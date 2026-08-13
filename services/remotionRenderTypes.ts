/**
 * Remotion 视频合成导出 - 类型定义
 *
 * 与现有剪映导出共用的 Shot 数据结构，并扩展 Remotion 渲染所需的字段。
 */

/** 句子级 cue（用于无 word-level 数据时的均分时长字幕） */
export interface SubtitleCue {
  text: string;
  startFrame: number;
  endFrame: number;
  /** 该句包含的词级时间戳（仅 ASR 后端注入时存在） */
  words?: SubtitleWord[];
}

/** 词级 cue（ASR / Whisper 输出），用于卡拉 OK 着色和按发音切分 */
export interface SubtitleWord {
  text: string;
  /** 单词的视觉起始（毫秒，相对于整段音频） */
  startMs: number;
  /** 单词的视觉结束（毫秒） */
  endMs: number;
}

export interface RemotionShot {
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
  /** 渲染时长（秒），默认取 audioDurationExact，否则 4 */
  duration?: number;
  /** 服务器侧本地缓存路径（localMediaCacheService 提供） */
  localMediaPaths?: Array<{ url: string; localPath: string }>;
  /** 字幕文本（默认 caption） */
  text?: string;
  /**
   * 预计算的字幕 cue（句子级 + 词级）。
   * - 若提供：Remotion Subtitle 直接使用，**不再按标点切分、不再均分时长**
   * - 缺失时：回退到 sentence-split 均分方案
   */
  textCues?: SubtitleCue[];
  /** 单镜头滤镜（预留） */
  filter?: string;
  /** 入场转场（预留） */
  transitionIn?: string;
  /** 出场转场（预留） */
  transitionOut?: string;
  /** Ken Burns 动画类型 */
  motion?: 'none' | 'kenBurns' | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown' | 'push' | 'pull';
}

export interface RemotionBGMConfig {
  enabled: boolean;
  url?: string;
  /** 0~1 */
  volume?: number;
  /** 秒 */
  fadeIn?: number;
  /** 秒 */
  fadeOut?: number;
  /** 循环（默认 true） */
  loop?: boolean;
}

export interface RemotionSubtitleConfig {
  enabled: boolean;
  /**
   * 视觉风格
   * - default: 单色（按 color 字段）
   * - stroke: 带描边（TikTok 也算 stroke，加多色字）
   * - karaoke: 卡拉 OK（按 ASR 时间戳逐词染色）
   * - tiktok: TikTok 风（双色交替 + 弹簧缩放入场 + 强描边）
   */
  style: 'default' | 'stroke' | 'karaoke' | 'tiktok';
  position: 'top' | 'middle' | 'bottom';

  // 字号 / 颜色 / 字体
  fontSize?: number;            // 默认按分辨率自适应 (width/32)
  color?: string;               // 默认 #ffffff
  fontFamily?: string;          // 默认 PingFang SC / Microsoft YaHei
  fontWeight?: number | string; // 默认 700

  // 间距
  letterSpacing?: number;       // 像素，默认 0
  lineHeight?: number;          // 默认 1.4
  paddingX?: number;            // 水平内边距 px，默认 24
  paddingY?: number;            // 垂直内边距 px，默认 8

  // 描边
  strokeColor?: string;         // 默认 #000
  strokeWidth?: number;         // 默认 2

  // 阴影
  shadow?: boolean;             // 默认 true
  shadowBlur?: number;          // 默认 6
  shadowColor?: string;         // 默认 rgba(0,0,0,0.75)

  // 帧级淡入淡出
  fadeInFrames?: number;
  fadeOutFrames?: number;

  // ── TikTok / Karaoke 扩展 ──
  /** TikTok 风格的副色（与 color 交替） */
  altColor?: string;            // 默认 #ffe600
  /** TikTok 入场动画类型 */
  preset?: 'none' | 'spring';
}

