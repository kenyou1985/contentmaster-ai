import { AbsoluteFill, Sequence, useVideoConfig, useCurrentFrame, interpolate, Audio, staticFile } from 'remotion';
import { useMemo, type CSSProperties } from 'react';
import { ShotLayer } from './ShotLayer';
import { ShotSequence } from './ShotSequence';
import { ShotAudioLayer } from './ShotAudioLayer';
import { Subtitle } from './Subtitle';
import { IntroLayer } from './IntroLayer';
import { getShotDuration, RemotionInputProps } from '../types';
import type { SubtitleCue } from './subtitleCues';

/**
 * 把 mmedia/... 路径转换为 staticFile URL
 * - data: URL 保持不变
 * - http/https URL 保持不变
 */
function resolveMediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
    return url;
  }
  try {
    return staticFile(url);
  } catch {
    return url;
  }
}

const DEFAULT_TRANSITION = 'fade';
const DEFAULT_TRANSITION_FRAMES = 12; // ≈ 0.4s @ 30fps

/**
 * 计算片头总时长（帧）
 */
function getIntroDurationFrames(config: RemotionInputProps['config'], fps: number): number {
  const intro = config.intro;
  if (!intro?.style || intro.style === 'none') return 0;
  // 从 RemotionInputConfig.intro 读取预设默认时长
  const PRESET_DURATIONS: Record<string, number> = {
    fade_in: 2.5,
    slide_up: 2.0,
    typewriter: 3.5,
    glitch: 2.0,
    zoom_in: 2.0,
    split: 2.5,
  };
  const introDurationSec = intro.duration ?? PRESET_DURATIONS[intro.style] ?? 2.0;
  return Math.round(introDurationSec * fps);
}

