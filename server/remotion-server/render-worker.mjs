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

// ── 浏览器可执行文件路径 ───────────────────────────────────────────
// Railway / Linux 容器内：使用系统安装的 chromium，避免 Remotion 运行时下载失败
const SYSTEM_CHROMIUM_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_EXECUTABLE_PATH,
  process.env.REMOTION_BROWSER_EXECUTABLE,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chrome',
];
const SYSTEM_CHROMIUM = SYSTEM_CHROMIUM_PATHS.find((p) => p && existsSync(p)) || null;
if (SYSTEM_CHROMIUM) {
  console.log(`[browser] 使用系统 Chromium: ${SYSTEM_CHROMIUM}`);
} else {
  console.warn(`[browser] 未找到系统 Chromium，Remotion 将尝试下载（容器中可能失败）`);
}

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

  // 检查所有可能的路径
  const allPaths = [
    { base: PROJECT_ROOT, modules: join(PROJECT_ROOT, 'node_modules') },
    { base: __dirname, modules: join(__dirname, 'node_modules') },
    { base: '/app/remotion', modules: '/app/remotion/node_modules' },
    { base: '/app/remotion-server', modules: '/app/remotion-server/node_modules' },
  ];

  writeLog('INFO', `[module] PROJECT_ROOT=${PROJECT_ROOT}`);
  writeLog('INFO', `[module] __dirname=${__dirname}`);

  // 先列出所有路径下的 @remotion 目录
  for (const { base, modules } of allPaths) {
    const remotionDir = join(modules, '@remotion');
    if (existsSync(remotionDir)) {
      try {
        const entries = fs.readdirSync(remotionDir);
        writeLog('INFO', `[module] ${remotionDir} 内容: ${entries.join(', ')}`);
      } catch (e) {
        writeLog('INFO', `[module] 无法读取 ${remotionDir}: ${e.message}`);
      }
    } else {
      writeLog('INFO', `[module] 不存在: ${remotionDir}`);
    }
  }

  for (const { base, modules } of allPaths) {
    const bundlerPath = join(modules, '@remotion', 'bundler');
    const rendererPath = join(modules, '@remotion', 'renderer');

    if (!existsSync(bundlerPath) || !existsSync(rendererPath)) {
      continue;
    }

    writeLog('INFO', `[module] 找到模块: ${modules}`);

    // 方式 1: 读取 package.json 获取正确入口
    try {
      const bundlerPkgPath = join(bundlerPath, 'package.json');
      const rendererPkgPath = join(rendererPath, 'package.json');

      if (!existsSync(bundlerPkgPath) || !existsSync(rendererPkgPath)) {
        writeLog('INFO', '[module] package.json 不存在');
        continue;
      }

      const bundlerPkg = JSON.parse(fsReadFileSync(bundlerPkgPath, 'utf-8'));
      const rendererPkg = JSON.parse(fsReadFileSync(rendererPkgPath, 'utf-8'));

      writeLog('INFO', `[module] bundler main: ${bundlerPkg.main || 'none'}`);
      writeLog('INFO', `[module] bundler exports: ${JSON.stringify(bundlerPkg.exports || {}).slice(0, 200)}`);

      // 尝试多种入口
      const bundlerEntries = [
        bundlerPkg.main,
        bundlerPkg.exports?.['.']?.require,
        bundlerPkg.exports?.['.']?.import,
        bundlerPkg.exports?.['.'],
        'dist/index.js',
        'dist/index.cjs',
        'dist/bundler.js',
      ].filter(Boolean);

      const rendererEntries = [
        rendererPkg.main,
        rendererPkg.exports?.['.']?.require,
        rendererPkg.exports?.['.']?.import,
        rendererPkg.exports?.['.'],
        'dist/index.js',
        'dist/index.cjs',
        'dist/renderer.js',
      ].filter(Boolean);

      for (const entry of bundlerEntries) {
        try {
          const absPath = join(bundlerPath, entry);
          writeLog('INFO', `[module] 尝试 bundler: ${absPath}`);

          if (!existsSync(absPath)) {
            continue;
          }

          const b = require(absPath);
          if (b && typeof b.bundle === 'function') {
            bundler = b;
            writeLog('INFO', `[module] ✅ bundler 加载成功: ${absPath}`);
            break;
          }
        } catch (e) {
          writeLog('INFO', `[module] bundler ${entry} 失败: ${e.message}`);
        }
      }

      if (!bundler) continue;

      for (const entry of rendererEntries) {
        try {
          const absPath = join(rendererPath, entry);
          writeLog('INFO', `[module] 尝试 renderer: ${absPath}`);

          if (!existsSync(absPath)) {
            continue;
          }

          const r = require(absPath);
          if (r && typeof r.renderMedia === 'function') {
            renderer = r;
            writeLog('INFO', `[module] ✅ renderer 加载成功: ${absPath}`);
            break;
          }
        } catch (e) {
          writeLog('INFO', `[module] renderer ${entry} 失败: ${e.message}`);
        }
      }

      if (bundler && renderer) {
        writeLog('INFO', `[module] ✅ 所有模块加载成功！`);
        return true;
      }
    } catch (e) {
      writeLog('INFO', `[module] 加载过程出错: ${e.message}`);
    }
  }

  // 最后尝试默认路径
  try {
    writeLog('INFO', '[module] 尝试默认路径...');
    bundler = require('@remotion/bundler');
    renderer = require('@remotion/renderer');
    writeLog('INFO', '[module] ✅ 默认路径成功');
    return true;
  } catch (e) {
    writeLog('ERROR', `[module] 默认路径失败: ${e.message}`);
  }

  writeLog('ERROR', '无法加载 Remotion 模块');
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

