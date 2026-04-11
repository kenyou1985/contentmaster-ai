/**
 * RunningHub 配音 / 视频任务全局并发槽：批量配音 + 批量视频 + 单点操作共享，避免同时超过 API 承载。
 * 并发数可由用户在 UI 中配置（默认 1，最大 20）。
 */

const DEFAULT_CONCURRENT = 1;
const MAX_CONCURRENT = 20;

let maxConcurrent = DEFAULT_CONCURRENT;

const waitQueue: (() => void)[] = [];
let activeCount = 0;

function acquireSlot(): Promise<void> {
  if (activeCount < maxConcurrent) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(() => {
      resolve();
    });
  });
}

function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    next();
  } else {
    activeCount--;
  }
}

/** 同一时刻最多 N 个 RunningHub 相关任务在执行（提交 + 轮询整段占槽） */
export async function withRunningHubSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

/** 获取当前并发数上限 */
export function getRunningHubMaxConcurrent(): number {
  return maxConcurrent;
}

/** 设置并发数上限（范围 1-20） */
export function setRunningHubMaxConcurrent(n: number): void {
  maxConcurrent = Math.max(1, Math.min(MAX_CONCURRENT, Math.floor(n)));
  // 持久化到 localStorage
  try {
    localStorage.setItem('RUNNINGHUB_MAX_CONCURRENT', String(maxConcurrent));
  } catch {}
}

/** 从 localStorage 恢复并发数设置 */
export function initRunningHubConcurrency(): void {
  try {
    const stored = localStorage.getItem('RUNNINGHUB_MAX_CONCURRENT');
    if (stored) {
      const n = parseInt(stored, 10);
      if (!isNaN(n) && n >= 1 && n <= MAX_CONCURRENT) {
        maxConcurrent = n;
      }
    }
  } catch {}
}

export { MAX_CONCURRENT, DEFAULT_CONCURRENT };
