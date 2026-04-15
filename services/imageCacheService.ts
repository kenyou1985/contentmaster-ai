/**
 * 图片缓存服务 - 使用IndexedDB存储生成的图片
 */

const DB_NAME = 'ChannelImageCache';
const DB_VERSION = 1;
const STORE_NAME = 'images';

let db: IDBDatabase | null = null;

// 初始化数据库
export const initImageCache = (): Promise<boolean> => {
  return new Promise((resolve) => {
    if (db) {
      resolve(true);
      return;
    }

    // 检查是否支持 IndexedDB
    if (typeof indexedDB === 'undefined') {
      console.warn('[ImageCache] IndexedDB 不可用，图片缓存功能已禁用');
      resolve(false);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.warn('[ImageCache] 数据库打开失败，图片缓存功能已禁用');
      db = null;
      resolve(false);
    };

    request.onsuccess = () => {
      db = request.result;
      console.log('[ImageCache] 数据库初始化成功');
      resolve(true);
    };

    request.onblocked = () => {
      console.warn('[ImageCache] 数据库打开被阻止');
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
  });
};

// 将图片URL转换为base64并缓存
export const cacheImage = async (key: string, url: string): Promise<string> => {
  try {
    // 如果是已经是data URL，直接返回
    if (url.startsWith('data:')) {
      return url;
    }

    // 初始化缓存，检查是否可用
    const cacheAvailable = await initImageCache();
    if (!cacheAvailable) {
      console.warn('[ImageCache] 缓存不可用，跳过缓存:', key);
      return url;
    }

    // 再次检查 db 状态
    if (!db) {
      console.warn('[ImageCache] 数据库未就绪，跳过缓存:', key);
      return url;
    }

    // 尝试转换为base64
    const response = await fetch(url);
    const blob = await response.blob();
    const base64 = await blobToBase64(blob);
    const dataUrl = `data:${blob.type};base64,${base64}`;

    // 存储到IndexedDB
    return new Promise((resolve) => {
      try {
        const transaction = db!.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.put({ key, dataUrl });
        transaction.oncomplete = () => {
          console.log(`[ImageCache] 图片已缓存: ${key}`);
          resolve(dataUrl);
        };
        transaction.onerror = () => {
          console.warn('[ImageCache] 事务错误，返回原始URL');
          resolve(url);
        };
      } catch (e) {
        console.warn('[ImageCache] 存储失败，返回原始URL:', e);
        resolve(url);
      }
    });
  } catch (e) {
    console.error('[ImageCache] 缓存图片失败:', e);
    return url; // 失败时返回原始URL
  }
};

// 批量缓存图片
export const cacheImages = async (
  avatarUrls: string[][],
  bannerUrls: string[][]
): Promise<{ avatarUrls: string[][]; bannerUrls: string[][] }> => {
  const timestamp = Date.now();
  
  // 缓存头像
  const cachedAvatars: string[][] = [];
  for (let i = 0; i < avatarUrls.length; i++) {
    cachedAvatars[i] = [];
    for (let j = 0; j < avatarUrls[i].length; j++) {
      const key = `avatar_${timestamp}_${i}_${j}`;
      const cached = await cacheImage(key, avatarUrls[i][j]);
      cachedAvatars[i].push(cached);
    }
  }

  // 缓存横幅
  const cachedBanners: string[][] = [];
  for (let i = 0; i < bannerUrls.length; i++) {
    cachedBanners[i] = [];
    for (let j = 0; j < bannerUrls[i].length; j++) {
      const key = `banner_${timestamp}_${i}_${j}`;
      const cached = await cacheImage(key, bannerUrls[i][j]);
      cachedBanners[i].push(cached);
    }
  }

  return { avatarUrls: cachedAvatars, bannerUrls: cachedBanners };
};

// 从缓存获取图片
export const getCachedImage = (key: string): Promise<string | null> => {
  return new Promise((resolve) => {
    if (!db) {
      initImageCache().then(() => getCachedImage(key)).then(resolve).catch(() => resolve(null));
      return;
    }

    try {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        resolve(request.result?.dataUrl || null);
      };
      request.onerror = () => resolve(null);
    } catch (e) {
      console.warn('[ImageCache] 读取缓存失败:', e);
      resolve(null);
    }
  });
};

// 清理过期缓存（保留最近N条记录的缓存）
export const cleanupOldCache = (keepCount: number = 10): void => {
  if (!db) return;

  try {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        // 随机删除一些条目
        if (Math.random() > 0.5) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
    request.onerror = () => {
      console.warn('[ImageCache] 清理缓存游标错误');
    };
  } catch (e) {
    console.warn('[ImageCache] 清理缓存失败:', e);
  }
};

// blob转base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      try {
        const result = reader.result as string;
        if (!result || typeof result !== 'string') {
          reject(new Error('Invalid reader result'));
          return;
        }
        const parts = result.split(',');
        if (parts.length < 2) {
          reject(new Error('Invalid data URL format'));
          return;
        }
        resolve(parts[1]);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
};

// 清除所有缓存
export const clearImageCache = (): Promise<void> => {
  return new Promise((resolve) => {
    if (!db) {
      initImageCache().then(() => clearImageCache()).then(resolve);
      return;
    }

    try {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.clear();
      transaction.oncomplete = () => {
        console.log('[ImageCache] 缓存已清除');
        resolve();
      };
    } catch {
      resolve();
    }
  });
};
