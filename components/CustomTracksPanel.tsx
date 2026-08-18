/**
 * 自定义素材成片子面板
 *
 * 设计：双轨道模式（视频轨道 + 音频轨道），类似剪映 / PR 的多轨编辑器
 *  - 视频轨道：用户上传 N 张图片 / 多个视频，按顺序拼成一个长视频
 *  - 音频轨道：用户上传 1 个完整音频（整段视频的背景音/解说）
 *  - 字幕：默认走 Whisper ASR 自动生成；用户也可上传 .srt / .vtt / .json 字幕覆盖
 *  - 总时长：取音频时长（缺省时取所有视频时长之和，图片按 4s/张 兜底）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  FileVideo,
  FileAudio,
  Upload,
  X,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Volume2,
  FileText,
  Film,
  Loader2,
  Music,
  Download,
} from 'lucide-react';
import {
  traditionalToSimplified,
  convertCuesTexts,
  looksLikeTraditional,
} from '../services/textConverter';
import {
  isVideoFile,
  extractAudioFromVideo,
  prewarmFfmpeg,
} from '../services/audioExtractor';
import { getRemotionApiBase } from '../services/remotionExportService';
import { optimizeSubtitles } from '../services/subtitleOptimizer';

// ── 字幕辅助函数 ──────────────────────────────────────────

/** 下载文件 */
function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 格式化 SRT 时间（秒 → HH:MM:SS,mmm） */
function formatSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ── 单个素材（图片或视频）────────────────────────────────
export interface CustomMediaTrackItem {
  /** 唯一 ID */
  id: string;
  /** 素材类型 */
  kind: 'image' | 'video';
  /** 远程或本地 URL（blob: / data: / https:） */
  url: string;
  /** 文件名（仅展示用） */
  name: string;
  /** MIME 类型 */
  mime: string;
  /** 文件大小（字节） */
  size: number;
  /** 视频时长（秒），图片无此字段 */
  durationSec?: number;
  /** 探测到的实际像素尺寸（图片用） */
  width?: number;
  height?: number;
  /** 用户可手动覆盖的镜头时长（秒），未设则用：视频=durationSec / 图片=4 */
  overrideDurationSec?: number;
  /** 该镜头的字幕文本（可选） */
  caption?: string;
}

// ── 字幕项（SRT/VTT 解析后的统一结构）──────────────────────
export interface CustomSubtitleCue {
  /** 起始时间（秒） */
  startSec: number;
  /** 结束时间（秒） */
  endSec: number;
  /** 字幕文本 */
  text: string;
}

export interface CustomTracksState {
  videoItems: CustomMediaTrackItem[];
  audioUrl?: string;
  audioName?: string;
  audioDurationSec?: number;
  /** 用户上传的字幕文件内容（解析后的 cues 数组） */
  subtitleCues: CustomSubtitleCue[];
  /** 字幕文件名 */
  subtitleFileName?: string;
  /** 是否启用字幕 */
  subtitleEnabled: boolean;
}

interface CustomTracksPanelProps {
  /** 受控 state */
  state: CustomTracksState;
  /**
   * 受控更新（支持函数式更新以避免闭包捕获旧 state）：
   *   onChange(newState)           — 直接替换
   *   onChange((prev) => newState) — 函数式更新（推荐批量场景）
   */
  onChange: (state: CustomTracksState | ((prev: CustomTracksState) => CustomTracksState)) => void;
  /** 字幕来源说明：'whisper' | 'upload' | 'none' */
  onLog?: (prefix: string, message: string) => void;
}

// ── 时间解析工具（"00:01:23,456" / "00:01:23.456" / "83.5"）──
function parseTimecodeToSec(tc: string): number {
  const s = tc.trim().replace(',', '.');
  // HH:MM:SS.mmm 或 MM:SS.mmm
  const m = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (m) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseFloat(m[3]);
    return h * 3600 + min * 60 + sec;
  }
  // 纯秒
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ── SRT 解析 ─────────────────────────────────────────────
function parseSrt(content: string): CustomSubtitleCue[] {
  const cues: CustomSubtitleCue[] = [];
  // SRT 块用空行分隔
  const blocks = content.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    let timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx < 0) continue;
    const tcLine = lines[timeLineIdx];
    const m = tcLine.match(/(\S+)\s*-->\s*(\S+)/);
    if (!m) continue;
    const text = lines.slice(timeLineIdx + 1).join(' ').trim();
    if (!text) continue;
    cues.push({
      startSec: parseTimecodeToSec(m[1]),
      endSec: parseTimecodeToSec(m[2]),
      text,
    });
  }
  return cues.sort((a, b) => a.startSec - b.startSec);
}

