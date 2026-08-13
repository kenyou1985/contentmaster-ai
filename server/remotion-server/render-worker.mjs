#!/usr/bin/env node
/**
 * ContentMaster AI - Remotion 渲染子进程
 *
 * 参数传递：stdin 写入 JSON { payload, taskId, outputDir }（绕过 macOS argv 256KB 上限）
 * 输出：stdout 逐行 JSON { type, ... }
 * 日志：/tmp/remotion-out/logs/<taskId>.log（方便跟踪调试）
 */
import { bundle } from '@remotion/bundler';
import { renderMedia, getCompositions, selectComposition } from '@remotion/renderer';
import { existsSync, mkdirSync, statSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import os from 'os';
import { prepareBundleCache, recordBundleResult, clearWebpackCache } from './bundle-cache.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = process.env.REMOTION_PROJECT_ROOT || join(__dirname, '..', '..', 'remotion');
const ENTRY_FILE = join(PROJECT_ROOT, 'src', 'index.tsx');
const OUTPUT_DIR = process.env.REMOTION_OUTPUT_DIR || join('/tmp', 'remotion-out');
const PUBLIC_MEDIA_DIR = join(PROJECT_ROOT, 'public', 'mmedia');
const LOG_DIR = join(OUTPUT_DIR, 'logs');

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
if (!existsSync(PUBLIC_MEDIA_DIR)) mkdirSync(PUBLIC_MEDIA_DIR, { recursive: true });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// ── 日志工具 ────────────────────────────────────────────────────
let _logFp = null;

function initLog(taskId) {
  const logPath = join(LOG_DIR, `${taskId}.log`);
  writeFileSync(logPath, '');
  _logFp = logPath;
}

function writeLog(prefix, message) {
  if (!_logFp) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] [${prefix}] ${message}\n`;
  appendFileSync(_logFp, line);
}

function logProgress(progress, message, meta) {
  writeLog('PROGRESS', `${progress}% ${message}`);
  process.stdout.write(
    JSON.stringify({
      type: 'progress',
      progress: Math.round(progress),
      message,
      frame: meta?.frame,
      totalFrames: meta?.totalFrames,
      fps: meta?.fps,
    }) + '\n'
  );
}

function logInfo(message) {
  writeLog('INFO', message);
  process.stdout.write(JSON.stringify({ type: 'log', message }) + '\n');
}

function logError(error) {
  const msg = typeof error === 'string' ? error : error.message || String(error);
  writeLog('ERROR', msg);
  process.stdout.write(
    JSON.stringify({ type: 'error', error: msg }) + '\n'
  );
}

function logDone(result) {
  writeLog('DONE', '渲染完成');
  process.stdout.write(JSON.stringify({ type: 'done', result }) + '\n');
}

// ── 媒体转换 ────────────────────────────────────────────────────
// 把本地文件或远程 URL 的媒体都转成 data URL，避免渲染时联网下载失败
async function convertMediaToDataUrls(shots) {
  // 并发限制：同时最多下载 4 个远程文件，避免耗尽 fd / 内存
  const CONCURRENCY = 4;
  const newShots = [];
  for (const shot of shots) {
    const newShot = { ...shot };
    // 处理单个 URL 字段（imageUrl / audioUrl / voiceoverAudioUrl / videoUrl）
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      const val = newShot[key];
      if (!val || typeof val !== 'string') continue;
      // 已是 data URL，跳过
      if (val.startsWith('data:')) continue;
      // 本地文件
      if (!val.startsWith('http://') && !val.startsWith('https://')) {
        if (!existsSync(val)) {
          logInfo(`[warn] 媒体文件不存在: ${val}`);
          continue;
        }
        try {
          const buf = await fs.readFile(val);
          const mime = mimeFromPath(val, key);
          newShot[key] = `data:${mime};base64,${buf.toString('base64')}`;
          logInfo(`  ${key}: ${val} → data URL (${(buf.length / 1024).toFixed(1)}KB)`);
        } catch (e) {
          logInfo(`[warn] 读取媒体失败: ${val}: ${e.message}`);
        }
        continue;
      }
      // 远程 URL → 下载并转 data URL
      try {
        const fetched = await fetchWithRetry(val, 3);
        if (fetched) {
          newShot[key] = `data:${fetched.mime};base64,${fetched.base64}`;
          logInfo(`  ${key}: ${val.slice(0, 80)} → data URL (${(fetched.size / 1024).toFixed(1)}KB)`);
        } else {
          logInfo(`[warn] 远程媒体下载失败，保留原 URL: ${val.slice(0, 80)}`);
        }
      } catch (e) {
        logInfo(`[warn] 远程媒体下载出错: ${val.slice(0, 80)}: ${e.message}`);
      }
    }

    // 处理 imageUrls 数组
    if (Array.isArray(shot.imageUrls)) {
      newShot.imageUrls = [];
      for (const u of shot.imageUrls) {
        if (!u || typeof u !== 'string') {
          newShot.imageUrls.push(u);
          continue;
        }
        if (u.startsWith('data:')) {
          newShot.imageUrls.push(u);
          continue;
        }
        if (!u.startsWith('http://') && !u.startsWith('https://')) {
          if (!existsSync(u)) {
            newShot.imageUrls.push(u);
            continue;
          }
          try {
            const buf = await fs.readFile(u);
            const mime = mimeFromPath(u, 'imageUrl');
            newShot.imageUrls.push(`data:${mime};base64,${buf.toString('base64')}`);
          } catch {
            newShot.imageUrls.push(u);
          }
          continue;
        }
        // 远程图片
        try {
          const fetched = await fetchWithRetry(u, 3);
          if (fetched) {
            newShot.imageUrls.push(`data:${fetched.mime};base64,${fetched.base64}`);
          } else {
            newShot.imageUrls.push(u);
          }
        } catch {
          newShot.imageUrls.push(u);
        }
      }
    }

    newShots.push(newShot);
  }
  return newShots;
}

// 带重试的 fetch（用于下载远程媒体文件）
async function fetchWithRetry(url, retries = 3) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s 超时
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    return {
      mime: mime.split(';')[0].trim(),
      base64: Buffer.from(buf).toString('base64'),
      size: buf.byteLength,
    };
  } catch (e) {
    clearTimeout(timeout);
    if (retries > 1) {
      logInfo(`[warn] fetch 重试 ${retries - 1}: ${e.message}`);
      return fetchWithRetry(url, retries - 1);
    }
    return null;
  }
}

function mimeFromPath(path, kind) {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
  const ext = m ? m[1] : '';
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/m4a',
    aac: 'audio/aac', ogg: 'audio/ogg',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  };
  if (ext && map[ext]) return map[ext];
  if (kind === 'imageUrl') return 'image/png';
  if (kind === 'audioUrl' || kind === 'voiceoverAudioUrl') return 'audio/mpeg';
  if (kind === 'videoUrl') return 'video/mp4';
  return 'application/octet-stream';
}

function getConcurrency() {
  const totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  return totalMemGB >= 16 ? 2 : 1;
}

// ── stdin 读取参数（绕过 argv 上限）─────────────────────────────
async function readStdinArgs() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(raw);
}

// ── 主入口 ──────────────────────────────────────────────────────
async function main() {
  try {
    const { payload, taskId } = await readStdinArgs();
    initLog(taskId);

    const shots = payload.shots || [];
    const config = payload.config || {};

    if (shots.length === 0) {
      throw new Error('shots 为空');
    }

    logInfo('== Remotion 渲染任务开始 ==');
    logInfo(`任务 ID: ${taskId}`);
    logInfo(`镜头数: ${shots.length}`);
    logInfo(`分辨率: ${config.resolution || '1920x1080'}`);
    logInfo(`帧率: ${config.fps || 30}`);
    logInfo(`编码: ${config.codec || 'h264'}`);
    logInfo(`入口: ${ENTRY_FILE}`);

    if (!existsSync(ENTRY_FILE)) {
      throw new Error(`Remotion 入口文件不存在: ${ENTRY_FILE}`);
    }

    logInfo('步骤 1/4: 处理媒体文件（本地 + 远程）...');
    const dataShots = await convertMediaToDataUrls(shots);
    logInfo(`已转换 ${dataShots.length} 个镜头的媒体为 data URL`);
    logInfo(`镜头运动参数: ${dataShots.map(s => `id=${s.id?.slice(0,8)} motion=${s.motion}`).join(' | ')}`);
    logInfo(`镜头时长: ${dataShots.map(s => `id=${s.id?.slice(0,8)} dur=${s.audioDurationExact ?? s.audioDurationSec ?? '?'}s`).join(' | ')}`);

    logInfo('步骤 2/4: 打包 Remotion 项目（M2 #11 智能缓存策略）...');
    const t0 = Date.now();
    // 检查 L1 缓存（基于源文件 hash + Node 版本 + Remotion 版本）
    const cacheCheck = await prepareBundleCache(PROJECT_ROOT, ENTRY_FILE);
    let bundleLocation;
    if (cacheCheck.hit && cacheCheck.bundleUrl) {
      // L1 命中：直接复用上次打包结果（~0.1s）
      bundleLocation = cacheCheck.bundleUrl;
      logInfo(`[bundle] ✅ L1 缓存命中，cacheKey=${cacheCheck.cacheKey}（跳过 ${Date.now() - t0}ms）`);
      logProgress(10, 'Remotion 项目复用缓存');
    } else {
      // L1 不命中：按需清 L2 + 重新打包（启用 webpack 持久化缓存以备下次命中）
      if (cacheCheck.needWebpackClear) {
        const cleared = clearWebpackCache(PROJECT_ROOT);
        if (cleared) logInfo('[bundle] L1 cache key 不匹配，已清空 webpack 持久化缓存');
      }
      bundleLocation = await bundle({
        entryPoint: ENTRY_FILE,
        enableCaching: true, // L2 始终启用，webpack 内部 cache
      });
      // 记录结果以便下次 L1 命中
      recordBundleResult(cacheCheck.cacheKey, bundleLocation);
      logInfo(`[bundle] 🔧 已重新打包，cacheKey=${cacheCheck.cacheKey}（耗时 ${Date.now() - t0}ms）`);
      logProgress(10, 'Remotion 项目打包完成');
    }

    const safeConfig = {
      ...config,
      output: config.output ? { target: config.output.target } : { target: 'browser' },
    };
    const inputProps = { shots: dataShots, config: safeConfig };

    logInfo('步骤 3/4: 选择 Composition...');
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'MyVideo',
      inputProps,
    });

    logInfo(`Composition: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} 帧`);

    const outputPath = join(OUTPUT_DIR, `${taskId}.mp4`);
    logInfo(`输出路径: ${outputPath}`);

    logInfo('步骤 4/4: 渲染 MP4...');

    await renderMedia({
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
        // 渲染前50帧时，实时输出当前 shot 信息用于调试
        if (renderedFrames <= 5) {
          logInfo(`[ShotLayer shot check] shots=${dataShots.length} firstShotMotion=${dataShots[0]?.motion}`);
        }
        const overall = 10 + Math.round(progress * 85);
        // M2 #13：把帧号也作为结构化字段推送给前端（SSE 实时帧进度）
        logProgress(
          overall,
          `渲染中 (${renderedFrames}/${totalFrames} 帧, ${Math.round(progress * 100)}%)`,
          { frame: renderedFrames, totalFrames, fps: composition.fps }
        );
      },
      onBrowserLog: (info) => {
        if (info.type === 'error') {
          logInfo(`[browser error] ${info.text.slice(0, 200)}`);
        }
        // 捕获所有 ShotLayer 等 React 组件的 console 输出，写入任务日志
        const t = info.text?.trim();
        if (t && (t.includes('[ShotLayer]') || t.includes('[shotsToRemotion]'))) {
          logInfo(`[browser] ${t}`);
        }
      },
      ...(config.bitrate ? { videoBitrate: config.bitrate } : {}),
    });

    logProgress(95, '校验输出文件...');

    if (!existsSync(outputPath)) {
      throw new Error('渲染完成后输出文件不存在');
    }

    const stats = statSync(outputPath);
    logInfo(`输出文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    const videoDurationSec = composition.durationInFrames / composition.fps;

    logDone({
      outputPath,
      outputUrl: `/api/remotion/download/${taskId}.mp4`,
      durationSec: videoDurationSec,
      videoSizeBytes: stats.size,
      resolution: `${composition.width}x${composition.height}`,
      fps: composition.fps,
      format: 'mp4',
      taskId,
    });

    logProgress(100, '渲染完成');
    process.exit(0);
  } catch (e) {
    logError(e);
    console.error('[render-worker] 失败:', e);
    process.exit(1);
  }
}

main();
