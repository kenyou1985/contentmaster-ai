/**
 * 音轨提取器：从视频文件中提取音轨并编码为 WAV（16kHz mono PCM）
 *
 * 工作原理：
 *  1. 把视频文件加载到隐藏的 <video> 元素（HTMLMediaElement）
 *  2. 用 AudioContext + MediaElementAudioSourceNode + MediaStreamDestination 捕获音频流
 *  3. 用 MediaRecorder 把音频流录为 webm blob
 *  4. 把 webm 解码为 AudioBuffer，再用 OfflineAudioContext 重采样到目标采样率和声道
 *  5. 编码为 WAV 格式 Blob（服务端 ASR 只接受 wav/mp3）
 *
 * 兼容性：
 *  - Chrome/Edge：完全支持
 *  - Safari 14+：支持（需要 muted=true 才能解码音频）
 *  - Firefox：支持
 *
 * 用途：
 *  - 用户上传视频作为配音源 → 自动提取音轨做 Whisper ASR
 *  - 不依赖 ffmpeg（纯前端 Web Audio API）
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
 * 从视频文件中提取音频并编码为 WAV Blob
 *
 * @param file    视频文件
 * @param opts    选项（采样率、声道、进度回调）
 * @returns       WAV 格式的 Blob
 */
export async function extractAudioFromVideo(
  file: File,
  opts: ExtractOptions = {},
): Promise<Blob> {
  const {
    targetSampleRate = 16000,
    targetChannels = 1,
    onProgress,
  } = opts;

  onProgress?.(0.05);
  const url = URL.createObjectURL(file);

  // 1. 加载视频到 <video> 元素
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;  // 必须 muted 才能用 Web Audio API 解码
  video.preload = 'auto';
  video.src = url;

  // 等待元数据
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error(`视频加载失败: ${file.name}`));
  });

  onProgress?.(0.15);
  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) {
    URL.revokeObjectURL(url);
    throw new Error('无法获取视频时长');
  }

  // 2. 用实时 AudioContext + MediaElementSource 捕获音频流
  //    然后用 MediaRecorder 把音频流录下来，存为 webm blob
  //    再用 decodeAudioData + OfflineAudioContext 离线重采样到目标格式
  //    注意：OfflineAudioContext 没有 createMediaElementSource，
  //    所以第一步必须用 AudioContext（实时）
  let audioCtx: AudioContext;
  try {
    audioCtx = new AudioContext({ sampleRate: 48000 });
  } catch {
    audioCtx = new AudioContext();
  }
  const source = audioCtx.createMediaElementSource(video);
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(dest);
  // 同时接到 ctx.destination 让 video 静音播放（Safari 需要）
  source.connect(audioCtx.destination);

  // 用 MediaRecorder 录制为 webm
  const recorder = new MediaRecorder(dest.stream, {
    mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm',
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  return new Promise<Blob>((resolve, reject) => {
    recorder.onstop = async () => {
      try {
        onProgress?.(0.7);
        const webmBlob = new Blob(chunks, { type: 'audio/webm' });

        // 把 webm 解码为 AudioBuffer，再用 OfflineAudioContext 重采样到目标格式
        const arrayBuf = await webmBlob.arrayBuffer();
        // Safari 上 decodeAudioData 必须是回调风格（旧版）
        const audioBuf: AudioBuffer = await new Promise((res, rej) => {
          const p = audioCtx.decodeAudioData(arrayBuf.slice(0), res, rej);
          if (p && typeof (p as any).then === 'function') (p as any).then(res, rej);
        });
        URL.revokeObjectURL(url);

        onProgress?.(0.85);

        // 重采样到目标采样率和声道
        let finalBuf = audioBuf;
        if (audioBuf.sampleRate !== targetSampleRate || audioBuf.numberOfChannels !== targetChannels) {
          finalBuf = await resampleAudioBuffer(audioBuf, targetSampleRate, targetChannels);
        }

        const wav = encodeWav(finalBuf);
        onProgress?.(1.0);
        resolve(wav);
      } catch (e: any) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    recorder.onerror = (e: any) => {
      URL.revokeObjectURL(url);
      reject(new Error(`录制失败: ${e?.message || 'unknown'}`));
    };

    video.currentTime = 0;
    video.muted = true;
    recorder.start();
    video.play().then(() => {
      onProgress?.(0.3);
      video.onended = () => recorder.stop();
      // 兜底超时：视频播放结束事件可能丢失，设置 video.duration + 2s 后强制停止
      setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, (duration + 2) * 1000);
    }).catch((playErr) => {
      URL.revokeObjectURL(url);
      reject(new Error(`视频播放失败: ${playErr.message}`));
    });
  });
}

/**
 * 重采样 AudioBuffer 到目标采样率和声道数
 */
async function resampleAudioBuffer(
  buffer: AudioBuffer,
  targetSampleRate: number,
  targetChannels: 1 | 2,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(
    targetChannels,
    Math.ceil(buffer.duration * targetSampleRate),
    targetSampleRate,
  );

  // 如果源是多声道，先 downmix 到目标声道
  const source = ctx.createBufferSource();
  if (buffer.numberOfChannels !== targetChannels) {
    // downmix
    const mixed = ctx.createBuffer(targetChannels, buffer.length, buffer.sampleRate);
    for (let ch = 0; ch < targetChannels; ch++) {
      const data = mixed.getChannelData(ch);
      if (buffer.numberOfChannels === 1) {
        data.set(buffer.getChannelData(0));
      } else {
        // 平均
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
 *
 * WAV 文件头结构：
 *  - RIFF 头（12 字节）
 *  - fmt 块（24 字节）：采样率、声道、位深
 *  - data 块（8 字节 + PCM 数据）
 */
export function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM samples (interleaved for multi-channel)
  let offset = 44;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }
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
  // 已是 mp3 等：直接返回，服务端能处理
  return blob;
}
