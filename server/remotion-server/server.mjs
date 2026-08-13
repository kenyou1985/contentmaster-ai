#!/usr/bin/env node
/**
 * ContentMaster AI - Remotion 视频渲染 HTTP 服务
 *
 * 路由：
 *   GET  /health                       → 健康检查
 *   POST /api/remotion/upload-media    → data URL → temp file
 *   POST /api/remotion/render/start    → 异步提交渲染任务
 *   GET  /api/remotion/render/status/:id → 轮询状态
 *   GET  /api/remotion/render/result/:id → 获取最终 MP4
 *   POST /api/remotion/render/sync     → 同步短路（仅供本地短镜头）
 *   GET  /api/remotion/render/sse/:id  → SSE 实时进度
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDER_WORKER = join(__dirname, 'render-worker.mjs');
const REMOTION_PROJECT_ENTRY = join(__dirname, '..', '..', 'remotion', 'src', 'index.tsx');
const REMOTION_PROJECT_ROOT = join(__dirname, '..', '..', 'remotion');

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
const IS_VERCEL = !!process.env.VERCEL;
const PORT = process.env.PORT || (IS_RAILWAY ? 10000 : 18093);

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
      return cb(null, true); // 暂时全开，后续收紧
    },
    credentials: true,
  })
);

// ── 静态文件：存放渲染好的 MP4 ─────────────────────
const OUTPUT_DIR = process.env.REMOTION_OUTPUT_DIR || (IS_RAILWAY ? join('/tmp', 'remotion-out') : join('/tmp', 'remotion-out'));
const LOG_DIR = join(OUTPUT_DIR, 'logs');
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

app.use('/api/remotion/download', express.static(OUTPUT_DIR, {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
    }
  },
}));

// ── 渲染队列（批量任务串行调度，避免内存爆炸）─────────────────────
const MAX_PARALLEL_WORKERS = 1; // 默认串行（macOS 内存优先），可改为 2 启用并行
const renderQueue = [];        // 待执行任务队列
const activeWorkers = new Set(); // 正在运行的 taskId
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
  while (activeWorkers.size < MAX_PARALLEL_WORKERS && renderQueue.length > 0) {
    const next = renderQueue.shift();
    activeWorkers.add(next.taskId);
    next.run().finally(() => {
      activeWorkers.delete(next.taskId);
      scheduleQueueTick();
    });
  }
}

function enqueueRender(taskId, payload) {
  renderQueue.push({
    taskId,
    run: () => runRenderWorker(payload, taskId),
  });
  updateTask(taskId, {
    status: 'queued',
    progress: 0,
    message: `排队中（前面还有 ${renderQueue.length} 个任务）`,
  });
  scheduleQueueTick();
}

// ── 任务队列（内存版）──────────────────────────────
const renderTasks = new Map();
const TASK_TTL_MS = 1000 * 60 * 60; // 60 分钟（长视频）
const sseConnections = new Map(); // taskId → Set<res>

function createRenderTask(payload) {
  const taskId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const task = {
    taskId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    renderStartAt: now, // M2 #13: 用于估算 ETA
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
    } catch {
      /* ignore */
    }
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
  // M2 #13：SSE 推送帧进度（frame / totalFrames / fps / eta）
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

/**
 * M2 #13：根据已渲染帧数和 FPS 估算剩余时间（秒）
 * - 需要 >= 2 个 progress 数据点才能估算
 * - 简单的滚动平均：每收到一个进度就重新计算
 */
function computeEta(task) {
  if (!task.frame || !task.totalFrames || !task.fps) return undefined;
  const elapsedMs = Date.now() - (task.renderStartAt ?? task.createdAt);
  if (elapsedMs <= 0) return undefined;
  const framesPerSec = task.frame / (elapsedMs / 1000);
  if (framesPerSec <= 0) return undefined;
  const remainingFrames = Math.max(0, task.totalFrames - task.frame);
  return Math.round(remainingFrames / framesPerSec);
}

// ── Data URL → Temp File 转换 ─────────────────────
const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/gif': '.gif', 'image/webp': '.webp',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav',
  'audio/ogg': '.ogg', 'audio/m4a': '.m4a', 'audio/aac': '.aac',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a',
};