// ── WebVTT 解析 ──────────────────────────────────────────
function parseVtt(content: string): CustomSubtitleCue[] {
  // VTT 与 SRT 几乎一致，但有时间戳可能不带 HH
  // 先剥掉 WEBVTT 头
  const cleaned = content.replace(/^WEBVTT[^\n]*\n/i, '');
  return parseSrt(cleaned);
}

// ── JSON 解析（接受 { cues: [{ start, end, text }] } 或 [{ startSec, endSec, text }]）──
function parseSubtitleJson(content: string): CustomSubtitleCue[] {
  const data = JSON.parse(content);
  const arr = Array.isArray(data) ? data : Array.isArray(data?.cues) ? data.cues : null;
  if (!arr) throw new Error('JSON 结构无法识别（需 cues 数组或顶层数组）');
  return arr
    .map((c: any): CustomSubtitleCue | null => {
      const startSec = c.startSec ?? c.start ?? c.startTime ?? c.from;
      const endSec = c.endSec ?? c.end ?? c.endTime ?? c.to;
      const text = c.text ?? c.content ?? '';
      if (typeof startSec !== 'number' || typeof endSec !== 'number' || !text) return null;
      return { startSec, endSec, text: String(text).trim() };
    })
    .filter(Boolean) as CustomSubtitleCue[];
}

function parseSubtitleFile(name: string, content: string): CustomSubtitleCue[] {
  const lower = name.toLowerCase();
  if (lower.endsWith('.srt')) return parseSrt(content);
  if (lower.endsWith('.vtt')) return parseVtt(content);
  if (lower.endsWith('.json')) return parseSubtitleJson(content);
  // 兜底：按 SRT 处理
  return parseSrt(content);
}

// ── 探测视频时长（用 <video> 元素拿 metadata）────────────
function probeVideoDuration(url: string): Promise<{ durationSec: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => {
      resolve({
        durationSec: isFinite(v.duration) ? v.duration : 0,
        width: v.videoWidth || undefined,
        height: v.videoHeight || undefined,
      });
    };
    v.onerror = () => resolve({ durationSec: 0 });
    v.src = url;
  });
}

// ── 探测图片尺寸 ────────────────────────────────────────
function probeImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

// ── 探测音频时长 ────────────────────────────────────────
function probeAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.muted = true;
    let settled = false;
    const settle = (n: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.src = '';
      resolve(n);
    };
    a.onloadedmetadata = () => {
      settle(isFinite(a.duration) && a.duration > 0 ? a.duration : 0);
    };
    a.onerror = () => settle(0);
    a.onloadeddata = () => {
      // fallback：loadeddata 时也尝试拿 duration（某些格式 metadata 不触发）
      if (a.duration && isFinite(a.duration)) settle(a.duration);
    };
    a.src = url;
    a.load();
    // 超时兜底（某些浏览器 blob URL metadata 加载慢）
    const timer = setTimeout(() => settle(0), 8000);
  });
}

// ── 计算单条素材的有效时长（秒）──────────────────────────
function effectiveItemDuration(it: CustomMediaTrackItem): number {
  if (typeof it.overrideDurationSec === 'number' && it.overrideDurationSec > 0) {
    return it.overrideDurationSec;
  }
  if (it.kind === 'video' && it.durationSec && it.durationSec > 0) {
    return it.durationSec;
  }
  return 4; // 图片兜底
}

// ── 计算视频轨道总长（秒）───────────────────────────────
function computeVideoTrackDuration(items: CustomMediaTrackItem[]): number {
  return items.reduce((sum, it) => sum + effectiveItemDuration(it), 0);
}

export function createEmptyCustomTracksState(): CustomTracksState {
  return {
    videoItems: [],
    subtitleCues: [],
    subtitleEnabled: true,
  };
}

