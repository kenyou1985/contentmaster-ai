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
 * 计算 AudioBuffer 的 RMS（均方根）幅值，用于判断整体音量水平
 */
function getRmsAmplitude(buffer: AudioBuffer, sampleSize = 50000): number {
  const checkLen = Math.min(buffer.length, sampleSize);
  let sumSquares = 0;
  let count = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < checkLen; i++) {
      const v = data[i];
      sumSquares += v * v;
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sumSquares / count) : 0;
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

  // ── 策略 1（最快）：HTML5 video + WebAudio API 直接解码 ──
  //    优势：浏览器原生，毫秒级，不需服务端
  //    适用：mp4/h264/aac（兼容性最好）
  //    失败：HEVC、mkv 等浏览器不支持的格式
  try {
    const wav1 = await strategyHtml5Video(file, {
      targetSampleRate,
      targetChannels,
      onProgress: (p) => onProgress?.(0.02 + p * 0.4),  // 0.02 → 0.42
    });
    if (wav1) {
      console.log(`[audioExtractor] ✓ 策略 1（HTML5 video）成功`);
      onProgress?.(1.0);
      return wav1;
    }
  } catch (e1: any) {
    console.warn(`[audioExtractor] 策略 1 (HTML5 video) 失败: ${e1.message?.slice(0, 200)}`);
  }

  // ── 策略 0a（推荐）：服务端 ffmpeg 转码（remotion-server 的 /audio/extract）──
  //    优势：服务端有完整 ffmpeg + 无浏览器解码限制，比 ffmpeg.wasm 快且稳
  //    触发逻辑：
  //      - 本地环境 → /api/remotion/audio/extract (vite proxy)
  //      - 线上环境 → VITE_REMITION_API_BASE (Railway)
  onProgress?.(0.45);
  try {
    const wav0 = await strategyServerExtract(file, {
      targetSampleRate,
      targetChannels,
      onProgress: (p) => onProgress?.(0.45 + p * 0.5),  // 0.45 → 0.95
    });
    console.log(`[audioExtractor] ✓ 策略 0a（服务端 ffmpeg）成功`);
    onProgress?.(1.0);
    return wav0;
  } catch (e0a: any) {
    console.warn(`[audioExtractor] 策略 0a (服务端) 失败: ${e0a.message?.slice(0, 200)}`);
  }

  // ── 策略 0b（兜底）：@ffmpeg/ffmpeg WASM — 浏览器内解码 ──
  //    优势：无需服务端
  //    代价：首次加载约 31MB WASM（约 5-15 秒），Safari 在某些 HEVC 上仍可能失败
  onProgress?.(0.96);
  try {
    const wav0 = await strategyFfmpegWasm(file, {
      targetSampleRate,
      targetChannels,
      onProgress: (p) => onProgress?.(0.96 + p * 0.04),  // 0.96 → 1.0
    });
    console.log(`[audioExtractor] ✓ 策略 0b（ffmpeg.wasm）成功`);
    onProgress?.(1.0);
    return wav0;
  } catch (e0: any) {
    console.warn(`[audioExtractor] 策略 0b (ffmpeg.wasm) 失败: ${e0.message?.slice(0, 200)}`);
    throw new Error(
      `视频音轨提取失败。所有方法都已尝试：\n` +
      `  - HTML5 video + WebAudio: 浏览器无法解码此视频\n` +
      `  - 服务端 ffmpeg (remotion-server): 失败或服务端未启动\n` +
      `  - ffmpeg.wasm (32MB 兜底): ${e0.message?.slice(0, 200)}\n` +
      `请确认视频文件包含音轨，或确认 remotion-server 服务已启动。`
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

/**
 * 预热 ffmpeg.wasm（不阻塞调用方）
 * 建议在用户进入"文案成片"页面时就调用，借助 requestIdleCallback 避开首屏
 */
export function prewarmFfmpeg(): void {
  if (ffmpegInstance || ffmpegLoadingPromise) return;
  const idle = (window as any).requestIdleCallback || ((cb: any) => setTimeout(cb, 1000));
  idle(() => {
    getFfmpegInstance().catch((e) => {
      console.warn('[audioExtractor] 预热失败（不影响功能）：', e?.message?.slice(0, 100));
    });
  });
}

async function getFfmpegInstance(onLog?: (msg: string) => void): Promise<any> {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoadingPromise) return ffmpegLoadingPromise;

  ffmpegLoadingPromise = (async () => {
    const t0 = performance.now();
    console.log('[audioExtractor] ═══ 加载 @ffmpeg/ffmpeg WASM（首次约 5-15 秒）═══');
    console.log('[audioExtractor]   步骤 1/3: 导入 @ffmpeg/ffmpeg 模块...');
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    console.log('[audioExtractor]   步骤 2/3: 导入 @ffmpeg/util helper...');
    const { toBlobURL: toBlobURLFn, fetchFile } = await import('@ffmpeg/util');

    const ffmpeg = new FFmpeg();
    if (onLog) {
      ffmpeg.on('log', ({ message }: any) => {
        // 只输出关键日志（避免刷屏）
        if (/Error|error|Failed|Conversion|Stream|Duration/.test(message)) {
          console.log('[ffmpeg]', message.slice(0, 200));
        }
      });
    }

    // 加载 core（CDN 版本，避免 vite 解析 ffmpeg 包内部动态 import 失败）
    // @ffmpeg/core@0.12.10 UMD 版
    // 用 unpkg CDN，因为本地 vite 解析 module worker 的 dynamic import 会失败
    const CORE_VERSION = '0.12.10';
    const CDN_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
    const LOCAL_BASE = `/node_modules/@ffmpeg/core/dist/umd`;

    // 用 toBlobURL 跨域代理（解决 CORS）
    const tryLoad = async (base: string): Promise<{ coreURL: string; wasmURL: string }> => {
      const coreURL = await toBlobURLFn(`${base}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURLFn(`${base}/ffmpeg-core.wasm`, 'application/wasm');
      return { coreURL, wasmURL };
    };

    let coreURL: string;
    let wasmURL: string;
    try {
      console.log(`[audioExtractor]   尝试 CDN: ${CDN_BASE}`);
      const r = await tryLoad(CDN_BASE);
      coreURL = r.coreURL;
      wasmURL = r.wasmURL;
      console.log(`[audioExtractor]   ✓ CDN core/wasm 已转 Blob URL（绕过 CORS）`);
    } catch (e: any) {
      console.warn(`[audioExtractor]   CDN 失败（${e.message?.slice(0, 100)}），回退本地 vite serve: ${LOCAL_BASE}`);
      const r = await tryLoad(LOCAL_BASE);
      coreURL = r.coreURL;
      wasmURL = r.wasmURL;
      console.log(`[audioExtractor]   ✓ 本地 core/wasm 已转 Blob URL`);
    }
    console.log(`[audioExtractor]   WASM 下载完成，编译中（Web Worker 编译可能需要 5-10 秒）...`);

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
    // 增加采样检查范围
    const maxAmp = getMaxAmplitude(audioBuf, Math.min(audioBuf.length, 50000));
    console.log(`[audioExtractor] ffmpeg.wasm 解码后: ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, ${audioBuf.duration.toFixed(1)}s, maxAmp=${maxAmp.toFixed(4)}`);
    // 对长视频使用更宽松的阈值
    const silenceThreshold = audioBuf.duration > 30 ? 0.0001 : 0.001;
    if (maxAmp < silenceThreshold) {
      const rms = getRmsAmplitude(audioBuf);
      console.log(`[audioExtractor]   RMS=${rms.toFixed(6)}, 再次检查...`);
      if (rms < silenceThreshold * 0.5) {
        throw new Error(`ffmpeg.wasm 输出是静音（maxAmp=${maxAmp.toFixed(4)}），视频可能本身没音轨`);
      }
      console.log(`[audioExtractor]   通过 RMS 检查，使用结果`);
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

/**
 * 检测是否为本地环境（localhost / 127.0.0.1）
 */
function isLocalSiteOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h)) return true;
  return false;
}

/**
 * 获取 Remotion API Base URL
 * - 本地环境 → /api/remotion (vite proxy)
 * - 线上环境 → VITE_REMITION_API_BASE 环境变量
 */
function getApiBase(): string {
  if (isLocalSiteOrigin()) {
    return '/api/remotion';
  }
  // 动态读取 VITE_REMITION_API_BASE（前端构建时注入）
  const envBase = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_REMITION_API_BASE) as string | undefined;
  if (envBase) return envBase.replace(/\/$/, '');
  // fallback 到公共 Railway URL
  return 'https://remotion-production-3c9f.up.railway.app';
}

// ── 策略 0a：服务端 ffmpeg 转码（remotion-server /audio/extract） ──
//    通过 vite proxy → http://127.0.0.1:18093/audio/extract
//    服务端用 @remotion/renderer.extractAudio() 解码任意 mp4/mov/mkv → WAV（16kHz mono PCM）
//
//    优势：
//      - 服务端 ffmpeg 完整版（支持 iPhone HEVC），无浏览器解码限制
//      - macOS ARM64 上用 Remotion 包内 @remotion/compositor-darwin-arm64/ffmpeg（零依赖、零 Gatekeeper 问题）
//
//    触发逻辑：
//      - 用户上传视频 → 调用此策略
//      - 服务端返回 wavDataUrl → 转 Blob 返回
//      - 服务端挂了/不存在 → throw，fallback 到 ffmpeg.wasm
async function strategyServerExtract(
  file: File,
  opts: { targetSampleRate: number; targetChannels: 1 | 2; onProgress: (p: number) => void },
): Promise<Blob> {
  opts.onProgress(0.05);
  console.log(`[audioExtractor] 策略 0a: 通过服务端 ffmpeg 转码（${getApiBase()}）`);
  console.log(`[audioExtractor]   视频: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB, ${file.type})`);

  // 用 multipart/form-data 直接传 File（无需 base64，节省 33% 网络开销）
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('fileName', file.name);
  fd.append('mime', file.type || 'video/mp4');
  opts.onProgress(0.20);

  // 调用服务端（本地 vite proxy 或线上 Railway）
  // 长超时：285MB 文件上传 ~10-30 秒，转码 ~10-30 秒（取决于 ffmpeg-static 和 CPU）
  // 用 XMLHttpRequest 而非 fetch，因为 XHR 支持 upload.onprogress
  const wavDataUrl = await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${getApiBase()}/audio/extract`, true);
    xhr.timeout = 600_000; // 10 分钟（极保守，285MB + 转码 + 网络抖动）
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total * 0.5).toFixed(1); // 上传占 0-50%
        opts.onProgress(0.45 + parseFloat(pct) / 100);  // 0.45 → 0.95
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText);
          if (json.success && json.wavDataUrl) {
            resolve(json.wavDataUrl);
          } else {
            reject(new Error(json.error || '服务端返回失败'));
          }
        } catch (e) {
          reject(new Error(`服务端返回非 JSON: ${xhr.responseText.slice(0, 200)}`));
        }
      } else {
        reject(new Error(`服务端 HTTP ${xhr.status}: ${xhr.responseText.slice(0, 300)}`));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误（服务端未响应或断网）'));
    xhr.ontimeout = () => reject(new Error(`服务端超时（${xhr.timeout / 1000}s），请确认 remotion-server 已启动`));
    xhr.send(fd);
  });
  opts.onProgress(0.95);

  // 数据已经在 XHR onload 解析，直接处理
  // data URL → Blob
  const m = wavDataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error('服务端 wavDataUrl 格式错误');
  const bin = atob(m[2]);
  const wavBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) wavBytes[i] = bin.charCodeAt(i);
  const wavBlob = new Blob([wavBytes], { type: m[1] || 'audio/wav' });
  console.log(`[audioExtractor] 服务端返回: ${(wavBlob.size / 1024).toFixed(1)} KB`);

  if (wavBlob.size < 1000) {
    throw new Error(`服务端返回过小（${wavBlob.size} bytes），视频可能无音轨`);
  }

  // 验证不是静音（解码看 maxAmp）
  const arrayBuf = await wavBlob.arrayBuffer();
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    const audioBuf: AudioBuffer = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(arrayBuf.slice(0), res, rej);
      if (p && typeof (p as any).then === 'function') (p as any).then(res, rej);
    });
    // 增加采样检查范围（原来只检查前10000样本，对长视频可能漏掉主要内容）
    const maxAmp = getMaxAmplitude(audioBuf, Math.min(audioBuf.length, 50000));
    console.log(`[audioExtractor] 服务端 WAV 解码后: ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, ${audioBuf.duration.toFixed(1)}s, maxAmp=${maxAmp.toFixed(4)}`);
    // 放宽阈值并增加检查：对长视频（>30s）使用更宽松的阈值
    const silenceThreshold = audioBuf.duration > 30 ? 0.0001 : 0.001;
    if (maxAmp < silenceThreshold) {
      // 再检查音频的 RMS 值来确认是否真的静音
      const rms = getRmsAmplitude(audioBuf);
      console.log(`[audioExtractor]   RMS=${rms.toFixed(6)}, 再次检查整体音量...`);
      // 如果 RMS 也很低，才判定为静音
      if (rms < silenceThreshold * 0.5) {
        throw new Error(`服务端返回静音（maxAmp=${maxAmp.toFixed(4)}，rms=${rms.toFixed(6)}），视频可能无音轨`);
      }
      console.log(`[audioExtractor]   通过 RMS 检查，使用服务端结果`);
    }
  } finally {
    ctx.close().catch(() => {});
  }

  opts.onProgress(1.0);
  return wavBlob;
}

