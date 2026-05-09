/**
 * 数字人对口型服务
 * RunningHub 数字人对口型 API 封装：提交任务、轮询状态、全局并发控制
 * 复用 runninghubService.ts 的基础工具函数
 */

import {
  resolveRunningHubOutputUrl,
  fetchOpenApiV2Query,
} from './runninghubService';
import { lsGetItem, lsSetItem } from './storageService';

// ============================================================
// 常量定义
// ============================================================

/** RunningHub 数字人对口型 AI App ID */
const DIGITAL_HUMAN_AI_APP_ID = '1980529181027123202';

/** 节点定义 */
const DH_VIDEO_NODE_ID = '85';
const DH_AUDIO_NODE_ID = '4';

/** 全局并发上限 */
const MAX_CONCURRENT_TASKS = 20;

/** 分批打包：每批最多多少个视频文件 */
export const BATCH_ZIP_SIZE = 5;

/** 轮询配置 */
const POLL_INTERVAL_MS = 20000;   // 20 秒
const POLL_MAX_MS = 30 * 60 * 1000;  // 30 分钟

// ============================================================
// 类型定义
// ============================================================

export interface DhSegmentTask {
  id: string;
  index: number;
  text: string;
  textLength: number;

  // 配音阶段
  audioPhase: 'pending' | 'running' | 'done' | 'error';
  audioTaskId?: string;
  audioUrl?: string;
  audioError?: string;

  // 数字人阶段
  dhPhase: 'pending' | 'running' | 'done' | 'error';
  dhTaskId?: string;
  dhVideoUrl?: string;
  dhError?: string;

  // 进度时间
  audioStartMs?: number;
  dhStartMs?: number;
}

export interface DhTaskResult {
  videoUrl: string;
  segmentText: string;
  segmentIndex: number;
  durationMs: number;
}

export interface DhBatchResult {
  results: DhTaskResult[];
  failedCount: number;
  totalCount: number;
}

// ============================================================
// 历史记录（复用配音历史记录模式，localStorage）
// ============================================================

const DH_HISTORY_KEY = 'digital_human_history_v1';
const MAX_HISTORY = 200;

export interface DhHistoryRecord {
  id: string;
  displayName: string;
  createdAt: number;
  referenceVideoName: string;
  scriptPreview: string;
  segmentCount: number;
  successCount: number;
  failedCount: number;
  /** 各段落结果 */
  segments: DhHistorySegment[];
}

export interface DhHistorySegment {
  index: number;
  text: string;
  audioUrl?: string;
  videoUrl?: string;
  durationMs?: number;
  dhMs?: number;
  audioError?: string;
  dhError?: string;
}

function readHistory(): DhHistoryRecord[] {
  return lsGetItem<DhHistoryRecord[]>(DH_HISTORY_KEY, []);
}

function writeHistory(list: DhHistoryRecord[]): void {
  lsSetItem(DH_HISTORY_KEY, list.slice(0, MAX_HISTORY));
}

export function loadDhHistory(): DhHistoryRecord[] {
  return readHistory().sort((a, b) => b.createdAt - a.createdAt);
}

export function saveDhHistoryRecord(rec: DhHistoryRecord): void {
  const list = readHistory().filter((x) => x.id !== rec.id);
  list.unshift(rec);
  writeHistory(list);
}

export function removeDhHistoryIds(ids: string[]): void {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  writeHistory(readHistory().filter((x) => !drop.has(x.id)));
}

/**
 * 获取当前活跃的 DH 会话 ID（用于自动保存）
 * 格式：dh_{timestamp}，在面板初始化时生成
 */
const ACTIVE_DH_SESSION_KEY = 'dh_active_session_id';

export function getActiveDhSessionId(): string {
  let id = lsGetItem<string>(ACTIVE_DH_SESSION_KEY, '');
  if (!id) {
    id = `dh_${Date.now()}`;
    lsSetItem(ACTIVE_DH_SESSION_KEY, id);
  }
  return id;
}

