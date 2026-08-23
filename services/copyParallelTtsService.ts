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
  /**
   * 合并后的 MP3 Blob（v2.7+）。
   * 直接来自 RunningHub TTS 任务的 mp3 链接拼接（保留原始 mp3 编码，无 ffmpeg 重编码损失）。
   * 失败/未生成时为 undefined，前端应降级到客户端 MediaRecorder 或服务端 ffmpeg。
   */
  mergedMp3Blob?: Blob;
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

  // v2.7+：从原始 mp3 URL 合并 mp3（不经过 wav → mp3 重编码，质量零损失）
  updateProgress(
    '合并 MP3',
    segmentsTotal + 1,
    `合并 ${successSegments.length} 段 mp3 链接（保留 RunningHub 原始编码）...`
  );
  const mergedMp3Blob = await mergeMp3AudioUrls(successSegments.map((s) => s.audioUrl));

  updateProgress('完成', segmentsTotal + 1, `合并完成，总时长 ${merged.totalDuration.toFixed(1)} 秒`);

  return {
    mergedAudioUrl: merged.mergedUrl,
    mergedAudioBlob: merged.mergedBlob,
    mergedMp3Blob: mergedMp3Blob ?? undefined,
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

/**
 * 合并多个 MP3 URL 为单个 MP3 Blob（v2.7+）
 *
 * 关键优化：RunningHub TTS 任务返回的 results[].url **本身就是 mp3**（API 文档明文
 *   "新增：保存为 mp3 格式"）。无需再用 ffmpeg / MediaRecorder 重编码（既慢又损质量）。
 *
 * 合并原理：
 *   - MP3 帧是 self-contained（CBR / VBR 都行），可以跨文件拼接播放
 *   - 文件头必须去掉 ID3v1 / ID3v2 tag（可能含旧歌名/封面/时长等元数据，会干扰播放器）
 *   - 文件尾可能有 LAME/Xing/Info VBR header，只保留第一个文件中的，作为新文件 VBR header
 *   - 中间是连续的 MP3 帧，直接拼接
 *
 * 失败兜底：返回 undefined，由调用方决定降级到 WAV / MediaRecorder / 服务端 ffmpeg。
 *
 * 浏览器兼容性：所有现代浏览器（Chrome/Firefox/Safari/Edge）都支持 mp3 Blob 拼接。
 */
export async function mergeMp3AudioUrls(
  urls: string[]
): Promise<Blob | undefined> {
  if (urls.length === 0) return undefined;
  try {
    const buffers: ArrayBuffer[] = [];
    for (const u of urls) {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`mp3 下载失败 ${res.status}: ${u}`);
      buffers.push(await res.arrayBuffer());
    }

    // 单段：原样返回（但去掉 ID3v2 tag，避免播放器误读旧元数据）
    if (buffers.length === 1) {
      return new Blob([stripId3v2(buffers[0])], { type: 'audio/mpeg' });
    }

    // 多段：第 1 个文件保留 ID3v2 + 末尾 VBR header；其余文件去掉 ID3 + 末尾 VBR header
    //       然后按顺序拼接中间 frame 数据
    const parts: Uint8Array[] = [];
    let totalLen = 0;

    for (let i = 0; i < buffers.length; i++) {
      let bytes = new Uint8Array(buffers[i]);
      if (i === 0) {
        // 第 1 个文件：去掉 ID3v1（末尾 128 字节 "TAG" 头），保留 ID3v2 和 VBR header
        bytes = stripId3v1(bytes);
      } else {
        // 后续文件：去掉所有头尾元数据，只保留帧数据
        bytes = stripAllMp3Metadata(bytes);
      }
      parts.push(bytes);
      totalLen += bytes.length;
    }

    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.length;
    }

    return new Blob([merged], { type: 'audio/mpeg' });
  } catch (e) {
    console.warn('[mergeMp3AudioUrls] 合并失败（调用方应降级到 WAV / MediaRecorder）：', e);
    return undefined;
  }
}

/** 去掉 ID3v1 tag（文件末尾 128 字节，若以 "TAG" 开头） */
function stripId3v1(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 128) return bytes;
  const tagStart = bytes.length - 128;
  if (
    bytes[tagStart] === 0x54 && // 'T'
    bytes[tagStart + 1] === 0x41 && // 'A'
    bytes[tagStart + 2] === 0x47 // 'G'
  ) {
    return bytes.subarray(0, tagStart);
  }
  return bytes;
}

/** 去掉 ID3v2 tag（文件头部，若以 "ID3" 开头） */
function stripId3v2(buf: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 10) return bytes;
  if (
    bytes[0] === 0x49 && // 'I'
    bytes[1] === 0x44 && // 'D'
    bytes[2] === 0x33 // '3'
  ) {
    // ID3v2 header: 10 bytes, then sync-safe size (4 bytes, big-endian, each byte bit 7 = 0)
    const b4 = bytes[6] & 0x7f;
    const b5 = bytes[7] & 0x7f;
    const b6 = bytes[8] & 0x7f;
    const b7 = bytes[9] & 0x7f;
    const tagSize = (b4 << 21) | (b5 << 14) | (b6 << 7) | b7;
    const headerEnd = 10 + tagSize;
    if (headerEnd < bytes.length) return bytes.subarray(headerEnd);
  }
  return bytes;
}

/**
 * 完整去元数据（v2.7 简化版）：只去 ID3v2 + ID3v1，保留中间所有 MP3 帧。
 *
 * 重要教训（v2.6 → v2.7 修复）：
 *   旧版试图切掉 Xing/LAME/Info VBR header，结果 `bytes.subarray(0, vbrEnd)`
 *   把 VBR header **之后**的帧数据也丢了（因为 Xing header 后面通常还有大量帧）。
 *   这导致拼接后的 mp3 实际只有第一段（VBR header 之前的部分），看起来
 *   像"只下载了第一段"。
 *
 * 正确做法：完全不动 VBR header。
 *   - VBR header (Xing/LAME) 通常出现在第 1 个 MPEG 帧之后，描述整个文件的 VBR 信息
 *   - 拼接时重复出现对播放器无害：mp3 是流式帧格式，播放器按 0xFFEx 同步字节解析
 *     帧数据，VBR header 文本（"Xing"）看起来不像 MP3 帧（第一个字节是 'X' = 0x58，
 *     不是 0xFF），播放器会跳过
 *   - 真正会卡播放器的是 ID3v2 tag（含元数据，长度可能几 KB~几 MB）
 *     和 ID3v1（末尾 128 字节 "TAG" 标记）
 *
 * 因此只去 ID3v2（文件头）+ ID3v1（文件尾），保留中间所有数据。
 */
function stripAllMp3Metadata(bytes: Uint8Array): Uint8Array {
  // 1) 去 ID3v2（头部 "ID3" + sync-safe 长度）
  bytes = stripId3v2(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  // 2) 去 ID3v1（末尾 128 字节 "TAG" 头）
  bytes = stripId3v1(bytes);
  // 3) 不动 VBR header（Xing/LAME/Info）— 见上方注释
  return bytes;
}