// ── 策略 1：HTML5 video + WebAudio API 直接解码 ─────────────
//    浏览器原生，毫秒级，零依赖。
//    适用：浏览器原生能解码的格式（mp4/h264/aac 最稳，webm/vp9 视 macOS 而定）
//    失败：HEVC/hvc1, mkv, 某些 mov variant（Safari 不支持）
//    失败时返回 null → 主流程跳到下一个策略
async function strategyHtml5Video(
  file: File,
  opts: { targetSampleRate: number; targetChannels: 1 | 2; onProgress: (p: number) => void },
): Promise<Blob | null> {
  opts.onProgress(0.05);
  console.log(`[audioExtractor] 策略 1: HTML5 video + WebAudio API 解码`);

  // 1. 创建临时 video URL
  const videoUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.muted = true; // 不播放音频
  video.src = videoUrl;

  // 2. 监听 error
  return await new Promise<Blob | null>((resolve, reject) => {
    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        URL.revokeObjectURL(videoUrl);
        video.remove();
      }
    };

    const timeout = setTimeout(() => {
      if (resolved) return;
      cleanup();
      reject(new Error('HTML5 video 加载超时（30s）'));
    }, 30_000);

    video.addEventListener('error', (e) => {
      // 浏览器无法解码此格式（HEVC 等）
      cleanup();
      clearTimeout(timeout);
      reject(new Error(`HTML5 video 加载失败: ${video.error?.message || '未知错误'}`));
    });

    video.addEventListener('loadedmetadata', async () => {
      opts.onProgress(0.30);
      console.log(`[audioExtractor]   HTML5 video metadata: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(1)}s`);

      // 3. 用 MediaElement + WebAudio 捕获音频
      //    注意：传统方法是用 OfflineAudioContext + AudioBuffer，但 video
      //    元素只能通过 MediaElementAudioSourceNode 实时播放后捕获。
      //    浏览器不允许直接 dump video 元数据到 AudioBuffer。
      //    替代方案：用 createMediaElementSource + ScriptProcessor/AudioWorklet
      //    → 复杂且非标准
      //
      //    **更稳的方案**：用 MediaRecorder 录制 video 播放的音频输出 + 离屏 video
      //    但这对 285MB 视频太慢（要 90s 实时播放）
      //
      //    **最实用**：直接用 video.captureStream() → MediaRecorder
      //    限制：要播放完整 video 才能拿到完整 audio
      //
      //    实际：iPhone HEVC 视频在 Safari 走不通；用 ffmpeg.wasm；
      //    在 Chrome 里 MP4 走 HTML5 decoding 即可。
      //
      //    **快速策略 1**：仅对**非 HEVC** mp4（典型 Chrome 兼容场景）起作用
      //    否则 reject 回到主流程走策略 0a

      cleanup();
      clearTimeout(timeout);

      // 判定：iPhone 视频通常是 HEVC（HVC1）。macOS Safari/Chrome HEVC 支持参差
      // 浏览器无法从 video 元素直接拿音频 PCM（除非用 MediaRecorder 实时录制）
      // 这里直接 reject，让主流程走下个策略
      const codecs = (video.canPlayType(file.type) || '').replace(/^.*codecs="([^"]+)"$/, '$1');
      if (codecs.toLowerCase().includes('hvc1') || codecs.toLowerCase().includes('hev1')) {
        reject(new Error(`HTML5 video 不支持 HEVC codec: ${codecs}，跳过策略 1`));
        return;
      }

      // 简化：HTML5 video 拿到 metadata 后还需要实时播放+录制才能拿到 PCM
      // 这对长视频不实际（90s 视频 = 90s 播放）
      // 因此我们只对短片段（<10s）用 HTML5 video
      if (video.duration > 10) {
        reject(new Error(`视频时长 ${video.duration.toFixed(1)}s > 10s，HTML5 video 策略需要实时播放，不实际`));
        return;
      }

      // 短视频：实时播放 + WebAudio 捕获
      try {
        const wav = await streamVideoAudio(video, opts);
        resolve(wav);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// 实时播放 video + WebAudio 捕获（仅适合 <10s 短视频）
async function streamVideoAudio(
  video: HTMLVideoElement,
  opts: { targetSampleRate: number; targetChannels: 1 | 2; onProgress: (p: number) => void },
): Promise<Blob> {
  opts.onProgress(0.40);
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const source = ctx.createMediaElementSource(video);
  const destination = ctx.createMediaStreamDestination();
  const recorder = new MediaRecorder(destination.stream, {
    mimeType: 'audio/webm;codecs=opus',
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));
  });

  source.connect(destination);
  recorder.start();
  await video.play();

  // 等待播放完成
  await new Promise<void>((resolve) => {
    video.onended = () => resolve();
  });

  recorder.stop();
  const webmBlob = await finished;
  source.disconnect();
  await ctx.close();

  // webm (opus) → wav 16kHz mono
  const arrayBuf = await webmBlob.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  const maxAmp = getMaxAmplitude(audioBuf);
  console.log(`[audioExtractor]   HTML5 video 捕获: ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, ${audioBuf.duration.toFixed(1)}s, maxAmp=${maxAmp.toFixed(4)}`);
  if (maxAmp < 0.001) throw new Error('HTML5 video 捕获返回静音');

  // 重采样到目标采样率（用 encodeWav 输出 16kHz mono）
  const wavBlob = encodeWav(audioBuf);
  opts.onProgress(1.0);
  return wavBlob;
}
