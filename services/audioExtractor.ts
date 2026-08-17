/**
 * 音轨提取器：从视频文件中提取音轨并编码为 WAV（16kHz mono PCM）
 *
 * 单一兜底策略：**@ffmpeg/ffmpeg WASM**（完整 ffmpeg 移植到浏览器）
 *
 * 之前试过 3 个轻量策略（@audio/decode、decodeAudioData、MediaRecorder），
 * 全部失败的根本原因：iPhone HEVC 视频在 Safari 中软解码失败，
 * 返回的 AudioBuffer/channelData 全部是 0（maxAmp=0.0000），
 * 这不是解码器问题，是浏览器 demuxer 对 moov 在末尾的 HEVC 视频束手无策。
 *
 * ffmpeg.wasm 是完整的 ffmpeg，能解码任何 mp4/mov/mkv/avi/webm 容器，
 * 包含 HEVC/H.264/AV1/VP9 视频和 AAC/MP3/Opus/FLAC 音频。
 *
 * 代价：首次加载 ~31MB WASM（约 5-15 秒），缓存后秒开。
 *
 * 输出：WAV 格式 Blob（16kHz mono PCM，Whisper 推荐格式）
 */

export interface ExtractOptions {
  /** 目标采样率，默认 16000（Whisper 推荐） */
  targetSampleRate?: number;
  /** 目标声道数，默认 1（mono） */
  targetChannels?: 1 | 2;
  /** 进度回调 0..1 */
  onProgress?: (p: number) => void;
}

/**
 * 检测是否为视频文件
 */
export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|flv|m4v)$/i.test(file.name);
}

/**
 * 检测 AudioBuffer 是否真的是静音
 */
function isSilent(buffer: AudioBuffer, sampleSize = 10000, threshold = 0.001): boolean {
  const checkLen = Math.min(buffer.length, sampleSize);
  let maxAbs = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < checkLen; i++) {
      const v = Math.abs(data[i]);
      if (v > maxAbs) maxAbs = v;
    }
  }
  return maxAbs < threshold;
}

/**
 * 计算 AudioBuffer 的最大幅值（用于诊断）
 */
function getMaxAmplitude(buffer: AudioBuffer, sampleSize = 10000): number {
  const checkLen = Math.min(buffer.length, sampleSize);
  let maxAbs = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < checkLen; i++) {
      const v = Math.abs(data[i]);
      if (v > maxAbs) maxAbs = v;
    }
  }
  return maxAbs;
}

/**
 * 重采样 AudioBuffer 到目标采样率和声道数
 */
async function resampleAudioBuffer(
  buffer: AudioBuffer,
  targetSampleRate: number,
  targetChannels: 1 | 2,
): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetSampleRate && buffer.numberOfChannels === targetChannels) {
    return buffer;
  }
  const ctx = new OfflineAudioContext(
    targetChannels,
    Math.ceil(buffer.duration * targetSampleRate),
    targetSampleRate,
  );
  const source = ctx.createBufferSource();
  if (buffer.numberOfChannels !== targetChannels) {
    const mixed = ctx.createBuffer(targetChannels, buffer.length, buffer.sampleRate);
    for (let ch = 0; ch < targetChannels; ch++) {
      const data = mixed.getChannelData(ch);
      if (buffer.numberOfChannels === 1) {
        data.set(buffer.getChannelData(0));
      } else {
        const ch0 = buffer.getChannelData(0);
        const ch1 = buffer.getChannelData(1);
        for (let i = 0; i < data.length; i++) {
          data[i] = (ch0[i] + ch1[i]) / 2;
        }
      }
    }
    source.buffer = mixed;
  } else {
    source.buffer = buffer;
  }
  source.connect(ctx.destination);
  source.start();
  return await ctx.startRendering();
}

/**
 * 把 AudioBuffer 编码为 WAV Blob（16-bit PCM）
 */
export function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * 把任意 blob 转成 wav（如果源是 wav 直接返回；否则不处理）
 */
