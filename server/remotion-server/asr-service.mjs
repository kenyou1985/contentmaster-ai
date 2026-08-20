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

// HF Transformers 环境配置：
// - cacheDir: 模型缓存目录（默认在 node_modules/@huggingface/transformers/.cache/）
// - allowRemoteModels: 当本地缓存命中时不需要联网；离线场景可以设为 false 避免偶发 fetch failed
// - allowLocalModels: 必须为 true 才能加载本地缓存
env.allowLocalModels = true;
// 不要完全禁止 remote：若用户改用更大模型（如 whisper-small/medium），仍需联网下载一次
// env.allowRemoteModels = true;

// ── 全局单例 ──────────────────────────────────────────────
let asrPipeline = null;
let modelLoadingPromise = null;

/**
 * Whisper 模型选择：
 * - whisper-base (~140MB): 速度快，质量一般，适合快速测试
 * - whisper-small (~244MB): 速度与质量平衡，中文较好
 * - whisper-medium (~768MB): 质量高，中文识别更准确
 * - whisper-large-v3 (~1.5GB): 最高质量，中文人名、专业术语识别最准
 *
 * 推荐：production 环境使用 whisper-large-v3 以获得最佳识别效果
 */
// 使用本地已缓存的 whisper-base（避免离线/网络限制）
// 备选模型（需联网下载）：whisper-small / whisper-medium / whisper-large-v3
const WHISPER_MODEL = 'Xenova/whisper-base';

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
    // 关键：必须 allowLocalModels=true，否则会触发网络请求下载模型
    env.allowLocalModels = true;
    env.allowRemoteModels = true; // 允许从 HF Hub 下载缺失的模型文件（如 quantized）
    env.useBrowserCache = false;
    // 不强制量化 dtype：whisper-base 本地缓存里只有 fp32 的 .onnx 文件
    // 如果硬要 q8，会触发 fetch failed（需要联网下载 quantized 变体）
    // 质量/速度优先：fp32 + whisper-base 本地缓存可用，零网络依赖

    asrPipeline = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      device: 'cpu',
      // dtype 留空：使用模型仓库里实际存在的 .onnx 文件（默认 fp32）
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
 * 检测音频文件真实格式（通过魔数）
 * 支持：WAV (RIFF), MP3 (ID3/MPEG), OGG, FLAC
 * 返回扩展名字符串（wav|mp3|ogg|flac），未知则回退 'bin'
 */
function detectAudioFormat(audioPath) {
  const buf = readFileSync(audioPath);
  if (buf.length < 4) return 'bin';

  // WAV: "RIFF" + ... + "WAVE"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    if (buf.length >= 12 &&
        buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) {
      return 'wav';
    }
  }

  // MP3: "ID3" (v2.x) 或 0xFF 0xFB/0xF3/0xE3 (MPEG sync)
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return 'mp3';
  }
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) {
    return 'mp3';
  }

  // OGG: "OggS"
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return 'ogg';
  }

  // FLAC: "fLaC"
  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) {
    return 'flac';
  }

  return 'bin';
}

/**
 * 把任意支持的音频（mp3/wav）转 16kHz mono Float32Array
 * - mp3 → mpg123-decoder (WASM)
 * - wav → wavefile
 * 输出 Float32Array，元素范围 -1..1
 */
async function decodeAudioToFloat32Mono16k(audioPath) {
  // 通过文件魔数检测真实格式，不依赖扩展名
  const ext = detectAudioFormat(audioPath);
  console.log(`[ASR] 音频格式检测: ${audioPath} → .${ext}`);

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
    // 确保 samples 是 Float32Array
    if (Array.isArray(audioData)) {
      samples = audioData[0];
      if (numChannels > 1 && audioData[1]) {
        const SCALING = Math.sqrt(2);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = (SCALING * (audioData[0][i] + audioData[1][i])) / 2;
        }
      }
    } else {
      samples = audioData;
      numChannels = 1;
    }
    // 验证 samples 有效性
    if (!samples || samples.length === 0) {
      throw new Error(`WAV 解码失败：音频样本为空（sampleRate=${sampleRate}, channels=${numChannels}）`);
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
    const hint = (ext === 'ogg' || ext === 'flac')
      ? '（请将音频转为 mp3 或 wav 格式）'
      : '（目前仅支持 mp3 / wav）';
    throw new Error(`不支持的音频格式: .${ext}${hint}`);
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
