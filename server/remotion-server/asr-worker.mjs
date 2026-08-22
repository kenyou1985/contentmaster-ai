#!/usr/bin/env node
/**
 * ASR worker thread：在 Node.js worker_threads 里跑 Whisper，避免阻塞主进程 event loop
 *
 * 主进程通过 parentPort 发送 { id, audioPath, language }，
 * worker 返回 { id, ok, words, text, durationSec, language, error }。
 *
 * 为何需要 worker：
 *  - @huggingface/transformers + WASM 后端做 CPU-bound 推理（几秒到几分钟）
 *  - 如果在主线程跑，整个 Express 服务卡死，/health 等所有请求 hang
 *  - 用 Worker 让 ASR 在独立线程跑，主线程继续处理其他请求
 *
 * 注意：
 *  - Worker 内有自己的 V8 实例和模块缓存，所以模型加载有开销
 *  - 多个并发 ASR 任务会触发多个 worker 实例各自加载模型（浪费内存）
 *  - 因此服务端用 WorkerPool / 复用单 Worker 的模式：单 Worker 串行处理 ASR 任务队列
 */
import { parentPort } from 'worker_threads';

if (!parentPort) {
  console.error('[asr-worker] must run as worker thread');
  process.exit(1);
}

// 懒加载 transcribeAudio（首次任务才加载模型）
let transcribeAudio = null;
let modelLoading = null;

async function ensureLoaded() {
  if (transcribeAudio) return transcribeAudio;
  if (modelLoading) {
    await modelLoading;
    return transcribeAudio;
  }
  modelLoading = (async () => {
    const mod = await import('./asr-service.mjs');
    transcribeAudio = mod.transcribeAudio;
    // 触发模型预热（首次会下载/缓存模型，耗时 10-30s）
    await transcribeAudio; // ensure import is evaluated
    return transcribeAudio;
  })();
  await modelLoading;
  return transcribeAudio;
}

parentPort.on('message', async (msg) => {
  const { id, audioPath, language } = msg;
  try {
    const fn = await ensureLoaded();
    const result = await fn(audioPath, language);
    parentPort.postMessage({ id, ...result });
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: e?.message || String(e),
      words: [],
      text: '',
      durationSec: 0,
      language,
    });
  }
});

// 通知主进程 worker 已就绪
parentPort.postMessage({ ready: true });