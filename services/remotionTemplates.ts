import type { RemotionTemplateConfig } from './remotionRenderTypes';

/**
 * Remotion 模板清单
 * - 每种模板推荐一组默认值（分辨率 / 字体 / 字幕字号 / 颜色）
 * - 选择模板时自动套用到 RemotionExportConfig
 */
export const REMOTION_TEMPLATES: RemotionTemplateConfig[] = [
  {
    id: 'vertical_default',
    name: '竖屏默认（1080×1920）',
    resolution: '1080x1920',
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
    defaultFontSize: 56,
    defaultColor: '#ffffff',
    defaultSubtitlePosition: 'middle',
    fontSizeScale: 1.25,
    recommendedMotion: 'kenBurnsStrong',
  },
  {
    id: 'landscape_default',
    name: '横屏默认（1920×1080）',
    resolution: '1920x1080',
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
    defaultFontSize: 48,
    defaultColor: '#ffffff',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.0,
    recommendedMotion: 'kenBurns',
  },
  {
    id: 'square_default',
    name: '方形（1080×1080）',
    resolution: '1080x1080',
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    defaultFontSize: 50,
    defaultColor: '#ffffff',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.05,
    recommendedMotion: 'kenBurns',
  },
  {
    id: 'cinema_wide',
    name: '电影宽幅（2560×1080）',
    resolution: '2560x1080',
    fontFamily: '"Source Han Sans SC","Noto Sans CJK SC",sans-serif',
    defaultFontSize: 44,
    defaultColor: '#f5e9c8',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.0,
    recommendedMotion: 'kenBurnsSlow',
  },
  {
    id: 'reels',
    name: 'Instagram Reels（1080×1920）',
    resolution: '1080x1920',
    fontFamily: '"Inter","Helvetica Neue","PingFang SC",sans-serif',
    defaultFontSize: 60,
    defaultColor: '#ffffff',
    defaultSubtitlePosition: 'middle',
    fontSizeScale: 1.3,
    recommendedMotion: 'kenBurnsStrong',
  },
  {
    id: 'tiktok',
    name: 'TikTok（1080×1920）',
    resolution: '1080x1920',
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    defaultFontSize: 62,
    defaultColor: '#ffffff',
    defaultSubtitlePosition: 'middle',
    fontSizeScale: 1.35,
    recommendedMotion: 'kenBurnsStrong',
  },
  {
    id: 'youtube_shorts',
    name: 'YouTube Shorts（1080×1920）',
    resolution: '1080x1920',
    fontFamily: '"Roboto","Noto Sans CJK SC",sans-serif',
    defaultFontSize: 58,
    defaultColor: '#ffffff',
    defaultSubtitlePosition: 'middle',
    fontSizeScale: 1.3,
    recommendedMotion: 'kenBurns',
  },
  {
    id: 'documentary_warm',
    name: '纪录片暖色（1920×1080）',
    resolution: '1920x1080',
    fontFamily: '"Source Han Serif SC","Noto Serif CJK SC",serif',
    defaultFontSize: 46,
    defaultColor: '#fff2d6',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.0,
    recommendedMotion: 'kenBurnsSlow',
  },
  {
    id: 'magazine',
    name: '杂志感（1080×1350 偏方形）',
    resolution: '1080x1080',
    fontFamily: '"Helvetica Neue","PingFang SC",sans-serif',
    defaultFontSize: 52,
    defaultColor: '#ffffff',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.05,
    recommendedMotion: 'kenBurns',
  },
  {
    id: 'chinese_ink',
    name: '国风水墨（1920×1080）',
    resolution: '1920x1080',
    fontFamily: '"STKaiti","KaiTi","Songti SC",serif',
    defaultFontSize: 50,
    defaultColor: '#f8f4e3',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.0,
    recommendedMotion: 'kenBurnsSlow',
  },
];

export function getTemplateById(id: string): RemotionTemplateConfig | undefined {
  return REMOTION_TEMPLATES.find(t => t.id === id);
}

/**
 * 根据模板给出推荐的默认转场。
 * 电影宽幅 / 国风水墨 → fade
 * TikTok / Reels / Shorts → zoom（节奏快）
 * 其余 → slide
 */
export function getTemplateDefaultTransition(id: string): 'fade' | 'slide' | 'zoom' {
  if (id === 'cinema_wide' || id === 'chinese_ink' || id === 'documentary_warm') return 'fade';
  if (id === 'tiktok' || id === 'reels' || id === 'youtube_shorts') return 'zoom';
  return 'slide';
}