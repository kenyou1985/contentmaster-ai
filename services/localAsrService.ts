/**
 * 本地 WASM Whisper ASR 服务（前端调用层）
 *
 * 路由：本 Remotion 服务器（同 /api/remotion/*）
 * - 本地 localhost → /api/remotion/asr/transcribe
 * - 远程 Railway → VITE_REMITION_API_BASE/asr/transcribe
 *
 * 流程：
 *   1. 把音频（blob/data URL/http URL）上传到 /api/remotion/upload-media
 *   2. 调用 /api/remotion/asr/transcribe 提交任务
 *   3. 直接拿到 { words: [{text, startMs, endMs}], text, durationSec }
 *   4. 前端把 words 注入 shot.textCues → Remotion 渲染
 *
 * 零外部 API 费用，模型下载一次后完全离线。
 */

import { SubtitleWord, SubtitleCue } from './remotionRenderTypes';

export interface AsrResult {
  ok: boolean;
  words: SubtitleWord[];
  text: string;
  durationSec: number;
  language: string;
  error?: string;
}

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  const env = (import.meta as any).env || {};
  const base = env.VITE_REMITION_API_BASE || '/api/remotion';
  return base.replace(/\/$/, '');
}

/**
 * 把 blob/data URL 转成 File，调用 /upload-media → { paths }
 */
async function uploadAudioToServer(audioBlob: Blob, filename = 'audio.mp3'): Promise<string> {
  const form = new FormData();
  form.append('file', audioBlob, filename);
  const base = getApiBase();
  const res = await fetch(`${base}/upload-media`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`上传失败: ${res.status}`);
  const json = await res.json();
  if (!json?.paths?.[0]) throw new Error('上传响应异常: ' + JSON.stringify(json).slice(0, 100));
  return json.paths[0];
}

/**
 * 对单个音频运行本地 Whisper ASR。
 *
 * @param audioUrl   任意音频 URL（blob: / data: / http(s):）
 * @param audioFilename  上传时的文件名（用于服务器端识别格式）
 */
