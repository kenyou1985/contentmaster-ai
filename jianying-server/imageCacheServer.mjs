#!/usr/bin/env node
/**
 * ContentMaster AI - 媒体本地缓存 HTTP 服务
 * 将 dataUrl（base64 图片/视频）保存到本地文件系统，供剪映导出时使用。
 *
 * 端口：18092（与 vite.config.ts 的 /api/image-cache 代理对应）
 *
 * 路由：
 *   GET  /health              → 健康检查
 *   POST /api/image-cache/save → 保存 media dataUrl，返回本地路径
 *   GET  /api/image-cache/exists?path=... → 检查路径是否存在
 */
import express from 'express';
import { existsSync, mkdirSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { dirname, basename, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 18092;
const CACHE_DIR = process.env.IMAGE_CACHE_DIR
  ? resolve(process.env.IMAGE_CACHE_DIR)
  : join(__dirname, 'image_cache');

// 确保缓存目录存在
try {
  mkdirSync(CACHE_DIR, { recursive: true });
} catch (e) {
  // 可能已存在，忽略
}

const app = express();

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// ── 健康检查 ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'image-cache-server', port: PORT, cacheDir: CACHE_DIR });
});

// ── 保存媒体文件 ─────────────────────────────────────────────────────────
// Body: { url: string, dataUrl: string }
// Response: { path: string }
app.post('/api/image-cache/save', async (req, res) => {
  try {
    const { url, dataUrl } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'missing or invalid url' });
    }
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
      return res.status(400).json({ error: 'missing or invalid dataUrl (must be data:...;base64,...)' });
    }

    // 从 dataUrl 解析 mimeType 和 base64 数据
    const commaIdx = dataUrl.indexOf(',');
    const header = dataUrl.slice(0, commaIdx);
    const b64data = dataUrl.slice(commaIdx + 1);

    // 解析 mimeType，兜底为 application/octet-stream
    const mimeMatch = header.match(/data:([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

    // 根据 mimeType 确定扩展名
    const MIME_TO_EXT = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/webm': 'webm',
      'video/x-msvideo': 'avi',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
    };
    const ext = MIME_TO_EXT[mimeType] || 'bin';

    // 生成文件名：url 的 hash（避免特殊字符）+ 时间戳 + 扩展名
    const urlHash = url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80);
    const timestamp = Date.now();
    const filename = `${urlHash}_${timestamp}.${ext}`;
    const filePath = join(CACHE_DIR, filename);

    // 写入文件
    const buffer = Buffer.from(b64data, 'base64');
    writeFileSync(filePath, buffer);

    console.log(`[image-cache] saved: ${filename} (${(buffer.byteLength / 1024).toFixed(1)} KB) from ${url.slice(0, 60)}`);
    res.json({ path: filePath, filename, sizeBytes: buffer.byteLength });
  } catch (e) {
    console.error('[image-cache] save error:', e);
    res.status(500).json({ error: e?.message || 'save failed' });
  }
});

// ── 检查路径是否存在 ─────────────────────────────────────────────────────
app.get('/api/image-cache/exists', (req, res) => {
  const { path: filePath } = req.query || {};
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'missing path query param' });
  }

  // 安全检查：拒绝访问 CACHE_DIR 以外的路径
  const resolved = resolve(String(filePath));
  if (!resolved.startsWith(CACHE_DIR)) {
    return res.status(403).json({ error: 'forbidden: path outside cache directory' });
  }

  try {
    const stat = statSync(resolved);
    res.json({ exists: true, sizeBytes: stat.size });
  } catch {
    res.json({ exists: false });
  }
});

// ── 清理单个文件 ─────────────────────────────────────────────────────────
app.delete('/api/image-cache/file', (req, res) => {
  const { path: filePath } = req.query || {};
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'missing path query param' });
  }

  const resolved = resolve(String(filePath));
  if (!resolved.startsWith(CACHE_DIR)) {
    return res.status(403).json({ error: 'forbidden: path outside cache directory' });
  }

  try {
    unlinkSync(resolved);
    res.json({ deleted: true });
  } catch (e) {
    res.status(404).json({ error: 'file not found or already deleted' });
  }
});

// ── 404 ──────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── 启动 ──────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ image-cache-server 已启动，端口: ${PORT}`);
  console.log(`📁 缓存目录: ${CACHE_DIR}`);
});