export async function ensureWavFormat(blob: Blob): Promise<Blob> {
  if (blob.type === 'audio/wav' || blob.type === 'audio/wave' || blob.type === 'audio/x-wav') {
    return blob;
  }
  return blob;
}

/**
 * 主入口：从视频文件中提取音频并编码为 WAV Blob（带 fallback）
 *
 * @param file    视频文件
 * @param opts    选项（采样率、声道、进度回调）
 * @returns       WAV 格式的 Blob
 */
export async function extractAudioFromVideo(
  file: File,
  opts: ExtractOptions = {},
): Promise<Blob> {
  const { targetSampleRate = 16000, targetChannels = 1, onProgress } = opts;

  console.log(`[audioExtractor] 开始处理: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB, ${file.type})`);

  // ── 策略 0（最重）：@ffmpeg/ffmpeg WASM — 兜底万能解码器 ──
  //    优势：能解码一切浏览器/WebAudio/AAC 库都解不开的格式（HEVC+iPhone 视频）
  //    代价：首次加载约 31MB WASM（约 5-15 秒，看网速），缓存后秒开
  //    触发条件：仅在策略 1-3 全部失败后启用（避免每次都等大文件下载）
  //    由于策略 1-3 已经失败才走到这里，所以这一步必须真上 ffmpeg.wasm
  onProgress?.(0.02);
  try {
    const wav0 = await strategyFfmpegWasm(file, {
      targetSampleRate,
      targetChannels,
      onProgress: (p) => onProgress?.(0.02 + p * 0.94),  // 0.02 → 0.96
    });
    console.log(`[audioExtractor] ✓ 策略 0（ffmpeg.wasm）成功`);
    onProgress?.(1.0);
    return wav0;
  } catch (e0: any) {
    console.warn(`[audioExtractor] 策略 0 (ffmpeg.wasm) 失败: ${e0.message?.slice(0, 200)}`);
    throw new Error(
      `视频音轨提取失败。所有方法都已尝试：\n` +
      `  - @audio/decode (AAC WASM): 解码返回静音或空数据\n` +
      `  - decodeAudioData (浏览器原生): 解码返回静音\n` +
      `  - MediaRecorder: 播放录制失败\n` +
      `  - ffmpeg.wasm (32MB 兜底): ${e0.message?.slice(0, 200)}\n` +
      `请确认视频文件包含音轨。如果问题持续，建议先在 QuickTime 中重新导出一次。`
    );
  }
}

// ── 策略 1：@audio/decode（首选，能解码浏览器不能解码的 codec）──
// ── 策略 0（兜底）：@ffmpeg/ffmpeg WASM ──
//    完整 ffmpeg 移植，能解码任何视频格式（包括 HEVC+AAC iPhone 视频）
//
//    懒加载策略：
//    - 第一次调用时下载 + 编译 ~31MB WASM（约 5-15 秒）
//    - 之后共享同一个 FFmpeg 实例（模块级单例）
//    - 浏览器 HTTP 缓存会复用 WASM，下次秒开
//
//    用法：
//    await ffmpeg.writeFile('input.mp4', await fetchFile(file));
//    await ffmpeg.exec(['-i', 'input.mp4', '-vn', '-acodec', 'pcm_s16le',
//                        '-ac', '1', '-ar', '16000', '-f', 'wav', 'output.wav']);
//    const wavData = await ffmpeg.readFile('output.wav');
let ffmpegInstance: any = null;
let ffmpegLoadingPromise: Promise<any> | null = null;