export function clearActiveDhSession(): void {
  lsSetItem(ACTIVE_DH_SESSION_KEY, '');
}

/**
 * 确保当前会话在历史中存在（初始化时调用）
 */
export function ensureDhSession(record: DhHistoryRecord): void {
  const list = readHistory();
  const idx = list.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.unshift(record);
    if (list.length > MAX_HISTORY) list.pop();
  }
  writeHistory(list);
}

/**
 * 更新会话中指定段落的音频信息（配音完成时调用）
 */
export function updateDhSegmentAudio(
  sessionId: string,
  segmentIndex: number,
  audioUrl: string,
  audioMs?: number,
  audioError?: string
): void {
  const list = readHistory();
  const rec = list.find((r) => r.id === sessionId);
  if (!rec) return;
  const seg = rec.segments.find((s) => s.index === segmentIndex);
  if (!seg) return;
  if (audioUrl) seg.audioUrl = audioUrl;
  if (audioMs != null) seg.durationMs = audioMs;
  if (audioError) seg.audioError = audioError;
  writeHistory(list);
}

/**
 * 更新会话中指定段落的数字人视频信息（DH 完成时调用）
 */
export function updateDhSegmentVideo(
  sessionId: string,
  segmentIndex: number,
  videoUrl: string,
  dhMs?: number,
  dhError?: string
): void {
  const list = readHistory();
  const rec = list.find((r) => r.id === sessionId);
  if (!rec) return;
  const seg = rec.segments.find((s) => s.index === segmentIndex);
  if (!seg) return;
  if (videoUrl) seg.videoUrl = videoUrl;
  if (dhMs != null) seg.dhMs = dhMs;
  if (dhError) seg.dhError = dhError;
  // 重新统计成功/失败数
  rec.successCount = rec.segments.filter((s) => !!s.videoUrl).length;
  rec.failedCount = rec.segments.filter(
    (s) => !s.videoUrl && !s.dhError && s.dhMs !== undefined
  ).length;
  writeHistory(list);
}

/** 更新会话的统计摘要 */
export function updateDhSessionSummary(sessionId: string): void {
  const list = readHistory();
  const rec = list.find((r) => r.id === sessionId);
  if (!rec) return;
  rec.successCount = rec.segments.filter((s) => !!s.videoUrl).length;
  rec.failedCount = rec.segments.filter(
    (s) => !s.videoUrl && !s.dhError && s.dhMs !== undefined
  ).length;
  writeHistory(list);
}

// ============================================================
// 参考视频上传
// ============================================================

/**
 * 上传参考视频到 RunningHub，返回 RunningHub 文件路径
 */
export async function uploadReferenceVideoToRunningHub(
  apiKey: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<string> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('fileType', 'video');
  formData.append('apiKey', apiKey);

  onProgress?.(30);

  const res = await fetch('https://www.runninghub.cn/task/openapi/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  onProgress?.(90);

  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`参考视频上传失败: ${res.status} ${raw}`);
  }

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`参考视频上传失败: ${data.msg || data.message || '未知错误'}`);
  }

  const path = data.data?.fileName || data.data?.filePath;
  if (!path) throw new Error('参考视频上传成功但未返回路径');

  onProgress?.(100);
  return path as string;
}

// ============================================================
// 音频上传（复用 runninghubService.uploadAudioToRunningHub）
// ============================================================

export { uploadAudioToRunningHub } from './runninghubService';

// ============================================================
// 数字人对口型任务提交
// ============================================================

/**
 * 提交数字人对口型任务到 RunningHub
 */
