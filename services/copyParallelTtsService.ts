/**
 * 文案成片模块 · 5 段并行 TTS 配音
 *
 * 核心优化：
 * - 输入：用户原始文案（任意长度）
 * - 自动切分：按句号/问号/感叹号/段落边界切分为 N 段（默认 5 段）
 * - 并行执行：5 段独立 RunningHub TTS 同时调 API，达到 5 倍并行提速
 * - 自动排队：复用 runningHubConcurrency 全局槽（默认 5 并发）
 * - 音频合并：每段分配完成后，前端 Web Audio API 拼接为单个 WAV
 */

import {
  generateAudioWithRetry,
  type RunningHubAudioOptions,
  type RunningHubResult,
} from './runninghubService';
import { withRunningHubSlot } from './runningHubConcurrency';
import { polishTextForTtsSpeech } from './yunwuService';

export interface ParallelTtsProgress {
  /** 0-N 共 N+1 步（含合并） */
  current: number;
  total: number;
  /** 当前步骤名 */
  stage: string;
  /** 已经完成的段数 */
  segmentsCompleted: number;
  /** 总段数 */
  segmentsTotal: number;
  /** 每段状态（按段序号） */
  segmentsStatus: Array<'pending' | 'running' | 'done' | 'failed'>;
  /** 最近一条日志 */
  lastLog?: string;
}

export interface ParallelTtsOptions {
  /** 5 段（默认） */
  segmentCount?: number;
  /** 是否启用 LLM 优化（默认 true，仅调整语气/节奏，不改内容） */
  polishWithLlm?: boolean;
  /** 进度回调 */
  onProgress?: (progress: ParallelTtsProgress) => void;
  /** 终止信号（用户取消） */
  signal?: AbortSignal;
}

export interface ParallelTtsResult {
  /** 合并后的 WAV Blob URL（可直接播放） */
  mergedAudioUrl: string;
  /** 合并后的 WAV Blob（供上传/导出） */
  mergedAudioBlob: Blob;
  /** 合并后的总时长（秒） */
  totalDuration: number;
  /** 每段信息（顺序保留） */
  segments: Array<{
    index: number;
    text: string;
    audioUrl: string;
    duration: number;
    success: boolean;
    error?: string;
  }>;
}

/**
 * 文案切成 N 段（按句子边界）
 * - 中文：按 。！？；\n 分割
 * - 英文：按 .!?;\n 分割
 * - 单段：直接返回 [text]
 */
export function splitTextIntoN(text: string, n: number = 5): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (n <= 1 || trimmed.length < 200) return [trimmed];

  const hasChinese = /[\u4e00-\u9fff]/.test(trimmed);
  const splitter = hasChinese ? /(?<=[。！？；\n])/ : /(?<=[.!?;\n])/g;
  const sentences = trimmed.split(splitter).map((s) => s.trim()).filter(Boolean);

  if (sentences.length <= n) {
    // 句子数 <= 目标段数：按目标段数均匀分组
    return groupSentencesByTarget(sentences, n);
  }

  // 句子数 > 目标段数：贪心分组，每段尽量接近 n 等分
  return groupSentencesByTarget(sentences, n);
}

/**
 * 贪心分组：让每段累计字数尽量接近总字数 / n
 */
function groupSentencesByTarget(sentences: string[], n: number): string[] {
  if (sentences.length === 0) return [];
  const total = sentences.reduce((sum, s) => sum + s.length, 0);
  const targetSize = total / n;
  const groups: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const sentence of sentences) {
    current.push(sentence);
    currentLen += sentence.length;
    if (currentLen >= targetSize && groups.length < n - 1) {
      groups.push(current);
      current = [];
      currentLen = 0;
    }
  }
  if (current.length > 0) groups.push(current);
  // 补齐：如果分组不足 n 段（极短文案），合并空位
  while (groups.length < n && groups.length > 1) {
    const last = groups.pop()!;
    groups[groups.length - 1].push(...last);
  }
  return groups.map((g) => g.join(' ').trim()).filter(Boolean);
}

