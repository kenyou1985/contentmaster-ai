import { AbsoluteFill, Sequence, useVideoConfig, useCurrentFrame, interpolate, Audio, staticFile } from 'remotion';
import { useMemo, type CSSProperties } from 'react';
import { ShotLayer } from './ShotLayer';
import { ShotSequence } from './ShotSequence';
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

  // 预先计算每个镜头的起始帧 / 时长 / 转场
  //
  // 关键修复（音频截断 + 字幕整段输出 bug）：
  // 旧逻辑通过 `durationFrames -= effTf` 让相邻 Sequence 重叠，但这会缩短当前
  // Sequence 的时长，进而让 <Audio> 在尾部被截断、字幕 cue 提前结束。
  // 新逻辑：每个镜头 Sequence 保持完整的音频时长，
  // 仅通过让下一镜头的 Sequence `from` 提前 leadInFrames 帧来形成画面重叠，
  // 这样音频 / 字幕 / 视觉都在自己的完整时长内，互不干扰。
  const segments = useMemo(() => {
    type Segment = {
      shot: typeof shots[0];
      startFrame: number;          // 视觉（音频）起点
      leadInFrames: number;         // 上一镜头重叠进来的帧数（视觉上提前进入）
      durationFrames: number;       // 镜头实际渲染时长（等于音频时长，不截断）
      transitionIn: import('../types').TransitionType;
      transitionOut: import('../types').TransitionType;
      transitionFrames: number;
    };
    const out: Segment[] = [];
    let cursor = 0;
    const transitionGlobal = config.transition?.type ?? DEFAULT_TRANSITION;
    const transitionSec = config.transition?.duration ?? DEFAULT_TRANSITION_FRAMES / 30;
    const transitionFrames = Math.max(0, Math.round(transitionSec * fps));
    const useGlobalTransition = transitionGlobal !== 'none' && transitionFrames > 0;

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const duration = getShotDuration(shot);
      let durationFrames = Math.max(1, Math.round(duration * fps));

      // 单镜头转场优先；否则用全局
      const ti = (shot.transitionIn as any) || (useGlobalTransition ? transitionGlobal : 'none');
      const to = (shot.transitionOut as any) || (useGlobalTransition ? transitionGlobal : 'none');
      // 把 transitionFrames 限制为 durationFrames/2，避免转场吃掉整段
      const effTf = Math.min(transitionFrames, Math.floor(durationFrames / 2));

      // 当前镜头是否作为"下一段"与上一镜头重叠？
      // 仅当上一镜头有出场转场（out）且本镜头有入场转场（in）时重叠
      const prev = i > 0 ? shots[i - 1] : null;
      const prevOut = prev ? ((prev as any).transitionOut as any) || (useGlobalTransition ? transitionGlobal : 'none') : 'none';
      const canOverlap = i > 0 && prevOut !== 'none' && ti !== 'none';
      const leadInFrames = canOverlap ? effTf : 0;

      out.push({
        shot,
        startFrame: cursor + introDurationFrames,  // ★ 片头偏移
        leadInFrames,
        durationFrames,                  // ★ 保持完整时长，不截断音频
        transitionIn: ti,
        transitionOut: to,
        transitionFrames: effTf,
      });
      // 下一个镜头的视觉起点 = 当前终点 - 重叠量
      // 注意：片头已经通过 introDurationFrames 把所有镜头往后推了
      cursor += Math.max(1, durationFrames - leadInFrames);
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

      {/* 镜头序列（含转场，承载视频画面 + 音频） */}
      {/* sequenceFrom = 视觉起点 - leadInFrames：让本镜头在视觉上提前覆盖到上一镜头尾部，
          但 Sequence.durationInFrames 仍 = durationFrames + leadInFrames，保证音频完整不截断 */}
      {segments.map(({ shot, startFrame, leadInFrames, durationFrames, transitionIn, transitionOut, transitionFrames }) => {
        const sequenceFrom = Math.max(0, startFrame - leadInFrames);
        const sequenceDuration = durationFrames + leadInFrames;
        return (
          <Sequence
            key={shot.id}
            from={sequenceFrom}
            durationInFrames={sequenceDuration}
          >
            <ShotSequence
              shot={shot}
              durationInFrames={sequenceDuration}
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
          {segments.map(({ shot, startFrame, leadInFrames, durationFrames }) => {
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
                durationInFrames={durationFrames}
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