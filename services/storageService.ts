/**
 * 通用 IndexedDB 存储服务
 * 提供简洁的 Promise/async 封装，替代 localStorage 实现更大量的持久化存储。
 *
 * 支持：
 * - 任意 JSON 序列化对象（含 Blob、ArrayBuffer 等特殊类型）
 * - 索引查询（通过 keyPath 字段建立索引）
 * - 历史快照（单条记录的变更记录数组）
 * - 自动过期清理（TTL）
 */

const DB_NAME = 'ContentMasterDB';
/** 版本变更会触发 onupgradeneeded，重建全部 object store（修复旧版仅有 kvstore、无 appData 等脏库） */
const DB_VERSION = 3;

interface StoreSchema {
  [storeName: string]: {
    keyPath?: string;
    indexes?: { name: string; keyPath: string; unique?: boolean }[];
    ttlSec?: number; // 该 store 所有记录的默认 TTL（秒）
  };
}

// 所有 store 的结构声明（可按需扩展）
const STORE_SCHEMAS: StoreSchema = {
  /** 通用键值存储（替代 localStorage，可存任意 JSON） */
  appData: { keyPath: 'k' },
  /** 通用列表存储（无需 keyPath，autoIncrement） */
  appList: { },
  /** 视频历史快照（支持趋势分析） */
  videoSnapshots: {
    keyPath: 'id',
    indexes: [
      { name: 'by_videoId', keyPath: 'videoId', unique: false },
      { name: 'by_fetchedAt', keyPath: 'fetchedAt', unique: false },
      { name: 'by_channelId', keyPath: 'channelId', unique: false },
    ],
  },
  /** 频道分组（支持拖拽排序） */
  channelGroups: {
    keyPath: 'id',
    indexes: [{ name: 'by_order', keyPath: 'order', unique: false }],
  },
  /** 频道快照（每次抓取保存一份） */
  channelSnapshots: {
    keyPath: 'id',
    indexes: [
      { name: 'by_channelId', keyPath: 'channelId', unique: false },
      { name: 'by_fetchedAt', keyPath: 'fetchedAt', unique: false },
    ],
  },
  /** 关键词监控配置 */
  keywordMonitors: { keyPath: 'id' },
  /** 关键词搜索结果缓存 */
  keywordResults: {
    keyPath: 'id',
    indexes: [
      { name: 'by_keyword', keyPath: 'keyword', unique: false },
      { name: 'by_fetchedAt', keyPath: 'fetchedAt', unique: false },
    ],
  },
  /** 视频对比列表 */
  videoComparisons: { keyPath: 'id' },
  /** API 配额记录 */
  apiQuotaLog: {
    keyPath: 'id',
    indexes: [
      { name: 'by_date', keyPath: 'date', unique: true },
    ],
  },

  /** 频道元数据（channelId -> 元数据） */
  channelMetaMap: {
    keyPath: 'channelId',
  },
};

let _dbInstance: IDBDatabase | null = null;
let _dbInitPromise: Promise<IDBDatabase> | null = null;
/** onupgradeneeded 完成后通知（用于 put/get 等操作等待 schema 初始化） */
let _dbUpgradeDoneResolve: (() => void) | null = null;
const _dbUpgradeDone = new Promise<void>((r) => { _dbUpgradeDoneResolve = r; });

/** 打开数据库连接（单例） */
async function openDB(): Promise<IDBDatabase> {
  if (_dbInstance) return _dbInstance;
  if (_dbInitPromise) return _dbInitPromise;

  _dbInitPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      for (const [name, schema] of Object.entries(STORE_SCHEMAS)) {
        if (db.objectStoreNames.contains(name)) {
          try { db.deleteObjectStore(name); } catch { /* ignore */ }
        }
        const store = db.createObjectStore(name, schema.keyPath
          ? { keyPath: schema.keyPath }
          : { autoIncrement: true }
        );
        for (const idx of schema.indexes || []) {
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
        }
      }
      // onupgradeneeded 的事务在返回后自动完成，此时 store 即可用
      _dbInstance = db;
      if (_dbUpgradeDoneResolve) _dbUpgradeDoneResolve();
    };

    req.onsuccess = () => {
      // 若 onupgradeneeded 未触发（版本未变），在此补 resolve
      if (!_dbInstance) {
        _dbInstance = req.result;
        if (_dbUpgradeDoneResolve) _dbUpgradeDoneResolve();
      }
      resolve(_dbInstance);
    };

    req.onerror = () => reject(req.error);
  });

  return _dbInitPromise;
}

