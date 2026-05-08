import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Video,
  Upload,
  Loader2,
  Play,
  Pause,
  Download,
  Clock,
  AlertCircle,
  CheckCircle2,
  Trash2,
  History,
  X,
  Mic,
  Film,
  Archive,
  ChevronDown,
  ChevronRight,
  CheckSquare,
  Square,
  RefreshCw,
  Terminal,
  Library,
  Trash,
  HardDrive,
  Volume2,
  Plus,
  ExternalLink,
} from 'lucide-react';
import { useToast } from './Toast';
import {
  uploadReferenceVideoToRunningHub,
  submitDigitalHumanTask,
  pollDigitalHumanUntilDone,
  splitTextByLanguage,
  type DhSegmentTask,
  type DhHistoryRecord,
  loadDhHistory,
  removeDhHistoryIds,
  getActiveDhSessionId,
  clearActiveDhSession,
  ensureDhSession,
  updateDhSegmentAudio,
  updateDhSegmentVideo,
  packVideosToZip,
  packVideosToBatches,
  BATCH_ZIP_SIZE,
  type DownloadProgressCallback,
  dhConcurrency,
  uploadAudioToRunningHub,
} from '../services/digitalHumanService';
import { runOneClickTts } from '../services/oneClickTtsService';
import {
  listVideoLibrary,
  saveVideoToLibrary,
  deleteVideoFromLibrary,
  updateVideoRhPath,
  getVideoFromLibrary,
  formatFileSize,
  type VideoLibraryItem,
} from '../services/videoLibraryService';
import { VoiceLibrary } from './VoiceLibrary';
import { getSelectedVoice } from '../services/voiceLibraryService';

const MAX_CONCURRENT = 20;
const MAX_LOG_LINES = 500;

function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ============================================================
// 历史记录 Modal
// ============================================================

