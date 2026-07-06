/**
 * gpt-image-2 / jimeng 图片历史记录服务
 * 持久化存储：图片 blob 保存到 IndexedDB，history 元数据也存 IndexedDB
 * 不依赖 localStorage（blob URL 无法跨页面持久化）
 */

const STORE_NAME = 'gptImageHistory';
const DB_NAME = 'ContentMasterDB';
const DB_VERSION = 4;

let _dbInstance: IDBDatabase | null = null;
let _dbInitPromise: Promise<IDBDatabase> | null = null;

async function getDb(): Promise<IDBDatabase> {
  if (_dbInstance) return _dbInstance;
  if (_dbInitPromise) return _dbInitPromise;
  _dbInitPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by_batchId', 'batchId', { unique: false });
        store.createIndex('by_createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => { _dbInstance = req.result; resolve(_dbInstance); };
    req.onerror = () => reject(req.error);
  });
  return _dbInitPromise;
}

async function ensureDb(): Promise<IDBDatabase> {
  const db = await getDb();
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    db.close();
    _dbInstance = null;
    _dbInitPromise = null;
    return getDb();
  }
  return db;
}

/** 单张图片记录 */
export interface GptImageRecord {
  id: string;
  blob: Blob;
  mimeType: string;
  prompt: string;
  batchId: string;
  batchIndex: number;
  createdAt: number;
  model: string;
  size?: string;
  originalUrl?: string;
}

/** 批次元数据 */
export interface GptImageBatch {
  id: string;
  previewRecordId: string;
  previewBlobKey: string;
  prompt: string;
  model: string;
  size?: string;
  createdAt: number;
  count: number;
}

/** 历史列表条目 */
export interface GptImageHistoryItem {
  batchId: string;
  prompt: string;
  model: string;
  size?: string;
  createdAt: number;
  count: number;
  previewBlobKey: string;
}

function makeBatchId(): string {
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeRecordId(): string {
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 将 HTTP URL 下载为 Blob */
async function fetchUrlAsBlob(url: string): Promise<Blob> {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const binary = atob(match[2]);
      const arr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      return new Blob([arr], { type: match[1] });
    }
  }

  const hostname = new URL(url).hostname;
  const referers: Record<string, string> = {
    'p11-dreamina-sign.byteimg.com': 'https://jimeng.jianying.com/',
    'byteimg.com': 'https://jimeng.jianying.com/',
    'yunwu.ai': 'https://yunwu.ai/',
    'bytedance.com': 'https://jimeng.jianying.com/',
  };
  const ref = Object.keys(referers).find(k => hostname.includes(k));
  const headersInit: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (ref) headersInit['Referer'] = referers[ref];

  const resp = await fetch(url, { headers: headersInit });
  if (!resp.ok) throw new Error(`fetch ${resp.status}`);
  return resp.blob();
}

/** 根据 MIME 推断扩展名 */
function extFromMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

/**
 * 保存一批生成的图片到历史记录
 * 自动下载 HTTP URL 为 blob 并存入 IndexedDB
 */
export async function saveImageBatch(params: {
  urls: string[];
  prompt: string;
  model: string;
  size?: string;
}): Promise<GptImageBatch | null> {
  if (!params.urls.length) return null;

  const batchId = makeBatchId();
  const db = await ensureDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  const saved: GptImageRecord[] = [];

  for (let i = 0; i < params.urls.length; i++) {
    const url = params.urls[i];
    try {
      const blob = await fetchUrlAsBlob(url);
      const record: GptImageRecord = {
        id: makeRecordId(),
        blob,
        mimeType: blob.type || 'image/png',
        prompt: params.prompt,
        batchId,
        batchIndex: i,
        createdAt: Date.now(),
        model: params.model,
        size: params.size,
        originalUrl: url.startsWith('data:') ? undefined : url,
      };
      await new Promise<void>((res, rej) => {
        const r = store.put(record as unknown as IDBValidKey);
        r.onsuccess = () => res();
        r.onerror = (e) => rej((e.target as IDBRequest).error);
      });
      saved.push(record);
    } catch (e) {
      console.warn('[GptImageHistory] 保存图片失败:', url, e);
    }
  }

  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = (e) => rej((e.target as IDBTransaction).error);
  });

  if (saved.length === 0) return null;

  const preview = saved[0];
  return {
    id: batchId,
    previewRecordId: preview.id,
    previewBlobKey: preview.id,
    prompt: params.prompt,
    model: params.model,
    size: params.size,
    createdAt: Date.now(),
    count: saved.length,
  };
}

/** 获取历史记录列表（按时间倒序） */
export async function getImageHistory(): Promise<GptImageHistoryItem[]> {
  const db = await ensureDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('by_createdAt');
    const req = index.openCursor(null, 'prev');
    const seenBatches = new Set<string>();
    const items: GptImageHistoryItem[] = [];

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (!cursor) {
        resolve(items);
        return;
      }
      const record = cursor.value as GptImageRecord;
      if (!seenBatches.has(record.batchId)) {
        seenBatches.add(record.batchId);
        items.push({
          batchId: record.batchId,
          prompt: record.prompt,
          model: record.model,
          size: record.size,
          createdAt: record.createdAt,
          count: 1,
          previewBlobKey: record.id,
        });
      } else {
        const existing = items.find(it => it.batchId === record.batchId);
        if (existing) existing.count++;
      }
      cursor.continue();
    };
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/** 加载指定批次的单张图片（返回 ObjectURL） */
export async function loadImageFromHistory(recordId: string): Promise<string | null> {
  const db = await ensureDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(recordId);
    req.onsuccess = () => {
      const record = req.result as GptImageRecord | undefined;
      if (!record) { resolve(null); return; }
      const url = URL.createObjectURL(record.blob);
      resolve(url);
    };
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/** 加载指定批次的所有图片 */
export async function loadBatchFromHistory(batchId: string): Promise<Array<{ recordId: string; url: string }>> {
  const db = await ensureDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('by_batchId');
    const req = index.getAll(batchId);
    req.onsuccess = () => {
      const records = (req.result as GptImageRecord[]).sort((a, b) => a.batchIndex - b.batchIndex);
      const results = records.map(r => ({ recordId: r.id, url: URL.createObjectURL(r.blob) }));
      resolve(results);
    };
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/** 删除指定批次的所有记录 */
export async function deleteBatchFromHistory(batchId: string): Promise<void> {
  const db = await ensureDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('by_batchId');
    const req = index.getAllKeys(batchId);
    req.onsuccess = () => {
      const keys = req.result;
      let done = 0;
      if (keys.length === 0) { resolve(); return; }
      for (const key of keys) {
        const delReq = store.delete(key);
        delReq.onsuccess = () => {
          done++;
          if (done === keys.length) resolve();
        };
        delReq.onerror = (e) => reject((e.target as IDBRequest).error);
      }
    };
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/** 清空所有历史记录 */
export async function clearAllImageHistory(): Promise<void> {
  const db = await ensureDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/** 导出 blob 为下载 */
export async function downloadHistoryImage(recordId: string, filename?: string): Promise<void> {
  const db = await ensureDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(recordId);
    req.onsuccess = () => {
      const record = req.result as GptImageRecord | undefined;
      if (!record) { reject(new Error('记录不存在')); return; }
      const url = URL.createObjectURL(record.blob);
      const a = document.createElement('a');
      a.href = url;
      const ext = extFromMime(record.mimeType);
      a.download = filename || `gpt_image_${recordId}_${Date.now()}.${ext}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      resolve();
    };
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}
