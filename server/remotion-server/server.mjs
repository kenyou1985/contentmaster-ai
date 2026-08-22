#!/usr/bin/env node
/**
 * ContentMaster AI - Remotion 视频渲染 HTTP 服务
 *
 * 路由（全部在根路径）：
 *   GET  /health                       → 健康检查
 *   POST /upload-media                 → data URL → temp file
 *   POST /render/start                  → 异步提交渲染任务
 *   GET  /render/status/:id            → 轮询状态
 *   GET  /render/result/:id            → 获取最终 MP4
 *   POST /render/sync                  → 同步短路（仅供本地短镜头）
 *   POST /asr/transcribe              → 本地 Whisper WASM 提取字幕（零外网费用）
 *   GET  /render/sse/:id               → SSE 实时进度
 *   GET  /download/:file               → 下载渲染好的 MP4
 *
 * 端口：18093（本地）
 *      Railway / Vercel 由 PORT 环境变量决定
 */
import express from 'express';
import cors from 'cors';
import { spawn, execFile, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, createReadStream, statSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import os from 'os';
import multer from 'multer';
import { Worker } from 'worker_threads';
// ESM 文件中创建本地 require，用于解析 ffmpeg-static 等 CommonJS 模块
import { createRequire } from 'module';
const localRequire = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Remotion 模块加载（直接导入）──────────────
let bundler = null;
let renderer = null;
let modulesLoaded = false;
let modulesLoadError = null;

async function loadRemotionModules() {
  if (modulesLoaded) return modulesLoaded;
  
  try {
    console.log('[remotion] 正在加载 Remotion 模块...');
    bundler = await import('@remotion/bundler');
    renderer = await import('@remotion/renderer');
    console.log('[remotion] ✅ Remotion 模块加载成功');
    modulesLoaded = true;
    return true;
  } catch (e) {
    console.error('[remotion] ❌ Remotion 模块加载失败:', e.message);
    modulesLoadError = e;
    return false;
  }
}

// 预加载 Remotion 模块（启动时）
loadRemotionModules().catch(console.error);

// ── Remotion 项目根路径解析 ─────────────────────────
const RAW_ENV_ROOT = process.env.REMOTION_PROJECT_ROOT;

const CANDIDATE_ROOTS = [
  RAW_ENV_ROOT ? RAW_ENV_ROOT.replace(/[\r\n\s]+$/g, '').trim() : null,
  '/app/remotion',
  // server.mjs 在 /app/remotion-server/
  join(__dirname, '..', 'remotion'),
].filter(Boolean);

const SEEN = new Set();
const REMOTION_PROJECT_ROOT =
  CANDIDATE_ROOTS.find((p) => {
    if (SEEN.has(p)) return false;
    SEEN.add(p);
    return existsSync(join(p, 'src', 'index.tsx'));
  }) || CANDIDATE_ROOTS[0] || '/app/remotion';

const REMOTION_PROJECT_ENTRY = join(REMOTION_PROJECT_ROOT, 'src', 'index.tsx');

// 递归清除 payload 中的 data URL（避免 body 解析 OOM）
// 过大的 data URL 字段替换为占位符，文件实际通过 uploadInlineDataUrlsToServer 上传
const DATA_URL_PLACEHOLDER = '__DATA_URL_PLACEHOLDER__';
function cleanPayloadDataUrls(obj) {
  if (typeof obj === 'string') {
    return obj.startsWith('data:') ? DATA_URL_PLACEHOLDER : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => cleanPayloadDataUrls(v));
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = cleanPayloadDataUrls(v);
    }
    return out;
  }
  return obj;
}

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
const IS_VERCEL = !!process.env.VERCEL;
const PORT = process.env.PORT || 10000;

const app = express();
// 流式 JSON body 解析（替代 express.json({ limit:'2gb' })，避免 OOM）
// 接受 application/json 和 multipart/form-data（后者含 data URL）
// /upload-media 同时支持两种格式：JSON { items } 和 multipart (file 字段)
// 为了避免重复 Buffer.concat 内存爆炸：
//   - multipart → 让 /upload-media 内部的 multer 处理（已配置 1GB 上限）
//   - JSON → 这里用流式解析后给 req.body
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  const isUploadMedia = req.path === '/upload-media';
  // multipart 路径：只在 /upload-media 拦截，其他 multipart 端点也走 multer
  if (ct.includes('multipart/form-data')) {
    if (isUploadMedia) return next(); // 让 multer 处理
    // 其他 multipart：交给下游 multer
    return next();
  }
  if (ct.includes('application/json')) {
    const chunks = [];
    let totalLen = 0;
    const MAX = 200 * 1024 * 1024; // 200MB 硬上限（防止 OOM）
    req.on('data', (c) => {
      totalLen += c.length;
      if (totalLen > MAX) {
        chunks.length = 0;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        if (raw.length === 0) { req.body = {}; return next(); }
        // v1.11: 提高阈值到 100MB（大多数 payload 在此范围内包含完整 data URL）
        // 只有超过 100MB 的 payload 才会清理 data URL（依赖前端 upload-media 上传）
        // 排除 /asr/transcribe：audioUrl 本身就是 data URL，清理后服务端会得到占位符导致 fetch 失败
        const MAX_BODY_MB = 100;
        if (raw.length > MAX_BODY_MB * 1024 * 1024 && !req.path.startsWith('/asr/transcribe')) {
          try {
            const parsed = JSON.parse(raw.toString());
            req.body = cleanPayloadDataUrls(parsed);
          } catch { req.body = {}; }
        } else {
          req.body = JSON.parse(raw.toString());
        }
      } catch { req.body = {}; }
      next();
    });
    req.on('error', () => { req.body = {}; next(); });
  } else {
    next();
  }
});

const CORS_ALLOWED = [
  /localhost(:\d+)?$/,
  /127\.0\.0\.1(:\d+)?$/,
  /\.vercel\.app$/,
  /\.railway\.app$/,
  /\.up\.railway\.app$/,
];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (CORS_ALLOWED.some((re) => re.test(origin))) return cb(null, true);
      return cb(null, true);
    },
    credentials: true,
  })
);

// ── 静态文件 ─────────────────────
const OUTPUT_DIR = process.env.REMOTION_OUTPUT_DIR || join('/tmp', 'remotion-out');
const LOG_DIR = join(OUTPUT_DIR, 'logs');
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// ── 浏览器可执行文件路径 ─────────────────────────
// Railway / Linux 容器内：使用系统安装的 chromium，避免 Remotion 运行时下载失败
const SYSTEM_CHROMIUM_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_EXECUTABLE_PATH,
  process.env.REMOTION_BROWSER_EXECUTABLE,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chrome',
  // macOS：本机安装位置
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // macOS：当前用户 Homebrew
  '/opt/homebrew/bin/chromium',
  '/opt/homebrew/opt/chromium/bin/chromium',
];
const SYSTEM_CHROMIUM = SYSTEM_CHROMIUM_PATHS.find((p) => p && existsSync(p)) || null;
if (SYSTEM_CHROMIUM) {
  console.log(`[browser] 使用系统 Chromium: ${SYSTEM_CHROMIUM}`);
} else {
  console.warn(`[browser] 未找到系统 Chromium，Remotion 将尝试下载（容器中可能失败）`);
}

// 流式下载（替代 express.static）：
// - 移除 Content-Length，启用 Railway chunked transfer
// - 每 512KB 发一次块，块间无延迟（node pipe 自动背压），
//   Railway 的 120s 空闲超时只会在真正没数据传输时触发，pipe 会持续推数据所以不会触发
// - 客户端 AbortSignal.timeout(600s) 给浏览器足够时间完成大文件下载
app.use('/download', (req, res) => {
  const filename = req.path.replace(/^\//, '');
  const filePath = join(OUTPUT_DIR, filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${basename(filename)}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  // 不设 Content-Length → Railway 走 chunked transfer，边推边发不卡在"等文件发完"
  res.flushHeaders();

  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 }); // 1MB chunks
  stream.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else try { res.end(); } catch {}
  });
  stream.pipe(res);
});

// v1.11：清理过期的输出文件
//   - 默认保留 24 小时（REMOTION_KEEP_OUTPUT_HOURS 可覆盖）
//   - 跳过 _parts 子目录和 logs 子目录
//   - 每次清理打印统计，方便线上观察
const OUTPUT_KEEP_HOURS = Number(process.env.REMOTION_KEEP_OUTPUT_HOURS ?? 24);
const OUTPUT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时一次