/** 确保 store 已创建后再执行操作（等待 onupgradeneeded 完成） */
async function waitForStore(): Promise<void> {
  await openDB();
  await _dbUpgradeDone;
}

/**
 * 从 localStorage 迁移单个 key 到 IndexedDB（appData store）
 * 首次读取：优先从 localStorage 取（兼容已有数据），然后写入 IndexedDB
 * 后续读取：直接从 IndexedDB 取
 */
export async function migrateFromLocalStorage<T>(
  key: string,
  defaultValue: T
): Promise<{ value: T; migrated: boolean }> {
  const lsValue = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  if (lsValue !== null) {
    try {
      const parsed = JSON.parse(lsValue) as T;
      await put('appData', { k: key, v: parsed, updatedAt: Date.now() });
      // 清理旧 key（仅在新值已确认写入后）
      if (typeof localStorage !== 'undefined') {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
      }
      return { value: parsed, migrated: true };
    } catch {
      // localStorage 值损坏，丢弃，使用默认值
    }
  }
  // IndexedDB 中读取
  const entry = await get<{ k: string; v: T }>('appData', key);
  return { value: entry?.v ?? defaultValue, migrated: false };
}

/** 通用的 put（新增或覆盖） */
async function put<T>(storeName: string, value: T): Promise<void> {
  await waitForStore();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 通用的 get */
async function get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  await waitForStore();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** 通用的 getAll */
async function getAll<T>(storeName: string): Promise<T[]> {
  await waitForStore();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result || []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** 按索引查询 */
async function getAllByIndex<T>(
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange | null
): Promise<T[]> {
  await waitForStore();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index(indexName).getAll(query);
    req.onsuccess = () => resolve((req.result || []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** 删除 */
async function remove(storeName: string, key: IDBValidKey): Promise<void> {
  await waitForStore();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 清空 store */
async function clear(storeName: string): Promise<void> {
  await waitForStore();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 清理过期记录（TTL 过滤） */
async function pruneExpired(storeName: string, ttlSec: number): Promise<void> {
  const cutoff = Date.now() - ttlSec * 1000;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const val = cursor.value as Record<string, unknown>;
        const fetchedAt = val.fetchedAt as number | undefined;
        if (fetchedAt && fetchedAt < cutoff) {
          store.delete(cursor.primaryKey);
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── 高级封装：带 TTL + 历史快照的 kvstore ──────────────────────────────

export interface KvEntry {
  k: string;       // keyPath
  v: unknown;      // 值（任意可序列化对象）
  updatedAt: number;
  history?: KvEntry[]; // 最近变更历史（最多 N 条）
}

const KV_HISTORY_LIMIT = 20;

export const storage = {
  // ── appData（替代 localStorage）─────────────────────────────────────

  /** 存值 */
  async set<T>(key: string, value: T): Promise<void> {
    const prev = await get<{ k: string; v: unknown; updatedAt: number }>('appData', key);
    const entry = { k: key, v: value, updatedAt: Date.now() };
    if (prev) {
      const history = (prev as any)._history ?? [];
      entry as any; // avoid TS warning
      await put('appData', { k: key, v: value, updatedAt: Date.now(), _history: [{ v: prev.v, ts: prev.updatedAt }, ...history].slice(0, 10) });
    } else {
      await put('appData', { k: key, v: value, updatedAt: Date.now() });
    }
  },

  /** 取值 */
  async get<T>(key: string): Promise<T | undefined> {
    const entry = await get<{ k: string; v: T }>('appData', key);
    return entry?.v as T | undefined;
  },

  /** 删除 */
  async delete(key: string): Promise<void> {
    return remove('appData', key);
  },

  /** 获取所有 key */
  async keys(): Promise<string[]> {
    const entries = await getAll<{ k: string }>('appData');
    return entries.map((e) => e.k);
  },

  /** 批量存 */
  async setMany(entries: { key: string; value: unknown }[]): Promise<void> {
    for (const { key, value } of entries) {
      await this.set(key, value);
    }
  },

  // ── 视频快照（历史趋势）───────────────────────────────────────────────

  /** 追加视频快照（每次抓取后调用，自动去重） */
  async appendVideoSnapshot(snapshot: VideoSnapshot): Promise<void> {
    const existing = await getAllByIndex<VideoSnapshot>('videoSnapshots', 'by_videoId', snapshot.videoId);
    const sameTime = existing.find((s) => s.fetchedAt === snapshot.fetchedAt);
    if (sameTime) return; // 同一时间点不重复写入
    return put('videoSnapshots', { ...snapshot, id: snapshot.id || `${snapshot.videoId}_${snapshot.fetchedAt}` });
  },

  /** 获取视频历史快照（按时间升序） */
  async getVideoHistory(videoId: string): Promise<VideoSnapshot[]> {
    const snaps = await getAllByIndex<VideoSnapshot>('videoSnapshots', 'by_videoId', videoId);
    return snaps.sort((a, b) => a.fetchedAt - b.fetchedAt);
  },

  /** 获取指定时间范围内的快照 */
  async getVideoHistoryInRange(videoId: string, fromTs: number, toTs: number): Promise<VideoSnapshot[]> {
    const snaps = await this.getVideoHistory(videoId);
    return snaps.filter((s) => s.fetchedAt >= fromTs && s.fetchedAt <= toTs);
  },

  // ── 频道分组 ────────────────────────────────────────────────────────

  async getChannelGroups(): Promise<ChannelGroup[]> {
    const groups = await getAll<ChannelGroup>('channelGroups');
    return groups.sort((a, b) => a.order - b.order);
  },

  async saveChannelGroup(group: ChannelGroup): Promise<void> {
    return put('channelGroups', group);
  },

  async deleteChannelGroup(id: string): Promise<void> {
    return remove('channelGroups', id);
  },

  async reorderChannelGroups(orderedIds: string[]): Promise<void> {
    const groups = await this.getChannelGroups();
    const updated = groups.map((g) => ({
      ...g,
      order: orderedIds.indexOf(g.id),
    }));
    for (const g of updated) {
      await put('channelGroups', g);
    }
  },

  // ── 频道元数据 Map ──────────────────────────────────────────────────

  async getChannelMetaMap(): Promise<Record<string, {
    channelId: string;
    title: string;
    description?: string;
    thumbnail?: string;
    subscriberCount: number;
    videoCount: number;
    viewCount: number;
    fetchedAt: number;
  }>> {
    const entries = await getAll<{
      channelId: string;
      title: string;
      description?: string;
      thumbnail?: string;
      subscriberCount: number;
      videoCount: number;
      viewCount: number;
      fetchedAt: number;
    }>('channelMetaMap');
    const map: Record<string, {
      channelId: string;
      title: string;
      description?: string;
      thumbnail?: string;
      subscriberCount: number;
      videoCount: number;
      viewCount: number;
      fetchedAt: number;
    }> = {};
    for (const e of entries) map[e.channelId] = e;
    return map;
  },

  async saveChannelMeta(meta: {
    channelId: string;
    title: string;
    description?: string;
    thumbnail?: string;
    subscriberCount: number;
    videoCount: number;
    viewCount: number;
    fetchedAt: number;
  }): Promise<void> {
    return put('channelMetaMap', meta);
  },

  // ── 关键词监控 ──────────────────────────────────────────────────────

  async getKeywordMonitors(): Promise<KeywordMonitor[]> {
    return getAll<KeywordMonitor>('keywordMonitors');
  },

  async saveKeywordMonitor(m: KeywordMonitor): Promise<void> {
    return put('keywordMonitors', m);
  },

  async deleteKeywordMonitor(id: string): Promise<void> {
    return remove('keywordMonitors', id);
  },

  // ── 关键词搜索结果缓存 ───────────────────────────────────────────────

  async getKeywordResults(keyword: string, maxAgeMs = 10 * 60 * 1000): Promise<KeywordSearchResult[]> {
    const results = await getAllByIndex<KeywordSearchResult>('keywordResults', 'by_keyword', keyword);
    const fresh = results.filter((r) => Date.now() - r.fetchedAt < maxAgeMs);
    return fresh.sort((a, b) => b.fetchedAt - a.fetchedAt);
  },

  async saveKeywordResults(results: KeywordSearchResult[]): Promise<void> {
    for (const r of results) {
      await put('keywordResults', r);
    }
  },

  /** 清理超过 maxAgeMs 的关键词缓存 */
  async pruneKeywordCache(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keywordResults', 'readwrite');
      const store = tx.objectStore('keywordResults');
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const val = cursor.value as KeywordSearchResult;
          if (val.fetchedAt < cutoff) store.delete(cursor.primaryKey);
          else cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  // ── 频道视频缓存 ────────────────────────────────────────────────────

  /** 缓存频道视频列表 */
  async cacheChannelVideos(channelId: string, videos: any[]): Promise<void> {
    const key = `channelVideos_${channelId}`;
    return put('appData', {
      k: key,
      v: {
        videos,
        cachedAt: Date.now(),
        channelId,
      },
      updatedAt: Date.now(),
    });
  },

  /** 获取频道视频缓存 */
  async getCachedChannelVideos(channelId: string): Promise<{ videos: any[]; cachedAt: number } | null> {
    const key = `channelVideos_${channelId}`;
    const entry = await get<{ k: string; v: { videos: any[]; cachedAt: number; channelId: string } }>('appData', key);
    return entry?.v || null;
  },

  /** 检查是否需要刷新（超过指定分钟数） */
  needsRefresh(cachedAt: number, intervalMinutes: number): boolean {
    const ageMs = Date.now() - cachedAt;
    return ageMs > intervalMinutes * 60 * 1000;
  },

  /** 清理过期频道缓存 */
  async pruneChannelCache(maxAgeMs = 2 * 60 * 60 * 1000): Promise<void> {
    const keys = await this.keys();
    const channelKeys = keys.filter(k => k.startsWith('channelVideos_'));
    const cutoff = Date.now() - maxAgeMs;
    for (const key of channelKeys) {
      const entry = await get<any>('appData', key);
      if (entry?.v?.cachedAt && entry.v.cachedAt < cutoff) {
        await this.delete(key);
      }
    }
  },

  // ── 频道快照 ────────────────────────────────────────────────────────

  async appendChannelSnapshot(snapshot: ChannelSnapshot): Promise<void> {
    return put('channelSnapshots', { ...snapshot, id: snapshot.id || `ch_${snapshot.channelId}_${snapshot.fetchedAt}` });
  },

  async getChannelSnapshots(channelId: string): Promise<ChannelSnapshot[]> {
    const snaps = await getAllByIndex<ChannelSnapshot>('channelSnapshots', 'by_channelId', channelId);
    return snaps.sort((a, b) => a.fetchedAt - b.fetchedAt);
  },

  // ── 视频对比列表 ────────────────────────────────────────────────────

  async getVideoComparisons(): Promise<VideoComparison[]> {
    return getAll<VideoComparison>('videoComparisons');
  },

  async saveVideoComparison(c: VideoComparison): Promise<void> {
    return put('videoComparisons', c);
  },

  async deleteVideoComparison(id: string): Promise<void> {
    return remove('videoComparisons', id);
  },

  // ── API 配额日志 ────────────────────────────────────────────────────

  async logApiUsage(units: number, operation: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const existing = await get<ApiQuotaEntry>('apiQuotaLog', today);
    const entry: ApiQuotaEntry = {
      id: today,
      date: today,
      totalUnits: (existing?.totalUnits ?? 0) + units,
      operations: [{ ts: Date.now(), units, operation }],
      updatedAt: Date.now(),
    };
    if (existing?.operations) {
      entry.operations = [...existing.operations, ...entry.operations].slice(0, 1000);
    }
    return put('apiQuotaLog', entry);
  },

  async getApiQuotaToday(): Promise<{ totalUnits: number; operations: ApiQuotaOperation[] }> {
    const today = new Date().toISOString().slice(0, 10);
    const entry = await get<ApiQuotaEntry>('apiQuotaLog', today);
    return { totalUnits: entry?.totalUnits ?? 0, operations: entry?.operations ?? [] };
  },

  /** 获取最近 N 天的配额消耗 */
  async getApiQuotaHistory(days = 7): Promise<ApiQuotaEntry[]> {
    const all = await getAll<ApiQuotaEntry>('apiQuotaLog');
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return all
      .filter((e) => e.updatedAt > cutoff)
      .sort((a, b) => a.date.localeCompare(b.date));
  },

  // ── 清理 / 导出 ──────────────────────────────────────────────────────

  /** 清理所有过期数据 */
  async pruneAll(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    await this.pruneKeywordCache(maxAgeMs);
  },

  /** 导出全部数据（用于备份或迁移） */
  async exportAll(): Promise<Record<string, unknown[]>> {
    const db = await openDB();
    const result: Record<string, unknown[]> = {};
    const storeNames = db.objectStoreNames;
    for (const name of storeNames) {
      result[name] = await getAll(name);
    }
    return result;
  },

  /** 清空所有 store（危险操作） */
  async clearAll(): Promise<void> {
    const db = await openDB();
    const storeNames = db.objectStoreNames;
    for (const name of storeNames) {
      await clear(name);
    }
  },
};

// ── 类型定义（与 store schema 对应）───────────────────────────────────

export interface VideoSnapshot {
  id?: string;
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  viewCount: number;
  likeCount?: number;
  commentCount?: number;
  publishedAt: number; // timestamp
  fetchedAt: number;   // timestamp
  duration?: number;
  thumbnail?: string;
  url?: string;
}

export interface ChannelGroup {
  id: string;
  name: string;
  color: string; // 标签颜色
  channelIds: string[]; // 该分组下的频道 ID 列表
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface KeywordMonitor {
  id: string;
  keyword: string;
  enabled: boolean;
  intervalMinutes: number; // 刷新间隔（分钟）
  lastFetchedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface KeywordSearchResult {
  id: string;
  keyword: string;
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  viewCount: number;
  likeCount?: number;
  publishedAt: number;
  fetchedAt: number;
  thumbnail?: string;
  url?: string;
}

export interface ChannelSnapshot {
  id?: string;
  channelId: string;
  channelTitle: string;
  subscriberCount?: number;
  totalVideos?: number;
  fetchedAt: number;
}

export interface VideoComparison {
  id: string;
  videoIds: string[];
  createdAt: number;
  name?: string;
}

export interface ApiQuotaEntry {
  id: string;
  date: string;
  totalUnits: number;
  operations: ApiQuotaOperation[];
  updatedAt: number;
}

export interface ApiQuotaOperation {
  ts: number;
  units: number;
  operation: string;
}

// ── 辅助函数 ───────────────────────────────────────────────────────────

/** 生成唯一 ID */
export function genId(prefix = ''): string {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ── localStorage 兼容层 ──────────────────────────────────────────────

/**
 * localStorage 同步兼容 API
 * - 写操作：同步写入 localStorage（保持现有 service 代码无需改 async）
 * - 读操作：优先从 localStorage 读；首次读时自动从 IndexedDB 兜底（兼容已迁移的数据）
 * - 后台异步将数据同步到 IndexedDB（做备份和未来迁移）
 *
 * 使用方式：替代各 service 中的 localStorage.getItem / setItem / removeItem
 *
 * 迁移阶段说明：
 * 1. 现有 service 完全不动，读取结果与原来一致
 * 2. 写操作：同步写 localStorage，后台异步写 IndexedDB
 * 3. 读操作：从 localStorage 读；若 localStorage 无数据但 IndexedDB 有，自动同步到 localStorage（数据从 IndexedDB 回填）
 * 4. 所有现有数据均保持兼容，无需用户操作
 */

/** 缓存最近一次 IndexedDB 迁移状态（避免每次读都查 DB） */
const _migratedKeys = new Set<string>();

/**
 * 页面初始化时一次性将 IndexedDB 数据回填到 localStorage
 * （用于 IndexedDB 已有但 localStorage 为空的情况，如 YouTube 分组等新功能）
 */
export async function backfillLocalStorageFromIDB(): Promise<void> {
  await waitForStore();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('appData', 'readonly');
    const req = tx.objectStore('appData').getAll();
    req.onsuccess = () => {
      const entries = (req.result || []) as { k: string; v: unknown }[];
      for (const entry of entries) {
        if (typeof localStorage !== 'undefined') {
          const lsVal = localStorage.getItem(entry.k);
          if (lsVal === null) {
            // localStorage 为空但 IndexedDB 有值 → 回填
            try {
              localStorage.setItem(entry.k, JSON.stringify(entry.v));
              _migratedKeys.add(entry.k);
            } catch { /* storage full, ignore */ }
          }
        }
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

/** 同步兼容 getItem（localStorage 优先；无则同步查 IndexedDB 兜底） */
export function lsGetItem<T>(key: string, defaultValue: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw !== null) {
      return JSON.parse(raw) as T;
    }
  } catch { /* ignore */ }

  // localStorage 为空 → 同步尝试从 IndexedDB 读取（不影响现有同步接口契约）
  void _syncIDBGetThenSet(key, defaultValue);
  return defaultValue;
}

// 同步从 IndexedDB 读取并回填 localStorage（不阻塞，不等待）
async function _syncIDBGetThenSet<T>(key: string, defaultValue: T): Promise<void> {
  try {
    const entry = await get<{ k: string; v: T }>('appData', key);
    if (entry?.v !== undefined) {
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem(key, JSON.stringify(entry.v)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/** 同步兼容 setItem（同步写 localStorage，后台写 IndexedDB） */
export function lsSetItem<T>(key: string, value: T): void {
  try {
    const raw = JSON.stringify(value);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, raw);
    }
    // 后台异步写入 IndexedDB（不阻塞 UI）
    void _asyncIDBWrite(key, value);
  } catch (e) {
    // localStorage 写失败时仍然尝试写 IndexedDB
    void _asyncIDBWrite(key, value);
  }
}

/** 同步兼容 removeItem */
export function lsRemoveItem(key: string): void {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  void _asyncIDBRemove(key);
}

/** 同步兼容 clear（慎用！） */
export function lsClear(): void {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.clear(); } catch { /* ignore */ }
  }
  void _asyncIDBClear();
}

// ── 后台异步 IDB 写入（不阻塞 UI）───────────────────────────────

let _writeQueue: { key: string; value: unknown }[] = [];
let _writePending = false;

async function _asyncIDBWrite(key: string, value: unknown): Promise<void> {
  _writeQueue.push({ key, value });
  if (_writePending) return;
  _writePending = true;

  const batch = _writeQueue.splice(0, 3);
  _writePending = false;

  for (const { key: k, value: v } of batch) {
    try {
      await put('appData', { k, v, updatedAt: Date.now() });
    } catch (e) {
      console.warn(`[storage] IndexedDB write failed for key "${k}":`, e);
    }
  }

  if (_writeQueue.length > 0) {
    setTimeout(() => { void _asyncIDBWrite('_trigger_', null); }, 0);
  }
}

async function _asyncIDBRemove(key: string): Promise<void> {
  try {
    await remove('appData', key);
  } catch (e) {
    console.warn(`[storage] IndexedDB remove failed for key "${key}":`, e);
  }
}

async function _asyncIDBClear(): Promise<void> {
  try {
    await clear('appData');
  } catch (e) {
    console.warn('[storage] IndexedDB clear failed:', e);
  }
}

/** 类型参数占位（实际不参与运行时） */
type T = unknown;

