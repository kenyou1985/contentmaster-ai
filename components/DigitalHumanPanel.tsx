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
  dhConcurrency,
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

  // --- Refs ---
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const tasksRef = useRef(tasks);
  const pollingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const oneClickRef = useRef<'idle' | 'audio' | 'dh' | 'done'>('idle');
  const genAudioRef = useRef<((taskId: string) => Promise<void>) | null>(null);
  const genDhRef = useRef<((taskId: string) => Promise<void>) | null>(null);

  // Keep tasksRef in sync
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    oneClickRef.current = oneClickFilm;
  }, [oneClickFilm]);

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
    [pushLog, refVideoName]
  );

  // ============================================================
  // 单段配音
  // ============================================================
  const generateSingleAudio = useCallback(
    async (taskId: string) => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task) {
        console.error(`[配音] 段未找到: ${taskId}`);
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
    async (taskId: string) => {
      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task) {
        console.error(`[数字人] 段未找到: ${taskId}`);
        return;
      }

      if (!task.audioUrl) {
        console.error(`[数字人] 段${task.index} 无音频URL，无法生成数字人`);
        toast.error(`段${task.index} 请先完成配音`);
        return;
      }

      if (!refVideoRhPath) {
        console.error(`[数字人] 无参考视频路径，无法生成数字人`);
        toast.error('请先上传参考视频');
        return;
      }

      if (task.dhPhase === 'running') return;

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, dhPhase: 'running' as const, dhStartMs: Date.now(), dhError: undefined }
            : t
        )
      );

      pushLog(`[段${task.index} 数字人] 提交任务…`);
      console.log(`[数字人] 段${task.index} 开始, audioUrl: ${task.audioUrl?.slice(0, 80)}, refVideoPath: ${refVideoRhPath}`);

      try {
        const taskId_ = await dhConcurrency.run(async () => {
          const tid = await submitDigitalHumanTask(runningHubApiKey, {
            referenceVideoPath: refVideoRhPath,
            audioPath: task.audioUrl!.replace(/^https:\/\/www\.runninghub\.cn/, '').replace(/^\//, ''),
          });
          console.log(`[数字人] 段${task.index} 提交成功, taskId: ${tid?.slice(0, 16)}`);
          pushLog(`[段${task.index} 数字人] taskId: ${tid?.slice(0, 16)}…`);

          const videoUrl = await pollDigitalHumanUntilDone(runningHubApiKey, tid, (stage, elapsed) => {
            if (elapsed % 30 === 0) {
              pushLog(`[段${task.index} 数字人] 轮询中 ${elapsed}s…`);
            }
          });

          console.log(`[数字人] 段${task.index} 轮询完成, videoUrl: ${videoUrl?.slice(0, 80)}`);
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
        if (dhSessionId) {
          const dhMs = task.dhStartMs ? Date.now() - task.dhStartMs : undefined;
          updateDhSegmentVideo(dhSessionId, task.index, taskId_, dhMs);
        }
        pushLog(`[段${task.index} 数字人] ✅ 完成`);
      } catch (err: any) {
        console.error(`[数字人] 段${task.index} 异常:`, err);
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, dhPhase: 'error' as const, dhError: err.message }
              : t
          )
        );
        if (dhSessionId) {
          updateDhSegmentVideo(dhSessionId, task.index, '', undefined, err.message);
        }
        pushLog(`[段${task.index} 数字人] ❌ 失败: ${err.message}`);
        toast.error(`段${task.index} 数字人失败: ${err.message}`);
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

    const ready = tasks.filter((t) => t.audioPhase === 'done' && t.dhPhase === 'pending');
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

    pushLog(`[打包下载] 打包 ${selected.length} 个视频…`);
    try {
      const blob = await packVideosToZip(
        selected.map((t) => ({
          url: t.dhVideoUrl!,
          filename: `段${t.index}.mp4`,
        }))
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `数字人对口型视频_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`打包下载成功: ${selected.length} 个视频`);
    } catch (err: any) {
      toast.error(`打包失败: ${err.message}`);
    }
  }, [tasks, selectedIds, handleDownloadSingle, toast, pushLog]);

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

    pushLog(`[打包下载] 打包 ${done.length} 个视频…`);
    try {
      const blob = await packVideosToZip(
        done.map((t) => ({
          url: t.dhVideoUrl!,
          filename: `段${t.index}.mp4`,
        }))
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `数字人对口型视频_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`打包下载成功: ${done.length} 个视频`);
    } catch (err: any) {
      toast.error(`打包失败: ${err.message}`);
    }
  }, [tasks, handleDownloadSingle, toast, pushLog]);

  // ============================================================
  // 一键成片：配音 → 数字人 → 下载
  // ============================================================
  const handleOneClickFilm = useCallback(async () => {
    if (!runningHubApiKey.trim()) {
      toast.error('请先配置 RunningHub API Key');
      return;
    }
    if (!refVideoRhPath) {
      toast.error('请先上传参考视频');
      return;
    }

    const pending = tasks.filter((t) => t.audioPhase === 'pending');
    console.log('[一键成片] pending tasks:', pending.length);
    pushLog(`[一键成片] 检查待配音段落: ${pending.length} 个`);
    if (pending.length === 0) {
      toast.warning('没有待配音的段落');
      return;
    }

    const pendingIds = pending.map((t) => t.id);
    // 必须先同步更新 ref，再创建 workers，避免 workers 一创建就检测到 idle 退出
    oneClickRef.current = 'audio';
    setOneClickFilm('audio');
    pushLog(`[一键成片] 开始… 阶段① 批量配音 ${pending.length} 段`);

    // Phase 1: 批量配音
    const queue = [...pending];
    const workers = Array.from({ length: Math.min(queue.length, MAX_CONCURRENT) }, () => {
      const worker = async () => {
        while (queue.length > 0) {
          if (oneClickRef.current === 'idle') {
            console.log('[一键成片] worker 检测到 oneClickFilm==idle，提前退出');
            return;
          }
          const task = queue.shift()!;
          console.log(`[一键成片] worker 开始处理段${task.index} (${task.id})`);
          try {
            await generateSingleAudio(task.id);
            console.log(`[一键成片] worker 段${task.index} 配音完成`);
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
    const afterAudio = tasksRef.current;
    const failedAudio = afterAudio.filter(
      (t) => t.audioPhase !== 'done' && pendingIds.includes(t.id)
    );
    const doneAudio = afterAudio.filter(
      (t) => t.audioPhase === 'done' && pendingIds.includes(t.id)
    );
    console.log(`[一键成片] Phase1 结果: 成功 ${doneAudio.length}, 失败 ${failedAudio.length}`);
    failedAudio.forEach((t) => {
      pushLog(`[一键成片] ⚠️ 段${t.index} 配音失败: ${t.audioError || '未知错误'}`);
      console.error(`[一键成片] 段${t.index} 失败详情:`, t.audioError);
    });

    if (failedAudio.length > 0) {
      pushLog(`[一键成片] ⚠️ ${failedAudio.length} 段配音失败，跳过数字人阶段`);
      toast.warning(`${failedAudio.length} 段配音失败，一键成片中断`);
      setOneClickFilm('idle');
      return;
    }

    pushLog(`[一键成片] 阶段① 完成 → 阶段② 批量数字人`);
    oneClickRef.current = 'dh';
    setOneClickFilm('dh');

    // Phase 2: 批量数字人
    const ready = tasksRef.current.filter((t) => t.audioPhase === 'done' && t.dhPhase === 'pending');
    const readyIds = ready.map((t) => t.id);
    console.log(`[一键成片] Phase2 待处理: ${ready.length} 段`);
    pushLog(`[一键成片] 阶段② 开始批量数字人: ${ready.length} 段`);
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
            await generateSingleDh(task.id);
            console.log(`[一键成片] dh worker 段${task.index} 完成`);
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

    const done = tasksRef.current.filter((t) => t.dhPhase === 'done' && t.dhVideoUrl);
    const failedDh = tasksRef.current.filter((t) => t.dhPhase === 'error' && readyIds.includes(t.id));
    console.log(`[一键成片] Phase2 结果: 成功 ${done.length}, 失败 ${failedDh.length}`);
    failedDh.forEach((t) => {
      pushLog(`[一键成片] ⚠️ 段${t.index} 数字人失败: ${t.dhError || '未知错误'}`);
      console.error(`[一键成片] 段${t.index} DH 失败详情:`, t.dhError);
    });

    pushLog(`[一键成片] 阶段② 完成 → 开始下载 ZIP`);
    setOneClickFilm('done');

    // Phase 3: 打包下载
    if (done.length === 0) {
      toast.warning('数字人全部失败，无视频可下载');
      setOneClickFilm('idle');
      return;
    }

    pushLog(`[一键成片] 打包 ${done.length} 个视频…`);
    try {
      const blob = await packVideosToZip(
        done.map((t) => ({
          url: t.dhVideoUrl!,
          filename: `段${t.index}.mp4`,
        }))
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `数字人对口型_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      pushLog(`[一键成片] ✅ 全部完成 · ${done.length} 个视频已下载`);
      toast.success(`一键成片完成: ${done.length} 个视频已打包下载`);
    } catch (err: any) {
      toast.error(`打包失败: ${err.message}`);
    }
    setOneClickFilm('idle');
  }, [
    runningHubApiKey,
    refVideoRhPath,
    toast,
    pushLog,
    dhSessionId,
    generateSingleAudio,
    generateSingleDh,
  ]);

  // ============================================================
  // 历史记录
  // ============================================================
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
                  {segments.length > 0 && (
                    <span className="text-xs text-gray-500">
                      {segments.length} 段 · {scriptText.length} 字
                    </span>
                  )}
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
                      tasks.filter((t) => t.audioPhase === 'done' && t.dhPhase === 'pending')
                        .length === 0
                    }
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Film size={16} />
                    批量生成数字人
                    {tasks.filter((t) => t.audioPhase === 'done' && t.dhPhase === 'pending')
                      .length > 0 && (
                      <span className="text-xs opacity-70">
                        (
                        {
                          tasks.filter(
                            (t) => t.audioPhase === 'done' && t.dhPhase === 'pending'
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

                  {/* 一键成片 */}
                  <button
                    onClick={handleOneClickFilm}
                    disabled={
                      oneClickFilm !== 'idle' ||
                      tasks.filter((t) => t.audioPhase === 'pending').length === 0
                    }
                    className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
                      oneClickFilm !== 'idle'
                        ? oneClickFilm === 'audio'
                          ? 'bg-blue-600/60 cursor-not-allowed animate-pulse'
                          : oneClickFilm === 'dh'
                          ? 'bg-green-600/60 cursor-not-allowed animate-pulse'
                          : 'bg-emerald-600/60 cursor-not-allowed'
                        : 'bg-gradient-to-r from-blue-600 via-purple-600 to-emerald-600 hover:from-blue-500 hover:via-purple-500 hover:to-emerald-500 disabled:from-gray-700 disabled:via-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed shadow-lg shadow-purple-500/20'
                    } text-white`}
                  >
                    {oneClickFilm === 'idle' && <Film size={18} />}
                    {oneClickFilm === 'audio' && <Mic size={18} />}
                    {oneClickFilm === 'dh' && <Film size={18} />}
                    {oneClickFilm === 'done' && <Download size={18} />}
                    {oneClickFilm === 'idle' && '一键成片'}
                    {oneClickFilm === 'audio' && `配音中…`}
                    {oneClickFilm === 'dh' && `数字人中…`}
                    {oneClickFilm === 'done' && `完成!`}
                  </button>
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
    </div>
  );
}
