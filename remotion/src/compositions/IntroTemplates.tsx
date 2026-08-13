/**
 * Remotion 片头预设系统
 *
 * 支持的片头类型：
 * - fade_in:        纯色淡入
 * - slide_up:      从底部滑入
 * - typewriter:     逐字打字机效果
 * - glitch:        故障风（抖动感）
 * - zoom_in:       从小放大淡入
 * - split:         分裂入场
 *
 * 每个片头包含：
 * - duration:      片头持续秒数
 * - text?:         显示文字（如无则无文字层）
 * - fontSize:      字号
 * - fontFamily:    字体
 * - color:         文字颜色
 * - bgColor:       背景色
 */

export interface IntroStyle {
  /** 唯一 ID */
  id: string;
  /** 中文名称 */
  name: string;
  /** 描述 */
  desc: string;
  /** 持续秒数 */
  duration: number;
  /** 是否需要文字 */
  hasText: boolean;
  /** 默认背景色 */
  bgColor: string;
  /** 默认文字色 */
  textColor: string;
  /** 默认字号（px，相对于 1920 宽） */
  fontSize: number;
  /** 默认字体 */
  fontFamily: string;
  /** 默认字重 */
  fontWeight: number | string;
  /** 最低推荐分辨率 */
  minResolution?: string;
}

export const INTRO_STYLES: IntroStyle[] = [
  {
    id: 'none',
    name: '无片头',
    desc: '直接开始第一镜',
    duration: 0,
    hasText: false,
    bgColor: '#000000',
    textColor: '#ffffff',
    fontSize: 64,
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    fontWeight: 700,
  },
  {
    id: 'fade_in',
    name: '纯色淡入',
    desc: '黑底渐显标题，淡雅开场',
    duration: 2.5,
    hasText: true,
    bgColor: '#0a0a0a',
    textColor: '#ffffff',
    fontSize: 72,
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    fontWeight: 700,
  },
  {
    id: 'slide_up',
    name: '底部滑入',
    desc: '标题从底部弹入，节奏感强',
    duration: 2.0,
    hasText: true,
    bgColor: '#1a1a2e',
    textColor: '#ffe600',
    fontSize: 80,
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    fontWeight: 800,
  },
  {
    id: 'typewriter',
    name: '打字机',
    desc: '一字一字打出来，适合引用/金句',
    duration: 3.5,
    hasText: true,
    bgColor: '#0d1117',
    textColor: '#58a6ff',
    fontSize: 64,
    fontFamily: '"JetBrains Mono","Fira Code","PingFang SC",monospace',
    fontWeight: 400,
  },
  {
    id: 'glitch',
    name: '故障风',
    desc: '赛博故障风格，科技感强',
    duration: 2.0,
    hasText: true,
    bgColor: '#000000',
    textColor: '#ff2d55',
    fontSize: 88,
    fontFamily: '"Impact","Arial Black",sans-serif',
    fontWeight: 900,
  },
  {
    id: 'zoom_in',
    name: '从大变小',
    desc: '从小圆到大，冲击力强',
    duration: 2.0,
    hasText: true,
    bgColor: '#111111',
    textColor: '#ffffff',
    fontSize: 72,
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    fontWeight: 700,
  },
  {
    id: 'split',
    name: '分裂入场',
    desc: '左右分屏向中间合拢',
    duration: 2.5,
    hasText: true,
    bgColor: '#1a1a1a',
    textColor: '#ffffff',
    fontSize: 72,
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    fontWeight: 700,
  },
];

export function getIntroStyleById(id: string): IntroStyle | undefined {
  return INTRO_STYLES.find(s => s.id === id);
}
