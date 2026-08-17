/**
 * ContentMaster AI - 本地 Whisper ASR 服务
 *
 * 使用 @huggingface/transformers (Xenova/whisper) 在 Node.js 中离线运行。
 * 零外部 API 费用，模型下载一次后完全离线。
 *
 * 音频解码（纯 Node.js WASM，无 native binary）：
 *  - mp3     → mpg123-decoder (WASM)
 *  - wav     → wavefile 直接转 16kHz mono Float32Array
 *  - 其他格式 → 暂不支持（提示用户转 mp3）
 *
 * 模型：Xenova/whisper-base (~140MB)，中文推荐
 */

import { pipeline, env } from '@huggingface/transformers';
import { readFileSync } from 'fs';
import wavefilePkg from 'wavefile';
import { MPEGDecoder } from 'mpg123-decoder';
const { WaveFile } = wavefilePkg;

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
 * 把任意支持的音频（mp3/wav）转 16kHz mono Float32Array
 * - mp3 → mpg123-decoder (WASM)
 * - wav → wavefile
 * 输出 Float32Array，元素范围 -1..1
 */
async function decodeAudioToFloat32Mono16k(audioPath) {
  const ext = (audioPath.split('.').pop() || '').toLowerCase();

  let samples;     // Int16Array / Float32Array
  let sampleRate;  // number
  let numChannels; // number

  if (ext === 'wav') {
    const buf = readFileSync(audioPath);
    const wav = new WaveFile(buf);
    wav.toBitDepth('32f');
    sampleRate = wav.fmt.sampleRate;
    numChannels = wav.fmt.numChannels;
    let audioData = wav.getSamples();
    if (Array.isArray(audioData)) {
      samples = audioData[0];
      if (numChannels > 1) {
        const SCALING = Math.sqrt(2);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = (SCALING * (audioData[0][i] + audioData[1][i])) / 2;
        }
      }
    } else {
      samples = audioData;
      numChannels = 1;
    }
  } else if (ext === 'mp3' || ext === 'mpeg') {
    const buf = readFileSync(audioPath);
    const decoder = new MPEGDecoder();
    await decoder.ready;
    const data = decoder.decode(new Uint8Array(buf));
    // data.channelData: Float32Array[]（每个声道一个数组，已归一化 -1..1）
    // data.sampleRate
    sampleRate = data.sampleRate;
    if (data.channelData && data.channelData.length > 0) {
      if (data.channelData.length === 1) {
        samples = data.channelData[0];
      } else {
        // 立体声 → 平均（不除以 N，按 sqrt(2) 缩放保持能量）
        const ch0 = data.channelData[0];
        const ch1 = data.channelData[1];
        const merged = new Float32Array(ch0.length);
        const SCALING = Math.sqrt(2);
        for (let i = 0; i < ch0.length; i++) {
          merged[i] = (SCALING * (ch0[i] + ch1[i])) / 2;
        }
        samples = merged;
      }
      numChannels = 1;
    } else {
      throw new Error('mp3 decoder 未返回 channelData');
    }
  } else {
    throw new Error(`不支持的音频格式: .${ext}（仅支持 mp3 / wav）`);
  }

  // 重采样到 16kHz（线性插值，简单够用）
  if (sampleRate !== 16000) {
    const targetLen = Math.round(samples.length * 16000 / sampleRate);
    const out = new Float32Array(targetLen);
    for (let i = 0; i < targetLen; i++) {
      const srcIdx = (i * sampleRate) / 16000;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      const frac = srcIdx - i0;
      out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    samples = out;
  }

  return samples;
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

    // 1) 解码音频到 Float32Array（16kHz mono）
    const audioData = await decodeAudioToFloat32Mono16k(audioPath);
    const durationSec = audioData.length / 16000;
    console.log(`[ASR] 音频解码完成: ${audioData.length} samples (${durationSec.toFixed(1)}s)`);

    // 2) 传 Float32Array 给 pipeline（避免 AudioContext）
    const result = await pipe(audioData, {
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
      durationSec: durationSec,
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
