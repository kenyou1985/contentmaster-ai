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
  //   - 视觉由 ShotSequence（视频 Sequence）通过 leadIn 重叠完成转场
  //   - 音频由 ShotAudioLayer 单独挂在顶层 Sequence，避免被 leadIn 重叠污染
  //   - leadIn：本镜头"前面"被下一镜头覆盖进来的帧数（视觉提前进入下一段）
  //   - leadOut：本镜头"末尾"被下一镜头覆盖的帧数
  //     等价于下一镜头的 leadIn；audio 在这段做 fadeOut
  const segments = useMemo(() => {
    type Segment = {
      shot: typeof shots[0];
      startFrame: number;            // 音频起点（绝对时间轴，不含 leadIn）
      leadInFrames: number;
      leadOutFrames: number;
      durationFrames: number;        // 视觉总时长（含 leadIn + leadOut + 主体）
      audioDurationFrames: number;   // 音频播完帧数
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

    // 2) 判断每段是否与"下一段"重叠（仅当本段有 out 转场 + 下一段有 in 转场时）
    // canOverlapNext[i] = 镜头 i 的"末尾"是否与镜头 i+1 重叠
    const canOverlapNext: boolean[] = shots.map((_, i) => {
      if (i >= shots.length - 1) return false;
      return toList[i] !== 'none' && tiList[i + 1] !== 'none';
    });

    // 3) 计算 startFrame 和 leadIn/leadOut
    const out: Segment[] = [];
    let cursor = 0;

    for (let i = 0; i < shots.length; i++) {
      const df = baseFrames[i];
      const leadIn = i > 0 && canOverlapNext[i - 1] ? effTfList[i] : 0;
      const leadOut = i < shots.length - 1 && canOverlapNext[i] ? effTfList[i + 1] : 0;

      // 主体段 = df；视觉总时长 = leadIn + df + leadOut
      // 注意：这里 leadIn 是"被上一镜头覆盖进来的"占位帧，
      //      leadOut 是"被下一镜头覆盖出去的"占位帧
      out.push({
        shot: shots[i],
        startFrame: cursor + introDurationFrames,
        leadInFrames: leadIn,
        leadOutFrames: leadOut,
        durationFrames: df + leadIn + leadOut,
        audioDurationFrames: df,
        transitionIn: tiList[i],
        transitionOut: toList[i],
        transitionFrames: effTfList[i],
      });

      // 下一个 cursor = 当前音频起点 + df - 下一镜头的 leadIn
      const nextLeadIn = i < shots.length - 1 && canOverlapNext[i] ? effTfList[i + 1] : 0;
      cursor += Math.max(1, df - nextLeadIn);
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

      {/* 音频层（独立 Sequence，绝对时间轴，不受视频 leadIn 重叠影响） */}
      {/* 在 leadIn/leadOut 区段做 fadeOut/fadeIn 实现音频 crossfade */}
      {segments.map(({ shot, startFrame, leadInFrames, leadOutFrames, audioDurationFrames }) => {
        if (!shot.audioUrl) return null;
        return (
          <ShotAudioLayer
            key={`audio-${shot.id}`}
            url={shot.audioUrl}
            startFrame={startFrame}
            leadInFrames={leadInFrames}
            leadOutFrames={leadOutFrames}
            audioDurationFrames={audioDurationFrames}
          />
        );
      })}

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