/**
 * Remotion Bundle 缓存管理（M2 #11）
 *
 * 3 级缓存命中策略：
 * - L1（最快，~0.1s）：源文件 hash + Node 版本 + Remotion 版本 calc cache key，
 *   命中直接复用上次打包结果
 * - L2（次快，~3-5s）：Remotion 内置 webpack 持久化缓存
 * - L3（兜底，~10-30s）：清空 webpack 缓存重新打包
 *
 * 缓存位置：`/tmp/remotion-bundle-cache/`
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { promises as fs } from 'fs';

/** 缓存根目录（跨 worker 复用） */
const CACHE_ROOT = process.env.REMOTION_BUNDLE_CACHE_DIR || join('/tmp', 'remotion-bundle-cache');

/** 缓存版本（缓存格式变更时手动 +1） */
const CACHE_VERSION = 1;

/**
 * 计算当前请求的缓存键
 * 基于：源文件 hash + Node 版本 + Remotion 版本
 */
export async function computeCacheKey(projectRoot, entryFile) {
  const inputs = [
    `cache-version:${CACHE_VERSION}`,
    `node:${process.version}`,
    await hashFile(join(projectRoot, 'package.json')),
    await hashFile(join(projectRoot, 'remotion.config.ts')),
    await hashFile(entryFile),
    await hashDir(join(projectRoot, 'src')),
  ];

  const key = createHash('sha256').update(inputs.join('\n')).digest('hex').slice(0, 16);
  return key;
}

async function hashFile(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return createHash('sha1').update(content).digest('hex').slice(0, 8);
  } catch {
    return `missing:${filePath.split('/').pop()}`;
  }
}

async function hashDir(dirPath) {
  if (!existsSync(dirPath)) return `missing-dir:${dirPath}`;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const hashes = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules') continue;
      const fullPath = join(dirPath, e.name);
      if (e.isDirectory()) {
        hashes.push(`${e.name}:${await hashDir(fullPath)}`);
      } else {
        hashes.push(`${e.name}:${await hashFile(fullPath)}`);
      }
    }
    return createHash('sha256').update(hashes.sort().join('|')).digest('hex').slice(0, 12);
  } catch {
    return 'hash-error';
  }
}

function getManifestPath() {
  return join(CACHE_ROOT, 'manifest.json');
}

function getWebpackCacheDir(projectRoot) {
  return join(projectRoot, 'node_modules', '.cache', 'webpack');
}

/**
 * 检查缓存状态
 */
export async function checkBundleCache(projectRoot, entryFile) {
  const cacheKey = await computeCacheKey(projectRoot, entryFile);
  const manifestPath = getManifestPath();

  let existing = null;
  if (existsSync(manifestPath)) {
    try {
      const txt = readFileSync(manifestPath, 'utf-8');
      existing = JSON.parse(txt);
    } catch {
      existing = null;
    }
  }

  const hit = !!(existing && existing.cacheKey === cacheKey && existing.bundleUrl);

  return {
    cacheKey,
    hit,
    bundleUrl: hit ? existing.bundleUrl : undefined,
    needWebpackClear: !hit,
    needRebundle: !hit,
  };
}

/**
 * 记录打包结果（更新 manifest）
 */
export function recordBundleResult(cacheKey, bundleUrl, bundleSize) {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const manifestPath = getManifestPath();

  let prev = {};
  if (existsSync(manifestPath)) {
    try {
      prev = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      /* ignore */
    }
  }

  const manifest = {
    version: CACHE_VERSION,
    cacheKey,
    bundleUrl,
    lastPackagedAt: Date.now(),
    hitCount: (prev.hitCount || 0) + 1,
    bundleSize: bundleSize || prev.bundleSize,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * 清空 webpack 持久化缓存
 */
export function clearWebpackCache(projectRoot) {
  try {
    const cacheDir = getWebpackCacheDir(projectRoot);
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 获取缓存命中率统计
 */
export function getCacheStats() {
  if (!existsSync(CACHE_ROOT)) return { cacheRoot: CACHE_ROOT };
  const manifestPath = getManifestPath();
  if (!existsSync(manifestPath)) return { cacheRoot: CACHE_ROOT };
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return { cacheRoot: CACHE_ROOT, manifest: m };
  } catch {
    return { cacheRoot: CACHE_ROOT };
  }
}

/**
 * 主入口：在 render-worker.mjs 中使用
 */
export async function prepareBundleCache(projectRoot, entryFile) {
  return checkBundleCache(projectRoot, entryFile);
}
