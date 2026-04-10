/**
 * 历史记录服务
 * 用于管理自动生成和改写工具的历史记录
 * 底层存储：IndexedDB（storageService） + localStorage 兼容层
 */

import { lsGetItem, lsSetItem, lsRemoveItem } from './storageService';

export interface HistoryRecord {
  content: string;
  timestamp: number;
  metadata?: {
    input?: string;
    topic?: string;
    [key: string]: any;
  };
}

const MAX_HISTORY_COUNT = 15;

/**
 * 历史列表展示名：本地日期时间 + 三位随机数（例 202604071253-482），与媒体快照命名风格一致
 */
export function generateDatedRandomHistoryLabel(): string {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const n = Math.floor(Math.random() * 1000);
  return `${y}${mo}${day}${hh}${mm}-${String(n).padStart(3, '0')}`;
}

/**
 * 生成历史记录的存储键
 */
export const getHistoryKey = (module: 'generator' | 'tools', ...parts: string[]): string => {
  const key = parts.filter(Boolean).join('_').toLowerCase();
  return `history_${module}_${key}`;
};

/**
 * 保存历史记录
 */
export const saveHistory = (
  module: 'generator' | 'tools',
  key: string,
  content: string,
  metadata?: HistoryRecord['metadata']
): void => {
  if (!content || !content.trim()) {
    return;
  }

  const storageKey = getHistoryKey(module, key);
  const history = lsGetItem<HistoryRecord[]>(storageKey, []);

  // 检查是否已存在相同内容的记录（避免重复保存）
  const trimmedContent = content.trim();
  const existingIndex = history.findIndex(record =>
    record.content.trim() === trimmedContent &&
    record.metadata?.topic === metadata?.topic
  );

  // 如果已存在相同记录，不重复添加
  if (existingIndex !== -1) {
    return;
  }

  // 添加新记录到最前面
  history.unshift({
    content: trimmedContent,
    timestamp: Date.now(),
    metadata: metadata || {},
  });

  // 只保留最近 MAX_HISTORY_COUNT 条
  if (history.length > MAX_HISTORY_COUNT) {
    history.length = MAX_HISTORY_COUNT;
  }

  lsSetItem(storageKey, history);
};

/**
 * 获取历史记录列表
 */
export const getHistory = (
  module: 'generator' | 'tools',
  key: string
): HistoryRecord[] => {
  const history = lsGetItem<HistoryRecord[]>(getHistoryKey(module, key), []);
  const valid = (Array.isArray(history) ? history : []).filter(
    (item: any): item is HistoryRecord =>
      item != null && typeof item.content === 'string' && item.content.trim().length > 0
  );
  return valid.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
};

/**
 * 删除历史记录
 */
export const deleteHistory = (
  module: 'generator' | 'tools',
  key: string,
  timestamp: number
): void => {
  const history = lsGetItem<HistoryRecord[]>(getHistoryKey(module, key), []);
  const filtered = history.filter(record => record.timestamp !== timestamp);
  if (filtered.length === 0) {
    lsRemoveItem(getHistoryKey(module, key));
  } else {
    lsSetItem(getHistoryKey(module, key), filtered);
  }
};

/**
 * 清空指定键的所有历史记录
 */
export const clearHistory = (
  module: 'generator' | 'tools',
  key: string
): void => {
  lsRemoveItem(getHistoryKey(module, key));
};

/** 旧版 scriptHistory（非 history_tools_* 键） */
export const SCRIPT_HISTORY_LEGACY_KEY = 'scriptHistory';
export const LAST_GENERATED_SCRIPT_STORAGE_KEY = 'lastGeneratedScript';

/**
 * 列表中「最新生成的脚本」占位时间戳（该条目无独立存储时间，删除时按内容匹配 lastGeneratedScript）
 */
export const LAST_GENERATED_SCRIPT_TIMELINE_TS = 9_001_000_000_000;

export function deleteScriptHistoryLegacyItem(timestamp: number): void {
  const history = lsGetItem<any[]>(SCRIPT_HISTORY_LEGACY_KEY, []);
  const filtered = history.filter((item: any) => Number(item?.timestamp) !== Number(timestamp));
  if (filtered.length === 0) lsRemoveItem(SCRIPT_HISTORY_LEGACY_KEY);
  else lsSetItem(SCRIPT_HISTORY_LEGACY_KEY, filtered);
}

export function clearScriptHistoryLegacy(): void {
  lsRemoveItem(SCRIPT_HISTORY_LEGACY_KEY);
}

export function removeLastGeneratedScriptIfContentEquals(content: string): void {
  const saved = lsGetItem<string | null>(LAST_GENERATED_SCRIPT_STORAGE_KEY, null);
  if (saved != null && saved.trim() === String(content).trim()) {
    lsRemoveItem(LAST_GENERATED_SCRIPT_STORAGE_KEY);
  }
}

export function clearLastGeneratedScript(): void {
  lsRemoveItem(LAST_GENERATED_SCRIPT_STORAGE_KEY);
}
