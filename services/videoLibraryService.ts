/**
 * 视频库服务 — IndexedDB 持久化存储
 * 存储参考视频文件元数据 + Blob，供数字人模块直接复用，无需重复上传
 */

const DB_NAME = 'video_library_db';
const DB_VERSION = 1;
const STORE_NAME = 'videos';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface VideoLibraryItem {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  blob: Blob;
  createdAt: number;
  /** RunningHub 上传后的路径（若有） */
  rhPath?: string;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function saveVideoToLibrary(
  file: File,
  onProgress?: (pct: number) => void
): Promise<VideoLibraryItem> {
  onProgress?.(10);
  const id = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const blob = file.slice(0, file.size);
  onProgress?.(60);

  const item: VideoLibraryItem = {
    id,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    blob,
    createdAt: Date.now(),
  };

  await withStore('readwrite', (store) => store.put(item));
  onProgress?.(100);
  return item;
}

export async function listVideoLibrary(): Promise<VideoLibraryItem[]> {
  const all: VideoLibraryItem[] = await withStore('readonly', (store) =>
    store.index('createdAt').getAll()
  );
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteVideoFromLibrary(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}

export async function updateVideoRhPath(id: string, rhPath: string): Promise<void> {
  const item: VideoLibraryItem = await withStore('readwrite', (store) => store.get(id));
  if (item) {
    item.rhPath = rhPath;
    await withStore('readwrite', (store) => store.put(item));
  }
}

export async function getVideoFromLibrary(id: string): Promise<VideoLibraryItem | undefined> {
  return withStore('readonly', (store) => store.get(id));
}

export async function getLibrarySize(): Promise<number> {
  const items: VideoLibraryItem[] = await withStore('readonly', (store) => store.getAll());
  return items.reduce((sum, item) => sum + item.size, 0);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
