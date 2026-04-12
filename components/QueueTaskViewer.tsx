import React, { useState, useEffect } from 'react';
import { Clock, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';

/**
 * 挂机队列任务查看器（独立窗口）
 * 通过 URL 参数 ?taskId=xxx 打开，从 localStorage 读取任务数据并展示。
 * 不支持编辑，仅展示该任务的快照内容（镜头列表、图片、视频、配音等）。
 */

interface Shot {
  id: string;
  number: number;
  caption?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  videoUrl?: string;
  cachedVideoUrls?: string[];
  cachedVideoUrl?: string;
  selectedVideoIndex?: number;
  selectedImageIndex?: number;
  voiceoverAudioUrl?: string;
}

interface OneClickTaskSnapshot {
  shots: unknown[];
  scriptText: string;
  selectedImageModel: string;
  selectedImageRatio: string;
  selectedStyle: string;
  selectedVideoModel: string;
  selectedVideoSize: string;
  selectedVideoDuration: number;
  selectedVideoOrientation: string;
  generateImageCount: number;
  jianyingOutputDir: string;
  jyRandomEffectBundle: boolean;
  jyRandomTransitions: boolean;
  jyRandomFilters: boolean;
  jimengApiUrl: string;
  jimengSessionId: string;
}

interface OneClickQueueTask {
  id: string;
  draftName: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  exportMode: 'full' | 'image_audio';
  priority: number;
  paused: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  lastError?: string;
  progressNote?: string;
  progressPercent?: number;  // 0-100
  snapshot: OneClickTaskSnapshot;
  resultSnapshot?: OneClickTaskSnapshot;
  lastExportedDraftName?: string;
}

const STORAGE_KEY = 'contentmaster_one_click_queue_v1';

function loadQueue(): OneClickQueueTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return (v?.tasks ?? []).map((t: OneClickQueueTask) => ({
      ...t,
      draftName: t.draftName || t.label || `任务_${t.id.slice(0, 12)}`,
    }));
  } catch {
    return [];
  }
}

function persistedShotToShot(s: unknown): Shot {
  const o = s as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    number: Number(o.number ?? 0),
    caption: String(o.caption ?? ''),
    imageUrls: Array.isArray(o.imageUrls) ? (o.imageUrls as string[]) : undefined,
    videoUrls: Array.isArray(o.videoUrls) ? (o.videoUrls as string[]) : undefined,
    videoUrl: o.videoUrl ? String(o.videoUrl) : undefined,
    cachedVideoUrls: Array.isArray(o.cachedVideoUrls) ? (o.cachedVideoUrls as string[]) : undefined,
    cachedVideoUrl: o.cachedVideoUrl ? String(o.cachedVideoUrl) : undefined,
    selectedVideoIndex: o.selectedVideoIndex != null ? Number(o.selectedVideoIndex) : undefined,
    selectedImageIndex: o.selectedImageIndex != null ? Number(o.selectedImageIndex) : undefined,
    voiceoverAudioUrl: o.voiceoverAudioUrl ? String(o.voiceoverAudioUrl) : undefined,
  };
}