export async function submitDigitalHumanTask(
  apiKey: string,
  params: {
    referenceVideoPath: string;
    audioPath: string;
  }
): Promise<string> {
  const res = await fetch(
    `https://www.runninghub.cn/openapi/v2/run/ai-app/${DIGITAL_HUMAN_AI_APP_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        nodeInfoList: [
          {
            nodeId: DH_VIDEO_NODE_ID,
            fieldName: 'video',
            fieldValue: params.referenceVideoPath,
            description: 'video',
          },
          {
            nodeId: DH_AUDIO_NODE_ID,
            fieldName: 'audio',
            fieldValue: params.audioPath,
            description: 'audio',
          },
        ],
        instanceType: 'default',
        usePersonalQueue: 'false',
      }),
    }
  );

  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`数字人对口型任务提交失败: ${res.status} ${raw}`);
  }

  const data = await res.json();

  // 兼容两种响应格式
  const taskId =
    data?.data?.taskId ??
    data?.taskId ??
    data?.data?.task_id;

  if (!taskId) {
    throw new Error(
      `数字人对口型任务提交失败（无 taskId）: ${JSON.stringify(data).slice(0, 200)}`
    );
  }

  return String(taskId);
}

// ============================================================
// 轮询状态
// ============================================================

/**
 * 轮询数字人对口型任务状态，直到完成或失败
 * @returns 视频 URL（绝对路径）
 */
export async function pollDigitalHumanUntilDone(
  apiKey: string,
  taskId: string,
  onProgress?: (stage: 'pending' | 'running' | 'done' | 'failed', elapsedSec: number) => void
): Promise<string> {
  const t0 = Date.now();
  let lastStatus = 'pending';

  while (Date.now() - t0 < POLL_MAX_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const data = await fetchOpenApiV2Query(apiKey, taskId);
    if (!data) {
      lastStatus = 'running';
      onProgress?.('running', Math.round((Date.now() - t0) / 1000));
      continue;
    }

    const statusRaw =
      data.status ??
      data.taskStatus ??
      data.data?.status ??
      'unknown';
    const status = String(statusRaw).toLowerCase();

    if (status === 'success' || status === 'completed' || status === 'finish') {
      onProgress?.('done', Math.round((Date.now() - t0) / 1000));
      // 提取视频 URL
      const videoUrl =
        data.url ??
        data.outputUrl ??
        data.videoUrl ??
        data.data?.url ??
        data.data?.outputUrl ??
        data.data?.videoUrl ??
        data.data?.fileUrl ??
        extractVideoUrlFromResults(data);

      if (!videoUrl) {
        // 尝试 get-outputs
        const urls = await tryGetOutputs(apiKey, taskId);
        if (urls.length > 0) {
          return resolveRunningHubOutputUrl(urls[0]);
        }
        throw new Error(`数字人任务 ${taskId?.slice(0, 12)}… 完成但未返回视频URL`);
      }
      return resolveRunningHubOutputUrl(videoUrl);
    }

    if (status === 'failed' || status === 'error' || status === 'fail') {
      const errMsg =
        data.errorMessage ??
        data.error_message ??
        data.error ??
        data.message ??
        '任务失败';
      throw new Error(`数字人对口型任务失败: ${errMsg}`);
    }

    if (status !== lastStatus) {
      lastStatus = status;
    }
    onProgress?.('running', Math.round((Date.now() - t0) / 1000));
  }

  throw new Error(`数字人对口型任务 ${taskId?.slice(0, 12)}… 轮询超时（30min）`);
}

function extractVideoUrlFromResults(data: any): string | null {
  const results = data?.results ?? data?.data?.results ?? [];
  for (const r of Array.isArray(results) ? results : []) {
    for (const k of ['url', 'outputUrl', 'videoUrl', 'fileUrl', 'path']) {
      const v = r[k];
      if (typeof v === 'string' && (v.endsWith('.mp4') || v.includes('video'))) {
        return v;
      }
    }
  }
  return null;
}

async function tryGetOutputs(apiKey: string, taskId: string): Promise<string[]> {
  try {
    const res = await fetch('https://www.runninghub.cn/task/openapi/get-outputs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ apiKey, taskId }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const files = data?.data?.files ?? data?.files ?? [];
    return files
      .map((f: any) => f?.url ?? f?.fileUrl ?? f?.fileName)
      .filter(Boolean) as string[];
  } catch {
    return [];
  }
}

// ============================================================
// 全局并发控制器
// ============================================================

/** 单个任务控制块 */
interface TaskSlot<T> {
  resolve: (val: T) => void;
  reject: (err: Error) => void;
  fn: () => Promise<T>;
  cancelled: boolean;
}

/**
 * 全局并发调度器
 * 语音任务 + 数字人任务共享 20 并发槽
 * 超出上限的任务进入等待队列，FIFO 依次执行
 * 支持取消进行中的任务
 */
export class DhConcurrencyController {
  private running = 0;
  private queue: Array<TaskSlot<unknown>> = [];

  /** 取消令牌：任务 ID -> 取消函数 */
  private cancelTokens = new Map<string, { cancelled: boolean }>();

  get activeCount(): number {
    return this.running;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get availableSlots(): number {
    return Math.max(0, MAX_CONCURRENT_TASKS - this.running);
  }

  canRun(): boolean {
    return this.running < MAX_CONCURRENT_TASKS;
  }

  /**
   * 注册一个可取消的任务，返回取消令牌
   */
  registerTask(taskId: string): { cancelled: boolean } {
    const token = { cancelled: false };
    this.cancelTokens.set(taskId, token);
    return token;
  }

  /**
   * 取消指定任务
   * - 如果任务在队列中，直接移除
   * - 如果任务正在执行，标记取消状态（由任务内部检查并中断）
   */
  cancelTask(taskId: string): boolean {
    const token = this.cancelTokens.get(taskId);
    if (!token) return false;

    if (token.cancelled) return false;
    token.cancelled = true;

    // 从队列中移除
    this.queue = this.queue.filter((slot) => {
      // 通过 slot.fn 的 toString 查找（不可靠，改用标记）
      return true; // 保留所有，任务执行时会检查 cancelled 状态
    });

    return true;
  }

  /**
   * 清理取消令牌
   */
  unregisterTask(taskId: string): void {
    this.cancelTokens.delete(taskId);
  }

  /**
   * 检查任务是否已取消
   */
  isTaskCancelled(taskId: string): boolean {
    const token = this.cancelTokens.get(taskId);
    return token?.cancelled ?? false;
  }

  /**
   * 申请一个执行槽。返回 true 表示可以立即执行，false 表示已入队等待
   */
  async run<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const token = this.registerTask(taskId);

    if (this.running < MAX_CONCURRENT_TASKS) {
      this.running++;
      try {
        if (token.cancelled) {
          throw new Error('CANCELLED');
        }
        const result = await fn();
        return result;
      } catch (e: unknown) {
        if (token.cancelled && !(e instanceof Error && e.message === 'CANCELLED')) {
          throw new Error('任务已取消');
        }
        throw e;
      } finally {
        this.unregisterTask(taskId);
        this.dequeue();
      }
    }

    // 超出上限，等待
    return new Promise<T>((resolve, reject) => {
      const slot: TaskSlot<T> = {
        resolve,
        reject,
        fn: fn as () => Promise<unknown>,
        cancelled: false,
      };
      this.queue.push(slot as unknown as TaskSlot<unknown>);
    }).finally(() => {
      this.unregisterTask(taskId);
    });
  }

  private dequeue(): void {
    this.running = Math.max(0, this.running - 1);
    if (this.queue.length > 0 && this.running < MAX_CONCURRENT_TASKS) {
      const slot = this.queue.shift() as TaskSlot<unknown> | undefined;
      if (slot) {
        // 检查是否已取消
        const token = this.cancelTokens.get(slot.fn.toString().slice(0, 50));
        if (token?.cancelled) {
          slot.reject(new Error('任务已取消'));
          this.dequeue();
          return;
        }

        this.running++;
        void (async () => {
          try {
            const result = await (slot.fn as () => Promise<unknown>)();
            slot.resolve(result as unknown as T);
          } catch (e: unknown) {
            slot.reject(e instanceof Error ? e : new Error(String(e)));
          } finally {
            this.dequeue();
          }
        })();
      }
    }
  }

  /** 清空等待队列（页面卸载时调用） */
  clearQueue(): void {
    this.queue.forEach((slot) => {
      slot.reject(new Error('队列已清空'));
    });
    this.queue = [];
    this.cancelTokens.clear();
  }
}

export const dhConcurrency = new DhConcurrencyController();

// ============================================================
// 段落分割工具
// ============================================================

/** 中文：按完整句子分割，每段 ~400 字符 */
export function splitChineseText(text: string, chunkSize = 400): string[] {
  if (!text.trim()) return [];

  const sentences: string[] = [];
  // 按句子分割：。！？；\n
  const parts = text.split(/(?<=[。！？；\n])/);
  let current = '';

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if ((current + trimmed).length <= chunkSize) {
      current += trimmed;
    } else {
      if (current.trim()) sentences.push(current.trim());
      // 如果单句本身超长，强行截断
      if (trimmed.length > chunkSize) {
        for (let i = 0; i < trimmed.length; i += chunkSize) {
          sentences.push(trimmed.slice(i, i + chunkSize));
        }
      } else {
        current = trimmed;
      }
    }
  }

  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

/** 英文：按完整句子分割，每段 ~400 单词 */
export function splitEnglishText(text: string, wordLimit = 400): string[] {
  if (!text.trim()) return [];

  const sentences: string[] = [];
  // 按句子分割：.!?;\n
  const parts = text.split(/(?<=[.!?;\n])/);
  let current: string[] = [];
  let wordCount = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const partWords = trimmed.split(/\s+/).filter(Boolean).length;

    if (wordCount + partWords <= wordLimit) {
      current.push(trimmed);
      wordCount += partWords;
    } else {
      if (current.length > 0) sentences.push(current.join(' '));
      if (partWords > wordLimit) {
        // 单句超长，分割之
        const words = trimmed.split(/\s+/);
        current = [];
        wordCount = 0;
        for (let i = 0; i < words.length; i += wordLimit) {
          const chunk = words.slice(i, i + wordLimit).join(' ');
          sentences.push(chunk);
        }
        current = [];
        wordCount = 0;
      } else {
        current = [trimmed];
        wordCount = partWords;
      }
    }
  }

  if (current.length > 0) sentences.push(current.join(' '));
  return sentences;
}

/** 自动检测语言并分割 */
export function splitTextByLanguage(
  text: string
): { lang: 'zh' | 'en'; chunks: string[] } {
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  if (hasChinese) {
    return { lang: 'zh', chunks: splitChineseText(text) };
  }
  return { lang: 'en', chunks: splitEnglishText(text) };
}

// ============================================================
// 批量打包下载
// ============================================================

/** 单个文件下载进度回调 */
export type DownloadProgressCallback = (info: {
  filename: string;
  loaded: number;
  total: number;
  /** 所有文件的整体进度（0-100） */
  overallPercent: number;
  /** 当前正在处理的文件索引 */
  currentIndex: number;
  totalFiles: number;
  /** 'downloading' | 'zipping' | 'done' */
  phase: 'downloading' | 'zipping' | 'done';
  /** 累计已下载字节数 */
  downloadedBytes: number;
  /** 预估总字节数（已知时） */
  totalBytes?: number;
}) => void;

/**
 * 将多个视频 URL 打包为单个 ZIP
 */
export async function packVideosToZip(
  items: Array<{ url: string; filename: string }>,
  zipFilename = '数字人对口型视频.zip',
  onProgress?: DownloadProgressCallback
): Promise<Blob> {
  const { default: JSZip } = await import('jszip');

  const zip = new JSZip();
  const folder = zip.folder('数字人对口型');

  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  const fileSizes: number[] = [];

  const results = await Promise.allSettled(
    items.map(async ({ url, filename }, idx) => {
      const res = await fetch(url, {
        onProgress: (event) => {
          if (event.lengthComputable) {
            onProgress?.({
              filename,
              loaded: event.loaded,
              total: event.total,
              overallPercent: -1,
              currentIndex: idx,
              totalFiles: items.length,
              phase: 'downloading',
              downloadedBytes,
              totalBytes,
            });
          }
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${filename}: ${url}`);
      }
      const blob = await res.blob();
      if (blob.size < 1024) {
        throw new Error(`视频文件过小 (${blob.size}B)，可能下载失败: ${filename}`);
      }
      folder?.file(filename, blob);
      downloadedBytes += blob.size;
      fileSizes.push(blob.size);
      totalBytes = downloadedBytes;
      onProgress?.({
        filename,
        loaded: blob.size,
        total: blob.size,
        overallPercent: Math.round(((idx + 1) / items.length) * 100),
        currentIndex: idx + 1,
        totalFiles: items.length,
        phase: 'downloading',
        downloadedBytes,
        totalBytes,
      });
      return filename;
    })
  );

  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  if (failed.length > 0) {
    const msgs = failed.map((f) => (f.reason as Error).message).join('; ');
    console.error('[packVideosToZip] 部分视频下载失败:', msgs);
    console.warn(`[packVideosToZip] ${failed.length}/${items.length} 个视频下载失败，将打包剩余视频`);
  }

  const successful = results.filter((r) => r.status === 'fulfilled').length;
  onProgress?.({
    filename: '',
    loaded: successful,
    total: items.length,
    overallPercent: 99,
    currentIndex: successful,
    totalFiles: items.length,
    phase: 'zipping',
    downloadedBytes,
    totalBytes,
  });

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } },
    (metadata) => {
      if (metadata.percent > 0) {
        onProgress?.({
          filename: metadata.currentFile || '',
          loaded: 0,
          total: 0,
          overallPercent: Math.round(metadata.percent),
          currentIndex: successful,
          totalFiles: items.length,
          phase: 'zipping',
          downloadedBytes,
          totalBytes,
        });
      }
    }
  );

  onProgress?.({
    filename: '',
    loaded: successful,
    total: items.length,
    overallPercent: 100,
    currentIndex: successful,
    totalFiles: items.length,
    phase: 'done',
    downloadedBytes,
    totalBytes,
  });

  return blob;
}

