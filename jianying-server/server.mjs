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

// CORS：允许 Vercel 部署的前端调用
app.use(cors({
  origin: [
    /vercel\.app$/,
    /contentmaster.*\.vercel\.app$/,
    /\.contentmaster-ai\.vercel\.app$/,
    'https://contentmaster-ai.vercel.app',
    // 本地开发
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '50mb' }));

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

// ── 导出剪映草稿（核心接口）───────────────────────────────────────────────
app.post('/api/jianying/export', (req, res) => {
  const {
    draftName = 'ContentMaster_Export',
    shots = [],
    resolution = '1920x1080',
    fps = 30,
    outputPath = null,
    randomTransitions = false,
    randomVideoEffects = false,
    returnZip = false,
  } = req.body || {};

  if (!Array.isArray(shots) || shots.length === 0) {
    return res.status(400).json({ success: false, error: 'shots 不能为空' });
  }

  runPythonStdin(
    [
      '--name', draftName,
      '--shots-json-stdin',
      '--resolution', resolution,
      '--fps', String(fps),
    ],
    {
      shots,
      outputPath,
      randomTransitions,
      randomVideoEffects,
    }
  )
    .then(({ code, stdout, stderr }) => {
      // stderr 含调试日志，stdout 为 JSON 响应
      if (stderr.trim()) {
        console.error('[jianying-server] Python stderr:\n', stderr.slice(0, 2000));
      }
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `Python exit ${code}`,
          stdout: stdout.slice(0, 500),
        });
      }
      const text = stdout.trim();
      if (!text) {
        return res.status(500).json({ success: false, error: 'Python 无输出' });
      }
      // 尝试解析 JSON，若失败则按成功文本处理
      try {
        const result = JSON.parse(text);
        if (returnZip && result?.zip_path) {
          result.zip_download_url = `/api/jianying/download/${encodeURIComponent(basename(result.zip_path))}`;
        }
        res.json(result);
      } catch {
        // stdout 夹杂日志时，尝试提取最后一个 JSON 对象
        const s = text.trim();
        const i = s.lastIndexOf('{');
        const j = s.lastIndexOf('}');
        if (i >= 0 && j > i) {
          try {
            const result = JSON.parse(s.slice(i, j + 1));
            if (returnZip && result?.zip_path) {
              result.zip_download_url = `/api/jianying/download/${encodeURIComponent(basename(result.zip_path))}`;
            }
            return res.json(result);
          } catch {
            // ignore
          }
        }
        const low = text.toLowerCase();
        if (/success|完成|草稿|draft|✅/.test(text) && !/error|失败|traceback/.test(low)) {
          res.json({ success: true, message: text, platform: 'jianying' });
        } else {
          res.json({ success: false, error: text });
        }
      }
    })
    .catch((err) => {
      console.error('[jianying-server] export error:', err);
      res.status(500).json({ success: false, error: err.message });
    });
});

// ── 下载导出的 ZIP（Railway Linux 场景）────────────────────────────────────
app.get('/api/jianying/download/:filename', (req, res) => {
  try {
    const filename = basename(req.params.filename || '');
    if (!filename || !filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const zipPath = resolve('/root/Movies/JianyingPro/User Data/Projects/com.lveditor.draft', filename);
    if (!existsSync(zipPath)) {
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
 */
function runPythonStdin(args, payload) {
  return new Promise((resolve, reject) => {
    if (!existsSync(PYTHON_SCRIPT)) {
      reject(new Error(`Python 脚本不存在: ${PYTHON_SCRIPT}`));
      return;
    }

    // 优先使用 python3
    const pyCmd = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
    const child = spawn(pyCmd, [PYTHON_SCRIPT, ...args], {
      // Free tier 超时：60s
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, 60_000);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
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
