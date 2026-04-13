#!/usr/bin/env node
/**
 * ContentMaster AI - 剪映草稿导出 HTTP 服务
 * 部署到 Render.com（Web Service）
 *
 * 路由：
 *   GET  /health            → 健康检查（Render 存活探针）
 *   GET  /api/jianying/list → 列出所有草稿（需 macOS 完全磁盘访问权限）
 *   POST /api/jianying/export → 导出剪映草稿（下载媒体文件 + 生成 JSON）
 *   GET  /api/jianying/health → Python 脚本健康检查
 */
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PYTHON_SCRIPT = join(__dirname, 'jianying_export_service.py');
const PORT = process.env.PORT || 10000; // Render.com 免费版分配随机端口

const app = express();
const recentZipPathByName = new Map();

// 异步导出任务（内存队列，进程重启后会清空）
const exportTasks = new Map();
const EXPORT_TASK_TTL_MS = 1000 * 60 * 30; // 30 分钟

// SSE 连接队列（taskId → Set<{res, controller}>）
const taskSseConnections = new Map();

function createExportTask(payload) {
  const taskId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const task = {
    taskId,
    status: 'queued', // queued | running | success | failed
    createdAt: now,
    updatedAt: now,
    payload,
    result: null,
    error: null,
  };
  exportTasks.set(taskId, task);
  return task;
}

function pruneOldExportTasks() {
  const now = Date.now();
  for (const [id, t] of exportTasks.entries()) {
    if (now - (t.updatedAt || t.createdAt || now) > EXPORT_TASK_TTL_MS) {
      exportTasks.delete(id);
    }
  }
}

// SSE 流式推送：任务状态变化时通知所有订阅者
function notifyTaskSse(taskId, data) {
  const connections = taskSseConnections.get(taskId);
  if (!connections) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const { controller } of connections) {
    try {
      controller.enqueue(new TextEncoder().encode(payload));
    } catch {
      // 连接已关闭，忽略
    }
  }
}

function normalizeExportResult(result, returnZip) {
  if (!result || typeof result !== 'object') return result;
  if (returnZip && result.zip_path) {
    const zipFilename = basename(result.zip_path);
    recentZipPathByName.set(zipFilename, result.zip_path);
    result.zip_download_url = `/api/jianying/download/${encodeURIComponent(zipFilename)}`;
  }
  return result;
}

async function runExportJob(payload, taskId) {
  const {
    draftName = 'ContentMaster_Export',
    shots = [],
    resolution = '1920x1080',
    fps = 30,
    outputPath = null,
    pathMapRoot = process.env.JIANYING_PATH_MAP_ROOT || null,
    randomTransitions = false,
    randomVideoEffects = false,
    returnZip = false,
  } = payload || {};

  // SSE 进度通知函数
  const notify = (progress, message) => {
    if (taskId) {
      notifyTaskSse(taskId, { progress, message, status: 'running' });
    }
    console.log(`[jianying-server] 任务 ${taskId} 进度: ${progress}% - ${message}`);
  };

  notify(5, '开始处理...');

  const { code, stdout, stderr } = await runPythonStdin(
    [
      '--name', draftName,
      '--shots-json-stdin',
      '--resolution', resolution,
      '--fps', String(fps),
      '--progress-callback',
    ],
    {
      shots,
      outputPath,
      pathMapRoot,
      randomTransitions,
      randomVideoEffects,
    },
    (progress, stage) => {
      // Python 进度回调：0-95% 之间
      const scaledProgress = Math.round(5 + progress * 0.9);
      notify(scaledProgress, stage || '处理中...');
    }
  );

  notify(95, '解析结果...');

  // 调试日志过滤：只记录 stderr 中的调试信息，不当作错误
  if (stderr.trim()) {
    const debugLines = stderr.split('\n').filter(line =>
      line.includes('[jianying_export]') || line.includes('[jianying-server]')
    );
    if (debugLines.length > 0) {
      console.log('[jianying-server] Python 调试日志:\n', debugLines.join('\n').slice(0, 2000));
    }
  }

  // 处理 stdout：这是 Python 脚本的实际输出（JSON）
  const text = (stdout || '').trim();

  // 如果 stdout 为空但 stderr 有调试信息，说明可能有问题
  if (!text) {
    // 检查 stderr 中是否有真正的错误（不是调试日志）
    const errorLines = stderr.split('\n').filter(line =>
      line.trim() && !line.includes('[jianying_export]') && !line.includes('[jianying-server]')
    );
    if (errorLines.length > 0) {
      throw new Error(errorLines.join(' ').slice(0, 500));
    }
    // 如果有调试日志但没有实际输出，说明可能有问题
    if (stderr.includes('[jianying_export]')) {
      throw new Error('Python 脚本执行异常：无有效输出');
    }
    throw new Error('Python 无输出');
  }

  notify(98, '解析响应...');

  // 成功情况：尝试解析 JSON
  try {
    const result = normalizeExportResult(JSON.parse(text), returnZip);
    notify(100, '完成');
    return result;
  } catch {
    // JSON 解析失败，尝试提取
    const i = text.lastIndexOf('{');
    const j = text.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        return normalizeExportResult(JSON.parse(text.slice(i, j + 1)), returnZip);
      } catch {
        // ignore
      }
    }
    // 非 JSON 响应：检查是否是成功消息
    const low = text.toLowerCase();
    if (/success|完成|草稿|draft|✅/.test(text) && !/error|失败|traceback/.test(low)) {
      return { success: true, message: text, platform: 'jianying' };
    }
    throw new Error(text.slice(0, 500));
  }
}

