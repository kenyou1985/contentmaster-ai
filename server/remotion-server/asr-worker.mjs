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
    // v8.2：触发模型预热！之前只引用了函数引用，没有实际调用，导致模型从未被加载
    // 首次请求到来时才触发 -> 首次请求用户等待时间 +20~60s
    const warmupFile = '/tmp/asr_warmup_' + process.pid + '.wav';
    try {
      const { writeFileSync } = await import('fs');
      // 写一个 0.5 秒静音 PCM WAV（16kHz mono）
      const buf = Buffer.alloc(44 + 8000);
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + 8000, 4);
      buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28);
      buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
      buf.write('data', 36); buf.writeUInt32LE(8000, 40);
      writeFileSync(warmupFile, buf);
      await transcribeAudio(warmupFile, 'zh');
      console.log('[asr-worker] 模型预热完成（仅静音测试，无实际推理）');
    } catch (e) {
      // 预热失败不影响 worker 启动，正式请求时仍会触发加载
      console.warn('[asr-worker] 预热失败:', e?.message);
    }
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