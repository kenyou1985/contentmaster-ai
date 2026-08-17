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
import { existsSync, mkdirSync, writeFileSync, createReadStream, statSync, readFileSync, rmSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import os from 'os';
import multer from 'multer';
import { createRequire } from 'module';

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

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
const IS_VERCEL = !!process.env.VERCEL;
const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.json({ limit: '2gb' }));
app.use(express.urlencoded({ extended: true, limit: '2gb' }));

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

app.use('/download', express.static(OUTPUT_DIR, {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
    }
  },
}));

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

function tickQueue() {
  while (activeWorkers.size < 1 && renderQueue.length > 0) {
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
 * 把文件路径替换为 HTTP URL（Remotion webpack dev server 需要 HTTP URL）
 * @param {Array} shots - 包含文件路径的 shots
 * @param {Map} filePathMap - data URL → 文件路径 的映射
 * @param {string} baseUrl - 如 http://localhost:8080
 */
function replaceFilePathsWithHttpUrls(shots, filePathMap, baseUrl) {
  const reversedMap = new Map();
  for (const [dataUrl, filePath] of filePathMap) {
    // filePath 形如 /tmp/remotion_data_xxx/media_0000.png
    // /media 路由已经 mount 到 /tmp，所以 URL 应该是 /media/remotion_data_xxx/media_0000.png
    // 需要去掉 /tmp 前缀
    const urlPath = filePath.replace(/^\/tmp/, '');
    reversedMap.set(filePath, `${baseUrl}/media${urlPath}`);
  }

  const result = JSON.parse(JSON.stringify(shots));
  for (const shot of result) {
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      if (shot[key] && reversedMap.has(shot[key])) {
        shot[key] = reversedMap.get(shot[key]);
      }
    }
    if (Array.isArray(shot.imageUrls)) {
      shot.imageUrls = shot.imageUrls.map((u) =>
        u && reversedMap.has(u) ? reversedMap.get(u) : u
      );
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
const healthHandler = (_req, res) => {
  let chromiumOk = false;
  let chromiumVersion = null;
  let ffmpegOk = false;
  let ffmpegVersion = null;
  try {
    chromiumVersion = execSync('chromium --version 2>/dev/null || google-chrome --version 2>/dev/null || echo ""', { timeout: 3000 })
      .toString().trim();
    chromiumOk = /Chromium|Google Chrome/i.test(chromiumVersion);
  } catch {}
  try {
    ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -1', { timeout: 3000 }).toString().trim();
    ffmpegOk = /ffmpeg/i.test(ffmpegVersion);
  } catch {}

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
app.post('/upload-media', async (req, res) => {
  try {
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

    // 优先：Remotion 官方 @remotion/renderer.extractAudio()
    //   用包内 @remotion/compositor-darwin-arm64/ffmpeg（macOS ARM64 专用编译版，
    //   同包 spawn，dylib 解析正常，无需 DYLD_LIBRARY_PATH）
    let ffmpegOk = false;
    let ffmpegVersion = null;
    let usedExtractor = 'unknown';
    const tempDir = join('/tmp', `audio_extract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
    const safeName = (fileName || 'input.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
    const inPath = join(tempDir, safeName);
    const outPath = join(tempDir, safeName.replace(/\.[^.]+$/, '') + '.wav');
    writeFileSync(inPath, bytes);

    // 路径 1：Remotion 官方 extractAudio（自动找包内 ffmpeg，零依赖）
    try {
      const { extractAudio: remotionExtractAudio } = require('@remotion/renderer');
      console.log(`[remotion] 使用 @remotion/renderer.extractAudio() 提取音轨`);
      await remotionExtractAudio({
        videoSource: inPath,
        audioOutput: outPath,
        logLevel: 'error',
      });
      usedExtractor = 'remotion.extractAudio';
      ffmpegOk = true;
      ffmpegVersion = '@remotion/compositor-darwin-arm64 (bundle)';
    } catch (e1) {
      console.warn(`[remotion] @remotion/renderer.extractAudio 失败: ${e1.message?.slice(0, 300)}`);
      // 路径 2：fallback 到用户机器上的 ffmpeg binary
      const candidates = [];
      try { candidates.push(require('ffmpeg-static')); } catch {}
      candidates.push('/Applications/小V猫.app/Contents/Resources/app/ffmpeg');
      candidates.push('/Applications/易剪媒.app/Contents/Resources/extraResources/ffmpeg/mac/ffmpeg');
      candidates.push('/Applications/剪映专业版5.9.app/Contents/Resources/ffmpeg');
      candidates.push('/opt/homebrew/bin/ffmpeg');
      candidates.push('/usr/local/bin/ffmpeg');

      for (const p of candidates) {
        if (!p) continue;
        if (!existsSync(p)) continue;
        try {
          // 验证可执行
          execSync(`"${p}" -version`, { timeout: 3000, stdio: 'pipe' });
        } catch (verifyErr) {
          console.warn(`[remotion] ffmpeg ${p} 不可执行: ${verifyErr.message?.slice(0, 100)}`);
          continue;
        }
        console.log(`[remotion] 用 fallback ffmpeg: ${p}`);
        ffmpegVersion = execSync(`"${p}" -version 2>&1 | head -1`).toString().trim();
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
          ], { timeout: 120_000 }, (err, _stdout, stderr) => {
            if (err) reject(new Error(stderr?.toString()?.slice(0, 300) || err.message));
            else resolve();
          });
        });
        usedExtractor = `shell-ffmpeg(${p})`;
        ffmpegOk = true;
        break;
      }
    }

    if (!ffmpegOk) {
      rmSync(tempDir, { recursive: true, force: true });
      return res.status(503).json({
        success: false,
        error: '服务端所有 ffmpeg 路径都失败（@remotion/renderer.extractAudio + 所有 fallback binary）',
      });
    }

    const wavBytes = readFileSync(outPath);
    const wavSizeKB = (wavBytes.length / 1024).toFixed(1);
    console.log(`[remotion] ffmpeg 输出: ${wavSizeKB} KB (${Date.now() - startedAt}ms)`);

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
    });
  } catch (e) {
    console.error('[remotion] /audio/extract 失败:', e);
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
    maxParallel: 1,
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
 * 2. 保存到 /tmp/whisper_audio_*.mp3
 * 3. 调用 transcribeAudio()（本地 WASM whisper，无外网调用）
 * 4. 清理临时文件
 */
app.post('/asr/transcribe', async (req, res) => {
  try {
    const { audioUrl, language = 'zh' } = req.body || {};
    if (!audioUrl) {
      return res.status(400).json({ success: false, error: 'audioUrl 不能为空' });
    }

    const tempFile = `/tmp/whisper_audio_${Date.now()}.mp3`;
    try {
      let audioData;
      if (audioUrl.startsWith('data:')) {
        // data: URL → 直接解码
        const base64 = audioUrl.replace(/^data:[^;]+;base64,/, '');
        const { writeFileSync } = await import('fs');
        const buffer = Buffer.from(base64, 'base64');
        writeFileSync(tempFile, buffer);
      } else {
        // http(s) URL → 下载
        const response = await fetch(audioUrl);
        if (!response.ok) {
          return res.status(400).json({ success: false, error: `下载音频失败: HTTP ${response.status}` });
        }
        const arrayBuffer = await response.arrayBuffer();
        const { writeFileSync } = await import('fs');
        writeFileSync(tempFile, Buffer.from(arrayBuffer));
      }

      // 懒加载 ASR 服务（首次调用时才初始化模型）
      const { transcribeAudio } = await import('./asr-service.mjs');
      const result = await transcribeAudio(tempFile, language);

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
});
