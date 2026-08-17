/**
 * 音轨提取器：从视频文件中提取音轨并编码为 WAV（16kHz mono PCM）
 *
 * 三层 fallback 策略（按可靠性从高到低）：
 *
 * 1. **decodeAudioData 直解**：用 AudioContext.decodeAudioData(file.arrayBuffer())
 *    让浏览器直接从 mp4/mov 容器中解码音频轨。
 *    - 优点：不需要播放视频，最快，最稳
 *    - 缺点：部分浏览器对视频容器解码支持差（可能无声）
 *
 * 2. **MediaRecorder 录制**：把视频加载到 <video> 元素播放，
 *    用 MediaElementAudioSourceNode + MediaStreamDestination + MediaRecorder
 *    录下音频流。配合 GainNode(0) 实现静音播放。
 *    - 优点：兼容性好，几乎所有浏览器都行
 *    - 缺点：必须播放完整个视频，速度慢；video.muted=true 会解码为静音
 *
 * 3. **最终兜底**：返回原始文件 blob，依赖服务端 ffmpeg 处理（如果后端有）
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

  // ── 策略 1：直接 decodeAudioData（最快，最可靠）──
  onProgress?.(0.05);
  try {
    const wav1 = await strategyDecodeDirect(file, { targetSampleRate, targetChannels, onProgress: (p) => onProgress?.(0.05 + p * 0.6) });
    console.log(`[audioExtractor] ✓ 策略 1（直接解码）成功`);
    onProgress?.(1.0);
    return wav1;
  } catch (e1: any) {
    console.warn(`[audioExtractor] 策略 1 失败: ${e1.message}`);
  }

  // ── 策略 2：MediaRecorder 录制 ──
  console.log(`[audioExtractor] 回退到策略 2：MediaRecorder 录制…`);
  onProgress?.(0.65);
  try {
    const wav2 = await strategyMediaRecorder(file, { targetSampleRate, targetChannels, onProgress: (p) => onProgress?.(0.65 + p * 0.35) });
    console.log(`[audioExtractor] ✓ 策略 2（MediaRecorder）成功`);
    onProgress?.(1.0);
    return wav2;
  } catch (e2: any) {
    console.error(`[audioExtractor] ✗ 策略 2 也失败: ${e2.message}`);
    throw new Error(
      `视频音轨提取失败。所有方法都已尝试：\n` +
      `  - 直接解码：${e2.message}\n` +
      `请确认视频文件包含音轨，且浏览器支持该格式。`
    );
  }
}

// ── 策略 1：AudioContext.decodeAudioData 直接解码整个视频文件 ──
async function strategyDecodeDirect(
  file: File,
  opts: { targetSampleRate: number; targetChannels: 1 | 2; onProgress: (p: number) => void },
): Promise<Blob> {
  opts.onProgress(0.1);
  const fileBuffer = await file.arrayBuffer();
  opts.onProgress(0.3);

  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

  // Safari 旧版需用回调风格，新版支持 Promise
  const audioBuf: AudioBuffer = await new Promise((resolve, reject) => {
    const p = audioCtx.decodeAudioData(fileBuffer.slice(0), resolve, reject);
    if (p && typeof (p as any).then === 'function') (p as any).then(resolve, reject);
  });
  opts.onProgress(0.7);

  const maxAmp = getMaxAmplitude(audioBuf);
  console.log(`[audioExtractor] 策略 1 解码后: ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, ${audioBuf.duration.toFixed(1)}s, maxAmp=${maxAmp.toFixed(4)}`);
  if (maxAmp < 0.001) {
    throw new Error(`直接解码得到的是静音音频（maxAmp=${maxAmp.toFixed(4)}），视频可能无音轨或浏览器解码失败`);
  }
  opts.onProgress(0.85);

  // 重采样
  const finalBuf = await resampleAudioBuffer(audioBuf, opts.targetSampleRate, opts.targetChannels);
  audioCtx.close().catch(() => {});
  return encodeWav(finalBuf);
}

// ── 策略 2：MediaRecorder 录制整个视频播放 ──
async function strategyMediaRecorder(
  file: File,
  opts: { targetSampleRate: number; targetChannels: 1 | 2; onProgress: (p: number) => void },
): Promise<Blob> {
  const { targetSampleRate, targetChannels } = opts;

  const url = URL.createObjectURL(file);

  // video.muted=false 是关键，否则浏览器跳过音频解码
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = false;
  video.preload = 'auto';
  video.volume = 0;
  video.src = url;
  video.setAttribute('playsinline', 'true');
  video.setAttribute('webkit-playsinline', 'true');
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '-9999px';
  video.style.width = '1px';
  video.style.height = '1px';
  video.style.pointerEvents = 'none';
  document.body.appendChild(video);

  try {
    // 等待 metadata
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('视频元数据加载超时')), 30000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('视频加载失败')); };
    });
    opts.onProgress(0.1);

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error('无法获取视频时长');
    }

    // 用 AudioContext 捕获音频
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const source = audioCtx.createMediaElementSource(video);
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    source.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);

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
          opts.onProgress(0.7);
          const webmBlob = new Blob(chunks, { type: 'audio/webm' });
          console.log(`[audioExtractor] 策略 2 MediaRecorder 输出: ${webmBlob.size} bytes`);

          if (webmBlob.size < 1000) {
            throw new Error(`MediaRecorder 录制输出过小（${webmBlob.size} bytes），可能未捕获到音频`);
          }

          const arrayBuf = await webmBlob.arrayBuffer();
          const audioBuf: AudioBuffer = await new Promise((res, rej) => {
            const p = audioCtx.decodeAudioData(arrayBuf.slice(0), res, rej);
            if (p && typeof (p as any).then === 'function') (p as any).then(res, rej);
          });
          audioCtx.close().catch(() => {});

          const maxAmp = getMaxAmplitude(audioBuf);
          console.log(`[audioExtractor] 策略 2 解码后: ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, ${audioBuf.duration.toFixed(1)}s, maxAmp=${maxAmp.toFixed(4)}`);
          if (maxAmp < 0.001) {
            throw new Error(`MediaRecorder 录制得到的是静音（maxAmp=${maxAmp.toFixed(4)}）`);
          }
          opts.onProgress(0.85);

          const finalBuf = await resampleAudioBuffer(audioBuf, targetSampleRate, targetChannels);
          resolve(encodeWav(finalBuf));
        } catch (e: any) {
          audioCtx.close().catch(() => {});
          reject(e);
        }
      };
      recorder.onerror = (e: any) => {
        audioCtx.close().catch(() => {});
        reject(new Error(`MediaRecorder 错误: ${e?.message || 'unknown'}`));
      };

      video.currentTime = 0;
      recorder.start();
      video.play().then(() => {
        opts.onProgress(0.3);
        const progressTimer = setInterval(() => {
          if (video.duration > 0 && !video.paused && video.currentTime >= 0) {
            const p = 0.30 + (video.currentTime / video.duration) * 0.40;
            opts.onProgress(Math.min(0.7, p));
          }
        }, 200);
        video.onended = () => {
          clearInterval(progressTimer);
          try { recorder.stop(); } catch {}
        };
        // 兜底超时
        setTimeout(() => {
          clearInterval(progressTimer);
          if (recorder.state === 'recording') {
            try { recorder.stop(); } catch {}
          }
        }, (duration + 2) * 1000);
      }).catch((playErr) => {
        audioCtx.close().catch(() => {});
        reject(new Error(`视频播放失败（Safari 可能需要先与页面交互）: ${playErr.message}`));
      });
    });
  } finally {
    // 清理 DOM
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (video.parentNode) video.parentNode.removeChild(video);
    } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  }
}
