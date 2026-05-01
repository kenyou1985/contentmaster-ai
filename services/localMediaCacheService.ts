/**
 * 本地媒体缓存服务
 * 通过后端 image-cache-server 将媒体（图片/视频）缓存到本地文件系统，
 * 避免导出剪映时依赖远程 URL。
 *
 * 后端服务（默认 http://127.0.0.1:18092）需单独启动。
 */

const IMAGE_CACHE_BASE = '/api/image-cache';

/** 缓存元数据存储 key（localStorage） */
const META_KEY = 'local_media_cache_meta_v1';

interface CacheMeta {
  url: string;
  localPath: string;
  cachedAt: number;
  sizeBytes?: number;
}

function getMeta(): CacheMeta[] {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setMeta(meta: CacheMeta[]): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // localStorage 满则静默忽略
  }
}

function getMetaEntry(url: string): CacheMeta | undefined {
  return getMeta().find((m) => m.url === url);
}

/**
 * 将媒体 dataUrl 保存到本地缓存，返回本地路径。
 * dataUrl 格式: data:image/png;base64,... 或 data:video/mp4;base64,...
 */
export async function saveMediaToLocalCache(url: string, dataUrl: string): Promise<string | null> {
  try {
    const meta = getMeta();
    const existing = meta.find((m) => m.url === url);
    if (existing) return existing.localPath;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    const r = await fetch(`${IMAGE_CACHE_BASE}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, dataUrl }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      console.warn('[localMediaCache] save failed:', r.status, await r.text().catch(() => ''));
      return null;
    }

    const json = (await r.json()) as { path?: string };
    if (!json.path) return null;

    const entry: CacheMeta = { url, localPath: json.path, cachedAt: Date.now() };
    setMeta([...meta.filter((m) => m.url !== url), entry]);
    return json.path;
  } catch (e) {
    console.warn('[localMediaCache] save error:', e);
    return null;
  }
}

/**
 * 批量检查哪些 URL 已有本地缓存路径。
 * 返回 Map<url, localPath>，仅包含已缓存的条目。
 */
export async function getLocalCachePaths(
  urls: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!urls.length) return result;

  const meta = getMeta();
  const now = Date.now();
  const staleMs = 7 * 24 * 60 * 60 * 1000; // 7 天过期

  for (const url of urls) {
    const entry = meta.find((m) => m.url === url);
    if (entry && now - entry.cachedAt < staleMs) {
      // 验证路径是否仍然有效
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5_000);
        const r = await fetch(`${IMAGE_CACHE_BASE}/exists?path=${encodeURIComponent(entry.localPath)}`, {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (r.ok) {
          result.set(url, entry.localPath);
        } else {
          // 文件不存在，移除过期条目
          setMeta(meta.filter((m) => m.url !== url));
        }
      } catch {
        // 网络错误时保守地信任元数据（本地文件大概率仍存在）
        result.set(url, entry.localPath);
      }
    }
  }

  return result;
}

/**
 * 解析 URL 列表，优先使用本地缓存路径，缓存不存在时原样返回 URL。
 * 返回 Map<url, pathOrUrl>。
 */
export async function resolveLocalCacheOrFetch(
  urls: string[]
): Promise<Map<string, string>> {
  const cached = await getLocalCachePaths(urls);
  const result = new Map<string, string>();
  for (const url of urls) {
    result.set(url, cached.get(url) ?? url);
  }
  return result;
}
