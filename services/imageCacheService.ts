/**
 * 图片缓存服务 - 使用IndexedDB存储生成的图片
 */

const DB_NAME = 'ChannelImageCache';
const DB_VERSION = 1;
const STORE_NAME = 'images';

let db: IDBDatabase | null = null;

// 初始化数据库
export const initImageCache = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve();
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[ImageCache] 数据库打开失败');
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      console.log('[ImageCache] 数据库初始化成功');
      resolve();
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
    await initImageCache();

    // 如果是已经是data URL，直接返回
    if (url.startsWith('data:')) {
      return url;
    }

    // 尝试转换为base64
    const response = await fetch(url);
    const blob = await response.blob();
    const base64 = await blobToBase64(blob);
    const dataUrl = `data:${blob.type};base64,${base64}`;

    // 存储到IndexedDB
    return new Promise((resolve, reject) => {
      const transaction = db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put({ key, dataUrl });
      transaction.oncomplete = () => {
        console.log(`[ImageCache] 图片已缓存: ${key}`);
        resolve(dataUrl);
      };
      transaction.onerror = () => reject(transaction.error);
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
    } catch {
      resolve(null);
    }
  });
};

// 清理过期缓存（保留最近N条记录的缓存）
export const cleanupOldCache = (keepCount: number = 10): void => {
  // 简单的清理策略：随机删除一半的缓存
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
  } catch (e) {
    console.error('[ImageCache] 清理缓存失败:', e);
  }
};

// blob转base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // 移除data URL前缀
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
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