function cleanupExpiredOutputs() {
  if (!existsSync(OUTPUT_DIR)) return { scanned: 0, deleted: 0, bytes: 0 };
  const now = Date.now();
  const maxAgeMs = OUTPUT_KEEP_HOURS * 60 * 60 * 1000;
  let scanned = 0;
  let deleted = 0;
  let bytesFreed = 0;
  let entries;
  try {
    entries = readdirSync(OUTPUT_DIR, { withFileTypes: true });
  } catch (e) {
    console.warn(`[cleanup] 读取 OUTPUT_DIR 失败: ${e.message}`);
    return { scanned: 0, deleted: 0, bytes: 0 };
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue; // 跳过 _parts 子目录等
    if (!ent.name.endsWith('.mp4')) continue;
    scanned++;
    const full = join(OUTPUT_DIR, ent.name);
    let st;
    try { st = statSync(full); } catch { continue; }
    const ageMs = now - st.mtimeMs;
    if (ageMs < maxAgeMs) continue;
    try {
      rmSync(full, { force: true });
      deleted++;
      bytesFreed += st.size;
      console.log(`[cleanup] 删除过期文件: ${ent.name} (${(ageMs / 3600_000).toFixed(1)}h, ${(st.size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (e) {
      console.warn(`[cleanup] 删除失败 ${ent.name}: ${e.message}`);
    }
  }
  if (scanned > 0) {
    console.log(`[cleanup] 扫描 ${scanned} 个 MP4，删除 ${deleted} 个，释放 ${(bytesFreed / 1024 / 1024).toFixed(1)}MB（保留 ${OUTPUT_KEEP_HOURS}h）`);
  }
  return { scanned, deleted, bytes: bytesFreed };
}

function scheduleOutputCleanup() {
  // 启动后 60s 跑一次（避开启动高峰 IO），然后每小时
  setTimeout(() => {
    cleanupExpiredOutputs();
    setInterval(cleanupExpiredOutputs, OUTPUT_CLEANUP_INTERVAL_MS);
  }, 60_000);
}

// ── ASR Worker（避免 Whisper 阻塞主 event loop）────────────
// 复用一个 Worker 串行处理 ASR 任务，避免每个请求都新启一个进程/加载模型
let asrWorker = null;
const asrPending = new Map(); // id -> { resolve, reject }
let asrNextId = 1;

function getAsrWorker() {
  if (asrWorker) return asrWorker;
  const workerPath = join(__dirname, 'asr-worker.mjs');
  console.log('[asr-worker] 启动:', workerPath);
  asrWorker = new Worker(workerPath);

  asrWorker.on('message', (msg) => {
    if (msg.ready) {
      console.log('[asr-worker] 就绪');
      return;
    }
    const pending = asrPending.get(msg.id);
    if (!pending) return;
    asrPending.delete(msg.id);
    pending.resolve(msg);
  });

  asrWorker.on('error', (err) => {
    console.error('[asr-worker] error:', err);
    // reject 所有 pending
    for (const [id, p] of asrPending) {
      p.reject(err);
      asrPending.delete(id);
    }
  });

  asrWorker.on('exit', (code) => {
    console.warn(`[asr-worker] exit code=${code}`);
    asrWorker = null;
    // reject 所有 pending
    for (const [id, p] of asrPending) {
      p.reject(new Error(`ASR worker exited code=${code}`));
      asrPending.delete(id);
    }
  });

  return asrWorker;
}

async function runAsrInWorker(audioPath, language = 'zh') {
  const worker = getAsrWorker();
  const id = asrNextId++;
  return new Promise((resolve, reject) => {
    asrPending.set(id, { resolve, reject });
    worker.postMessage({ id, audioPath, language });
  });
}

// ── 任务队列 ───────────────────────────────
const renderTasks = new Map();
const TASK_TTL_MS = 1000 * 60 * 60;
const sseConnections = new Map();
const renderQueue = [];
const activeWorkers = new Set();
let queueTickScheduled = false;

function scheduleQueueTick() {
  if (queueTickScheduled) return;
  queueTickScheduled = true;
  setImmediate(() => {
    queueTickScheduled = false;
    tickQueue();
  });
}

function getMaxParallelRenders() {
  // v1.11：根据 CPU/内存动态计算可同时跑的 Remotion worker 数
  //  - 每个 Chromium tab + 一个 Remotion 进程约吃 1.5-2 核 + 2-3GB
  //  - 留 1-2 核给 Chromium 进程外的辅助任务（ASR/Express/系统）
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const byCpu = Math.max(1, Math.floor((cpuCount - 2) / 2));
  const byMem = Math.max(1, Math.floor(totalMemGB / 4));
  // 保险下限 1，上限 4（再多会导致 IO/上下文切换反而更慢，且单个任务内已开 concurrency=16）
  const n = Math.min(4, Math.max(1, byCpu, byMem));
  console.log(`[queue] cpu=${cpuCount} mem=${totalMemGB}GB → maxParallelRenders=${n} (cpu-budget=${byCpu}, mem-budget=${byMem})`);
  return n;
}

const MAX_PARALLEL_RENDERS = getMaxParallelRenders();

function tickQueue() {
  while (activeWorkers.size < MAX_PARALLEL_RENDERS && renderQueue.length > 0) {
    const next = renderQueue.shift();
    activeWorkers.add(next.taskId);
    next.run().finally(() => {
      activeWorkers.delete(next.taskId);
      scheduleQueueTick();
    });
  }
}

function createRenderTask(payload) {
  const taskId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const task = {
    taskId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    renderStartAt: now,
    payload,
    result: null,
    error: null,
    progress: 0,
    message: '任务已创建',
    logs: [],
    frame: undefined,
    totalFrames: undefined,
    fps: undefined,
  };
  renderTasks.set(taskId, task);
  return task;
}

function pruneOldTasks() {
  const now = Date.now();
  for (const [id, t] of renderTasks.entries()) {
    const updatedAt = t.updatedAt || t.createdAt || now;
    if (now - updatedAt > TASK_TTL_MS) {
      renderTasks.delete(id);
      sseConnections.delete(id);
    }
  }
}
setInterval(pruneOldTasks, 60 * 1000);

function notifySse(taskId, data) {
  const connections = sseConnections.get(taskId);
  if (!connections) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of connections) {
    try {
      res.write(payload);
    } catch {}
  }
}

function updateTask(taskId, patch) {
  const task = renderTasks.get(taskId);
  if (!task) return;
  Object.assign(task, patch, { updatedAt: Date.now() });
  if (patch.progress !== undefined || patch.message) {
    task.logs.push({
      time: Date.now(),
      progress: patch.progress ?? task.progress,
      message: patch.message ?? task.message,
    });
    if (task.logs.length > 500) task.logs = task.logs.slice(-500);
  }
  const etaSec = computeEta(task);
  notifySse(taskId, {
    status: task.status,
    progress: task.progress,
    message: task.message,
    frame: patch.frame ?? task.frame,
    totalFrames: patch.totalFrames ?? task.totalFrames,
    fps: patch.fps ?? task.fps,
    etaSec,
  });
}

function computeEta(task) {
  if (!task.frame || !task.totalFrames || !task.fps) return undefined;
  const elapsedMs = Date.now() - (task.renderStartAt ?? task.createdAt);
  if (elapsedMs <= 0) return undefined;
  const framesPerSec = task.frame / (elapsedMs / 1000);
  if (framesPerSec <= 0) return undefined;
  const remainingFrames = Math.max(0, task.totalFrames - task.frame);
  return Math.round(remainingFrames / framesPerSec);
}

// ── Temp 目录静态文件服务 ─────────────────────
// Remotion 的 webpack dev server 无法访问 /tmp，需要通过 HTTP 暴露
const TEMP_DIR = '/tmp';
app.use('/media', express.static(TEMP_DIR, {
  dotfiles: 'allow',
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (filePath.endsWith('.mp3') || filePath.endsWith('.wav') || filePath.endsWith('.ogg') || filePath.endsWith('.m4a')) {
      res.setHeader('Content-Type', 'audio/mpeg');
    } else if (filePath.endsWith('.mp4') || filePath.endsWith('.webm') || filePath.endsWith('.mov')) {
      res.setHeader('Content-Type', 'video/mp4');
    }
  },
}));

// ── Data URL → Temp File ─────────────────────
const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/gif': '.gif', 'image/webp': '.webp',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav',
  'audio/ogg': '.ogg', 'audio/m4a': '.m4a', 'audio/aac': '.aac',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a',
};

// 最小占位文件：用于远程 URL 下载失败时占位，避免 Remotion 重新下载
// 1x1 透明 PNG（base64）
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
// 最小 mp3（用于 ffmpeg 失败时的回退，ffprobe 可能仍报错）
const PLACEHOLDER_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00, 0x00, 0x00]);
const PLACEHOLDER_BYTES = {
  '.png': PLACEHOLDER_PNG, '.jpg': PLACEHOLDER_PNG, '.jpeg': PLACEHOLDER_PNG,
  '.gif': PLACEHOLDER_PNG, '.webp': PLACEHOLDER_PNG,
  '.mp3': PLACEHOLDER_MP3, '.wav': PLACEHOLDER_MP3, '.ogg': PLACEHOLDER_MP3,
  '.m4a': PLACEHOLDER_MP3, '.aac': PLACEHOLDER_MP3,
  '.mp4': PLACEHOLDER_MP3, '.mov': PLACEHOLDER_MP3, '.webm': PLACEHOLDER_MP3,
  '.bin': Buffer.alloc(0),
};

/**
 * 用 ffmpeg 生成合法的占位媒体文件
 * - 音频：1 秒静音 mp3（ffprobe 可识别时长）
 * - 图像：1x1 黑/透明 PNG
 * - 视频：1 秒黑屏 mp4
 */
async function generatePlaceholder(ext, filePath, log) {
  const { execFileSync } = await import('child_process');
  const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'].includes(ext);
  const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);

  try {
    if (isAudio) {
      // 1 秒静音 mp3
      execFileSync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t', '1', '-q:a', '9', '-acodec', 'libmp3lame', filePath
      ], { stdio: 'ignore', timeout: 10000 });
      return;
    }
    if (isVideo) {
      // 1 秒黑屏 mp4
      execFileSync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1',
        '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filePath
      ], { stdio: 'ignore', timeout: 10000 });
      return;
    }
    if (isImage) {
      writeFileSync(filePath, PLACEHOLDER_BYTES[ext] || PLACEHOLDER_PNG);
      return;
    }
  } catch (e) {
    log(`⚠️ ffmpeg 生成占位失败: ${e.message}，回退到字节占位`);
  }
  // 回退：写字节占位
  writeFileSync(filePath, PLACEHOLDER_BYTES[ext] || Buffer.alloc(0));
}

/**
 * 把 data URL 或远程 URL 转成文件路径，返回 { cleanedShots, tempDir, filePathMap }
 * filePathMap: 原始 URL → 文件路径 的映射
 */
async function extractUrlsToTempFiles(shots, log = console.log) {
  const tempDir = join('/tmp', `remotion_data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tempDir, { recursive: true });
  const filePathMap = new Map();

  // 检查是否有 placeholder（body 解析时被清理了）
  const placeholderCount = (() => {
    let count = 0;
    const check = (val) => {
      if (val === DATA_URL_PLACEHOLDER) count++;
      else if (typeof val === 'string' && val.includes(DATA_URL_PLACEHOLDER)) count++;
    };
    for (const shot of shots) {
      for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
        check(shot?.[key]);
      }
      if (Array.isArray(shot?.imageUrls)) {
        for (const u of shot.imageUrls) check(u);
      }
    }
    return count;
  })();

  if (placeholderCount > 0) {
    throw new Error(
      `Payload 包含 ${placeholderCount} 个占位符 __DATA_URL_PLACEHOLDER__，` +
      `表示媒体文件未上传。请确保前端使用 upload-media 接口上传大文件。`
    );
  }

  const collectUrls = (shot) => {
    const urls = [];
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      const val = shot[key];
      if (val && typeof val === 'string') urls.push({ key, val });
    }
    if (Array.isArray(shot.imageUrls)) {
      for (const u of shot.imageUrls) {
        if (u && typeof u === 'string') urls.push({ key: 'imageUrls', val: u });
      }
    }
    return urls;
  };

  const writeFileFromBase64 = (val, ext) => {
    const idx = filePathMap.size;
    const filePath = join(tempDir, `media_${String(idx).padStart(4, '0')}${ext}`);
    const commaIdx = val.indexOf(',');
    const b64data = commaIdx >= 0 ? val.slice(commaIdx + 1) : val;
    writeFileSync(filePath, Buffer.from(b64data, 'base64'));
    return filePath;
  };

  const downloadRemote = async (val, ext) => {
    const idx = filePathMap.size;
    const filePath = join(tempDir, `media_${String(idx).padStart(4, '0')}${ext}`);
    try {
      log(`下载远程媒体: ${val.slice(0, 80)}...`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch(val, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // 防御：检测空响应或 HTML 错误页（返回了错误页而不是媒体）
      if (buf.length < 16 || (buf[0] === 0x3c && buf[1] === 0x21)) {
        throw new Error(`响应无效 (${buf.length} bytes)`);
      }
      writeFileSync(filePath, buf);
      log(`下载成功 (${(buf.length / 1024).toFixed(1)} KB): ${basename(filePath)}`);
      return filePath;
    } catch (e) {
      log(`⚠️ 下载失败 ${val.slice(0, 60)}...: ${e.message}，使用占位文件`);
      // 下载失败时用 ffmpeg 生成 1 秒静音 mp3 / 1 帧黑屏图像占位
      const placeholder = await generatePlaceholder(ext, filePath, log);
      return filePath;
    }
  };

  for (const shot of shots) {
    for (const { key, val } of collectUrls(shot)) {
      if (filePathMap.has(val)) continue;

      if (val.startsWith('data:')) {
        const headerMatch = val.match(/^data:([^;]+)/);
        const mime = headerMatch ? headerMatch[1] : 'application/octet-stream';
        const ext = MIME_EXT[mime] || '.bin';
        const filePath = writeFileFromBase64(val, ext);
        filePathMap.set(val, filePath);
      } else if (val.startsWith('http://') || val.startsWith('https://')) {
        // 从 URL 推断扩展名
        let ext = '.bin';
        try {
          const u = new URL(val);
          const pathname = u.pathname.toLowerCase();
          const m = pathname.match(/\.([a-z0-9]{2,5})(\?|$)/);
          if (m) ext = '.' + m[1];
          else if (pathname.includes('audio')) ext = '.mp3';
          else if (pathname.includes('image') || pathname.includes('img')) ext = '.png';
          else if (pathname.includes('video')) ext = '.mp4';
        } catch {}
        const filePath = await downloadRemote(val, ext);
        filePathMap.set(val, filePath);
      } else if (val.startsWith('/tmp/') || val.startsWith('/api/remotion/media/')) {
        // 兜底：前端调 /upload-media 后被 toRemotionMediaHttpUrl 转成的相对路径，
        // 或未经转换的本地路径（/tmp/remotion_data_xxx/...）。两者都映射到同一个
        // filePath，让后续 replaceFilePathsWithHttpUrls 转成绝对 HTTP URL。
        // 这样任何忘了转换的调用方（CustomTracksPanel/CopyBasedPanel/老 build）
        // 也不会让 shot.audioUrl 留 /tmp/... 或 /api/remotion/media/... 让
        // Remotion staticFile 包成 3001/public/... 报错。
        const filePath = val.startsWith('/api/remotion/media/')
          ? '/tmp/' + val.slice('/api/remotion/media/'.length)
          : val;
        try {
          if (!existsSync(filePath)) {
            log(`⚠️ 本地路径不存在: ${val} → ${filePath}`);
            continue;
          }
          filePathMap.set(val, filePath);
        } catch {}
      }
    }
  }

  const cleanedShots = JSON.parse(JSON.stringify(shots));
  for (const shot of cleanedShots) {
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      if (shot[key] && filePathMap.has(shot[key])) {
        shot[key] = filePathMap.get(shot[key]);
      }
    }
    if (Array.isArray(shot.imageUrls)) {
      shot.imageUrls = shot.imageUrls.map((u) =>
        u && filePathMap.has(u) ? filePathMap.get(u) : u
      );
    }
  }

  log(`媒体下载完成: ${filePathMap.size} 个文件，已映射 ${cleanedShots.reduce((acc, s) => acc + (Array.isArray(s.imageUrls) ? s.imageUrls.length : 0) + ['imageUrl','audioUrl','voiceoverAudioUrl','videoUrl'].filter(k => s[k]).length, 0)} 处引用`);

  return { cleanedShots, tempDir, filePathMap };
}

/**
 * 把文件路径替换为 HTTP URL（Remotion Chrome 需要绝对 URL 才能直接 fetch）
 * @param {Array} shots - 包含文件路径的 shots
 * @param {Map} filePathMap - data URL → 文件路径 的映射
 * @param {string} baseUrl - 如 http://localhost:18093
 */
function replaceFilePathsWithHttpUrls(shots, filePathMap, baseUrl) {
  const reversedMap = new Map();
  for (const [dataUrl, filePath] of filePathMap) {
    // filePath 形如 /tmp/remotion_data_xxx/media_0000.png
    // /media 路由已经 mount 到 /tmp，所以 URL 应该是 /media/remotion_data_xxx/media_0000.png
    // 需要去掉 /tmp 前缀
    const urlPath = filePath.replace(/^\/tmp/, '');
    reversedMap.set(filePath, `${baseUrl}/media${urlPath}`);
    // 同时把 /api/remotion/media/... 相对路径也映射成绝对 URL
    // 修复：前端 toRemotionMediaHttpUrl 把 /tmp/... 转成 /api/remotion/media/... 相对路径，
    // 后端需要再 normalize 成 http://...:18093/media/... 否则 Remotion staticFile() 会
    // 包成 http://<Remotion端口>/public/api/remotion/... → Chrome 找不到媒体。
    reversedMap.set(`/api/remotion/media${urlPath}`, `${baseUrl}/media${urlPath}`);
  }

  const result = JSON.parse(JSON.stringify(shots));
  for (const shot of result) {
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      if (shot[key] && reversedMap.has(shot[key])) {
        shot[key] = reversedMap.get(shot[key]);
      } else if (shot[key]?.startsWith?.('/api/remotion/media/')) {
        // 兜底：filePathMap 没记录的（理论上不会发生，但保险起见）
        const subPath = shot[key].slice('/api/remotion/media/'.length);
        shot[key] = `${baseUrl}/media/${subPath}`;
      } else if (shot[key]?.startsWith?.('/tmp/')) {
        // 兜底：前端没转换的本地路径
        shot[key] = `${baseUrl}/media${shot[key].replace(/^\/tmp/, '')}`;
      }
    }
    if (Array.isArray(shot.imageUrls)) {
      shot.imageUrls = shot.imageUrls.map((u) => {
        if (u && reversedMap.has(u)) return reversedMap.get(u);
        if (u?.startsWith?.('/api/remotion/media/')) {
          return `${baseUrl}/media/${u.slice('/api/remotion/media/'.length)}`;
        }
        if (u?.startsWith?.('/tmp/')) {
          return `${baseUrl}/media${u.replace(/^\/tmp/, '')}`;
        }
        return u;
      });
    }
  }
  return result;
}

