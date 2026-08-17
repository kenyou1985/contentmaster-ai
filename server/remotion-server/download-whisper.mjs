#!/usr/bin/env node
/**
 * ContentMaster AI - Whisper 模型预下载脚本
 *
 * 用途：在启动 Remotion 服务前，单独下载 Whisper 模型到本地缓存
 * 避免服务收到 ASR 请求时才下载导致请求超时。
 *
 * 用法：
 *   node server/remotion-server/download-whisper.mjs
 */

import { pipeline, env } from '@huggingface/transformers';

const WHISPER_MODEL = 'Xenova/whisper-base';

console.log(`[whisper] 准备下载模型: ${WHISPER_MODEL}`);
console.log(`[whisper] 缓存目录: ${env.cacheDir}`);
console.log(`[whisper] 通常 140MB 左右，请耐心等待…\n`);

const startTime = Date.now();

try {
  const pipe = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
    device: 'cpu',
    progress_callback: (info) => {
      const phase = info.status;
      const file = info.file || info.name || '';
      const progress = info.progress ? `${Math.round(info.progress)}%` : '';
      if (file) {
        console.log(`[whisper] ${phase.padEnd(10)} ${file} ${progress}`);
      } else {
        console.log(`[whisper] ${phase.padEnd(10)} ${progress}`);
      }
    },
  });

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[whisper] ✓ 模型就绪: ${WHISPER_MODEL}`);
  console.log(`[whisper] 耗时: ${elapsed}s`);
  console.log(`[whisper] 缓存路径: ${env.cacheDir}`);
  process.exit(0);
} catch (e) {
  console.error(`[whisper] ✗ 失败:`, e?.message || e);
  console.error('[whisper] 将在运行时按需懒加载（可能更慢）');
  process.exit(0); // 不阻断服务启动
}