export const MyVideo: React.FC<RemotionInputProps> = ({ shots, config }) => {
  const { fps, durationInFrames: compositionDurationFrames } = useVideoConfig();

  // 片头总时长
  const introDurationFrames = getIntroDurationFrames(config, fps);

  // 镜头时间轴计算
  //   - 视觉（视频 Sequence）按 leadIn 重叠做转场
  //   - 音频（ShotAudioLayer）严格不重叠：每个镜头音频在前一个镜头音频结束后立即开始
  //     audioStartFrame[i] = audioStartFrame[i-1] + audioDurationFrames[i-1]
  //   - 这样：
  //     * 音频文件开头/末尾完整保留（用户反馈："今天"不能丢）
  //     * 镜头切换时不会出现音频重叠噪音（用户反馈：末尾和开头叠加）
  //     * 代价：B 音频比 B 视频晚 leadIn_B 帧开始（约 0.4s），
  //       因为视频提前了 leadIn 帧做视觉转场，而音频在前一个镜头音频结束后才开始
  //     * 听感上：视频画面先出现 ~0.4s 后才有新镜头音频，可接受
  //
  // v1.10：自定义素材成片模式（custom tracks）下，多个镜头共享同一个 audioUrl
  //   （用户上传一整段音频）。如果对每个镜头都播一遍同一个音频，会出现重复播放。
  //   检测方法：所有 shots 的 audioUrl 都相同 → 视为「共享音频」，改为全局单次播放。
  //   - isSharedAudio = true：用 SharedAudioLayer 在 frame 0 播放一次，duration = 全长
  //   - isSharedAudio = false：保持原有 per-shot 行为
  const isSharedAudio = useMemo(() => {
    const urls = shots.map((s) => s.audioUrl).filter(Boolean);
    if (urls.length < 2) return false;
    const first = urls[0];
    return urls.every((u) => u === first);
  }, [shots]);

  // 共享音频的总时长（用第一个 shot 的 audioDurationSec，或最后一个 shot 的结束时间）
  const sharedAudioDurationSec = useMemo(() => {
    if (!isSharedAudio) return 0;
    const first = shots[0];
    return (first as any).audioDurationSec || (first as any).audioDurationExact || 0;
  }, [isSharedAudio, shots]);

  const segments = useMemo(() => {
    type Segment = {
      shot: typeof shots[0];
      startFrame: number;            // 视频 Sequence 起点（含 leadIn）
      leadInFrames: number;
      leadOutFrames: number;
      durationFrames: number;        // 视觉总时长
      audioDurationFrames: number;
      audioStartFrame: number;       // 音频 Sequence 起点（与前一个音频严格不重叠）
      transitionIn: import('../types').TransitionType;
      transitionOut: import('../types').TransitionType;
      transitionFrames: number;
    };

    const transitionGlobal = config.transition?.type ?? DEFAULT_TRANSITION;
    const transitionSec = config.transition?.duration ?? DEFAULT_TRANSITION_FRAMES / 30;
    const transitionFrames = Math.max(0, Math.round(transitionSec * fps));
    const useGlobalTransition = transitionGlobal !== 'none' && transitionFrames > 0;

    // 1) 先算出每个镜头的"基础时长 + 有效转场帧数 + 是否有入场转场"
    const baseFrames: number[] = [];
    const effTfList: number[] = [];
    const tiList: import('../types').TransitionType[] = [];
    const toList: import('../types').TransitionType[] = [];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const df = Math.max(1, Math.round(getShotDuration(shot) * fps));
      baseFrames.push(df);

      const ti = ((shot as any).transitionIn as any) || (useGlobalTransition ? transitionGlobal : 'none');
      const to = ((shot as any).transitionOut as any) || (useGlobalTransition ? transitionGlobal : 'none');
      const effTf = Math.min(transitionFrames, Math.floor(df / 2));
      effTfList.push(effTf);
      tiList.push(ti);
      toList.push(to);
    }

    // 2) 判断每段是否与"下一段"重叠
    const canOverlapNext: boolean[] = shots.map((_, i) => {
      if (i >= shots.length - 1) return false;
      return toList[i] !== 'none' && tiList[i + 1] !== 'none';
    });

    // 3) 计算 startFrame / leadIn / leadOut / audioStartFrame
    const out: Segment[] = [];
    let cursor = 0;
    let audioCursor = 0;  // 音频时间轴上的累计位置（不带 leadIn）

    for (let i = 0; i < shots.length; i++) {
      const df = baseFrames[i];
      const leadIn = i > 0 && canOverlapNext[i - 1] ? effTfList[i] : 0;
      const leadOut = i < shots.length - 1 && canOverlapNext[i] ? effTfList[i + 1] : 0;

      out.push({
        shot: shots[i],
        startFrame: cursor + introDurationFrames,
        leadInFrames: leadIn,
        leadOutFrames: leadOut,
        durationFrames: df + leadIn + leadOut,
        audioDurationFrames: df,
        audioStartFrame: audioCursor + introDurationFrames,  // ★ 音频严格不重叠
        transitionIn: tiList[i],
        transitionOut: toList[i],
        transitionFrames: effTfList[i],
      });

      // 下一个 cursor = 当前音频起点 + df - 下一镜头的 leadIn（视觉重叠）
      const nextLeadIn = i < shots.length - 1 && canOverlapNext[i] ? effTfList[i + 1] : 0;
      cursor += Math.max(1, df - nextLeadIn);
      audioCursor += df;  // ★ 音频时间轴累加 df，不减 nextLeadIn
    }

    return out;
  }, [shots, fps, config.transition, introDurationFrames]);

  if (segments.length === 0) {
    return (
      <AbsoluteFill style={{ backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <p style={{ color: '#888' }}>No shots to render</p>
      </AbsoluteFill>
    );
  }

  // 字幕配置
  const subtitleEnabled = config.subtitle?.enabled !== false;
  const subtitleCfg = {
    enabled: subtitleEnabled,
    style: (config.subtitle?.style || 'default') as 'default' | 'stroke' | 'karaoke' | 'tiktok',
    position: (config.subtitle?.position || 'bottom') as 'top' | 'middle' | 'bottom',
    fontSize: config.subtitle?.fontSize,
    color: config.subtitle?.color,
    fontFamily: config.subtitle?.fontFamily,
    fontWeight: config.subtitle?.fontWeight,
    letterSpacing: config.subtitle?.letterSpacing,
    lineHeight: config.subtitle?.lineHeight,
    paddingX: config.subtitle?.paddingX,
    paddingY: config.subtitle?.paddingY,
    strokeColor: config.subtitle?.strokeColor,
    strokeWidth: config.subtitle?.strokeWidth,
    shadow: config.subtitle?.shadow,
    shadowBlur: config.subtitle?.shadowBlur,
    shadowColor: config.subtitle?.shadowColor,
    fadeInFrames: config.subtitle?.fadeInFrames,
    fadeOutFrames: config.subtitle?.fadeOutFrames,
    altColor: config.subtitle?.altColor,
    preset: (config.subtitle?.preset || 'spring') as 'none' | 'spring',
    /** v1.10：字幕切分模式（'sentence' | 'word' | 'none'） */
    chunking: (config.subtitle?.chunking || 'sentence') as 'sentence' | 'word' | 'none',
    /** 字幕安全区（自动避开主体/重要物品） */
    safeZone: (config.subtitle as any)?.safeZone,
  };

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* 背景音乐：从 frame 0 开始播放（覆盖片头），尾部淡出 */}
      {config.bgm?.enabled && config.bgm.url && (
        <BgmLayer
          url={config.bgm.url}
          volume={config.bgm.volume ?? 0.3}
          loop={config.bgm.loop ?? true}
          fadeInSec={config.bgm.fadeIn ?? 0}
          fadeOutSec={config.bgm.fadeOut ?? 0}
          compositionDurationFrames={compositionDurationFrames}
          fps={fps}
        />
      )}

      {/* 片头（从帧 0 开始） */}
      {introDurationFrames > 0 && (
        <IntroLayer
          introConfig={config.intro}
          offsetFrames={0}
        />
      )}

      {/* 音频层（独立 Sequence，每个镜头音频在前一个镜头音频结束后立即开始，
          不参与视频 leadIn 重叠 — 避免末尾和开头音频重叠） */}
      {/* v1.10：当所有 shots 共享同一音频 URL（自定义素材成片），
          改为全局单次播放，避免每个镜头都从头重复播放同一个音频。 */}
      {isSharedAudio && shots[0]?.audioUrl && sharedAudioDurationSec > 0 ? (
        <Sequence
          key="shared-audio"
          from={0}
          durationInFrames={Math.max(
            1,
            Math.round(sharedAudioDurationSec * fps) +
              // 加点 buffer 防止尾部被截断
              Math.round(0.5 * fps)
          )}
        >
          <SharedAudioLayer
            url={shots[0].audioUrl}
            volume={1}
          />
        </Sequence>
      ) : (
        segments.map(({ shot, audioStartFrame, audioDurationFrames }) => {
          if (!shot.audioUrl) return null;
          return (
            <ShotAudioLayer
              key={`audio-${shot.id}`}
              url={shot.audioUrl}
              startFrame={audioStartFrame}
              audioDurationFrames={audioDurationFrames}
            />
          );
        })
      )}

      {/* 镜头序列（视频画面 + 转场） */}
      {/* sequenceFrom = startFrame - leadInFrames：让本镜头在视觉上提前覆盖到上一镜头尾部，
          Sequence.durationInFrames = durationFrames（含 leadIn + leadOut），保证音频完整不截断 */}
      {segments.map(({ shot, startFrame, leadInFrames, leadOutFrames, durationFrames, transitionIn, transitionOut, transitionFrames }) => {
        const sequenceFrom = Math.max(0, startFrame - leadInFrames);
        return (
          <Sequence
            key={shot.id}
            from={sequenceFrom}
            durationInFrames={durationFrames}
          >
            <ShotSequence
              shot={shot}
              durationInFrames={durationFrames}
              transitionIn={transitionIn}
              transitionOut={transitionOut}
              transitionFrames={transitionFrames}
              globalMotion={config.motion}
              globalFilter={config.videoFilter}
            />
          </Sequence>
        );
      })}

      {/* 字幕层（每句一个独立 <Sequence/>，放在最外层时间轴上） */}
      {/* 关键：不能嵌套在镜头 Sequence 内 —— Remotion 会把内部 Sequence 的 from 当作相对偏移，
          而非视频整体时间轴位置。放在 AbsoluteFill 顶层，from 就是绝对帧。 */}
      {subtitleEnabled && (
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          {segments.map(({ shot, startFrame, leadInFrames, leadOutFrames, audioDurationFrames }) => {
            const sequenceFrom = Math.max(0, startFrame - leadInFrames);
            // 优先使用 shot 上预计算的 textCues（来自 Whisper ASR 等）
            const externalCues = (shot as any).textCues as SubtitleCue[] | undefined;
            // M2 #7：每个 shot 单独的安全区（自动避开主体）
            const shotSafeZone = (shot as any).safeZone;
            const cfgWithSafeZone = shotSafeZone
              ? { ...subtitleCfg, safeZone: shotSafeZone }
              : subtitleCfg;
            return (
              <Subtitle
                key={`sub-${shot.id}`}
                text={shot.text || shot.caption}
                durationInFrames={audioDurationFrames}
                offsetFrames={sequenceFrom}
                config={cfgWithSafeZone}
                cues={externalCues}
              />
            );
          })}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

/**
 * 共享音频层（v1.10）
 * - 适用于「自定义素材成片」场景：多个镜头共享同一个 audioUrl（用户上传一整段音频）
 * - 与 ShotAudioLayer 的区别：ShotAudioLayer 每个 shot 都从头播放同一份音频（导致重复）
 * - 本组件只在 frame 0 播放一次，覆盖整个视频时长
 */
const SharedAudioLayer: React.FC<{
  url: string;
  volume?: number;
}> = ({ url, volume = 1 }) => {
  const src = resolveMediaUrl(url) || url;
  return <Audio src={src} volume={volume} />;
};

/**
 * 背景音乐层
 * - 包裹在 <Sequence from={0} durationInFrames={duration}> 内，强制从 frame 0 开始播放
 * - 这样片头阶段也有 BGM，不会出现"静音片头"
 * - 支持首尾淡入淡出（fadeIn / fadeOut）
 */
const BgmLayer: React.FC<{
  url: string;
  volume: number;
  loop: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  compositionDurationFrames: number;
  fps: number;
}> = ({ url, volume, loop, fadeInSec, fadeOutSec, compositionDurationFrames, fps }) => {
  const frame = useCurrentFrame();
  const src = resolveMediaUrl(url) || url;

  const fadeInFrames = Math.max(0, Math.round(fadeInSec * fps));
  const fadeOutFrames = Math.max(0, Math.round(fadeOutSec * fps));
  const total = compositionDurationFrames;

  // 淡入：前 fadeInFrames 帧从 0 升到目标 volume
  const fadeIn = fadeInFrames > 0
    ? interpolate(frame, [0, fadeInFrames], [0, 1], { extrapolateRight: 'clamp' })
    : 1;
  // 淡出：最后 fadeOutFrames 帧从 1 降到 0
  const fadeOut = fadeOutFrames > 0
    ? interpolate(frame, [Math.max(0, total - fadeOutFrames), total], [1, 0], { extrapolateLeft: 'clamp' })
    : 1;

  const finalVolume = Math.max(0, Math.min(1, volume * Math.min(fadeIn, fadeOut)));

  return (
    <Sequence from={0} durationInFrames={total}>
      <Audio src={src} volume={finalVolume} loop={loop} />
    </Sequence>
  );
};