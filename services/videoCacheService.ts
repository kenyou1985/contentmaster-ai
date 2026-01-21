/**
 * 视频缓存服务
 * 用于将视频下载到本地缓存，提升播放性能
 */

const CACHE_PREFIX = 'VIDEO_CACHE_';
const CACHE_META_KEY = 'VIDEO_CACHE_METADATA';

interface VideoCacheMetadata {
  url: string;
  blobUrl: string;
  cachedAt: number;
  size?: number;
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
  
  try {
    // 下载视频
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error(`下载视频失败: ${response.status} ${response.statusText}`);
    }
    
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    
    // 将 Blob URL 存储到 IndexedDB 或使用其他方式
    // 由于 localStorage 有大小限制，我们使用 IndexedDB 存储大文件
    // 但为了简单，这里先使用 sessionStorage 存储元数据，实际 blob 通过 URL.createObjectURL 管理
    
    // 存储元数据到 localStorage
    const metadata: VideoCacheMetadata = {
      url: videoUrl,
      blobUrl: blobUrl,
      cachedAt: Date.now(),
      size: blob.size,
    };
    
    const cacheKey = getCacheKey(videoUrl);
    localStorage.setItem(cacheKey, JSON.stringify(metadata));
    
    // 更新缓存元数据列表
    updateCacheMetadata(videoUrl, metadata);
    
    console.log('[VideoCache] 视频缓存成功:', {
      url: videoUrl,
      size: blob.size,
      blobUrl: blobUrl.substring(0, 50) + '...'
    });
    
    return blobUrl;
  } catch (error: any) {
    console.error('[VideoCache] 缓存视频失败:', error);
    throw new Error(`缓存视频失败: ${error.message || '未知错误'}`);
  }
}

/**
 * 更新缓存元数据列表
 */
function updateCacheMetadata(videoUrl: string, metadata: VideoCacheMetadata): void {
  try {
    const existing = localStorage.getItem(CACHE_META_KEY);
    const metadataList: Record<string, VideoCacheMetadata> = existing ? JSON.parse(existing) : {};
    metadataList[videoUrl] = metadata;
    localStorage.setItem(CACHE_META_KEY, JSON.stringify(metadataList));
  } catch (error) {
    console.error('[VideoCache] 更新缓存元数据失败:', error);
  }
}

/**
 * 清除视频缓存
 */
export function clearVideoCache(videoUrl: string): void {
  const cacheKey = getCacheKey(videoUrl);
  const cachedData = localStorage.getItem(cacheKey);
  
  if (cachedData) {
    try {
      const metadata: VideoCacheMetadata = JSON.parse(cachedData);
      // 释放 Blob URL
      if (metadata.blobUrl) {
        URL.revokeObjectURL(metadata.blobUrl);
      }
    } catch (error) {
      console.error('[VideoCache] 释放 Blob URL 失败:', error);
    }
  }
  
  localStorage.removeItem(cacheKey);
  
  // 从元数据列表中移除
  try {
    const existing = localStorage.getItem(CACHE_META_KEY);
    if (existing) {
      const metadataList: Record<string, VideoCacheMetadata> = JSON.parse(existing);
      delete metadataList[videoUrl];
      localStorage.setItem(CACHE_META_KEY, JSON.stringify(metadataList));
    }
  } catch (error) {
    console.error('[VideoCache] 清除缓存元数据失败:', error);
  }
}

/**
 * 获取所有缓存的视频列表
 */
export function getAllCachedVideos(): VideoCacheMetadata[] {
  try {
    const existing = localStorage.getItem(CACHE_META_KEY);
    if (!existing) {
      return [];
    }
    
    const metadataList: Record<string, VideoCacheMetadata> = JSON.parse(existing);
    return Object.values(metadataList);
  } catch (error) {
    console.error('[VideoCache] 获取缓存列表失败:', error);
    return [];
  }
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