function extractDataUrlsToTempFiles(shots) {
  const tempDir = join('/tmp', `remotion_data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tempDir, { recursive: true });
  const replacements = new Map();

  for (const shot of shots) {
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      const val = shot[key];
      if (!val || typeof val !== 'string' || !val.startsWith('data:')) continue;
      if (replacements.has(val)) continue;
      const headerMatch = val.match(/^data:([^;]+)/);
      const mime = headerMatch ? headerMatch[1] : 'application/octet-stream';
      const ext = MIME_EXT[mime] || '.bin';
      const idx = replacements.size;
      const filePath = join(tempDir, `media_${String(idx).padStart(4, '0')}${ext}`);
      const commaIdx = val.indexOf(',');
      const b64data = commaIdx >= 0 ? val.slice(commaIdx + 1) : val;
      writeFileSync(filePath, Buffer.from(b64data, 'base64'));
      replacements.set(val, filePath);
    }
    if (Array.isArray(shot.imageUrls)) {
      for (const u of shot.imageUrls) {
        if (!u || !u.startsWith('data:') || replacements.has(u)) continue;
        const headerMatch = u.match(/^data:([^;]+)/);
        const mime = headerMatch ? headerMatch[1] : 'application/octet-stream';
        const ext = MIME_EXT[mime] || '.bin';
        const idx = replacements.size;
        const filePath = join(tempDir, `media_${String(idx).padStart(4, '0')}${ext}`);
        const commaIdx = u.indexOf(',');
        const b64data = commaIdx >= 0 ? u.slice(commaIdx + 1) : u;
        writeFileSync(filePath, Buffer.from(b64data, 'base64'));
        replacements.set(u, filePath);
      }
    }
  }

  const cleanedShots = JSON.parse(JSON.stringify(shots));
  for (const shot of cleanedShots) {
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      if (shot[key] && shot[key].startsWith('data:')) {
        shot[key] = replacements.get(shot[key]) || shot[key];
      }
    }
    if (Array.isArray(shot.imageUrls)) {
      shot.imageUrls = shot.imageUrls.map((u) =>
        u && u.startsWith('data:') ? replacements.get(u) || u : u
      );
    }
  }

  return { cleanedShots, tempDir };
}

function cleanupTempDir(tempDir) {
  try {
    if (tempDir && tempDir.includes('/tmp/remotion_data_')) {
      const { rmSync } = require('fs');
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

// ── 子进程调用 render-worker.mjs（stdin 传参，绕过 macOS argv 256KB 上限）────
function runRenderWorker(payload, taskId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      [RENDER_WORKER],
      {
        cwd: REMOTION_PROJECT_ROOT,
        env: {
          ...process.env,
          REMOTION_PROJECT_ROOT,
          REMOTION_OUTPUT_DIR: OUTPUT_DIR,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdoutBuf += s;
      // 每行尝试解析 JSON 进度
      const lines = s.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const msg = JSON.parse(trimmed);
            if (msg.type === 'progress') {
              const patch = {
                progress: msg.progress,
                message: msg.message,
                frame: msg.frame,
                totalFrames: msg.totalFrames,
                fps: msg.fps,
              };
              updateTask(taskId, patch);
              // M2 #12 兼容：长视频分批时，前缀信息直接包含 part 索引
            } else if (msg.type === 'log') {
              updateTask(taskId, { message: msg.message });
            } else if (msg.type === 'done') {
              updateTask(taskId, {
                status: 'success',
                progress: 100,
                message: '渲染完成',
                result: msg.result,
              });
            } else if (msg.type === 'error') {
              updateTask(taskId, {
                status: 'failed',
                error: msg.error,
                message: '渲染失败',
              });
            }
          } catch (e) {
            if (trimmed.length > 0) {
              updateTask(taskId, { message: trimmed });
            }
          }
        } else if (trimmed.length > 0) {
          updateTask(taskId, { message: trimmed });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      // stderr 通常是 error stack，把每一行也作为日志推送给前端
      const task = renderTasks.get(taskId);
      if (task) {
        for (const line of s.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          task.logs.push({
            time: Date.now(),
            progress: task.progress,
            message: `[stderr] ${trimmed}`,
          });
          if (task.logs.length > 500) task.logs = task.logs.slice(-500);
        }
        notifySse(taskId, {
          status: task.status,
          progress: task.progress,
          message: task.message,
          // 失败时附上 stderr tail，方便前端直接显示 stack trace
          stderrTail: task.status === 'failed' ? stderrBuf.slice(-2000) : undefined,
        });
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        const task = renderTasks.get(taskId);
        if (task && task.status === 'success') {
          resolve(task.result);
        } else {
          resolve(task?.result || null);
        }
      } else {
        reject(new Error(`render-worker 退出码 ${code}: ${stderrBuf.slice(-500)}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });

    // 把 payload 通过 stdin 传给 worker（绕过 argv 256KB 上限）
    const msg = JSON.stringify({ payload, taskId, outputDir: OUTPUT_DIR });
    child.stdin.write(msg);
    child.stdin.end();
  });
}