function cleanupTempDir(tempDir) {
  try {
    if (tempDir && tempDir.includes('/tmp/remotion_data_')) {
      const { rmSync } = require('fs');
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {}
}

// ── 主进程渲染（直接执行，不使用子进程）────────────────────
async function runRenderInProcess(payload, taskId) {
  const task = renderTasks.get(taskId);
  if (!task) return;

  // 确保模块已加载
  if (!modulesLoaded) {
    const loaded = await loadRemotionModules();
    if (!loaded) {
      updateTask(taskId, { status: 'failed', error: modulesLoadError?.message || '模块加载失败' });
      return;
    }
  }

  const shots = payload.shots || [];
  const config = payload.config || {};
  const outputPath = join(OUTPUT_DIR, `${taskId}.mp4`);
  const logPath = join(LOG_DIR, `${taskId}.log`);

    // log 函数必须在 try 之外定义，以便 catch 块也能使用
    // v1.7：使用异步 writeFile（不阻塞渲染主线程）
    const log = (msg) => {
      try {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        // 异步写入：避免 writeFileSync 阻塞渲染/CPU 关键路径
        fs.writeFile(logPath, line, { flag: 'a' }).catch(() => {});
        console.log(msg);
      } catch {}
    };

    // v1.7：给单个步骤加硬超时（避免 hang 死）
    const withTimeout = (promise, ms, label) =>
      Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${label} 超时（>${Math.round(ms / 1000)}s）`)), ms)
        ),
      ]);

    try {
    log(`== 渲染任务开始: ${taskId} ==`);
    log(`PROJECT_ROOT: ${REMOTION_PROJECT_ROOT}`);
    log(`ENTRY_FILE: ${REMOTION_PROJECT_ENTRY}`);
    log(`输出路径: ${outputPath}`);

    if (!existsSync(REMOTION_PROJECT_ENTRY)) {
      throw new Error(`入口文件不存在: ${REMOTION_PROJECT_ENTRY}`);
    }

    updateTask(taskId, { status: 'running', progress: 5, message: '处理媒体文件...' });

    // 媒体文件已经在 /render/start 时转换好了，这里直接使用
    // payload._tempDir 是转换时创建的临时目录
    // payload.shots 已经是转换后的（包含 HTTP URL）
    log(`临时目录: ${payload._tempDir || 'N/A'}`);
    log(`镜头数量: ${shots.length}`);

    updateTask(taskId, { progress: 10, message: '打包 Remotion 项目...' });
    log('步骤 2/4: 打包 Remotion 项目...');

    const t0 = Date.now();
    const bundleLocation = await bundler.bundle({
      entryPoint: REMOTION_PROJECT_ENTRY,
      enableCaching: true,
      ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
    });
    log(`打包完成（耗时 ${Date.now() - t0}ms）: ${bundleLocation}`);

    updateTask(taskId, { progress: 15, message: '选择 Composition...' });
    log('步骤 3/4: 选择 Composition...');

    const safeConfig = {
      ...config,
      output: config.output ? { target: config.output.target } : { target: 'browser' },
    };
    const inputProps = { shots: shots, config: safeConfig };

    const composition = await renderer.selectComposition({
      serveUrl: bundleLocation,
      id: 'MyVideo',
      inputProps,
      // 见 renderMedia 处的 v1.x 修复：macOS Chrome 访问 serveUrl 需要 IPv4
      forceIPv4: true,
      ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
    });

    log(`Composition: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} 帧`);

    updateTask(taskId, { 
      progress: 20, 
      message: '开始渲染视频...',
      totalFrames: composition.durationInFrames,
      fps: composition.fps,
    });

    log('步骤 4/4: 渲染 MP4...');

    const getConcurrency = () => {
      const cpuCount = Math.max(1, os.cpus()?.length || 1);
      const totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
      const concurrencyByCpu = Math.max(1, Math.floor(cpuCount * 0.6));
      const concurrencyByMem = Math.max(1, Math.floor(totalMemGB / 3));
      return Math.min(16, concurrencyByCpu, concurrencyByMem);
    };

    const concurrency = getConcurrency();
    const offthreadThreads = Math.min(8, Math.max(2, Math.floor((os.cpus()?.length || 4) / 4)));
    log(`[render] concurrency=${concurrency} offthreadVideoThreads=${offthreadThreads}`);
    log(`[render] shots=${shots.length} resolution=${config.resolution || '1920x1080'} duration=${composition.durationInFrames}f @ ${composition.fps}fps`);

    await renderer.renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: config.codec === 'h265' ? 'h265' : 'h264',
      outputLocation: outputPath,
      inputProps,
      concurrency,
      // 修复 v1.x：macOS 上 Chrome 访问 serveUrl 失败
      // Remotion serveStatic 默认按 IPv6 → '::' bind，Chrome 用 localhost 解析到 IPv4 127.0.0.1
      // → bind 地址和访问地址不一致，连接超时（"got no response"）。
      // 强制 IPv4 让 serveStatic 用 0.0.0.0 bind，避免与 Vite 3000 等其他进程的 IPv4/V6 冲突。
      forceIPv4: true,
      ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
      chromiumOptions: {
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--enable-gpu',
          '--use-gl=swiftshader',
          '--enable-features=Vulkan',
          '--ignore-gpu-blocklist',
        ],
      },
      offthreadVideoThreads: offthreadThreads,
      x264Preset: 'ultrafast',
      parallelEncoding: true,
      onProgress: ({ progress, renderedFrames, totalFrames }) => {
        const overall = 20 + Math.round(progress * 75);
        updateTask(taskId, {
          progress: overall,
          frame: renderedFrames,
          totalFrames,
          message: `渲染中 (${renderedFrames}/${totalFrames} 帧, ${Math.round(progress * 100)}%)`,
        });
      },
    });

    if (!existsSync(outputPath)) {
      throw new Error('渲染完成后输出文件不存在');
    }

    const stats = statSync(outputPath);
    log(`输出文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    const videoDurationSec = composition.durationInFrames / composition.fps;

    cleanupTempDir(payload._tempDir);

    updateTask(taskId, {
      status: 'success',
      progress: 100,
      message: '渲染完成',
      result: {
        outputPath,
        outputUrl: `/download/${taskId}.mp4`,
        durationSec: videoDurationSec,
        videoSizeBytes: stats.size,
        resolution: `${composition.width}x${composition.height}`,
        fps: composition.fps,
        format: 'mp4',
        taskId,
      },
    });

    log('== 渲染完成 ==');
  } catch (e) {
    log(`❌ 渲染失败: ${e.message}`);
    console.error('[render-worker] 失败:', e);
    cleanupTempDir(payload._tempDir);
    updateTask(taskId, {
      status: 'failed',
      error: e.message,
      message: `渲染失败: ${e.message}`,
    });
  }
}

