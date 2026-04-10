import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic,
  Shuffle,
  Volume2,
  Loader2,
  KeyRound,
  Play,
  Pause,
  Download,
  Clock,
  AlertCircle,
  CheckCircle2,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useToast } from './Toast';
import { VoiceLibrary } from './VoiceLibrary';
import { DUBBING_STYLE_TRACKS, getDubbingTrackById } from '../services/dubbingStylePresets';
import { runOneClickTts, type OneClickTtsProgressStage } from '../services/oneClickTtsService';
import { getSelectedVoice } from '../services/voiceLibraryService';

/** 与口播区 UI 一致；输入在 onChange 内截断 */
const SCRIPT_MAX_LEN = 5000;
const MAX_TASKS = 50;
const MAX_LOG_LINES = 500;

function formatLogTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

type DubbingEmotionId =
  | 'none'
  | 'happy'
  | 'angry'
  | 'sad'
  | 'scared'
  | 'disgusted'
  | 'melancholy'
  | 'surprised'
  | 'calm'
  | 'tender'
  | 'serious'
  | 'passionate'
  | 'playful'
  | 'ironic';

const DUBBING_EMOTION_OPTIONS: { id: DubbingEmotionId; label: string }[] = [
  { id: 'none', label: '无' },
  { id: 'happy', label: '高兴' },
  { id: 'angry', label: '愤怒' },
  { id: 'sad', label: '悲伤' },
  { id: 'scared', label: '害怕' },
  { id: 'disgusted', label: '厌恶' },
  { id: 'melancholy', label: '忧郁' },
  { id: 'surprised', label: '惊讶' },
  { id: 'calm', label: '平静' },
  { id: 'tender', label: '温柔' },
  { id: 'serious', label: '严肃' },
  { id: 'passionate', label: '激昂' },
  { id: 'playful', label: '俏皮' },
  { id: 'ironic', label: '冷幽默' },
];

function getEmotionTtsParams(id: DubbingEmotionId): { emphasisStrength: number; pitch: number } {
  switch (id) {
    case 'none':
      return { emphasisStrength: 0.5, pitch: 0 };
    case 'happy':
      return { emphasisStrength: 0.56, pitch: 0.3 };
    case 'angry':
      return { emphasisStrength: 0.72, pitch: -0.25 };
    case 'sad':
      return { emphasisStrength: 0.38, pitch: -0.45 };
    case 'scared':
      return { emphasisStrength: 0.48, pitch: 0.2 };
    case 'disgusted':
      return { emphasisStrength: 0.64, pitch: -0.15 };
    case 'melancholy':
      return { emphasisStrength: 0.42, pitch: -0.35 };
    case 'surprised':
      return { emphasisStrength: 0.62, pitch: 0.35 };
    case 'calm':
      return { emphasisStrength: 0.4, pitch: 0 };
    case 'tender':
      return { emphasisStrength: 0.47, pitch: 0.15 };
    case 'serious':
      return { emphasisStrength: 0.58, pitch: -0.12 };
    case 'passionate':
      return { emphasisStrength: 0.7, pitch: 0.25 };
    case 'playful':
      return { emphasisStrength: 0.52, pitch: 0.28 };
    case 'ironic':
      return { emphasisStrength: 0.55, pitch: -0.08 };
    default:
      return { emphasisStrength: 0.5, pitch: 0 };
  }
}