export interface RemotionTemplateConfig {
  /**
   * 模板 id（与背景 / 镜头节奏 / 默认字号相关联）
   * - vertical_default / landscape_default / square_default / cinema_wide
   * - reels / tiktok / youtube_shorts / documentary_warm
   * - magazine / chinese_ink
   */
  id:
    | 'vertical_default'
    | 'landscape_default'
    | 'square_default'
    | 'cinema_wide'
    | 'reels'
    | 'tiktok'
    | 'youtube_shorts'
    | 'documentary_warm'
    | 'magazine'
    | 'chinese_ink';
  name: string;
  /** 推荐分辨率（覆盖 exportConfig.resolution） */
  resolution: '1280x720' | '1920x1080' | '1080x1920' | '1080x1080' | '2560x1080' | '3840x2160';
  /** 推荐字体 */
  fontFamily?: string;
  /** 推荐默认字幕字号（px @ 1080P） */
  defaultFontSize?: number;
  /** 推荐默认字幕颜色 */
  defaultColor?: string;
  /** 字幕默认位置：竖屏默认 'middle'（画面中段，避免被下方 UI 遮挡），横屏默认 'bottom' */
  defaultSubtitlePosition?: 'top' | 'middle' | 'bottom';
  /** 字幕字号缩放（竖屏需要更大字号，1.2 = +20%） */
  fontSizeScale?: number;
  /** 推荐的 Ken Burns 运动类型（竖屏模板默认 'kenBurnsStrong' 增强动感） */
  recommendedMotion?: 'none' | 'kenBurns' | 'kenBurnsStrong' | 'kenBurnsSlow' | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown' | 'push' | 'pull';
}

export interface RemotionExportConfig {
  template: RemotionTemplateConfig;
  resolution: '1280x720' | '1920x1080' | '1080x1920' | '1080x1080' | '2560x1080' | '3840x2160';
  fps: 24 | 30 | 60;
  codec: 'h264' | 'h265';
  bitrate?: string; // e.g. '5M'
  bgm: RemotionBGMConfig;
  subtitle: RemotionSubtitleConfig;
  /** 过渡（每个镜头之间） */
  transition?: { type: 'none' | 'fade' | 'slide' | 'zoom'; duration: number };
  /** 输出方式 */
  output: {
    target: 'browser' | 'download';
  };
  /**
   * 全局分镜运动预设（每个镜头的运动默认继承此值；单个镜头也可独立覆盖）
   * - kenBurns: Ken Burns 效果（轻微放大 1.0→1.08）
   * - kenBurnsStrong: 强力 Ken Burns（1.0→1.3，明显放大）
   * - kenBurnsSlow: 慢速 Ken Burns（更平滑的弹性曲线）
   * - none: 无运动（静止）
   * - zoomIn: 持续放大（1.0→1.3）
   * - zoomOut: 持续缩小（1.3→1.0）
   * - panLeft/Right/Up/Down: 平移
   * - push/pull: 推拉
   */
  motion?: 'none' | 'kenBurns' | 'kenBurnsStrong' | 'kenBurnsSlow' | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown' | 'push' | 'pull';
  /** M2 #7：字幕防遮挡 - 自动检测图片安全区，让字幕避开主体 */
  safeZoneDetection?: boolean;
  /** 预留字段 */
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

export interface RemotionExportOptions {
  draftName: string;
  shots: RemotionShot[];
  config: RemotionExportConfig;
  /** 本地缓存路径（优化：避免重新下载） */
  localMediaPaths?: Array<{ url: string; localPath: string }>;
}

export interface RemotionRenderResult {
  success: boolean;
  taskId: string;
  durationSec: number;
  videoDurationSec: number;
  videoSizeBytes: number;
  resolution: string;
  fps: number;
  outputUrl: string;
  outputTarget: string;
  cloudUrl?: string;
  format: 'mp4';
  message: string;
  error?: string;
}

export interface RemotionProgressInfo {
  progress: number;
  message: string;
  frame?: number;
  totalFrames?: number;
  /** 视频帧率 */
  fps?: number;
  /** 估算剩余时间（秒），由服务端基于已渲染帧数推算 */
  etaSec?: number;
}
