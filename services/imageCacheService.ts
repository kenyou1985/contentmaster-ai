/**
 * 图片缓存服务
 * 用于将图片下载到本地缓存，避免刷新后 HTTP URL 失效（如 jimeng 403 签名过期）
 * - 每个图片 URL 的缓存数据（blob URL）：localStorage（会话级，刷新后失效）
 * - 元数据表（CACHE_META_KEY）：IndexedDB（storageService） + localStorage 兼容层
 *
 * 设计参照 services/videoCacheService.ts
 */

import { lsGetItem, lsSetItem } from './storageService';

const CACHE_PREFIX = 'IMAGE_CACHE_';
const CACHE_META_KEY = 'IMAGE_CACHE_META_V1';

/** 缓存大小限制：2GB（图片比视频轻，阈值放宽；可配置） */
const MAX_CACHE_SIZE_MB = parseInt(import.meta.env.VITE_IMAGE_CACHE_SIZE_MB || '2048', 10);
const MAX_CACHE_SIZE_BYTES = MAX_CACHE_SIZE_MB * 1024 * 1024;

interface ImageCacheMetadata {
  url: string;
  blobUrl: string;
  cachedAt: number;
  size?: number;
  width?: number;
  height?: number;
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

function getCacheKey(imageUrl: string): string {
  return `${CACHE_PREFIX}${btoa(imageUrl).replace(/[+/=]/g, '')}`;
}

export function isImageCached(imageUrl: string): boolean {
  const cacheKey = getCacheKey(imageUrl);
  return localStorage.getItem(cacheKey) !== null;
}

export function getCachedImageUrl(imageUrl: string): string | null {
  const cacheKey = getCacheKey(imageUrl);
  const cachedData = localStorage.getItem(cacheKey);

  if (!cachedData) {
    return null;
  }

  try {
    const metadata: ImageCacheMetadata = JSON.parse(cachedData);
    // 刷新后 blob: 已无效，但 localStorage 仍指向旧 blob —— 用 pageBootId 丢弃
    const boot = getPageBootId();
    if (!metadata.pageBootId || metadata.pageBootId !== boot) {
      clearImageCache(imageUrl);
      return null;
    }
    // 检查缓存是否过期（30天）
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - metadata.cachedAt > thirtyDays) {
      clearImageCache(imageUrl);
      return null;
    }

    return metadata.blobUrl;
  } catch (error) {
    console.error('[ImageCache] 解析缓存数据失败:', error);
    clearImageCache(imageUrl);
    return null;
  }
}

export async function cacheImage(imageUrl: string): Promise<string> {
  // 先检查是否已缓存
  const cachedUrl = getCachedImageUrl(imageUrl);
  if (cachedUrl) {
    console.log('[ImageCache] 使用已缓存的图片:', imageUrl);
    return cachedUrl;
  }

  console.log('[ImageCache] 开始下载并缓存图片:', imageUrl);

  let blob: Blob;
  try {
    try {
      // 尝试带 referer 的方式（防盗链图片需要）
      const fetchWithHeaders = async (u: string): Promise<Response> => {
        // 常见的 referer 来源
        const referers: Record<string, string> = {
          'p11-dreamina-sign.byteimg.com': 'https://jimeng.jianying.com/',
          'byteimg.com': 'https://jimeng.jianying.com/',
          'yunwu.ai': 'https://yunwu.ai/',
          'bytedance.com': 'https://jimeng.jianying.com/',
          'cos.ap-beijing.myqcloud.com': 'https://www.runninghub.ai/',
          'rh-images': 'https://www.runninghub.ai/',
        };
        const hostname = new URL(u).hostname;
        const ref = Object.keys(referers).find(k => hostname.includes(k));
        const headersInit: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };
        if (ref) headersInit['Referer'] = referers[ref];
        return fetch(u, { headers: headersInit });
      };
      const resp = await fetchWithHeaders(imageUrl);
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      blob = await resp.blob();
    } catch {
      try {
        blob = await new Promise<Blob>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', imageUrl);
          xhr.responseType = 'blob';
          xhr.onload = () => resolve(xhr.response);
          xhr.onerror = () => reject(new Error('XMLHttpRequest failed'));
          xhr.send();
        });
      } catch {
        console.warn('[ImageCache] fetch 和 XMLHttpRequest 均失败，缓存放弃，回退到原 URL:', imageUrl);
        return imageUrl;
      }
    }

    const blobUrl = URL.createObjectURL(blob);

    const metadata: ImageCacheMetadata = {
      url: imageUrl,
      blobUrl,
      cachedAt: Date.now(),
      size: blob.size,
      pageBootId: getPageBootId(),
    };

    const cacheKey = getCacheKey(imageUrl);
    localStorage.setItem(cacheKey, JSON.stringify(metadata));

    updateCacheMetadata(imageUrl, metadata);

    console.log('[ImageCache] 图片缓存成功:', {
      url: imageUrl,
      size: blob.size,
      blobUrl: blobUrl.substring(0, 50) + '...',
    });

    return blobUrl;
  } catch (error: any) {
    console.error('[ImageCache] 缓存图片失败:', error);
    return imageUrl;
  }
}

