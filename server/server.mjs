/**
 * 剪映草稿导出 HTTP 服务
 * 前端通过 fetch('/api/jianying/...') 调用
 * 内部通过 child_process 调用 Python 脚本
 */
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let cors;
try {
  cors = require('cors');
} catch {
  cors = null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, '..', 'services', 'jianying_export_service.py');
const PORT = 18091;

// 异步导出任务队列（内存存储）
const exportTasks = new Map();
const EXPORT_TASK_TTL_MS = 1000 * 60 * 30; // 30 分钟过期

function createExportTask(payload) {
  const taskId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const task = {
    taskId,
    status: 'queued', // queued | running | success | failed
    createdAt: now,
    updatedAt: now,
    payload,
    result: null,
    error: null,
    logs: [],
    progress: 0,
    progressMessage: '',
  };
  exportTasks.set(taskId, task);
  return task;
}

function pruneOldTasks() {
  const now = Date.now();
  for (const [id, t] of exportTasks.entries()) {
    if (now - (t.updatedAt || t.createdAt || now) > EXPORT_TASK_TTL_MS) {
      exportTasks.delete(id);
    }
  }
}

function runPythonStdin(args, stdinData, onProgress) {
  return new Promise((resolve, reject) => {
    if (!existsSync(SCRIPT_PATH)) {
      reject(new Error(`Python 脚本不存在: ${SCRIPT_PATH}`));
      return;
    }
    const child = spawn('python3', [SCRIPT_PATH, ...args]);

    let killed = false;
    // 本地导出超时增加到 5 分钟（处理大文件和慢速下载）
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      console.error(`[server] Python 进程超时 (300s)`);
    }, 300000);

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

    // 通过 stdin 写入 JSON，避免命令行参数超限（E2BIG）
    if (stdinData !== undefined) {
      const jsonData = JSON.stringify(stdinData);
      const writable = child.stdin;
      writable.on('error', (err) => {
        // EPIPE: Python 进程在写入完成前已退出，属于正常情况，忽略即可
        if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
          console.error(`[server] stdin write error: ${err.code} ${err.message}`);
        }
      });
      try {
        writable.write(jsonData, () => {
          writable.end();
        });
      } catch (err) {
        // 写入时直接抛错（如管道已关闭），忽略
      }
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('Python 进程超时（5分钟），可能被大文件阻塞'));
        return;
      }
      if (stderr.trim()) {
        console.error(`[server] Python stderr:\n${stderr.slice(0, 5000)}`);
      }
      // 检查 stderr 中是否有真正的错误（而非进度输出）
      const errorPatterns = ['error', 'exception', 'traceback', 'failed', 'Error:', 'Exception:', 'Traceback'];
      const hasError = errorPatterns.some(pattern => 
        stderr.toLowerCase().includes(pattern.toLowerCase()) && !stderr.includes('[PROGRESS]')
      );
      
      if (code !== 0 || hasError) {
        // 提取错误信息
        const errorLines = stderr.split('\n')
          .filter(line => {
            const lower = line.toLowerCase();
            return !line.includes('[PROGRESS]') && 
                   (lower.includes('error') || lower.includes('exception') || 
                    lower.includes('traceback') || lower.includes('failed'));
          })
          .map(line => line.trim())
          .filter(line => line.length > 0);
        
        const errorMsg = errorLines.length > 0 
          ? errorLines.join('; ').slice(0, 500)
          : (code !== 0 ? `Python 进程异常退出 (code: ${code})` : '未知错误');
        
        reject(new Error(errorMsg));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[server] spawn error: ${err.message}`);
      reject(err);
    });
  });
}

// 向后兼容：无 stdin 的简单调用
function runPython(args) {
  return runPythonStdin(args, undefined, null);
}

async function runLocalExportJob(payload, taskId) {
  const {
    draftName = 'ContentMaster_Export',
    shots = [],
    resolution = '1920x1080',
    fps = 30,
    outputPath = null,
    forceDraftFolderName = null,
    randomTransitions = false,
    randomVideoEffects = false,
  } = payload || {};

  const task = taskId ? exportTasks.get(taskId) : null;

  const notify = (progress, message) => {
    if (task) {
      task.progress = progress;
      task.progressMessage = message;
      task.logs.push({ time: Date.now(), progress, message });
      if (task.logs.length > 500) {
        task.logs = task.logs.slice(-500);
      }
    }
    console.log(`[server] 任务 ${taskId} 进度: ${progress}% - ${message}`);
  };

  notify(5, '开始处理...');

  const { code, stdout, stderr } = await runPythonStdin(
    [
      '--name', draftName,
      '--shots-json-stdin',
      '--resolution', resolution,
      '--fps', String(fps),
    ],
    {
      shots,
      outputPath,
      forceDraftFolderName,
      randomTransitions,
      randomVideoEffects,
    },
    (progress, stage) => {
      // Python 进度回调：0-100 之间
      const scaledProgress = Math.round(5 + progress * 0.9);
      notify(scaledProgress, stage || '处理中...');
    }
  );

  notify(95, '解析结果...');

  // 处理 stderr 中的调试日志和进度信息
  if (stderr.trim()) {
    // 处理 [PROGRESS] 进度行
    const progressLines = stderr.split('\n').filter(line =>
      line.includes('[PROGRESS]')
    );
    if (progressLines.length > 0 && task) {
      progressLines.forEach(line => {
        const match = line.match(/\[PROGRESS\]\s*(\d+)\|(.+)/);
        if (match) {
          task.logs.push({ time: Date.now(), progress: parseInt(match[1]), message: match[2].trim() });
        }
      });
    }
    // 处理其他调试日志
    const debugLines = stderr.split('\n').filter(line =>
      (line.includes('[jianying_export]') || line.includes('[jianying-server]')) && !line.includes('[PROGRESS]')
    );
    if (debugLines.length > 0 && task) {
      debugLines.forEach(line => {
        task.logs.push({ time: Date.now(), progress: task.progress || 95, message: line.trim() });
      });
    }
  }

  const text = (stdout || '').trim();

  // 检查 Python 是否执行成功
  const pythonErrorLines = stderr.split('\n').filter(line => {
    const lower = line.toLowerCase();
    return line.trim() && 
           !line.includes('[jianying_export]') && 
           !line.includes('[jianying-server]') &&
           !line.includes('[PROGRESS]') &&
           (lower.includes('error') || lower.includes('exception') || 
            lower.includes('traceback') || lower.includes('failed'));
  });

  if (!text) {
    if (pythonErrorLines.length > 0) {
      const errorMsg = pythonErrorLines.join('; ').slice(0, 500);
      console.error(`[server] 任务 ${taskId} Python 执行失败: ${errorMsg}`);
      throw new Error(errorMsg);
    }
    if (stderr.includes('[jianying_export]')) {
      throw new Error('Python 脚本执行异常：无有效输出');
    }
    throw new Error('Python 无输出');
  }

  notify(98, '解析响应...');

  try {
    const result = JSON.parse(text);
    notify(100, '完成');
    return result;
  } catch {
    const i = text.lastIndexOf('{');
    const j = text.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(text.slice(i, j + 1));
      } catch {
        // ignore
      }
    }
    const low = text.toLowerCase();
    if (/success|完成|草稿|draft|✅/.test(text) && !/error|失败|traceback/.test(low)) {
      return { success: true, message: text, platform: 'jianying' };
    }
    throw new Error(text.slice(0, 500));
  }
}

async function handleRequest(req, res) {
  // 简单 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /api/jianying/list  → 列出所有草稿
  if (req.method === 'GET' && url.pathname === '/api/jianying/list') {
    try {
      const { stdout, code, stderr } = await runPython(['--list-json']);
      if (code !== 0) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: stderr || `exit ${code}` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stdout.trim() || '[]');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/jianying/export/start  → 异步任务开始（新增）
  if (req.method === 'POST' && url.pathname === '/api/jianying/export/start') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        pruneOldTasks();
        const payload = JSON.parse(body);
        const shots = payload?.shots;
        if (!Array.isArray(shots) || shots.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'shots 不能为空' }));
          return;
        }

        const task = createExportTask(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, taskId: task.taskId, status: task.status }));

        // 异步执行导出任务
        setImmediate(async () => {
          const current = exportTasks.get(task.taskId);
          if (!current) return;

          try {
            current.status = 'running';
            current.updatedAt = Date.now();
            const result = await runLocalExportJob(payload, task.taskId);
            current.status = 'success';
            current.result = result;
            current.updatedAt = Date.now();
            current.payload = undefined;
            console.log(`[server] 任务 ${task.taskId} 完成`);
          } catch (e) {
            current.status = 'failed';
            current.error = e?.message || String(e);
            current.updatedAt = Date.now();
            current.payload = undefined;
            console.error(`[server] 任务 ${task.taskId} 失败:`, current.error);
          }
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/jianying/export/status/:taskId  → 轮询任务状态（新增）
  if (req.method === 'GET' && url.pathname.startsWith('/api/jianying/export/status/')) {
    pruneOldTasks();
    const taskId = url.pathname.replace('/api/jianying/export/status/', '');
    const task = exportTasks.get(taskId);

    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'task not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      taskId: task.taskId,
      status: task.status,
      progress: task.status === 'success' ? 100 : task.status === 'failed' ? -1 : (task.progress || 0),
      message: task.progressMessage || '',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      error: task.error || null,
      logs: task.logs || [],
    }));
    return;
  }

  // GET /api/jianying/export/result/:taskId  → 获取任务结果（新增）
  if (req.method === 'GET' && url.pathname.startsWith('/api/jianying/export/result/')) {
    pruneOldTasks();
    const taskId = url.pathname.replace('/api/jianying/export/result/', '');
    const task = exportTasks.get(taskId);

    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'task not found' }));
      return;
    }

    if (task.status === 'success') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task.result || { success: true }));
      return;
    }

    if (task.status === 'failed') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: task.error || 'export failed' }));
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, status: task.status, message: '任务仍在执行中' }));
    return;
  }

  // POST /api/jianying/export  → 导出草稿（同步版本，保持兼容）
  if (req.method === 'POST' && url.pathname === '/api/jianying/export') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { code, stdout, stderr } = await runPythonStdin(
          [
            '--name', payload.draftName || '未命名',
            '--shots-json-stdin',
            '--resolution', payload.resolution || '1920x1080',
            '--fps', String(payload.fps || 30),
          ],
          {
            shots: payload.shots || [],
            outputPath: payload.outputPath || null,
            randomTransitions: !!payload.randomTransitions,
            randomVideoEffects: !!payload.randomVideoEffects,
          },
          null // 不传 onProgress，同步接口不支持进度回调
        );
        if (code !== 0) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: stderr || `exit ${code}`,
            stdout: stdout.slice(0, 500),
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(stdout.trim());
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/jianying/health  → 健康检查
  if (req.method === 'GET' && url.pathname === '/api/jianying/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', script: SCRIPT_PATH, exists: existsSync(SCRIPT_PATH) }));
    return;
  }

  // POST /api/jianying/echo  → 调试：原样返回请求体
  if (req.method === 'POST' && url.pathname === '/api/jianying/echo') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echo: 'ok', shots: payload.shots?.length, totalSize: body.length }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echo: 'parse_error', error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer(handleRequest);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 剪映导出服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`📄 Python 脚本: ${SCRIPT_PATH}`);
  console.log(`🔗 GET  /api/jianying/list              → 列出所有草稿`);
  console.log(`🔗 POST /api/jianying/export            → 导出草稿（同步）`);
  console.log(`🔗 POST /api/jianying/export/start      → 导出草稿（异步，返回 taskId）`);
  console.log(`🔗 GET  /api/jianying/export/status/:id → 轮询任务状态`);
  console.log(`🔗 GET  /api/jianying/export/result/:id → 获取任务结果`);
  console.log(`🔗 GET  /api/jianying/health           → 健康检查`);
});