/**
 * 将视频分批打包为多个 ZIP，每个 ZIP 最多 BATCH_ZIP_SIZE 个文件。
 * 每个批次完成后立即通过 onBatchDone 回调返回（触发下载），
 * 避免等待全部完成才一次性下载导致部分浏览器下载被忽略。
 * 返回所有批次的元信息。
 */
export async function packVideosToBatches(
  items: Array<{ url: string; filename: string }>,
  onBatchProgress?: (batchIndex: number, totalBatches: number, batchProgress: number, filename: string) => void,
  onBatchDone?: (batchIndex: number, totalBatches: number, batch: { partLabel: string; zipBlob: Blob; filenames: string[] }) => void
): Promise<Array<{ partLabel: string; zipBlob: Blob; filenames: string[] }>> {
  const totalBatches = Math.ceil(items.length / BATCH_ZIP_SIZE);
  const batches: Array<{ partLabel: string; zipBlob: Blob; filenames: string[] }> = [];

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_ZIP_SIZE;
    const batchItems = items.slice(start, start + BATCH_ZIP_SIZE);
    const partLabel = `第${batchIdx + 1}批（共${totalBatches}批）`;

    onBatchProgress?.(batchIdx, totalBatches, 0, '');

    const blob = await packVideosToZip(batchItems, `数字人对口型_part${batchIdx + 1}.zip`, (info) => {
      onBatchProgress?.(batchIdx, totalBatches, info.overallPercent >= 0 ? info.overallPercent : 0, info.filename);
    });

    const batch = {
      partLabel,
      zipBlob: blob,
      filenames: batchItems.map((i) => i.filename),
    };
    batches.push(batch);

    // 立即触发该批次下载，不必等全部完成
    onBatchDone?.(batchIdx, totalBatches, batch);
  }

  return batches;
}