/** 并行缓存多个图片 URL，返回缓存后的 URL 映射 */
export async function cacheImages(
  avatarUrls: string[][],
  bannerUrls: string[][]
): Promise<{ avatarUrls: string[][]; bannerUrls: string[][] }> {
  const allAvatarUrls = avatarUrls.map(v => v || []);
  const allBannerUrls = bannerUrls.map(v => v || []);

  const flatAvatars = allAvatarUrls.flat().filter(Boolean);
  const flatBanners = allBannerUrls.flat().filter(Boolean);

  const avatarResults = await Promise.all(flatAvatars.map(u => cacheImage(u)));
  const bannerResults = await Promise.all(flatBanners.map(u => cacheImage(u)));

  let idx = 0;
  const cachedAvatars = allAvatarUrls.map(group =>
    group.map(() => avatarResults[idx++] || '')
  );
  idx = 0;
  const cachedBanners = allBannerUrls.map(group =>
    group.map(() => bannerResults[idx++] || '')
  );

  return { avatarUrls: cachedAvatars, bannerUrls: cachedBanners };
}

function updateCacheMetadata(imageUrl: string, metadata: ImageCacheMetadata): void {
  const meta = lsGetItem<Record<string, ImageCacheMetadata>>(CACHE_META_KEY, {});
  meta[imageUrl] = metadata;
  lsSetItem(CACHE_META_KEY, meta);
}

export function clearImageCache(imageUrl: string): void {
  const cacheKey = getCacheKey(imageUrl);
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const meta = JSON.parse(raw) as ImageCacheMetadata;
        if (meta.blobUrl) URL.revokeObjectURL(meta.blobUrl);
      }
    } catch { /* ignore */ }
    try { localStorage.removeItem(cacheKey); } catch { /* ignore */ }
  }

  const meta = lsGetItem<Record<string, ImageCacheMetadata>>(CACHE_META_KEY, {});
  delete meta[imageUrl];
  lsSetItem(CACHE_META_KEY, meta);
}

export function getAllCachedImages(): ImageCacheMetadata[] {
  const meta = lsGetItem<Record<string, ImageCacheMetadata>>(CACHE_META_KEY, {});
  return Object.values(meta);
}

export function getImageCacheTotalSize(): number {
  return getAllCachedImages().reduce((total, v) => total + (v.size || 0), 0);
}

export function getImageCacheStats(): { count: number; totalSize: number; maxSize: number; oldestItem?: number } {
  const cachedImages = getAllCachedImages();
  const totalSize = cachedImages.reduce((total, v) => total + (v.size || 0), 0);
  const oldestItem = cachedImages.length > 0
    ? Math.min(...cachedImages.map((v) => v.cachedAt))
    : undefined;
  return {
    count: cachedImages.length,
    totalSize,
    maxSize: MAX_CACHE_SIZE_BYTES,
    oldestItem,
  };
}

export async function cleanExpiredAndOversizedImageCache(): Promise<{ removed: number; freedBytes: number }> {
  let removed = 0;
  let freedBytes = 0;
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  const cachedImages = getAllCachedImages();

  for (const image of cachedImages) {
    if (now - image.cachedAt > thirtyDays) {
      clearImageCache(image.url);
      removed++;
      freedBytes += image.size || 0;
    }
  }

  let currentSize = getImageCacheTotalSize();
  if (currentSize > MAX_CACHE_SIZE_BYTES) {
    const remaining = getAllCachedImages().sort((a, b) => a.cachedAt - b.cachedAt);

    for (const image of remaining) {
      if (currentSize <= MAX_CACHE_SIZE_BYTES * 0.8) break;
      clearImageCache(image.url);
      removed++;
      freedBytes += image.size || 0;
      currentSize -= image.size || 0;
    }
  }

  if (removed > 0) {
    console.log(`[ImageCache] 清理完成：移除了 ${removed} 个缓存项，释放 ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);
  }
  return { removed, freedBytes };
}

export function clearAllImageCache(): void {
  const cachedImages = getAllCachedImages();

  cachedImages.forEach((metadata) => {
    if (metadata.blobUrl) {
      URL.revokeObjectURL(metadata.blobUrl);
    }
  });

  Object.keys(localStorage).forEach((key) => {
    if (key.startsWith(CACHE_PREFIX)) {
      localStorage.removeItem(key);
    }
  });

  localStorage.removeItem(CACHE_META_KEY);
  console.log('[ImageCache] 已清除所有图片缓存');
}
