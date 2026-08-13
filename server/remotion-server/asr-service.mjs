/**
 * ContentMaster AI - 本地 WASM Whisper ASR 服务
 *
 * 使用 @huggingface/transformers (Xenova/whisper) 在 Node.js 中离线运行。
 * 零外部 API 费用，模型下载一次后完全离线。
 *
 * 模型：Xenova/whisper-base (~140MB)，中文推荐
 */

import { pipeline, env } from '@huggingface/transformers';

// ── 全局单例 ──────────────────────────────────────────────
let asrPipeline = null;
let modelLoadingPromise = null;

const WHISPER_MODEL = 'Xenova/whisper-base'; // 轻量模型，兼顾质量和速度

/**
 * 获取或初始化 ASR pipeline（懒加载 + 全局单例）
 */
export async function getPipeline() {
  if (asrPipeline) return asrPipeline;
  if (modelLoadingPromise) {
    await modelLoadingPromise;
    return asrPipeline;
  }

  modelLoadingPromise = (async () => {
    env.allowLocalModels = false;
    env.useBrowserCache = false;

    asrPipeline = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      device: 'cpu',
      progress_callback: (info) => {
        if (info.status === 'initiate' || info.status === 'loading') {
          console.log(`[ASR] 加载模型: ${Math.round(info.progress ?? 0)}%`);
        }
      },
    });
    console.log(`[ASR] ✓ 模型就绪: ${WHISPER_MODEL}`);
  })();

  await modelLoadingPromise;
  return asrPipeline;
}

/**
 * 标准化中文标点（与前端字幕切分规则保持一致）
 */
function normalizeChinesePunct(text) {
  return text
    .replace(/[!?;]/g, m => m === '!' ? '！' : m === '?' ? '？' : '；')
    .replace(/,/g, '，')
    .replace(/\./g, '。');
}

/**
 * 对音频文件运行本地 Whisper，返回词级时间戳。
 *
 * @param {string} audioPath - 音频文件路径（支持 mp3/wav/m4a/ogg）
 * @param {string} language - 语言代码，默认 'zh'
 * @returns {Promise<{ok, words, text, durationSec, language, error}>}
 */
export async function transcribeAudio(audioPath, language = 'zh') {
  try {
    const pipe = await getPipeline();

    const result = await pipe(audioPath, {
      language,
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    // 提取词级时间戳
    let words = [];
    if (result?.chunks && Array.isArray(result.chunks)) {
      for (const chunk of result.chunks) {
        if (chunk?.words && Array.isArray(chunk.words)) {
          // 词级结果
          for (const w of chunk.words) {
            const text = String(w.word ?? w.text ?? '').trim();
            if (!text) continue;
            const ts = w.timestamp;
            words.push({
              text,
              startMs: ts && ts[0] !== undefined ? Math.round(Number(ts[0]) * 1000) : 0,
              endMs:   ts && ts[1] !== undefined ? Math.round(Number(ts[1]) * 1000) : 0,
            });
          }
        } else if (chunk?.text && chunk?.timestamp) {
          // 句级结果
          const ts = chunk.timestamp;
          words.push({
            text: String(chunk.text).trim(),
            startMs: Math.round(Number(ts[0] ?? 0) * 1000),
            endMs:   Math.round(Number(ts[1] ?? 0) * 1000),
          });
        }
      }
    }

    // 回退：整体结果
    if (words.length === 0 && result?.text) {
      const text = normalizeChinesePunct(String(result.text));
      const dur = result.duration_sec ?? 0;
      words = [{ text, startMs: 0, endMs: Math.round(dur * 1000) }];
    }

    return {
      ok: true,
      words,
      text: normalizeChinesePunct(String(result?.text ?? '')),
      durationSec: Number(result?.duration_sec ?? 0),
      language: result?.language ?? language,
    };
  } catch (e) {
    console.error('[ASR] 失败:', e?.message ?? e);
    return {
      ok: false,
      words: [],
      text: '',
      durationSec: 0,
      language,
      error: e?.message ?? String(e),
    };
  }
}

/**
 * 批量处理多个音频（串行）
 */
export async function transcribeBatch(items, onProgress) {
  const results = {};
  for (let i = 0; i < items.length; i++) {
    const { id, audioPath, language = 'zh' } = items[i];
    onProgress?.(i, items.length, id);
    results[id] = await transcribeAudio(audioPath, language);
    onProgress?.(i + 1, items.length, id);
  }
  return results;
}
