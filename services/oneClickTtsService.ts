/**
 * 一键配音页：与一键成片镜头配音共用 RunningHub TTS + 可选云雾 gpt-5.4-mini 口播优化
 *
 * 音频后处理说明（修复破音/电流声）：
 * RunningHub TTS 输出的原始音频末尾可能存在：
 *   1. 突然截断 → 振幅从满幅直降至零 → 数字削波（clipping）→ 破音
 *   2. 模型尾部伪影 → 高频噪声/电流声
 *   3. 过长的静音尾部
 * 处理策略：
 *   - 淡出（Fade-out）：在音频末尾 300ms 内平滑地将振幅降至零，防止削波
 *   - 尾部静音裁剪：将末尾连续的静音部分（< -50dB）移除，精简长度
 */

import {
  generateAudioWithRetry,
  TTS_AUTO_RETRY_COUNT,
  uploadAudioToRunningHub,
  resolveRunningHubOutputUrl,
} from './runninghubService';
import { polishTextForTtsSpeech, polishTextForTtsSpeechWithStyle } from './yunwuService';
import { getSelectedVoice, updateVoice } from './voiceLibraryService';

// ============================================================
// 音频后处理参数
// ============================================================

/** 淡出时长（毫秒），覆盖末尾这段时间的振幅 */
const FADE_OUT_MS = 300;
/** 静音检测阈值（dB），低于此值的样本视为静音 */
const SILENCE_THRESHOLD_DB = -50;

// ============================================================
// 音频后处理核心
// ============================================================

/**
 * 对 TTS 音频进行客户端后处理：
 *   1. Web Audio API 解码原始音频
 *   2. 末尾淡出（Fade-out）—— 平滑振幅降至零，防止削波破音
 *   3. 尾部静音裁剪 —— 移除过长的静音尾部
 *
 * @param remoteUrl 原始音频 URL（可以是 http(s):// 或 data: URL）
 * @returns 处理后的 Blob URL（audio/wav），可直接用于播放/下载/上传
 */