// ── 健康检查 ─────────────────────
// 健康检查不能在 ASR 跑时被卡死 → 缓存子进程结果 + 用 Promise.race 超时保护
const healthCache = {
  chromiumVersion: null,
  chromiumOk: false,
  ffmpegVersion: null,
  ffmpegOk: false,
  lastChecked: 0,
};
const HEALTH_CACHE_TTL_MS = 30_000; // 30 秒内复用同一次结果

async function execWithTimeout(cmd, args, timeoutMs) {
  // 异步执行 cmd，避免阻塞 Node 主线程（防止 ASR 跑时健康检查拖死）
  try {
    const { execFile } = await import('child_process');
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      execFile(cmd, args, { timeout: timeoutMs + 1000 }, (err, stdout) => {
        clearTimeout(timer);
        resolve(err ? null : (stdout || '').toString().trim());
      });
    });
  } catch {
    return null;
  }
}

const healthHandler = async (_req, res) => {
  const now = Date.now();
  const cacheFresh = (now - healthCache.lastChecked) < HEALTH_CACHE_TTL_MS && healthCache.lastChecked > 0;

  let chromiumOk = healthCache.chromiumOk;
  let chromiumVersion = healthCache.chromiumVersion;
  let ffmpegOk = healthCache.ffmpegOk;
  let ffmpegVersion = healthCache.ffmpegVersion;

  if (!cacheFresh) {
    // Chromium/chrome：优先用 SYSTEM_CHROMIUM（实际会被 Remotion 渲染用到的二进制），
    // 这样健康检查和实际渲染路径一致，避免误报"OK 但渲染失败"。
    // 用 async execFile，不要阻塞主线程（ASR/Remotion 跑时也能正常返回 200）。
    if (SYSTEM_CHROMIUM) {
      chromiumVersion = await execWithTimeout(SYSTEM_CHROMIUM, ['--version'], 5000);
      chromiumOk = !!chromiumVersion && /Chromium|Google Chrome|Chrome/i.test(chromiumVersion);
      if (!chromiumOk) chromiumVersion = '(exec failed or unknown)';
    }
    if (!chromiumOk) {
      // 兜底：PATH 命令（仅当 SYSTEM_CHROMIUM 不存在时跑）
      chromiumVersion = await execWithTimeout('/bin/sh', ['-c', 'chromium --version 2>/dev/null || google-chrome --version 2>/dev/null || echo ""'], 2000);
      chromiumOk = !!chromiumVersion && /Chromium|Google Chrome/i.test(chromiumVersion);
    }

    // ffmpeg：优先 ffmpeg-static（项目自带），其次 PATH 命令
    try {
      const nmdir = localRequire.resolve('ffmpeg-static').replace('/index.js', '');
      const fsBin = join(nmdir, 'ffmpeg');
      if (existsSync(fsBin)) {
        const v = await execWithTimeout(fsBin, ['-version'], 2000);
        if (v && /ffmpeg/i.test(v)) {
          ffmpegVersion = v.split('\n')[0].trim();
          ffmpegOk = true;
        }
      }
    } catch {}
    if (!ffmpegOk) {
      const v = await execWithTimeout('/bin/sh', ['-c', 'ffmpeg -version 2>&1 | head -1'], 2000);
      if (v && /ffmpeg/i.test(v)) {
        ffmpegVersion = v.trim();
        ffmpegOk = true;
      }
    }

    // 写回缓存
    healthCache.chromiumOk = chromiumOk;
    healthCache.chromiumVersion = chromiumVersion;
    healthCache.ffmpegOk = ffmpegOk;
    healthCache.ffmpegVersion = ffmpegVersion;
    healthCache.lastChecked = now;
  }

  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMB = Math.round(os.freemem() / 1024 / 1024);

  res.json({
    status: 'ok',
    service: 'remotion-render-server',
    version: '1.0.0',
    port: PORT,
    node: process.version,
    platform: IS_RAILWAY ? 'railway' : IS_VERCEL ? 'vercel' : 'local',
    env: {
      RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT || null,
      RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID || null,
      RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN || null,
    },
    remotionEntry: REMOTION_PROJECT_ENTRY,
    remotionEntryExists: existsSync(REMOTION_PROJECT_ENTRY),
    remotion: {
      projectRoot: REMOTION_PROJECT_ROOT,
      entry: REMOTION_PROJECT_ENTRY,
      entryExists: existsSync(REMOTION_PROJECT_ENTRY),
      modulesLoaded,
      modulesLoadError: modulesLoadError?.message || null,
    },
    runtime: {
      chromium: chromiumOk,
      chromiumVersion,
      chromiumPath: SYSTEM_CHROMIUM,
      ffmpeg: ffmpegOk,
      ffmpegVersion,
      cpus: os.cpus()?.length || 0,
      totalMemMB,
      freeMemMB,
    },
    outputDir: OUTPUT_DIR,
    activeTasks: renderTasks.size,
    timestamp: Date.now(),
  });
};
app.get('/health', healthHandler);

