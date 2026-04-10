/**
 * 一键配音：已完成任务的本地历史（localStorage）。
 * 从列表删除的任务会同步从历史移除，故「最近历史」仅含未删除的记录。
 */

const STORAGE_KEY = 'dubbing_voice_history_v1';
const MAX_ENTRIES = 200;

export interface DubbingHistoryRecord {
  id: string;
  displayName: string;
  createdAt: number;
  scriptPreview: string;
  audioUrl: string;
  speakText?: string;
  polishMs?: number;
  ttsMs?: number;
  totalMs?: number;
  englishWarn?: boolean;
}

function readRaw(): DubbingHistoryRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(list: DubbingHistoryRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch (e) {
    console.warn('[dubbingHistory] 写入失败', e);
  }
}

/** 按时间倒序（最新在前） */
export function loadDubbingHistory(): DubbingHistoryRecord[] {
  return readRaw().sort((a, b) => b.createdAt - a.createdAt);
}

/** 合成成功时写入或覆盖同 id */
export function saveDubbingHistoryRecord(rec: DubbingHistoryRecord): void {
  const list = readRaw().filter((x) => x.id !== rec.id);
  list.unshift(rec);
  writeRaw(list);
}

/** 从列表删除、批量删除、一键清空时调用，使历史与列表一致 */
export function removeDubbingHistoryIds(ids: string[]): void {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  writeRaw(readRaw().filter((x) => !drop.has(x.id)));
}
