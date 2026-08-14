#!/usr/bin/env node
/**
 * ContentMaster AI - Remotion 渲染子进程
 *
 * 参数传递：stdin 写入 JSON { payload, taskId, outputDir }（绕过 macOS argv 256KB 上限）
 * 输出：stdout 逐行 JSON { type, ... }
 * 日志：/tmp/remotion-out/logs/<taskId>.log（方便跟踪调试）
 */
import { existsSync, mkdirSync, statSync, writeFileSync, appendFileSync, readFileSync as fsReadFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import os from 'os';
import { createRequire } from 'module';
import { prepareBundleCache, recordBundleResult, clearWebpackCache } from './bundle-cache.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// ── 路径常量 ──────────────────────────────────────────────────────
const PROJECT_ROOT = process.env.REMOTION_PROJECT_ROOT || join(__dirname, '..', '..', 'remotion');
const ENTRY_FILE = join(PROJECT_ROOT, 'src', 'index.tsx');
const OUTPUT_DIR = process.env.REMOTION_OUTPUT_DIR || join('/tmp', 'remotion-out');
const PUBLIC_MEDIA_DIR = join(PROJECT_ROOT, 'public', 'mmedia');
const LOG_DIR = join(OUTPUT_DIR, 'logs');

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
if (!existsSync(PUBLIC_MEDIA_DIR)) mkdirSync(PUBLIC_MEDIA_DIR, { recursive: true });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// ── Remotion 模块加载器 ─────────────────────────────────────────────
let bundler = null;
let renderer = null;

async function loadRemotionModules() {
  if (bundler && renderer) {
    writeLog('INFO', '[module] 模块已加载，跳过');
    return true;
  }

  // Remotion 模块可能在不同位置
  const possiblePaths = [
    PROJECT_ROOT,
    __dirname,
    '/app/remotion',
    '/app/remotion-server',
  ].map(p => join(p, 'node_modules'));

  writeLog('INFO', `[module] PROJECT_ROOT=${PROJECT_ROOT}`);
  writeLog('INFO', `[module] __dirname=${__dirname}`);
  writeLog('INFO', `[module] 开始搜索 Remotion 模块...`);

  for (const modulesPath of possiblePaths) {
    const bundlerPath = join(modulesPath, '@remotion', 'bundler');
    const rendererPath = join(modulesPath, '@remotion', 'renderer');

    writeLog('INFO', `[module] 检查路径: ${modulesPath}`);

    if (!existsSync(bundlerPath) || !existsSync(rendererPath)) {
      continue;
    }

    writeLog('INFO', `[module] 找到模块候选: ${modulesPath}`);

    // 尝试多种加载方式
    const loadMethods = [
      // 方式 1: 读取 package.json 获取正确入口
      async () => {
        try {
          const bundlerPkg = JSON.parse(fsReadFileSync(join(bundlerPath, 'package.json'), 'utf-8'));
          const rendererPkg = JSON.parse(fsReadFileSync(join(rendererPath, 'package.json'), 'utf-8'));

          // 获取 main 或 exports
          let bundlerEntry = bundlerPkg.main;
          let rendererEntry = rendererPkg.main;

          // 尝试从 exports 字段获取
          if (!bundlerEntry && bundlerPkg.exports) {
            const exp = bundlerPkg.exports;
            bundlerEntry = exp['.']?.require || exp['.']?.import || exp['.'];
          }
          if (!rendererEntry && rendererPkg.exports) {
            const exp = rendererPkg.exports;
            rendererEntry = exp['.']?.require || exp['.']?.import || exp['.'];
          }

          if (bundlerEntry && rendererEntry) {
            const bundlerAbs = join(bundlerPath, bundlerEntry);
            const rendererAbs = join(rendererPath, rendererEntry);

            const b = require(bundlerAbs);
            const r = require(rendererAbs);

            if (b.bundle && r.renderMedia) {
              bundler = b;
              renderer = r;
              writeLog('INFO', `[module] ✅ 方式1成功: ${modulesPath}`);
              return true;
            }
          }
        } catch (e) {
          writeLog('INFO', `[module] 方式1失败: ${e.message}`);
        }
        return false;
      },

      // 方式 2: 直接 require 包目录（Node 会自动找 main）
      async () => {
        try {
          const b = require(bundlerPath);
          const r = require(rendererPath);

          if (b.bundle && r.renderMedia) {
            bundler = b;
            renderer = r;
            writeLog('INFO', `[module] ✅ 方式2成功: ${modulesPath}`);
            return true;
          }
        } catch (e) {
          writeLog('INFO', `[module] 方式2失败: ${e.message}`);
        }
        return false;
      },

      // 方式 3: 动态 import dist/index.cjs
      async () => {
        try {
          const bundlerAbs = join(bundlerPath, 'dist', 'index.cjs');
          const rendererAbs = join(rendererPath, 'dist', 'index.cjs');

          if (!existsSync(bundlerAbs) || !existsSync(rendererAbs)) {
            return false;
          }

          const b = await import(bundlerAbs);
          const r = await import(rendererAbs);

          if (b.bundle && r.renderMedia) {
            bundler = b;
            renderer = r;
            writeLog('INFO', `[module] ✅ 方式3成功: ${modulesPath}`);
            return true;
          }
        } catch (e) {
          writeLog('INFO', `[module] 方式3失败: ${e.message}`);
        }
        return false;
      },
    ];

    for (const method of loadMethods) {
      if (await method()) {
        return true;
      }
    }
  }

  // 最后尝试默认路径（让 Node 自动查找）
  try {
    writeLog('INFO', '[module] 尝试默认路径...');
    const b = require('@remotion/bundler');
    const r = require('@remotion/renderer');

    if (b.bundle && r.renderMedia) {
      bundler = b;
      renderer = r;
      writeLog('INFO', '[module] ✅ 默认路径成功');
      return true;
    }
  } catch (e) {
    writeLog('ERROR', `[module] 默认路径失败: ${e.message}`);
  }

  writeLog('ERROR', '无法加载 Remotion 模块，请检查安装');
  return false;
}

// ── 日志工具 ──────────────────────────────────────────────────────
let _logFp = null;

function initLog(taskId) {
  const logPath = join(LOG_DIR, `${taskId}.log`);
  writeFileSync(logPath, '');
  _logFp = logPath;
}

function writeLog(prefix, message) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] [${prefix}] ${message}`;
  console.log(line);
  if (_logFp) {
    appendFileSync(_logFp, line + '\n');
  }
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
}

function logError(error) {
  const msg = typeof error === 'string' ? error : error.message || String(error);
  writeLog('ERROR', msg);
}

function logDone(result) {
  writeLog('DONE', '渲染完成');
  process.stdout.write(JSON.stringify({ type: 'done', result }) + '\n');
}

// ── 媒体转换 ─────────────────────────────────────────────────────
async function convertMediaToDataUrls(shots) {
  const newShots = [];
  for (const shot of shots) {
    const newShot = { ...shot };
    for (const key of ['imageUrl', 'audioUrl', 'voiceoverAudioUrl', 'videoUrl']) {
      const val = newShot[key];
      if (!val || typeof val !== 'string') continue;
      if (val.startsWith('data:')) continue;

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

      try {
        const fetched = await fetchWithRetry(val, 3);
        if (fetched) {
          newShot[key] = `data:${fetched.mime};base64,${fetched.base64}`;
          logInfo(`  ${key}: ${val.slice(0, 80)} → data URL`);
        }
      } catch (e) {
        logInfo(`[warn] 远程媒体下载出错: ${val.slice(0, 80)}: ${e.message}`);
      }
    }

    if (Array.isArray(shot.imageUrls)) {
      newShot.imageUrls = [];
      for (const u of shot.imageUrls) {
        if (!u || typeof u !== 'string' || u.startsWith('data:')) {
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

async function fetchWithRetry(url, retries = 3) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
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

// ── stdin 读取参数 ─────────────────────────────────────────────────
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

    logInfo('== Remotion 渲染任务开始 ==');
    logInfo(`任务 ID: ${taskId}`);
    logInfo(`PROJECT_ROOT: ${PROJECT_ROOT}`);
    logInfo(`ENTRY_FILE: ${ENTRY_FILE}`);
    logInfo(`ENTRY_FILE exists: ${existsSync(ENTRY_FILE)}`);

    // 加载 Remotion 模块
    logInfo('步骤 0/4: 加载 Remotion 模块...');
    const loaded = await loadRemotionModules();
    if (!loaded) {
      throw new Error('无法加载 Remotion 模块，请检查 node_modules 安装');
    }
    logInfo(`bundler.bundle 类型: ${typeof bundler.bundle}`);
    logInfo(`renderer.renderMedia 类型: ${typeof renderer.renderMedia}`);

    const shots = payload.shots || [];
    const config = payload.config || {};

    if (shots.length === 0) {
      throw new Error('shots 为空');
    }

    logInfo(`镜头数: ${shots.length}`);
    logInfo(`分辨率: ${config.resolution || '1920x1080'}`);
    logInfo(`帧率: ${config.fps || 30}`);
    logInfo(`编码: ${config.codec || 'h264'}`);

    if (!existsSync(ENTRY_FILE)) {
      throw new Error(`Remotion 入口文件不存在: ${ENTRY_FILE}`);
    }

    logInfo('步骤 1/4: 处理媒体文件...');
    const dataShots = await convertMediaToDataUrls(shots);
    logInfo(`已转换 ${dataShots.length} 个镜头的媒体`);

    logInfo('步骤 2/4: 打包 Remotion 项目...');
    const t0 = Date.now();
    const cacheCheck = await prepareBundleCache(PROJECT_ROOT, ENTRY_FILE);
    let bundleLocation;

    if (cacheCheck.hit && cacheCheck.bundleUrl) {
      bundleLocation = cacheCheck.bundleUrl;
      logInfo(`[bundle] ✅ L1 缓存命中（跳过 ${Date.now() - t0}ms）`);
      logProgress(10, 'Remotion 项目复用缓存');
    } else {
      if (cacheCheck.needWebpackClear) {
        clearWebpackCache(PROJECT_ROOT);
        logInfo('[bundle] 已清空 webpack 缓存');
      }
      bundleLocation = await bundler.bundle({
        entryPoint: ENTRY_FILE,
        enableCaching: true,
      });
      recordBundleResult(cacheCheck.cacheKey, bundleLocation);
      logInfo(`[bundle] 🔧 已重新打包（耗时 ${Date.now() - t0}ms）`);
      logProgress(10, 'Remotion 项目打包完成');
    }

    const safeConfig = {
      ...config,
      output: config.output ? { target: config.output.target } : { target: 'browser' },
    };
    const inputProps = { shots: dataShots, config: safeConfig };

    logInfo('步骤 3/4: 选择 Composition...');
    const composition = await renderer.selectComposition({
      serveUrl: bundleLocation,
      id: 'MyVideo',
      inputProps,
    });

    logInfo(`Composition: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} 帧`);

    const outputPath = join(OUTPUT_DIR, `${taskId}.mp4`);
    logInfo(`输出路径: ${outputPath}`);

    logInfo('步骤 4/4: 渲染 MP4...');

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
        if (renderedFrames <= 5) {
          logInfo(`[ShotLayer] shots=${dataShots.length}`);
        }
        const overall = 10 + Math.round(progress * 85);
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
      outputUrl: `/download/${taskId}.mp4`,
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
