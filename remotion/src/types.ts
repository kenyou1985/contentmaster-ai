/**
 * Remotion 输入参数（inputProps）类型定义
 * 与前端 services/remotionRenderTypes.ts 中的类型保持一致
 */
import type { CSSProperties } from 'react';

export interface RemotionInputWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface RemotionInputCue {
  text: string;
  startFrame: number;
  endFrame: number;
  words?: RemotionInputWord[];
}

export interface RemotionInputShot {
  id: string;
  number: number;
  caption: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  audioUrl?: string;
  voiceoverAudioUrl?: string;
  audioDurationSec?: number;
  audioDurationExact?: number;
  duration?: number;
  text?: string;
  /**
   * 预计算的字幕 cue 列表（每句的起止帧 + 可选 words）。
   * - 提供时：Subtitle 直接使用，跳过内部按标点切分 + 等分时长
   * - 不传：回退到 subtitleCues.buildSubtitleCues（按标点切句 + 等分）
   */
  textCues?: RemotionInputCue[];
  filter?: string;
  transitionIn?: TransitionType;
  transitionOut?: TransitionType;
  /**
   * 镜头级视频滤镜（优先级高于全局 videoFilter）
   * 支持: blur / brightness / contrast / saturation / exposure / temperature / hue / grayscale / opacity
   */
  videoFilter?: RemotionInputVideoFilter;
  /**
   * Ken Burns 运动类型（图片镜头有效）
   * 支持:
   *   none | kenBurns | kenBurnsStrong | kenBurnsSlow | kenBurnsLinear
   *   zoomIn | zoomOut | panLeft | panRight | panUp | panDown
   *   push | pull | rotateCW | rotateCCW
   */
  motion?: 'none' | 'kenBurns' | 'kenBurnsStrong' | 'kenBurnsSlow' | 'kenBurnsLinear'
    | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown'
    | 'push' | 'pull' | 'rotateCW' | 'rotateCCW';
}

/**
 * 镜头转场类型
 * 支持：
 *   none | fade | slide | wipe | flip | clockWipe | iris
 *   zoomBlur | dreamyZoom | crossZoom | filmBurn | ripple | pushCut | dissolve
 */
export type TransitionType =
  | 'none'
  | 'fade'
  | 'slide'
  | 'wipe'
  | 'flip'
  | 'clockWipe'
  | 'iris'
  | 'zoomBlur'
  | 'dreamyZoom'
  | 'crossZoom'
  | 'filmBurn'
  | 'ripple'
  | 'pushCut'
  | 'dissolve';

export interface RemotionInputVideoFilter {
  /** 高斯模糊半径（0 = 无） */
  blur?: number;
  /** 亮度（1 = 原始，>1 变亮，<1 变暗） */
  brightness?: number;
  /** 对比度（1 = 原始，>1 提高，<1 降低） */
  contrast?: number;
  /** 饱和度（1 = 原始，0 = 灰度，>1 提高） */
  saturation?: number;
  /** 曝光档位（0 = 原始，正数提亮，负数压暗） */
  exposure?: number;
  /** 色温（正数偏暖，负数偏冷） */
  temperature?: number;
  /** 色调偏移（-180~180） */
  hue?: number;
  /** 黑白（0-1，1 = 完全灰度） */
  grayscale?: number;
  /** 透明度（0 = 完全透明，1 = 完全不透明） */
  opacity?: number;
}

export interface RemotionInputBGM {
  enabled: boolean;
  url?: string;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
}

export interface RemotionInputSubtitle {
  enabled: boolean;
  style: 'default' | 'stroke' | 'karaoke' | 'tiktok';
  position: 'top' | 'middle' | 'bottom';
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  fontWeight?: number | string;
  letterSpacing?: number;
  lineHeight?: number;
  paddingX?: number;
  paddingY?: number;
  strokeColor?: string;
  strokeWidth?: number;
  shadow?: boolean;
  shadowBlur?: number;
  shadowColor?: string;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  altColor?: string;
  preset?: 'none' | 'spring';
}

export interface RemotionInputConfig {
  template: { id: string; name: string };
  resolution: string;
  fps: number;
  codec: 'h264' | 'h265';
  bitrate?: string;
  bgm: RemotionInputBGM;
  subtitle: RemotionInputSubtitle;
  transition?: { type: TransitionType; duration: number };
  output?: { target: string };
  /**
   * 全局视频滤镜（图片/视频镜头均适用）
   * 支持: blur / brightness / contrast / saturation / exposure / temperature / hue / grayscale / opacity
   */
  videoFilter?: RemotionInputVideoFilter;
  /**
   * 全局分镜运动预设（每个镜头的运动默认继承此值；单个镜头也可独立覆盖）
   * 支持:
   *   none | kenBurns | kenBurnsStrong | kenBurnsSlow | kenBurnsLinear
   *   zoomIn | zoomOut | panLeft | panRight | panUp | panDown
   *   push | pull | rotateCW | rotateCCW
   */
  motion?: 'none' | 'kenBurns' | 'kenBurnsStrong' | 'kenBurnsSlow' | 'kenBurnsLinear'
    | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown'
    | 'push' | 'pull' | 'rotateCW' | 'rotateCCW';
  /**
   * 片头预设
   * - style: none | fade_in | slide_up | typewriter | glitch | zoom_in | split
   * - text: 片头显示文字（可空）
   * - duration: 自定义时长（秒），留空则用预设默认值
   */
  intro?: {
    style?: string;
    text?: string;
    duration?: number;
    textColor?: string;
    bgColor?: string;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number | string;
  };
  outro?: { url?: string; duration?: number };
  watermark?: { url?: string; position?: string; opacity?: number };
}

export type RemotionInputPropsType = {
  shots: RemotionInputShot[];
  config: RemotionInputConfig;
} & Record<string, unknown>;

/** Alias for Remotion API */
export type RemotionInputProps = RemotionInputPropsType;

/**
 * 默认镜头时长（秒），当音频时长无法获取时使用
 */
export const DEFAULT_SHOT_DURATION_SEC = 4;

/**
 * 计算单个镜头的渲染时长（秒）
 */
export function getShotDuration(shot: RemotionInputShot): number {
  if (typeof shot.duration === 'number' && shot.duration > 0) return shot.duration;
  if (typeof shot.audioDurationExact === 'number' && shot.audioDurationExact > 0) {
    return shot.audioDurationExact;
  }
  if (typeof shot.audioDurationSec === 'number' && shot.audioDurationSec > 0) {
    return shot.audioDurationSec;
  }
  return DEFAULT_SHOT_DURATION_SEC;
}

/**
 * 把分辨率字符串拆成宽高
 */
export function parseResolution(res: string): { width: number; height: number } {
  const [w, h] = res.split('x').map(Number);
  return { width: w || 1920, height: h || 1080 };
}
