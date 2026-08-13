/**
 * 字幕文件生成工具（SRT / ASS）
 * - SRT：通用字幕格式，几乎所有播放器都支持（剪映、PR、DaVinci 等）
 * - ASS：高级字幕格式，支持字体/描边/阴影/位置等样式（更接近渲染效果）
 *
 * 输入：RemotionShot[] 数组 + 帧率 + 配置
 * 输出：字幕文件字符串
 */

import type { SubtitleCue } from './remotionRenderTypes';

interface SrtEntry {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

interface AssStyle {
  name: string;
  fontName: string;
  fontSize: number;
  primaryColour: string;
  outlineColour: string;
  backColour: string;
  bold: boolean;
  outline: number;
  shadow: number;
  alignment: number; // 1=左下 2=中下 3=右下 4=左中 5=正中 6=右中 7=左上 8=中上 9=右上
  marginV: number;
}

/**
 * 把帧号 + fps 转成毫秒
 */
function framesToMs(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000);
}

/**
 * SRT 时间格式：HH:MM:SS,mmm
 */
function formatSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mil = Math.floor(ms % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mil).padStart(3, '0')}`;
}

/**
 * ASS 时间格式：H:MM:SS.cc（百分秒）
 */
function formatAssTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10); // 厘秒（百分秒）
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * 把 hex 颜色（如 #ffe600）转为 ASS 的 &HBBGGRR& 格式
 */
function hexToAssColor(hex: string, alpha = 0): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return '&H00FFFFFF&';
  const rgb = m[1];
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  const a = String(alpha).padStart(2, '0').toUpperCase();
  return `&H${a}${b}${g}${r}&`.toUpperCase();
}

interface GenerateOptions {
  fps: number;
  resolution: { width: number; height: number };
  shots: Array<{
    id: string;
    textCues?: SubtitleCue[];
    caption?: string;
  }>;
  // ASS 样式
  fontName?: string;
  fontSize?: number;
  color?: string;
  outlineColor?: string;
  outlineWidth?: number;
  shadow?: boolean;
  position?: 'top' | 'middle' | 'bottom';
}

/**
 * 把整段视频的字幕拍平（拼接所有 shot 的 cues），并加上 shot 的偏移
 */
function flattenCues(
  shots: GenerateOptions['shots'],
  fps: number
): Array<{ text: string; startMs: number; endMs: number }> {
  const result: Array<{ text: string; startMs: number; endMs: number }> = [];
  let shotOffsetFrame = 0;
  for (const shot of shots) {
    const cues = shot.textCues;
    if (cues && cues.length > 0) {
      for (const cue of cues) {
        result.push({
          text: cue.text.trim(),
          startMs: framesToMs(shotOffsetFrame + cue.startFrame, fps),
          endMs: framesToMs(shotOffsetFrame + cue.endFrame, fps),
        });
      }
    } else if (shot.caption) {
      // 没有预切 cue，把整段 caption 作为一句
      const dur = 30; // 默认 30 帧 = 1s
      result.push({
        text: shot.caption.trim(),
        startMs: framesToMs(shotOffsetFrame, fps),
        endMs: framesToMs(shotOffsetFrame + dur, fps),
      });
    }
    // 累计偏移：取最长 cue 的 endFrame 作为这个 shot 的时长
    let shotDurFrame = 30;
    if (cues && cues.length > 0) {
      shotDurFrame = Math.max(...cues.map((c) => c.endFrame));
    }
    shotOffsetFrame += shotDurFrame;
  }
  return result;
}

/**
 * 生成 SRT 文件内容
 */
export function generateSrt(opts: GenerateOptions): string {
  const cues = flattenCues(opts.shots, opts.fps);
  return cues
    .filter((c) => c.text)
    .map((c, i) => {
      return `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}\n`;
    })
    .join('\n');
}

/**
 * 生成 ASS 文件内容（带样式）
 */
export function generateAss(opts: GenerateOptions): string {
  const cues = flattenCues(opts.shots, opts.fps);
  const alignMap: Record<string, number> = { top: 8, middle: 5, bottom: 2 };
  const alignment = alignMap[opts.position ?? 'bottom'] ?? 2;

  const style: AssStyle = {
    name: 'Default',
    fontName: opts.fontName || 'PingFang SC',
    fontSize: opts.fontSize || 48,
    primaryColour: hexToAssColor(opts.color || '#ffffff'),
    outlineColour: hexToAssColor(opts.outlineColor || '#000000'),
    backColour: '&H80000000&',
    bold: true,
    outline: opts.outlineWidth ?? 2,
    shadow: opts.shadow ? 2 : 0,
    alignment,
    marginV: 60,
  };

  const header = [
    '[Script Info]',
    'Title: ContentMaster AI 字幕',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'PlayResX: ' + opts.resolution.width,
    'PlayResY: ' + opts.resolution.height,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${style.name},${style.fontName},${style.fontSize},${style.primaryColour},&H00FFFFFF&,${style.outlineColour},${style.backColour},${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},${style.alignment},40,40,${style.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = cues
    .filter((c) => c.text)
    .map((c) => {
      return `Dialogue: 0,${formatAssTime(c.startMs)},${formatAssTime(c.endMs)},${style.name},,0,0,0,,${c.text.replace(/\n/g, '\\N')}`;
    })
    .join('\n');

  return header.join('\n') + '\n' + events + '\n';
}

/**
 * 触发浏览器下载字幕文件
 */
export function downloadSubtitleFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