// ── Data URL 上传 ─────────────────────
// 支持两种格式：
//   A. application/json: { items: [{ mime, data: "base64" }] }   // 兼容旧版
//   B. multipart/form-data: file=<File>, mime=<string>             // 大文件流式上传（不走 base64）
app.post('/upload-media', async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  try {
    // B. multipart（推荐用于大音频/视频）
    if (contentType.includes('multipart/form-data')) {
      const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } }).single('file');
      await new Promise((resolve, reject) => {
        upload(req, res, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      const f = req.file;
      if (!f) return res.status(400).json({ success: false, error: 'multipart 缺少 file 字段' });
      const mime = (f.mimetype || req.body?.mime || 'application/octet-stream').toLowerCase();
      const ext = MIME_EXT[mime] || '.bin';
      const tempDir = join('/tmp', `remotion_data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(tempDir, { recursive: true });
      const filePath = join(tempDir, `media_0000${ext}`);
      writeFileSync(filePath, f.buffer);
      return res.json({ success: true, paths: [filePath], tempDir, count: 1 });
    }

    // A. JSON（兼容旧版）
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items 不能为空' });
    }
    const tempDir = join('/tmp', `remotion_data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
    const paths = [];
    for (const it of items) {
      const mime = (it.mime || 'application/octet-stream').toLowerCase();
      const ext = MIME_EXT[mime] || '.bin';
      const idx = paths.length;
      const filePath = join(tempDir, `media_${String(idx).padStart(4, '0')}${ext}`);
      writeFileSync(filePath, Buffer.from(it.data, 'base64'));
      paths.push(filePath);
    }
    res.json({ success: true, paths, tempDir, count: paths.length });
  } catch (e) {
    console.error('[remotion] upload-media 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 服务端音轨提取（Remotion 官方 extractAudio） ─────────────────────
// 兜底方案：前端浏览器无法解码 iPhone HEVC 视频时，
// 由服务端用完整 ffmpeg 提取音轨为 WAV（16kHz mono PCM）。
//
// 支持两种请求格式（前端优先用 multipart）：
//   A. multipart/form-data: file=<File>, fileName=<string>, mime=<string>
//   B. application/json:    { mediaDataUrl: "data:..." , fileName: "..." }  // 兼容旧版
app.post('/audio/extract', async (req, res) => {
  const startedAt = Date.now();
  let wavBytes = null;

  try {
    let bytes;
    let fileName = 'input.mp4';
    let mime = 'video/mp4';

    // 兼容 multipart（来自 FormData 上传）
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } }).single('file');
      await new Promise((resolve, reject) => {
        upload(req, res, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      const f = req.file;
      if (!f) return res.status(400).json({ success: false, error: 'multipart 缺少 file 字段' });
      bytes = f.buffer;
      fileName = f.originalname || fileName;
      mime = f.mimetype || mime;
    } else {
      // JSON 兼容
      const { mediaDataUrl } = req.body || {};
      if (typeof mediaDataUrl !== 'string' || !mediaDataUrl.startsWith('data:')) {
        return res.status(400).json({ success: false, error: '缺少 file（multipart）或 mediaDataUrl（JSON）' });
      }
      const m = mediaDataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) return res.status(400).json({ success: false, error: 'data URL 格式错误' });
      bytes = Buffer.from(m[2], 'base64');
      mime = m[1];
      fileName = req.body.fileName || fileName;
    }
    console.log(`[remotion] /audio/extract 收到 ${(bytes.length / 1024 / 1024).toFixed(2)} MB (${mime}, ${fileName})`);

    const tempDir = join('/tmp', `audio_extract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const inPath = join(tempDir, safeName);
    const outPath = join(tempDir, safeName.replace(/\.[^.]+$/, '') + '.wav');
    writeFileSync(inPath, bytes);

    let usedExtractor = 'unknown';
    let ffmpegVersion = 'unknown';

    // ── 提取音频（直接用 ffmpeg-static 转标准 PCM WAV）──
    //    @remotion/renderer.extractAudio() 输出 audioFormat:255（WAVE_FORMAT_EXTENSIBLE），
    //    浏览器 decodeAudioData() 无法解码。改用 ffmpeg-static 直接转 PCM。
    //    execFile spawn 绕开 shell，不会触发 macOS Gatekeeper SIGKILL。
    //
    // 优先级：ffmpeg-static（完整解码器）> 小V猫 > 其他
    // 注意：hardcode 路径，避免 ESM 中 require() 动态 resolve 的坑
    const nodeModulesDir = localRequire.resolve('ffmpeg-static').replace('/index.js', '');
    const candidates = [
      {
        path: join(nodeModulesDir, 'ffmpeg'),
        label: 'ffmpeg-static',
      },
      {
        path: '/Applications/小V猫.app/Contents/Resources/app/ffmpeg',
        label: '小V猫',
      },
      {
        path: '/Applications/剪映专业版5.9.app/Contents/Resources/ffmpeg',
        label: '剪映',
      },
      {
        path: '/Applications/易剪媒.app/Contents/Resources/extraResources/ffmpeg/mac/ffmpeg',
        label: '易剪媒',
      },
      {
        path: '/opt/homebrew/bin/ffmpeg',
        label: 'homebrew',
      },
      {
        path: '/usr/local/bin/ffmpeg',
        label: 'usr/local',
      },
    ];

    let ffmpegOk = false;
    for (const { path: p, label } of candidates) {
      if (!p || !existsSync(p)) continue;
      console.log(`[remotion] 用 ffmpeg: ${label} (${p})`);
      try {
        await new Promise((resolve, reject) => {
          execFile(p, [
            '-i', inPath,
            '-vn',
            '-acodec', 'pcm_s16le',
            '-ac', '1',
            '-ar', '16000',
            '-f', 'wav',
            '-y',
            outPath,
          ], { timeout: 180_000 }, (err, _stdout, stderr) => {
            if (err) {
              const msg = stderr?.toString()?.slice(0, 300) || err.message;
              console.warn(`[remotion] ffmpeg ${label} 失败: ${msg}`);
              reject(new Error(msg));
            } else {
              resolve();
            }
          });
        });
        // 取版本信息（用 execFile，不用 execSync shell）
        try {
          const vOut = await new Promise(res => {
            const v = spawn(p, ['-version'], { timeout: 3000 });
            let out = '';
            v.stdout.on('data', d => out += d.toString());
            v.on('close', () => res(out.split('\n')[0]));
            v.on('error', () => res(''));
          });
          ffmpegVersion = vOut.trim() || label;
        } catch (_ve) {
          ffmpegVersion = label;
        }

        // ffmpeg-static 对某些 HEVC+AAC 解码失败但静默输出，检查后决定是否重试
        if (label === 'ffmpeg-static') {
          const stat = statSync(outPath);
          if (stat.size > 500_000) {
            const wBytes = readFileSync(outPath);
            const pcmData = wBytes.slice(44);
            let pcmMax = 0;
            const checkLen = Math.min(pcmData.length, 100_000);
            for (let i = 0; i < checkLen; i += 2) {
              const v = Math.abs(pcmData.readInt16LE(i));
              if (v > pcmMax) pcmMax = v;
            }
            const pcmRatio = pcmMax / 32767;
            console.log(`[remotion] ffmpeg-static PCM max: ${pcmMax} (${pcmRatio.toFixed(4)})`);
            if (pcmRatio < 0.001) {
              console.warn(`[remotion] ffmpeg-static 输出静音，尝试下一个`);
              continue; // try next candidate
            }
          }
        }

        usedExtractor = `ffmpeg-${label}`;
        ffmpegOk = true;
        break;
      } catch (_e) {
        // try next candidate
      }
    }

    if (!ffmpegOk) {
      rmSync(tempDir, { recursive: true, force: true });
      return res.status(503).json({
        success: false,
        error: '服务端所有 ffmpeg 都失败',
      });
    }

    if (!existsSync(outPath)) {
      rmSync(tempDir, { recursive: true, force: true });
      return res.status(500).json({ success: false, error: 'ffmpeg 未生成输出文件' });
    }

    wavBytes = readFileSync(outPath);
    const wavSizeKB = (wavBytes.length / 1024).toFixed(1);
    console.log(`[remotion] ffmpeg 输出: ${wavSizeKB} KB (${Date.now() - startedAt}ms, extractor=${usedExtractor})`);

    if (wavBytes.length < 1000) {
      rmSync(tempDir, { recursive: true, force: true });
      return res.status(422).json({ success: false, error: 'ffmpeg 输出过小，视频可能无音轨' });
    }

    const wavDataUrl = `data:audio/wav;base64,${wavBytes.toString('base64')}`;
    rmSync(tempDir, { recursive: true, force: true });

    res.json({
      success: true,
      wavDataUrl,
      sizeBytes: wavBytes.length,
      elapsedMs: Date.now() - startedAt,
      usedExtractor,
      ffmpegVersion,
    });
  } catch (e) {
    console.error('[remotion] /audio/extract 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 长视频分批渲染 ─────────────────────
/**
 * POST /render/long
 * Body: { shots, config } — 与 /render/start 相同
 * 行为：总时长 > 30 分钟时自动分批渲染，每段 ≤ 20 分钟
 * 成功返回: { success, taskId, mode, segmentCount, childTaskIds }
 */
app.post('/render/long', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
      return res.status(400).json({ success: false, error: 'shots 不能为空' });
    }

    // 估算总时长（与前端 remotionExportService 保持一致）
    const totalDuration = (payload.shots || []).reduce(
      (s, x) => s + (x?.audioDurationExact ?? x?.audioDurationSec ?? x?.duration ?? 4),
      0
    );

    // 若短于阈值（30 分钟），降级到普通渲染
    if (totalDuration <= 1800) {
      // 自动转向 /render/start
      return res.redirect(307, '/render/start');
    }

    const task = createRenderTask(payload);
    const taskId = task.taskId;
    updateTask(taskId, { status: 'running', progress: 0, message: `长视频检测（${(totalDuration / 60).toFixed(1)} 分钟），分批渲染中...` });

    // 提取 media URL 为文件
    const { cleanedShots, tempDir, filePathMap } = await extractUrlsToTempFiles(payload.shots);
    const baseUrl = process.env.MEDIA_BASE_URL || `http://127.0.0.1:${PORT}`;
    const shotsWithHttpUrls = replaceFilePathsWithHttpUrls(cleanedShots, filePathMap, baseUrl);
    const normalizedPayload = { ...payload, shots: shotsWithHttpUrls, _tempDir: tempDir, _taskId: taskId };

    // 异步执行分批渲染
    renderQueue.push({
      taskId,
      run: async () => {
        try {
          const { renderLongVideoBatch } = await import('./batch-renderer.mjs');
          const { renderSegment } = await import('./render-worker.mjs');

          const logger = {
            logInfo: (msg) => updateTask(taskId, { message: msg }),
            logError: (msg) => updateTask(taskId, { message: `❌ ${msg}` }),
            logProgress: (p, m) => updateTask(taskId, { progress: p, message: m }),
          };

          const result = await renderLongVideoBatch(
            normalizedPayload,
            (segmentShots, segmentOutputPath) =>
              renderSegment(segmentShots, segmentOutputPath, {
                config: normalizedPayload.config,
                logger,
              }),
            {
              outputDir: OUTPUT_DIR,
              maxSegmentDurationSec: 1200, // 每段 ≤ 20 分钟
              onLog: (msg) => logger.logInfo(msg),
            }
          );

          // 更新任务状态
          updateTask(taskId, {
            status: 'success',
            progress: 100,
            message: `分批渲染完成（${result.segmentCount} 段）`,
            result: {
              outputPath: result.finalPath,
              outputUrl: `/download/${taskId}.mp4`,
              durationSec: result.totalDurationSec,
              videoSizeBytes: existsSync(result.finalPath) ? statSync(result.finalPath).size : 0,
              resolution: '1920x1080',
              fps: 30,
              format: 'mp4',
              taskId,
              segmentCount: result.segmentCount,
            },
          });
        } catch (e) {
          console.error('[render/long] 渲染失败:', e);
          updateTask(taskId, { status: 'failed', error: e.message });
        }
      },
    });
    scheduleQueueTick();

    res.json({
      success: true,
      taskId,
      mode: 'batch',
      estimatedDurationSec: totalDuration,
      message: `长视频（${(totalDuration / 60).toFixed(1)} 分钟）将分 ${Math.ceil(totalDuration / 1200)} 段渲染`,
    });
  } catch (e) {
    console.error('[remotion] render/long 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 异步提交渲染任务 ─────────────────────
app.post('/render/start', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
      return res.status(400).json({ success: false, error: 'shots 不能为空' });
    }

    const task = createRenderTask(payload);
    updateTask(task.taskId, { status: 'running', progress: 0, message: '任务已入队' });

    // 提取 data URL / 远程 URL 为文件
    const { cleanedShots, tempDir, filePathMap } = await extractUrlsToTempFiles(payload.shots);

    // 构建 baseUrl
    // 重要：Remotion 内部的 chromium 浏览器需要访问媒体文件
    // 用 127.0.0.1:PORT 确保访问到容器内的 Express server
    // （req.host 在 Railway 可能是 railway.app 域名，从容器内可能无法解析）
    const baseUrl = process.env.MEDIA_BASE_URL || `http://127.0.0.1:${PORT}`;
    const shotsWithHttpUrls = replaceFilePathsWithHttpUrls(cleanedShots, filePathMap, baseUrl);

    const normalizedPayload = { ...payload, shots: shotsWithHttpUrls, _tempDir: tempDir };

    renderQueue.push({
      taskId: task.taskId,
      run: () => runRenderInProcess(normalizedPayload, task.taskId),
    });
    scheduleQueueTick();

    res.json({ success: true, taskId: task.taskId });
  } catch (e) {
    console.error('[remotion] render/start 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 轮询状态 ─────────────────────
app.get('/render/status/:id', (req, res) => {
  const task = renderTasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ status: 'not_found', error: '任务不存在或已过期' });
  }
  let stderr = '';
  if (task.status === 'failed') {
    stderr = task.logs
      .filter((l) => typeof l.message === 'string' && l.message.startsWith('[stderr]'))
      .map((l) => l.message.replace(/^\[stderr\]\s*/, ''))
      .join('\n');
  }
  res.json({
    status: task.status,
    progress: task.progress,
    message: task.message,
    error: task.error,
    frame: task.frame,
    totalFrames: task.totalFrames,
    fps: task.fps,
    etaSec: computeEta(task),
    logs: task.logs.slice(-200),
    stderr: stderr || undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
});

// ── 获取结果 ─────────────────────
app.get('/render/result/:id', (req, res) => {
  const task = renderTasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在或已过期' });
  }
  if (task.status !== 'success' || !task.result) {
    return res.status(400).json({
      success: false,
      status: task.status,
      error: task.error || task.message || '任务未完成',
    });
  }
  res.json({ success: true, ...task.result });
});

// ── SSE 实时进度 ─────────────────────
app.get('/render/sse/:id', (req, res) => {
  const taskId = req.params.id;
  const task = renderTasks.get(taskId);
  if (!task) {
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (!sseConnections.has(taskId)) sseConnections.set(taskId, new Set());
  sseConnections.get(taskId).add(res);

  res.write(
    `data: ${JSON.stringify({
      status: task.status,
      progress: task.progress,
      message: task.message,
      frame: task.frame,
      totalFrames: task.totalFrames,
      fps: task.fps,
      etaSec: computeEta(task),
    })}\n\n`
  );

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseConnections.get(taskId)?.delete(res);
  });
});

// ── 队列状态查询 ─────────────────────
app.get('/render/queue', (_req, res) => {
  const queueItems = renderQueue.map((q, i) => ({
    position: i + 1,
    taskId: q.taskId,
  }));
  res.json({
    queueLength: renderQueue.length,
    activeCount: activeWorkers.size,
    maxParallel: MAX_PARALLEL_RENDERS,
    queue: queueItems,
  });
});

// ── 同步渲染（仅本地短镜头测试用）─────────────────────
app.post('/render/sync', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
      return res.status(400).json({ success: false, error: 'shots 不能为空' });
    }
    const taskId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = createRenderTask(payload);

    // 提取 data URL / 远程 URL 为文件
    const { cleanedShots, tempDir, filePathMap } = await extractUrlsToTempFiles(payload.shots);
    // 转换为 HTTP URL → 用 127.0.0.1:PORT 走容器内回环
    const baseUrl = process.env.MEDIA_BASE_URL || `http://127.0.0.1:${PORT}`;
    const shotsWithHttpUrls = replaceFilePathsWithHttpUrls(cleanedShots, filePathMap, baseUrl);
    const normalizedPayload = { ...payload, shots: shotsWithHttpUrls, _tempDir: tempDir };

    try {
      await runRenderInProcess(normalizedPayload, task.taskId);
      const result = renderTasks.get(task.taskId)?.result;
      cleanupTempDir(tempDir);
      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ success: false, error: '渲染未返回结果' });
      }
    } catch (e) {
      cleanupTempDir(tempDir);
      res.status(500).json({ success: false, error: e.message });
    }
  } catch (e) {
    console.error('[remotion] render/sync 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── ASR 字幕提取（本地 Whisper WASM）────────────────────
/**
 * POST /asr/transcribe
 * Body: { audioUrl: string (http/data URL) }
 * Returns: { success, cues: [{startSec, endSec, text}], durationSec, error? }
 *
 * 工作流：
 * 1. 接收 audioUrl（支持 data: URL 或 http://localhost:18093/media/...）
 * 2. 根据 MIME 类型/URL 扩展名保存为对应格式（wav/mp3/m4a/ogg）
 * 3. 调用 transcribeAudio()（本地 WASM whisper，无外网调用）
 * 4. 清理临时文件
 */
app.post('/asr/transcribe', async (req, res) => {
  try {
    const { audioUrl, audioPath, language = 'zh' } = req.body || {};
    // 兼容两种入参：
    //   1. audioUrl: data: URL 直接 inline（不推荐，大文件会被 fetch 切断）
    //   2. audioPath: /tmp/remotion_data_xxx/media_0000.mp3（前端先 /upload-media 拿到的服务端路径）
    const audioSource = audioUrl || audioPath;
    if (!audioSource) {
      return res.status(400).json({ success: false, error: 'audioUrl 或 audioPath 不能为空' });
    }

    // 从 data URL 的 MIME 类型推断文件扩展名，支持 wav/mp3/m4a/ogg 等格式
    let audioExt = '.mp3'; // 默认 mp3
    if (audioSource.startsWith('data:')) {
      const mimeMatch = audioSource.match(/^data:([^;]+)/);
      if (mimeMatch) {
        const mime = mimeMatch[1].toLowerCase();
        if (mime.includes('wav')) audioExt = '.wav';
        else if (mime.includes('mp3') || mime.includes('mpeg')) audioExt = '.mp3';
        else if (mime.includes('m4a')) audioExt = '.m4a';
        else if (mime.includes('ogg')) audioExt = '.ogg';
        else if (mime.includes('flac')) audioExt = '.flac';
      }
    } else if (audioSource.startsWith('/')) {
      // 服务端文件路径：按扩展名推断
      const ext = audioSource.match(/\.([a-z0-9]+)$/i);
      if (ext) audioExt = '.' + ext[1].toLowerCase();
    }
    const tempFile = `/tmp/whisper_audio_${Date.now()}${audioExt}`;
    try {
      let mimeType = 'audio/wav';
      if (audioSource.startsWith('data:')) {
        // data: URL → 直接解码
        const base64 = audioSource.replace(/^data:[^;]+;base64,/, '');
        const mimeMatch = audioSource.match(/^data:([^;]+)/);
        mimeType = mimeMatch ? mimeMatch[1] : 'audio/wav';
        const { writeFileSync } = await import('fs');
        const buffer = Buffer.from(base64, 'base64');
        console.log(`[ASR] 接收 data: URL, MIME=${mimeType}, 大小=${buffer.length} bytes, 扩展名=${audioExt}`);
        writeFileSync(tempFile, buffer);
      } else if (audioSource.startsWith('/')) {
        // 服务端路径：直接读取 copy（upload-media 路径下文件生命周期与请求一致即可）
        // 兼容前端调 /upload-media 后被 toRemotionMediaHttpUrl 转成的相对路径
        // （形如 /api/remotion/media/remotion_data_xxx/...）：把 /api/remotion/media 前缀反向
        // 映射回真实 /tmp 路径，避免文件不存在报错
        const { readFileSync, copyFileSync, writeFileSync } = await import('fs');
        let realPath = audioSource;
        if (audioSource.startsWith('/api/remotion/media/')) {
          realPath = '/tmp/' + audioSource.slice('/api/remotion/media/'.length);
          console.log(`[ASR] 解析相对路径 ${audioSource} → ${realPath}`);
        }
        try {
          copyFileSync(realPath, tempFile);
        } catch (copyErr) {
          // 兜底：直接读取写到一个新文件
          const buf = readFileSync(audioSource);
          writeFileSync(tempFile, buf);
        }
        console.log(`[ASR] 接收服务端路径 audioPath=${audioSource} → ${tempFile}`);
      } else {
        // http(s) URL → 下载
        const response = await fetch(audioSource);
        if (!response.ok) {
          return res.status(400).json({ success: false, error: `下载音频失败: HTTP ${response.status}` });
        }
        const arrayBuffer = await response.arrayBuffer();
        const { writeFileSync } = await import('fs');
        writeFileSync(tempFile, Buffer.from(arrayBuffer));
      }

      // 跑 ASR 在 worker thread 里，不阻塞主进程 event loop
      // （transformers.js WASM 是 CPU-bound，长音频会卡死整个 Express → /health 也会 hang）
      const result = await runAsrInWorker(tempFile, language);

      if (!result.ok) {
        return res.json({
          success: false,
          error: result.error || 'ASR 识别失败',
          durationSec: result.durationSec ?? 0,
        });
      }

      return res.json({
        success: true,
        durationSec: result.durationSec ?? 0,
        text: result.text ?? '',
        cues: (result.words ?? []).map((w) => ({
          startSec: (w.startMs ?? 0) / 1000,
          endSec: (w.endMs ?? 0) / 1000,
          text: w.text ?? '',
        })),
      });
    } finally {
      // 清理临时文件
      try {
        const { unlinkSync } = await import('fs');
        unlinkSync(tempFile);
      } catch {}
    }
  } catch (e) {
    console.error('[asr] /transcribe error:', e);
    res.status(500).json({ success: false, error: e.message ?? String(e) });
  }
});

// ── 音频格式转换（WAV → MP3）────────────────────
/**
 * POST /audio/convert-to-mp3
 * Body: { audioUrl: string (data: URL 或 http URL) }
 * Returns: { success, mp3Url: string (data URL), size: number }
 *
 * 使用 ffmpeg 将音频转换为 MP3 格式
 */
app.post('/audio/convert-to-mp3', async (req, res) => {
  try {
    const { audioUrl } = req.body || {};
    if (!audioUrl) {
      return res.status(400).json({ success: false, error: 'audioUrl 不能为空' });
    }

    const tempWav = `/tmp/convert_to_mp3_${Date.now()}.wav`;
    const tempMp3 = `/tmp/convert_to_mp3_${Date.now()}.mp3`;

    try {
      // 下载音频文件
      if (audioUrl.startsWith('data:')) {
        const base64 = audioUrl.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        writeFileSync(tempWav, buffer);
      } else {
        const response = await fetch(audioUrl);
        if (!response.ok) {
          return res.status(400).json({ success: false, error: `下载音频失败: HTTP ${response.status}` });
        }
        const arrayBuffer = await response.arrayBuffer();
        writeFileSync(tempWav, Buffer.from(arrayBuffer));
      }

      // 检查 ffmpeg 是否可用
      let ffmpegPath = 'ffmpeg';
      let ffmpegOk = false;
      try {
        execSync('ffmpeg -version', { timeout: 3000 });
        ffmpegOk = true;
      } catch {
        // 尝试 ffmpeg-static
        try {
          const nodeModulesDir = localRequire.resolve('ffmpeg-static').replace('/index.js', '');
          ffmpegPath = join(nodeModulesDir, 'ffmpeg');
          if (!existsSync(ffmpegPath)) {
            return res.status(500).json({ success: false, error: 'ffmpeg 不可用' });
          }
          ffmpegOk = true;
        } catch {
          return res.status(500).json({ success: false, error: 'ffmpeg 不可用' });
        }
      }

      // 用 ffmpeg 转换为 MP3
      await new Promise((resolve, reject) => {
        const args = ['-y', '-i', tempWav, '-codec:a', 'libmp3lame', '-qscale:a', '2', '-ar', '44100', '-ac', '2', tempMp3];
        const proc = spawn(ffmpegPath, args);
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg 转换失败: ${stderr.slice(-200)}`));
        });
        proc.on('error', reject);
      });

      // 读取 MP3 文件并转为 base64
      const mp3Data = readFileSync(tempMp3);
      const mp3Base64 = mp3Data.toString('base64');
      const mp3DataUrl = `data:audio/mpeg;base64,${mp3Base64}`;

      console.log(`[audio] WAV → MP3 转换完成: ${mp3Data.length} bytes`);
      return res.json({ success: true, mp3Url: mp3DataUrl, size: mp3Data.length });
    } finally {
      // 清理临时文件
      try { unlinkSync(tempWav); } catch {}
      try { unlinkSync(tempMp3); } catch {}
    }
  } catch (e) {
    console.error('[audio] /convert-to-mp3 error:', e);
    res.status(500).json({ success: false, error: e.message ?? String(e) });
  }
});

// ── 错误处理 ─────────────────────
app.use((err, _req, res, _next) => {
  console.error('[remotion] error:', err);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`[remotion-server] 监听端口 ${PORT}`);
  console.log(`[remotion-server] 输出目录: ${OUTPUT_DIR}`);
  console.log(`[remotion-server] remotion 项目: ${REMOTION_PROJECT_ENTRY}`);
  if (!existsSync(REMOTION_PROJECT_ENTRY)) {
    console.warn(`[remotion-server] ⚠️  未找到 remotion 入口文件: ${REMOTION_PROJECT_ENTRY}`);
  }
  // 启动后立即尝试加载 Remotion 模块
  loadRemotionModules().then(loaded => {
    if (loaded) {
      console.log('[remotion-server] ✅ Remotion 模块就绪');
    } else {
      console.error('[remotion-server] ❌ Remotion 模块加载失败，将在首次渲染时重试');
    }
  });

  // v1.11：启动时 + 每小时清理过期的 MP4 文件
  //   - 默认保留 24 小时（由 REMOTION_KEEP_OUTPUT_HOURS 覆盖）
  //   - 仅清理 OUTPUT_DIR 下的 *.mp4 文件（不动 parts 子目录里的临时分段）
  //   - 这样即使容器不重启，用户完成下载后我们也能腾出磁盘
  scheduleOutputCleanup();
});