// CORS：允许 Vercel 部署的前端调用
// 本地 localhost:3000 + 各种开发服务器端口（Vite 5173/5174/5175）
const ALLOWED_ORIGINS = [
  /vercel\.app$/,
  /contentmaster.*\.vercel\.app$/,
  /\.contentmaster-ai\.vercel\.app$/,
  'https://contentmaster-ai.vercel.app',
  // 自定义正式域名
  'https://contentmaster-ai.77aiai.com',
  'https://www.contentmaster-ai.77aiai.com',
  // Railway/Render 部署的剪映服务端自身
  'https://contentmaster-ai-production.up.railway.app',
  // 本地开发（支持各种端口）
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
  'http://127.0.0.1:8080',
];

function isOriginAllowed(origin) {
  if (!origin) return false;
  // 同源请求直接放行
  if (origin === `http://localhost:${PORT}` || origin === `https://localhost:${PORT}`) return true;
  for (const o of ALLOWED_ORIGINS) {
    if (typeof o === 'string') {
      if (origin === o) return true;
    } else if (o instanceof RegExp) {
      if (o.test(origin)) return true;
    }
  }
  return false;
}

app.use(cors({
  origin: (origin, callback) => {
    // 同源请求或没有 origin（server-to-server）直接放行
    if (!origin || isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] 拒绝来源: ${origin}`);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false,
  maxAge: 86400,
}));

app.use(express.json({
  limit: '100mb',
  inflate: true,
  // 自定义错误处理：区分请求中止（不打印为 ERROR）和格式错误
  verify: (req, _res, buf) => {
    req._rawBody = buf;
  }
}));

// 统一错误处理中间件（处理所有中间件错误，包括 JSON 解析、请求中止等）
// Express 4 错误中间件必须 4 个参数: (err, req, res, next)
app.use((err, req, res, _next) => {
  const errMsg = err?.message || '';
  const errType = err?.type || '';
  const errCode = err?.code || '';

  // 检测是否是客户端断连错误（Railway 平台超时、客户端主动取消等）
  // 这些不是服务端问题，只是正常的中止，不返回响应（已 headers sent）
  const isClientAbort =
    /aborted|closed|ECONNRESET|request aborted|client aborted/i.test(errMsg) ||
    /aborted|closed|ECONNRESET|request aborted/i.test(errType) ||
    errCode === 'ECONNRESET' ||
    errCode === 'ERR_STREAM_PREMATURE_CLOSE' ||
    errCode === 'HTTP_ERROR' ||
    req.socket?.destroyed;

  if (isClientAbort) {
    // 客户端已断开，不尝试发送响应
    console.warn('[jianying-server] 客户端断开了连接');
    if (!res.headersSent) {
      res.end();
    }
    return;
  }

  // BadRequestError: JSON 格式错误
  if (errType === 'entity.parse.failed') {
    console.error('[jianying-server] JSON 解析失败:', errMsg);
    if (!res.headersSent) {
      res.status(400).json({ error: '请求格式错误', detail: errMsg });
    }
    return;
  }

  // 请求体过大
  if (errType === 'entity.too.large') {
    console.warn('[jianying-server] 请求体过大');
    if (!res.headersSent) {
      res.status(413).json({ error: '请求体过大，最大支持 100MB' });
    }
    return;
  }

  // 其他中间件错误
  console.error('[jianying-server] 请求处理错误:', errMsg || err);
  if (!res.headersSent) {
    res.status(500).json({ error: errMsg || 'Internal error' });
  }
});

// 请求超时中间件（Railway/Render 默认 30s 太短）
app.use((req, res, next) => {
  // Railway/Render 请求超时约 60s，增加到 5 分钟
  req.setTimeout(300_000);
  res.setTimeout(300_000);
  next();
});

// ── 健康检查（Render 存活探针）──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jianying-export-server', port: PORT });
});

// ── Python 脚本健康检查 ───────────────────────────────────────────────────
app.get('/api/jianying/health', (_req, res) => {
  const scriptExists = existsSync(PYTHON_SCRIPT);
  res.json({
    status: scriptExists ? 'ok' : 'missing',
    script: PYTHON_SCRIPT,
    exists: scriptExists,
  });
});

// ── 列出剪映草稿（仅 macOS 有完全磁盘访问权限，Windows/Linux 不可用）──
app.get('/api/jianying/list', (_req, res) => {
  runPython(['--list-json'], null)
    .then(({ code, stdout, stderr }) => {
      if (code !== 0) {
        return res.status(500).json({ error: stderr || `exit ${code}` });
      }
      try {
        const data = JSON.parse(stdout.trim() || '[]');
        res.json(Array.isArray(data) ? data : []);
      } catch {
        res.json([]);
      }
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// ── 导出剪映草稿（SSE 流式进度）─────────────────────────────────────────────
// GET /api/jianying/export/sse/:taskId - SSE 流式推送任务状态（前端订阅）
app.get('/api/jianying/export/sse/:taskId', (req, res) => {
  const { taskId } = req.params;
  pruneOldExportTasks();

  // 检查任务是否存在
  const task = exportTasks.get(taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: 'task not found' });
  }

  // 设置 SSE 头（Railway 代理兼容）
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
    'Access-Control-Allow-Origin': '*',
    'Keep-Alive': 'timeout=300, max=1000',
  });

  // 发送初始连接确认
  res.write(`data: ${JSON.stringify({ type: 'connected', taskId })}\n\n`);

  // 心跳保活定时器（Railway 代理每 30-60s 超时，需每 15s 发心跳）
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      // 连接已断开
    }
  }, 15000);

  // 将此连接加入任务订阅队列
  const controller = {
    enqueue: (chunk) => {
      try {
        res.write(chunk);
      } catch {
        // 连接已断开
      }
    }
  };

  const entry = { res, controller };
  if (!taskSseConnections.has(taskId)) {
    taskSseConnections.set(taskId, new Set());
  }
  taskSseConnections.get(taskId).add(entry);

  // 立即发送当前状态
  res.write(`data: ${JSON.stringify({
    type: 'status',
    taskId: task.taskId,
    status: task.status,
    progress: task.status === 'success' ? 100 : task.status === 'failed' ? -1 : (task.progress || 0),
    message: task.progressMessage || '',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error || null,
  })}\n\n`);

  // 如果已完成，立即发送结果
  if (task.status === 'success' && task.result) {
    res.write(`data: ${JSON.stringify({ type: 'result', ...task.result })}\n\n`);
  } else if (task.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: 'error', error: task.error || '任务失败' })}\n\n`);
  }

  // 清理函数：连接断开时移除
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    const conns = taskSseConnections.get(taskId);
    if (conns) {
      conns.delete(entry);
      if (conns.size === 0) {
        taskSseConnections.delete(taskId);
      }
    }
  });
});

