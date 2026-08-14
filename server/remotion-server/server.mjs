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
 *   GET  /render/sse/:id               → SSE 实时进度
 *   GET  /download/:file               → 下载渲染好的 MP4
 *
 * 端口：18093（本地）
 *      Railway / Vercel 由 PORT 环境变量决定
 */
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, createReadStream, statSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import os from 'os';
import { execSync } from 'child_process';
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

/**
 * 把 data URL 转成文件路径，返回 { cleanedShots, tempDir, filePathMap }
 * filePathMap: data URL → 文件路径 的映射
 */
function extractDataUrlsToTempFiles(shots) {
  const tempDir = join('/tmp', `remotion_data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tempDir, { recursive: true });
  const filePathMap = new Map();

  for (const shot of shots) {
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      const val = shot[key];
      if (!val || typeof val !== 'string' || !val.startsWith('data:')) continue;
      if (filePathMap.has(val)) continue;
      const headerMatch = val.match(/^data:([^;]+)/);
      const mime = headerMatch ? headerMatch[1] : 'application/octet-stream';
      const ext = MIME_EXT[mime] || '.bin';
      const idx = filePathMap.size;
      const filePath = join(tempDir, `media_${String(idx).padStart(4, '0')}${ext}`);
      const commaIdx = val.indexOf(',');
      const b64data = commaIdx >= 0 ? val.slice(commaIdx + 1) : val;
      writeFileSync(filePath, Buffer.from(b64data, 'base64'));
      filePathMap.set(val, filePath);
    }
    if (Array.isArray(shot.imageUrls)) {
      for (const u of shot.imageUrls) {
        if (!u || !u.startsWith('data:') || filePathMap.has(u)) continue;
        const headerMatch = u.match(/^data:([^;]+)/);
        const mime = headerMatch ? headerMatch[1] : 'application/octet-stream';
        const ext = MIME_EXT[mime] || '.bin';
        const idx = filePathMap.size;
        const filePath = join(tempDir, `media_${String(idx).padStart(4, '0')}${ext}`);
        const commaIdx = u.indexOf(',');
        const b64data = commaIdx >= 0 ? u.slice(commaIdx + 1) : u;
        writeFileSync(filePath, Buffer.from(b64data, 'base64'));
        filePathMap.set(u, filePath);
      }
    }
  }

  const cleanedShots = JSON.parse(JSON.stringify(shots));
  for (const shot of cleanedShots) {
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      if (shot[key] && shot[key].startsWith('data:')) {
        shot[key] = filePathMap.get(shot[key]) || shot[key];
      }
    }
    if (Array.isArray(shot.imageUrls)) {
      shot.imageUrls = shot.imageUrls.map((u) =>
        u && u.startsWith('data:') ? filePathMap.get(u) || u : u
      );
    }
  }

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
    reversedMap.set(filePath, `${baseUrl}/media${filePath}`);
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
  const log = (msg) => {
    try {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      writeFileSync(logPath, line, { flag: 'a' });
      console.log(msg);
    } catch {}
  };

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
      const totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
      return totalMemGB >= 16 ? 2 : 1;
    };

    await renderer.renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: config.codec === 'h265' ? 'h265' : 'h264',
      outputLocation: outputPath,
      inputProps,
      concurrency: getConcurrency(),
      chromiumOptions: {
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--disable-gpu',
        ],
      },
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

// ── 异步提交渲染任务 ─────────────────────
app.post('/render/start', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
      return res.status(400).json({ success: false, error: 'shots 不能为空' });
    }

    const task = createRenderTask(payload);
    updateTask(task.taskId, { status: 'running', progress: 0, message: '任务已入队' });

    // 提取 data URL 为文件
    const { cleanedShots, tempDir, filePathMap } = extractDataUrlsToTempFiles(payload.shots);

    // 构建 baseUrl 并转换为 HTTP URL（Remotion webpack dev server 需要 HTTP URL）
    const baseUrl = `${req.protocol}://${req.get('host')}`;
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

    // 提取 data URL 为文件
    const { cleanedShots, tempDir, filePathMap } = extractDataUrlsToTempFiles(payload.shots);
    // 转换为 HTTP URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;
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
