/**
 * 音轨提取器：从视频文件中提取音轨并编码为 WAV（16kHz mono PCM）
 *
 * 三层 fallback 策略（按可靠性从高到低）：
 *
 * 1. **@audio/decode（首选）**：用纯 WASM/JS 解码器（FAAD2 等）直接从 mp4/m4a/mov
 *    容器解码 AAC/ALAC/Opus 等浏览器不能解码的音频 codec。
 *    - 优点：跨浏览器一致，能解码浏览器 WebAudio 解不开的格式
 *    - 缺点：不能解码视频/音频混在 webm/mkv 的复杂容器（这些走策略 2）
 *
 * 2. **decodeAudioData 直解**：用 AudioContext.decodeAudioData(file.arrayBuffer())
 *    让浏览器直接从 mp4/mov 容器中解码音频轨。
 *    - 优点：不需要播放视频，最快，最稳
 *    - 缺点：部分浏览器对视频容器解码支持差
 *
 * 3. **MediaRecorder 录制**：把视频加载到 <video> 元素播放，
 *    用 MediaElementAudioSourceNode + MediaStreamDestination + MediaRecorder
 *    录下音频流。配合 GainNode(0) 实现静音播放。
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

  // ── 策略 1：@audio/decode（首选，能解码浏览器不能解码的 codec）──
  onProgress?.(0.05);
  try {
    const wav1 = await strategyWasmDecode(file, {
      targetSampleRate,
      targetChannels,
      onProgress: (p) => onProgress?.(0.05 + p * 0.55),  // 0.05 → 0.60
    });
    console.log(`[audioExtractor] ✓ 策略 1（@audio/decode）成功`);
    onProgress?.(1.0);
    return wav1;
  } catch (e1: any) {
    console.warn(`[audioExtractor] 策略 1 失败: ${e1.message?.slice(0, 200)}`);
  }

  // ── 策略 2：AudioContext.decodeAudioData 直解 ──
  console.log(`[audioExtractor] 回退到策略 2：decodeAudioData 直解…`);
  onProgress?.(0.65);
  try {
    const wav2 = await strategyDecodeDirect(file, {
      targetSampleRate,
      targetChannels,
      onProgress: (p) => onProgress?.(0.65 + p * 0.25),  // 0.65 → 0.90
    });
    console.log(`[audioExtractor] ✓ 策略 2（decodeAudioData）成功`);
    onProgress?.(1.0);
    return wav2;
  } catch (e2: any) {
    console.warn(`[audioExtractor] 策略 2 失败: ${e2.message?.slice(0, 200)}`);
  }

  // ── 策略 3：MediaRecorder 录制整个视频播放 ──
  console.log(`[audioExtractor] 回退到策略 3：MediaRecorder 录制…`);
  onProgress?.(0.90);
  try {
    const wav3 = await strategyMediaRecorder(file, {
      targetSampleRate,
      targetChannels,
      onProgress: (p) => onProgress?.(0.90 + p * 0.10),
    });
    console.log(`[audioExtractor] ✓ 策略 3（MediaRecorder）成功`);
    onProgress?.(1.0);
    return wav3;
  } catch (e3: any) {
    console.error(`[audioExtractor] ✗ 所有策略都失败: ${e3.message?.slice(0, 200)}`);
    throw new Error(
      `视频音轨提取失败。所有方法都已尝试（WASM / WebAudio / MediaRecorder）。\n` +
      `最后错误：${e3.message?.slice(0, 200)}\n` +
      `请确认视频文件包含音轨。`
    );
  }
}

// ── 策略 1：@audio/decode（首选）──
//    优点：能解码 AAC/ALAC/Opus 等浏览器 WebAudio 解不开的 codec
//    缺点：要下载 WASM（约 400KB，但缓存后无影响）
async function strategyWasmDecode(
  file: File,
  opts: { targetSampleRate: number; targetChannels: 1 | 2; onProgress: (p: number) => void },
): Promise<Blob> {
  opts.onProgress(0.1);

  // 动态 import（Vite 自动 code-split，单独 chunk）
  const mod: any = await import('@audio/decode');
  const decode = mod.default || mod.decode || mod;
  if (typeof decode !== 'function') {
    throw new Error('@audio/decode default export is not a function');
  }

  opts.onProgress(0.3);
  const fileBuffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(fileBuffer);
  opts.onProgress(0.5);

  console.log(`[audioExtractor] 策略 1 调用 @audio/decode (${(uint8.length / 1024 / 1024).toFixed(2)} MB)`);
  // @audio/decode 会按文件头自动检测格式（mp4/m4a/webm/mp3/wav/...）
  const { channelData, sampleRate }: { channelData: Float32Array[]; sampleRate: number } = await decode(uint8);
  opts.onProgress(0.9);

  if (!channelData || channelData.length === 0) {
    throw new Error('@audio/decode 返回空 channelData（可能是不支持的容器）');
  }
  // 校验是否真的是音频
  let maxAmp = 0;
  for (const ch of channelData) {
    const chData = ch as Float32Array;
    for (let i = 0; i < Math.min(chData.length, 10000); i++) {
      if (Math.abs(chData[i]) > maxAmp) maxAmp = Math.abs(chData[i]);
    }
  }
  console.log(`[audioExtractor] 策略 1 解码后: ${channelData.length}ch @ ${sampleRate}Hz, maxAmp=${maxAmp.toFixed(4)}`);
  if (maxAmp < 0.001) {
    throw new Error(`@audio/decode 解码得到的是静音（maxAmp=${maxAmp.toFixed(4)}）`);
  }

  // channelData 是 Float32Array[]，构造虚拟 AudioBuffer 用于重采样
  const numFrames = channelData[0].length;
  const virtualBuffer = {
    numberOfChannels: channelData.length,
    length: numFrames,
    sampleRate,
    duration: numFrames / sampleRate,
    getChannelData: (ch: number) => channelData[ch],
  } as unknown as AudioBuffer;

  // 重采样到目标采样率和声道
  const finalBuf = await resampleAudioBuffer(virtualBuffer, opts.targetSampleRate, opts.targetChannels);
  return encodeWav(finalBuf);
}

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

      let settled = false;
      // 保护 play() 不被 pause() 中断（race condition）
      // 注意：video.pause() 不在 finally 里调用，只在成功/失败后才清理
      const safeReject = (e: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(progressTimer);
        try { recorder.stop(); } catch {}
        reject(e);
      };
      const safeResolve = (b: Blob) => {
        if (settled) return;
        settled = true;
        clearInterval(progressTimer);
        resolve(b);
      };
      // 劫持 onstop/onerror 以使用 safe wrapper
      recorder.onstop = async () => {
        try {
          opts.onProgress(0.7);
          const webmBlob = new Blob(chunks, { type: 'audio/webm' });
          console.log(`[audioExtractor] 策略 2 MediaRecorder 输出: ${webmBlob.size} bytes`);
          if (webmBlob.size < 1000) {
            throw new Error(`MediaRecorder 输出过小（${webmBlob.size} bytes）`);
          }
          const arrayBuf = await webmBlob.arrayBuffer();
          const audioBuf: AudioBuffer = await new Promise((res, rej) => {
            const p = audioCtx.decodeAudioData(arrayBuf.slice(0), res, rej);
            if (p && typeof (p as any).then === 'function') (p as any).then(res, rej);
          });
          audioCtx.close().catch(() => {});
          const maxAmp = getMaxAmplitude(audioBuf);
          console.log(`[audioExtractor] 策略 2 解码后: ${audioBuf.numberOfChannels}ch @ ${audioBuf.sampleRate}Hz, maxAmp=${maxAmp.toFixed(4)}`);
          if (maxAmp < 0.001) {
            throw new Error(`MediaRecorder 录制得到的是静音（maxAmp=${maxAmp.toFixed(4)}）`);
          }
          opts.onProgress(0.85);
          const finalBuf = await resampleAudioBuffer(audioBuf, targetSampleRate, targetChannels);
          safeResolve(encodeWav(finalBuf));
        } catch (e: any) {
          audioCtx.close().catch(() => {});
          safeReject(e);
        }
      };
      recorder.onerror = (e: any) => {
        audioCtx.close().catch(() => {});
        safeReject(new Error(`MediaRecorder 错误: ${e?.message || 'unknown'}`));
      };

      video.currentTime = 0;
      recorder.start();

      let progressTimer: any = null;
      video.play().then(() => {
        opts.onProgress(0.3);
        progressTimer = setInterval(() => {
          if (video.duration > 0 && !video.paused && video.currentTime >= 0) {
            const p = 0.30 + (video.currentTime / video.duration) * 0.40;
            opts.onProgress(Math.min(0.7, p));
          }
        }, 200);
        video.onended = () => {
          try { recorder.stop(); } catch {}
        };
        // 兜底超时
        setTimeout(() => {
          if (recorder.state === 'recording') {
            try { recorder.stop(); } catch {}
          }
        }, (duration + 2) * 1000);
      }).catch((playErr) => {
        audioCtx.close().catch(() => {});
        safeReject(new Error(`视频播放失败（Safari 可能需要先与页面交互）: ${playErr.message}`));
      });
    });
  } finally {
    // 清理 DOM（注意：不在这里 pause，否则会中断 play promise）
    try {
      video.removeAttribute('src');
      video.load();
      if (video.parentNode) video.parentNode.removeChild(video);
    } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  }
}
