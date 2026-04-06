/**
 * RunningHub 配音 / 视频任务全局并发槽：批量配音 + 批量视频 + 单点操作共享，避免同时超过 API 承载。
 */
const MAX_CONCURRENT = 3;

const waitQueue: (() => void)[] = [];
let activeCount = 0;

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
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

/** 同一时刻最多 3 个 RunningHub 相关任务在执行（提交 + 轮询整段占槽） */
export async function withRunningHubSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

export const RUNNINGHUB_MAX_CONCURRENT_TASKS = MAX_CONCURRENT;
