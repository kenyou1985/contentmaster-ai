#!/usr/bin/env node
/**
 * Remotion Bundle 缓存管理（M2 #11）
 *
 * 3 级缓存命中策略：
 * - L1（最快，~0.1s）：源文件 hash + Node 版本 + Remotion 版本 calc cache key，
 *   命中直接复用上次打包结果（复用 bundle 后的 serveUrl/builtDir）
 * - L2（次快，~3-5s）：使用 Remotion 内置 webpack 持久化缓存
 *   （`@remotion/bundler` 的 `enableCaching: true`），把 cache 目录保留
 * - L3（兜底，~10-30s）：清空 webpack 缓存重新打包（保留 L1 manifest 但触发 L2 重建）
 *
 * 与旧逻辑对比：
 * - 旧：每次都 `rm -rf .cache/webpack` + `enableCaching: false` → 每次 10-30s 打包
 * - 新：仅当源码变了（hash 不一致）才清空；否则直接复用缓存目录
 *
 * 缓存位置：`/tmp/remotion-bundle-cache/`
 *   ├── manifest.json          // { cacheKey, lastBundleUrl, lastPackagedAt, ... }
 *   └── webpack/               // webpack 持久化缓存（由 Remotion 内部管理）
 */

import { createHash } from 'crypto';
import { existsSync, writeFileSync, readFileSync, statSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { promises as fs } from 'fs';

/** 缓存根目录（跨 worker 复用） */
const CACHE_ROOT = process.env.REMOTION_BUNDLE_CACHE_DIR || join('/tmp', 'remotion-bundle-cache');

/** 缓存版本（缓存格式变更时手动 +1） */
const CACHE_VERSION = 1;

interface BundleManifest {
  version: number;
  cacheKey: string;
  /** 上一次打包结果（Remotion 的 serveUrl，可直接 renderMedia 复用） */
  bundleUrl: string;
  /** 上次打包时间戳 */
  lastPackagedAt: number;
  /** 累积命中次数（调试用） */
  hitCount: number;
  /** 包大小（字节） */
  bundleSize?: number;
}

interface CacheCheckResult {
  /** 当前缓存键 */
  cacheKey: string;
  /** 是否命中 L1（manifest 文件复用） */
  hit: boolean;
  /** 上一次打包结果（hit=true 时有值） */
  bundleUrl?: string;
  /** 是否需要清空 webpack 缓存（L2 不命中） */
  needWebpackClear: boolean;
  /** 是否需要重新打包 */
  needRebundle: boolean;
}

/**
 * 计算当前请求的缓存键
 * 基于：源文件 hash + 关键配置（resolution/fps/codec）+ 环境版本
 */
export async function computeCacheKey(projectRoot: string, entryFile: string): Promise<string> {
  const inputs: string[] = [
    `cache-version:${CACHE_VERSION}`,
    `node:${process.version}`,
    // 关键源文件 hash（影响构建产物的内容）
    await hashFile(join(projectRoot, 'package.json')),
    await hashFile(join(projectRoot, 'remotion.config.ts')),
    await hashFile(entryFile),
    await hashDir(join(projectRoot, 'src')),
  ];

  const key = createHash('sha256').update(inputs.join('\n')).digest('hex').slice(0, 16);
  return key;
}

async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath);
    return createHash('sha1').update(content).digest('hex').slice(0, 8);
  } catch {
    return `missing:${filePath.split('/').pop()}`;
  }
}

async function hashDir(dirPath: string): Promise<string> {
  if (!existsSync(dirPath)) return `missing-dir:${dirPath}`;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const hashes: string[] = [];
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

function getManifestPath(): string {
  return join(CACHE_ROOT, 'manifest.json');
}

function getWebpackCacheDir(projectRoot: string): string {
  return join(projectRoot, 'node_modules', '.cache', 'webpack');
}

/**
 * 检查缓存状态
 */
export async function checkBundleCache(projectRoot: string, entryFile: string): Promise<CacheCheckResult> {
  const cacheKey = await computeCacheKey(projectRoot, entryFile);
  const manifestPath = getManifestPath();

  let existing: BundleManifest | null = null;
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
    bundleUrl: hit ? existing!.bundleUrl : undefined,
    // L1 不命中 → 清空 webpack 缓存让 L2 重新构建（仍启用 enableCaching 避免下次 L1 命中前的慢路径）
    needWebpackClear: !hit,
    needRebundle: !hit,
  };
}

/**
 * 记录打包结果（更新 manifest）
 */
export function recordBundleResult(
  cacheKey: string,
  bundleUrl: string,
  bundleSize?: number
): void {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const manifestPath = getManifestPath();

  let prev: Partial<BundleManifest> = {};
  if (existsSync(manifestPath)) {
    try {
      prev = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      /* ignore */
    }
  }

  const manifest: BundleManifest = {
    version: CACHE_VERSION,
    cacheKey,
    bundleUrl,
    lastPackagedAt: Date.now(),
    hitCount: (prev.hitCount ?? 0) + 1,
    bundleSize,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * 清空 webpack 持久化缓存（仅当 L1 不命中时调用）
 */
export function clearWebpackCache(projectRoot: string): boolean {
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
export function getCacheStats(): { cacheRoot: string; manifest?: BundleManifest } {
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
 * 用法：
 *   const cacheResult = await prepareBundleCache(PROJECT_ROOT, ENTRY_FILE);
 *   if (cacheResult.hit && cacheResult.bundleUrl) {
 *     bundleLocation = cacheResult.bundleUrl;
 *     logInfo(`[bundle] L1 缓存命中，跳过打包 (${cacheResult.cacheKey})`);
 *   } else {
 *     if (cacheResult.needWebpackClear) {
 *       clearWebpackCache(PROJECT_ROOT);
 *     }
 *     bundleLocation = await bundle({
 *       entryPoint: ENTRY_FILE,
 *       enableCaching: true, // L2 始终启用，节省下次没 L1 命中时的开销
 *     });
 *     recordBundleResult(cacheResult.cacheKey, bundleLocation);
 *   }
 */
export async function prepareBundleCache(projectRoot: string, entryFile: string): Promise<CacheCheckResult> {
  return checkBundleCache(projectRoot, entryFile);
}
