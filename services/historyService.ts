/**
 * 历史记录服务
 * 用于管理自动生成和改写工具的历史记录
 */

export interface HistoryRecord {
  content: string;
  timestamp: number;
  metadata?: {
    input?: string;
    topic?: string;
    [key: string]: any;
  };
}

const MAX_HISTORY_COUNT = 10;

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
  try {
    if (!content || !content.trim()) {
      return;
    }

    const storageKey = getHistoryKey(module, key);
    const historyStr = localStorage.getItem(storageKey);
    let history: HistoryRecord[] = [];

    if (historyStr) {
      try {
        history = JSON.parse(historyStr);
        if (!Array.isArray(history)) {
          history = [];
        }
      } catch {
        history = [];
      }
    }

    // 添加新记录到最前面
    history.unshift({
      content: content.trim(),
      timestamp: Date.now(),
      metadata: metadata || {},
    });

    // 只保留最近 MAX_HISTORY_COUNT 条
    if (history.length > MAX_HISTORY_COUNT) {
      history = history.slice(0, MAX_HISTORY_COUNT);
    }

    localStorage.setItem(storageKey, JSON.stringify(history));
    console.log(`[HistoryService] 保存历史记录: ${storageKey}, 记录数: ${history.length}`);
  } catch (error) {
    console.error('[HistoryService] 保存历史记录失败:', error);
  }
};

/**
 * 获取历史记录列表
 */
export const getHistory = (
  module: 'generator' | 'tools',
  key: string
): HistoryRecord[] => {
  try {
    const storageKey = getHistoryKey(module, key);
    const historyStr = localStorage.getItem(storageKey);

    if (!historyStr) {
      return [];
    }

    const history = JSON.parse(historyStr);
    if (!Array.isArray(history)) {
      return [];
    }

    // 按时间戳排序（最新的在前）
    return history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  } catch (error) {
    console.error('[HistoryService] 获取历史记录失败:', error);
    return [];
  }
};

/**
 * 删除历史记录
 */
export const deleteHistory = (
  module: 'generator' | 'tools',
  key: string,
  timestamp: number
): void => {
  try {
    const storageKey = getHistoryKey(module, key);
    const historyStr = localStorage.getItem(storageKey);

    if (!historyStr) {
      return;
    }

    const history = JSON.parse(historyStr);
    if (!Array.isArray(history)) {
      return;
    }

    const filtered = history.filter(record => record.timestamp !== timestamp);

    if (filtered.length === 0) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(filtered));
    }
  } catch (error) {
    console.error('[HistoryService] 删除历史记录失败:', error);
  }
};

/**
 * 清空指定键的所有历史记录
 */
export const clearHistory = (
  module: 'generator' | 'tools',
  key: string
): void => {
  try {
    const storageKey = getHistoryKey(module, key);
    localStorage.removeItem(storageKey);
    console.log(`[HistoryService] 清空历史记录: ${storageKey}`);
  } catch (error) {
    console.error('[HistoryService] 清空历史记录失败:', error);
  }
};