function formatDurationMs(ms?: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ============================================================
// 历史记录 Modal
// ============================================================

function HistoryModal({
  entries,
  onClose,
  onLoad,
  onRemove,
}: {
  entries: DhHistoryRecord[];
  onClose: () => void;
  onLoad: (rec: DhHistoryRecord) => void;
  onRemove: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  const [previewVideoName, setPreviewVideoName] = useState<string>('');

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[780px] max-h-[85vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
            <h3 className="text-lg font-semibold text-white flex items-center gap-2">
              <History size={18} className="text-blue-400" />
              数字人对口型历史
              <span className="text-xs text-gray-500 font-normal">（自动保存，永久保留）</span>
            </h3>
            <div className="flex items-center gap-3">
              {selected.size > 0 && (
                <button
                  onClick={() => {
                    onRemove([...selected]);
                    setSelected(new Set());
                  }}
                  className="text-sm text-red-400 hover:text-red-300"
                >
                  删除选中 ({selected.size})
                </button>
              )}
              <button onClick={onClose} className="text-gray-400 hover:text-white">
                <X size={20} />
              </button>
            </div>
          </div>

          <div className="overflow-y-auto flex-1 px-5 py-3 space-y-2">
            {entries.length === 0 ? (
              <p className="text-gray-500 text-center py-12">暂无历史记录</p>
            ) : (
              entries.map((rec) => (
                <div key={rec.id} className="bg-gray-800 rounded-lg overflow-hidden">
                  {/* 摘要行 */}
                  <div
                    className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-gray-750 transition-colors"
                    onClick={() => setExpandedId(expandedId === rec.id ? null : rec.id)}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(rec.id);
                      }}
                      className="mt-0.5 text-gray-400 hover:text-white"
                    >
                      {selected.has(rec.id) ? (
                        <CheckSquare size={18} className="text-blue-400" />
                      ) : (
                        <Square size={18} />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-medium text-white text-sm">{rec.displayName}</span>
                        <span className="text-xs text-gray-500">
                          {new Date(rec.createdAt).toLocaleString('zh-CN')}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 truncate">
                        {rec.referenceVideoName || '无参考视频'} · {rec.segmentCount} 段
                      </p>
                      <div className="flex gap-2 mt-1">
                        {rec.successCount > 0 && (
                          <span className="text-xs bg-green-900/40 text-green-400 px-2 py-0.5 rounded">
                            成功 {rec.successCount} 段
                          </span>
                        )}
                        {rec.failedCount > 0 && (
                          <span className="text-xs bg-red-900/40 text-red-400 px-2 py-0.5 rounded">
                            失败 {rec.failedCount} 段
                          </span>
                        )}
                        <span className="text-xs text-gray-600 px-2 py-0.5">
                          {rec.scriptPreview?.slice(0, 40)}…
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onLoad(rec);
                      }}
                      className="shrink-0 text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white"
                    >
                      加载
                    </button>
                  </div>

                  {/* 展开的段落详情 */}
                  {expandedId === rec.id && (
                    <div className="border-t border-gray-700 bg-gray-850 max-h-[320px] overflow-y-auto">
                      {rec.segments.map((seg) => (
                        <div
                          key={seg.index}
                          className="px-4 py-2.5 border-b border-gray-700/60 last:border-b-0 flex items-center gap-3 hover:bg-gray-750/50"
                        >
                          <span className="text-xs font-medium text-gray-500 w-10 flex-shrink-0">
                            段{seg.index}
                          </span>

                          {/* 音频 */}
                          {seg.audioUrl ? (
                            <button
                              onClick={() =>
                                setPlayingAudio(playingAudio === seg.audioUrl ? null : seg.audioUrl!)
                              }
                              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                            >
                              <Volume2 size={13} />
                              <span className="text-gray-400">
                                {playingAudio === seg.audioUrl ? '暂停' : '试听'}
                              </span>
                              {seg.durationMs != null && (
                                <span className="text-gray-600">
                                  {formatDurationMs(seg.durationMs)}
                                </span>
                              )}
                            </button>
                          ) : (
                            <span className="text-xs text-gray-600 flex items-center gap-1">
                              <Volume2 size={13} />
                              {seg.audioError ? (
                                <span className="text-red-400">失败</span>
                              ) : (
                                <span>待配音</span>
                              )}
                            </span>
                          )}

                          {/* 分隔 */}
                          <div className="w-px h-4 bg-gray-700 flex-shrink-0" />

                          {/* 视频 */}
                          {seg.videoUrl ? (
                            <button
                              onClick={() => {
                                setPreviewVideoUrl(seg.videoUrl!);
                                setPreviewVideoName(`段${seg.index} 数字人视频`);
                              }}
                              className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300"
                            >
                              <Video size={13} />
                              <span className="text-gray-400">预览</span>
                              {seg.dhMs != null && (
                                <span className="text-gray-600">
                                  {formatDurationMs(seg.dhMs)}
                                </span>
                              )}
                            </button>
                          ) : (
                            <span className="text-xs text-gray-600 flex items-center gap-1">
                              <Video size={13} />
                              {seg.dhError ? (
                                <span className="text-red-400">失败</span>
                              ) : (
                                <span>待生成</span>
                              )}
                            </span>
                          )}

                          {/* 原文预览 */}
                          <span className="text-xs text-gray-600 truncate flex-1">
                            {seg.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 隐藏的音频播放器（用于试听） */}
      {playingAudio && (
        <audio
          src={playingAudio}
          autoPlay
          onEnded={() => setPlayingAudio(null)}
          className="hidden"
        />
      )}

      {/* 视频预览 */}
      {previewVideoUrl && (
        <VideoPreviewModal
          url={previewVideoUrl}
          name={previewVideoName}
          onClose={() => setPreviewVideoUrl(null)}
        />
      )}
    </>
  );
}

// ============================================================
// 视频预览 Modal
// ============================================================

function VideoPreviewModal({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative max-w-4xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm text-gray-400 truncate flex-1 mr-4">{name}</p>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1"
          >
            <X size={18} />
          </button>
        </div>
        <video
          src={url}
          controls
          autoPlay
          className="w-full rounded-lg bg-black max-h-[80vh]"
        />
      </div>
    </div>
  );
}

// ============================================================
// 视频库 Modal
// ============================================================

function VideoLibraryModal({
  onClose,
  onSelect,
  onDelete,
}: {
  onClose: () => void;
  onSelect: (item: VideoLibraryItem) => void;
  onDelete: (id: string) => void;
}) {
  const [items, setItems] = useState<VideoLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => {
    listVideoLibrary().then((list) => {
      setItems(list);
      setLoading(false);
    });
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[700px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Library size={18} />
            视频库
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-3">
          {loading ? (
            <p className="text-gray-500 text-center py-8">加载中…</p>
          ) : items.length === 0 ? (
            <p className="text-gray-500 text-center py-8">视频库为空，请先上传参考视频</p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="bg-gray-800 rounded-lg p-3 flex items-center gap-3 hover:bg-gray-750 group"
                >
                  <video
                    src={URL.createObjectURL(item.blob)}
                    className="w-16 h-12 object-cover rounded bg-black flex-shrink-0"
                    onMouseEnter={(e) => (e.currentTarget as HTMLVideoElement).play()}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLVideoElement;
                      el.pause();
                      el.currentTime = 0;
                    }}
                    muted
                    loop
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{item.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatFileSize(item.size)} · {new Date(item.createdAt).toLocaleString('zh-CN')}
                      {item.rhPath && (
                        <span className="ml-2 text-green-400">✓ 已上传</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!item.rhPath && (
                      <span className="text-xs text-yellow-500 mr-1">未上传</span>
                    )}
                    <button
                      onClick={() => onSelect(item)}
                      className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs text-white"
                    >
                      使用
                    </button>
                    <button
                      onClick={() => {
                        deleteVideoFromLibrary(item.id);
                        setItems((prev) => prev.filter((i) => i.id !== item.id));
                      }}
                      className="p-1.5 rounded hover:bg-red-900/50 text-gray-500 hover:text-red-400"
                      title="删除"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-700 flex items-center gap-2 text-xs text-gray-600">
          <HardDrive size={12} />
          <span>
            {items.length} 个视频 ·{' '}
            {formatFileSize(items.reduce((sum, i) => sum + i.size, 0))}
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 一键成片进度条
// ============================================================
function OneClickProgressBar({
  progress,
  currentPhase,
}: {
  progress: { phase: 'audio' | 'dh'; done: number; total: number; startMs: number };
  currentPhase: 'audio' | 'dh' | 'done';
}) {
  const [elapsed, setElapsed] = useState(Date.now() - progress.startMs);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - progress.startMs);
    }, 1000);
    return () => clearInterval(interval);
  }, [progress.startMs]);

  // 直接用 props 计算，避免 local state 闭包延迟
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const phaseLabel = progress.phase === 'audio' ? '配音' : '数字人';
  const phaseColor = progress.phase === 'audio' ? 'from-blue-500 to-purple-500' : 'from-green-500 to-emerald-500';
  const barColor = progress.phase === 'audio' ? 'bg-blue-500' : 'bg-green-500';

  return (
    <div className="bg-gray-800/80 rounded-xl p-3 border border-gray-700/60 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-300 font-medium">
          {currentPhase === 'done' ? '✅ 一键成片完成' : `阶段${progress.phase === 'audio' ? '①' : '②'} · ${phaseLabel}中`}
        </span>
        <span className="text-gray-500 tabular-nums">{formatElapsed(elapsed)}</span>
      </div>

      <div className="relative h-3 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${phaseColor} transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] font-bold text-white drop-shadow-sm tabular-nums">
            {pct}%
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px]">
        <span className={`${barColor} text-white font-bold px-2 py-0.5 rounded`}>
          {progress.done}/{progress.total} 段
        </span>
        {currentPhase !== 'done' && (
          <span className="text-gray-500">
            剩余 {progress.total - progress.done} 段 · {formatElapsed(elapsed)}
          </span>
        )}
        {currentPhase === 'done' && (
          <span className="text-emerald-400 font-medium">
            打包下载中…
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 主面板
// ============================================================

interface DigitalHumanPanelProps {
  apiKey: string;
  runningHubApiKey: string;
  setRunningHubApiKey: (k: string) => void;
  toast: ReturnType<typeof useToast>;
}

export function DigitalHumanPanel({
  apiKey,
  runningHubApiKey,
  setRunningHubApiKey,
  toast,
}: DigitalHumanPanelProps) {
  // --- 参考视频状态 ---
  const [refVideoFile, setRefVideoFile] = useState<File | null>(null);
  const [refVideoName, setRefVideoName] = useState('');
  const [refVideoRhPath, setRefVideoRhPath] = useState('');   // RunningHub 路径
  const [refVideoUploadPct, setRefVideoUploadPct] = useState(0);
  const [refVideoUploading, setRefVideoUploading] = useState(false);

  // --- 原文 & 分割 ---
  const [scriptText, setScriptText] = useState('');
  const [segments, setSegments] = useState<DhSegmentTask[]>([]);
  const [detectedLang, setDetectedLang] = useState<'zh' | 'en' | null>(null);

  // --- 任务状态 ---
  const [tasks, setTasks] = useState<DhSegmentTask[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // --- 一键成片进度 ---
  const [ocProgress, setOcProgress] = useState<{
    phase: 'audio' | 'dh';
    done: number;
    total: number;
    startMs: number;
  } | null>(null);

  // --- 数字人会话（自动保存历史） ---
  const [dhSessionId, setDhSessionId] = useState<string>('');
  const [sessionInitialized, setSessionInitialized] = useState(false);

  // --- 日志 ---
  const [logLines, setLogLines] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // --- Modal ---
  const [showHistory, setShowHistory] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<DhHistoryRecord[]>([]);
  const [previewVideo, setPreviewVideo] = useState<{ url: string; name: string } | null>(null);
  const [showVideoLibrary, setShowVideoLibrary] = useState(false);
  const [libraryVideoId, setLibraryVideoId] = useState<string | null>(null);
  const [showVoiceLibrary, setShowVoiceLibrary] = useState(false);
  const [voiceEpoch, setVoiceEpoch] = useState(0);
  const selectedVoice = useMemo(() => getSelectedVoice(), [voiceEpoch]);
  const [oneClickFilm, setOneClickFilm] = useState<'idle' | 'audio' | 'dh' | 'done'>('idle');

  /** 新建任务弹窗 */
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [newTaskText, setNewTaskText] = useState('');

  /** 独立任务多选状态 */
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());

  /** 挂起队列状态（支持多个独立任务） */
  const [oneClickQueue, setOneClickQueue] = useState<{
    /** 来源 session ID（独立任务才有，主任务为空字符串） */
    sessionIds: string[];
    /** 挂起的段落快照（sessionId -> segmentIds[]） */
    pendingSegmentsBySession: Record<string, string[]>;
  } | null>(null);

  /** 挂起队列的完整任务快照（用于独立显示和执行） */
  const [queuedTasks, setQueuedTasks] = useState<typeof tasks | null>(null);

  /** 独立新建任务列表（不影响当前正在执行的任务） */
  const [newTaskSessions, setNewTaskSessions] = useState<Array<{
    id: string;
    text: string;
    segments: DhSegmentTask[];
    ocProgress: { phase: 'audio' | 'dh'; done: number; total: number; startMs: number } | null;
    ocState: 'idle' | 'audio' | 'dh' | 'done';
    ocQueue: { pendingSegmentIds: string[]; waitingCount: number; isWaiting: boolean } | null;
    progressRef: { phase: 'audio' | 'dh'; done: number; total: number; startMs: number } | null;
    queueRef: { pendingSegmentIds: string[]; waitingCount: number; isWaiting: boolean } | null;
  }>>([]);

  /** 下载进度状态 */
  const [downloadProgress, setDownloadProgress] = useState<{
    totalFiles: number;
    currentIndex: number;
    phase: 'downloading' | 'zipping' | 'done';
    overallPercent: number;
    currentFilename: string;
    /** 当前批次进度（如分批导出） */
    batchIndex?: number;
    totalBatches?: number;
    /** 已下载字节数 */
    downloadedBytes?: number;
    /** 总字节数（所有文件） */
    totalBytes?: number;
  } | null>(null);

  // --- Refs ---
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const tasksRef = useRef(tasks);
  const pollingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const oneClickRef = useRef<'idle' | 'audio' | 'dh' | 'done'>('idle');
  /** 自动继续模式：跳过排队检查，直接从队列取出下一个任务执行 */
  const autoContinueRef = useRef(false);
  /** handleOneClickFilm 的稳定引用（避免 useEffect 依赖问题） */
  const handleOneClickFilmRef = useRef<(() => void) | null>(null);
  /** 防止 Phase 3 sync 代码与 useEffect 同时触发队列执行 */
  const queueRunningRef = useRef(false);
  /** 记录正在执行的 sessionId，防止 runQueueTask 被重复调用 */
  const runningSessionIdRef = useRef<string | null>(null);
  /** Phase 3 刚完成标志：用于触发 useEffect 执行队列（用 state 确保 React 感知变化） */
  const [phase3JustFinished, setPhase3JustFinished] = useState(false);
  /** 队列处理中标志：防止 useEffect 重复触发队列逻辑 */
  const queueProcessingRef = useRef(false);
  const genAudioRef = useRef<((taskId: string) => Promise<void>) | null>(null);
  const genDhRef = useRef<((taskId: string) => Promise<void>) | null>(null);
  // 用于一键成片 Phase1 判断：setTasks 是异步的，tasksRef 在下次渲染前不会更新
  // 因此在 setTasks 成功后同步写入这两个 Set，Phase1 可直接查询
  const completedAudioPhasesRef = useRef<Map<string, 'pending' | 'running' | 'done' | 'error'>>(new Map());
  const completedAudioUrlsRef = useRef<Map<string, string>>(new Map()); // 记录已完成音频的 URL（setTasks 后 tasksRef 不会立即同步）
  const completedDhPhasesRef = useRef<Map<string, 'done' | 'error'>>(new Map());
  const completedDhVideoUrlsRef = useRef<Map<string, string>>(new Map()); // 记录 DH 视频 URL（用于 ZIP 打包）
  // 一键成片实时进度：{ phase, done, total, startMs }
  const oneClickProgressRef = useRef<{ phase: 'audio' | 'dh'; done: number; total: number; startMs: number } | null>(null);
  // 挂起队列 ref（用于异步函数中访问最新状态）
  const oneClickQueueRef = useRef<{ sessionIds: string[]; pendingSegmentsBySession: Record<string, string[]> } | null>(null);
  // 当前执行中的任务 ID（用于 Phase 3 隔离下载范围，避免 ref 累积导致跨任务打包）
  const currentTaskSessionIdRef = useRef<string>('');
  // 当前任务的 segment IDs（用于 Phase 3 隔离下载，避免跨任务打包）
  const currentTaskSegmentIdsRef = useRef<Set<string>>(new Set());
  // 保存主任务的 segments（用于队列任务执行时恢复 UI）
  const mainTasksRef = useRef<DhSegmentTask[]>([]);

  // Keep tasksRef in sync
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // Always-fresh ref for newTaskSessions (updated synchronously to avoid stale closure in Phase 3)
  const newTaskSessionsRef = useRef(newTaskSessions);
  newTaskSessionsRef.current = newTaskSessions;

  useEffect(() => {
    oneClickRef.current = oneClickFilm;
  }, [oneClickFilm]);

  // Keep oneClickQueueRef in sync
  useEffect(() => {
    oneClickQueueRef.current = oneClickQueue;
  }, [oneClickQueue]);

  // Live ticker for running tasks
  useEffect(() => {
    const hasRunning =
      tasks.some((t) => t.audioPhase === 'running' || t.dhPhase === 'running');
    if (!hasRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 400);
    return () => clearInterval(id);
  }, [tasks]);

  // Auto-scroll log
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logLines]);

  // ============================================================
  // 监听队列变化：任务完成后自动执行下一个
  // 触发条件：phase3JustFinished 变为 true（Phase3 完成后设置），
  //           或者 oneClickFilm 变为 idle（数字人阶段完成后）
  // ============================================================
  useEffect(() => {
    console.log('[队列调试] useEffect 触发 phase3Flag=', phase3JustFinished, 'oneClickFilm=', oneClickFilm, 'queue=', oneClickQueue?.sessionIds);

    // 只有 Phase 3 完成标志触发时才执行（避免 Phase 2 设置 idle 时误触发）
    if (!phase3JustFinished && oneClickFilm !== 'idle') {
      console.log('[队列调试] 守卫1跳过: phase3JustFinished=false 且 oneClickFilm!==idle');
      return;
    }
    setPhase3JustFinished(false); // 重置标志

    // 防止重复触发：如果队列逻辑正在执行中，跳过
    if (queueProcessingRef.current) {
      console.log('[队列调试] 守卫1b跳过: queueProcessingRef=true，队列处理中');
      return;
    }
    // 防止重复触发：如果 Phase3 sync 代码正在执行独立任务，跳过
    if (queueRunningRef.current) {
      console.log('[队列调试] 守卫1c跳过: queueRunningRef=true，队列任务执行中');
      return;
    }

    if (!oneClickQueueRef.current) {
      console.log('[队列调试] 守卫2跳过: oneClickQueue=null');
      queueProcessingRef.current = false;
      return;
    }

    // sessionIds 只包含"待执行"的任务，不包含正在执行的任务
    // 取出第一个待执行任务
    const nextSessionId = oneClickQueueRef.current.sessionIds[0];
    console.log('[队列调试] sessionIds:', oneClickQueueRef.current.sessionIds, '即将执行:', nextSessionId);
    if (!nextSessionId) {
      console.log('[队列调试] 守卫3跳过: sessionIds 已空');
      queueProcessingRef.current = false;
      return; // 队列已空
    }

    // 有任务要处理，标记队列处理中（防止 useEffect 重复触发）
    queueProcessingRef.current = true;

    // 从 sessionIds 中移除正在执行的任务（这样队列里只剩待执行的）
    const newQueue = {
      sessionIds: oneClickQueueRef.current.sessionIds.slice(1), // 移除 [0]，剩下的才是真正"待执行"的
      pendingSegmentsBySession: Object.fromEntries(
        Object.entries(oneClickQueueRef.current.pendingSegmentsBySession).filter(([k]) => k !== nextSessionId)
      ),
    };
    oneClickQueueRef.current = newQueue;
    setOneClickQueue(newQueue);

    const isMainTask = nextSessionId === '';
    const sessionData = !isMainTask ? newTaskSessionsRef.current.find((s) => s.id === nextSessionId) : null;
    const nextSegments: DhSegmentTask[] = isMainTask
      ? tasks
      : (sessionData?.segments.map((seg) => ({
          id: seg.id,
          index: seg.index,
          text: seg.text,
          textLength: seg.text.length,
          audioPhase: seg.audioPhase as 'pending' | 'running' | 'done' | 'error',
          audioUrl: seg.audioUrl,
          dhPhase: seg.dhPhase as 'pending' | 'running' | 'done' | 'error',
          dhVideoUrl: seg.dhVideoUrl,
        })) ?? []);

    if (nextSegments.length === 0) {
      queueProcessingRef.current = false;
      return;
    }

    // 记录当前任务信息
    currentTaskSessionIdRef.current = nextSessionId;
    // 记录当前任务的 segment IDs（直接使用原有 id，已经是完整格式）
    currentTaskSegmentIdsRef.current = new Set(nextSegments.map((t) => t.id));

    const name = isMainTask ? '主任务' : nextSessionId.split('_')[1];

    if (isMainTask) {
      // 主任务：更新 tasks 并调用 handleOneClickFilm
      setTasks(nextSegments);
      pushLog(`[一键成片] 🔄 自动执行下一个: ${name}`);
      toast.info(`自动执行下一个任务…`);
      setTimeout(() => {
        queueProcessingRef.current = false;
        autoContinueRef.current = true;
        handleOneClickFilmRef.current?.();
      }, 300);
    } else {
      // 独立任务：将 segments 合并到 tasksRef，然后调用 runQueueTask
      // 注意：segment.id 已经是完整格式，不需要再加前缀
      const existingIds = new Set(tasksRef.current.map((t) => t.id));
      const newSegs = nextSegments
        .filter((s) => !existingIds.has(s.id))
        .map((s) => ({ ...s }));
      tasksRef.current = [...tasksRef.current, ...newSegs];
      pushLog(`[一键成片] 🔄 自动执行下一个: ${name}`);
      toast.info(`自动执行下一个任务…`);
      setTimeout(() => {
        queueProcessingRef.current = false;
        queueRunningRef.current = true;
        void runQueueTask(nextSessionId, nextSegments);
      }, 300);
    }
  }, [phase3JustFinished, setPhase3JustFinished]);

  // ============================================================
  // 日志工具
  // ============================================================
  const pushLog = useCallback((msg: string) => {
    const ts = formatTime(new Date());
    setLogLines((prev) => {
      const next = [...prev, `[${ts}] ${msg}`];
      return next.slice(-MAX_LOG_LINES);
    });
  }, []);

  // ============================================================
  // 参考视频上传
  // ============================================================
  const handleRefVideoSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!runningHubApiKey.trim()) {
        toast.error('请先配置 RunningHub API Key');
        return;
      }

      if (!file.type.startsWith('video/')) {
        toast.error('请选择视频文件');
        return;
      }

      const MAX_SIZE = 100 * 1024 * 1024; // 100MB
      if (file.size > MAX_SIZE) {
        toast.error('参考视频不能超过 100MB');
        return;
      }

      setRefVideoFile(file);
      setRefVideoName(file.name);
      setRefVideoRhPath('');
      setRefVideoUploadPct(0);
      setRefVideoUploading(true);
      setLibraryVideoId(null);
      pushLog(`开始上传参考视频: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

      try {
        const saved = await saveVideoToLibrary(file);
        setLibraryVideoId(saved.id);
        const rhPath = await uploadReferenceVideoToRunningHub(
          runningHubApiKey,
          file,
          (pct) => setRefVideoUploadPct(pct)
        );
        await updateVideoRhPath(saved.id, rhPath);
        setRefVideoRhPath(rhPath);
        setRefVideoUploading(false);
        pushLog(`✅ 参考视频上传成功: ${rhPath}`);
        toast.success('参考视频上传成功');
      } catch (err: any) {
        setRefVideoUploading(false);
        pushLog(`❌ 参考视频上传失败: ${err.message}`);
        toast.error(`上传失败: ${err.message}`);
        setRefVideoFile(null);
        setRefVideoName('');
        setLibraryVideoId(null);
      }
    },
    [runningHubApiKey, toast, pushLog]
  );

  // ============================================================
  // 从视频库选择参考视频
  // ============================================================
  const handleSelectFromLibrary = useCallback(
    async (item: VideoLibraryItem) => {
      if (!runningHubApiKey.trim()) {
        toast.error('请先配置 RunningHub API Key');
        return;
      }

      setRefVideoFile(null);
      setRefVideoName(item.name);
      setLibraryVideoId(item.id);

      if (item.rhPath) {
        // 已上传过，直接复用
        setRefVideoRhPath(item.rhPath);
        setRefVideoUploading(false);
        pushLog(`从视频库选择: ${item.name}（已上传，直接复用）`);
        toast.success('已选择视频库中的参考视频');
      } else {
        // 未上传，需要重新上传
        setRefVideoRhPath('');
        setRefVideoUploadPct(0);
        setRefVideoUploading(true);
        pushLog(`从视频库选择: ${item.name}，正在重新上传…`);

        try {
          const rhPath = await uploadReferenceVideoToRunningHub(
            runningHubApiKey,
            item.blob as unknown as File,
            (pct) => setRefVideoUploadPct(pct)
          );
          await updateVideoRhPath(item.id, rhPath);
          setRefVideoRhPath(rhPath);
          setRefVideoUploading(false);
          pushLog(`✅ 视频库视频重新上传成功: ${rhPath}`);
          toast.success('视频库视频已重新上传');
        } catch (err: any) {
          setRefVideoUploading(false);
          pushLog(`❌ 视频库视频重新上传失败: ${err.message}`);
          toast.error(`重新上传失败: ${err.message}`);
          setRefVideoName('');
          setLibraryVideoId(null);
        }
      }
    },
    [runningHubApiKey, toast, pushLog]
  );

  // ============================================================
  // 原文输入 & 分割预览
  // ============================================================
  const handleScriptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setScriptText(val);

      if (!val.trim()) {
        setSegments([]);
        setDetectedLang(null);
        return;
      }

      // 如果有任务正在执行，阻止替换当前任务（编辑框仍可编辑，用于粘贴或复制）
      if (oneClickRef.current !== 'idle') {
        const hasRunning = tasks.some((t) => t.audioPhase === 'running' || t.dhPhase === 'running');
        if (hasRunning) {
          // 只更新显示文本，不替换任务
          setScriptText(val);
          return;
        }
      }

      const { lang, chunks } = splitTextByLanguage(val);
      setDetectedLang(lang);

      const newSegments: DhSegmentTask[] = chunks.map((text, i) => ({
        id: `seg_${Date.now()}_${i}`,
        index: i + 1,
        text,
        textLength: text.length,
        audioPhase: 'pending',
        dhPhase: 'pending',
      }));

      // 初始化数字人会话（自动保存历史）
      const sid = getActiveDhSessionId();
      const now = new Date();
      const displayName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      ensureDhSession({
        id: sid,
        displayName,
        createdAt: Date.now(),
        referenceVideoName: refVideoName,
        scriptPreview: val.slice(0, 200),
        segmentCount: newSegments.length,
        successCount: 0,
        failedCount: 0,
        segments: newSegments.map((s) => ({ index: s.index, text: s.text })),
      });
      setDhSessionId(sid);
      setSessionInitialized(true);

      setSegments(newSegments);
      setTasks(newSegments);
      pushLog(
        `[分割] 检测语言: ${lang === 'zh' ? '中文' : '英文'}，分割为 ${chunks.length} 段`
      );
    },
    [pushLog, refVideoName, toast, tasks]
  );

  // ============================================================
  // 新建独立任务（从弹窗输入全新文案）
  // ============================================================
  const handleCreateNewSession = useCallback(() => {
    if (!newTaskText.trim()) {
      toast.warning('请输入文案');
      return;
    }
    if (!runningHubApiKey.trim()) {
      toast.error('请先配置 RunningHub API Key');
      return;
    }

    const { lang, chunks } = splitTextByLanguage(newTaskText);

    const newSegments: DhSegmentTask[] = chunks.map((text, i) => ({
      id: `seg_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      index: i + 1,
      text,
      textLength: text.length,
      audioPhase: 'pending',
      dhPhase: 'pending',
    }));

    const now = new Date();
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const displayName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    ensureDhSession({
      id: sessionId,
      displayName,
      createdAt: Date.now(),
      referenceVideoName: refVideoName,
      scriptPreview: newTaskText.slice(0, 200),
      segmentCount: newSegments.length,
      successCount: 0,
      failedCount: 0,
      segments: newSegments.map((s) => ({ index: s.index, text: s.text })),
    });

    const newSession = {
      id: sessionId,
      text: newTaskText,
      segments: newSegments,
      ocProgress: null,
      ocState: 'idle' as const,
      ocQueue: null,
      progressRef: null,
      queueRef: null,
    };

    setNewTaskSessions((prev) => [...prev, newSession]);
    toast.success(`已创建独立任务: ${displayName}（${newSegments.length} 段）`);
    pushLog(`[新建任务] ${displayName} · ${newSegments.length} 段 · 独立 ID: ${sessionId}`);
    setShowNewTaskModal(false);
    setNewTaskText('');
  }, [newTaskText, runningHubApiKey, refVideoName, toast, pushLog]);

  // ============================================================
  // 单段配音
  // ============================================================
  const generateSingleAudio = useCallback(
    async (taskId: string) => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task) {
        console.warn(`[配音] 段未找到: ${taskId}，可能脚本已修改，跳过`);
        return;
      }
      if (task.audioPhase === 'running') return;

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, audioPhase: 'running' as const, audioStartMs: Date.now(), audioError: undefined }
            : t
        )
      );

      try {
        console.log(`[配音] 段${task.index} 开始调用 runOneClickTts, 文本长度: ${task.text.length}`);
        const result = await runOneClickTts(runningHubApiKey, task.text, {
          skipLlmPolish: true,
          onLog: (msg) => pushLog(`[段${task.index} 配音] ${msg}`),
        });
        console.log(`[配音] 段${task.index} runOneClickTts 返回:`, result);

        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  audioPhase: 'done' as const,
                  audioUrl: result.audioUrl,
                  audioStartMs: t.audioStartMs ?? Date.now(),
                }
              : t
          )
        );
        // 同步写入 ref，供 Phase1 一键成片流程立即查询（setTasks 是异步的）
        completedAudioPhasesRef.current.set(taskId, 'done');
        completedAudioUrlsRef.current.set(taskId, result.audioUrl);
        const audioMs = task.audioStartMs ? Date.now() - task.audioStartMs : undefined;
        if (dhSessionId) {
          updateDhSegmentAudio(dhSessionId, task.index, result.audioUrl, audioMs);
        }
        pushLog(`[段${task.index} 配音] ✅ 完成，音频: ${result.audioUrl?.slice(0, 60)}`);
      } catch (err: any) {
        console.error(`[配音] 段${task.index} 异常:`, err);
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, audioPhase: 'error' as const, audioError: err.message }
              : t
          )
        );
        completedAudioPhasesRef.current.set(taskId, 'error');
        if (dhSessionId) {
          updateDhSegmentAudio(dhSessionId, task.index, '', undefined, err.message);
        }
        pushLog(`[段${task.index} 配音] ❌ 失败: ${err.message}`);
        toast.error(`段${task.index} 配音失败: ${err.message}`);
      }
    },
    [runningHubApiKey, pushLog, toast, dhSessionId]
  );

  /** 直接使用传入的任务对象进行配音（不通过 ID 查找，避免 ID 变化导致找不到任务） */
  const generateSingleAudioDirect = useCallback(
    async (task: DhSegmentTask) => {
      const taskId = task.id;

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, audioPhase: 'running' as const, audioStartMs: Date.now(), audioError: undefined }
            : t
        )
      );

      try {
        console.log(`[配音] 段${task.index} 直接调用 runOneClickTts, 文本长度: ${task.text.length}`);
        const result = await runOneClickTts(runningHubApiKey, task.text, {
          skipLlmPolish: true,
          onLog: (msg) => pushLog(`[段${task.index} 配音] ${msg}`),
        });
        console.log(`[配音] 段${task.index} runOneClickTts 返回: audioUrl=${!!result?.audioUrl} url=${result?.audioUrl?.slice(0, 60)}`);
        console.log('[配音] 更新前 tasksRef 中是否存在:', taskId, tasksRef.current.some(t => t.id === taskId) ? '存在' : '不存在');

        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  audioPhase: 'done' as const,
                  audioUrl: result.audioUrl,
                  audioStartMs: task.audioStartMs ? Date.now() - task.audioStartMs : undefined,
                }
              : t
          )
        );
        completedAudioPhasesRef.current.set(taskId, 'done');
        completedAudioUrlsRef.current.set(taskId, result.audioUrl);
        // 同步到 tasksRef，确保队列任务能读到最新音频状态
        const beforeUpdate = tasksRef.current.find(t => t.id === taskId);
        console.log('[配音] 更新前 tasksRef.current 中的状态:', beforeUpdate ? `${beforeUpdate.audioPhase}, url=${!!beforeUpdate.audioUrl}` : '未找到');

        // 如果 tasksRef 中存在该任务，更新它；如果不存在，添加它
        const existingIndex = tasksRef.current.findIndex(t => t.id === taskId);
        if (existingIndex >= 0) {
          tasksRef.current = tasksRef.current.map((t) =>
            t.id === taskId
              ? { ...t, audioPhase: 'done' as const, audioUrl: result.audioUrl }
              : t
          );
        } else {
          // tasksRef 中不存在该任务（队列任务可能在合并前就被调用），直接添加到 ref
          console.log(`[配音] 段${taskId} 在 tasksRef 中不存在，添加到 ref`);
          tasksRef.current = [...tasksRef.current, { ...task, audioPhase: 'done' as const, audioUrl: result.audioUrl }];
        }

        const afterUpdate = tasksRef.current.find(t => t.id === taskId);
        console.log('[配音] 更新后 tasksRef.current 中的状态:', afterUpdate ? `${afterUpdate.audioPhase}, url=${!!afterUpdate.audioUrl}` : '未找到');
        const audioMs = task.audioStartMs ? Date.now() - task.audioStartMs : undefined;
        if (dhSessionId) {
          updateDhSegmentAudio(dhSessionId, task.index, result.audioUrl, audioMs);
        }
        pushLog(`[段${task.index} 配音] ✅ 完成，音频: ${result.audioUrl?.slice(0, 60)}`);
      } catch (err: any) {
        console.error(`[配音] 段${task.index} 异常:`, err);
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, audioPhase: 'error' as const, audioError: err.message }
              : t
          )
        );
        completedAudioPhasesRef.current.set(taskId, 'error');
        // 同步错误状态到 tasksRef
        const existingIndex = tasksRef.current.findIndex(t => t.id === taskId);
        if (existingIndex >= 0) {
          tasksRef.current = tasksRef.current.map((t) =>
            t.id === taskId
              ? { ...t, audioPhase: 'error' as const, audioError: err.message }
              : t
          );
        } else {
          tasksRef.current = [...tasksRef.current, { ...task, audioPhase: 'error' as const, audioError: err.message }];
        }
        if (dhSessionId) {
          updateDhSegmentAudio(dhSessionId, task.index, '', undefined, err.message);
        }
        pushLog(`[段${task.index} 配音] ❌ 失败: ${err.message}`);
        toast.error(`段${task.index} 配音失败: ${err.message}`);
      }
    },
    [runningHubApiKey, pushLog, toast, dhSessionId]
  );

  // ============================================================
  // 单段数字人
  // ============================================================
  const generateSingleDh = useCallback(
    async (taskId: string, forcedAudioUrl?: string) => {
      // 优先使用 forcedAudioUrl（从队列任务传入，确保即使 ID 不匹配也能工作）
      // 如果没有 forcedAudioUrl，尝试从 tasksRef 和 completedAudioUrlsRef 获取
      let audioUrl = forcedAudioUrl;
      let taskIndex = 0;
      let taskDhPhase: string | undefined;

      const taskFromRef = tasksRef.current.find((t) => t.id === taskId);
      if (taskFromRef) {
        // tasksRef 中存在该任务，正常使用
        audioUrl = audioUrl || taskFromRef.audioUrl || completedAudioUrlsRef.current.get(taskId);
        taskIndex = taskFromRef.index;
        taskDhPhase = taskFromRef.dhPhase;
      } else if (!audioUrl) {
        // tasksRef 中不存在该任务，且没有 forcedAudioUrl，从 completedAudioUrlsRef 尝试获取
        audioUrl = completedAudioUrlsRef.current.get(taskId);
        if (!audioUrl) {
          console.error(`[数字人] 段未找到: ${taskId}，且无缓存音频，跳过`);
          return;
        }
        console.warn(`[数字人] 段 ${taskId} 在 tasksRef 中不存在，但使用缓存音频继续执行`);
      }

      if (!audioUrl) {
        console.error(`[数字人] 段未找到: ${taskId}，无音频URL`);
        return;
      }

      if (!refVideoRhPath) {
        console.error(`[数字人] 无参考视频路径，无法生成数字人`);
        toast.error('请先上传参考视频');
        return;
      }

      if (taskDhPhase === 'running') return;

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, dhPhase: 'running' as const, dhStartMs: Date.now(), dhError: undefined }
            : t
        )
      );

      pushLog(`[段${taskIndex} 数字人] 提交任务…`);
      console.log(`[数字人] 段${taskIndex} 开始, audioUrl: ${audioUrl?.slice(0, 80)}, refVideoPath: ${refVideoRhPath}`);

      try {
        const taskId_ = await dhConcurrency.run(async () => {
          // blob: URL 无法被 RunningHub 工作流访问，需要先上传到 RunningHub
          let audioPathForDh: string;
          if (audioUrl.startsWith('blob:')) {
            pushLog(`[段${taskIndex} 数字人] 本地音频，需先上传至 RunningHub…`);
            console.log(`[数字人] 段${taskIndex} 检测到 blob URL，开始上传`);
            audioPathForDh = await uploadAudioToRunningHub(runningHubApiKey, audioUrl);
            const short = audioPathForDh.length > 64 ? `${audioPathForDh.slice(0, 64)}…` : audioPathForDh;
            pushLog(`[段${taskIndex} 数字人] 音频已上传: ${short}`);
            console.log(`[数字人] 段${taskIndex} 上传成功: ${audioPathForDh}`);
          } else {
            // 已经是 RunningHub 路径或 https: URL，提取路径
            audioPathForDh = audioUrl.replace(/^https:\/\/www\.runninghub\.cn/, '').replace(/^\//, '');
          }

          const tid = await submitDigitalHumanTask(runningHubApiKey, {
            referenceVideoPath: refVideoRhPath,
            audioPath: audioPathForDh,
          });
          console.log(`[数字人] 段${taskIndex} 提交成功, taskId: ${tid?.slice(0, 16)}`);
          pushLog(`[段${taskIndex} 数字人] taskId: ${tid?.slice(0, 16)}…`);

          const videoUrl = await pollDigitalHumanUntilDone(runningHubApiKey, tid, (stage, elapsed) => {
            if (elapsed % 30 === 0) {
              pushLog(`[段${taskIndex} 数字人] 轮询中 ${elapsed}s…`);
            }
          });

          console.log(`[数字人] 段${taskIndex} 轮询完成, videoUrl: ${videoUrl?.slice(0, 80)}`);
          return videoUrl;
        });

        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  dhPhase: 'done' as const,
                  dhVideoUrl: taskId_,
                  dhStartMs: t.dhStartMs ?? Date.now(),
                }
              : t
          )
        );
        completedDhPhasesRef.current.set(taskId, 'done');
        completedDhVideoUrlsRef.current.set(taskId, taskId_);
        if (dhSessionId) {
          const dhMs = taskFromRef?.dhStartMs ? Date.now() - taskFromRef.dhStartMs : undefined;
          updateDhSegmentVideo(dhSessionId, taskIndex, taskId_, dhMs);
        }
        pushLog(`[段${taskIndex} 数字人] ✅ 完成`);
      } catch (err: any) {
        console.error(`[数字人] 段${taskIndex} 异常:`, err);
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, dhPhase: 'error' as const, dhError: err.message }
              : t
          )
        );
        completedDhPhasesRef.current.set(taskId, 'error');
        if (dhSessionId) {
          updateDhSegmentVideo(dhSessionId, taskIndex, '', undefined, err.message);
        }
        pushLog(`[段${taskIndex} 数字人] ❌ 失败: ${err.message}`);
        toast.error(`段${taskIndex} 数字人失败: ${err.message}`);
        // 如果是网络错误（CORS 或 Failed to fetch），自动重试一次
        const isNetworkError = err.message?.includes('Failed to fetch') ||
                               err.message?.includes('CORS') ||
                               err.message?.includes('NetworkError') ||
                               err.message?.includes('net::ERR');
        if (isNetworkError) {
          console.log(`[数字人] 段${taskIndex} 检测到网络错误，5秒后自动重试…`);
          pushLog(`[段${taskIndex} 数字人] 网络错误，5秒后自动重试…`);
          // 使用 setTimeout 延迟执行，避免在回调中直接调用自身
          window.setTimeout(() => {
            console.log(`[数字人] 段${taskIndex} 自动重试开始`);
            pushLog(`[段${taskIndex} 数字人] 重试中…`);
            // 重置状态
            setTasks((prev) =>
              prev.map((t) =>
                t.id === taskId
                  ? { ...t, dhPhase: 'pending' as const, dhError: undefined }
                  : t
              )
            );
            completedDhPhasesRef.current.delete(taskId);
            // 通过 ref 调用自身重试
            genDhRef.current?.(taskId, audioUrl);
          }, 5000);
        }
      }
    },
    [runningHubApiKey, refVideoRhPath, toast, pushLog, dhSessionId]
  );

  // refs 在函数定义后直接赋值（避免 TDZ 问题）
  genAudioRef.current = generateSingleAudio;
  genDhRef.current = generateSingleDh;

  // ============================================================
  // 批量配音
  // ============================================================
  const handleBatchAudio = useCallback(async () => {
    if (!runningHubApiKey.trim()) {
      toast.error('请先配置 RunningHub API Key');
      return;
    }

    const pending = tasks.filter((t) => t.audioPhase === 'pending');
    if (pending.length === 0) {
      toast.warning('没有待配音的段落');
      return;
    }

    pushLog(`[批量配音] 开始 ${pending.length} 段…`);

    // 最多 20 并发
    const CONCURRENCY = Math.min(pending.length, MAX_CONCURRENT);
    const queue = [...pending];
    const running: Promise<void>[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        const task = queue.shift()!;
        await generateSingleAudio(task.id);
      }
    };

    for (let i = 0; i < CONCURRENCY; i++) {
      running.push(worker());
    }

    await Promise.all(running);
    pushLog(`[批量配音] ✅ 全部完成`);
    toast.success('批量配音完成');
  }, [tasks, runningHubApiKey, generateSingleAudio, pushLog, toast]);

  // ============================================================
  // 批量数字人
  // ============================================================
  const handleBatchDh = useCallback(async () => {
    if (!runningHubApiKey.trim()) {
      toast.error('请先配置 RunningHub API Key');
      return;
    }

    if (!refVideoRhPath) {
      toast.error('请先上传参考视频');
      return;
    }

    const ready = tasks.filter((t) => t.audioPhase === 'done' && (t.dhPhase === 'pending' || t.dhPhase === 'error'));
    if (ready.length === 0) {
      toast.warning('没有可生成数字人的段落（需要先完成配音）');
      return;
    }

    pushLog(`[批量数字人] 开始 ${ready.length} 段…`);

    const queue = [...ready];
    const running: Promise<void>[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        const task = queue.shift()!;
        await generateSingleDh(task.id);
      }
    };

    for (let i = 0; i < MAX_CONCURRENT; i++) {
      running.push(worker());
    }

    await Promise.all(running);
    pushLog(`[批量数字人] ✅ 全部完成`);
    toast.success('批量生成完成');
  }, [tasks, refVideoRhPath, runningHubApiKey, generateSingleDh, pushLog, toast]);

  // ============================================================
  // 下载
  // ============================================================
  /** 触发一个 ZIP blob 的浏览器下载 */
  const triggerZipDownload = (blob: Blob, prefix: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${prefix}_${Date.now()}.zip`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  /** 构造视频下载项列表 */
  const makeVideoItems = (taskList: DhSegmentTask[]) =>
    taskList
      .filter((t) => !!t.dhVideoUrl)
      .map((t) => ({ url: t.dhVideoUrl!, filename: `段${t.index}.mp4` }));

  const handleDownloadSingle = useCallback((task: DhSegmentTask) => {
    if (!task.dhVideoUrl) return;
    const a = document.createElement('a');
    a.href = task.dhVideoUrl;
    a.download = `数字人对口型_段${task.index}.mp4`;
    a.target = '_blank';
    a.click();
  }, []);

  const handleDownloadSelected = useCallback(async () => {
    const selected = tasks.filter((t) => selectedIds.has(t.id) && t.dhVideoUrl);
    if (selected.length === 0) {
      toast.warning('请先选择已完成数字人的段落');
      return;
    }

    if (selected.length === 1) {
      handleDownloadSingle(selected[0]);
      return;
    }

    const items = makeVideoItems(selected);
    const totalBatches = Math.ceil(items.length / BATCH_ZIP_SIZE);
    pushLog(`[打包下载] 分 ${totalBatches} 批打包 ${items.length} 个视频…`);
    setDownloadProgress({ totalFiles: items.length, currentIndex: 0, phase: 'downloading', overallPercent: 0, currentFilename: '', downloadedBytes: 0, totalBytes: undefined });

    try {
      const onProgress: DownloadProgressCallback = (info) => {
        setDownloadProgress((p) =>
          p ? {
            ...p,
            overallPercent: info.overallPercent >= 0 ? info.overallPercent : (p?.overallPercent ?? 0),
            currentIndex: info.currentIndex,
            currentFilename: info.filename,
            phase: info.phase,
            downloadedBytes: info.downloadedBytes,
            totalBytes: info.totalBytes,
          } : null
        );
      };

      if (totalBatches > 1) {
        // 分多批下载，每批单独触发浏览器下载
        let downloadedBatches = 0;
        await packVideosToBatches(
          items,
          (batchIndex, total, batchPct, filename) => {
            setDownloadProgress((p) =>
              p ? { ...p, batchIndex, totalBatches: total, overallPercent: batchPct, currentFilename: filename, phase: 'downloading' } : null
            );
          },
          (batchIndex, total, batch) => {
            triggerZipDownload(batch.zipBlob, `数字人对口型_${batch.partLabel}`);
            downloadedBatches++;
            pushLog(`[打包下载] ✅ ${batch.partLabel}（含 ${batch.filenames.length} 个视频）已下载`);
            setDownloadProgress((p) =>
              p ? { ...p, batchIndex, totalBatches: total, overallPercent: Math.round((downloadedBatches / total) * 100) } : null
            );
          }
        );
        toast.success(`${items.length} 个视频分 ${totalBatches} 批打包完成`);
      } else {
        // 单批，直接打包下载
        const blob = await packVideosToZip(items, '数字人对口型视频.zip', onProgress);
        triggerZipDownload(blob, '数字人对口型视频');
        toast.success(`打包下载成功: ${items.length} 个视频`);
      }
    } catch (err: any) {
      toast.error(`打包失败: ${err.message}`);
    } finally {
      setDownloadProgress(null);
    }
  }, [tasks, selectedIds, handleDownloadSingle, toast, pushLog, setDownloadProgress, makeVideoItems, packVideosToBatches, packVideosToZip]);

  const handleDownloadAll = useCallback(async () => {
    const done = tasks.filter((t) => t.dhPhase === 'done' && t.dhVideoUrl);
    if (done.length === 0) {
      toast.warning('没有可下载的数字人视频');
      return;
    }

    if (done.length === 1) {
      handleDownloadSingle(done[0]);
      return;
    }

    const items = makeVideoItems(done);
    const totalBatches = Math.ceil(items.length / BATCH_ZIP_SIZE);
    pushLog(`[打包下载] 分 ${totalBatches} 批打包 ${items.length} 个视频…`);
    setDownloadProgress({ totalFiles: items.length, currentIndex: 0, phase: 'downloading', overallPercent: 0, currentFilename: '' });

    try {
      if (totalBatches > 1) {
        pushLog(`[打包下载] 分 ${totalBatches} 批打包 ${items.length} 个视频…`);
        let downloadedBatches = 0;
        await packVideosToBatches(
          items,
          (batchIndex, total, batchPct, filename) => {
            setDownloadProgress((p) =>
              p ? { ...p, batchIndex, totalBatches: total, overallPercent: batchPct, currentFilename: filename, phase: 'downloading' } : null
            );
          },
          (batchIndex, total, batch) => {
            triggerZipDownload(batch.zipBlob, `数字人对口型_${batch.partLabel}`);
            downloadedBatches++;
            pushLog(`[打包下载] ✅ ${batch.partLabel}（含 ${batch.filenames.length} 个视频）已下载`);
            setDownloadProgress((p) =>
              p ? { ...p, batchIndex, totalBatches: total, overallPercent: Math.round((downloadedBatches / total) * 100) } : null
            );
          }
        );
        toast.success(`${items.length} 个视频分 ${totalBatches} 批打包完成`);
      } else {
        const onProgress: DownloadProgressCallback = (info) => {
          setDownloadProgress((p) =>
            p ? { ...p, overallPercent: info.overallPercent >= 0 ? info.overallPercent : (p?.overallPercent ?? 0), currentIndex: info.currentIndex, currentFilename: info.filename, phase: info.phase } : null
          );
        };
        const blob = await packVideosToZip(items, '数字人对口型视频.zip', onProgress);
        triggerZipDownload(blob, '数字人对口型视频');
        toast.success(`打包下载成功: ${items.length} 个视频`);
      }
    } catch (err: any) {
      toast.error(`打包失败: ${err.message}`);
    } finally {
      setDownloadProgress(null);
    }
  }, [tasks, handleDownloadSingle, toast, pushLog, setDownloadProgress, makeVideoItems, packVideosToBatches, packVideosToZip, triggerZipDownload]);

  // ============================================================
  // 队列任务执行：直接执行独立任务的配音→数字人→下载流程
  // 不操作 tasks（主任务 UI 保持不变）
  // ============================================================
  const runQueueTask = useCallback(
    async (sessionId: string, segments: DhSegmentTask[]) => {
      // 防重入：同一个 sessionId 的任务如果已经在执行中，跳过
      if (runningSessionIdRef.current === sessionId) {
        console.log(`[队列任务] sessionId=${sessionId} 正在执行中，跳过重复调用`);
        return;
      }
      runningSessionIdRef.current = sessionId;

      try {
        console.log(`[队列任务] runQueueTask 开始 sessionId=${sessionId} segments=${segments.length}个 ids=${segments.map(s => s.id.slice(-10)).join(',')}`);
        // 从 tasksRef.current 获取最新音频状态（避免使用 stale 的 segments 参数）
        const tasksSnapshot = tasksRef.current;
        console.log(`[队列任务] runQueueTask 开始 - sessionId=${sessionId}`);
        console.log(`[队列任务] tasksRef.current 全部 segments: ${tasksSnapshot.map(t => `${t.id.slice(-10)}:audio=${t.audioPhase},url=${!!t.audioUrl}`).join(', ')}`);
        console.log(`[队列任务] 入参 segments: ${segments.map(s => `${s.id.slice(-10)}:audio=${s.audioPhase},url=${!!s.audioUrl}`).join(', ')}`);

        // 注意：独立任务的 segment.id 已经是完整格式（如 seg_xxx_0），直接使用
        const segs = segments.filter((t) => {
          // 优先用 tasksRef.current 中的最新状态
          const latest = tasksSnapshot.find((tt) => tt.id === t.id);
          const phase = latest?.audioPhase ?? t.audioPhase;
          const url = latest?.audioUrl ?? t.audioUrl;
          console.log(`[队列任务] Phase1 段${t.index} 检查: id=${t.id.slice(-10)} tasksSnapshot中=${!!latest} phase=${phase} url=${!!url}`);
          return phase === 'pending' || (phase === 'running' && !url);
        });
        console.log(`[队列任务] Phase1 过滤结果: segs=${segs.length}个 tasksSnapshot=${tasksSnapshot.map(t => `${t.id.slice(-10)}:audio=${t.audioPhase}`).join(', ')}`);

        // 全部已完成则跳过配音
        if (segs.length === 0) {
          console.log('[队列任务] 全部配音已完成，跳过 Phase1，直接进入 Phase2');
        } else {
          console.log('[队列任务] Phase1 即将设置 setOneClickFilm(audio)');
          // 必须先同步更新 ref，再创建 workers，避免 workers 一创建就检测到 idle 退出
          oneClickRef.current = 'audio';
          setOneClickFilm('audio');
          console.log('[队列任务] Phase1 已设置 setOneClickFilm(audio), 准备并发配音');
          setOcProgress({ phase: 'audio', done: 0, total: segs.length, startMs: Date.now() });
        pushLog(`[队列任务] 开始… 阶段① 批量配音 ${segs.length} 段`);

        // 并发配音
        const queue = [...segs];
        console.log(`[队列任务] Phase1 并发配音开始, queue长度: ${queue.length} MAX_CONCURRENT: ${MAX_CONCURRENT}`);
        await Promise.all(
          Array.from({ length: Math.min(queue.length, MAX_CONCURRENT) }, () =>
            (async () => {
              while (queue.length > 0) {
                console.log(`[队列任务] Phase1 worker 检查 oneClickRef: ${oneClickRef.current}`);
                if (oneClickRef.current === 'idle') {
                  console.log('[队列任务] Phase1 worker 检测到 idle，提前退出');
                  return;
                }
                const task = queue.shift()!;
                console.log(`[队列任务] Phase1 worker 使用 id: ${task.id.slice(-10)}`);
                completedAudioPhasesRef.current.set(task.id, 'running');
                try {
                  await generateSingleAudioDirect(task);
                  setOcProgress((p) => p ? { ...p, done: p.done + 1 } : null);
                } catch (err: any) {
                  pushLog(`[队列任务] ⚠️ 段${task.index} 配音异常: ${err.message}`);
                }
              }
            })()
          )
        );
        console.log('[队列任务] Phase1 并发配音完成');
      }

      // Phase 2: 数字人
      // 直接使用入参 segments 和 completedAudioUrlsRef 构建 ready 列表，避免 id 不匹配问题
      console.log('[队列任务] Phase2 详细检查:');
      console.log(`[队列任务]  - 入参 segments: ${segments.map(s => `${s.id.slice(-10)}:audio=${s.audioPhase}`).join(', ')}`);
      console.log(`[队列任务]  - completedAudioUrlsRef: ${[...completedAudioUrlsRef.current.entries()].map(([id, url]) => `${id.slice(-10)}=${!!url}`).join(', ')}`);
      console.log(`[队列任务]  - completedDhPhasesRef: ${[...completedDhPhasesRef.current.entries()].map(([id, phase]) => `${id.slice(-10)}=${phase}`).join(', ')}`);
      
      const ready = segments
        .filter((seg) => {
          const audioUrl = completedAudioUrlsRef.current.get(seg.id);
          const dhPhase = completedDhPhasesRef.current.get(seg.id);
          console.log(`[队列任务] 段${seg.index} 检查: id=${seg.id.slice(-10)} audioUrl=${!!audioUrl} dhPhase=${dhPhase || 'pending'}`);
          return audioUrl && dhPhase !== 'done';
        })
        .map((seg) => ({
          id: seg.id,
          index: seg.index,
          audioUrl: completedAudioUrlsRef.current.get(seg.id)!,
          text: seg.text,
        }));
      console.log(`[队列任务] Phase2 ready=${ready.length}个: ${ready.map(r => `${r.id.slice(-10)}`).join(',')}`);

      if (ready.length === 0) {
        pushLog(`[队列任务] 无可生成数字人的段`);
        setOneClickFilm('idle');
        setOcProgress(null);
        return;
      }

      setOneClickFilm('dh');
      setOcProgress({ phase: 'dh', done: 0, total: ready.length, startMs: Date.now() });
      pushLog(`[队列任务] 阶段② 开始批量数字人: ${ready.length} 段`);

      // 并发数字人
      const dhQueue = [...ready];
      await Promise.all(
        Array.from({ length: Math.min(dhQueue.length, MAX_CONCURRENT) }, () =>
          (async () => {
            while (dhQueue.length > 0) {
              if (oneClickRef.current === 'idle') return;
              const task = dhQueue.shift()!;
              try {
                await generateSingleDh(task.id, task.audioUrl);
                setOcProgress((p) => p ? { ...p, done: p.done + 1 } : null);
              } catch (err: any) {
                pushLog(`[队列任务] ⚠️ 段${task.index} 数字人异常: ${err.message}`);
              }
            }
          })()
        )
      );

      // Phase 3: 下载
      const currIds = currentTaskSegmentIdsRef.current;
      const doneEntries = [...completedDhPhasesRef.current.entries()]
        .filter(([id, phase]) => phase === 'done' && currIds.has(id));

      if (doneEntries.length === 0) {
        toast.warning('数字人全部失败，无视频可下载');
        setOneClickFilm('idle');
        setOcProgress(null);
        return;
      }

      const videoItems = doneEntries.map(([id]) => {
        const videoUrl = completedDhVideoUrlsRef.current.get(id)!;
        const originalSeg = segments.find((s) => s.id === id);
        return { url: videoUrl, filename: `段${originalSeg?.index ?? 0}.mp4` };
      });

      pushLog(`[队列任务] 打包 ${videoItems.length} 个视频…`);
      setDownloadProgress({ totalFiles: videoItems.length, currentIndex: 0, phase: 'downloading', overallPercent: 0, currentFilename: '' });
      try {
        const blob = await packVideosToZip(videoItems, '数字人对口型视频.zip', (info) => {
          setDownloadProgress((p) => p ? { ...p, overallPercent: info.overallPercent >= 0 ? info.overallPercent : (p?.overallPercent ?? 0), currentIndex: info.currentIndex, currentFilename: info.filename, phase: info.phase } : null);
        });
        triggerZipDownload(blob, '数字人对口型视频');
        pushLog(`[队列任务] ✅ 完成 · ${videoItems.length} 个视频已下载`);
        toast.success(`队列任务完成: ${videoItems.length} 个视频已打包下载`);
      } catch (err: any) {
        toast.error(`打包失败: ${err.message}`);
      } finally {
        setDownloadProgress(null);
      }

      // 更新 newTaskSessions 状态
      setNewTaskSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ocState: 'done' as const } : s))
      );
      setOneClickFilm('idle');
      setOcProgress(null);
      console.log('[队列任务] 执行完成');

      // 触发队列处理下一个任务
      queueRunningRef.current = false;
      setPhase3JustFinished(true);
      } finally {
        runningSessionIdRef.current = null;
      }
    },
    [generateSingleAudioDirect, generateSingleDh, pushLog, toast, setDownloadProgress, triggerZipDownload, packVideosToZip, setPhase3JustFinished]
  );

  // ============================================================
  // 一键成片：配音 → 数字人 → 下载
  // ============================================================
  const handleOneClickFilm = useCallback(async () => {
    // 如果是自动继续模式（任务完成后自动调用），跳过排队检查
    const isAutoContinue = autoContinueRef.current;
    if (isAutoContinue) {
      autoContinueRef.current = false;
    }

    // auto-continue 模式：跳过排队检查，直接执行
    // currentTaskSessionIdRef 在 setOneClickFilm('audio') 时已由下方逻辑设置
    if (!runningHubApiKey.trim()) {
      toast.error('请先配置 RunningHub API Key');
      return;
    }
    if (!refVideoRhPath) {
      toast.error('请先上传参考视频');
      return;
    }

    // ============================================================
    // 排队目标逻辑（auto-continue 时跳过）
    // 1. 有选中独立任务 → 排队选中任务
    // 2. 无选中但有独立任务 → 默认排队全部独立任务
    // 3. 无独立任务 → 排队主任务
    // 无论哪种情况，如果主任务有待配音段落，排队后继续执行主任务
    // ============================================================
    if (!isAutoContinue) {
      const selectedForQueue = selectedSessionIds.size > 0
        ? newTaskSessions.filter((s) => selectedSessionIds.has(s.id))
        : (newTaskSessions.length > 0 ? newTaskSessions : []);

      // 检查主任务待配音段落
      const pending = tasks.filter((t) => t.audioPhase === 'pending' || (t.audioPhase === 'running' && !t.audioUrl));
      const hasRunningTasks = tasks.some((t) => t.audioPhase === 'running');

      console.log('[一键成片] 入参状态:', {
        oneClickFilm,
        tasksCount: tasks.length,
        pendingCount: pending.length,
        hasRunningTasks,
        selectedForQueue: selectedForQueue.map(s => s.id),
        queueState: oneClickQueueRef.current ? { sessionIds: oneClickQueueRef.current.sessionIds } : null,
      });

      // --- 有选中/默认独立任务：排队独立任务 ---
      if (selectedForQueue.length > 0) {
        const existingQueue = oneClickQueueRef.current;
        const alreadyQueuedIds = existingQueue?.sessionIds || [];
        const newSessions = selectedForQueue.filter((s) => !alreadyQueuedIds.includes(s.id));

        if (newSessions.length > 0) {
          const newQueue = {
            sessionIds: [...alreadyQueuedIds, ...newSessions.map((s) => s.id)],
            pendingSegmentsBySession: {
              ...(existingQueue?.pendingSegmentsBySession || {}),
              ...Object.fromEntries(newSessions.map((s) => [s.id, s.segments.map((seg) => seg.id)])),
            },
          };
          setOneClickQueue(newQueue);
          oneClickQueueRef.current = newQueue;
          console.log('[一键成片] 队列已设置:', { sessionIds: newQueue.sessionIds, queueRef: oneClickQueueRef.current?.sessionIds });

          const names = newSessions.map((s) => s.id.split('_')[1]).join(', ');
          pushLog(`[一键成片] ⏳ 已加入队列: ${newSessions.length} 个任务 (${names})`);
          toast.info(`已加入队列: ${newSessions.length} 个任务`);
        } else {
          pushLog('[一键成片] 选中任务已在队列中');
          toast.info('选中任务已在队列中');
        }

        // 清除选中状态，下次可重新选择
        setSelectedSessionIds(new Set());

        // 有主任务待配音 → 继续执行主任务；否则排队结束
        if (pending.length > 0) {
          pushLog(`[一键成片] 同时执行主任务: ${pending.length} 段待配音`);
        } else {
          return;
        }
      }

      // --- 无独立任务，排队主任务 ---
      // === 主任务挂起逻辑（当前有任务在执行时挂起） ===
      if (oneClickFilm !== 'idle' || hasRunningTasks) {
        const pendingIds = pending.map((t) => t.id);
        const existingIds = oneClickQueueRef.current?.pendingSegmentsBySession[''] || [];
        const newPendingIds = pendingIds.filter((id) => !existingIds.includes(id));

        if (newPendingIds.length === 0) {
          pushLog('[一键成片] 主任务已在队列中');
          toast.info('主任务已在队列中');
          return;
        }

        const newQueue = {
          sessionIds: ['', ...(oneClickQueueRef.current?.sessionIds || [])],
          pendingSegmentsBySession: {
            ...(oneClickQueueRef.current?.pendingSegmentsBySession || {}),
            '': [...existingIds, ...newPendingIds],
          },
        };
        setOneClickQueue(newQueue);
        oneClickQueueRef.current = newQueue;

        pushLog(`[一键成片] ⏳ 主任务 ${newPendingIds.length} 段已挂起，当前任务完成后自动开始`);
        toast.info(`主任务已挂起，等待中…`);
        return;
      }

      if (pending.length === 0) {
        toast.warning('没有待配音的段落');
        return;
      }
    }

    // auto-continue 时 pending 仍需要（上面已确保它被定义）
    const execPending = tasks.filter((t) => t.audioPhase === 'pending' || (t.audioPhase === 'running' && !t.audioUrl));

    // 必须先同步更新 ref，再创建 workers，避免 workers 一创建就检测到 idle 退出
    oneClickRef.current = 'audio';
    setOneClickFilm('audio');
    setOcProgress({ phase: 'audio', done: 0, total: execPending.length, startMs: Date.now() });
    pushLog(`[一键成片] 开始… 阶段① 批量配音 ${execPending.length} 段`);

    // 记录当前任务的 segment IDs，Phase 3 只打包这些 ID 的视频（避免跨任务打包）
    // 如果 execPending 非空用它；为空则用 tasks（配音全完成的情况）
    currentTaskSegmentIdsRef.current = new Set(
      execPending.length > 0 ? execPending.map((t) => t.id) : tasks.map((t) => t.id)
    );
    // 主任务执行时清空 session ID（独立任务由队列执行逻辑设置）
    currentTaskSessionIdRef.current = '';

    // Phase 1: 批量配音
    console.log(`[一键成片] Phase1 调试: pending=${execPending.length}个, ids=${execPending.map(t => t.id.slice(-6)).join(',')}`);
    const queue = [...execPending];
    const workers = Array.from({ length: Math.min(queue.length, MAX_CONCURRENT) }, () => {
      const worker = async () => {
        while (queue.length > 0) {
          if (oneClickRef.current === 'idle') {
            console.log('[一键成片] worker 检测到 oneClickFilm==idle，提前退出');
            return;
          }
          const task = queue.shift()!;
          console.log(`[一键成片] worker 开始处理段${task.index} (${task.id}), queue剩余=${queue.length}`);
          try {
            // 同步记录 audioPhase 为 running，防止重复处理
            completedAudioPhasesRef.current.set(task.id, 'running');
            // 直接使用队列中的 task 对象，而不是通过 tasksRef 查找
            await generateSingleAudioDirect(task);
            console.log(`[一键成片] worker 段${task.index} 配音完成`);
            setOcProgress((p) => p ? { ...p, done: p.done + 1 } : null);
          } catch (err: any) {
            console.error(`[一键成片] worker 段${task.index} 配音异常:`, err.message);
            pushLog(`[一键成片] ⚠️ 段${task.index} 配音异常: ${err.message}`);
          }
        }
      };
      return worker();
    });
    await Promise.all(workers);
    console.log('[一键成片] Phase1 配音阶段全部 worker 完成');

    // 配音完成后，检查是否还有失败的
    // 用 completedAudioPhasesRef 判断（setTasks 是异步的，直接查 tasksRef 拿不到最新状态）
    const phaseRefEntries = [...completedAudioPhasesRef.current.entries()];
    const completedAudioUrls = new Map(completedAudioUrlsRef.current);
    console.log(`[一键成片] Phase1 调试: phaseRefEntries=${phaseRefEntries.length}个, completedAudioUrls=${completedAudioUrls.size}个`);
    console.log(`[一键成片] Phase1 调试: phaseRefEntries=${JSON.stringify(phaseRefEntries)}`);
    console.log(`[一键成片] Phase1 调试: tasksRef=${tasksRef.current.map(t => `${t.id.slice(-6)}:audio=${t.audioPhase}`).join(', ')}`);

    // 即使 phaseRefEntries 为空，只要有 completedAudioUrls 记录，就应该进入 Phase 2
    // （因为音频可能已完成，只是 ID 不匹配）
    const failedAudio = phaseRefEntries.filter(([, phase]) => phase === 'error').map(([id]) => tasksRef.current.find((t) => t.id === id)).filter(Boolean);
    const doneAudio = phaseRefEntries.filter(([, phase]) => phase === 'done').map(([id]) => tasksRef.current.find((t) => t.id === id)).filter(Boolean);
    console.log(`[一键成片] Phase1 结果: 成功 ${doneAudio.length}, 失败 ${failedAudio.length}`);
    failedAudio.forEach((t) => {
      pushLog(`[一键成片] ⚠️ 段${t.index} 配音失败: ${t.audioError || '未知错误'}`);
      console.error(`[一键成片] 段${t.index} 失败详情:`, t.audioError);
    });

    if (failedAudio.length > 0) {
      pushLog(`[一键成片] ⚠️ ${failedAudio.length} 段配音失败，跳过数字人阶段`);
      toast.warning(`${failedAudio.length} 段配音失败，一键成片中断`);
      setOneClickFilm('idle');
      setOcProgress(null);
      return;
    }

    // Phase 2: 批量数字人
    // 从 completedAudioPhasesRef 和 completedAudioUrlsRef 构建 ready 列表
    // tasksRef 可能是 stale 的（setTasks 异步），但 ref 是同步更新的
    const doneAudioIds = [...completedAudioPhasesRef.current.entries()]
      .filter(([, phase]) => phase === 'done')
      .map(([id]) => id);
    const ready = doneAudioIds
      .filter((id) => completedDhPhasesRef.current.get(id) !== 'done')
      .map((id) => {
        const audioUrl = completedAudioUrlsRef.current.get(id);
        if (!audioUrl) return null;
        const taskFromRef = tasksRef.current.find((t) => t.id === id);
        return {
          id,
          index: taskFromRef?.index ?? 0,
          audioUrl,
          text: taskFromRef?.text ?? '',
        };
      })
      .filter(Boolean) as Array<{ id: string; index: number; audioUrl: string; text: string }>;

    console.log(`[一键成片] Phase2 待处理: ${ready.length} 段`);
    console.log(`[一键成片] Phase2 调试: audioDoneIds=${doneAudioIds.length}个, ready=${ready.length}个`);
    console.log(`[一键成片] Phase2 调试: tasksRef=${tasksRef.current.map(t => `${t.id.slice(-6)}:audio=${t.audioPhase},dh=${t.dhPhase},url=${!!t.audioUrl}`).join(', ')}`);

    // 如果没有可处理的配音完成任务，用 completedAudioPhasesRef 重试（setTasks 是异步的，tasksRef 可能未同步）
    if (ready.length === 0) {
      const doneIds = [...completedAudioPhasesRef.current.entries()]
        .filter(([, phase]) => phase === 'done')
        .map(([id]) => id);

      // 如果 ref 里已有完成的任务但 tasksRef 还没同步，说明需要等待渲染更新
      // 这种情况直接等待下一轮渲染后再检查
      const pendingAudio = tasksRef.current.filter((t) => t.audioPhase === 'pending').length;
      const runningAudio = tasksRef.current.filter((t) => t.audioPhase === 'running').length;

      if (doneIds.length > 0) {
        // ref 里有完成的，尝试从 completedAudioUrlsRef 构造 ready（tasksRef 可能未同步）
        const fallbackReady = doneIds
          .filter((id) => completedDhPhasesRef.current.get(id) !== 'done')
          .map((id) => {
            const audioUrl = completedAudioUrlsRef.current.get(id);
            if (!audioUrl) return null;
            const taskFromRef = tasksRef.current.find((t) => t.id === id);
            return {
              id,
              index: taskFromRef?.index ?? 0,
              audioUrl,
              text: taskFromRef?.text ?? '',
            };
          })
          .filter(Boolean) as Array<{ id: string; index: number; audioUrl: string; text: string }>;

        if (fallbackReady.length > 0) {
          pushLog(`[一键成片] ⚠️ tasksRef 未同步，从 ref 恢复 ${fallbackReady.length} 段 → 直接进入数字人阶段`);
          ready.push(...fallbackReady);
        } else if (pendingAudio === 0 && runningAudio === 0 && doneIds.length > 0) {
          // 所有配音已完成，但 ready 为空，说明所有数字人也已完成（或失败）
          const allDhDone = [...completedDhPhasesRef.current.entries()].every(([, phase]) => phase !== 'done');
          if (!allDhDone) {
            pushLog('[一键成片] 所有任务已完成，准备打包下载…');
            setOneClickFilm('done');
            setOcProgress({ phase: 'dh', done: doneIds.length, total: doneIds.length, startMs: Date.now() });
            // 继续到 Phase 3（done 列表为空则提前返回）
            const doneDhEntries = [...completedDhPhasesRef.current.entries()].filter(([, phase]) => phase === 'done');
            if (doneDhEntries.length === 0) {
              toast.warning('数字人全部失败，无视频可下载');
              setOneClickFilm('idle');
              setOcProgress(null);
              return;
            }
          }
        }
      }

      // 如果 fallbackReady 也没构造出有效数据，进入等待逻辑
      if (ready.length === 0) {
        const allAudioDone = tasksRef.current.every((t) => t.audioPhase === 'done');
        const allDhDone = tasksRef.current.every((t) => t.dhPhase === 'done' || t.dhPhase === 'error');

        if (allAudioDone && allDhDone) {
          pushLog('[一键成片] 所有任务已完成，准备打包下载…');
          setOneClickFilm('done');
          setOcProgress({ phase: 'dh', done: tasksRef.current.length, total: tasksRef.current.length, startMs: Date.now() });
          return;
        }

        if (pendingAudio === 0 && runningAudio === 0) {
          pushLog('[一键成片] 阶段② 无可处理任务，跳过 → 检查挂起队列');
          setOneClickFilm('idle');
          setOcProgress(null);
          const nextQueue = oneClickQueueRef.current;
          if (nextQueue && nextQueue.sessionIds.length > 0) {
            pushLog(`[一键成片] 🔄 检测到 ${nextQueue.sessionIds.length} 个挂起任务，自动继续…`);
            setTimeout(() => {
              void handleOneClickFilm();
            }, 500);
            return;
          }
          return;
        }

        pushLog(`[一键成片] 等待任务完成（pending: ${pendingAudio}, running: ${runningAudio}）`);
        setOneClickFilm('idle');
        setOcProgress(null);
        return;
      }
    }

    console.log(`[一键成片] Phase2 待处理: ${ready.length} 段`);


    pushLog(`[一键成片] 阶段② 开始批量数字人: ${ready.length} 段`);
    setOcProgress((p) => (p ? { ...p, phase: 'dh', done: 0, total: ready.length } : null));
    oneClickRef.current = 'dh';
    setOneClickFilm('dh');
    // 更新独立任务的数字人阶段状态
    const currSessionId = currentTaskSessionIdRef.current;
    if (currSessionId) {
      setNewTaskSessions((prev) =>
        prev.map((s) => (s.id === currSessionId ? { ...s, ocState: 'dh' as const } : s))
      );
    }
    const dhQueue = [...ready];
    const dhWorkers = Array.from({ length: Math.min(dhQueue.length, MAX_CONCURRENT) }, () => {
      const worker = async () => {
        while (dhQueue.length > 0) {
          if (oneClickRef.current === 'idle') {
            console.log('[一键成片] dh worker 检测到 oneClickFilm==idle，提前退出');
            return;
          }
          const task = dhQueue.shift()!;
          console.log(`[一键成片] dh worker 开始处理段${task.index} (${task.id}), audioUrl: ${task.audioUrl?.slice(0, 60)}`);
          try {
            // 传递音频 URL 以便在 ID 不匹配时使用
            await generateSingleDh(task.id, task.audioUrl);
            console.log(`[一键成片] dh worker 段${task.index} 完成`);
            setOcProgress((p) => p ? { ...p, done: p.done + 1 } : null);
          } catch (err: any) {
            console.error(`[一键成片] dh worker 段${task.index} 异常:`, err.message);
            pushLog(`[一键成片] ⚠️ 段${task.index} 数字人异常: ${err.message}`);
          }
        }
      };
      return worker();
    });
    await Promise.all(dhWorkers);
    console.log('[一键成片] Phase2 数字人阶段全部 worker 完成');

    // 等待所有段落数字人完成（防止手动触发的数字人在 workers 完成后才完成）
    // 只等待当前任务的段落
    const currentIds = currentTaskSegmentIdsRef.current;
    let waitCount = 0;
    while (true) {
      const pendingDh = [...completedDhPhasesRef.current.entries()]
        .filter(([id, phase]) => phase !== 'done' && phase !== 'error' && currentIds.has(id));
      if (pendingDh.length === 0) break;
      waitCount++;
      if (waitCount % 10 === 0) {
        pushLog(`[一键成片] 等待数字人完成: ${pendingDh.length} 段进行中…`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (waitCount > 0) {
      pushLog(`[一键成片] 所有数字人已完成，开始打包…`);
    }

    // 只打包当前任务的视频（currentTaskSegmentIdsRef），避免 ref 累积导致跨任务打包
    const doneEntries = [...completedDhPhasesRef.current.entries()]
      .filter(([id, phase]) => phase === 'done' && currentIds.has(id));
    const failedDhEntries = [...completedDhPhasesRef.current.entries()]
      .filter(([id, phase]) => phase === 'error' && currentIds.has(id));

    // 从 tasksRef 获取任务详情（用于日志显示 index），如果 tasksRef 未同步则从 pending 列表构造
    const done = doneEntries.map(([id]) => {
      const fromRef = tasksRef.current.find((t) => t.id === id);
      if (fromRef) return fromRef;
      // tasksRef 未同步时，从 completedAudioUrlsRef 获取 audioUrl，从 completedDhVideoUrlsRef 获取 dhVideoUrl
      return {
        id,
        index: 0, // 无法确定 index，用 0 占位
        audioUrl: completedAudioUrlsRef.current.get(id),
        dhVideoUrl: completedDhVideoUrlsRef.current.get(id),
      } as typeof tasksRef.current[0];
    });
    const failedDh = failedDhEntries.map(([id]) => tasksRef.current.find((t) => t.id === id)).filter(Boolean);
    console.log(`[一键成片] Phase2 结果: 成功 ${done.length}, 失败 ${failedDh.length}`);
    console.log(`[一键成片] completedDhPhasesRef:`, [...completedDhPhasesRef.current.entries()]);
    failedDh.forEach((t) => {
      pushLog(`[一键成片] ⚠️ 段${t.index} 数字人失败: ${t.dhError || '未知错误'}`);
      console.error(`[一键成片] 段${t.index} DH 失败详情:`, t.dhError);
    });

    pushLog(`[一键成片] 阶段② 完成 → 开始下载 ZIP`);
    setOneClickFilm('done');

    // Phase 3: 打包下载
    if (done.length === 0) {
      toast.warning('数字人全部失败，无视频可下载');
      setPhase3JustFinished(true);
      setOneClickFilm('idle');
      return;
    }

    pushLog(`[一键成片] 打包 ${done.length} 个视频…`);
    setDownloadProgress({ totalFiles: done.length, currentIndex: 0, phase: 'downloading', overallPercent: 0, currentFilename: '' });
    try {
      // 使用 completedDhVideoUrlsRef 获取视频 URL（tasksRef 可能未同步），同时获取原始 index
      const videoItems = done.map((t) => {
        const videoUrl = completedDhVideoUrlsRef.current.get(t.id);
        const originalTask = tasksRef.current.find((orig) => orig.id === t.id);
        const segmentIndex = originalTask?.index ?? (typeof t.index === 'number' && t.index > 0 ? t.index : 0);
        return {
          url: videoUrl!,
          filename: `段${segmentIndex}.mp4`,
        };
      });
      const totalBatches = Math.ceil(videoItems.length / BATCH_ZIP_SIZE);
      if (totalBatches > 1) {
        pushLog(`[一键成片] 分 ${totalBatches} 批打包下载…`);
        let downloadedBatches = 0;
        await packVideosToBatches(
          videoItems,
          (batchIndex, total, batchPct, filename) => {
            setDownloadProgress((p) =>
              p ? { ...p, batchIndex, totalBatches: total, overallPercent: batchPct, currentFilename: filename, phase: 'downloading' } : null
            );
          },
          (batchIndex, total, batch) => {
            // 每批完成后立即触发下载，不必等全部完成
            triggerZipDownload(batch.zipBlob, `数字人对口型_${batch.partLabel}`);
            downloadedBatches++;
            pushLog(`[一键成片] ✅ ${batch.partLabel}（含 ${batch.filenames.length} 个视频）已下载`);
            setDownloadProgress((p) =>
              p ? { ...p, batchIndex, totalBatches: total, overallPercent: Math.round((downloadedBatches / total) * 100), phase: 'downloading' } : null
            );
          }
        );
        pushLog(`[一键成片] ✅ 全部完成 · ${done.length} 个视频已下载`);
        toast.success(`一键成片完成: ${done.length} 个视频分 ${totalBatches} 批打包下载`);
      } else {
        const onProgress: DownloadProgressCallback = (info) => {
          setDownloadProgress((p) =>
            p ? { ...p, overallPercent: info.overallPercent >= 0 ? info.overallPercent : (p?.overallPercent ?? 0), currentIndex: info.currentIndex, currentFilename: info.filename, phase: info.phase } : null
          );
        };
        const blob = await packVideosToZip(videoItems, '数字人对口型视频.zip', onProgress);
        triggerZipDownload(blob, '数字人对口型视频');
        pushLog(`[一键成片] ✅ 全部完成 · ${done.length} 个视频已下载`);
        toast.success(`一键成片完成: ${done.length} 个视频已打包下载`);
      }
    } catch (err: any) {
      toast.error(`打包失败: ${err.message}`);
    } finally {
      setDownloadProgress(null);
      console.log('[一键成片] Phase3 finally 到达');
    }
    // 标记 Phase 3 完成，触发 useEffect 执行队列
    console.log('[一键成片] 🔥 Phase3 即将设置 setPhase3JustFinished(true)');
    setPhase3JustFinished(true);
    // 任务完成后状态恢复（队列自动执行由 useEffect 监听 phase3JustFinished 触发）
    setOneClickFilm('idle');
    setOcProgress(null);

    // 更新 newTaskSessions 中已完成 session 的状态（显示完成标记）
    const completedSessionId = currentTaskSessionIdRef.current;
    if (completedSessionId) {
      setNewTaskSessions((prev) =>
        prev.map((s) =>
          s.id === completedSessionId ? { ...s, ocState: 'done' as const } : s
        )
      );
    }

    // 同步检查队列：是否有更多待执行的任务？直接执行下一个（不走 useEffect）
    const queueAfterDone = oneClickQueueRef.current;
    const nextId = queueAfterDone?.sessionIds[0];
    if (nextId) {
      console.log('[一键成片] 队列中还有任务，直接执行下一个:', nextId);

      // 立即标记队列处理中，防止 useEffect 重复触发
      queueProcessingRef.current = true;

      // 用函数式更新：React 会把最新 state 作为参数传入，
      // 这样可以拿到最新 newTaskSessions（不受闭包过时影响）
      setOneClickQueue((prevQueue) => {
        const queue = prevQueue || queueAfterDone!;
        const isMainTask = nextId === '';
        const sessionData = !isMainTask ? newTaskSessionsRef.current.find((s) => s.id === nextId) : null;
        console.log('[一键成片] 队列查找: nextId=', nextId, 'isMainTask=', isMainTask, 'newTaskSessions长度=', newTaskSessionsRef.current.length, 'sessionData=', sessionData ? sessionData.id : null);
        const nextSegments: DhSegmentTask[] = isMainTask
          ? tasks
          : (sessionData?.segments.map((seg) => {
              console.log('[一键成片] 独立任务 segment 原始 id:', seg.id);
              return ({
                id: seg.id, index: seg.index, text: seg.text,
                textLength: seg.text.length,
                audioPhase: seg.audioPhase as 'pending' | 'running' | 'done' | 'error',
                audioUrl: seg.audioUrl,
                dhPhase: seg.dhPhase as 'pending' | 'running' | 'done' | 'error',
                dhVideoUrl: seg.dhVideoUrl,
              });
            }) ?? []);

        // 从队列中移除正在执行的任务
        const cleanedQueue = {
          sessionIds: queue.sessionIds.slice(1),
          pendingSegmentsBySession: Object.fromEntries(
            Object.entries(queue.pendingSegmentsBySession).filter(([k]) => k !== nextId)
          ),
        };
        oneClickQueueRef.current = cleanedQueue;

        // 保存主任务的 segments（用于完成后恢复 UI）
        mainTasksRef.current = tasks;
        // 记录当前 session ID，用于 Phase 3 更新 newTaskSessions 状态
        currentTaskSessionIdRef.current = nextId;
        // 记录当前任务的 segment IDs（直接使用 segment 的原有 id，已经是完整格式）
        currentTaskSegmentIdsRef.current = new Set(nextSegments.map((t) => t.id));

        if (!isMainTask) {
          // 更新独立任务的执行状态
          setNewTaskSessions((prev) =>
            prev.map((s) => (s.id === nextId ? { ...s, ocState: 'audio' as const } : s))
          );
          // 将队列任务的 segments 合并到 tasksRef（runQueueTask Phase 2 从 tasksRef 读取最新音频状态）
          // 注意：独立任务的 segment.id 已经是完整格式（如 seg_xxx_0），不需要再加前缀
          const existingIds = new Set(tasksRef.current.map((t) => t.id));
          console.log('[队列处理] setOneClickQueue 回调开始');
          console.log('[队列处理] 合并前 tasksRef:', tasksRef.current.map(t => `${t.id.slice(-10)}:audio=${t.audioPhase}`).join(', '));
          console.log('[队列处理] nextSegments:', nextSegments.map(s => `${s.id.slice(-10)}:audio=${s.audioPhase}`).join(', '));
          // 直接使用 segment 的原有 id（已经是完整格式）
          const newSegs = nextSegments
            .filter((s) => !existingIds.has(s.id))
            .map((s) => ({ ...s }));
          console.log('[队列处理] 新增 segments:', newSegs.map(s => s.id.slice(-10)).join(', '));
          tasksRef.current = [...tasksRef.current, ...newSegs];
          console.log('[队列处理] 合并后 tasksRef:', tasksRef.current.map(t => `${t.id.slice(-10)}:audio=${t.audioPhase}`).join(', '));
          console.log('[队列处理] setOneClickQueue 回调结束，即将 setTimeout');
        } else {
          // 主任务：直接覆盖
          tasksRef.current = nextSegments;
        }

        if (isMainTask) {
          // 主任务：更新 tasks 并调用 handleOneClickFilm
          setTasks(nextSegments);
          setTimeout(() => {
            autoContinueRef.current = true;
            handleOneClickFilmRef.current?.();
          }, 300);
        } else {
          // 独立任务：直接执行，不操作 tasks（主任务 UI 保持不变）
          setTimeout(() => {
            queueRunningRef.current = true;
            // 直接从 newTaskSessionsRef 获取最新的完整 segments，避免 id 转换问题
            const latestSession = newTaskSessionsRef.current.find((s) => s.id === nextId);
            const latestSegments = latestSession?.segments ?? nextSegments;
            console.log('[一键成片] 独立任务执行，使用最新 segments:', latestSegments.map(s => `${s.id.slice(-10)}:audio=${s.audioPhase}`).join(', '));
            void runQueueTask(nextId, latestSegments);
          }, 300);
        }

        return cleanedQueue;
      });
    } else {
      // 队列已空，清空队列状态，并恢复主任务显示
      console.log('[一键成片] 队列已空，清空并恢复主任务');
      setOneClickQueue(null);
      oneClickQueueRef.current = null;
      // 恢复主任务到 UI
      if (mainTasksRef.current.length > 0) {
        tasksRef.current = mainTasksRef.current;
        setTasks(mainTasksRef.current);
        mainTasksRef.current = [];
      }
    }
  }, [
    runningHubApiKey,
    refVideoRhPath,
    toast,
    pushLog,
    dhSessionId,
    generateSingleAudio,
    generateSingleDh,
    setDownloadProgress,
    triggerZipDownload,
    packVideosToBatches,
    packVideosToZip,
    tasks,
    oneClickFilm,
    oneClickQueue,
    selectedSessionIds,
    newTaskSessions,
    setSelectedSessionIds,
    setPhase3JustFinished,
  ]);

  // 保持 ref 指向最新版本的 handleOneClickFilm
  handleOneClickFilmRef.current = handleOneClickFilm;

  // ============================================================
  // 取消挂起队列
  // ============================================================
  const handleCancelOneClickQueue = useCallback(() => {
    setOneClickQueue(null);
    oneClickQueueRef.current = null;
    pushLog('[一键成片] ⏭️ 已取消挂起队列');
    toast.info('已取消挂起队列');
  }, [pushLog, toast]);
  const handleShowHistory = useCallback(() => {
    setHistoryEntries(loadDhHistory());
    setShowHistory(true);
  }, []);

  const handleLoadHistory = useCallback(
    (rec: DhHistoryRecord) => {
      // 重建段落任务
      const newTasks: DhSegmentTask[] = rec.segments.map((seg, i) => ({
        id: `hist_${rec.id}_${i}`,
        index: seg.index,
        text: seg.text,
        textLength: seg.text.length,
        audioPhase: seg.audioUrl ? ('done' as const) : 'pending',
        audioUrl: seg.audioUrl,
        dhPhase: seg.videoUrl ? ('done' as const) : 'pending',
        dhVideoUrl: seg.videoUrl,
      }));

      setRefVideoName(rec.referenceVideoName);
      setScriptText(rec.scriptPreview);
      setSegments(newTasks);
      setTasks(newTasks);
      setShowHistory(false);
      toast.success(`已加载历史记录: ${rec.displayName}`);
      pushLog(`[历史] 加载: ${rec.displayName}，${newTasks.length} 段`);
    },
    [toast, pushLog]
  );

  // ============================================================
  // 选中管理
  // ============================================================
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(tasks.map((t) => t.id)));
  }, [tasks]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // ============================================================
  // 音频播放
  // ============================================================
  const handlePlayAudio = useCallback(
    (task: DhSegmentTask) => {
      if (!task.audioUrl) return;

      if (playingId === task.id) {
        // 暂停
        audioRefs.current.get(task.id)?.pause();
        setPlayingId(null);
        return;
      }

      // 停止其他
      audioRefs.current.forEach((el, id) => {
        if (id !== task.id) {
          el.pause();
          el.currentTime = 0;
        }
      });
      setPlayingId(null);

      let el = audioRefs.current.get(task.id);
      if (!el) {
        el = new Audio(task.audioUrl);
        audioRefs.current.set(task.id, el);
        el.addEventListener('ended', () => setPlayingId(null));
      }
      el.src = task.audioUrl;
      el.play();
      setPlayingId(task.id);
    },
    [playingId]
  );

  // ============================================================
  // 统计
  // ============================================================
  const stats = useMemo(() => {
    const audioDone = tasks.filter((t) => t.audioPhase === 'done').length;
    const audioError = tasks.filter((t) => t.audioPhase === 'error').length;
    const dhDone = tasks.filter((t) => t.dhPhase === 'done').length;
    const dhError = tasks.filter((t) => t.dhPhase === 'error').length;
    const dhRunning = tasks.filter((t) => t.dhPhase === 'running').length;
    const concurrencyUsed = dhConcurrency.activeCount;
    return { audioDone, audioError, dhDone, dhError, dhRunning, concurrencyUsed };
  }, [tasks]);

  // ============================================================
  // 渲染
  // ============================================================

  const PhaseIcon = ({ phase }: { phase: DhSegmentTask['audioPhase'] | DhSegmentTask['dhPhase'] }) => {
    switch (phase) {
      case 'done':
        return <CheckCircle2 size={14} className="text-green-400" />;
      case 'error':
        return <AlertCircle size={14} className="text-red-400" />;
      case 'running':
        return <Loader2 size={14} className="text-blue-400 animate-spin" />;
      default:
        return <Clock size={14} className="text-gray-500" />;
    }
  };

  return (
    <div className="h-full flex flex-col bg-gray-950 text-white">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-800 flex items-center gap-3">
        <div className="p-2 bg-blue-600/20 rounded-lg">
          <Video size={20} className="text-blue-400" />
        </div>
        <div>
          <h2 className="font-semibold text-white">数字人对口型</h2>
          <p className="text-xs text-gray-500">上传参考视频 + 输入文案，自动分割并行配音，批量生成数字人对口型视频</p>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-gray-400">
          <RefreshCw size={12} className={dhConcurrency.activeCount > 0 ? 'animate-spin text-blue-400' : ''} />
          并发: {dhConcurrency.activeCount}/{MAX_CONCURRENT}
          {dhConcurrency.queueLength > 0 && (
            <span className="text-yellow-400">等待: {dhConcurrency.queueLength}</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="p-6 grid grid-cols-12 gap-4">
            {/* 左侧：输入区 */}
            <div className="col-span-7 space-y-4">
              {/* 参考视频 */}
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <h3 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
                  <Video size={14} />
                  参考视频
                  <span className="text-gray-600 font-normal">（上传至 RunningHub 持久化）</span>
                </h3>

                {!refVideoName ? (
                  <div className="flex gap-2">
                    <label className="flex flex-col items-center justify-center flex-1 border-2 border-dashed border-gray-700 rounded-lg p-6 cursor-pointer hover:border-blue-500 hover:bg-blue-500/5 transition-colors">
                      <Upload size={24} className="text-gray-500 mb-2" />
                      <span className="text-sm text-gray-400">选择本地视频</span>
                      <span className="text-xs text-gray-600 mt-1">mp4 / mov / avi，最大 100MB</span>
                      <input
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={handleRefVideoSelect}
                      />
                    </label>
                    <button
                      onClick={() => setShowVideoLibrary(true)}
                      className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-gray-700 rounded-lg p-6 cursor-pointer hover:border-purple-500 hover:bg-purple-500/5 transition-colors"
                    >
                      <Library size={24} className="text-gray-500 mb-2" />
                      <span className="text-sm text-gray-400">视频库</span>
                      <span className="text-xs text-gray-600 mt-1">选择已保存的视频</span>
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 bg-gray-800 rounded-lg p-3">
                    <Video size={16} className="text-blue-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-white truncate">{refVideoName}</p>
                        {libraryVideoId && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-400 flex-shrink-0">
                            来自视频库
                          </span>
                        )}
                      </div>
                      {refVideoUploading ? (
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 transition-all"
                              style={{ width: `${refVideoUploadPct}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-400">{refVideoUploadPct}%</span>
                        </div>
                      ) : refVideoRhPath ? (
                        <p className="text-xs text-green-400 mt-0.5 truncate">
                          ✓ 已上传: {refVideoRhPath}
                        </p>
                      ) : null}
                    </div>
                    <button
                      onClick={() => {
                        setRefVideoFile(null);
                        setRefVideoName('');
                        setRefVideoRhPath('');
                        setRefVideoUploadPct(0);
                        setLibraryVideoId(null);
                      }}
                      className="text-gray-400 hover:text-red-400"
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}
              </div>

              {/* 原文输入 */}
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                    <Mic size={14} />
                    原文输入
                    {detectedLang && (
                      <span className="text-xs font-normal px-2 py-0.5 rounded bg-gray-700 text-gray-400">
                        {detectedLang === 'zh' ? '中文' : '英文'}
                      </span>
                    )}
                  </h3>
                  <div className="flex items-center gap-2">
                    {segments.length > 0 && (
                      <span className="text-xs text-gray-500">
                        {segments.length} 段 · {scriptText.length} 字
                      </span>
                    )}
                    <button
                      onClick={() => {
                        if (!scriptText.trim() && !newTaskText.trim()) {
                          toast.warning('请先在下方输入文案');
                          return;
                        }
                        setShowNewTaskModal(true);
                      }}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-600/20 text-blue-400 hover:bg-blue-600/40 border border-blue-500/30 transition-colors"
                      title="新建独立任务，不影响当前正在执行的任务"
                    >
                      <Plus size={12} />
                      新建任务
                    </button>
                  </div>
                </div>

                <textarea
                  value={scriptText}
                  onChange={handleScriptChange}
                  placeholder={
                    detectedLang === 'en'
                      ? 'Enter your English script here...'
                      : '请输入要生成数字人的文案，支持中英文混合…'
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500"
                  rows={10}
                />
              </div>

              {/* 独立任务列表 */}
              {newTaskSessions.length > 0 && (
                <div className="space-y-3">
                  {/* 醒目的加入队列按钮 */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        const toQueue = selectedSessionIds.size > 0
                          ? newTaskSessions.filter((s) => selectedSessionIds.has(s.id))
                          : newTaskSessions;
                        if (toQueue.length === 0) return;

                        const existingQueue = oneClickQueueRef.current;
                        const alreadyQueuedIds = existingQueue?.sessionIds || [];
                        const newSessions = toQueue.filter((s) => !alreadyQueuedIds.includes(s.id));

                        if (newSessions.length === 0) {
                          toast.info('选中任务已在队列中');
                          return;
                        }

                        const newQueue = {
                          sessionIds: [...alreadyQueuedIds, ...newSessions.map((s) => s.id)],
                          pendingSegmentsBySession: {
                            ...(existingQueue?.pendingSegmentsBySession || {}),
                            ...Object.fromEntries(newSessions.map((s) => [s.id, s.segments.map((seg) => seg.id)])),
                          },
                        };
                        setOneClickQueue(newQueue);
                        oneClickQueueRef.current = newQueue;
                        setSelectedSessionIds(new Set());

                        const names = newSessions.map((s) => s.id.split('_')[1]).join(', ');
                        pushLog(`[一键成片] ⏳ 已加入队列: ${newSessions.length} 个任务 (${names})`);
                        toast.info(`已加入队列: ${newSessions.length} 个任务`);
                      }}
                      disabled={selectedSessionIds.size === 0}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed text-white shadow-lg shadow-amber-500/20 transition-all"
                    >
                      <Clock size={16} />
                      加入队列
                      {selectedSessionIds.size > 0
                        ? `（${selectedSessionIds.size} 个）`
                        : `（${newTaskSessions.length} 个）`}
                    </button>
                    <button
                      onClick={() => {
                        if (selectedSessionIds.size === newTaskSessions.length) {
                          setSelectedSessionIds(new Set());
                        } else {
                          setSelectedSessionIds(new Set(newTaskSessions.map((s) => s.id)));
                        }
                      }}
                      className="text-xs text-purple-400 hover:text-purple-300 px-3 py-2.5 rounded-xl hover:bg-purple-900/30 transition-colors border border-purple-500/30"
                    >
                      {selectedSessionIds.size === newTaskSessions.length ? '取消全选' : '全选'}
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                      <ExternalLink size={14} className="text-purple-400" />
                      独立任务 ({newTaskSessions.length})
                      <span className="sr-only">{tick}</span>
                    </h3>
                  </div>
                  {newTaskSessions.map((session) => {
                    // 合并 tasksRef 中的最新状态
                    const getSegFromRef = (segId: string) => {
                      const exact = tasksRef.current.find((t) => t.id === segId);
                      if (exact) return exact;
                      const parts = segId.split('_');
                      const suffix = parts.slice(-2).join('_');
                      const found = tasksRef.current.find((t) =>
                        t.id.endsWith('_' + suffix) || t.id.includes(suffix)
                      );
                      if (found) return found;
                      const timestampPart = parts.slice(1, -2).join('_');
                      if (timestampPart) {
                        return tasksRef.current.find((t) => t.id.includes(timestampPart));
                      }
                      return undefined;
                    };
                    const mergedSegments = session.segments.map((seg) => {
                      const ref = getSegFromRef(seg.id);
                      return {
                        ...seg,
                        audioPhase: ref?.audioPhase || seg.audioPhase,
                        audioUrl: ref?.audioUrl || seg.audioUrl,
                        dhPhase: ref?.dhPhase || seg.dhPhase,
                        dhVideoUrl: ref?.dhVideoUrl || seg.dhVideoUrl,
                      };
                    });
                    const audioDone = mergedSegments.filter((s) => s.audioPhase === 'done').length;
                    const dhDone = mergedSegments.filter((s) => s.dhPhase === 'done').length;
                    const isSelected = selectedSessionIds.has(session.id);
                    return (
                      <div
                        key={session.id}
                        className={`bg-gray-900/80 rounded-xl p-3 border transition-colors ${
                          isSelected ? 'border-purple-400 bg-purple-900/20' : 'border-purple-500/30'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                setSelectedSessionIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(session.id)) next.delete(session.id);
                                  else next.add(session.id);
                                  return next;
                                });
                              }}
                              className="text-purple-400 hover:text-white flex-shrink-0"
                            >
                              {isSelected ? (
                                <CheckSquare size={16} />
                              ) : (
                                <Square size={16} />
                              )}
                            </button>
                            <span className="text-xs font-bold text-purple-200 bg-purple-800/60 px-1.5 py-0.5 rounded">
                              {session.id.split('_')[1]}
                            </span>
                            {/* 状态徽章 - 使用合并后的状态 */}
                            {audioDone < mergedSegments.length && audioDone === 0 && dhDone === 0 && (
                              <span className="text-[10px] font-medium text-gray-400 bg-gray-700/50 px-1.5 py-0.5 rounded">等待执行</span>
                            )}
                            {audioDone < mergedSegments.length && audioDone > 0 && (
                              <span className="text-[10px] font-medium text-blue-400 bg-blue-900/50 px-1.5 py-0.5 rounded animate-pulse">配音中</span>
                            )}
                            {audioDone === mergedSegments.length && dhDone < mergedSegments.length && dhDone === 0 && (
                              <span className="text-[10px] font-medium text-amber-400 bg-amber-900/50 px-1.5 py-0.5 rounded animate-pulse">数字人中</span>
                            )}
                            {dhDone === mergedSegments.length && (
                              <span className="text-[10px] font-medium text-green-400 bg-green-900/50 px-1.5 py-0.5 rounded">已完成</span>
                            )}
                            <span className="text-xs text-gray-500">
                              {session.segments.length}段 · {session.text.length}字
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setNewTaskSessions((prev) => prev.filter((s) => s.id !== session.id))}
                              className="text-gray-500 hover:text-red-400 p-1"
                              title="移除此任务"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </div>
                        {mergedSegments.map((seg) => {
                          const audioUrl = seg.audioUrl;
                          const dhVideoUrl = seg.dhVideoUrl;
                          return (
                            <div key={seg.id} className="flex items-center gap-2 text-xs py-1.5 border-t border-gray-800/50">
                              <span className="text-gray-500 w-8 flex-shrink-0">段{seg.index}</span>
                              <span className="text-gray-600 flex-1 truncate">{seg.text.slice(0, 50)}{seg.text.length > 50 ? '…' : ''}</span>
                              {/* 配音状态 - 使用合并后的状态 */}
                              <span className={
                                seg.audioPhase === 'done' ? 'text-green-400' :
                                seg.audioPhase === 'error' ? 'text-red-400' :
                                seg.audioPhase === 'running' ? 'text-blue-400' : 'text-gray-600'
                              }>
                                {seg.audioPhase === 'done' ? '✓ 配音' :
                                 seg.audioPhase === 'error' ? '✗ 失败' :
                                 seg.audioPhase === 'running' ? '… 配音' : '○ 待配音'}
                              </span>
                              {/* 音频试听按钮 */}
                              {audioUrl && (
                                <button
                                  onClick={() => {
                                    if (playingId === seg.id) {
                                      setPlayingId(null);
                                    } else {
                                      setPlayingId(seg.id);
                                      const audio = new Audio(audioUrl);
                                      audio.onended = () => setPlayingId(null);
                                      audio.play().catch(console.error);
                                    }
                                  }}
                                  className="text-blue-400 hover:text-blue-300 p-0.5"
                                  title="试听音频"
                                >
                                  {playingId === seg.id ? <Pause size={11} /> : <Play size={11} />}
                                </button>
                              )}
                              {/* 数字人状态 - 使用合并后的状态 */}
                              <span className={
                                seg.dhPhase === 'done' ? 'text-green-400' :
                                seg.dhPhase === 'error' ? 'text-red-400' :
                                seg.dhPhase === 'running' ? 'text-blue-400' : 'text-gray-600'
                              }>
                                {seg.dhPhase === 'done' ? '✓ 数字人' :
                                 seg.dhPhase === 'error' ? '✗ 失败' :
                                 seg.dhPhase === 'running' ? '… 数字人' : '○ 待生成'}
                              </span>
                              {/* 视频预览按钮 */}
                              {dhVideoUrl && (
                                <button
                                  onClick={() => setPreviewVideo({ url: dhVideoUrl, name: `段${seg.index}` })}
                                  className="text-purple-400 hover:text-purple-300 p-0.5"
                                  title="预览视频"
                                >
                                  <Video size={11} />
                                </button>
                              )}
                              {/* 视频下载按钮 */}
                              {dhVideoUrl && (
                                <button
                                  onClick={() => {
                                    const a = document.createElement('a');
                                    a.href = dhVideoUrl;
                                    a.download = `数字人对口型_段${seg.index}.mp4`;
                                    a.target = '_blank';
                                    a.click();
                                  }}
                                  className="text-gray-500 hover:text-white p-0.5"
                                  title="下载视频"
                                >
                                  <Download size={11} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 段落预览 */}
              {segments.length > 0 && (
                <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                  <h3 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
                    <Film size={14} />
                    段落分割预览
                    <span className="text-xs text-gray-600 font-normal">
                      {detectedLang === 'zh' ? '~400字/段' : '~400词/段'}
                    </span>
                    <span className="ml-auto text-xs text-gray-500">{segments.length} 段</span>
                  </h3>
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {segments.map((seg) => {
                      const running = tasks.find((t) => t.id === seg.id);
                      return (
                        <div
                          key={seg.id}
                          className={`bg-gray-800 rounded-lg p-3 border ${
                            selectedIds.has(seg.id) ? 'border-blue-500' : 'border-gray-700'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <button
                              onClick={() => toggleSelect(seg.id)}
                              className="text-gray-500 hover:text-white"
                            >
                              {selectedIds.has(seg.id) ? (
                                <CheckSquare size={14} className="text-blue-400" />
                              ) : (
                                <Square size={14} />
                              )}
                            </button>
                            <span className="text-xs font-medium text-gray-400">
                              段{seg.index}
                            </span>
                            <span className="text-xs text-gray-600">{seg.textLength}字</span>

                            {/* 配音状态 */}
                            {running && (
                              <div className="ml-auto flex items-center gap-1">
                                <PhaseIcon phase={running.audioPhase} />
                                <span className="text-xs text-gray-500">
                                  {running.audioPhase === 'done' ? '配音✓' : ''}
                                  {running.audioPhase === 'error' ? '配音✗' : ''}
                                  {running.audioPhase === 'running' ? '配音…' : '待配音'}
                                </span>
                                {running.audioPhase === 'done' && running.audioUrl && (
                                  <button
                                    onClick={() => handlePlayAudio(running)}
                                    className="text-blue-400 hover:text-blue-300 ml-1"
                                    title="试听"
                                  >
                                    {playingId === running.id ? <Pause size={12} /> : <Play size={12} />}
                                  </button>
                                )}
                              </div>
                            )}

                            {/* 单段操作 */}
                            <div className="flex items-center gap-1 ml-2">
                              {(!running || running.audioPhase !== 'done') && (
                                <button
                                  onClick={() => generateSingleAudio(seg.id)}
                                  disabled={running?.audioPhase === 'running'}
                                  className="text-xs px-2 py-0.5 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/40 disabled:opacity-40"
                                >
                                  {running?.audioPhase === 'running' ? '…' : '配音'}
                                </button>
                              )}
                              <button
                                onClick={() => generateSingleDh(seg.id)}
                                disabled={
                                  !running ||
                                  running.audioPhase !== 'done' ||
                                  running.dhPhase === 'running'
                                }
                                className="text-xs px-2 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/40 disabled:opacity-40"
                              >
                                {running?.dhPhase === 'running' ? '…' : '数字人'}
                              </button>
                            </div>
                          </div>
                          <p className="text-xs text-gray-500 line-clamp-2 pl-[22px]">
                            {seg.text.slice(0, 120)}
                            {seg.text.length > 120 && '…'}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 右侧：操作 & 状态 */}
            <div className="col-span-5 space-y-4">
              {/* 并发状态 */}
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <h3 className="text-sm font-medium text-gray-300 mb-3">并发控制</h3>
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{
                        width: `${(stats.concurrencyUsed / MAX_CONCURRENT) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs text-gray-400">
                    {stats.concurrencyUsed}/{MAX_CONCURRENT}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-gray-800 rounded p-2">
                    <span className="text-gray-500">配音完成</span>
                    <p className="text-green-400 font-medium">
                      {stats.audioDone}/{tasks.length}
                    </p>
                  </div>
                  <div className="bg-gray-800 rounded p-2">
                    <span className="text-gray-500">数字人完成</span>
                    <p className="text-green-400 font-medium">
                      {stats.dhDone}/{tasks.length}
                    </p>
                  </div>
                </div>
              </div>

              {/* 参考音色 */}
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <h3 className="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                  <Volume2 size={14} />
                  参考音色
                </h3>
                <p className="text-sm text-gray-400 bg-gray-800 rounded-lg px-3 py-2.5 mb-2 truncate">
                  {selectedVoice?.name || '未选择 · 使用系统默认参考音'}
                </p>
                <button
                  onClick={() => setShowVoiceLibrary(true)}
                  className="w-full py-2 rounded-lg text-sm font-medium bg-slate-800 hover:bg-slate-700 text-gray-200 border border-gray-700 transition-colors"
                >
                  管理语音库
                </button>
              </div>

              {/* 批量操作 */}
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <h3 className="text-sm font-medium text-gray-300 mb-3">批量操作</h3>
                <div className="space-y-2">
                  <button
                    onClick={handleBatchAudio}
                    disabled={tasks.filter((t) => t.audioPhase === 'pending').length === 0}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Mic size={16} />
                    一键批量配音
                    {tasks.filter((t) => t.audioPhase === 'pending').length > 0 && (
                      <span className="text-xs opacity-70">
                        ({tasks.filter((t) => t.audioPhase === 'pending').length}段)
                      </span>
                    )}
                  </button>

                  <button
                    onClick={handleBatchDh}
                    disabled={
                      tasks.filter(
                        (t) => t.audioPhase === 'done' && (t.dhPhase === 'pending' || t.dhPhase === 'error')
                      ).length === 0
                    }
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Film size={16} />
                    批量生成数字人
                    {tasks.filter(
                      (t) => t.audioPhase === 'done' && (t.dhPhase === 'pending' || t.dhPhase === 'error')
                    ).length > 0 && (
                      <span className="text-xs opacity-70">
                        (
                        {
                          tasks.filter(
                            (t) => t.audioPhase === 'done' && (t.dhPhase === 'pending' || t.dhPhase === 'error')
                          ).length
                        }
                        段)
                      </span>
                    )}
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleDownloadAll}
                      disabled={tasks.filter((t) => t.dhPhase === 'done').length === 0}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded-lg text-xs transition-colors"
                    >
                      <Download size={14} />
                      下载全部
                    </button>
                    <button
                      onClick={handleDownloadSelected}
                      disabled={selectedIds.size === 0}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded-lg text-xs transition-colors"
                    >
                      <Archive size={14} />
                      下载选中
                      {selectedIds.size > 0 && (
                        <span className="text-blue-400">({selectedIds.size})</span>
                      )}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => (selectedIds.size < tasks.length ? selectAll() : deselectAll())}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors"
                    >
                      {selectedIds.size < tasks.length ? (
                        <>
                          <CheckSquare size={14} />
                          全选
                        </>
                      ) : (
                        <>
                          <Square size={14} />
                          取消
                        </>
                      )}
                    </button>
                    <button
                      onClick={handleShowHistory}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors"
                    >
                      <History size={14} />
                      查看历史
                    </button>
                  </div>

                  {/* 一键成片进度条 */}
                  {ocProgress && (oneClickFilm === 'audio' || oneClickFilm === 'dh' || oneClickFilm === 'done') && (
                    <OneClickProgressBar
                      progress={ocProgress}
                      currentPhase={oneClickFilm as 'audio' | 'dh' | 'done'}
                    />
                  )}

                  {/* 下载打包进度条 */}
                  {downloadProgress && downloadProgress.phase !== 'done' && (
                    <div className="space-y-1.5 p-3 bg-slate-800/60 rounded-lg border border-slate-600">
                      <div className="flex items-center justify-between text-xs text-slate-300">
                        <span className="flex items-center gap-1.5">
                          <Download size={12} className="text-blue-400" />
                          {downloadProgress.phase === 'downloading'
                            ? downloadProgress.totalBatches && downloadProgress.totalBatches > 1
                              ? `打包下载中（第 ${(downloadProgress.batchIndex ?? 0) + 1}/${downloadProgress.totalBatches} 批）`
                              : '下载中…'
                            : '打包中…'}
                        </span>
                        <span className="text-blue-400 font-mono">{downloadProgress.overallPercent}%</span>
                      </div>
                      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-300"
                          style={{ width: `${downloadProgress.overallPercent}%` }}
                        />
                      </div>
                      {downloadProgress.currentFilename && (
                        <p className="text-[10px] text-slate-500 truncate">
                          {downloadProgress.currentFilename}
                        </p>
                      )}
                      <p className="text-[10px] text-slate-500">
                        {downloadProgress.totalBatches && downloadProgress.totalBatches > 1
                          ? `已处理 ${downloadProgress.currentIndex}/${downloadProgress.totalFiles} 个文件`
                          : downloadProgress.totalFiles > 0
                          ? `文件 ${downloadProgress.currentIndex}/${downloadProgress.totalFiles}`
                          : ''}
                      </p>
                    </div>
                  )}

                  {/* 一键成片 */}
                  <button
                    onClick={handleOneClickFilm}
                    disabled={
                      oneClickFilm !== 'idle'
                        ? false
                        : (newTaskSessions.length > 0
                          ? selectedSessionIds.size === 0 && tasks.filter((t) => t.audioPhase === 'pending').length === 0
                          : tasks.filter((t) => t.audioPhase === 'pending').length === 0)
                    }
                    className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
                      oneClickFilm !== 'idle'
                        ? 'bg-amber-600/70 hover:bg-amber-500/70 animate-pulse'
                        : 'bg-gradient-to-r from-blue-600 via-purple-600 to-emerald-600 hover:from-blue-500 hover:via-purple-500 hover:to-emerald-500 disabled:from-gray-700 disabled:via-gray-700 disabled:to-gray-700 shadow-lg shadow-purple-500/20'
                    } text-white`}
                  >
                    {oneClickFilm === 'idle' && <Film size={18} />}
                    {oneClickFilm !== 'idle' && <Clock size={18} />}
                    {oneClickFilm === 'idle' && newTaskSessions.length > 0 && selectedSessionIds.size === 0 && `一键成片（排队${newTaskSessions.length}个）`}
                    {oneClickFilm === 'idle' && newTaskSessions.length > 0 && selectedSessionIds.size > 0 && `一键成片（排队${selectedSessionIds.size}个）`}
                    {oneClickFilm === 'idle' && newTaskSessions.length === 0 && '一键成片'}
                    {oneClickFilm === 'audio' && `配音中…`}
                    {oneClickFilm === 'dh' && `数字人中…`}
                    {oneClickFilm === 'done' && `完成!`}
                  </button>

                  {/* 挂起队列状态显示 */}
                  {oneClickQueue && oneClickQueue.sessionIds.length > 0 && (
                    <div className="flex flex-col gap-1.5 px-3 py-2.5 bg-amber-900/40 border border-amber-500/50 rounded-lg shadow-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Clock size={16} className="text-amber-400 animate-pulse" />
                          <div className="flex flex-col">
                            <span className="text-xs text-amber-300 font-medium">
                              ⏳ 等待队列: {oneClickQueue.sessionIds.length} 个任务
                            </span>
                            {oneClickQueue.sessionIds.length > 0 && (
                              <span className="text-[10px] text-amber-500">
                                {oneClickQueue.sessionIds.map((id) => id ? id.split('_')[1] : '主').join(', ')}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={handleCancelOneClickQueue}
                          className="text-xs text-amber-300 hover:text-white px-3 py-1 rounded bg-amber-800/50 hover:bg-amber-700/50 border border-amber-600/30 transition-colors shrink-0"
                        >
                          取消队列
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* 任务列表 */}
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <h3 className="text-sm font-medium text-gray-300 mb-3">任务列表</h3>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {tasks.length === 0 ? (
                    <p className="text-gray-600 text-sm text-center py-4">
                      输入文案后自动分割段落
                    </p>
                  ) : (
                    tasks.map((task) => (
                      <div
                        key={task.id}
                        className="bg-gray-800 rounded-lg p-2.5 flex items-center gap-2"
                      >
                        <button
                          onClick={() => toggleSelect(task.id)}
                          className="text-gray-500 hover:text-white flex-shrink-0"
                        >
                          {selectedIds.has(task.id) ? (
                            <CheckSquare size={14} className="text-blue-400" />
                          ) : (
                            <Square size={14} />
                          )}
                        </button>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-gray-400 font-medium">段{task.index}</span>
                            <span className="text-gray-600">{task.textLength}字</span>

                            {/* 音频 */}
                            {task.audioPhase === 'done' ? (
                              <button
                                onClick={() => handlePlayAudio(task)}
                                className="ml-1 text-blue-400 hover:text-blue-300"
                              >
                                {playingId === task.id ? <Pause size={12} /> : <Play size={12} />}
                              </button>
                            ) : (
                              <span className="ml-1 text-gray-600">
                                <PhaseIcon phase={task.audioPhase} />
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-gray-600">
                              配音:{' '}
                              <span
                                className={
                                  task.audioPhase === 'done'
                                    ? 'text-green-400'
                                    : task.audioPhase === 'error'
                                    ? 'text-red-400'
                                    : 'text-gray-500'
                                }
                              >
                                {task.audioPhase === 'done'
                                  ? '✓'
                                  : task.audioPhase === 'error'
                                  ? '✗'
                                  : task.audioPhase === 'running'
                                  ? '…'
                                  : '○'}
                              </span>
                            </span>
                            <span className="text-[10px] text-gray-600">
                              数字人:{' '}
                              <span
                                className={
                                  task.dhPhase === 'done'
                                    ? 'text-green-400'
                                    : task.dhPhase === 'error'
                                    ? 'text-red-400'
                                    : 'text-gray-500'
                                }
                              >
                                {task.dhPhase === 'done'
                                  ? '✓'
                                  : task.dhPhase === 'error'
                                  ? '✗'
                                  : task.dhPhase === 'running'
                                  ? '…'
                                  : '○'}
                              </span>
                            </span>
                            {task.dhPhase === 'running' && task.dhStartMs && (
                              <span className="text-[10px] text-blue-400">
                                {formatElapsed(Date.now() - task.dhStartMs)}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                          {task.dhPhase === 'done' && (
                            <button
                              onClick={() => handleDownloadSingle(task)}
                              className="text-gray-500 hover:text-white p-1"
                              title="下载"
                            >
                              <Download size={13} />
                            </button>
                          )}
                          {task.dhVideoUrl && (
                            <button
                              onClick={() =>
                                setPreviewVideo({
                                  url: task.dhVideoUrl!,
                                  name: `段${task.index}`,
                                })
                              }
                              className="text-gray-500 hover:text-blue-400 p-1"
                              title="预览"
                            >
                              <Video size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* 独立任务列表 */}
                {newTaskSessions.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-gray-700">
                    {/* tick 用于触发实时刷新 */}
                    <h3 className="text-sm font-medium text-purple-300 mb-3 flex items-center gap-2">
                      <ExternalLink size={14} className="text-purple-400" />
                      独立任务列表 ({newTaskSessions.length})
                      {/* 隐藏的 tick 引用，触发重新渲染以获取最新任务状态 */}
                      <span className="sr-only">{tick}</span>
                    </h3>
                    <div className="space-y-3 max-h-[400px] overflow-y-auto">
                      {newTaskSessions.map((session) => {
                        // 从 tasksRef 获取最新状态（独立任务 segment.id 包含在 tasksRef 完整 id 中）
                        // 例如: seg_1778225882938_0_wbwp (完整) 匹配 938_0_wbwp 或 seg_xxx_0_wbwp (部分)
                        const getSegFromRef = (segId: string) => {
                          // 尝试多种匹配方式：
                          // 1. 直接匹配
                          const exact = tasksRef.current.find((t) => t.id === segId);
                          if (exact) return exact;
                          
                          // 2. 包含匹配（tasksRef 中的 id 包含 segId 的后缀部分）
                          // segId 格式可能是: seg_timestamp_index_random 或 timestamp_index_random
                          const parts = segId.split('_');
                          // 提取时间戳后面的部分: index_random
                          const suffix = parts.slice(-2).join('_'); // 例如: 0_wbwp
                          const found = tasksRef.current.find((t) => 
                            t.id.endsWith('_' + suffix) || t.id.includes(suffix)
                          );
                          if (found) return found;
                          
                          // 3. 尝试用时间戳部分匹配
                          const timestampPart = parts.slice(1, -2).join('_'); // 例如: 1778225882938
                          if (timestampPart) {
                            return tasksRef.current.find((t) => t.id.includes(timestampPart));
                          }
                          
                          return undefined;
                        };
                        // 实时计算 session 的整体状态
                        const sessionSegTasks = session.segments.map((seg) => {
                          const refSeg = getSegFromRef(seg.id);
                          return {
                            ...seg,
                            audioPhase: refSeg?.audioPhase || seg.audioPhase,
                            audioUrl: refSeg?.audioUrl || seg.audioUrl,
                            dhPhase: refSeg?.dhPhase || seg.dhPhase,
                            dhVideoUrl: refSeg?.dhVideoUrl || seg.dhVideoUrl,
                            dhStartMs: refSeg?.dhStartMs || seg.dhStartMs,
                            dhError: refSeg?.dhError || seg.dhError,
                          };
                        });
                        // 计算 session 的整体状态
                        const hasRunningAudio = sessionSegTasks.some((t) => t.audioPhase === 'running');
                        const hasRunningDh = sessionSegTasks.some((t) => t.dhPhase === 'running');
                        const allAudioDone = sessionSegTasks.every((t) => t.audioPhase === 'done');
                        const allDhDone = sessionSegTasks.every((t) => t.dhPhase === 'done');
                        const anyDhError = sessionSegTasks.some((t) => t.dhPhase === 'error');
                        const sessionState = hasRunningAudio ? 'audio' : hasRunningDh ? 'dh' : allDhDone ? 'done' : allAudioDone ? 'audio_done' : 'idle';

                        return (
                          <div
                            key={session.id}
                            className="bg-gray-800/80 rounded-xl p-3 border border-purple-500/30"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-purple-200 bg-purple-800/60 px-1.5 py-0.5 rounded">
                                  {session.id.split('_')[1]}
                                </span>
                                {/* 实时状态徽章 */}
                                {hasRunningAudio && (
                                  <span className="text-[10px] font-medium text-blue-400 bg-blue-900/50 px-1.5 py-0.5 rounded animate-pulse flex items-center gap-1">
                                    <Loader2 size={10} className="animate-spin" />
                                    配音中
                                  </span>
                                )}
                                {!hasRunningAudio && hasRunningDh && (
                                  <span className="text-[10px] font-medium text-amber-400 bg-amber-900/50 px-1.5 py-0.5 rounded animate-pulse flex items-center gap-1">
                                    <Loader2 size={10} className="animate-spin" />
                                    数字人中
                                  </span>
                                )}
                                {allDhDone && !hasRunningAudio && !hasRunningDh && (
                                  <span className="text-[10px] font-medium text-green-400 bg-green-900/50 px-1.5 py-0.5 rounded">已完成</span>
                                )}
                                {anyDhError && !hasRunningAudio && !hasRunningDh && (
                                  <span className="text-[10px] font-medium text-red-400 bg-red-900/50 px-1.5 py-0.5 rounded">部分失败</span>
                                )}
                                {!hasRunningAudio && !hasRunningDh && !allAudioDone && !anyDhError && (
                                  <span className="text-[10px] font-medium text-gray-400 bg-gray-700/50 px-1.5 py-0.5 rounded">等待执行</span>
                                )}
                                <span className="text-xs text-gray-500">
                                  {session.segments.length}段 · {session.text.length}字
                                </span>
                              </div>
                              <button
                                onClick={() => setNewTaskSessions((prev) => prev.filter((s) => s.id !== session.id))}
                                className="text-gray-500 hover:text-red-400 p-1"
                                title="移除此任务"
                              >
                                <X size={14} />
                              </button>
                            </div>
                            {/* 独立任务段列表 */}
                            <div className="space-y-2">
                              {sessionSegTasks.map((task) => (
                                <div
                                  key={task.id}
                                  className="bg-gray-900/80 rounded-lg p-2.5 flex items-center gap-2"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 text-xs">
                                      <span className="text-gray-400 font-medium">段{task.index}</span>
                                      <span className="text-gray-600">{task.textLength || task.text.length}字</span>

                                      {/* 音频状态和播放按钮 */}
                                      {task.audioPhase === 'done' && task.audioUrl ? (
                                        <button
                                          onClick={() => {
                                            if (playingId === task.id) {
                                              audioRefs.current.get(task.id)?.pause();
                                              setPlayingId(null);
                                            } else {
                                              audioRefs.current.forEach((a) => a.pause());
                                              setPlayingId(task.id);
                                              const audio = new Audio(task.audioUrl!);
                                              audioRefs.current.set(task.id, audio);
                                              audio.onended = () => {
                                                setPlayingId(null);
                                                audioRefs.current.delete(task.id);
                                              };
                                              audio.play().catch(console.error);
                                            }
                                          }}
                                          className="ml-1 text-blue-400 hover:text-blue-300"
                                          title="试听"
                                        >
                                          {playingId === task.id ? <Pause size={12} /> : <Play size={12} />}
                                        </button>
                                      ) : (
                                        <span className="ml-1 text-gray-600">
                                          <PhaseIcon phase={task.audioPhase} />
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 mt-0.5">
                                      <span className="text-[10px] text-gray-600">
                                        配音:{' '}
                                        <span
                                          className={
                                            task.audioPhase === 'done'
                                              ? 'text-green-400'
                                              : task.audioPhase === 'error'
                                              ? 'text-red-400'
                                              : task.audioPhase === 'running'
                                              ? 'text-blue-400'
                                              : 'text-gray-500'
                                          }
                                        >
                                          {task.audioPhase === 'done'
                                            ? '✓'
                                            : task.audioPhase === 'error'
                                            ? '✗'
                                            : task.audioPhase === 'running'
                                            ? '…'
                                            : '○'}
                                        </span>
                                      </span>
                                      <span className="text-[10px] text-gray-600">
                                        数字人:{' '}
                                        <span
                                          className={
                                            task.dhPhase === 'done'
                                              ? 'text-green-400'
                                              : task.dhPhase === 'error'
                                              ? 'text-red-400'
                                              : task.dhPhase === 'running'
                                              ? 'text-blue-400'
                                              : 'text-gray-500'
                                          }
                                        >
                                          {task.dhPhase === 'done'
                                            ? '✓'
                                            : task.dhPhase === 'error'
                                            ? '✗'
                                            : task.dhPhase === 'running'
                                            ? '…'
                                            : '○'}
                                        </span>
                                      </span>
                                      {task.dhPhase === 'running' && task.dhStartMs && (
                                        <span className="text-[10px] text-blue-400 animate-pulse">
                                          {formatElapsed(Date.now() - task.dhStartMs)}
                                        </span>
                                      )}
                                      {task.dhPhase === 'error' && (
                                        <button
                                          onClick={() => {
                                            // 重试数字人
                                            const audioUrl = task.audioUrl || completedAudioUrlsRef.current.get(task.id);
                                            if (audioUrl) {
                                              generateSingleDh(task.id, audioUrl);
                                            }
                                          }}
                                          className="text-[10px] text-orange-400 hover:text-orange-300 ml-1"
                                        >
                                          重试
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-1 flex-shrink-0">
                                    {/* 下载按钮 */}
                                    {task.dhPhase === 'done' && task.dhVideoUrl && (
                                      <button
                                        onClick={() => {
                                          const a = document.createElement('a');
                                          a.href = task.dhVideoUrl!;
                                          a.download = `数字人对口型_${session.id.split('_')[1]}_段${task.index}.mp4`;
                                          a.target = '_blank';
                                          a.click();
                                        }}
                                        className="text-gray-500 hover:text-white p-1"
                                        title="下载"
                                      >
                                        <Download size={13} />
                                      </button>
                                    )}
                                    {/* 预览按钮 */}
                                    {task.dhVideoUrl && (
                                      <button
                                        onClick={() =>
                                          setPreviewVideo({
                                            url: task.dhVideoUrl!,
                                            name: `${session.id.split('_')[1]}_段${task.index}`,
                                          })
                                        }
                                        className="text-gray-500 hover:text-blue-400 p-1"
                                        title="预览"
                                      >
                                        <Video size={13} />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 日志面板 */}
          <div className="mx-6 mb-4 bg-gray-900 rounded-xl border border-gray-800">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
              <span className="text-xs font-medium text-gray-400 flex items-center gap-1.5">
                <Terminal size={12} />
                运行日志
              </span>
              <button
                onClick={() => setLogLines([])}
                className="text-xs text-gray-600 hover:text-gray-400"
              >
                清空
              </button>
            </div>
            <div
              className="h-[180px] overflow-y-auto px-4 py-2 font-mono text-xs space-y-0.5"
              style={{ lineHeight: '1.5' }}
            >
              {logLines.length === 0 ? (
                <p className="text-gray-700">等待操作…</p>
              ) : (
                logLines.map((line, i) => (
                  <p key={i} className="text-gray-400 whitespace-pre-wrap break-all">
                    {line}
                  </p>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </div>

      {/* 历史 Modal */}
      {showHistory && (
        <HistoryModal
          entries={historyEntries}
          onClose={() => setShowHistory(false)}
          onLoad={handleLoadHistory}
          onRemove={(ids) => {
            removeDhHistoryIds(ids);
            setHistoryEntries(loadDhHistory());
          }}
        />
      )}

      {/* 视频预览 Modal */}
      {previewVideo && (
        <VideoPreviewModal
          url={previewVideo.url}
          name={previewVideo.name}
          onClose={() => setPreviewVideo(null)}
        />
      )}

      {/* 视频库 Modal */}
      {showVideoLibrary && (
        <VideoLibraryModal
          onClose={() => setShowVideoLibrary(false)}
          onSelect={(item) => {
            handleSelectFromLibrary(item);
            setShowVideoLibrary(false);
          }}
          onDelete={(id) => {
            if (libraryVideoId === id) {
              setRefVideoFile(null);
              setRefVideoName('');
              setRefVideoRhPath('');
              setRefVideoUploadPct(0);
              setLibraryVideoId(null);
            }
          }}
        />
      )}

      {/* 语音库 Modal */}
      {showVoiceLibrary && (
        <VoiceLibrary
          onClose={() => setShowVoiceLibrary(false)}
          onVoicesChange={() => setVoiceEpoch((e) => e + 1)}
        />
      )}

      {/* 新建任务弹窗 */}
      {showNewTaskModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowNewTaskModal(false);
          }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Plus size={18} className="text-blue-400" />
                新建独立任务
              </h3>
              <button
                onClick={() => setShowNewTaskModal(false)}
                className="text-gray-400 hover:text-white"
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              <p className="text-sm text-gray-400">
                此任务将使用当前已选参考视频（{refVideoName || '未选择'}），独立执行不占用原任务槽位。
              </p>
              <textarea
                value={newTaskText}
                onChange={(e) => setNewTaskText(e.target.value)}
                placeholder="请输入全新的文案内容，支持中英文混合，系统将自动分割段落…"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500"
                rows={12}
                autoFocus
              />
              {newTaskText.trim() ? (() => {
                const { chunks } = splitTextByLanguage(newTaskText);
                return <p className="text-xs text-gray-500">将分割为 {chunks.length} 段 · {newTaskText.length} 字</p>;
              })() : null}
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-700">
              <button
                onClick={() => {
                  setShowNewTaskModal(false);
                  setNewTaskText('');
                }}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreateNewSession}
                disabled={!newTaskText.trim()}
                className="px-5 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-colors"
              >
                创建任务
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