export async function transcribeAudio(
  audioUrl: string,
  audioFilename = 'audio.mp3',
): Promise<AsrResult> {
  const base = getApiBase();

  // 1. 上传音频 → 获得服务器路径
  let serverPath: string;
  if (audioUrl.startsWith('blob:')) {
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error(`fetch blob 失败: ${res.status}`);
    const blob = await res.blob();
    serverPath = await uploadAudioToServer(blob, audioFilename);
  } else if (audioUrl.startsWith('data:')) {
    // data URL → Blob
    const [meta, b64] = audioUrl.split(',');
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    serverPath = await uploadAudioToServer(blob, audioFilename);
  } else {
    // http(s) URL → 直接传 URL 给服务器（服务器会下载）
    serverPath = audioUrl;
  }

  // 2. 调用 ASR
  const res = await fetch(`${base}/asr/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ id: 'single', audioPath: serverPath, language: 'zh' }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ASR 失败: ${res.status} ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const result = json?.results?.single;
  if (!result) return { ok: false, words: [], text: '', durationSec: 0, language: 'zh', error: '无结果' };
  return {
    ok: result.ok ?? false,
    words: result.words ?? [],
    text: result.text ?? '',
    durationSec: result.durationSec ?? 0,
    language: result.language ?? 'zh',
    error: result.error,
  };
}

/**
 * 批量对多个音频运行 ASR（串行，避免服务器内存爆炸）
 */
export async function transcribeShots(
  items: Array<{
    shotId: string;
    audioUrl: string;
    caption: string;
    durationInFrames: number;
    fps: number;
  }>,
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<Record<string, SubtitleCue[]>> {
  const results: Record<string, SubtitleCue[]> = {};
  const fps = items[0]?.fps ?? 30;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress?.(i, items.length, item.shotId);

    try {
      const r = await transcribeAudio(item.audioUrl);
      if (r.ok && r.words.length > 0) {
        // 优先用 ASR 实测音频时长（r.durationSec），确保时间轴与真实音频一致
        // item.durationInFrames 基于 shot.audioDurationExact，当其为 null/0 时可能是 4s 默认值，不可用
        const totalMs = (r.durationSec && r.durationSec > 0)
          ? Math.round(r.durationSec * 1000)
          : Math.round((item.durationInFrames / fps) * 1000);
        const cues = buildCuesFromWords(r.words, item.caption, totalMs, fps);
        results[item.shotId] = cues;
      } else {
        results[item.shotId] = buildFallbackCues(item.caption, item.durationInFrames, fps);
      }
    } catch (e: any) {
      console.warn(`[ASR] shot ${item.shotId} failed:`, e?.message ?? e);
      results[item.shotId] = buildFallbackCues(item.caption, item.durationInFrames, fps);
    }
    onProgress?.(i + 1, items.length, item.shotId);
  }
  return results;
}

// ── 本地工具函数（与 subtitleCues.ts 逻辑一致）────────────────────

function buildFallbackCues(caption: string, durationInFrames: number, fps: number): SubtitleCue[] {
  const spans = splitCaptionToSentences(caption);
  if (spans.length === 0) return [];
  if (spans.length === 1) return [{ text: spans[0], startFrame: 0, endFrame: durationInFrames }];
  const gapFrames = Math.max(2, Math.round(fps * 0.2));
  const totalGap = gapFrames * (spans.length - 1);
  const usable = Math.max(0, durationInFrames - totalGap);
  const perSentence = Math.max(1, Math.floor(usable / spans.length));
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < spans.length; i++) {
    let startFrame: number;
    let endFrame: number;
    if (i === 0) {
      startFrame = 0;
      endFrame = Math.min(durationInFrames, startFrame + perSentence);
    } else {
      const prevEnd = cues[i - 1].endFrame;
      startFrame = Math.min(durationInFrames, prevEnd + gapFrames);
      if (i === spans.length - 1) endFrame = durationInFrames;
      else endFrame = Math.min(durationInFrames, startFrame + perSentence);
    }
    if (endFrame <= startFrame) endFrame = Math.min(durationInFrames, startFrame + 1);
    cues.push({ text: spans[i], startFrame, endFrame });
  }
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endFrame > cues[i + 1].startFrame) cues[i].endFrame = cues[i + 1].startFrame;
  }
  return cues;
}

function splitCaptionToSentences(text: string): string[] {
  if (!text) return [];
  const norm = text
    .replace(/[!?;]/g, m => (m === '!' ? '！' : m === '?' ? '？' : '；'))
    .replace(/,/g, '，')
    .replace(/\./g, '。');
  const TRAILING_PUNCT = /[，。！？；：、……—·""''「」『』（）()【】\[\]…——\s]+$/;
  let raw: string[];
  if (/[，。！？；\n]/.test(norm)) {
    raw = norm.split(/(?<=[，。！？；\n])/g);
  } else {
    // 无标点 → 按 14 字权重切分
    raw = splitByWeight(norm, 14);
  }
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

function splitByWeight(text: string, targetLen: number): string[] {
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
    const w = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/.test(t) ? 1 : /\s/.test(t) ? 0.4 : 0.6;
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
 * 把 words 时间戳按 caption 标点切分成 SubtitleCue[]。
 * - 音频总时长已知时，按 words.startMs/endMs 分配帧时间轴
 * - caption 按标点切句作为句子边界
 */
function buildCuesFromWords(
  words: SubtitleWord[],
  caption: string,
  totalMs: number,
  fps: number,
): SubtitleCue[] {
  const spans = splitCaptionToSentences(caption);
  if (spans.length === 0) return [];
  const totalFrames = Math.max(1, Math.round((totalMs / 1000) * fps));

  // 计算每个 span 在原 caption 中的 ms 范围（按字符数比例）
  const totalChars = spans.reduce((s, sp) => s + Math.max(1, sp.length), 0);
  const spanMsRanges: Array<{ text: string; msStart: number; msEnd: number }> = [];
  let accMs = 0;
  for (let i = 0; i < spans.length; i++) {
    const isLast = i === spans.length - 1;
    const spanMs = isLast
      ? Math.max(0, totalMs - accMs)
      : Math.round((Math.max(1, spans[i].length) / totalChars) * totalMs);
    spanMsRanges.push({ text: spans[i], msStart: accMs, msEnd: Math.min(totalMs, accMs + spanMs) });
    accMs += spanMs;
  }

  const cues: SubtitleCue[] = [];
  for (const span of spanMsRanges) {
    const startFrame = Math.min(totalFrames - 1, Math.max(0, Math.round((span.msStart / 1000) * fps)));
    const endFrame = Math.max(startFrame + 1, Math.min(totalFrames, Math.round((span.msEnd / 1000) * fps)));
    // 找落在 [msStart, msEnd] 内的 words
    const matchedWords = words.filter(
      w => w.endMs >= span.msStart && w.startMs <= span.msEnd + 50,
    );
    cues.push({
      text: span.text,
      startFrame,
      endFrame,
      words: matchedWords.length > 0 ? matchedWords : undefined,
    });
  }

  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endFrame > cues[i + 1].startFrame) cues[i].endFrame = cues[i + 1].startFrame;
  }
  return cues;
}