const StatusBadge: React.FC<{ status: OneClickQueueTask['status'] }> = ({ status }) => {
  const configs: Record<OneClickQueueTask['status'], { cls: string; label: string; icon: React.ReactNode }> = {
    completed: { cls: 'bg-emerald-500/20 text-emerald-300', label: '已完成', icon: <CheckCircle2 size={12} /> },
    running: { cls: 'bg-amber-500/20 text-amber-300', label: '执行中', icon: <Loader2 size={12} className="animate-spin" /> },
    failed: { cls: 'bg-red-500/20 text-red-300', label: '失败', icon: <XCircle size={12} /> },
    cancelled: { cls: 'bg-slate-500/20 text-slate-400', label: '已取消', icon: <XCircle size={12} /> },
    pending: { cls: 'bg-slate-600/40 text-slate-300', label: '等待中', icon: <Clock size={12} /> },
  };
  const c = configs[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.cls}`}>
      {c.icon}
      {c.label}
    </span>
  );
};

const ShotCard: React.FC<{ shot: Shot; index: number }> = ({ shot, index }) => {
  const [expanded, setExpanded] = useState(false);
  const [enlargedImg, setEnlargedImg] = useState<string | null>(null);
  const [enlargedVideo, setEnlargedVideo] = useState<string | null>(null);

  const videoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
  const cachedVideoUrls = shot.cachedVideoUrls || (shot.cachedVideoUrl ? [shot.cachedVideoUrl] : []);
  const n = videoUrls.length;
  const effectiveIdx = shot.selectedVideoIndex !== undefined && shot.selectedVideoIndex >= 0 && shot.selectedVideoIndex < n
    ? shot.selectedVideoIndex
    : n - 1;
  const activeVideoUrl = n > 0 ? (cachedVideoUrls[effectiveIdx] || videoUrls[effectiveIdx]) : null;

  const imageUrls = shot.imageUrls || [];
  const imgIdx = shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0;
  const activeImg = imageUrls[imgIdx];

  const hasVideo = n > 0 && !!activeVideoUrl;
  const hasImage = !!activeImg;

  return (
    <>
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-3">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 bg-slate-700 rounded-full flex items-center justify-center text-slate-300 text-sm font-bold">
            {shot.number}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-slate-200 text-sm line-clamp-2">{shot.caption || <span className="text-slate-500 italic">无文案</span>}</p>
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex-shrink-0 text-slate-500 hover:text-slate-300"
              >
                {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>

            <div className="flex gap-2 flex-wrap">
              {hasImage && (
                <div className="relative w-24 h-24 bg-slate-900 rounded overflow-hidden cursor-pointer group"
                  onClick={() => setEnlargedImg(activeImg)}
                >
                  <img src={activeImg} alt="" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <ExternalLink size={16} className="text-white" />
                  </div>
                  {shot.selectedImageIndex !== undefined && imageUrls.length > 1 && (
                    <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[9px] px-1 rounded">
                      {imgIdx + 1}/{imageUrls.length}
                    </div>
                  )}
                </div>
              )}
              {hasVideo && (
                <div className="relative w-24 h-24 bg-slate-900 rounded overflow-hidden cursor-pointer group"
                  onClick={() => setEnlargedVideo(activeVideoUrl!)}
                >
                  <video src={activeVideoUrl!} className="w-full h-full object-cover" muted preload="metadata" />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <ExternalLink size={16} className="text-white" />
                  </div>
                  <div className="absolute bottom-1 right-1 bg-black/60 text-white text-[9px] px-1 rounded flex items-center gap-0.5">
                    <span className="inline-block w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
                    视频
                  </div>
                  {n > 1 && (
                    <div className="absolute top-1 left-1 bg-black/60 text-white text-[9px] px-1 rounded">
                      {effectiveIdx + 1}/{n}
                    </div>
                  )}
                </div>
              )}
              {!hasImage && !hasVideo && (
                <div className="w-24 h-24 bg-slate-900 rounded border border-slate-700 flex items-center justify-center">
                  <span className="text-slate-600 text-xs">无媒体</span>
                </div>
              )}
            </div>

            {expanded && (
              <div className="mt-2 space-y-1 text-xs text-slate-400">
                <div>📷 图片: {hasImage ? `${imageUrls.length} 张` : '无'}{shot.selectedImageIndex !== undefined ? ` (已选第 ${shot.selectedImageIndex + 1} 张)` : ''}</div>
                <div>🎬 视频: {hasVideo ? `${n} 个` : '无'}{shot.selectedVideoIndex !== undefined && n > 0 ? ` (已选第 ${shot.selectedVideoIndex + 1} 个)` : ''}</div>
                {shot.voiceoverAudioUrl && (
                  <div>🎙️ 配音: 已生成</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 图片放大 */}
      {enlargedImg && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setEnlargedImg(null)}
        >
          <div className="relative max-w-4xl">
            <img src={enlargedImg} alt="" className="max-w-full max-h-[85vh] rounded-lg" onClick={e => e.stopPropagation()} />
            <button onClick={() => setEnlargedImg(null)} className="absolute top-2 right-2 bg-slate-800 hover:bg-slate-700 text-white rounded-full p-2">
              ✕
            </button>
          </div>
        </div>
      )}

      {/* 视频放大 */}
      {enlargedVideo && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
          onClick={() => setEnlargedVideo(null)}
        >
          <div className="relative max-w-4xl w-full" onClick={e => e.stopPropagation()}>
            <video src={enlargedVideo!} controls autoPlay className="w-full max-h-[85vh] rounded-lg" />
            <button onClick={() => setEnlargedVideo(null)} className="absolute top-2 right-2 bg-slate-800 hover:bg-slate-700 text-white rounded-full p-2">
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const QueueTaskViewer: React.FC = () => {
  // 支持两种 URL 格式：?queueTaskView=xxx 或 ?taskId=xxx
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get('queueTaskView') || params.get('taskId');

  const [task, setTask] = useState<OneClickQueueTask | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<'入队' | '成片结果'>('入队');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!taskId) {
      setLoading(false);
      return;
    }
    const all = loadQueue();
    const found = all.find(t => t.id === taskId);
    setTask(found ?? null);
    setLoading(false);
  }, [taskId]);

  /** 旧数据「已完成」但无 resultSnapshot 时，默认看入队快照，避免成片结果页空白 */
  useEffect(() => {
    if (!task) return;
    const rs = task.resultSnapshot;
    const hasResult =
      rs && Array.isArray(rs.shots) && (rs.shots as unknown[]).length > 0;
    setActiveSnapshot(hasResult ? '成片结果' : '入队');
  }, [task?.id, task?.updatedAt]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400">
        <Loader2 size={24} className="animate-spin mr-2" /> 加载中…
      </div>
    );
  }

  if (!taskId) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-4 p-8">
        <h1 className="text-xl font-bold text-slate-200">缺少任务 ID 参数</h1>
        <p className="text-sm">请通过「查看任务」按钮打开此页面</p>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-4 p-8">
        <h1 className="text-xl font-bold text-slate-200">任务未找到</h1>
        <p className="text-sm">任务可能已被删除或过期</p>
        <p className="text-xs text-slate-600 font-mono">ID: {taskId}</p>
      </div>
    );
  }

  const effectiveSnap =
    activeSnapshot === '成片结果'
      ? task.resultSnapshot &&
          Array.isArray(task.resultSnapshot.shots) &&
          task.resultSnapshot.shots.length > 0
        ? task.resultSnapshot
        : task.snapshot
      : task.snapshot;
  const shots: Shot[] = effectiveSnap?.shots?.map(persistedShotToShot) ?? [];
  const snap = effectiveSnap;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <div className="bg-slate-900 border-b border-slate-700 px-6 py-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-lg font-bold text-emerald-400">📁 {task.draftName}</h1>
            <StatusBadge status={task.status} />
          </div>
          {task.progressPercent !== undefined && (
            <div className="flex items-center gap-2 mb-2">
              <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    task.status === 'failed' ? 'bg-red-500' :
                    task.status === 'completed' ? 'bg-emerald-500' :
                    task.status === 'running' ? 'bg-amber-500 animate-pulse' :
                    'bg-blue-500'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, Math.round(task.progressPercent)))}%` }}
                />
              </div>
              <span className="text-xs text-slate-400 font-medium tabular-nums w-12 text-right">
                {Math.min(100, Math.max(0, Math.round(task.progressPercent)))}%
              </span>
            </div>
          )}
          <div className="text-xs text-slate-500 space-y-0.5">
            <div>创建时间: {new Date(task.createdAt).toLocaleString('zh-CN')}</div>
            <div>更新时间: {new Date(task.updatedAt).toLocaleString('zh-CN')}</div>
            <div>导出模式: {task.exportMode === 'full' ? '全部（图片+配音+视频）' : '仅图片+配音'}</div>
            {task.lastError && <div className="text-red-400">错误: {task.lastError}</div>}
            {task.lastExportedDraftName && <div className="text-emerald-400">上次导出: {task.lastExportedDraftName}</div>}
          </div>
        </div>
      </div>

      {/* Snapshot selector */}
      <div className="max-w-4xl mx-auto px-6 py-4">
        <div className="flex gap-2 mb-4 flex-wrap items-center">
          <button
            type="button"
            onClick={() => setActiveSnapshot('成片结果')}
            disabled={
              !task.resultSnapshot ||
              !Array.isArray(task.resultSnapshot.shots) ||
              task.resultSnapshot.shots.length === 0
            }
            className={`px-3 py-1.5 rounded text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
              activeSnapshot === '成片结果'
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
            title={
              task.resultSnapshot && task.resultSnapshot.shots?.length
                ? '任务完成时写入的媒体快照'
                : '暂无成片快照（例如旧版任务或未完成），已自动回退入队数据'
            }
          >
            📊 成片结果
          </button>
          <button
            type="button"
            onClick={() => setActiveSnapshot('入队')}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-all ${
              activeSnapshot === '入队'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            📥 入队快照
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-slate-800 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-emerald-400">{shots.length}</div>
            <div className="text-xs text-slate-500">镜头数</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-purple-400">{shots.filter(s => s.videoUrls?.length || s.videoUrl).length}</div>
            <div className="text-xs text-slate-500">有视频</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-blue-400">{shots.filter(s => s.imageUrls?.length).length}</div>
            <div className="text-xs text-slate-500">有图片</div>
          </div>
        </div>
        {/* 进度条（如果有） */}
        {task.progressPercent !== undefined && (
          <div className="bg-slate-800 rounded-lg p-3 mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-400">生成进度</span>
              <span className="text-sm font-bold text-emerald-400">
                {Math.min(100, Math.max(0, Math.round(task.progressPercent)))}%
              </span>
            </div>
            <div className="h-3 bg-slate-900 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  task.status === 'failed' ? 'bg-red-500' :
                  task.status === 'completed' ? 'bg-emerald-500' :
                  task.status === 'running' ? 'bg-amber-500' :
                  'bg-blue-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, Math.round(task.progressPercent)))}%` }}
              />
            </div>
            {task.progressNote && (
              <div className="mt-1 text-xs text-slate-500 truncate">{task.progressNote}</div>
            )}
          </div>
        )}

        {/* Script preview */}
        {snap?.scriptText && (
          <details className="mb-4 bg-slate-800/50 border border-slate-700 rounded-lg">
            <summary className="px-4 py-2 text-sm text-slate-400 cursor-pointer hover:text-slate-300">
              📝 脚本预览（{snap.scriptText.length} 字）
            </summary>
            <pre className="px-4 pb-4 text-xs text-slate-400 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {snap.scriptText}
            </pre>
          </details>
        )}

        {/* Shots */}
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-300">分镜列表</h2>
          {shots.length === 0 ? (
            <p className="text-slate-600 text-sm py-4 text-center">无分镜数据</p>
          ) : (
            shots.map((shot, i) => (
              <ShotCard key={shot.id || i} shot={shot} index={i} />
            ))
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-slate-800 mt-8 pt-4 pb-6 text-center text-xs text-slate-600">
        ContentMaster · 挂机队列任务查看器 · {new Date().toLocaleDateString('zh-CN')}
      </div>
    </div>
  );
};

export default QueueTaskViewer;