/**
 * 主入口：5 段并行 TTS 配音 + 合并
 */
export async function runParallelTts(
  runningHubApiKey: string,
  yunwuApiKey: string,
  rawText: string,
  audioOpts: Omit<RunningHubAudioOptions, 'text'>,
  options: ParallelTtsOptions = {}
): Promise<ParallelTtsResult> {
  const {
    segmentCount = 5,
    polishWithLlm = true,
    onProgress,
    signal,
  } = options;

  const segmentsTotal = segmentCount;
  const segmentsStatus: Array<'pending' | 'running' | 'done' | 'failed'> = Array(
    segmentsTotal
  ).fill('pending');

  const updateProgress = (stage: string, current: number, lastLog?: string) => {
    onProgress?.({
      current,
      total: segmentsTotal + 1,
      stage,
      segmentsCompleted: segmentsStatus.filter((s) => s === 'done').length,
      segmentsTotal,
      segmentsStatus: [...segmentsStatus],
      lastLog,
    });
  };

  updateProgress('准备文案', 0);

  // 1. 切割文案
  let segments = splitTextIntoN(rawText, segmentsTotal);
  if (segments.length === 0) {
    throw new Error('文案为空，无法配音');
  }
  // 切割函数实际可能返回少于 n 段（短文案），调整 total
  const actualSegments = segments.length;
  const actualStatus: Array<'pending' | 'running' | 'done' | 'failed'> = Array(
    actualSegments
  ).fill('pending');

  // 2. 可选 LLM 润色（不修改内容，只优化朗读节奏）
  if (polishWithLlm && yunwuApiKey?.trim()) {
    updateProgress('优化朗读节奏', 0, '使用 LLM 仅优化语气，不修改文案内容');
    if (signal?.aborted) throw new Error('已取消');
    try {
      const polished = await polishTextForTtsSpeech(yunwuApiKey, rawText);
      // 重新切割（保持句数大致相等）
      const polishedSegments = splitTextIntoN(polished, actualSegments);
      if (polishedSegments.length === actualSegments) {
        segments = polishedSegments;
      }
    } catch (e: any) {
      console.warn('[ParallelTts] LLM 润色失败，使用原文:', e?.message);
    }
  }

  // 3. 5 段并行配音
  updateProgress('5 段并行配音中', 0, `已切割为 ${actualSegments} 段，开始并行调 RunningHub TTS...`);

  const results: Array<RunningHubResult | null> = await Promise.all(
    segments.map(async (segText, idx) => {
      if (signal?.aborted) {
        actualStatus[idx] = 'failed';
        return { success: false, error: '已取消' } as RunningHubResult;
      }
      actualStatus[idx] = 'running';
      updateProgress(
        `5 段并行配音中`,
        Math.min(idx, actualSegments - 1),
        `段 ${idx + 1}/${actualSegments} 提交中...`
      );
      try {
        const r = await withRunningHubSlot(() =>
          generateAudioWithRetry(runningHubApiKey, {
            ...audioOpts,
            text: segText,
          })
        );
        if (r.success) {
          actualStatus[idx] = 'done';
          updateProgress(
            `5 段并行配音中`,
            Math.min(idx, actualSegments - 1),
            `段 ${idx + 1}/${actualSegments} 完成`
          );
        } else {
          actualStatus[idx] = 'failed';
          updateProgress(
            `5 段并行配音中`,
            Math.min(idx, actualSegments - 1),
            `段 ${idx + 1}/${actualSegments} 失败: ${r.error}`
          );
        }
        return r;
      } catch (e: any) {
        actualStatus[idx] = 'failed';
        return { success: false, error: e?.message || '未知错误' } as RunningHubResult;
      }
    })
  );

  const failedCount = results.filter((r) => !r || !r.success).length;
  if (failedCount === actualSegments) {
    throw new Error('所有配音段都失败了');
  }

  updateProgress(
    '合并音频',
    actualSegments,
    `${actualSegments - failedCount} 段成功，${failedCount} 段失败，开始合并...`
  );

  // 4. 合并音频
  const segmentInfos = segments.map((text, idx) => {
    const r = results[idx];
    return {
      index: idx,
      text,
      audioUrl: r?.url || '',
      duration: 0,
      success: !!(r?.success && r.url),
      error: r?.error,
    };
  });

  const successSegments = segmentInfos.filter((s) => s.success);
  if (successSegments.length === 0) {
    throw new Error('没有可用的配音片段');
  }

  const merged = await mergeWavAudioUrls(successSegments.map((s) => s.audioUrl));

  // 填充每段时长
  successSegments.forEach((s, idx) => {
    s.duration = merged.durations[idx] || 0;
  });

  updateProgress('完成', segmentsTotal + 1, `合并完成，总时长 ${merged.totalDuration.toFixed(1)} 秒`);

  return {
    mergedAudioUrl: merged.mergedUrl,
    mergedAudioBlob: merged.mergedBlob,
    totalDuration: merged.totalDuration,
    segments: segmentInfos,
  };
}