// ── 导出剪映草稿（异步任务）──────────────────────────────────────────────
app.post('/api/jianying/export/start', (req, res) => {
  pruneOldExportTasks();
  const payload = req.body || {};
  const shots = payload?.shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    return res.status(400).json({ success: false, error: 'shots 不能为空' });
  }

  const task = createExportTask(payload);
  res.json({ success: true, taskId: task.taskId, status: task.status });

  setImmediate(async () => {
    const current = exportTasks.get(task.taskId);
    if (!current) return;
    current.status = 'running';
    current.updatedAt = Date.now();

    // SSE 通知任务开始
    notifyTaskSse(task.taskId, { status: 'running', progress: 0, message: '任务已启动' });

    try {
      const result = await runExportJob(payload, task.taskId);
      current.status = 'success';
      current.result = result;
      current.updatedAt = Date.now();
      current.payload = undefined;

      // SSE 通知任务完成
      notifyTaskSse(task.taskId, {
        status: 'success',
        progress: 100,
        message: '导出完成',
        ...result,
      });
    } catch (e) {
      current.status = 'failed';
      current.error = e?.message || String(e);
      current.updatedAt = Date.now();
      current.payload = undefined;
      console.error('[jianying-server] export task failed:', current.taskId, current.error);

      // SSE 通知任务失败
      notifyTaskSse(task.taskId, {
        status: 'failed',
        progress: -1,
        message: '导出失败',
        error: current.error,
      });
    }
  });
});

