/**
 * 视频缓存服务
 * 用于将视频下载到本地缓存，提升播放性能
 * - 每个视频 URL 的缓存数据（blob URL）：localStorage（会话级，刷新后失效）
 * - 元数据表（CACHE_META_KEY）：IndexedDB（storageService） + localStorage 兼容层
 * - 支持缓存大小限制（默认 500MB）和自动清理过期缓存
 */

import { lsGetItem, lsSetItem } from './storageService';

const CACHE_PREFIX = 'VIDEO_CACHE_';
const CACHE_META_KEY = 'VIDEO_CACHE_META_V1';

/** 缓存大小限制：500MB（可配置） */
const MAX_CACHE_SIZE_MB = parseInt(import.meta.env.VITE_VIDEO_CACHE_SIZE_MB || '500', 10);
const MAX_CACHE_SIZE_BYTES = MAX_CACHE_SIZE_MB * 1024 * 1024;

interface VideoCacheMetadata {
  url: string;
  blobUrl: string;
  cachedAt: number;
  size?: number;
  /** 与当前页面加载绑定；刷新后 blob 失效，旧缓存需丢弃 */
  pageBootId?: string;
}

/** 每次完整加载页面生成新 ID，用于使 localStorage 里记录的 blob: URL 在刷新后失效 */
function getPageBootId(): string {
  if (typeof window === 'undefined') return '';
  const w = window as Window & { __CM_PAGE_BOOT_ID__?: string };
  if (!w.__CM_PAGE_BOOT_ID__) {
    w.__CM_PAGE_BOOT_ID__ = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
  return w.__CM_PAGE_BOOT_ID__;
}

/**
 * 获取视频的缓存键
 */
function getCacheKey(videoUrl: string): string {
  return `${CACHE_PREFIX}${btoa(videoUrl).replace(/[+/=]/g, '')}`;
}

/**
 * 检查视频是否已缓存
 */
export function isVideoCached(videoUrl: string): boolean {
  const cacheKey = getCacheKey(videoUrl);
  return localStorage.getItem(cacheKey) !== null;
}

/**
 * 获取缓存的视频 Blob URL
 */
export function getCachedVideoUrl(videoUrl: string): string | null {
  const cacheKey = getCacheKey(videoUrl);
  const cachedData = localStorage.getItem(cacheKey);
  
  if (!cachedData) {
    return null;
  }
  
  try {
    const metadata: VideoCacheMetadata = JSON.parse(cachedData);
    // 刷新后 blob: 已无效，但 localStorage 仍指向旧 blob —— 用 pageBootId 丢弃
    const boot = getPageBootId();
    if (!metadata.pageBootId || metadata.pageBootId !== boot) {
      clearVideoCache(videoUrl);
      return null;
    }
    // 检查缓存是否过期（30天）
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - metadata.cachedAt > thirtyDays) {
      // 缓存过期，清除
      clearVideoCache(videoUrl);
      return null;
    }
    
    return metadata.blobUrl;
  } catch (error) {
    console.error('[VideoCache] 解析缓存数据失败:', error);
    clearVideoCache(videoUrl);
    return null;
  }
}

/**
 * 缓存视频到本地
 * 将视频下载并转换为 Blob URL 存储
 */
export async function cacheVideo(videoUrl: string): Promise<string> {
  // 先检查是否已缓存
  const cachedUrl = getCachedVideoUrl(videoUrl);
  if (cachedUrl) {
    console.log('[VideoCache] 使用已缓存的视频:', videoUrl);
    return cachedUrl;
  }

  console.log('[VideoCache] 开始下载并缓存视频:', videoUrl);

  let blob: Blob;
  try {
    try {
      const resp = await fetch(videoUrl);
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      blob = await resp.blob();
    } catch {
      try {
        blob = await new Promise<Blob>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', videoUrl);
          xhr.responseType = 'blob';
          xhr.onload = () => resolve(xhr.response);
          xhr.onerror = () => reject(new Error('XMLHttpRequest failed'));
          xhr.send();
        });
      } catch {
        console.warn('[VideoCache] fetch 和 XMLHttpRequest 均失败，缓存放弃，回退到原 URL:', videoUrl);
        return videoUrl;
      }
    }

    const blobUrl = URL.createObjectURL(blob);

    const metadata: VideoCacheMetadata = {
      url: videoUrl,
      blobUrl: blobUrl,
      cachedAt: Date.now(),
      size: blob.size,
      pageBootId: getPageBootId(),
    };

    const cacheKey = getCacheKey(videoUrl);
    localStorage.setItem(cacheKey, JSON.stringify(metadata));

    updateCacheMetadata(videoUrl, metadata);

    console.log('[VideoCache] 视频缓存成功:', {
      url: videoUrl,
      size: blob.size,
      blobUrl: blobUrl.substring(0, 50) + '...',
    });

    return blobUrl;
  } catch (error: any) {
    console.error('[VideoCache] 缓存视频失败:', error);
    return videoUrl;
  }
}

