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
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

app.use('/api/remotion/download', express.static(OUTPUT_DIR, {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
    }
  },
}));

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
    payload,
    result: null,
    error: null,
    progress: 0,
    message: '任务已创建',
    logs: [],
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
  notifySse(taskId, {
    status: task.status,
    progress: task.progress,
    message: task.message,
  });
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
              updateTask(taskId, {
                progress: msg.progress,
                message: msg.message,
              });
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
      stderrBuf += chunk.toString();
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

    // 异步执行
    setImmediate(() => {
      runRenderWorker(normalizedPayload, task.taskId)
        .then((result) => {
          cleanupTempDir(tempDir);
          if (result) {
            updateTask(task.taskId, {
              status: 'success',
              progress: 100,
              message: '渲染完成',
              result,
            });
          }
        })
        .catch((err) => {
          cleanupTempDir(tempDir);
          updateTask(task.taskId, {
            status: 'failed',
            error: err.message,
            message: `渲染失败: ${err.message}`,
          });
        });
    });

    res.json({ success: true, taskId: task.taskId });
  } catch (e) {
    console.error('[remotion] render/start 失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
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
  res.json({
    status: task.status,
    progress: task.progress,
    message: task.message,
    error: task.error,
    logs: task.logs.slice(-20),
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

  // 立即推送当前状态
  res.write(
    `data: ${JSON.stringify({
      status: task.status,
      progress: task.progress,
      message: task.message,
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