// ── 健康检查（同时支持 /health 与 /api/remotion/health，兼容前端 proxy 链）────
const healthHandler = (_req, res) => {
  res.json({
    status: 'ok',
    service: 'remotion-render-server',
    port: PORT,
    platform: IS_RAILWAY ? 'railway' : IS_VERCEL ? 'vercel' : 'local',
    remotionEntry: REMOTION_PROJECT_ENTRY,
    remotionEntryExists: existsSync(REMOTION_PROJECT_ENTRY),
    outputDir: OUTPUT_DIR,
    activeTasks: renderTasks.size,
    timestamp: Date.now(),
  });
};
app.get('/health', healthHandler);
app.get('/api/remotion/health', healthHandler);

// M2 #11：bundle 缓存状态查询
app.get('/api/remotion/bundle-cache/stats', async (_req, res) => {
  try {
    const { getCacheStats } = await import('./bundle-cache.mjs');
    const stats = getCacheStats();
    res.json({ success: true, ...stats });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/remotion/bundle-cache/clear', async (_req, res) => {
  try {
    const { clearWebpackCache } = await import('./bundle-cache.mjs');
    const cacheDir = join('/tmp', 'remotion-bundle-cache');
    let cleared = false;
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
      cleared = true;
    }
    const projectCache = join(REMOTION_PROJECT_ROOT, 'node_modules', '.cache', 'webpack');
    clearWebpackCache(REMOTION_PROJECT_ROOT);
    res.json({ success: true, cleared, manifestCleared: true, webpackCleared: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 同时兼容 /api/remotion 重写到根（部分前端/反代会带 strip）
// 这里不主动改路径，下面路由已经全部以 /api/remotion/* 形式提供。

// ── 本地 WASM Whisper ASR ─────────────────────
import { transcribeBatch, getPipeline } from './asr-service.mjs';

app.post('/api/remotion/asr/transcribe', async (req, res) => {
  try {
    const { items = [], model } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items 不能为空' });
    }

    // items: Array<{ id: string; audioPath: string; language?: string }>
    const results = await transcribeBatch(
      items,
      (done, total, current) => {
        console.log(`[ASR] ${done}/${total} 完成，当前: ${current}`);
      }
    );

    res.json({ success: true, results });
  } catch (e) {
    console.error('[ASR] transcribe 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 预热：提前加载 Whisper 模型（用户还没开始渲染时点一下）
app.get('/api/remotion/asr/warmup', async (req, res) => {
  try {
    await getPipeline();
    res.json({ success: true, message: '模型已就绪' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 模型状态检查
app.get('/api/remotion/asr/status', async (req, res) => {
  res.json({ ready: true, model: 'Xenova/whisper-base' });
});

// ── Data URL 上传 ─────────────────────
app.post('/api/remotion/upload-media', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items 必须是非空数组' });
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

// ── 长视频分批渲染（M2 #12：>30 分钟自动分批 + ffmpeg 拼接）─────────────────────
app.post('/api/remotion/render/long', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
      return res.status(400).json({ success: false, error: 'shots 不能为空' });
    }

    const shots = payload.shots;
    const fps = payload.config?.fps || 30;
    const totalDur = shots.reduce(
      (s: number, x: any) => s + (x.audioDurationExact ?? x.audioDurationSec ?? x.duration ?? 4),
      0
    );

    const LONG_THRESHOLD = 1800; // 30 分钟
    if (totalDur <= LONG_THRESHOLD) {
      // 短于阈值：走普通路由
      const task = createRenderTask(payload);
      const { cleanedShots, tempDir } = extractDataUrlsToTempFiles(payload.shots);
      const normalizedPayload = { ...payload, shots: cleanedShots, _tempDir: tempDir };
      enqueueRender(task.taskId, normalizedPayload);
      return res.json({
        success: true,
        taskId: task.taskId,
        mode: 'single',
        message: '视频短于 30 分钟，使用单段渲染',
      });
    }

    // 长视频分批：每个分段独立一个 task，前端可分段观察
    const { splitShotsIntoSegments } = await import('./batch-renderer.mjs');
    const segments = splitShotsIntoSegments(shots, 1200); // 每段 ≤ 20 分钟

    const parentTaskId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const childTaskIds: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segShots = segments[i];
      const segPayload = { ...payload, shots: segShots };
      const childTask = createRenderTask(segPayload);
      childTask.parentTaskId = parentTaskId;
      childTask.segmentIndex = i;
      childTask.totalSegments = segments.length;
      childTaskIds.push(childTask.taskId);
      const { cleanedShots, tempDir } = extractDataUrlsToTempFiles(segShots);
      const normalizedPayload = { ...segPayload, shots: cleanedShots, _tempDir: tempDir };
      enqueueRender(childTask.taskId, normalizedPayload);
    }

    // 父任务用于串联进度（前端按整体观察）
    const parentTask = createRenderTask(payload);
    parentTask.taskId = parentTaskId;
    parentTask.isParent = true;
    parentTask.segmentCount = segments.length;
    parentTask.childTaskIds = childTaskIds;
    renderTasks.set(parentTaskId, parentTask);
    updateTask(parentTaskId, {
      status: 'running',
      progress: 5,
      message: `长视频：${(totalDur / 60).toFixed(1)} 分钟 → ${segments.length} 个分段（并行排队中）`,
    });

    res.json({
      success: true,
      taskId: parentTaskId,
      mode: 'batch',
      segmentCount: segments.length,
      childTaskIds,
      message: `长视频检测：${(totalDur / 60).toFixed(1)} 分钟，分为 ${segments.length} 段渲染`,
    });

    // 异步：等所有子任务完成后 ffmpeg 拼接
    setImmediate(async () => {
      try {
        const { concatMp4 } = await import('./batch-renderer.mjs');
        await waitForTasks(childTaskIds, parentTaskId);
        const segResults = childTaskIds.map((tid) => renderTasks.get(tid)?.result).filter(Boolean);
        if (segResults.length !== segments.length) {
          throw new Error(`子任务未全部成功（${segResults.length}/${segments.length}）`);
        }
        // 把分段的 shot 数据写到 result 里好让前端拼接文件路径
        const finalPath = join(OUTPUT_DIR, `${parentTaskId}.mp4`);
        const realPartPaths = childTaskIds.map((tid) => {
          const r = renderTasks.get(tid)?.result;
          return r?.outputPath || join(OUTPUT_DIR, `${tid}.mp4`);
        });
        await concatMp4(realPartPaths, finalPath, (m) => logTask(parentTaskId, m));
        const stats = statSync(finalPath);
        updateTask(parentTaskId, {
          status: 'success',
          progress: 100,
          message: `分批拼接完成（${segments.length} 段 → 1 个 MP4）`,
          result: {
            outputPath: finalPath,
            outputUrl: `/api/remotion/download/${parentTaskId}.mp4`,
            durationSec: segResults.reduce((s: number, r: any) => s + (r.durationSec || 0), 0),
            videoDurationSec: segResults.reduce((s: number, r: any) => s + (r.durationSec || 0), 0),
            videoSizeBytes: stats.size,
            resolution: payload.config?.resolution || '1920x1080',
            fps,
            format: 'mp4',
            taskId: parentTaskId,
            segments: segments.map((seg, i) => ({
              index: i,
              taskId: childTaskIds[i],
              shotsCount: seg.length,
              path: realPartPaths[i],
            })),
          },
        });
      } catch (err: any) {
        updateTask(parentTaskId, {
          status: 'failed',
          error: err.message,
          message: `分批拼接失败: ${err.message}`,
        });
      }
    });
  } catch (e: any) {
    console.error('[remotion] render/long 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** 等待多个子任务完成 */
function waitForTasks(taskIds: string[], parentTaskId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const total = taskIds.length;
    let done = 0;
    let failed = 0;
    const interval = setInterval(() => {
      let allDone = true;
      let anyFailed = false;
      for (const tid of taskIds) {
        const t = renderTasks.get(tid);
        if (!t) {
          anyFailed = true;
          continue;
        }
        if (t.status === 'success') done++;
        else if (t.status === 'failed') {
          done++;
          anyFailed = true;
        } else {
          allDone = false;
        }
      }
      // 更新父任务进度 = 平均子任务进度
      const avg = taskIds.reduce((s, tid) => s + (renderTasks.get(tid)?.progress || 0), 0) / total;
      updateTask(parentTaskId, {
        progress: Math.min(95, Math.round(avg)),
        message: `分批渲染进度：${done}/${total} 段完成${anyFailed ? '（含失败段）' : ''}`,
      });
      if (allDone || anyFailed) {
        clearInterval(interval);
        if (anyFailed) {
          reject(new Error(`${failed || '某'}段渲染失败`));
        } else {
          resolve();
        }
      }
    }, 2000);
  });
}

function logTask(taskId: string, msg: string) {
  const task = renderTasks.get(taskId);
  if (!task) return;
  task.logs.push({ time: Date.now(), message: msg });
  if (task.logs.length > 500) task.logs = task.logs.slice(-500);
  process.stdout.write(JSON.stringify({ type: 'log', taskId, message: msg }) + '\n');
}

// ── 异步提交渲染任务 ─────────────────────
app.post('/api/remotion/render/start', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
      return res.status(400).json({ success: false, error: 'shots 不能为空' });
    }

    const task = createRenderTask(payload);
    updateTask(task.taskId, { status: 'running', progress: 5, message: '任务已入队' });

    // data URL 提取
    const { cleanedShots, tempDir } = extractDataUrlsToTempFiles(payload.shots);
    const normalizedPayload = { ...payload, shots: cleanedShots, _tempDir: tempDir };

    // 异步执行（通过全局队列限流）
    enqueueRender(task.taskId, normalizedPayload);

    res.json({ success: true, taskId: task.taskId });
  } catch (e) {
    console.error('[remotion] render/start 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 批量提交（M2 #8：一次提交多个任务，自动排队执行）─────────────────────
app.post('/api/remotion/render/batch', async (req, res) => {
  try {
    const { tasks } = req.body || {};
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ success: false, error: 'tasks 必须是非空数组' });
    }
    const taskIds = [];
    for (const payload of tasks) {
      if (!payload || !Array.isArray(payload.shots) || payload.shots.length === 0) continue;
      const task = createRenderTask(payload);
      taskIds.push(task.taskId);
      const { cleanedShots, tempDir } = extractDataUrlsToTempFiles(payload.shots);
      const normalizedPayload = { ...payload, shots: cleanedShots, _tempDir: tempDir };
      enqueueRender(task.taskId, normalizedPayload);
    }
    res.json({
      success: true,
      taskIds,
      count: taskIds.length,
      message: `已入队 ${taskIds.length} 个任务`,
    });
  } catch (e) {
    console.error('[remotion] render/batch 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 队列状态查询（M2 #8：前端展示"前面还有 N 个任务"）─────────────────────
app.get('/api/remotion/render/queue', (_req, res) => {
  const queueItems = renderQueue.map((q, i) => ({
    position: i + 1,
    taskId: q.taskId,
    shots: q.shots || 0, // 占位，createRenderTask 时记录
  }));
  res.json({
    queueLength: renderQueue.length,
    activeCount: activeWorkers.size,
    maxParallel: MAX_PARALLEL_WORKERS,
    queue: queueItems,
  });
});

// ── 同步渲染（仅本地短镜头测试用）─────────────────────
app.post('/api/remotion/render/sync', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!Array.isArray(payload.shots) || payload.shots.length === 0) {
      return res.status(400).json({ success: false, error: 'shots 不能为空' });
    }
    const taskId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { cleanedShots, tempDir } = extractDataUrlsToTempFiles(payload.shots);
    const normalizedPayload = { ...payload, shots: cleanedShots, _tempDir: tempDir };
    try {
      const result = await runRenderWorker(normalizedPayload, taskId);
      cleanupTempDir(tempDir);
      res.json({ success: true, ...result });
    } catch (e) {
      cleanupTempDir(tempDir);
      res.status(500).json({ success: false, error: e.message });
    }
  } catch (e) {
    console.error('[remotion] render/sync 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 轮询状态 ─────────────────────
app.get('/api/remotion/render/status/:id', (req, res) => {
  const task = renderTasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ status: 'not_found', error: '任务不存在或已过期' });
  }
  // 失败时返回完整 stderr（用于前端 stack trace 展示）
  let stderr = '';
  if (task.status === 'failed') {
    // 从最近 500 行日志里抓所有 [stderr] 行，重组成完整 stderr
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
    logs: task.logs.slice(-200), // 失败时给前端更多上下文
    stderr: stderr || undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
});

// ── 获取结果 ─────────────────────
app.get('/api/remotion/render/result/:id', (req, res) => {
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
  res.json({
    success: true,
    ...task.result,
  });
});

// ── SSE 实时进度 ─────────────────────
app.get('/api/remotion/render/sse/:id', (req, res) => {
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

  // 立即推送当前状态（含 frame/eta）
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

  // 30 秒心跳
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseConnections.get(taskId)?.delete(res);
  });
});

// ── 完整日志文件（调试用）─────────────────────
app.get('/api/remotion/render/log/:id', (req, res) => {
  const taskId = req.params.id;
  const logPath = join(LOG_DIR, `${taskId}.log`);
  if (!existsSync(logPath)) {
    return res.status(404).json({ success: false, error: '日志文件不存在或已过期' });
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(logPath).pipe(res);
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
});
