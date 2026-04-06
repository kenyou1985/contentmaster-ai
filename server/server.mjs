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
  // cors 未安装，手写简单跨域头
  cors = null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, '..', 'services', 'jianying_export_service.py');
const PORT = 18091;

function runPythonStdin(args, stdinData) {
  return new Promise((resolve, reject) => {
    if (!existsSync(SCRIPT_PATH)) {
      reject(new Error(`Python 脚本不存在: ${SCRIPT_PATH}`));
      return;
    }
    const child = spawn('python3', [SCRIPT_PATH, ...args]);

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      console.error(`[server] Python 进程超时 (60s)`);
    }, 60000);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // 通过 stdin 写入 JSON，避免命令行参数超限（E2BIG）
    if (stdinData !== undefined) {
      child.stdin.write(JSON.stringify(stdinData));
      child.stdin.end();
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('Python 进程超时（60s），可能被大文件阻塞'));
        return;
      }
      if (code !== 0) {
        console.error(`[server] Python 错误 (exit ${code}):\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 1000)}`);
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
  return runPythonStdin(args, undefined);
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

  // POST /api/jianying/export  → 导出草稿
  if (req.method === 'POST' && url.pathname === '/api/jianying/export') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        // shots 走 stdin 传递，避免命令行超限（E2BIG）
        const { code, stdout, stderr } = await runPythonStdin(
          [
            '--name', payload.draftName || '未命名',
            '--shots-json-stdin',  // 告诉 Python 从 stdin 读 shots JSON
            '--resolution', payload.resolution || '1920x1080',
            '--fps', String(payload.fps || 30),
          ],
          {
            shots: payload.shots || [],
            outputPath: payload.outputPath || null,
            randomTransitions: !!payload.randomTransitions,
            randomVideoEffects: !!payload.randomVideoEffects,
          }
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

  // POST /api/jianying/echo  → 调试：原样返回请求体（测试 Vite proxy 是否正常）
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
  console.log(`🔗 GET  /api/jianying/list     → 列出所有草稿`);
  console.log(`🔗 POST /api/jianying/export   → 导出草稿`);
  console.log(`🔗 GET  /api/jianying/health  → 健康检查`);
});