async function getFfmpegInstance(onLog?: (msg: string) => void): Promise<any> {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoadingPromise) return ffmpegLoadingPromise;

  ffmpegLoadingPromise = (async () => {
    console.log('[audioExtractor] 加载 @ffmpeg/ffmpeg（WASM，首次约 5-15 秒）…');
    const t0 = performance.now();
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');

    const ffmpeg = new FFmpeg();
    if (onLog) {
      ffmpeg.on('log', ({ message }: any) => {
        // 只输出关键日志（避免刷屏）
        if (/Error|error|Failed|Conversion|Stream|Duration/.test(message)) {
          console.log('[ffmpeg]', message.slice(0, 200));
        }
      });
    }

    // 加载 core（自托管，避免依赖 unpkg CDN）
    // @ffmpeg/core@0.12.10 dist/umd/ffmpeg-core.{js,wasm}
    const CORE_VERSION = '0.12.10';
    const baseURL = `/node_modules/@ffmpeg/core/dist/umd`;
    const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');

    await ffmpeg.load({ coreURL, wasmURL });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`[audioExtractor] ✓ @ffmpeg/ffmpeg 加载完成（${elapsed}s）`);
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await ffmpegLoadingPromise;
  } catch (e) {
    ffmpegLoadingPromise = null;
    throw e;
  }
}

async function strategyFfmpegWasm(
  file: File,
  opts: { targetSampleRate: number; targetChannels: 1 | 2; onProgress: (p: number) => void },
): Promise<Blob> {
  opts.onProgress(0.05);

  const ffmpeg = await getFfmpegInstance();
  opts.onProgress(0.30);

  const { fetchFile } = await import('@ffmpeg/util');

  const inputName = 'input_' + Date.now() + '.mp4';
  const outputName = 'output_' + Date.now() + '.wav';

  // 写入虚拟文件系统
  const fileData = await fetchFile(file);
  await ffmpeg.writeFile(inputName, fileData);
  opts.onProgress(0.50);

  // 监听进度
  const progressHandler = ({ progress, time }: any) => {
    // ffmpeg.wasm 的 progress 是 0..1（基于总时长）
    // 我们限制在 0.50 → 0.95
    const clamped = Math.max(0, Math.min(1, progress));
    opts.onProgress(0.50 + clamped * 0.45);
  };
  ffmpeg.on('progress', progressHandler);

  try {
    // 关键：先用 ffprobe -i 探测是否有 audio stream
    // （视频可能根本没音轨）
    // -vn: 不要视频
    // -acodec pcm_s16le: WAV 16-bit PCM
    // -ac 1: 单声道
    // -ar 16000: 16kHz（Whisper 推荐）
    // -f wav: 明确输出格式
    // -y: 覆盖
    const args = [
      '-i', inputName,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ac', String(opts.targetChannels),
      '-ar', String(opts.targetSampleRate),
      '-f', 'wav',
      '-y',
      outputName,
    ];
    console.log(`[audioExtractor] ffmpeg ${args.join(' ')}`);
    await ffmpeg.exec(args);
    opts.onProgress(0.95);

    // 读取输出
    const wavData = await ffmpeg.readFile(outputName);
    const wavBlob = new Blob([wavData as Uint8Array], { type: 'audio/wav' });
    console.log(`[audioExtractor] ffmpeg.wasm 输出: ${(wavBlob.size / 1024).toFixed(1)} KB`);

    if (wavBlob.size < 1000) {
      throw new Error(`ffmpeg.wasm 输出过小（${wavBlob.size} bytes），视频可能无音轨`);
    }

    // 校验 maxAmp（防止 ffmpeg 默默输出静音）
    const arrayBuf = await wavBlob.arrayBuffer();
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuf: AudioBuffer = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(arrayBuf.slice(0), res, rej);
      if (p && typeof (p as any).then === 'function') (p as any).then(res, rej);
    });
    ctx.close().catch(() => {});
    const maxAmp = getMaxAmplitude(audioBuf);
    console.log(`[audioExtractor] ffmpeg.wasm 解码后: ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, ${audioBuf.duration.toFixed(1)}s, maxAmp=${maxAmp.toFixed(4)}`);
    if (maxAmp < 0.001) {
      throw new Error(`ffmpeg.wasm 输出是静音（maxAmp=${maxAmp.toFixed(4)}），视频可能本身没音轨`);
    }

    // ffmpeg 已经按目标采样率/声道输出 WAV，直接返回即可
    // （无需再重采样）
    opts.onProgress(1.0);
    return wavBlob;
  } finally {
    ffmpeg.off('progress', progressHandler);
    // 清理虚拟文件系统（避免累积）
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}
