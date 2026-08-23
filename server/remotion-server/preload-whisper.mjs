#!/usr/bin/env node
/**
 * 构建时预下载 Whisper 模型到镜像（构建层缓存 = 持久化）
 *
 * 触发场景：Railway 容器重启后 /tmp/.huggingface 缓存被清空，
 * 运行时首次请求会触发模型下载 → "Unable to determine content-length"
 * + 超时 + 偶发的 "Unsupported model type" 等不稳定状态。
 *
 * 通过在 docker build 阶段下载模型到镜像层，重启后不需要重新下载。
 *
 * 注意：使用 AutoModelForSpeechSeq2Seq 直接装配而不是 pipeline()，
 * 绕开 transformers 内部 [AutoModelForSpeechSeq2Seq, AutoModelForCTC]
 * fallback 链（该链的 CTC 步骤会抛 "Unsupported model type: whisper"）。
 */

import {
  AutoModelForSpeechSeq2Seq,
  AutoTokenizer,
  AutomaticSpeechRecognitionPipeline,
  env,
} from '@huggingface/transformers';

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'Xenova/whisper-base';

async function main() {
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;

  console.log(`[build] 开始预下载 whisper 模型: ${WHISPER_MODEL}`);
  const start = Date.now();

  let lastFile = '';
  let lastPct = 0;

  const progressCallback = (info) => {
    if (info.status === 'download' || info.status === 'loading') {
      const f = info.file || info.name || '';
      const p = Math.round(info.progress ?? 0);
      if (f !== lastFile || p !== lastPct) {
        process.stdout.write(`\r[build] 下载 ${f}: ${p}%`);
        lastFile = f;
        lastPct = p;
      }
    }
  };

  const model = await AutoModelForSpeechSeq2Seq.from_pretrained(WHISPER_MODEL, {
    device: 'cpu',
    dtype: 'fp32',
    quantized: false,
    progress_callback: progressCallback,
  });

  const tokenizer = await AutoTokenizer.from_pretrained(WHISPER_MODEL, {
    quantized: false,
    progress_callback: progressCallback,
  });

  // 实例化 pipeline 确认整套装配无问题（不预热推理）
  // eslint-disable-next-line no-unused-vars
  const pipe = new AutomaticSpeechRecognitionPipeline({
    model,
    tokenizer,
  });

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n[build] ✓ whisper 模型预热完成: ${WHISPER_MODEL}（${elapsed}s）`);
}

main().catch((e) => {
  console.error('[build] ✗ 预下载失败（不阻断构建，运行时仍会按需下载）:', e?.message);
  process.exit(0); // 不阻断 docker build
});