function formatDubTaskDisplayName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fileStemFromDisplayName(name: string): string {
  const compact = name.replace(/[-:\s]/g, '');
  return `配音_${compact || 'audio'}`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type DubbingTaskPhase = 'running' | 'done' | 'error';
type DubbingTaskStage = 'polish' | 'tts';

interface DubbingTask {
  id: string;
  displayName: string;
  createdAt: number;
  scriptPreview: string;
  phase: DubbingTaskPhase;
  /** 进行中的子阶段 */
  uiStage: DubbingTaskStage;
  error?: string;
  audioUrl?: string;
  speakText?: string;
  englishWarn?: boolean;
  polishMs?: number;
  ttsMs?: number;
  totalMs?: number;
}

async function downloadAudioFile(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = filename.endsWith('.mp3') ? filename : `${filename}.mp3`;
    a.click();
    URL.revokeObjectURL(u);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export interface OneClickDubbingProps {
  apiKey: string;
  runningHubApiKey: string;
  setRunningHubApiKey?: (k: string) => void;
  toast?: ReturnType<typeof useToast>;
}

export const OneClickDubbing: React.FC<OneClickDubbingProps> = ({
  apiKey,
  runningHubApiKey,
  setRunningHubApiKey,
  toast: externalToast,
}) => {
  const internalToast = useToast();
  const toast = externalToast || internalToast;

  const [scriptText, setScriptText] = useState('');
  const [trackMode, setTrackMode] = useState<'none' | 'track'>('none');
  const [selectedTrackId, setSelectedTrackId] = useState<string>(
    () => DUBBING_STYLE_TRACKS[0]?.id ?? 'finance'
  );
  const [customHint, setCustomHint] = useState('');
  const [skipLlm, setSkipLlm] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [emotion, setEmotion] = useState<DubbingEmotionId>('none');
  const [tasks, setTasks] = useState<DubbingTask[]>([]);
  /** 勾选的任务 id（进行中的任务不可勾选） */
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set());
  const [playingTaskId, setPlayingTaskId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [dubLogLines, setDubLogLines] = useState<string[]>([]);

  const [showVoiceLibrary, setShowVoiceLibrary] = useState(false);
  const [voiceEpoch, setVoiceEpoch] = useState(0);
  const selectedVoice = useMemo(() => getSelectedVoice(), [voiceEpoch]);

  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const dubLogEndRef = useRef<HTMLDivElement>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const appendDubLog = useCallback((line: string) => {
    const ts = formatLogTime(new Date());
    setDubLogLines((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), `[${ts}] ${line}`]);
  }, []);

  useEffect(() => {
    dubLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [dubLogLines.length]);

  const emotionParams = useMemo(() => getEmotionTtsParams(emotion), [emotion]);

  const runningCount = useMemo(() => tasks.filter((t) => t.phase === 'running').length, [tasks]);

  const selectableTaskIds = useMemo(
    () => tasks.filter((t) => t.phase !== 'running').map((t) => t.id),
    [tasks]
  );

  const selectedSelectableCount = useMemo(
    () => [...selectedTaskIds].filter((id) => selectableTaskIds.includes(id)).length,
    [selectedTaskIds, selectableTaskIds]
  );

  const selectedWithAudioCount = useMemo(
    () =>
      tasks.filter(
        (t) => selectedTaskIds.has(t.id) && t.phase === 'done' && t.audioUrl
      ).length,
    [tasks, selectedTaskIds]
  );

  useEffect(() => {
    setSelectedTaskIds((prev) => {
      const valid = new Set(tasks.map((t) => t.id));
      const next = new Set([...prev].filter((id) => valid.has(id)));
      if (next.size === prev.size && [...prev].every((id) => next.has(id))) return prev;
      return next;
    });
  }, [tasks]);

  useEffect(() => {
    if (runningCount === 0) return;
    const id = window.setInterval(() => setTick((x) => x + 1), 400);
    return () => clearInterval(id);
  }, [runningCount]);

  const patchTask = useCallback((taskId: string, patch: Partial<DubbingTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
  }, []);

  const togglePlay = useCallback(
    (taskId: string, url: string) => {
      const el = audioRefs.current.get(taskId);
      if (!el) return;
      if (playingTaskId === taskId && !el.paused) {
        el.pause();
        setPlayingTaskId(null);
        return;
      }
      audioRefs.current.forEach((node, id) => {
        if (id !== taskId) {
          node.pause();
          node.currentTime = 0;
        }
      });
      if (el.src !== url) el.src = url;
      void el.play().then(
        () => setPlayingTaskId(taskId),
        () => toast.error('无法播放该音频', 4000)
      );
    },
    [playingTaskId, toast]
  );

  const toggleTaskSelected = useCallback((taskId: string) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (!task || task.phase === 'running') return;
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const selectAllSelectableTasks = useCallback(() => {
    setSelectedTaskIds(new Set(selectableTaskIds));
  }, [selectableTaskIds]);

  const deleteSelectedTasks = useCallback(() => {
    const toRemove = new Set(
      [...selectedTaskIds].filter((id) => selectableTaskIds.includes(id))
    );
    if (toRemove.size === 0) {
      toast.error('请先勾选要删除的任务（进行中的任务不可勾选）');
      return;
    }
    setTasks((prev) => prev.filter((t) => !toRemove.has(t.id)));
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      toRemove.forEach((id) => next.delete(id));
      return next;
    });
    if (playingTaskId && toRemove.has(playingTaskId)) {
      audioRefs.current.get(playingTaskId)?.pause();
      setPlayingTaskId(null);
    }
    toRemove.forEach((id) => audioRefs.current.delete(id));
    toast.success(`已删除 ${toRemove.size} 条任务`);
  }, [selectedTaskIds, selectableTaskIds, playingTaskId, toast]);

  const clearAllTasks = useCallback(() => {
    if (tasks.length === 0) return;
    const hasRunning = tasks.some((t) => t.phase === 'running');
    const msg = hasRunning
      ? '列表中有进行中的任务，清空后仍会尝试在后台完成已发起的合成，仅移除列表展示。确定清空？'
      : '确定清空全部配音任务？';
    if (!confirm(msg)) return;
    setTasks([]);
    setSelectedTaskIds(new Set());
    setPlayingTaskId(null);
    audioRefs.current.clear();
    toast.success('已清空任务列表');
  }, [tasks, toast]);

  const batchDownloadSelected = useCallback(async () => {
    const items = tasks.filter(
      (t) => selectedTaskIds.has(t.id) && t.phase === 'done' && t.audioUrl
    );
    if (items.length === 0) {
      toast.error('请勾选已完成的条目（含音频）后再批量下载');
      return;
    }
    toast.success(`开始依次下载 ${items.length} 个文件…`, 2500);
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      await downloadAudioFile(t.audioUrl!, `${fileStemFromDisplayName(t.displayName)}.mp3`);
      if (i < items.length - 1) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }, [tasks, selectedTaskIds, toast]);

  const handleGenerate = () => {
    const raw = scriptText.trim();
    if (!raw) {
      toast.error('请先输入要配音的口播正文');
      return;
    }
    if (!runningHubApiKey.trim()) {
      toast.error('请先填写 RunningHub API Key');
      return;
    }

    const taskId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `dub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const created = new Date();
    const displayName = formatDubTaskDisplayName(created);
    const yunwuKey = apiKey.trim();
    const willPolish = !skipLlm && !!yunwuKey;
    const trackPersona =
      !skipLlm && trackMode === 'track' ? getDubbingTrackById(selectedTrackId)?.persona : undefined;

    const snapshot = {
      raw,
      rh: runningHubApiKey.trim(),
      yunwuKey: yunwuKey || undefined,
      skipLlm,
      trackPersona,
      customHint: customHint.trim() || undefined,
      speed,
      emphasisStrength: emotionParams.emphasisStrength,
      pitch: emotionParams.pitch,
    };

    const preview =
      raw.length > 56 ? `${raw.slice(0, 56)}…` : raw;

    const newTask: DubbingTask = {
      id: taskId,
      displayName,
      createdAt: created.getTime(),
      scriptPreview: preview,
      phase: 'running',
      uiStage: willPolish ? 'polish' : 'tts',
    };

    setTasks((prev) => [newTask, ...prev].slice(0, MAX_TASKS));

    appendDubLog(`[${displayName}] 任务开始 · 正文 ${raw.length} 字 · 情绪/语速等参数已快照`);

    const t0 = Date.now();
    let tTtsStart = 0;

    void (async () => {
      try {
        const { audioUrl, speakText, englishWarn } = await runOneClickTts(snapshot.rh, snapshot.raw, {
          yunwuApiKey: snapshot.yunwuKey,
          skipLlmPolish: snapshot.skipLlm,
          trackPersona: snapshot.trackPersona,
          customHint: snapshot.customHint,
          speed: snapshot.speed,
          emphasisStrength: snapshot.emphasisStrength,
          pitch: snapshot.pitch,
          onLog: (msg) => appendDubLog(`[${displayName}] ${msg}`),
          onProgress: (stage: OneClickTtsProgressStage) => {
            const now = Date.now();
            if (stage === 'polish') {
              patchTask(taskId, { uiStage: 'polish' });
            } else {
              tTtsStart = now;
              patchTask(taskId, {
                uiStage: 'tts',
                polishMs: willPolish ? now - t0 : undefined,
              });
            }
          },
        });

        const tEnd = Date.now();
        const ttsMs = tTtsStart > 0 ? tEnd - tTtsStart : tEnd - t0;
        patchTask(taskId, {
          phase: 'done',
          audioUrl,
          speakText,
          englishWarn,
          ttsMs,
          totalMs: tEnd - t0,
        });

        if (englishWarn) {
          toast.warning(
            `「${displayName}」正文偏英文且使用默认中文参考音，听感可能不符；建议在语音库上传英文参考音。`,
            6000
          );
        }
        appendDubLog(`[${displayName}] ✓ 任务成功 · 总耗时 ${formatDurationMs(tEnd - t0)}`);
        toast.success(`配音已完成 · ${displayName}`, 2800);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '配音失败';
        const tEnd = Date.now();
        patchTask(taskId, {
          phase: 'error',
          error: msg,
          totalMs: tEnd - t0,
        });
        appendDubLog(`[${displayName}] ✖ 失败：${msg} · 已耗时 ${formatDurationMs(tEnd - t0)}`);
        toast.error(`${displayName}：${msg}`, 6000);
      }
    })();
  };

  const liveElapsed = (task: DubbingTask) => {
    void tick;
    if (task.phase !== 'running') return 0;
    return Date.now() - task.createdAt;
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-10">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25">
            <Mic className="w-8 h-8 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-100 tracking-tight">一键配音</h1>
            <p className="text-sm text-slate-500 mt-1 max-w-2xl leading-relaxed">
              原创大语言模型优化润色方案，一键生成高转化、深呼吸感的配音脚本，完美解决 AI 配音不自然、断句机械的痛点。
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2 text-slate-400 text-xs font-medium uppercase tracking-wide">
          <KeyRound size={14} className="text-emerald-500/80" />
          RunningHub API Key
        </div>
        <input
          type="password"
          value={runningHubApiKey}
          onChange={(e) => {
            const v = e.target.value;
            setRunningHubApiKey?.(v);
          }}
          placeholder="与一键成片配音共用，用于 TTS 合成"
          className="w-full bg-slate-950/80 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-4">
          <div className="rounded-xl border border-slate-700/80 bg-[#07080c] overflow-hidden shadow-inner">
            <div className="px-3 py-2 border-b border-slate-800/90 flex items-center justify-between gap-2 bg-slate-900/50">
              <div className="flex items-center gap-2 min-w-0">
                <Terminal className="w-4 h-4 text-emerald-500/90 shrink-0" aria-hidden />
                <span className="text-xs font-semibold text-slate-300 truncate">配音流程日志</span>
                <span className="text-[10px] text-slate-600 font-mono hidden sm:inline">terminal</span>
              </div>
              <button
                type="button"
                onClick={() => setDubLogLines([])}
                className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 px-2 py-1 rounded-md border border-transparent hover:border-slate-700 hover:bg-slate-800/80"
              >
                <Trash2 className="w-3.5 h-3.5" />
                清空
              </button>
            </div>
            <div
              className="px-3 py-2.5 font-mono text-[11px] leading-relaxed max-h-[min(220px,40vh)] overflow-y-auto text-emerald-400/95 selection:bg-emerald-500/25"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
            >
              {dubLogLines.length === 0 ? (
                <span className="text-slate-600">
                  $ 等待配音任务… 点击「生成配音」后将在此完整输出：润色 → 参考音 → RunningHub TTS → 结果。
                </span>
              ) : (
                dubLogLines.map((line, i) => (
                  <div key={`${i}-${line.slice(0, 24)}`} className="whitespace-pre-wrap break-words border-b border-slate-800/40 pb-1 mb-1 last:border-0 last:pb-0 last:mb-0">
                    <span className="text-slate-500">{line.match(/^\[[\d.:]+\]/)?.[0] ?? ''}</span>
                    <span className="text-emerald-400/95">{line.replace(/^\[[\d.:]+\]\s*/, '')}</span>
                  </div>
                ))
              )}
              <div ref={dubLogEndRef} />
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/30 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="text-sm font-semibold text-slate-200">口播正文</span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                <span className="text-slate-500">字数控制在 {SCRIPT_MAX_LEN} 字以内</span>
                <span
                  className={`tabular-nums ${
                    scriptText.length >= SCRIPT_MAX_LEN
                      ? 'text-amber-400'
                      : scriptText.length >= Math.floor(SCRIPT_MAX_LEN * 0.9)
                        ? 'text-amber-500/90'
                        : 'text-slate-500'
                  }`}
                >
                  {scriptText.length} / {SCRIPT_MAX_LEN}
                </span>
              </div>
            </div>
            <textarea
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value.slice(0, SCRIPT_MAX_LEN))}
              rows={14}
              className="w-full bg-transparent px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none resize-y min-h-[280px]"
              placeholder="粘贴或输入需要配音的口播稿…"
            />
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-200">口播优化 · 赛道风格</span>
              <button
                type="button"
                onClick={() => {
                  const list = DUBBING_STYLE_TRACKS;
                  if (!list.length) return;
                  const t = list[Math.floor(Math.random() * list.length)];
                  setTrackMode('track');
                  setSelectedTrackId(t.id);
                }}
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-400 px-2.5 py-1 rounded-lg border border-slate-700 hover:border-emerald-500/40 transition-colors"
              >
                <Shuffle size={14} />
                随机赛道
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setTrackMode('none')}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  trackMode === 'none'
                    ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-200'
                    : 'bg-slate-800/80 border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                <span className="text-sm leading-none shrink-0 opacity-95" aria-hidden>
                  ✨
                </span>
                无风格（仅默认润色）
              </button>
              {DUBBING_STYLE_TRACKS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setTrackMode('track');
                    setSelectedTrackId(t.id);
                  }}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    trackMode === 'track' && selectedTrackId === t.id
                      ? 'bg-slate-800 border-slate-500 text-slate-100'
                      : 'bg-slate-900/50 border-slate-700/80 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <span className="text-sm leading-none shrink-0 opacity-95" aria-hidden title={t.label}>
                    {t.emoji}
                  </span>
                  {t.label}
                </button>
              ))}
            </div>
            {trackMode === 'track' && getDubbingTrackById(selectedTrackId) && (
              <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3 text-xs text-slate-400 leading-relaxed">
                <span className="text-slate-500 block mb-1.5 text-[11px] uppercase tracking-wide">
                  当前人设（写入大模型，非口播正文）
                </span>
                {getDubbingTrackById(selectedTrackId)?.persona}
              </div>
            )}
            <div>
              <label className="text-xs text-slate-500 block mb-1.5">自定义补充（可选）</label>
              <textarea
                value={customHint}
                onChange={(e) => setCustomHint(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/40"
                placeholder="追加给优化模型的说明，例如停顿、语气…"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={skipLlm}
                onChange={(e) => setSkipLlm(e.target.checked)}
                className="rounded border-slate-600"
              />
              <span className="text-sm text-slate-300">跳过口播优化，正文直送 TTS</span>
            </label>
          </div>
        </div>

        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 space-y-3">
            <span className="text-sm font-semibold text-slate-200">参考音色</span>
            <p className="text-sm text-slate-400 bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2.5">
              {selectedVoice?.name || '未选择 · 使用系统默认参考音'}
            </p>
            <button
              type="button"
              onClick={() => setShowVoiceLibrary(true)}
              className="w-full py-2 rounded-lg text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              管理语音库
            </button>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 space-y-4">
            <span className="text-sm font-semibold text-slate-200">合成参数</span>
            <div>
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>语速</span>
                <span className="tabular-nums text-slate-400">{speed.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.75}
                max={1.25}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">情绪倾向</label>
              <select
                value={emotion}
                onChange={(e) => setEmotion(e.target.value as DubbingEmotionId)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500/40"
              >
                {DUBBING_EMOTION_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {!apiKey.trim() && !skipLlm && (
              <p className="text-[11px] text-amber-500/90 leading-relaxed">
                未配置云雾 API Key（设置面板）时无法进行 gpt-5.4-mini 优化；可勾选「跳过优化」直接合成。
              </p>
            )}
            <p className="text-[11px] text-slate-500 leading-relaxed">
              支持并行：生成进行中仍可修改口播并再次点击生成，每条任务以创建时的「日期 + 时间」命名，独立排队执行。
            </p>
            <button
              type="button"
              disabled={!runningHubApiKey.trim()}
              onClick={handleGenerate}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-900/20"
            >
              <Volume2 size={18} />
              生成配音
              {runningCount > 0 ? (
                <span className="ml-1 text-xs font-normal opacity-90 tabular-nums">（{runningCount} 进行中）</span>
              ) : null}
            </button>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/30 overflow-hidden">
            <div className="px-3 sm:px-4 py-2.5 border-b border-slate-800/80 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-200">配音任务</span>
                <span className="text-[11px] text-slate-500 tabular-nums">
                  共 {tasks.length} 条
                  {runningCount > 0 ? ` · ${runningCount} 进行中` : ''}
                  {selectedSelectableCount > 0 ? ` · 已选 ${selectedSelectableCount}` : ''}
                </span>
              </div>
              {tasks.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 justify-end">
                  <button
                    type="button"
                    disabled={selectableTaskIds.length === 0}
                    onClick={selectAllSelectableTasks}
                    className="text-[11px] px-2 py-1 rounded-md border border-slate-600 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    disabled={selectedSelectableCount === 0}
                    onClick={deleteSelectedTasks}
                    className="text-[11px] px-2 py-1 rounded-md border border-slate-600 text-slate-400 hover:bg-slate-800 hover:text-amber-200/90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    删除选中
                  </button>
                  <button
                    type="button"
                    disabled={selectedWithAudioCount === 0}
                    onClick={() => void batchDownloadSelected()}
                    className="text-[11px] px-2 py-1 rounded-md border border-emerald-500/40 text-emerald-400/90 hover:bg-emerald-950/40 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    批量下载
                  </button>
                  <button
                    type="button"
                    onClick={clearAllTasks}
                    className="text-[11px] px-2 py-1 rounded-md border border-red-500/30 text-red-400/90 hover:bg-red-950/30"
                  >
                    一键清空
                  </button>
                </div>
              )}
            </div>
            <div className="p-3 max-h-[min(70vh,520px)] overflow-y-auto space-y-2">
              {tasks.length === 0 ? (
                <p className="text-xs text-slate-500 text-center py-8 px-2">
                  暂无任务。点击「生成配音」后，任务会按时间顺序出现在此，可试听、下载，并查看各阶段耗时。
                </p>
              ) : (
                tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`rounded-lg border p-3 space-y-2 transition-colors ${
                      task.phase === 'running'
                        ? 'border-emerald-500/35 bg-emerald-950/15'
                        : task.phase === 'done'
                          ? 'border-slate-700/90 bg-slate-950/40'
                          : 'border-red-500/25 bg-red-950/10'
                    } ${selectedTaskIds.has(task.id) && task.phase !== 'running' ? 'ring-1 ring-emerald-500/35' : ''}`}
                  >
                    <div className="flex items-start gap-2">
                      {task.phase !== 'running' ? (
                        <input
                          type="checkbox"
                          checked={selectedTaskIds.has(task.id)}
                          onChange={() => toggleTaskSelected(task.id)}
                          className="mt-1 rounded border-slate-600 accent-emerald-500 shrink-0 cursor-pointer"
                          title="勾选后可删除或参与批量下载"
                          aria-label={`选择任务 ${task.displayName}`}
                        />
                      ) : (
                        <span
                          className="mt-1 w-4 h-4 shrink-0 rounded border border-slate-600/50 bg-slate-800/50"
                          title="进行中不可勾选"
                          aria-hidden
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-100 tabular-nums">{task.displayName}</span>
                          {task.phase === 'running' && (
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              {task.uiStage === 'polish' ? '口播优化' : 'TTS 合成'}
                            </span>
                          )}
                          {task.phase === 'done' && (
                            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-700/80 text-slate-300 border border-slate-600">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              完成
                            </span>
                          )}
                          {task.phase === 'error' && (
                            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/25">
                              <AlertCircle className="w-3 h-3" />
                              失败
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{task.scriptPreview}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 pl-0 sm:pl-7">
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Clock className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                        {task.phase === 'running' ? (
                          <>
                            已用 <span className="text-emerald-400/90">{formatDurationMs(liveElapsed(task))}</span>
                            {task.uiStage === 'polish' ? ' · 大模型润色' : ' · RunningHub 合成'}
                          </>
                        ) : task.phase === 'done' ? (
                          <>
                            总耗时{' '}
                            <span className="text-slate-400">
                              {task.totalMs != null ? formatDurationMs(task.totalMs) : '—'}
                            </span>
                            {task.polishMs != null && (
                              <>
                                {' '}
                                · 优化 {formatDurationMs(task.polishMs)}
                              </>
                            )}
                            {task.ttsMs != null && (
                              <>
                                {' '}
                                · 合成 {formatDurationMs(task.ttsMs)}
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            失败前已用{' '}
                            {task.totalMs != null ? formatDurationMs(task.totalMs) : formatDurationMs(liveElapsed(task))}
                          </>
                        )}
                      </span>
                    </div>

                    {task.phase === 'done' && task.audioUrl && (
                      <div className="flex flex-wrap items-center gap-2 pt-1 pl-0 sm:pl-7">
                        <audio
                          ref={(el) => {
                            if (el) {
                              audioRefs.current.set(task.id, el);
                              el.onended = () => {
                                if (tasksRef.current.some((x) => x.id === task.id && x.phase === 'done')) {
                                  setPlayingTaskId((cur) => (cur === task.id ? null : cur));
                                }
                              };
                            } else {
                              audioRefs.current.delete(task.id);
                            }
                          }}
                          src={task.audioUrl}
                          preload="metadata"
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => togglePlay(task.id, task.audioUrl!)}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 min-w-[5.5rem]"
                        >
                          {playingTaskId === task.id ? (
                            <>
                              <Pause size={14} className="text-emerald-400" />
                              暂停
                            </>
                          ) : (
                            <>
                              <Play size={14} className="text-emerald-400" />
                              播放
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void downloadAudioFile(task.audioUrl!, `${fileStemFromDisplayName(task.displayName)}.mp3`)
                          }
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-600"
                        >
                          <Download size={14} className="text-slate-400" />
                          下载
                        </button>
                      </div>
                    )}

                    {task.phase === 'error' && task.error && (
                      <p className="text-[11px] text-red-400/90 leading-relaxed">{task.error}</p>
                    )}

                    {task.phase === 'done' && task.speakText && (
                      <details className="text-[11px] text-slate-500">
                        <summary className="cursor-pointer text-slate-400 hover:text-slate-300">送 TTS 文本</summary>
                        <p className="mt-1.5 whitespace-pre-wrap text-slate-400 leading-relaxed max-h-32 overflow-y-auto">
                          {task.speakText}
                        </p>
                      </details>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {showVoiceLibrary && (
        <VoiceLibrary
          onClose={() => setShowVoiceLibrary(false)}
          onVoicesChange={() => setVoiceEpoch((e) => e + 1)}
        />
      )}
    </div>
  );
};