// v1.10：根据 CPU 核数 + 内存动态计算 Remotion renderMedia 并发度
// 参考官方推荐：https://www.remotion.dev/docs/performance
//  - Railway 48 核 330GB：concurrency ≈ 12-16（一个 Chromium tab 占 1.5-2 核）
//  - 本地 8-16 核 16-32GB：concurrency ≈ 4-8
//  - 低端 2-4 核 8GB：concurrency = 1
function getConcurrency() {
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);

  // 每个 Chromium tab 约占 1.5-2 个 CPU 和 ~2-3GB 内存
  // 目标：CPU 占用 70-80%（避免过度 oversubscribe），内存 < 80%
  const concurrencyByCpu = Math.max(1, Math.floor(cpuCount * 0.6));
  const concurrencyByMem = Math.max(1, Math.floor(totalMemGB / 3));

  // 限制上限 16（官方建议超过 16 后边际收益下降）
  const concurrency = Math.min(16, concurrencyByCpu, concurrencyByMem);

  writeLog(
    'INFO',
    `[concurrency] cpuCount=${cpuCount} totalMemGB=${totalMemGB} → concurrency=${concurrency} ` +
    `(cpu-budget=${concurrencyByCpu}, mem-budget=${concurrencyByMem})`
  );
  return concurrency;
}

/** v1.10：offthreadVideo 线程数（用于视频镜头的多线程解码）
 *  - 默认 2；48 核机器可拉到 8-16
 *  - 参考 https://github.com/remotion-dev/remotion/issues/4949
 */
