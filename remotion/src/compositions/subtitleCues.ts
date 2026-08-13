/**
 * 字幕切分工具（Remotion 渲染管线使用）
 * - 不依赖 React，纯 TS utils
 * - 被 Subtitle.tsx 和 MyVideo.tsx 共用
 */

export interface SubtitleWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleCue {
  text: string;
  startFrame: number;
  endFrame: number;
  /** 词级时间戳（由 ASR/WASM Whisper 注入）；用于卡拉 OK 染色 */
  words?: SubtitleWord[];
}

export interface SubtitleStyleConfig {
  /**
   * 视觉风格：
   * - default: 单色
   * - stroke:  单色 + 描边
   * - karaoke: 词级染色（需要 cue.words；无 words 时降级为 tiktok）
   * - tiktok:  逐词交替色 + 弹簧入场 + 强描边
   */
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
  /** 副色（与 color 交替），默认 #ffe600 */
  altColor?: string;
  /** 入场动画 */
  preset?: 'none' | 'spring';
  /**
   * 字幕安全区（M2 #7：自动避开主体/重要物品）
   * - 0~1 归一化坐标（相对视频画布）
   * - 若提供，则按 safeZone 计算字幕位置；position 字段被覆盖为推荐位置
   */
  safeZone?: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    preferredPosition: 'top' | 'middle' | 'bottom';
    confidence?: number;
  };
}

export interface SubtitleFullConfig extends SubtitleStyleConfig {
  enabled?: boolean;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  maxCharsPerLine?: number;
  cues?: SubtitleCue[];
}

/**
 * 按中英文标点把整段字幕切成若干"句"。
 * 切分规则：
 *   1. 按句子分隔符切：，。！？；\n（含半角）
 *   2. 无标点 → 按字符权重切分（中文 1 / 英文 0.6）
 *   3. 短句（< 4 字符）合并相邻句
 */
export function splitCaptionToSentences(text: string, targetLen: number = 14): string[] {
  if (!text) return [];

  const normalized = text
    .replace(/[!?;]/g, m => (m === '!' ? '！' : m === '?' ? '？' : '；'))
    .replace(/,/g, '，')
    .replace(/\./g, '。');

  let raw: string[];

  if (/[，。！？；\n]/.test(normalized)) {
    raw = normalized.split(/(?<=[，。！？；\n])/g);
  } else {
    raw = splitByCharWeight(normalized, targetLen);
  }

  const TRAILING_PUNCT = /[，。！？；：、……—·""''「」『』（）()【】\[\]…——\s]+$/;

  const sentences: string[] = [];
  for (const part of raw) {
    const cleaned = part.replace(TRAILING_PUNCT, '').trim();
    if (!cleaned) continue;
    const last = sentences[sentences.length - 1];
    if (last && last.length < 4) {
      sentences[sentences.length - 1] = last + cleaned;
    } else {
      sentences.push(cleaned);
    }
  }
  return sentences;
}

function splitByCharWeight(text: string, targetLen: number): string[] {
  const tokens: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(ch);
    } else if (/\s/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(' ');
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);

  const out: string[] = [];
  let cur = '';
  let curWeight = 0;
  for (const t of tokens) {
    const w = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/.test(t) ? 1
            : /\s/.test(t) ? 0.4
            : 0.6;
    if (curWeight + w > targetLen && cur.trim()) {
      out.push(cur.trim());
      cur = t;
      curWeight = w;
    } else {
      cur += t;
      curWeight += w;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length > 0 ? out : [text];
}

/**
 * 把整段镜头时长按句数均分，生成 cue 时间轴（帧）。
 * 约束：
 *   1. 所有句子必须 push（不允许漏最后一句）
 *   2. 最后一句 endFrame = durationInFrames
 *   3. 中间句按均分长度切片
 */
export function buildSubtitleCues(
  text: string,
  durationInFrames: number,
  fps: number,
  gapFrames: number = Math.max(2, Math.round(fps * 0.2)),
): SubtitleCue[] {
  const sentences = splitCaptionToSentences(text);
  if (sentences.length === 0 || durationInFrames <= 0) return [];
  if (sentences.length === 1) {
    return [{ text: sentences[0], startFrame: 0, endFrame: durationInFrames }];
  }

  const totalGap = gapFrames * (sentences.length - 1);
  const usable = Math.max(0, durationInFrames - totalGap);
  const perSentence = Math.max(1, Math.floor(usable / sentences.length));

  const cues: SubtitleCue[] = [];
  for (let i = 0; i < sentences.length; i++) {
    let startFrame: number;
    let endFrame: number;

    if (i === 0) {
      startFrame = 0;
      endFrame = Math.min(durationInFrames, startFrame + perSentence);
    } else {
      const prevEnd = cues[i - 1].endFrame;
      startFrame = Math.min(durationInFrames, prevEnd + gapFrames);
      if (i === sentences.length - 1) {
        endFrame = durationInFrames;
      } else {
        endFrame = Math.min(durationInFrames, startFrame + perSentence);
      }
    }

    if (endFrame <= startFrame) endFrame = Math.min(durationInFrames, startFrame + 1);
    cues.push({ text: sentences[i], startFrame, endFrame });
  }

  // 归一化：钳制相邻 cue 之间的间隙
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endFrame > cues[i + 1].startFrame) {
      cues[i].endFrame = cues[i + 1].startFrame;
    }
  }

  return cues;
}

/**
 * 把一句话按语义切分成"词组"。
 * 中文：按标点切；英文/混合：按空格切。
 * 用于 TikTok 逐词交替渲染。
 *
 * 例："今天体验的副本，是看到女生你就喜欢骚扰的恶臭中年男"
 *   → ["今天体验的副本", "是看到女生你就喜欢骚扰的恶臭中年男"]
 *
 * 例："Hello world, this is a test"
 *   → ["Hello", "world,", "this", "is", "a", "test"]
 */
export function splitTextToWords(text: string): string[] {
  if (!text) return [];
  const norm = text
    .replace(/[!?;]/g, m => (m === '!' ? '！' : m === '?' ? '？' : '；'))
    .replace(/,/g, '，')
    .replace(/\./g, '。');

  if (/[，。！？；\n\s]/.test(norm)) {
    const parts: string[] = [];
    let buf = '';
    for (const ch of norm) {
      if (/[，。！？；\n]/.test(ch)) {
        buf += ch;
        const trimmed = buf.trim();
        if (trimmed) parts.push(trimmed);
        buf = '';
      } else if (/\s/.test(ch)) {
        const trimmed = buf.trim();
        if (trimmed) parts.push(trimmed);
        buf = '';
      } else {
        buf += ch;
      }
    }
    const last = buf.trim();
    if (last) parts.push(last);
    return parts.length > 0 ? parts : [text.trim()];
  }

  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(norm)) {
    const CHUNK = 4;
    const out: string[] = [];
    for (let i = 0; i < norm.length; i += CHUNK) {
      const chunk = norm.slice(i, i + CHUNK);
      if (chunk) out.push(chunk);
    }
    return out.length > 0 ? out : [norm];
  }

  return norm.split(/\s+/).filter(Boolean);
}
