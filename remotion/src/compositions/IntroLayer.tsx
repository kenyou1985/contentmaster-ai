/**
 * Remotion 片头渲染层
 * - 支持 6 种预设片头动画
 * - 通过 config.intro 配置：{ style, text, duration }
 * - 片头时长独立于总视频时长，最后叠加
 */
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { type CSSProperties } from 'react';
import { IntroStyle, getIntroStyleById } from './IntroTemplates';

interface IntroLayerProps {
  introConfig?: {
    style?: string;
    text?: string;
    duration?: number;
    textColor?: string;
    bgColor?: string;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number | string;
  };
  offsetFrames: number;
}

/** fade_in: 黑底文字渐显 */
const FadeInIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, Math.round(durationFrames * 0.4)], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.7), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeIn, fadeOut);
  const scale = interpolate(frame, [0, durationFrames], [1.02, 1.0], { extrapolateRight: 'clamp' });
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 20);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ opacity, transform: `scale(${scale})`, transition: 'none' }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '85%',
            textShadow: `0 2px 8px rgba(0,0,0,0.8)`,
            letterSpacing: 4,
          }}>
            {text}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** slide_up: 从底部弹入 */
const SlideUpIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const slideIn = spring({ frame, fps, config: { damping: 12, stiffness: 160, mass: 0.8 } });
  const fadeIn = interpolate(frame, [0, Math.round(durationFrames * 0.3)], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.75), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeIn, fadeOut);
  const translateY = interpolate(slideIn, [0, 1], [80, 0]);
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 18);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ opacity, transform: `translateY(${translateY}px)` }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '85%',
            textShadow: `0 4px 20px rgba(0,0,0,0.9)`,
            letterSpacing: 2,
          }}>
            {text}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** typewriter: 一字一字打出来 */
const TypewriterIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const charCount = text.length;
  const typeDuration = Math.round(durationFrames * 0.6);
  const visibleChars = charCount > 0
    ? interpolate(frame, [0, typeDuration], [0, charCount], { extrapolateRight: 'clamp' })
    : 0;
  const isFull = frame >= typeDuration;
  const fadeOut = isFull
    ? interpolate(frame, [typeDuration, durationFrames], [1, 0], { extrapolateRight: 'clamp' })
    : 1;
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 22);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;
  const displayed = text.slice(0, Math.floor(visibleChars));
  const showCursor = !isFull && Math.floor(frame / (fps * 0.15)) % 2 === 0;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ opacity: fadeOut }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '90%',
            letterSpacing: 1,
          }}>
            {displayed}
            {showCursor && <span style={{ opacity: 0.8 }}>|</span>}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** glitch: 赛博故障风 */
const GlitchIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const glitchPhase = frame % (fps * 0.3);
  const isGlitch = glitchPhase < fps * 0.08;
  const offsetX = isGlitch ? (Math.random() - 0.5) * 16 : 0;
  const offsetY = isGlitch ? (Math.random() - 0.5) * 8 : 0;
  const scale = interpolate(frame, [0, durationFrames], [1.1, 1.0], { extrapolateRight: 'clamp' });
  const fadeIn = interpolate(frame, [0, Math.round(durationFrames * 0.2)], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.75), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeIn, fadeOut);
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 16);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ opacity, transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`, position: 'relative' }}>
        {text && (
          <>
            <div style={{
              color,
              fontSize,
              fontFamily,
              fontWeight,
              textAlign: 'center',
              maxWidth: '85%',
              textShadow: isGlitch ? `2px 0 #0ff, -2px 0 #f0f, 0 0 20px rgba(255,255,255,0.3)` : `2px 2px 0 rgba(0,0,0,0.8)`,
              WebkitTextStroke: isGlitch ? '1px rgba(0,255,255,0.4)' : undefined,
            }}>
              {text}
            </div>
            {isGlitch && (
              <>
                <div style={{
                  color: '#0ff',
                  fontSize,
                  fontFamily,
                  fontWeight,
                  textAlign: 'center',
                  maxWidth: '85%',
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translateX(-50%) translateX(3px)',
                  opacity: 0.6,
                  clipPath: 'inset(30% 0 40% 0)',
                }}>
                  {text}
                </div>
                <div style={{
                  color: '#f0f',
                  fontSize,
                  fontFamily,
                  fontWeight,
                  textAlign: 'center',
                  maxWidth: '85%',
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translateX(-50%) translateX(-3px)',
                  opacity: 0.6,
                  clipPath: 'inset(60% 0 10% 0)',
                }}>
                  {text}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** zoom_in: 从小放大淡入 */
const ZoomIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationFrames], [0.4, 1.0], { extrapolateRight: 'clamp' });
  const fadeIn = interpolate(frame, [0, Math.round(durationFrames * 0.3)], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.75), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeIn, fadeOut);
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 20);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ opacity, transform: `scale(${scale})`, transformOrigin: 'center center' }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '85%',
            textShadow: `0 2px 16px rgba(0,0,0,0.9)`,
            letterSpacing: 4,
          }}>
            {text}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** split: 左右分屏向中间合拢 */
const SplitIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const splitDuration = Math.round(durationFrames * 0.5);
  const progress = interpolate(frame, [0, splitDuration], [0, 1], { extrapolateRight: 'clamp' });
  const fadeIn = interpolate(frame, [0, Math.round(durationFrames * 0.2)], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.75), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeIn, fadeOut);
  const halfW = width / 2;
  const leftX = interpolate(progress, [0, 1], [-halfW, 0]);
  const rightX = interpolate(progress, [0, 1], [halfW, 0]);
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 20);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, overflow: 'hidden' }}>
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '50%',
        height: '100%',
        backgroundColor: bgColor,
        transform: `translateX(${leftX}px)`,
        opacity,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingRight: 8,
      }} />
      <div style={{
        position: 'absolute',
        top: 0,
        left: '50%',
        width: '50%',
        height: '100%',
        backgroundColor: bgColor,
        transform: `translateX(${rightX}px)`,
        opacity,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingLeft: 8,
      }} />
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%)`, opacity }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '85%',
            textShadow: `0 2px 16px rgba(0,0,0,0.9)`,
            letterSpacing: 4,
          }}>
            {text}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** slide_left: 从左侧横向滑入 */
const SlideLeftIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const slideIn = spring({ frame, fps, config: { damping: 14, stiffness: 140, mass: 0.9 } });
  const fadeIn = interpolate(frame, [0, Math.round(durationFrames * 0.3)], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.75), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeIn, fadeOut);
  const translateX = interpolate(slideIn, [0, 1], [-width * 0.6, 0]);
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 18);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ opacity, transform: `translateX(${translateX}px)` }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '85%',
            textShadow: `0 4px 20px rgba(0,0,0,0.9)`,
            letterSpacing: 2,
          }}>
            {text}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** rotate_in: 旋转放大入场 */
const RotateIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const rotateIn = spring({ frame, fps, config: { damping: 16, stiffness: 120, mass: 1.0 } });
  const fadeIn = interpolate(frame, [0, Math.round(durationFrames * 0.3)], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.75), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeIn, fadeOut);
  const rotate = interpolate(rotateIn, [0, 1], [-180, 0]);
  const scale = interpolate(rotateIn, [0, 1], [0.3, 1.0]);
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 20);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{
        opacity,
        transform: `rotate(${rotate}deg) scale(${scale})`,
        transformOrigin: 'center center',
      }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '85%',
            textShadow: `0 4px 24px rgba(0,0,0,0.9)`,
            letterSpacing: 3,
          }}>
            {text}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** blur_focus: 模糊到清晰 */
const BlurFocusIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  const blur = interpolate(frame, [0, Math.round(durationFrames * 0.7)], [20, 0], { extrapolateRight: 'clamp' });
  const fadeIn = interpolate(frame, [0, Math.round(durationFrames * 0.4)], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.75), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const opacity = Math.min(fadeIn, fadeOut);
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 20);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ opacity, filter: `blur(${blur}px)` }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '85%',
            textShadow: `0 2px 12px rgba(0,0,0,0.8)`,
            letterSpacing: 4,
          }}>
            {text}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** flash_white: 白闪入场 */
const FlashWhiteIntro: React.FC<{
  text: string; introStyle: IntroStyle; introConfig?: IntroLayerProps['introConfig'];
  fps: number; width: number; durationFrames: number;
}> = ({ text, introStyle, introConfig, fps, width, durationFrames }) => {
  const frame = useCurrentFrame();
  // 前 1/4：白屏闪一下（cover from white）
  const flashDuration = Math.round(durationFrames * 0.25);
  const flashOpacity = frame < flashDuration
    ? interpolate(frame, [0, flashDuration * 0.4, flashDuration], [1, 1, 0], { extrapolateRight: 'clamp' })
    : 0;
  // 文字：从大变小 + 渐显
  const textProgress = spring({ frame, fps, config: { damping: 18, stiffness: 140, mass: 0.9 } });
  const textFadeIn = interpolate(frame, [flashDuration * 0.4, flashDuration], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [Math.round(durationFrames * 0.75), durationFrames], [1, 0], { extrapolateRight: 'clamp' });
  const textOpacity = Math.min(textFadeIn, fadeOut);
  const textScale = interpolate(textProgress, [0, 1], [1.4, 1.0]);
  const bgColor = introConfig?.bgColor ?? introStyle.bgColor;
  const color = introConfig?.textColor ?? introStyle.textColor;
  const fontSize = introConfig?.fontSize ?? Math.round(width / 18);
  const fontFamily = introConfig?.fontFamily ?? introStyle.fontFamily;
  const fontWeight = introConfig?.fontWeight ?? introStyle.fontWeight;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, justifyContent: 'center', alignItems: 'center' }}>
      {/* 白闪遮罩 */}
      <AbsoluteFill style={{ backgroundColor: '#ffffff', opacity: flashOpacity }} />
      {/* 文字 */}
      <div style={{ opacity: textOpacity, transform: `scale(${textScale})` }}>
        {text && (
          <div style={{
            color,
            fontSize,
            fontFamily,
            fontWeight,
            textAlign: 'center',
            maxWidth: '85%',
            textShadow: `0 2px 8px rgba(255,255,255,0.5)`,
            letterSpacing: 4,
          }}>
            {text}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

// ── 渲染器注册表（必须在所有组件定义之后）──────────────────────

const INTRO_RENDERERS = {
  fade_in: FadeInIntro,
  slide_up: SlideUpIntro,
  typewriter: TypewriterIntro,
  glitch: GlitchIntro,
  zoom_in: ZoomIntro,
  split: SplitIntro,
  slide_left: SlideLeftIntro,
  rotate_in: RotateIntro,
  blur_focus: BlurFocusIntro,
  flash_white: FlashWhiteIntro,
} as const;

/**
 * 片头总容器
 */
export const IntroLayer: React.FC<IntroLayerProps> = ({ introConfig, offsetFrames }) => {
  const { fps, width } = useVideoConfig();
  const style = introConfig?.style ?? 'none';
  const text = introConfig?.text ?? '';
  const introStyle = getIntroStyleById(style);

  if (!introStyle || style === 'none' || introStyle.duration <= 0) {
    return <></>;
  }

  const introDurationSec = introConfig?.duration ?? introStyle.duration;
  const introDurationFrames = Math.max(1, Math.round(introDurationSec * fps));

  const Renderer = INTRO_RENDERERS[style as keyof typeof INTRO_RENDERERS];
  if (!Renderer) return <></>;

  return (
    <Sequence
      from={offsetFrames}
      durationInFrames={introDurationFrames}
      layout="none"
      name="intro"
    >
      <Renderer
        text={text}
        introStyle={introStyle}
        introConfig={introConfig}
        fps={fps}
        width={width}
        durationFrames={introDurationFrames}
      />
    </Sequence>
  );
};