function getOffthreadVideoThreads() {
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  // 上限 8，超过 8 后 IO 反而成瓶颈
  return Math.min(8, Math.max(2, Math.floor(cpuCount / 4)));
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
      // bundler.bundle 加 180s 超时保护
      bundleLocation = await Promise.race([
        bundler.bundle({
          entryPoint: ENTRY_FILE,
          enableCaching: true,
          // 强制固定端口，避免 Remotion 自动选 3001/3002 与 launchd 残留冲突
          port: 3003,
          ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('bundler.bundle 超时（>180s）')), 180_000))
      ]);
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
    // v1.8：selectComposition 加 95s 硬超时；超时后强制 kill 进程（Remotion 内部 promise 不会 reject）
    const selectCompositionPromise = renderer.selectComposition({
      serveUrl: bundleLocation,
      id: 'MyVideo',
      inputProps,
      ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
    });
    let selectTimer;
    const composition = await Promise.race([
      selectCompositionPromise,
      new Promise((_, reject) => {
        selectTimer = setTimeout(() => {
          logError('selectComposition 超时（>95s）');
          process.stdout.write(JSON.stringify({
            type: 'failed',
            error: 'selectComposition 超时（>95s）',
            message: 'Remotion selectComposition 阶段超时',
          }) + '\n');
          // 强制退出整个进程：Remotion 内部 promise 不会自动 reject
          setTimeout(() => process.exit(1), 200);
          reject(new Error('selectComposition 超时（>95s）'));
        }, 95_000);
      }),
    ]).finally(() => clearTimeout(selectTimer));

    logInfo(`Composition: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} 帧`);

    const outputPath = join(OUTPUT_DIR, `${taskId}.mp4`);
    logInfo(`输出路径: ${outputPath}`);

    logInfo('步骤 4/4: 渲染 MP4...');

    // v1.8：renderMedia 加 30 分钟硬超时（长视频走 batch-renderer；单任务最多 30 分钟）
    // v1.10：renderMedia 性能优化
    // ──────────────────────────────────────────────
    //  1. concurrency：根据 CPU 核数 + 内存动态调整（取代旧的「内存 ≥16 → 2」）
    //  2. offthreadVideoThreads：根据 CPU 核数动态调整（视频镜头并行解码）
    //  3. GPU：使用 swiftshader 软件加速（不是 disable-gpu）— 官方推荐 headless GPU 模式
    //  4. x264Preset: ultrafast（牺牲压缩率换编码速度）
    //  5. parallelEncoding: 启用（Remotion 4.0+ 默认 true，保持显式）
    //  参考：
    //    https://www.remotion.dev/docs/performance
    //    https://www.remotion.dev/docs/gpu
    //    https://github.com/remotion-dev/remotion/issues/4949
    const concurrency = getConcurrency();
    const offthreadThreads = getOffthreadVideoThreads();
    logInfo(`[render] concurrency=${concurrency} offthreadVideoThreads=${offthreadThreads}`);

    const renderMediaPromise = renderer.renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: config.codec === 'h265' ? 'h265' : 'h264',
      outputLocation: outputPath,
      inputProps,
      concurrency,
      ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
      // v1.10：启用 swiftshader 软件 GPU 加速（替代 --disable-gpu 关闭 GPU）
      // 在 Railway 无物理 GPU / 本地无独显时也能用 CPU 模拟 GPU，比纯软件渲染快 1.5-3x
      chromiumOptions: {
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--enable-gpu',
          // v2.3：Railway 有 NVIDIA T4，优先用 GPU 硬件加速
          '--ignore-gpu-blocklist',
          '--disable-gpu-sandbox',
          '--use-gl=angle',
          '--enable-features=Vulkan',
        ],
      },
      offthreadVideoThreads: offthreadThreads,
      // v1.10：x264 ultrafast 编码（牺牲压缩率换速度，3 分钟视频从 ~90s → ~40s）
      x264Preset: 'ultrafast',
      // v1.10：并行编码（Remotion 4.0+ 默认 true，但显式声明）
      parallelEncoding: true,
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
    let renderTimer;
    await Promise.race([
      renderMediaPromise,
      new Promise((_, reject) => {
        renderTimer = setTimeout(() => {
          logError('renderMedia 超时（>30min）');
          process.stdout.write(JSON.stringify({
            type: 'failed',
            error: 'renderMedia 超时（>30min）',
            message: 'Remotion renderMedia 阶段超时（>30min）',
          }) + '\n');
          // 强制退出整个进程：Remotion 内部 promise 不会自动 reject
          setTimeout(() => process.exit(1), 200);
          reject(new Error('renderMedia 超时（>30min）'));
        }, 30 * 60 * 1000);
      }),
    ]).finally(() => clearTimeout(renderTimer));

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
  } catch (err) {
    logError(err);
    process.stdout.write(JSON.stringify({
      type: 'failed',
      error: err.message || String(err),
      message: 'Remotion 渲染失败',
    }) + '\n');
    process.exit(1);
  }
}

/**
 * 单段渲染函数（可被 batch-renderer 导入复用）
 * @param {Array} shots - 镜头数组
 * @param {string} outputPath - 输出文件路径
 * @param {object} opts - { config, onProgress }
 */
