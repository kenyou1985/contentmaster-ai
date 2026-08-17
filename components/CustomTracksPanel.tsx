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
} from 'lucide-react';

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
  onChange: (state: CustomTracksState) => void;
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
    a.onloadedmetadata = () => resolve(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => resolve(0);
    a.src = url;
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
  const handleAddMedia = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newItems: CustomMediaTrackItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isVideo = file.type.startsWith('video/');
      const isImage = file.type.startsWith('image/');
      if (!isVideo && !isImage) {
        log('WARN', `跳过不支持的文件: ${file.name} (${file.type})`);
        continue;
      }
      const url = URL.createObjectURL(file);
      if (isVideo) {
        const meta = await probeVideoDuration(url);
        newItems.push({
          id: `m_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          kind: 'video',
          url,
          name: file.name,
          mime: file.type,
          size: file.size,
          durationSec: meta.durationSec,
          width: meta.width,
          height: meta.height,
        });
      } else {
        const dim = await probeImageDimensions(url);
        newItems.push({
          id: `m_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          kind: 'image',
          url,
          name: file.name,
          mime: file.type,
          size: file.size,
          width: dim.width,
          height: dim.height,
        });
      }
    }
    if (newItems.length === 0) return;
    onChange({ ...state, videoItems: [...state.videoItems, ...newItems] });
    log('TRACK', `✓ 添加 ${newItems.length} 个素材（图片/视频）到视频轨道`);
  }, [state, onChange, log]);

  // ── 删除素材 ─────────────────────────────────────────
  const handleRemoveItem = useCallback((id: string) => {
    const next = state.videoItems.filter((it) => it.id !== id);
    onChange({ ...state, videoItems: next });
  }, [state, onChange]);

  // ── 上下移动素材 ─────────────────────────────────────
  const handleMoveItem = useCallback((id: string, dir: -1 | 1) => {
    const idx = state.videoItems.findIndex((it) => it.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= state.videoItems.length) return;
    const next = [...state.videoItems];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    onChange({ ...state, videoItems: next });
  }, [state, onChange]);

  // ── 修改素材时长 ─────────────────────────────────────
  const handleChangeDuration = useCallback((id: string, sec: number) => {
    onChange({
      ...state,
      videoItems: state.videoItems.map((it) =>
        it.id === id ? { ...it, overrideDurationSec: sec > 0 ? sec : undefined } : it
      ),
    });
  }, [state, onChange]);

  // ── 修改字幕文本 ─────────────────────────────────────
  const handleChangeCaption = useCallback((id: string, text: string) => {
    onChange({
      ...state,
      videoItems: state.videoItems.map((it) =>
        it.id === id ? { ...it, caption: text } : it
      ),
    });
  }, [state, onChange]);

  // ── 上传音频 ─────────────────────────────────────────
  const audioInputRef = useRef<HTMLInputElement>(null);
  const handleAddAudio = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // 多选时取第一个有效的音频文件（其余日志提示）
    const audios = Array.from(files).filter((f) => f.type.startsWith('audio/'));
    if (audios.length === 0) {
      log('WARN', `音频格式不支持: ${Array.from(files).map((f) => f.name).join(', ')}`);
      return;
    }
    if (audios.length > 1) {
      log('INFO', `检测到 ${audios.length} 个音频文件，使用第一个: ${audios[0].name}`);
    }
    const file = audios[0];
    const url = URL.createObjectURL(file);
    const durationSec = await probeAudioDuration(url);
    onChange({
      ...state,
      audioUrl: url,
      audioName: file.name,
      audioDurationSec: durationSec,
    });
    log('TRACK', `✓ 音频轨道：${file.name} · ${durationSec.toFixed(1)}s · ${(file.size / 1024).toFixed(1)} KB`);
  }, [state, onChange, log]);

  const handleRemoveAudio = useCallback(() => {
    onChange({
      ...state,
      audioUrl: undefined,
      audioName: undefined,
      audioDurationSec: undefined,
    });
  }, [state, onChange]);

  // ── 上传字幕文件 ─────────────────────────────────────
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const handleAddSubtitle = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      const text = await file.text();
      const cues = parseSubtitleFile(file.name, text);
      if (cues.length === 0) throw new Error('字幕文件解析后为 0 条，请检查格式');
      onChange({
        ...state,
        subtitleCues: cues,
        subtitleFileName: file.name,
        subtitleEnabled: true,
      });
      log('TRACK', `✓ 字幕：${file.name} · ${cues.length} 条 cue`);
    } catch (e: any) {
      log('ERROR', `字幕解析失败: ${e.message}`);
    }
  }, [state, onChange, log]);

  const handleRemoveSubtitle = useCallback(() => {
    onChange({
      ...state,
      subtitleCues: [],
      subtitleFileName: undefined,
    });
  }, [state, onChange]);

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
                  const next = [...state.videoItems];
                  const [moved] = next.splice(draggingIndex, 1);
                  next.splice(idx, 0, moved);
                  onChange({ ...state, videoItems: next });
                  setDraggingIndex(null);
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
        ) : (
          <div
            onClick={() => audioInputRef.current?.click()}
            className="border-2 border-dashed border-slate-600 rounded-lg p-4 text-center text-slate-500 hover:border-amber-500 hover:text-amber-400 transition-colors cursor-pointer"
          >
            <Upload size={20} className="mx-auto mb-1 opacity-50" />
            <div className="text-xs">点击上传音频（mp3 / wav / m4a）</div>
            <div className="text-[10px] text-slate-600 mt-1">
              不上传时将仅导出视频轨道（无声）
            </div>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*"
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
              {state.subtitleCues.length > 0
                ? `${state.subtitleCues.length} 条（${state.subtitleFileName}）`
                : '默认 Whisper ASR 自动生成'}
            </span>
          </div>
          {state.subtitleCues.length > 0 && (
            <button
              onClick={handleRemoveSubtitle}
              className="text-[10px] text-red-400 hover:text-red-300 flex items-center gap-1"
              type="button"
            >
              <Trash2 size={10} /> 清除字幕文件
            </button>
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
          <label className="flex items-center gap-1 text-[10px] text-slate-300">
            <input
              type="checkbox"
              checked={state.subtitleEnabled}
              onChange={(e) => onChange({ ...state, subtitleEnabled: e.target.checked })}
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