/**
 * 合并多个 WAV 音频 URL 为单个 WAV
 * - 全部用 Web Audio API decode → 拼接 → 编码 wav
 * - 自动统一到第一个片段的 sampleRate / channel 数
 */
async function mergeWavAudioUrls(
  urls: string[]
): Promise<{ mergedUrl: string; mergedBlob: Blob; totalDuration: number; durations: number[] }> {
  if (urls.length === 0) throw new Error('无音频可合并');
  if (urls.length === 1) {
    const only = urls[0];
    const res = await fetch(only);
    const blob = await res.blob();
    const duration = await probeAudioDuration(only);
    return {
      mergedUrl: URL.createObjectURL(blob),
      mergedBlob: blob,
      totalDuration: duration,
      durations: [duration],
    };
  }

  const audioCtx = new AudioContext();
  try {
    // 1. 下载 + 解码所有片段
    const buffers: AudioBuffer[] = [];
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`音频下载失败: HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      const buf = await audioCtx.decodeAudioData(ab);
      buffers.push(buf);
    }

    // 2. 计算合并后总长度
    const targetSR = buffers[0].sampleRate;
    const targetChannels = buffers[0].numberOfChannels;
    const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);

    const merged = audioCtx.createBuffer(targetChannels, totalLength, targetSR);
    let offset = 0;
    for (const buf of buffers) {
      // 转 Mono / 调整 channels 数
      const frames = buf.length;
      for (let ch = 0; ch < targetChannels; ch++) {
        const srcChannel = ch < buf.numberOfChannels ? buf.getChannelData(ch) : buf.getChannelData(0);
        const dstChannel = merged.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          dstChannel[offset + i] = srcChannel[i];
        }
      }
      offset += frames;
    }

    // 3. 编码为 WAV
    const mergedBlob = encodeWavPcm16(merged);
    const mergedUrl = URL.createObjectURL(mergedBlob);

    const durations = buffers.map((b) => b.length / b.sampleRate);
    const totalDuration = durations.reduce((s, d) => s + d, 0);

    return { mergedUrl, mergedBlob, totalDuration, durations };
  } finally {
    await audioCtx.close();
  }
}

/**
 * 探测音频时长（fallback）
 */
async function probeAudioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const d = audio.duration;
      resolve(isFinite(d) ? d : 0);
    };
    audio.onerror = () => reject(new Error('音频元数据加载失败'));
    audio.src = url;
  });
}

/**
 * 编码 AudioBuffer 为 WAV（PCM 16-bit little-endian）
 * （与 oneClickTtsService encodeWavPcm16 一致，本地化以避免依赖）
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

  writeStr(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeStr(8, 'WAVE');

  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);

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