// ─────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────
export const CustomTracksPanel: React.FC<CustomTracksPanelProps> = ({
  state,
  onChange,
  onLog,
}) => {
  const log = useCallback(
    (prefix: string, msg: string) => onLog?.(prefix, msg),
    [onLog]
  );

  // ── 预热 ffmpeg.wasm（组件挂载就开始下载 32MB WASM） ──
  useEffect(() => {
    prewarmFfmpeg();
  }, []);

  // ── 计算总时长（用于 UI 显示）────────────────────────
  const totalDuration = useMemo(() => {
    if (state.audioDurationSec && state.audioDurationSec > 0) {
      return state.audioDurationSec;
    }
    return computeVideoTrackDuration(state.videoItems);
  }, [state.videoItems, state.audioDurationSec]);

  // ── 拖拽状态 ─────────────────────────────────────────
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [isDropzoneHover, setIsDropzoneHover] = useState<boolean>(false);

  // ── 添加图片 / 视频 ─────────────────────────────────
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const handleAddMedia = useCallback(async (filesIn: FileList | File[] | null) => {
    // 把 FileList 立即转成普通数组（避免后续异步处理中 FileList 被 GC / 变 live 状态）
    const files: File[] = Array.from(filesIn ?? []);
    if (files.length === 0) return;
    log('INFO', `📥 handleAddMedia 收到 ${files.length} 个文件：${files.map((f) => f.name).join(', ')}`);
    const newItems: CustomMediaTrackItem[] = [];
    // 用 Promise.all 并行探测尺寸（图片快得多）；视频仍串行避免抢浏览器 video decoder
    const imageProbes = files.map(async (file, i) => {
      const isVideo = file.type.startsWith('video/');
      const isImage = file.type.startsWith('image/');
      if (!isVideo && !isImage) {
        log('WARN', `跳过不支持的文件: ${file.name} (${file.type})`);
        return null;
      }
      const url = URL.createObjectURL(file);
      if (isVideo) {
        const meta = await probeVideoDuration(url);
        return {
          id: `m_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          kind: 'video' as const,
          url,
          name: file.name,
          mime: file.type,
          size: file.size,
          durationSec: meta.durationSec,
          width: meta.width,
          height: meta.height,
        };
      }
      const dim = await probeImageDimensions(url);
      return {
        id: `m_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'image' as const,
        url,
        name: file.name,
        mime: file.type,
        size: file.size,
        width: dim.width,
        height: dim.height,
      };
    });
    const results = await Promise.all(imageProbes);
    for (const r of results) if (r) newItems.push(r);
    if (newItems.length === 0) {
      log('ERROR', `所有 ${files.length} 个文件均未通过校验（不是图片/视频？）`);
      return;
    }
    log('INFO', `📊 探测完成：${files.length} 个输入 → ${newItems.length} 个有效素材`);
    // 使用函数式更新，避免 handleAddMedia 内部闭包捕获旧 state
    // （批量上传时多个 Promise.all 并发完成，若用 onChange({...state,...}) 会读到同一份旧 state）
    const itemsToAdd = newItems;
    onChange((prev) => ({ ...prev, videoItems: [...prev.videoItems, ...itemsToAdd] }));
    if (itemsToAdd.length === 1) {
      log('TRACK', `✓ 添加 1 个素材（图片/视频）到视频轨道`);
    } else {
      log('TRACK', `✓ 批量添加 ${itemsToAdd.length} 个素材（图片/视频）到视频轨道`);
    }
  }, [onChange, log]);

  // ── 删除素材 ─────────────────────────────────────────
  const handleRemoveItem = useCallback((id: string) => {
    onChange((prev) => ({ ...prev, videoItems: prev.videoItems.filter((it) => it.id !== id) }));
  }, [onChange]);

  // ── 上下移动素材 ─────────────────────────────────────
  const handleMoveItem = useCallback((id: string, dir: -1 | 1) => {
    onChange((prev) => {
      const idx = prev.videoItems.findIndex((it) => it.id === id);
      if (idx < 0) return prev;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= prev.videoItems.length) return prev;
      const next = [...prev.videoItems];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return { ...prev, videoItems: next };
    });
  }, [onChange]);

  // ── 修改素材时长 ─────────────────────────────────────
  const handleChangeDuration = useCallback((id: string, sec: number) => {
    onChange((prev) => ({
      ...prev,
      videoItems: prev.videoItems.map((it) =>
        it.id === id ? { ...it, overrideDurationSec: sec > 0 ? sec : undefined } : it
      ),
    }));
  }, [onChange]);

  // ── 修改字幕文本 ─────────────────────────────────────
  const handleChangeCaption = useCallback((id: string, text: string) => {
    onChange((prev) => ({
      ...prev,
      videoItems: prev.videoItems.map((it) =>
        it.id === id ? { ...it, caption: text } : it
      ),
    }));
  }, [onChange]);

  // ── 把 Blob URL 转 data: URL（用于上传到 /asr/transcribe）────────
function blobUrlToDataUrl(blobUrl: string): Promise<string> {
  return fetch(blobUrl).then((r) => r.blob()).then((blob) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result));
      reader.onerror = reject;
      // 确保使用正确的 MIME 类型读取 blob
      reader.readAsDataURL(blob);
    });
  });
}

  // ── 上传音频 / 视频（支持视频文件自动提取音轨）───
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [asrLoading, setAsrLoading] = useState<boolean>(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState<boolean>(false);
  const [audioStage, setAudioStage] = useState<'idle' | 'extracting' | 'asr' | 'converting'>('idle');
  const [audioProgress, setAudioProgress] = useState<number>(0);  // 0-1
  const handleAddAudio = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // 多选时取第一个有效的文件（支持音频 + 视频）；其余日志提示
    const allFiles = Array.from(files);
    const validFiles = allFiles.filter((f) =>
      f.type.startsWith('audio/') || isVideoFile(f)
    );
    if (validFiles.length === 0) {
      log('WARN', `音频/视频格式不支持: ${allFiles.map((f) => `${f.name}(${f.type || '?'})`).join(', ')}`);
      return;
    }
    if (validFiles.length > 1) {
      log('INFO', `检测到 ${validFiles.length} 个文件，使用第一个: ${validFiles[0].name}`);
    }
    const file = validFiles[0];
    const isVideo = isVideoFile(file);
    log('INFO', `📥 音频轨道收到 ${isVideo ? '视频' : '音频'}：${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[CustomTracks] 收到 ${isVideo ? '视频' : '音频'}：${file.name}, mime=${file.type}, size=${file.size}`);

    let url: string;
    let durationSec: number;

    if (isVideo) {
      // 视频文件：提取音轨为 WAV（16kHz mono PCM，Whisper 推荐格式）
      log('AUDIO', `▸ 检测到视频文件，正在提取音轨（WAV 16kHz mono）…`);
      setAudioStage('extracting');
      setAudioProgress(0);
      let wavBlob: Blob;
      try {
        wavBlob = await extractAudioFromVideo(file, {
          targetSampleRate: 16000,
          targetChannels: 1,
          onProgress: (p) => {
            setAudioProgress(p);
            if (p >= 0.25 && p < 0.3) log('AUDIO', `  音轨提取进度：${Math.round(p * 100)}%`);
          },
        });
        log('AUDIO', `✓ 音轨提取完成：${(wavBlob.size / 1024).toFixed(1)} KB WAV`);
        console.log(`[CustomTracks] 音轨提取完成: ${wavBlob.size} bytes (${file.name})`);
      } catch (e: any) {
        log('ERROR', `视频音轨提取失败: ${e.message}`);
        setAudioStage('idle');
        setAudioProgress(0);
        return;
      }
      url = URL.createObjectURL(wavBlob);
      durationSec = await probeAudioDuration(url);
    } else {
      url = URL.createObjectURL(file);
      durationSec = await probeAudioDuration(url);
    }

    const hasCustomSubtitle = state.subtitleCues.length > 0 && state.subtitleFileName;
    const displayName = isVideo ? `${file.name}（已提取音轨）` : file.name;

    onChange((prev) => ({
      ...prev,
      audioUrl: url,
      audioName: displayName,
      audioDurationSec: durationSec,
      // 若无用户上传字幕文件，自动触发 Whisper ASR
      subtitleCues: hasCustomSubtitle ? prev.subtitleCues : [],
      subtitleFileName: hasCustomSubtitle ? prev.subtitleFileName : undefined,
    }));
    log('TRACK', `✓ 音频轨道：${displayName} · ${durationSec.toFixed(1)}s · ${(file.size / 1024).toFixed(1)} KB`);
    // 自动触发 Whisper ASR（无自定义字幕文件时）
    if (!hasCustomSubtitle && durationSec > 0.5) {
      setAsrLoading(true);
      setAudioStage('asr');
      setAudioProgress(0);
      log('ASR', `▸ 开始 Whisper ASR 识别（音频 ${durationSec.toFixed(1)}s）…`);
      try {
        // blob: URL → data: URL（服务端 fetch 不到 blob URL）
        const dataUrl = await blobUrlToDataUrl(url);
        const baseUrl = (window as any).__REMOTION_SERVER_URL__ || getRemotionApiBase();
        const resp = await fetch(`${baseUrl}/asr/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioUrl: dataUrl, language: 'zh' }),
        });
        const data = await resp.json();
        if (data.success && data.cues?.length > 0) {
          // Whisper 输出默认为繁体中文 → 自动转简体
          const cuesText = data.cues.map((c: any) => c.text).join(' ');
          if (looksLikeTraditional(cuesText)) {
            log('ASR', `▸ 检测到繁体字幕，正在转换为简体…`);
            try {
              const convertedCues = await convertCuesTexts(data.cues, 't2s');
              onChange((prev) => ({
                ...prev,
                subtitleCues: convertedCues,
                subtitleFileName: undefined,
                subtitleEnabled: true,
              }));
              log('ASR', `✓ Whisper 识别完成：${convertedCues.length} 条字幕（${data.durationSec?.toFixed(1)}s）· 已转简体`);
            } catch (convErr: any) {
              // 转换失败保留原文
              log('WARN', `繁简转换失败: ${convErr.message}，保留原始字幕`);
              onChange((prev) => ({
                ...prev,
                subtitleCues: data.cues,
                subtitleFileName: undefined,
                subtitleEnabled: true,
              }));
              log('ASR', `✓ Whisper 识别完成：${data.cues.length} 条字幕（${data.durationSec?.toFixed(1)}s）`);
            }
          } else {
            // 已经是简体，直接写入
            onChange((prev) => ({
              ...prev,
              subtitleCues: data.cues,
              subtitleFileName: undefined,
              subtitleEnabled: true,
            }));
            log('ASR', `✓ Whisper 识别完成：${data.cues.length} 条字幕（${data.durationSec?.toFixed(1)}s）`);
          }
        } else {
          log('ASR', `⚠ Whisper 识别失败: ${data.error || '未知错误'}`);
        }
      } catch (e: any) {
        log('ASR', `✗ Whisper 请求失败: ${e.message}`);
      } finally {
        setAsrLoading(false);
        setAudioStage('idle');
        setAudioProgress(0);
      }
    } else if (hasCustomSubtitle) {
      log('TRACK', `  检测到用户已上传字幕文件，跳过 ASR`);
      setAudioStage('idle');
      setAudioProgress(0);
    } else {
      // 没触发 ASR 也清掉 stage
      setAudioStage('idle');
      setAudioProgress(0);
    }
  }, [state.subtitleCues, state.subtitleFileName, onChange, log]);

  const handleRemoveAudio = useCallback(() => {
    onChange((prev) => ({
      ...prev,
      audioUrl: undefined,
      audioName: undefined,
      audioDurationSec: undefined,
    }));
  }, [onChange]);

  // ── 上传字幕文件 ─────────────────────────────────────
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const handleAddSubtitle = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      const text = await file.text();
      const cues = parseSubtitleFile(file.name, text);
      if (cues.length === 0) throw new Error('字幕文件解析后为 0 条，请检查格式');
      // 检测字幕是否包含繁体字，若是则自动转简体
      const cuesText = cues.map((c) => c.text).join(' ');
      let finalCues = cues;
      if (looksLikeTraditional(cuesText)) {
        log('TRACK', `▸ 检测到繁体字幕，正在转换为简体…`);
        try {
          finalCues = await convertCuesTexts(cues, 't2s');
          log('TRACK', `✓ 繁体→简体转换完成`);
        } catch (e: any) {
          log('WARN', `繁简转换失败: ${e.message}，保留原始字幕`);
        }
      }
      onChange((prev) => ({
        ...prev,
        subtitleCues: finalCues,
        subtitleFileName: file.name,
        subtitleEnabled: true,
      }));
      log('TRACK', `✓ 字幕：${file.name} · ${finalCues.length} 条 cue`);
    } catch (e: any) {
      log('ERROR', `字幕解析失败: ${e.message}`);
    }
  }, [onChange, log]);

  const handleRemoveSubtitle = useCallback(() => {
    onChange((prev) => ({
      ...prev,
      subtitleCues: [],
      subtitleFileName: undefined,
    }));
  }, [onChange]);

  return (
    <div className="space-y-4">
      {/* ── 总时长 + 操作提示 ── */}
      <div className="bg-gradient-to-r from-emerald-900/30 to-cyan-900/30 border border-emerald-700 rounded-lg p-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Film size={16} className="text-emerald-400" />
            <span className="text-emerald-300 font-bold">视频总时长</span>
            <span className="text-white font-mono text-base">
              {totalDuration > 0 ? `${totalDuration.toFixed(1)} 秒` : '—'}
            </span>
            <span className="text-[10px] text-slate-400">
              （音频 {state.audioDurationSec ? `${state.audioDurationSec.toFixed(1)}s` : '未上传'} / 视频轨道 {computeVideoTrackDuration(state.videoItems).toFixed(1)}s / 取长者）
            </span>
          </div>
          <div className="text-[10px] text-slate-500">
            导出时会按音频时长自动对齐每个镜头
          </div>
        </div>
      </div>

      {/* ── 视频轨道 ── */}
      <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ImageIcon size={16} className="text-blue-400" />
            <h4 className="text-sm font-bold text-blue-300">视频轨道（图片 / 视频）</h4>
            <span className="text-[10px] text-slate-500">
              {state.videoItems.length} 个素材
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => mediaInputRef.current?.click()}
              className="text-[11px] px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1"
              type="button"
            >
              <Plus size={12} /> 添加素材
            </button>
            <input
              ref={mediaInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={(e) => {
                handleAddMedia(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {state.videoItems.length === 0 ? (
          <div
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDragEnter={(e) => { e.preventDefault(); setIsDropzoneHover(true); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDropzoneHover(false); }}
            onDrop={(e) => {
              e.preventDefault();
              setIsDropzoneHover(false);
              handleAddMedia(e.dataTransfer.files);
            }}
            className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
              isDropzoneHover ? 'border-blue-400 text-blue-400 bg-blue-950/30' : 'border-slate-600 text-slate-500 hover:border-blue-500 hover:text-blue-400'
            }`}
            onClick={() => mediaInputRef.current?.click()}
          >
            <Upload size={24} className="mx-auto mb-1 opacity-50" />
            <div className="text-xs">拖拽图片/视频到此处，或点击上传（支持批量多选）</div>
            <div className="text-[10px] text-slate-600 mt-1">
              支持 jpg / png / webp / mp4 / mov / webm（可一次性选多个）
            </div>
          </div>
        ) : (
          <>
            {/* 始终显示的紧凑拖拽条（已有素材时也支持继续批量添加） */}
            <div
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
              onDragEnter={(e) => { e.preventDefault(); setIsDropzoneHover(true); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDropzoneHover(false); }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDropzoneHover(false);
                handleAddMedia(e.dataTransfer.files);
              }}
              className={`border-2 border-dashed rounded-lg p-2 text-center text-[11px] transition-colors cursor-pointer flex items-center justify-center gap-2 ${
                isDropzoneHover ? 'border-blue-400 text-blue-400 bg-blue-950/30' : 'border-slate-700 text-slate-500 hover:border-blue-500 hover:text-blue-400'
              }`}
              onClick={() => mediaInputRef.current?.click()}
            >
              <Upload size={14} />
              <span>拖拽图片/视频批量添加，或点击选择（支持多选）</span>
            </div>
            <div className="space-y-1.5">
            {state.videoItems.map((it, idx) => (
              <div
                key={it.id}
                draggable
                onDragStart={() => setDraggingIndex(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggingIndex === null || draggingIndex === idx) return;
                  const currentDragIdx = draggingIndex;
                  setDraggingIndex(null);
                  onChange((prev) => {
                    const next = [...prev.videoItems];
                    const [moved] = next.splice(currentDragIdx, 1);
                    next.splice(idx, 0, moved);
                    return { ...prev, videoItems: next };
                  });
                }}
                onDragEnd={() => setDraggingIndex(null)}
                className={`flex items-center gap-2 bg-slate-950/60 border rounded p-2 ${
                  draggingIndex === idx ? 'border-blue-400 opacity-50' : 'border-slate-700'
                }`}
              >
                <GripVertical size={14} className="text-slate-500 cursor-grab flex-shrink-0" />
                <div className="flex-shrink-0 w-12 h-12 bg-slate-900 rounded overflow-hidden flex items-center justify-center">
                  {it.kind === 'image' ? (
                    <img src={it.url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <video src={it.url} className="w-full h-full object-cover" muted />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-xs">
                    {it.kind === 'image' ? (
                      <ImageIcon size={12} className="text-cyan-400" />
                    ) : (
                      <FileVideo size={12} className="text-purple-400" />
                    )}
                    <span className="font-medium text-slate-200 truncate">{it.name}</span>
                    <span className="text-[10px] text-slate-500">
                      {it.kind === 'video' && it.durationSec ? `${it.durationSec.toFixed(1)}s` : ''}
                      {it.width && it.height ? ` · ${it.width}×${it.height}` : ''}
                      {' · '}
                      {(it.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <label className="text-[10px] text-slate-500">时长(秒)</label>
                    <input
                      type="number"
                      min="0.5"
                      step="0.5"
                      value={effectiveItemDuration(it)}
                      onChange={(e) => handleChangeDuration(it.id, parseFloat(e.target.value) || 0)}
                      className="w-16 text-[10px] bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-slate-200"
                    />
                    <input
                      type="text"
                      value={it.caption || ''}
                      onChange={(e) => handleChangeCaption(it.id, e.target.value)}
                      placeholder="（可选）字幕文本"
                      className="flex-1 text-[10px] bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-0.5 flex-shrink-0">
                  <button
                    onClick={() => handleMoveItem(it.id, -1)}
                    disabled={idx === 0}
                    className="p-0.5 text-slate-400 hover:text-emerald-400 disabled:opacity-30"
                    type="button"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    onClick={() => handleMoveItem(it.id, 1)}
                    disabled={idx === state.videoItems.length - 1}
                    className="p-0.5 text-slate-400 hover:text-emerald-400 disabled:opacity-30"
                    type="button"
                  >
                    <ArrowDown size={12} />
                  </button>
                </div>
                <button
                  onClick={() => handleRemoveItem(it.id)}
                  className="p-1 text-slate-400 hover:text-red-400 flex-shrink-0"
                  type="button"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            </div>
          </>
        )}
      </div>

      {/* ── 音频轨道 ── */}
      <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileAudio size={16} className="text-amber-400" />
            <h4 className="text-sm font-bold text-amber-300">音频轨道（整段视频配乐/解说）</h4>
          </div>
          {state.audioUrl && (
            <button
              onClick={handleRemoveAudio}
              className="text-[10px] text-red-400 hover:text-red-300 flex items-center gap-1"
              type="button"
            >
              <Trash2 size={10} /> 清除
            </button>
          )}
        </div>

        {state.audioUrl ? (
          <div className="bg-slate-950/60 border border-amber-700/60 rounded p-2 space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <Volume2 size={12} className="text-amber-400" />
              <span className="text-amber-200 font-medium">{state.audioName}</span>
              <span className="text-[10px] text-slate-500">
                {state.audioDurationSec?.toFixed(1)}s · 视频将按此时长对齐
              </span>
            </div>
            <audio controls src={state.audioUrl} className="w-full h-8" />
          </div>
        ) : audioStage !== 'idle' ? (
          // 处理中状态（视频提取 / ASR / 转换）
          <div className="bg-slate-950/60 border border-amber-700/40 rounded p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Loader2 size={12} className="text-amber-400 animate-spin" />
              <span className="text-amber-200 font-medium">
                {audioStage === 'extracting'
                  ? `🎬 正在提取音轨…`
                  : audioStage === 'asr'
                    ? `🗣️  Whisper 识别中…`
                    : audioStage === 'converting'
                      ? `🔄 繁简转换中…`
                      : `处理中…`}
              </span>
              <span className="text-[10px] text-slate-500">
                {audioStage === 'extracting'
                  ? '需要播放完整个视频才能提取完整音轨'
                  : audioStage === 'asr'
                    ? `音频 ${state.audioDurationSec?.toFixed(1) ?? '?'}s，模型可能加载较慢`
                    : ''}
              </span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-amber-500 h-full transition-all duration-300 ease-out"
                style={{ width: `${Math.round(audioProgress * 100)}%` }}
              />
            </div>
            <div className="text-[10px] text-slate-500 text-center">
              {Math.round(audioProgress * 100)}%
            </div>
          </div>
        ) : (
          <div
            onClick={() => audioInputRef.current?.click()}
            className="border-2 border-dashed border-slate-600 rounded-lg p-4 text-center text-slate-500 hover:border-amber-500 hover:text-amber-400 transition-colors cursor-pointer"
          >
            <Upload size={20} className="mx-auto mb-1 opacity-50" />
            <div className="text-xs">点击上传音频/视频（mp3 / wav / m4a / mp4 / mov）</div>
            <div className="text-[10px] text-slate-600 mt-1">
              上传视频时将自动提取音轨用于 Whisper ASR 字幕识别
            </div>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*,video/*"
              multiple
              hidden
              onChange={(e) => {
                handleAddAudio(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </div>

      {/* ── 字幕轨道 ── */}
      <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-purple-400" />
            <h4 className="text-sm font-bold text-purple-300">字幕</h4>
            <span className="text-[10px] text-slate-500">
              {asrLoading
                ? '🔄 Whisper 识别中…'
                : state.subtitleCues.length > 0
                  ? `${state.subtitleCues.length} 条${state.subtitleFileName ? `（${state.subtitleFileName}）` : '（自动生成）'}`
                  : '默认 Whisper ASR 自动生成'}
            </span>
          </div>
          {state.subtitleCues.length > 0 && (
            <div className="flex items-center gap-2">
              {/* 下载字幕按钮 */}
              <div className="relative">
                <button
                  onClick={() => setDownloadMenuOpen(!downloadMenuOpen)}
                  className="text-[10px] text-green-400 hover:text-green-300 flex items-center gap-1"
                  type="button"
                >
                  <Download size={10} /> 下载字幕
                </button>
                {downloadMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded shadow-lg z-10 min-w-[80px]">
                    <button
                      onClick={() => {
                        const text = state.subtitleCues.map((c) => c.text).join('\n');
                        downloadFile(`subtitle_${Date.now()}.txt`, text, 'text/plain');
                        setDownloadMenuOpen(false);
                      }}
                      className="block w-full text-left px-3 py-1.5 text-[10px] text-slate-300 hover:bg-slate-700"
                    >
                      TXT 格式
                    </button>
                    <button
                      onClick={() => {
                        const srt = state.subtitleCues.map((c, i) => {
                          const startTime = formatSrtTime(c.startSec);
                          const endTime = formatSrtTime(c.endSec);
                          return `${i + 1}\n${startTime} --> ${endTime}\n${c.text}\n`;
                        }).join('\n');
                        downloadFile(`subtitle_${Date.now()}.srt`, srt, 'text/srt');
                        setDownloadMenuOpen(false);
                      }}
                      className="block w-full text-left px-3 py-1.5 text-[10px] text-slate-300 hover:bg-slate-700"
                    >
                      SRT 格式
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={handleRemoveSubtitle}
                className="text-[10px] text-red-400 hover:text-red-300 flex items-center gap-1"
                type="button"
              >
                <Trash2 size={10} /> 清除
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => subtitleInputRef.current?.click()}
            className="text-[11px] px-2.5 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded flex items-center gap-1"
            type="button"
          >
            <Plus size={12} /> 上传字幕文件
          </button>
          <input
            ref={subtitleInputRef}
            type="file"
            accept=".srt,.vtt,.json"
            hidden
            onChange={(e) => {
              handleAddSubtitle(e.target.files);
              e.target.value = '';
            }}
          />
          {state.audioUrl && (
            <button
              onClick={async () => {
                if (!state.audioUrl) return;
                setAsrLoading(true);
                log('ASR', `▸ 重新 Whisper ASR 识别…`);
                try {
                  const dataUrl = await blobUrlToDataUrl(state.audioUrl);
                  const baseUrl = (window as any).__REMOTION_SERVER_URL__ || getRemotionApiBase();
                  const resp = await fetch(`${baseUrl}/asr/transcribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ audioUrl: dataUrl, language: 'zh' }),
                  });
                  const data = await resp.json();
                  if (data.success && data.cues?.length > 0) {
                    // 重新识别时也做繁→简转换
                    const cuesText = data.cues.map((c: any) => c.text).join(' ');
                    let finalCues = data.cues;
                    if (looksLikeTraditional(cuesText)) {
                      log('ASR', `▸ 检测到繁体字幕，正在转换为简体…`);
                      try {
                        finalCues = await convertCuesTexts(data.cues, 't2s');
                      } catch (e: any) {
                        log('WARN', `繁简转换失败: ${e.message}`);
                      }
                    }
                    onChange((prev) => ({ ...prev, subtitleCues: finalCues, subtitleFileName: undefined, subtitleEnabled: true }));
                    log('ASR', `✓ 重新识别完成：${finalCues.length} 条字幕`);
                  } else {
                    log('ASR', `⚠ 识别失败: ${data.error || '未知错误'}`);
                  }
                } catch (e: any) {
                  log('ASR', `✗ 请求失败: ${e.message}`);
                } finally {
                  setAsrLoading(false);
                }
              }}
              disabled={asrLoading || !state.audioUrl}
              className="text-[11px] px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded flex items-center gap-1 disabled:opacity-40"
              type="button"
              title="用 Whisper 重新识别音频"
            >
              {asrLoading ? <Loader2 size={12} className="animate-spin" /> : null}
              {asrLoading ? '识别中…' : '🔄 重新识别'}
            </button>
            {/* AI 优化按钮 */}
            {state.subtitleCues.length > 0 && (
              <button
                onClick={async () => {
                  if (!state.subtitleCues.length) return;
                  const hasApiKey = typeof window !== 'undefined' && !!window.localStorage.getItem('GEMINI_API_KEY');
                  if (!hasApiKey) {
                    alert('请先在设置中配置 AI API Key（Gemini / Yunwu）');
                    return;
                  }
                  setAsrLoading(true);
                  log('ASR', `▸ AI 优化字幕中…`);
                  try {
                    const result = await optimizeSubtitles(state.subtitleCues, (cur, total) => {
                      log('ASR', `  AI 优化: ${cur}/${total}`);
                    });
                    if (result.success) {
                      onChange((prev) => ({
                        ...prev,
                        subtitleCues: result.optimizedCues,
                        subtitleFileName: undefined,
                      }));
                      log('ASR', `✓ AI 优化完成：${result.optimizedCues.length} 条字幕`);
                    } else {
                      log('ASR', `⚠ AI 优化失败: ${result.error}`);
                      alert('AI 优化失败: ' + (result.error || '未知错误'));
                    }
                  } catch (e: any) {
                    log('ASR', `✗ AI 优化出错: ${e.message}`);
                    alert('AI 优化出错: ' + e.message);
                  } finally {
                    setAsrLoading(false);
                  }
                }}
                disabled={asrLoading || !state.subtitleCues.length}
                className="text-[11px] px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded flex items-center gap-1 disabled:opacity-40"
                type="button"
                title="使用 AI 根据上下文语境优化字幕"
              >
                ✨ AI 优化
              </button>
            )}
          </div>
          <label className="flex items-center gap-1 text-[10px] text-slate-300">
            <input
              type="checkbox"
              checked={state.subtitleEnabled}
              onChange={(e) => onChange((prev) => ({ ...prev, subtitleEnabled: e.target.checked }))}
              className="accent-purple-500"
            />
            启用字幕
          </label>
        </div>

        {state.subtitleCues.length > 0 && (
          <div className="bg-slate-950/60 border border-purple-700/40 rounded p-2 max-h-32 overflow-y-auto text-[10px] space-y-0.5 font-mono">
            {state.subtitleCues.slice(0, 20).map((c, i) => (
              <div key={i} className="text-slate-300">
                <span className="text-purple-400">
                  [{c.startSec.toFixed(1)}s → {c.endSec.toFixed(1)}s]
                </span>{' '}
                {c.text}
              </div>
            ))}
            {state.subtitleCues.length > 20 && (
              <div className="text-slate-500">...还有 {state.subtitleCues.length - 20} 条</div>
            )}
          </div>
        )}

        <div className="text-[10px] text-slate-500 leading-relaxed">
          💡 未上传字幕时，导出时会自动调用 Remotion 服务侧 Whisper ASR 生成字幕。
          需要精准字幕？上传 .srt/.vtt/.json 覆盖即可。
        </div>
      </div>
    </div>
  );
};