/**
 * 更新缓存元数据列表
 */
function updateCacheMetadata(videoUrl: string, metadata: VideoCacheMetadata): void {
  const meta = lsGetItem<Record<string, VideoCacheMetadata>>(CACHE_META_KEY, {});
  meta[videoUrl] = metadata;
  lsSetItem(CACHE_META_KEY, meta);
}

/**
 * 清除视频缓存
 */
export function clearVideoCache(videoUrl: string): void {
  const cacheKey = getCacheKey(videoUrl);
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const meta = JSON.parse(raw) as VideoCacheMetadata;
        if (meta.blobUrl) URL.revokeObjectURL(meta.blobUrl);
      }
    } catch { /* ignore */ }
    try { localStorage.removeItem(cacheKey); } catch { /* ignore */ }
  }

  // 从元数据表中移除
  const meta = lsGetItem<Record<string, VideoCacheMetadata>>(CACHE_META_KEY, {});
  delete meta[videoUrl];
  lsSetItem(CACHE_META_KEY, meta);
}

/**
 * 获取所有缓存的视频列表
 */
export function getAllCachedVideos(): VideoCacheMetadata[] {
  const meta = lsGetItem<Record<string, VideoCacheMetadata>>(CACHE_META_KEY, {});
  return Object.values(meta);
}

/**
 * 获取当前缓存总大小
 */
export function getCacheTotalSize(): number {
  const cachedVideos = getAllCachedVideos();
  return cachedVideos.reduce((total, v) => total + (v.size || 0), 0);
}

/**
 * 获取缓存统计信息
 */
export function getCacheStats(): { count: number; totalSize: number; maxSize: number; oldestItem?: number } {
  const cachedVideos = getAllCachedVideos();
  const totalSize = cachedVideos.reduce((total, v) => total + (v.size || 0), 0);
  const oldestItem = cachedVideos.length > 0
    ? Math.min(...cachedVideos.map(v => v.cachedAt))
    : undefined;
  return {
    count: cachedVideos.length,
    totalSize,
    maxSize: MAX_CACHE_SIZE_BYTES,
    oldestItem,
  };
}

/**
 * 清理过期缓存和超出大小限制的缓存
 * 按时间从旧到新清理，直到缓存大小在限制内
 */
export async function cleanExpiredAndOversizedCache(): Promise<{ removed: number; freedBytes: number }> {
  let removed = 0;
  let freedBytes = 0;
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  // 获取所有缓存
  const cachedVideos = getAllCachedVideos();

  // 1. 先清理过期缓存（30天以上）
  for (const video of cachedVideos) {
    if (now - video.cachedAt > thirtyDays) {
      clearVideoCache(video.url);
      removed++;
      freedBytes += video.size || 0;
    }
  }

  // 2. 如果缓存大小超出限制，清理最旧的缓存
  let currentSize = getCacheTotalSize();
  if (currentSize > MAX_CACHE_SIZE_BYTES) {
    // 按缓存时间从旧到新排序
    const remainingVideos = getAllCachedVideos().sort((a, b) => a.cachedAt - b.cachedAt);

    for (const video of remainingVideos) {
      if (currentSize <= MAX_CACHE_SIZE_BYTES * 0.8) break; // 清理到 80% 以下
      clearVideoCache(video.url);
      removed++;
      freedBytes += video.size || 0;
      currentSize -= video.size || 0;
    }
  }

  if (removed > 0) {
    console.log(`[VideoCache] 清理完成：移除了 ${removed} 个缓存项，释放 ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);
  }

  return { removed, freedBytes };
}

/**
 * 清除所有视频缓存
 */
export function clearAllVideoCache(): void {
  const cachedVideos = getAllCachedVideos();

  // 释放所有 Blob URL
  cachedVideos.forEach(metadata => {
    if (metadata.blobUrl) {
      URL.revokeObjectURL(metadata.blobUrl);
    }
  });

  // 清除所有缓存键
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith(CACHE_PREFIX)) {
      localStorage.removeItem(key);
    }
  });

  localStorage.removeItem(CACHE_META_KEY);

  console.log('[VideoCache] 已清除所有视频缓存');
}

/**
 * 下载视频到本地文件
 */
export async function downloadVideo(videoUrl: string, filename?: string): Promise<void> {
  try {
    console.log('[VideoCache] 开始下载视频到本地:', videoUrl);
    
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status} ${response.statusText}`);
    }
    
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || `video_${Date.now()}.mp4`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // 延迟释放 URL，确保下载完成
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 100);
    
    console.log('[VideoCache] 视频下载成功');
  } catch (error: any) {
    console.error('[VideoCache] 下载视频失败:', error);
    throw new Error(`下载视频失败: ${error.message || '未知错误'}`);
  }
}