app.get('/api/jianying/export/status/:taskId', (req, res) => {
  pruneOldExportTasks();
  const task = exportTasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: 'task not found' });
  }
  res.json({
    success: true,
    taskId: task.taskId,
    status: task.status,
    progress: task.status === 'success' ? 100 : task.status === 'failed' ? -1 : (task.progress || 0),
    message: task.progressMessage || '',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error || null,
  });
});

app.get('/api/jianying/export/result/:taskId', (req, res) => {
  pruneOldExportTasks();
  const task = exportTasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: 'task not found' });
  }
  if (task.status === 'success') {
    return res.json(task.result || { success: true });
  }
  if (task.status === 'failed') {
    return res.status(500).json({ success: false, error: task.error || 'export failed' });
  }
  return res.status(202).json({ success: false, status: task.status, message: '任务仍在执行中' });
});

// 兼容旧接口：同步执行（可能超时，不建议线上使用）
app.post('/api/jianying/export', async (req, res) => {
  const payload = req.body || {};
  const shots = payload?.shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    return res.status(400).json({ success: false, error: 'shots 不能为空' });
  }
  try {
    const result = await runExportJob(payload);
    return res.json(result);
  } catch (err) {
    console.error('[jianying-server] export error:', err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// ── 下载导出的 ZIP（Railway Linux 场景）────────────────────────────────────
app.get('/api/jianying/download/:filename', (req, res) => {
  try {
    const filename = basename(req.params.filename || '');
    if (!filename || !filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const candidates = [];

    const remembered = recentZipPathByName.get(filename);
    if (remembered) candidates.push(resolve(remembered));

    // 默认目录兜底（兼容历史行为）
    candidates.push(resolve('/root/Movies/JianyingPro/User Data/Projects/com.lveditor.draft', filename));
    // 当前服务目录 exports 兜底
    candidates.push(resolve(__dirname, 'exports', filename));

    const zipPath = candidates.find((p) => existsSync(p));
    if (!zipPath) {
      return res.status(404).json({ error: 'zip not found' });
    }
    res.download(zipPath, filename);
  } catch (e) {
    res.status(500).json({ error: e.message || 'download failed' });
  }
});

// ── 404 ──────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── 启动 ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 剪映导出服务已启动，端口: ${PORT}`);
  console.log(`📄 Python 脚本: ${PYTHON_SCRIPT}`);
  console.log(`   exists: ${existsSync(PYTHON_SCRIPT)}`);
  console.log(`🌐 允许的来源: Vercel 前端 + 本地 localhost:3000`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 内部工具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 通过 stdin 传递 JSON（避免命令行参数超限 E2BIG）
 * @param {string[]} args - Python CLI 参数
 * @param {object|null} payload - 通过 stdin 传入的数据
 * @param {function|null} onProgress - 进度回调 (progress: number, stage: string) => void
 */
function runPythonStdin(args, payload, onProgress = null) {
  return new Promise((resolve, reject) => {
    if (!existsSync(PYTHON_SCRIPT)) {
      reject(new Error(`Python 脚本不存在: ${PYTHON_SCRIPT}`));
      return;
    }

    // 优先使用 python3
    const pyCmd = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
    const child = spawn(pyCmd, [PYTHON_SCRIPT, ...args], {
      // Railway 下载+打包可能需要更长时间（10分钟）
      timeout: 600_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let killed = false;
    // 10 分钟超时（处理大量媒体文件下载+打包）
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      console.error('[jianying-server] Python 进程超时被杀（10分钟）');
    }, 600_000);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      // 解析进度行: [PROGRESS] 50|下载音频...
      if (onProgress) {
        const m = text.match(/\[PROGRESS\]\s*(\d+)\|(.+)/);
        if (m) {
          try {
            onProgress(parseInt(m[1]), m[2]);
          } catch {
            // 解析失败，忽略
          }
        }
      }
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // stdin 写入 JSON，flush 后 end
    if (payload !== null && payload !== undefined) {
      const jsonData = JSON.stringify(payload);
      const writable = child.stdin;
      writable.write(jsonData, () => {
        writable.end();
      });
    } else {
      child.stdin.end();
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? -1 : code, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 无 stdin 的调用（向后兼容） */
function runPython(args) {
  return runPythonStdin(args, null);
}