export async function renderSegment(shots, outputPath, opts = {}) {
  const config = opts.config || {};
  const { logInfo, logError, logProgress } = opts.logger || createSegmentLogger();

  // 加载 Remotion 模块
  logInfo('加载 Remotion 模块...');
  const loaded = await loadRemotionModules();
  if (!loaded) {
    throw new Error('无法加载 Remotion 模块');
  }

  if (shots.length === 0) {
    throw new Error('shots 为空');
  }

  logInfo(`镜头数: ${shots.length}`);
  logInfo(`输出路径: ${outputPath}`);

  if (!existsSync(ENTRY_FILE)) {
    throw new Error(`Remotion 入口文件不存在: ${ENTRY_FILE}`);
  }

  logInfo('处理媒体文件...');
  const dataShots = await convertMediaToDataUrls(shots);
  logInfo(`已转换 ${dataShots.length} 个镜头的媒体`);

  logInfo('打包 Remotion 项目...');
  const t0 = Date.now();
  const cacheCheck = await prepareBundleCache(PROJECT_ROOT, ENTRY_FILE);
  let bundleLocation;

  if (cacheCheck.hit && cacheCheck.bundleUrl) {
    bundleLocation = cacheCheck.bundleUrl;
    logInfo(`缓存命中（跳过 ${Date.now() - t0}ms）`);
  } else {
    if (cacheCheck.needWebpackClear) {
      clearWebpackCache(PROJECT_ROOT);
    }
    bundleLocation = await bundler.bundle({
      entryPoint: ENTRY_FILE,
      enableCaching: true,
      port: 3003,
      ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
    });
    recordBundleResult(cacheCheck.cacheKey, bundleLocation);
    logInfo(`已打包（耗时 ${Date.now() - t0}ms）`);
  }

  const safeConfig = {
    ...config,
    output: config.output ? { target: config.output.target } : { target: 'browser' },
  };
  const inputProps = { shots: dataShots, config: safeConfig };

  logInfo('选择 Composition...');
  const selectTimer = setTimeout(() => {
    throw new Error('selectComposition 超时（>95s）');
  }, 95_000);

  let composition;
  try {
    composition = await renderer.selectComposition({
      serveUrl: bundleLocation,
      id: 'MyVideo',
      inputProps,
      ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
    });
  } finally {
    clearTimeout(selectTimer);
  }

  logInfo(`Composition: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} 帧`);

  logInfo('渲染 MP4...');
  const concurrency = getConcurrency();
  const offthreadThreads = getOffthreadVideoThreads();

  const videoDurationSec = composition.durationInFrames / composition.fps;

  await renderer.renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: config.codec === 'h265' ? 'h265' : 'h264',
    outputLocation: outputPath,
    inputProps,
    concurrency,
    ...(SYSTEM_CHROMIUM ? { browserExecutable: SYSTEM_CHROMIUM } : {}),
    chromiumOptions: {
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--enable-gpu',
        '--use-gl=swiftshader',
        '--enable-features=Vulkan',
        '--ignore-gpu-blocklist',
      ],
    },
    offthreadVideoThreads: offthreadThreads,
    x264Preset: 'ultrafast',
    parallelEncoding: true,
    onProgress: ({ progress, renderedFrames, totalFrames }) => {
      logProgress?.(10 + Math.round(progress * 80), `渲染中 (${renderedFrames}/${totalFrames} 帧)`);
    },
    onBrowserLog: (info) => {
      if (info.type === 'error') {
        logInfo(`[browser error] ${info.text.slice(0, 200)}`);
      }
    },
    ...(config.bitrate ? { videoBitrate: config.bitrate } : {}),
  });

  if (!existsSync(outputPath)) {
    throw new Error('渲染完成后输出文件不存在');
  }

  const stats = statSync(outputPath);
  logInfo(`输出文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  return {
    outputPath,
    durationSec: videoDurationSec,
    videoSizeBytes: stats.size,
    resolution: `${composition.width}x${composition.height}`,
    fps: composition.fps,
  };
}

function createSegmentLogger() {
  return {
    logInfo: (msg) => console.log(`[segment] ${msg}`),
    logError: (msg) => console.error(`[segment] ❌ ${msg}`),
    logProgress: (p, m) => console.log(`[segment] ${p}% ${m}`),
  };
}

main();
