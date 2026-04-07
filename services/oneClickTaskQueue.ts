/**
 * 一键成片挂机队列：本地持久化，避免误关页面丢失任务列表。
 * 单任务执行时仍会暂时将分镜切换为该任务快照（执行完恢复），请勿在执行中编辑当前分镜。
 */

const STORAGE_KEY = 'contentmaster_one_click_queue_v1';

export type OneClickExportMode = 'full' | 'image_audio';

/** 入队时冻结的一键成片相关设置（与 MediaGenerator 状态对齐） */
export interface OneClickTaskSnapshot {
  shots: unknown[];
  scriptText: string;
  selectedImageModel: string;
  selectedImageRatio: string;
  selectedStyle: string;
  selectedVideoModel: string;
  selectedVideoSize: string;
  selectedVideoDuration: number;
  selectedVideoOrientation: string;
  generateImageCount: number;
  jianyingOutputDir: string;
  jyRandomEffectBundle: boolean;
  jyRandomTransitions: boolean;
  jyRandomFilters: boolean;
  jimengApiUrl: string;
  jimengSessionId: string;
}

export type OneClickQueueTaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface OneClickQueueTask {
  id: string;
  /** 与剪映草稿名一致或同规则，便于列表识别 */
  draftName: string;
  /** 兼容旧数据；与 draftName 二选一展示 */
  label?: string;
  createdAt: number;
  updatedAt: number;
  exportMode: OneClickExportMode;
  /** 数值越大越优先（插队会增大） */
  priority: number;
  /** 'queue' = 挂机队列入队；'oneshot' = 界面一键成片直接完成 */
  type?: 'queue' | 'oneshot';
  paused: boolean;
  status: OneClickQueueTaskStatus;
  lastError?: string;
  progressNote?: string;
  /** 0–100，仅 running 时有意义；完成后应清除 */
  progressPercent?: number;
  snapshot: OneClickTaskSnapshot;
  /** 任务跑完后带媒体的分镜快照，用于「补导出剪映」 */
  resultSnapshot?: OneClickTaskSnapshot;
  /** 最后一次成功导出返回的目录/名称提示 */
  lastExportedDraftName?: string;
}

export interface OneClickQueuePersisted {
  tasks: OneClickQueueTask[];
  updatedAt: number;
}

function safeParse(raw: string | null): OneClickQueuePersisted | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as OneClickQueuePersisted;
    if (!v || !Array.isArray(v.tasks)) return null;
    return v;
  } catch {
    return null;
  }
}

function normalizeTask(t: OneClickQueueTask): OneClickQueueTask {
  const draftName =
    t.draftName ||
    t.label ||
    `ContentMaster_任务_${t.id.slice(0, 12)}`;
  const priority = typeof t.priority === 'number' ? t.priority : t.createdAt || 0;
  const progressPercent =
    typeof t.progressPercent === 'number' && !Number.isNaN(t.progressPercent)
      ? Math.max(0, Math.min(100, Math.round(t.progressPercent)))
      : undefined;
  const type: OneClickQueueTask['type'] =
    t.type ?? (String(t.id).startsWith('oc_') ? 'oneshot' : 'queue');
  return { ...t, draftName, priority, progressPercent, type };
}

export function loadOneClickQueue(): OneClickQueueTask[] {
  if (typeof localStorage === 'undefined') return [];
  const p = safeParse(localStorage.getItem(STORAGE_KEY));
  const raw = p?.tasks ?? [];
  return raw.map((x) => normalizeTask(x as OneClickQueueTask));
}

export function saveOneClickQueue(tasks: OneClickQueueTask[]): boolean {
  if (typeof localStorage === 'undefined') return false;
  const payload: OneClickQueuePersisted = {
    tasks,
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn('[oneClickTaskQueue] 保存队列失败（可能超出配额）', e);
    return false;
  }
}

export function newQueueTaskId(): string {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** 界面一键成片完成登记（与挂机 q_ 区分） */
export function newOneshotTaskId(): string {
  return `oc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function upsertQueueTask(tasks: OneClickQueueTask[], task: OneClickQueueTask): OneClickQueueTask[] {
  const i = tasks.findIndex((t) => t.id === task.id);
  const next = [...tasks];
  if (i >= 0) next[i] = { ...task, updatedAt: Date.now() };
  else next.push({ ...task, updatedAt: Date.now() });
  void saveOneClickQueue(next);
  return next;
}

export function removeQueueTask(tasks: OneClickQueueTask[], id: string): OneClickQueueTask[] {
  const next = tasks.filter((t) => t.id !== id);
  void saveOneClickQueue(next);
  return next;
}

export function replaceQueue(tasks: OneClickQueueTask[]): void {
  void saveOneClickQueue(tasks);
}
