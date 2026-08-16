import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { type CSSProperties, useMemo, Fragment } from 'react';
import { buildSubtitleCues, splitTextToWords, type SubtitleCue, type SubtitleFullConfig, type SubtitleWord } from './subtitleCues';

interface SubtitleProps {
  text: string;
  durationInFrames: number;
  /**
   * 父级 Sequence 的 `from`（视觉起点）。用于在视频整体时间轴上定位。
   * 默认 0（兼容旧用法）。
   */
  offsetFrames?: number;
  /**
   * 外部预计算好的 cue 列表（可选）。若提供，则跳过内部按标点切句。
   * - 通常由上游服务（如 ASR/whisper）生成 word-level 时间戳后传入。
   * - 不传则自动按句级切分。
   */
  cues?: SubtitleCue[];
  config: SubtitleFullConfig;
}

/**
 * 字幕层（官方推荐：每句一个独立 <Sequence/>）
 *
 * 输入：text（caption）+ durationInFrames（镜头时长）
 * 输出：在镜头对应窗口内，按 cues 列表逐句渲染 → 每句一个 <Sequence>
 */
export const Subtitle: React.FC<SubtitleProps> = ({
  text,
  durationInFrames,
  offsetFrames = 0,
  cues: externalCues,
  config,
}) => {
  const { fps } = useVideoConfig();

  if (!config.enabled || durationInFrames <= 0) {
    return <AbsoluteFill style={{ pointerEvents: 'none' }} />;
  }

  const cues = useMemo(
    () => externalCues ?? buildSubtitleCues(text, durationInFrames, fps, undefined, config.chunking),
    [externalCues, text, durationInFrames, fps, config.chunking],
  );

  if (cues.length === 0) {
    return <AbsoluteFill style={{ pointerEvents: 'none' }} />;
  }

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {cues.map((cue, idx) => {
        const from = offsetFrames + cue.startFrame;
        const cueDuration = Math.max(1, cue.endFrame - cue.startFrame);
        return (
          <Sequence
            key={`${cue.startFrame}-${idx}`}
            from={from}
            durationInFrames={cueDuration}
            layout="none"
            name={`subtitle-${idx}`}
          >
            <CueLayer
              text={cue.text}
              words={cue.words}
              cueDurationInFrames={cueDuration}
              config={config}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

/**
 * 单句字幕层（被独立 Sequence 包裹）
 * - 处理该句的淡入淡出 / 位置 / 字号 / 描边 / 阴影
 * - TikTok 风：逐词交替颜色 + 弹簧入场
 * - Karaoke 风：按词级时间戳染色（无 words 时降级为 tiktok）
 */
const CueLayer: React.FC<{
  text: string;
  words?: SubtitleWord[];
  cueDurationInFrames: number;
  config: SubtitleFullConfig;
}> = ({ text, words, cueDurationInFrames, config }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  const fadeInFrames = config.fadeInFrames ?? 9;
  const fadeOutFrames = config.fadeOutFrames ?? 9;

  const fadeIn = interpolate(frame, [0, fadeInFrames], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const fadeOut = interpolate(
    frame,
    [Math.max(0, cueDurationInFrames - fadeOutFrames), cueDurationInFrames],
    [1, 0],
    { extrapolateLeft: 'clamp' },
  );
  const opacity = Math.min(fadeIn, fadeOut);

  // 弹簧入场（TikTok 启用）
  const useSpringEntry = config.style === 'tiktok' || config.style === 'karaoke';
  const enter = useSpringEntry && (config.preset ?? 'spring') !== 'none'
    ? spring({ frame, fps, config: { damping: 14, stiffness: 180, mass: 0.7 } })
    : 1;
  const entryTransform = useSpringEntry && (config.preset ?? 'spring') !== 'none'
    ? `scale(${0.88 + enter * 0.12})`
    : undefined;

  // ── 通用样式（位置 / 字号 / 描边 / 阴影）──
  // M2 #7：如果提供了 safeZone，按其计算字幕位置（自动避开主体）
  const effectivePosition = config.safeZone?.preferredPosition ?? config.position;
  const safeZoneTop = config.safeZone?.top;
  const safeZoneBottom = config.safeZone?.bottom;
  const positionStyle: CSSProperties = {
    top: effectivePosition === 'top'
      ? safeZoneTop != null ? `${safeZoneTop * 100}%` : '8%'
      : effectivePosition === 'middle' ? '50%' : 'auto',
    bottom: effectivePosition === 'bottom'
      ? safeZoneBottom != null ? `${(1 - safeZoneBottom) * 100}%` : '10%'
      : 'auto',
    transform:
      effectivePosition === 'middle'
        ? `translateY(-50%) ${entryTransform ?? ''}`
        : entryTransform,
    transformOrigin: 'center center',
  };

  const fontSize = config.fontSize ?? Math.round(width / 28);
  const paddingX = config.paddingX ?? 24;
  const paddingY = config.paddingY ?? 8;

  const shadow = config.shadow !== false;
  const shadowCss = shadow
    ? `0 2px ${config.shadowBlur ?? 6}px ${config.shadowColor ?? 'rgba(0,0,0,0.75)'}`
    : 'none';

  const baseColor = config.color ?? '#ffffff';
  const altColor = config.altColor ?? '#ffe600';
  const strokeColor = config.strokeColor ?? '#000';
  const isVisualStyle = config.style === 'tiktok' || config.style === 'karaoke' || config.style === 'stroke';
  const strokeWidth = config.strokeWidth ?? (isVisualStyle ? 4 : 2);

  const baseStyle: CSSProperties = {
    fontSize,
    fontWeight: config.fontWeight ?? 800,
    fontFamily:
      config.fontFamily ||
      '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif',
    textAlign: 'center',
    lineHeight: config.lineHeight ?? 1.4,
    letterSpacing: config.letterSpacing ?? 0,
    padding: `${paddingY}px ${paddingX}px`,
    maxWidth: '88%',
    margin: '0 auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    textShadow: shadowCss,
    WebkitTextStroke: isVisualStyle ? `${strokeWidth}px ${strokeColor}` : undefined,
  };

  // ── 渲染分支 ──
  if (config.style === 'karaoke') {
    return (
      <div style={{ position: 'absolute', left: 0, right: 0, ...positionStyle }}>
        <KaraokeSubtitle text={text} words={words} config={config} baseStyle={baseStyle} opacity={opacity} frame={frame} fps={fps} />
      </div>
    );
  }

  if (config.style === 'tiktok') {
    return (
      <div style={{ position: 'absolute', left: 0, right: 0, ...positionStyle }}>
        <TikTokSubtitle text={text} config={config} baseStyle={baseStyle} opacity={opacity} />
      </div>
    );
  }

  // default / stroke
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, ...positionStyle }}>
      <div style={{ ...baseStyle, color: baseColor, opacity }}>{text}</div>
    </div>
  );
};

/**
 * TikTok 风：逐词交替颜色。
 * - 中文按标点/4字分词；英文按空格分词
 * - 相邻词交替 baseColor / altColor
 */
const TikTokSubtitle: React.FC<{
  text: string;
  config: SubtitleFullConfig;
  baseStyle: CSSProperties;
  opacity: number;
}> = ({ text, config, baseStyle, opacity }) => {
  const baseColor = config.color ?? '#ffffff';
  const altColor = config.altColor ?? '#ffe600';
  const words = splitTextToWords(text);

  return (
    <div style={{ ...baseStyle, color: baseColor, opacity }}>
      {words.map((word, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span style={{ color: i % 2 === 0 ? baseColor : altColor }}>
            {word}
          </span>
        </Fragment>
      ))}
    </div>
  );
};

/**
 * Karaoke 风：基于 words 时间戳逐词染色。
 * - 有 words：按词级时间戳，已读 altColor（红色），未读 baseColor（白色）
 * - 无 words：降级为逐词交替 TikTok 效果
 */
const KaraokeSubtitle: React.FC<{
  text: string;
  words?: SubtitleWord[];
  config: SubtitleFullConfig;
  baseStyle: CSSProperties;
  opacity: number;
  frame: number;
  fps: number;
}> = ({ text, words, config, baseStyle, opacity, frame, fps }) => {
  const baseColor = config.color ?? '#ffffff';
  const altColor = config.altColor ?? '#ff3b30';

  // 无词级时间戳 → 降级为逐词交替 TikTok 效果
  if (!words || words.length === 0) {
    return (
      <TikTokSubtitle
        text={text}
        config={config}
        baseStyle={baseStyle}
        opacity={opacity}
      />
    );
  }

  // 有词级时间戳 → 卡拉 OK 染色
  const nowMs = (frame / fps) * 1000;

  return (
    <div style={{ ...baseStyle, color: baseColor, opacity }}>
      {words.map((w, i) => {
        const isRead = nowMs >= w.endMs;
        return (
          <Fragment key={i}>
            {i > 0 && ' '}
            <span style={{ color: isRead ? altColor : baseColor }}>
              {w.text}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
};