async function processAudioWithFadeOut(remoteUrl: string): Promise<string> {
  const audioCtx = new AudioContext();

  let arrayBuffer: ArrayBuffer;
  try {
    const res = await fetch(remoteUrl);
    if (!res.ok) throw new Error(`音频下载失败: ${res.status}`);
    arrayBuffer = await res.arrayBuffer();
  } catch (err) {
    audioCtx.close();
    throw err instanceof Error ? err : new Error(String(err));
  }

  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (err) {
    await audioCtx.close();
    throw new Error(`音频解码失败（TTS 返回格式可能异常）: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sr = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const totalFrames = audioBuffer.length;

  // 步骤 1：计算末尾有效内容帧（从后向前找第一个超过静音阈值的点）
  const linearThreshold = Math.pow(10, SILENCE_THRESHOLD_DB / 20); // 线性振幅阈值
  let lastActiveFrame = totalFrames - 1;
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = totalFrames - 1; i >= 0; i--) {
      if (Math.abs(data[i]) > linearThreshold) {
        if (i > lastActiveFrame) lastActiveFrame = i;
        break;
      }
    }
  }

  // 步骤 2：计算淡出起始帧（取末尾 300ms 或有效内容末尾）
  const fadeOutFrames = Math.min(
    Math.round((FADE_OUT_MS / 1000) * sr),
    Math.floor(lastActiveFrame * 0.05), // 至多占音频总长的 5%，避免短音频被过度淡出
    lastActiveFrame
  );
  const fadeStartFrame = Math.max(0, lastActiveFrame - fadeOutFrames + 1);

  // 步骤 3：生成淡出曲线（二次方衰减，自然听感）
  const fadeCurve = new Float32Array(fadeOutFrames);
  for (let i = 0; i < fadeOutFrames; i++) {
    const t = i / (fadeOutFrames - 1 || 1); // 归一化 0→1
    fadeCurve[i] = Math.pow(1 - t, 2);
  }

  // 步骤 4：创建目标 buffer 并应用淡出
  const renderedBuffer = audioCtx.createBuffer(
    numChannels,
    lastActiveFrame + 1,
    sr
  );

  for (let ch = 0; ch < numChannels; ch++) {
    const srcData = audioBuffer.getChannelData(ch);
    const dstData = renderedBuffer.getChannelData(ch);
    for (let i = 0; i <= lastActiveFrame; i++) {
      dstData[i] = srcData[i];
    }
    // 应用淡出曲线
    for (let i = 0; i < fadeOutFrames; i++) {
      const frameIdx = fadeStartFrame + i;
      if (frameIdx < dstData.length) {
        dstData[frameIdx] *= fadeCurve[i];
      }
    }
  }

  // 步骤 5：编码为 WAV（PCM 16-bit）
  const wavBlob = encodeWavPcm16(renderedBuffer);

  // 释放 AudioContext
  await audioCtx.close();

  return URL.createObjectURL(wavBlob);
}

/**
 * 将 AudioBuffer 编码为 WAV（PCM 16-bit little-endian）
 */
function encodeWavPcm16(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = numFrames * numChannels * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeStr(8, 'WAVE');

  // fmt chunk
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);           // chunk size
  view.setUint16(20, 1, true);             // PCM format
  view.setUint16(22, numChannels, true);   // channels
  view.setUint32(24, sr, true);            // sample rate
  view.setUint32(28, sr * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true);     // block align
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample

  // data chunk
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([buf], { type: 'audio/wav' });
}

function isTextPrimarilyEnglish(text: string): boolean {
  if (!text || !text.trim()) return false;
  const latinChars = (text.match(/[A-Za-z]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  return totalChars > 0 && latinChars / totalChars > 0.3;
}

export type OneClickTtsProgressStage = 'polish' | 'tts';

export interface OneClickTtsOptions {
  yunwuApiKey?: string;
  skipLlmPolish?: boolean;
  trackPersona?: string;
  customHint?: string;
  speed?: number;
  emphasisStrength?: number;
  pitch?: number;
  /** 口播优化开始 / 进入 TTS 合成前回调，便于 UI 展示阶段与耗时 */
  onProgress?: (stage: OneClickTtsProgressStage) => void;
  /** 全流程日志（终端 UI），并行任务请在外部加任务名前缀 */
  onLog?: (message: string) => void;
}

/** @returns 可播放的绝对音频 URL */
export async function runOneClickTts(
  runningHubApiKey: string,
  rawText: string,
  opts?: OneClickTtsOptions
): Promise<{ audioUrl: string; speakText: string; englishWarn: boolean }> {
  const log = (msg: string) => {
    opts?.onLog?.(msg);
  };

  const textIn = rawText.trim();
  if (!textIn) throw new Error('正文为空');
  const rh = runningHubApiKey.trim();
  if (!rh) throw new Error('请先配置 RunningHub API Key');

  log(`接收口播正文 ${textIn.length} 字 · RunningHub 已连接`);

  const yunwu = opts?.yunwuApiKey?.trim();
  let text = textIn;
  const willPolish = !opts?.skipLlmPolish && !!yunwu;

  if (!willPolish) {
    if (opts?.skipLlmPolish) {
      log('跳过口播润色：已勾选「跳过口播优化」');
    } else if (!yunwu) {
      log('跳过口播润色：未配置云雾 API Key');
    }
  }

  if (willPolish) {
    opts?.onProgress?.('polish');
    const hasStyle = !!(opts?.trackPersona?.trim() || opts?.customHint?.trim());
    log(
      hasStyle
        ? '口播润色：云雾 gpt-5.4-mini（赛道人设 + 自定义补充）…'
        : '口播润色：云雾 gpt-5.4-mini（默认朗读友好化）…'
    );
    if (opts?.trackPersona?.trim() || opts?.customHint?.trim()) {
      text = await polishTextForTtsSpeechWithStyle(yunwu, text, {
        trackPersona: opts?.trackPersona,
        customHint: opts?.customHint,
      });
    } else {
      text = await polishTextForTtsSpeech(yunwu, text);
    }
  }

  const speakText = text.trim();
  if (!speakText) throw new Error('优化后无可朗读正文');

  if (willPolish) {
    const preview =
      speakText.length > 120 ? `${speakText.slice(0, 120)}…` : speakText;
    log(`润色完成 → ${speakText.length} 字 · 预览：${preview.replace(/\s+/g, ' ')}`);
  }

  opts?.onProgress?.('tts');
  log('进入 TTS：准备参考音色与合成参数…');

  const selected = getSelectedVoice();
  const usingDefaultRef = !selected?.runningHubAudioPath?.trim() && !selected?.audioDataUrl?.trim();
  const englishWarn = usingDefaultRef && isTextPrimarilyEnglish(speakText);

  if (selected?.name) {
    log(`参考音色：${selected.name}`);
  } else {
    log('参考音色：未在语音库选择 · 将用系统默认参考音');
  }

  let refPath: string | undefined = selected?.runningHubAudioPath?.trim();
  if (selected && !refPath && selected.audioDataUrl?.trim()) {
    log('本地上传参考音 → 正在上传至 RunningHub …');
    refPath = await uploadAudioToRunningHub(rh, selected.audioDataUrl);
    updateVoice(selected.id, { runningHubAudioPath: refPath });
    const short = refPath.length > 64 ? `${refPath.slice(0, 64)}…` : refPath;
    log(`参考音路径已登记：${short}`);
  } else if (refPath) {
    const short = refPath.length > 64 ? `${refPath.slice(0, 64)}…` : refPath;
    log(`使用语音库已绑定的参考音：${short}`);
  }

  const sp = opts?.speed ?? 1;
  const em = opts?.emphasisStrength ?? 0.5;
  const pi = opts?.pitch ?? 0;
  log(
    `请求 RunningHub TTS · 语速 ${sp.toFixed(2)} · 轻重读 ${em.toFixed(2)} · 音高 ${pi.toFixed(2)} · 韵律增强 / 呼吸 / 停顿（失败时最多自动重试 ${TTS_AUTO_RETRY_COUNT} 次）`
  );

  const r = await generateAudioWithRetry(
    rh,
    {
      text: speakText,
      referenceAudioPath: refPath,
      speed: sp,
      prosodyEnhance: true,
      breath: true,
      autoPause: true,
      pauseStrength: 0.7,
      emphasisStrength: em,
      pitch: pi,
      volume: 1,
    },
    {
      onRetry: ({ attemptNumber, maxAttempts, error, delayMs }) => {
        log(
          `TTS 失败：${error}${error.length >= 160 ? '…' : ''} · 自动重试第 ${attemptNumber}/${maxAttempts} 次（${delayMs}ms 后）`
        );
      },
    }
  );

  if (!r.success) throw new Error(r.error || 'TTS 请求失败');
  const url = r.url;
  if (!url) throw new Error('未获取到音频地址');
  const rawAudioUrl = resolveRunningHubOutputUrl(url);
  const urlShort = rawAudioUrl.length > 96 ? `${rawAudioUrl.slice(0, 96)}…` : rawAudioUrl;
  log(`TTS 成功 · 原始输出 URL：${urlShort}`);

  // 音频后处理：淡出 + 尾部静音裁剪（修复破音/电流声）
  let audioUrl = rawAudioUrl;
  try {
    log('音频后处理：淡出（300ms）+ 尾部静音裁剪…');
    audioUrl = await processAudioWithFadeOut(rawAudioUrl);
    log('音频后处理完成');
  } catch (err) {
    // 后处理失败时降级为原始 URL，保证流程不中断
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`音频后处理失败（降级为原始音频）: ${errMsg}`);
    audioUrl = rawAudioUrl;
  }

  if (englishWarn) {
    log('提示：正文偏英文且使用默认中文参考音，听感可能不符');
  }
  log('── 本任务流程结束 ──');

  return {
    audioUrl,
    speakText,
    englishWarn,
  };
}
