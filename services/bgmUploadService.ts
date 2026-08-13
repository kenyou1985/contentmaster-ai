/**
 * 本地背景音乐上传 + 临时缓存
 *
 * 设计：
 * - 用户上传的 mp3/wav 文件转 data URL 存在 sessionStorage（容量限制 5~10MB）
 * - 超大文件（>8MB）直接放进内存但不做 sessionStorage 持久化
 * - 通过文件名 hash 做缓存 key，避免重复 base64 转换
 */

const STORAGE_KEY = 'cm.remotion.bgm.cache.v1';
const MAX_CACHE_BYTES = 8 * 1024 * 1024; // 8MB

export interface BgmCacheEntry {
  name: string;
  size: number;
  type: string;
  dataUrl: string;
  cachedAt: number;
}

function readStore(): Record<string, BgmCacheEntry> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, BgmCacheEntry>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (e) {
    // 配额超限，清掉最老的
    const entries = Object.entries(store).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    while (entries.length > 0) {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
        return;
      } catch {
        entries.shift(); // 丢掉最老的
      }
    }
  }
}

function fileKey(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified || 0}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 处理用户选择的音频文件，返回 data URL 并尝试写入 sessionStorage。
 */
export async function cacheLocalBgm(file: File): Promise<BgmCacheEntry> {
  const key = fileKey(file);

  const store = readStore();
  if (store[key] && store[key].dataUrl) {
    return store[key];
  }

  const dataUrl = await fileToDataUrl(file);
  const entry: BgmCacheEntry = {
    name: file.name,
    size: file.size,
    type: file.type || 'audio/mpeg',
    dataUrl,
    cachedAt: Date.now(),
  };

  if (file.size <= MAX_CACHE_BYTES) {
    store[key] = entry;
    writeStore(store);
  }
  return entry;
}

export function listCachedBgm(): BgmCacheEntry[] {
  return Object.values(readStore()).sort((a, b) => b.cachedAt - a.cachedAt);
}

export function clearCachedBgm() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function removeCachedBgm(key: string) {
  const store = readStore();
  delete store[key];
  writeStore(store);
}

export function isLikelyAudio(filename: string): boolean {
  return /\.(mp3|wav|aac|m4a|ogg|flac)$/i.test(filename);
}