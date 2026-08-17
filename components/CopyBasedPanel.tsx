/**
 * 文案成片主面板（v1.2）
 *
 * 流程：
 * 1. 用户输入文案 → 点击「智能解析」
 * 2. AI 返回 3 套「标题+封面提示词+人物信息」方案
 * 3. 用户可勾选 1~3 套 → 上传角色参考图（可选）
 * 4. 点击「批量生成封面」→ 同时为每套方案生成封面图（多选对比）
 *    - 已生成且「锁定」的封面将保留，不会重复生成
 * 5. 封面标题支持复制 + 实时编辑（编辑后重生成时使用新标题）
 * 6. 封面提示词采用「白/黄/红/绿」+ 关键词加粗放大的多色文字特效
 * 7. 从已生成封面中挑一个作为最终选择
 * 8. 点击「5 段并行配音」→ 复用多镜头分镜的语音库（VoiceLibraryService）
 * 9. 点击「导出 MP4」→ 迁移 Remotion 导出配置 → renderRemotionVideo 出 MP4
 *
 * v1.2 新增：
 * - 已生成封面保留勾选框（不再覆盖）
 * - 标题可复制 + 可编辑（实时同步到封面提示词）
 * - 封面提示词强化：白/黄/红/绿配色 + 关键词加粗放大
 * - 复用多镜头分镜的语音库
 * - MP4 导出功能开放（Remotion 渲染）
 * - Remotion 导出设置（模板/分辨率/字幕/转场/运动）从多镜头分镜迁移
 * - 页面切换保留生成内容（localStorage 持久化：rawCopy、parsed titles、
 *   generated covers、finalCover、ttsResult、editedTitles）
 */

import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
// v1.10：module-level cache 解决切走 sub-tab 再回来大块数据丢失
import { copyBasedCache } from './copyBasedCache';
import {
  Sparkles,
  Loader2,
  Wand2,
  Image as ImageIcon,
  Mic,
  Square,
  Check,
  Upload,
  AlertCircle,
  Download,
  Film,
  X,
  Zap,
  Terminal,
  Trash2,
  Copy as CopyIcon,
  Lock,
  Unlock,
  Edit3,
  Save,
  Settings as SettingsIcon,
  Volume2,
  Music,
  Filter,
  Palette,
} from 'lucide-react';
import { useToast } from './Toast';
import { VoiceLibrary } from './VoiceLibrary';
import { generateImage } from '../services/yunwuService';
import {
  analyzeCopyWithLlm,
  type CopyAnalysisResult,
  type CopyTitleOption,
  type CopyCharacterInfo,
} from '../services/copyAnalysisService';
import { runParallelTts, type ParallelTtsProgress, type ParallelTtsResult } from '../services/copyParallelTtsService';
import { COPY_ANALYSIS_PROMPT } from '../constants';
import { getSelectedVoice, updateVoice, type VoiceProfile } from '../services/voiceLibraryService';
import {
  renderRemotionVideo,
  checkRemotionHealth,
  getRemotionApiBase,
  buildRemotionUrl,
} from '../services/remotionExportService';
import { uploadAudioToRunningHub } from '../services/runninghubService';
import {
  cacheLocalBgm,
  listCachedBgm,
  removeCachedBgm,
  clearCachedBgm,
  type BgmCacheEntry,
} from '../services/bgmUploadService';
import { transcribeShots } from '../services/localAsrService';
import type {
  RemotionExportConfig,
  RemotionShot,
  SubtitleCue,
} from '../services/remotionRenderTypes';
// v1.10：复用 remotion 模块的字幕切分工具（支持 sentence/word/none 三种模式）
import { buildSubtitleCues } from '../remotion/src/compositions/subtitleCues';

const SCRIPT_MAX_LEN = 8000; // 文案成片文案上限

// ── 人物勾选工具 ───────────────────────────
/**
 * 根据 N 套标题，提取「标题中提到的人物」名字集合
 *  - 输入：标题数组 + 全人物列表
 *  - 输出：按人物出现顺序去重后的名字列表（用于默认勾选）
 *  - 匹配规则：标题中包含 c.name（trim 后非空）
 *  - 兜底：若所有标题都没提到任何人名，则默认勾选前 2 位（确保至少有人参与封面）
 */
function pickCharactersMentionedInTitles(
  titles: string[],
  characters: Array<{ name: string }>
): string[] {
  const mentioned: string[] = [];
  const seen = new Set<string>();
  // 用所有标题拼接成一个查找源，覆盖 6 套方案不同角度
  const source = titles.filter(Boolean).join('|');
  if (!source) return [];

  for (const c of characters) {
    const name = (c.name || '').trim();
    if (!name) continue;
    // 直接子串匹配（人名多为 2-4 字）
    if (source.includes(name)) {
      if (!seen.has(name)) {
        seen.add(name);
        mentioned.push(name);
      }
    }
  }

  // 兜底：若所有标题都未命中任何人物名，默认勾选前 2 位
  if (mentioned.length === 0) {
    for (const c of characters.slice(0, 2)) {
      const name = (c.name || '').trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        mentioned.push(name);
      }
    }
  }
  return mentioned;
}

// ── 封面比例（与 CoverDesign.tsx 的 COVER_ASPECT_OPTIONS 完全对齐） ───
const COVER_RATIOS = [
  { id: '16:9', label: '16:9 横屏', w: 1920, h: 1080 },
  { id: '9:16', label: '9:16 竖屏', w: 1080, h: 1920 },
  { id: '1:1', label: '1:1 方图', w: 1080, h: 1080 },
  { id: '4:3', label: '4:3 标屏', w: 1440, h: 1080 },
  { id: '3:4', label: '3:4 海报', w: 1080, h: 1440 },
] as const;

// Tailwind aspect ratio class（用于封面图容器，匹配生图尺寸）
const COVER_RATIO_CLASSES: Record<string, string> = {
  '16:9': 'aspect-video',
  '9:16': 'aspect-[9/16]',
  '1:1': 'aspect-square',
  '4:3': 'aspect-[4/3]',
  '3:4': 'aspect-[3/4]',
};

type CoverRatioId = (typeof COVER_RATIOS)[number]['id'];

// ── Remotion 模板（与 services/remotionTemplates.ts 对齐，共 10 种） ────────
type RemotionTemplateId =
  | 'landscape_default'
  | 'vertical_default'
  | 'square_default'
  | 'cinema_wide'
  | 'reels'
  | 'tiktok'
  | 'youtube_shorts'
  | 'documentary_warm'
  | 'magazine'
  | 'chinese_ink';

interface RemotionTemplateInfo {
  id: RemotionTemplateId;
  name: string;
  resolution: '1280x720' | '1920x1080' | '1080x1920' | '1080x1080' | '2560x1080' | '3840x2160';
  defaultFontSize: number;
  defaultColor: string;
  fontFamily: string;
  defaultSubtitlePosition: 'top' | 'middle' | 'bottom';
  fontSizeScale: number;
  recommendedMotion: 'kenBurns' | 'kenBurnsStrong' | 'kenBurnsSlow' | 'zoomIn' | 'push';
}

const REMOTION_TEMPLATES: RemotionTemplateInfo[] = [
  {
    id: 'landscape_default',
    name: '横屏默认（1920×1080）',
    resolution: '1920x1080',
    defaultFontSize: 48,
    defaultColor: '#ffffff',
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.0,
    recommendedMotion: 'kenBurns',
  },
  {
    id: 'vertical_default',
    name: '竖屏默认（1080×1920）',
    resolution: '1080x1920',
    defaultFontSize: 56,
    defaultColor: '#ffffff',
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
    defaultSubtitlePosition: 'middle',
    fontSizeScale: 1.25,
    recommendedMotion: 'kenBurns',
  },
  {
    id: 'square_default',
    name: '方形（1080×1080）',
    resolution: '1080x1080',
    defaultFontSize: 50,
    defaultColor: '#ffffff',
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.05,
    recommendedMotion: 'kenBurns',
  },
  {
    id: 'cinema_wide',
    name: '电影宽幅（2560×1080）',
    resolution: '2560x1080',
    defaultFontSize: 52,
    defaultColor: '#fcd34d',
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.05,
    recommendedMotion: 'kenBurnsSlow',
  },
  {
    id: 'reels',
    name: 'Instagram Reels（1080×1920）',
    resolution: '1080x1920',
    defaultFontSize: 60,
    defaultColor: '#ffffff',
    fontFamily: '"Inter","Helvetica Neue","PingFang SC",sans-serif',
    defaultSubtitlePosition: 'middle',
    fontSizeScale: 1.3,
    recommendedMotion: 'kenBurnsStrong',
  },
  {
    id: 'tiktok',
    name: 'TikTok（1080×1920）',
    resolution: '1080x1920',
    defaultFontSize: 62,
    defaultColor: '#ffffff',
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
    defaultSubtitlePosition: 'middle',
    fontSizeScale: 1.35,
    recommendedMotion: 'kenBurnsStrong',
  },
  {
    id: 'youtube_shorts',
    name: 'YouTube Shorts（1080×1920）',
    resolution: '1080x1920',
    defaultFontSize: 60,
    defaultColor: '#ffe600',
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
    defaultSubtitlePosition: 'middle',
    fontSizeScale: 1.30,
    recommendedMotion: 'push',
  },
  {
    id: 'documentary_warm',
    name: '纪录片暖调（1920×1080）',
    resolution: '1920x1080',
    defaultFontSize: 50,
    defaultColor: '#fef3c7',
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.05,
    recommendedMotion: 'kenBurnsSlow',
  },
  {
    id: 'magazine',
    name: '杂志感（1080×1080）',
    resolution: '1080x1080',
    defaultFontSize: 52,
    defaultColor: '#ffffff',
    fontFamily: '"Helvetica Neue","PingFang SC",sans-serif',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.05,
    recommendedMotion: 'kenBurns',
  },
  {
    id: 'chinese_ink',
    name: '国风水墨（1920×1080）',
    resolution: '1920x1080',
    defaultFontSize: 50,
    defaultColor: '#f8f4e3',
    fontFamily: '"STKaiti","KaiTi","Songti SC",serif',
    defaultSubtitlePosition: 'bottom',
    fontSizeScale: 1.0,
    recommendedMotion: 'kenBurnsSlow',
  },
];

const SUBTITLE_STYLES = [
  { id: 'default', label: '经典（单色描边）' },
  { id: 'stroke', label: '强描边（多色字）' },
  { id: 'tiktok', label: 'TikTok 双色' },
  { id: 'karaoke', label: '卡拉 OK' },
] as const;

type SubtitleStyleId = (typeof SUBTITLE_STYLES)[number]['id'];

// ── 持久化 ───────────────────────────
const STORAGE_KEY = 'COPY_BASED_STATE_V1_4';

interface PersistedState {
  rawCopy: string;
  editedTitles: Record<number, string>; // 用户编辑后的标题
  lockedCoverIndices: number[]; // 锁定的封面索引（不重新生成）
  coverRatio: CoverRatioId;
  selectedIndices: number[];
  finalCoverIndex: number | null;
  selectedVoiceId: string | null;
  remotionConfig: RemotionExportConfig | null;
  // v1.3 新增：封面图与配音（用于切换 Tab 后还能继续浏览）
  generatedCovers: Array<{
    index: number;
    url: string;
    title: string;
    emoji: string;
    styleTag: string;
  }>;
  ttsResult: {
    mergedAudioUrl: string;
    totalDuration: number;
    segments: Array<{
      index: number;
      text: string;
      audioUrl: string;
      duration: number;
      success: boolean;
      error?: string;
    }>;
  } | null;
  // v1.4 新增：勾选参与封面生成的人物（默认解析时按标题自动勾选；用户可手动调整）
  selectedCharacterNames: string[];
}

function loadPersisted(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function savePersisted(s: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota */
  }
}

function clearPersisted() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

interface CoverImageEntry {
  index: number;
  url: string;
  title: string;
  emoji: string;
  styleTag: string;
  /** v1.4：所属方案 A~F（封面赛道模板） */
  schemeId?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  /** v1.4：方案中文名 */
  schemeName?: string;
}

interface LogEntry {
  id: string;
  time: string;
  tag: string; // 'INFO' | 'WARN' | 'ERROR' | 'STAGE' | 'TTS' | 'IMG' | 'PARSE' | 'EXPORT'
  message: string;
}

const CopyBasedPanel: React.FC<{
  apiKey: string;
  runningHubApiKey: string;
}> = ({ apiKey, runningHubApiKey }) => {
  const toast = useToast();
  const initial = useMemo(() => loadPersisted(), []);

  // ──────────────────────────────────────────────
  // 状态
  // ──────────────────────────────────────────────
  const [rawCopy, setRawCopy] = useState<string>(initial.rawCopy ?? '');
  const [analysisResult, setAnalysisResult] = useState<CopyAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  /** 用户编辑后的标题（索引 → 标题）。覆盖 analysisResult.titleOptions[i].title */
  const [editedTitles, setEditedTitles] = useState<Record<number, string>>(
    initial.editedTitles ?? {}
  );

  /** 锁定的封面索引（批量生成时跳过这些索引） */
  const [lockedCoverIndices, setLockedCoverIndices] = useState<Set<number>>(
    new Set<number>(
      Array.isArray(initial.lockedCoverIndices)
        ? (initial.lockedCoverIndices as number[]).filter((n) => Number.isInteger(n))
        : []
    )
  );

  /** 多选：方案索引集合 */
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    new Set<number>(
      Array.isArray(initial.selectedIndices)
        ? (initial.selectedIndices as number[]).filter((n) => Number.isInteger(n))
        : [0, 1, 2]
    )
  );
  /** 终选（最终采用哪个封面） */
  const [finalCoverIndex, setFinalCoverIndex] = useState<number | null>(
    initial.finalCoverIndex ?? null
  );
  const [characterRefs, setCharacterRefs] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 比例 */
  const [coverRatio, setCoverRatio] = useState<CoverRatioId>(
    (initial.coverRatio as CoverRatioId) ?? '16:9'
  );

  /** v1.4：参与封面生成的人物名单（按名字勾选；不勾选的人物不出现在画面里）
   *  默认：解析完成后按"6 套标题中出现过的人名"自动勾选，用户可手动调整 */
  const [selectedCharacterNames, setSelectedCharacterNames] = useState<string[]>(
    Array.isArray(initial.selectedCharacterNames)
      ? (initial.selectedCharacterNames as string[]).filter((s) => typeof s === 'string')
      : []
  );

  /** 多套封面图（v1.3：启动时从持久化恢复；blob URL 在 SPA 会话内仍有效）
   *  v1.10：先从 module-level cache 读（解决切走 sub-tab 再回来 base64 data URL 丢失） */
  const [generatedCovers, setGeneratedCovers] = useState<Map<number, CoverImageEntry>>(() => {
    const fromCache = copyBasedCache.getCovers();
    const arr = Array.isArray(fromCache) ? fromCache : Array.isArray(initial.generatedCovers) ? initial.generatedCovers : [];
    const m = new Map<number, CoverImageEntry>();
    arr.forEach((c) => {
      if (c && Number.isInteger(c.index) && c.url) {
        m.set(c.index, {
          index: c.index,
          url: c.url,
          title: c.title || '',
          emoji: c.emoji || '✨',
          styleTag: c.styleTag || '',
        });
      }
    });
    return m;
  });
  const [coversGenerating, setCoversGenerating] = useState<Set<number>>(new Set());
  const [coverErrors, setCoverErrors] = useState<Map<number, string>>(new Map());

  const [ttsProgress, setTtsProgress] = useState<ParallelTtsProgress | null>(null);
  const [ttsGenerating, setTtsGenerating] = useState<boolean>(false);
  /** v1.3：从持久化中恢复（去掉 mergedAudioBlob 字段，播放时仍可用 blob URL）
   *  v1.10：先从 module-level cache 读（解决切走 sub-tab 再回来 base64 配音丢失） */
  const [ttsResult, setTtsResult] = useState<ParallelTtsResult | null>(() => {
    const fromCache = copyBasedCache.getTtsResult();
    const r = fromCache || initial.ttsResult;
    if (!r) return null;
    // 重建一个兼容 ParallelTtsResult 的结构（mergedAudioBlob 设为 undefined，
    // 播放/导出仍用 mergedAudioUrl，因为不需要再次上传）
    return {
      mergedAudioUrl: r.mergedAudioUrl,
      mergedAudioBlob: undefined as unknown as Blob,
      totalDuration: r.totalDuration,
      segments: r.segments,
    };
  });
  const [ttsError, setTtsError] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoGenerating, setVideoGenerating] = useState<boolean>(false);
  const [videoProgress, setVideoProgress] = useState<number>(0);
  const [videoMessage, setVideoMessage] = useState<string>('');

  const abortRef = useRef<AbortController | null>(null);

  /** 语音库：当前选中的 voice（用于参考音） */
  const [showVoiceLibrary, setShowVoiceLibrary] = useState<boolean>(false);
  const [selectedVoice, setSelectedVoice] = useState<VoiceProfile | null>(null);
  const voiceEpochRef = useRef(0);
  useEffect(() => {
    setSelectedVoice(getSelectedVoice());
  }, [voiceEpochRef.current]);

  /** Remotion 导出设置 */
  const [remotionConfig, setRemotionConfig] = useState<RemotionExportConfig>(
    initial.remotionConfig ?? buildDefaultRemotionConfig()
  );
  const [remotionPanelOpen, setRemotionPanelOpen] = useState<boolean>(false);

  /** BGM 缓存列表 + 上传状态 */
  const [cachedBgm, setCachedBgm] = useState<BgmCacheEntry[]>([]);
  const [bgmUploading, setBgmUploading] = useState<boolean>(false);

  /** Whisper ASR 开关（生成词级时间戳支持卡拉OK字幕） */
  const [whisperEnabled, setWhisperEnabled] = useState<boolean>(false);
  const [whisperRunning, setWhisperRunning] = useState<boolean>(false);
  const [whisperProgress, setWhisperProgress] = useState<{ done: number; total: number; current: string }>(
    { done: 0, total: 0, current: '' }
  );

  /** 字幕样式面板展开 */
  const [subtitleStyleOpen, setSubtitleStyleOpen] = useState<boolean>(false);

  /** 渲染设置各子面板展开 */
  const [bgmExpanded, setBgmExpanded] = useState<boolean>(false);
  const [filterExpanded, setFilterExpanded] = useState<boolean>(false);
  const [motionExpanded, setMotionExpanded] = useState<boolean>(false);

  // 初始化 BGM 缓存列表
  useEffect(() => {
    try {
      setCachedBgm(listCachedBgm());
    } catch {
      /* ignore */
    }
  }, []);

  // 终端日志 */
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);

  /** 自动滚动日志到底部 */
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logs]);

  // ── 持久化（页面切换不丢内容） ───────────────────────────
  useEffect(() => {
    // 把 generatedCovers (Map) 转为数组；ttsResult 去掉 mergedAudioBlob（Blob 不能序列化，但 mergedAudioUrl 仍可播放）
    const coversArr: Array<{ index: number; url: string; title: string; emoji: string; styleTag: string }> =
      Array.from(generatedCovers.values());
    const ttsPersist = ttsResult
      ? {
          mergedAudioUrl: ttsResult.mergedAudioUrl,
          totalDuration: ttsResult.totalDuration,
          segments: ttsResult.segments,
        }
      : null;

    savePersisted({
      rawCopy,
      editedTitles,
      lockedCoverIndices: Array.from(lockedCoverIndices),
      coverRatio,
      selectedIndices: Array.from(selectedIndices),
      finalCoverIndex,
      selectedVoiceId: selectedVoice?.id ?? null,
      remotionConfig,
      generatedCovers: coversArr,
      ttsResult: ttsPersist,
      selectedCharacterNames,
    });

    // v1.10：大块数据（base64 封面/音频）单独写 module-level cache + sessionStorage
    // ────────────────────────────────────────────
    // 原因：localStorage 上限 5-10 MB，几 MB 的 base64 音频容易触发 QuotaExceededError
    //       → savePersisted 的 try/catch 静默忽略 → 切走 sub-tab 再回来数据丢失
    //       这里分到独立 key + 内存 cache：即使 localStorage 写失败，内存 cache 仍然保留
    try { copyBasedCache.setCovers(coversArr); } catch {}
    try {
      if (ttsPersist) copyBasedCache.setTtsResult(ttsPersist);
    } catch {}
  }, [
    rawCopy,
    editedTitles,
    lockedCoverIndices,
    coverRatio,
    selectedIndices,
    finalCoverIndex,
    selectedVoice,
    remotionConfig,
    generatedCovers,
    ttsResult,
    selectedCharacterNames,
  ]);

  // ──────────────────────────────────────────────
  // 日志
  // ──────────────────────────────────────────────
  const appendLog = useCallback((tag: LogEntry['tag'], message: string) => {
    const id = String(++logIdRef.current);
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs((prev) => {
      const next = [...prev, { id, time, tag, message }];
      // 最多保留 500 条
      return next.length > 500 ? next.slice(-500) : next;
    });
    console.log(`[${tag}] ${message}`);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    logIdRef.current = 0;
    appendLog('INFO', '日志已清空');
  }, [appendLog]);

  // ──────────────────────────────────────────────
  // 派生
  // ──────────────────────────────────────────────
  /** 应用 editedTitles 后的标题选项 */
  const liveTitleOptions: CopyTitleOption[] = useMemo(() => {
    if (!analysisResult) return [];
    return analysisResult.titleOptions.map((opt, i) => ({
      ...opt,
      title: editedTitles[i]?.trim() || opt.title,
    }));
  }, [analysisResult, editedTitles]);

  const selectedOptionList: CopyTitleOption[] = useMemo(() => {
    if (!analysisResult) return [];
    const idxList = Array.from(selectedIndices) as number[];
    return idxList
      .map((i) => liveTitleOptions[i])
      .filter(Boolean);
  }, [liveTitleOptions, selectedIndices]);

  const charCount = rawCopy.length;
  const currentRatio = COVER_RATIOS.find((r) => r.id === coverRatio) || COVER_RATIOS[0];

  const finalCover: CoverImageEntry | null =
    finalCoverIndex != null ? generatedCovers.get(finalCoverIndex) || null : null;

  // ──────────────────────────────────────────────
  // 文案解析
  // ──────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (!apiKey?.trim()) {
      appendLog('ERROR', '云雾 API Key 未配置');
      toast.error('请先在顶部输入云雾 API Key', 4000);
      return;
    }
    if (rawCopy.trim().length < 50) {
      appendLog('ERROR', `文案过短（${rawCopy.trim().length}字），至少 50 字，建议 300 字以上`);
      toast.error('文案过短，至少 50 字，建议 300 字以上', 4000);
      return;
    }
    appendLog('STAGE', '▶ 开始 AI 解析文案');
    appendLog('PARSE', `文案长度：${rawCopy.trim().length} 字`);
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisResult(null);
    // 默认选中前 3 个方案（A/B/C 对比性最强）；让用户能批量生成
    setSelectedIndices(new Set([0, 1, 2]));
    setFinalCoverIndex(null);
    setEditedTitles({});
    setLockedCoverIndices(new Set());
    setGeneratedCovers(new Map());
    setCoverErrors(new Map());
    setTtsResult(null);
    setVideoUrl('');
    try {
      appendLog('PARSE', '调用 GPT-5.6-Luna 解析 6 套方案（预计 15~60s，max_tokens=8192）...');
      // v1.5：用对象形式传参：开启超时 180s / 1 次重试 / 上限 6000 字
      const r = await analyzeCopyWithLlm(apiKey, rawCopy, COPY_ANALYSIS_PROMPT, {
        onLog: (msg) => {
          // 把 [文案解析] / [文案解析] ⚠... 这类前缀去掉，UI 简洁
          appendLog('PARSE', msg.replace(/^\[文案解析\]\s*/, ''));
        },
        timeoutMs: 180_000,
        retries: 1,
        maxInputChars: 6000,
        onDiagnostics: (diag) => {
          // 把诊断信息（finish_reason / usage）也写到日志，方便排查「LLM 返回为空」
          if (!diag.ok) {
            appendLog(
              'WARN',
              `解析诊断：HTTP=${diag.httpStatus || 'n/a'} · finish_reason=${
                diag.finishReason || 'n/a'
              } · 模型=${diag.model} · attempts=${diag.attempts} · 耗时 ${diag.elapsedMs}ms · ${
                diag.clippedChars ? `已裁剪 ${diag.clippedChars} 字 · ` : ''
              }content_len=${diag.rawContentLen || 0} · error=${diag.error || ''}`
            );
          }
        },
      });
      setAnalysisResult(r);
      appendLog('PARSE', `解析成功：${r.titleOptions.length} 套方案 + 人物「${r.characterInfo.name || '未识别'}」`);
      if (r.summary) appendLog('PARSE', `摘要：${r.summary}`);
      r.titleOptions.forEach((opt, i) => {
        appendLog('PARSE', `方案${i + 1}[${opt.schemeId}·${opt.schemeName}][${opt.styleTag}]：${opt.title}`);
      });

      // v1.4：默认勾选「标题中提到的人物」（未勾选的人物不会出现在封面）
      const titlesArr = r.titleOptions.map((o) => o.title);
      const pickedNames = pickCharactersMentionedInTitles(titlesArr, r.characters || []);
      if (pickedNames.length > 0) {
        setSelectedCharacterNames(pickedNames);
        const allNames = (r.characters || []).map((c) => c.name || '匿名').join('、');
        appendLog(
          'PARSE',
          `📌 封面人物自动勾选（${pickedNames.length}/${(r.characters || []).length}）：${pickedNames.join('、')}；未勾选：${(r.characters || [])
            .filter((c) => !pickedNames.includes((c.name || '').trim()))
            .map((c) => c.name || '匿名')
            .join('、') || '（无）'}`
        );
      } else {
        appendLog('PARSE', '⚠ 标题里未识别到人名，所有人物暂不勾选（请手动勾选后批量生成）');
      }
    } catch (e: any) {
      const msg = e?.message || '解析失败';
      setAnalysisError(msg);
      appendLog('ERROR', `AI 解析失败：${msg}`);
      toast.error(msg, 5000);
    } finally {
      setAnalyzing(false);
    }
  }, [apiKey, rawCopy, toast, appendLog]);

  // ──────────────────────────────────────────────
  // 角色参考图
  // ──────────────────────────────────────────────
  const handleUploadRef = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const max = 3;
      const promises: Promise<string>[] = [];
      for (let i = 0; i < Math.min(files.length, max - characterRefs.length); i++) {
        const f = files[i];
        promises.push(
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(f);
          })
        );
      }
      Promise.all(promises)
        .then((urls) => {
          setCharacterRefs((prev) => [...prev, ...urls].slice(0, max));
          appendLog('IMG', `已上传 ${urls.length} 张角色参考图（合计 ${urls.length + characterRefs.length} 张）`);
        })
        .catch((err) => {
          appendLog('ERROR', `参考图读取失败：${err.message}`);
          toast.error('参考图读取失败：' + err.message, 4000);
        });
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [characterRefs.length, toast, appendLog]
  );

  const removeRef = (idx: number) => {
    setCharacterRefs((prev) => prev.filter((_, i) => i !== idx));
  };

  const toggleSelectIndex = (idx: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        if (next.size > 1) next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // ──────────────────────────────────────────────
  // 标题编辑
  // ──────────────────────────────────────────────
  const updateTitle = (idx: number, newTitle: string) => {
    setEditedTitles((prev) => ({ ...prev, [idx]: newTitle }));
  };

  const resetTitle = (idx: number) => {
    setEditedTitles((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  };

  const copyTitle = (title: string) => {
    if (!title?.trim()) return;
    navigator.clipboard.writeText(title).then(
      () => toast.success('标题已复制', 1500),
      () => toast.error('复制失败', 1500)
    );
  };

  // ──────────────────────────────────────────────
  // 锁定 / 解锁封面（批量生成时跳过已锁定的）
  // ──────────────────────────────────────────────
  const toggleLockCover = (idx: number) => {
    setLockedCoverIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // ──────────────────────────────────────────────
  // 生成封面（单套）— 6 种不同排版方案（复用封面赛道 A~F 模板）
  // ──────────────────────────────────────────────

  /**
   * 6 种不同的封面排版设计（与封面赛道 A~F 一一对应）
   * - 不同排版≠相同 4 色 + 上下排列
   * - 每种布局：决定颜色组合、字号对比、元素位置、强调方式
   * - 复用 services/coverSchemePresets 的 hint 文案
   */
  const COVER_LAYOUT_VARIANTS = [
    {
      id: 'A_immersive',
      schemeId: 'A' as const,
      name: '排版 A · 场景沉浸',
      colors: '标题主色 #FFFFFF，副标题 #FFE600 暖黄，关键词徽章 #FF3300 警示红，背景深色',
      description:
        '沉浸式电影感：人物在画面中央偏上，背景是宏大场景（暴雨/战火/城市夜景），主标题放在画面上 1/3 区域作为巨型横幅（最大字号 + 加粗白字 + 黑色厚描边），副标题（或关键词徽章）放在画面下方 1/4 区域作为小亮点（黄色或红色对比），人物面部占画面 50-60%。',
      composition:
        '主标题横幅（顶部上 1/3 区域，占画面宽度 85%，巨型字号 12-15% 画高）+ 副标题（底部下 1/4 区域，描边对比色）+ 人物面部居中偏上（占 50-60% 视觉重量）。',
      emphasis:
        '关键词 1-2 个（人名 / 数字 / 反转词）：用 1.6-1.8 倍字号 + 加粗 900 + 高亮色（黄/红）背景徽章',
      extraDetails: '强光 / 雨雾 / 火焰 / 烟雾 / 戏剧化高对比',
    },
    {
      id: 'B_minimal',
      schemeId: 'B' as const,
      name: '排版 B · 极简/单色底',
      colors: '标题主色 #FFFFFF，副标题 #00D4FF 冷蓝（强调色），背景纯净渐变',
      description:
        '极简杂志感：纯净渐变背景（深蓝到深紫 / 深灰到深蓝），人物放在三分线右下方（不要居中），主标题单独放在画面左下方（占画面宽度 70%，巨型字号），副标题或关键词徽章放在右上角（小一点，作为强调点）。',
      composition:
        '主标题（左下方 60% 区域，左对齐，巨型字号 14-18% 画高，无装饰）+ 强调徽章（右上角，圆形或矩形，高亮色填充）+ 人物（三分线右下方，占 35-40% 视觉重量）。',
      emphasis:
        '关键词 1-2 个：用与背景对比的强调色（冷蓝/电光绿）作为徽章或下划线',
      extraDetails: '柔和编辑光 / 单一渐变 / 干净背景 / 杂志感',
    },
    {
      id: 'C_high_contrast',
      schemeId: 'C' as const,
      name: '排版 C · 高反差/特写',
      colors: '标题主色 #FFFFFF 锐白，关键词 #FF1744 炽红，背景蓝色调 #0A1A3A 反差蓝',
      description:
        '压迫感特写：紧贴人物面部/上半身（占画面 75-85%），夸张表情或动作，主标题作为超大字号（占画面 25-30% 高度）覆盖在人物身上（半透明黑底或无底），副标题放在画面下方作为副线。',
      composition:
        '主标题（中央重叠位置，超大字号 18-25% 画高，白字 + 阴影 + 厚边框，加粗 900）+ 副标题（底部 1/5 区域，小字，对比色：红色或黄色）+ 箭头或红圈强调（指向人物关键部位）。',
      emphasis:
        '关键词 1-2 个：1.8-2.2 倍超大字号 + 红/黄对比色 + 描边',
      extraDetails: '硬边光 / 锐化颗粒 / 胶片颗粒 / 高饱和反差',
    },
    {
      id: 'D_split',
      schemeId: 'D' as const,
      name: '排版 D · 纵向分屏',
      colors: '上半部主色 #1E3A8A 深蓝（主体场景），下半部 #FACC15 警示黄（信息条），中线 #FFFFFF 白色光束',
      description:
        '纵向分屏对比：上半部是宏大场景或人物特写，下半部是数据牌 / 信息条 / 对比信息，中线由一道光束或俱乐部色分割带分开，整体结构化、信息密度高，适合议题性内容。',
      composition:
        '上半部（约 60% 画面高度）：主体人物或场景全景；下半部（约 40%）：信息条 / 数据牌 / 关键词横幅；中线（横向 100%）：俱乐部色或霓虹光束分割，厚度 2-3%。',
      emphasis:
        '关键词 1-2 个：放在下半部信息条中央，超大字号 + 顶部 Hook',
      extraDetails: '上下对比 / 数据可视化 / 议题结构化',
    },
    {
      id: 'E_infographic',
      schemeId: 'E' as const,
      name: '排版 E · 信息图/数据牌',
      colors: '中央巨型字牌 #FF3300 警示红，Hook 字 #FFFFFF 白字，背景 #0F172A 深色',
      description:
        '信息图风格：中央巨型数字 / VS 对阵牌 / 徽章占画面 40-50%，主体剪影或头像特写放在上方或侧边，Hook 字横压顶部，整体像 ESPN / IMDb / 商业信息图。',
      composition:
        '中央巨型字牌（占画面 40-50%，超粗无衬线字体，数字/VS/徽章）+ 主体剪影（上方或侧边，头像或半身）+ 角标（四角：比分/排行/排名/年龄/数字）+ Hook 字（横压顶部或顶部横幅）。',
      emphasis:
        '关键词 1-2 个：作为巨型字牌 + 顶部 Hook 双重强调',
      extraDetails: '信息图质感 / 数据可视化 / ESPN 风',
    },
    {
      id: 'F_portrait_banner',
      schemeId: 'F' as const,
      name: '排版 F · 人像+大字横幅',
      colors: '横幅底色 #FF3300 荧光红或 #FACC15 金色，字色 #FFFFFF 白字，背景深色',
      description:
        '海报式人像：主角半身或头像特写 + 巨型姓名/称呼横幅（底色荧光或印章感），角标职位/节目名/期数，整体像电影海报或演播室字体感。',
      composition:
        '主角半身/头像特写（占画面 40-50%，居中或左侧）+ 巨型姓名横幅（底部或顶部，底色荧光，超粗字体）+ 角标（右上/右下：职位/节目名/期数，小字）。',
      emphasis:
        '关键词 1-2 个：人名 + 职位/节目名作为角标',
      extraDetails: '电影海报 / 演播室字体 / 印章感',
    },
  ] as const;

  /**
   * 从标题中提取 1-2 个关键词（人名 / 数字 / 反转词）
   */
  function extractKeywords(title: string): string[] {
    if (!title) return [];
    const keywords: string[] = [];

    // 1) 数字（金额 / 时间 / 比例）
    const numMatch = title.match(/[\d.零一二三四五六七八九十百千万亿]+/);
    if (numMatch) keywords.push(numMatch[0]);

    // 2) 中文人名（2-4 个汉字，无"的/了/是"等停用词）
    const nameMatches = title.match(/[一-龥]{2,4}/g) || [];
    const stopWords = new Set([
      '的', '了', '是', '在', '和', '与', '或', '就', '都', '也', '不', '没', '有',
      '台', '美', '中', '国', '对', '把', '让', '从', '到', '为', '以', '及',
      '中国', '美国', '台湾', '一位', '这个', '那个', '什么', '怎么', '为什么',
      '一起', '一起上', '底牌', '逼', '亮', '芯片', '海售', '军售',
    ]);
    const candidates = nameMatches
      .filter((w) => !stopWords.has(w) && w.length >= 2 && w.length <= 4)
      .filter((w) => /[一-龥]/.test(w));
    const seen = new Set<string>();
    for (const c of candidates) {
      if (!seen.has(c)) {
        seen.add(c);
        keywords.push(c);
      }
      if (keywords.length >= 2) break;
    }

    // 3) 反转词标识
    const flipWords = ['却', '竟然', '原来', '其实', '反', '不料', '没想到'];
    for (const fw of flipWords) {
      if (title.includes(fw)) {
        keywords.push(fw);
        break;
      }
    }

    return keywords.slice(0, 2);
  }

  const generateSingleCover = useCallback(
    async (optionIdx: number, option: CopyTitleOption) => {
      if (!apiKey?.trim()) {
        appendLog('ERROR', '云雾 API Key 未配置');
        toast.error('请先在顶部输入云雾 API Key', 4000);
        return;
      }
      const characters = analysisResult?.characters ?? [];
      const mainCharacter = characters[0];
      const otherCharacters = characters.slice(1);

      // v1.4：按用户勾选的人物过滤（默认是「标题中提到的人物」）
      // 未勾选的人物不进入 prompt，不出现在画面里
      const selectedSet = new Set((selectedCharacterNames || []).map((s) => s.trim()).filter(Boolean));
      const filteredCharacters = characters.filter((c) => selectedSet.has((c.name || '').trim()));
      const filteredMain = filteredCharacters[0];
      const filteredOthers = filteredCharacters.slice(1);

      // 抽取 1-2 个关键词（人名 / 数字 / 反转词）
      const keywords = extractKeywords(option.title);

      // 按 schemeId 选排版：A~F 与封面赛道 6 方案模板一一对应
      // 兼容旧数据（无 schemeId）则按 optionIdx 取模
      const schemeKey = (option.schemeId || ['A', 'B', 'C', 'D', 'E', 'F'][optionIdx % 6]) as
        | 'A'
        | 'B'
        | 'C'
        | 'D'
        | 'E'
        | 'F';
      const layout =
        COVER_LAYOUT_VARIANTS.find((v) => v.schemeId === schemeKey) ||
        COVER_LAYOUT_VARIANTS[optionIdx % 6];

      // 按方案 A~F 的"对应关系"映射 single-character / multi-character 提示
      // 若勾选多人物 → 强调"双人对峙/群像/分屏构图"
      // 若只勾选 1 位 → 用单人模板（不再误加多人）
      const isMulti = filteredCharacters.length >= 2;

      // 拼装多人物描述（只用勾选的人物）
      const charactersDesc = filteredCharacters
        .slice(0, 3)
        .map((c, i) => {
          const role = i === 0 ? '主人物' : (c.role || `相关人物${i}`);
          const parts = [c.name, c.title, c.visualDescription, c.dominantEmotion]
            .filter(Boolean)
            .join(' · ');
          return `${role}：${parts}`;
        })
        .join('\n');

      // 关键 1：把完整标题嵌入 prompt，强制 AI 显示完整文字
      // 关键 2：使用「排版方案」机制（6 种方案 6 种排版），与封面赛道 A~F 一一对应
      // 关键 3（v1.4）：只描述用户勾选的人物，未勾选的人物不会出现在画面里
      // 关键 4（v1.6）：复用封面模版赛道的"高 CTR 字体爆炸式排版 DNA"，
      //                 与 CoverDesign 的 prompt 1:1 对齐，确保文案成片封面与封面模版效果一致
      const highCtrTypographyDna = `\n\n=== ⭐ TYPOGRAPHY · 7-POINT EXPLOSIVE LAYOUT DNA（必读；与封面模版赛道一致）===
YouTube 高 CTR 封面必须做到以下 7 点：
1. **巨粗字号**：主标题占画面高度 18-28%，加粗 900 (black weight)，描边粗黑 6-10px。
2. **分色块排版**：同一句标题必须拆成 2-4 个色块，每个色块一个高饱和色：
   - 主色 #FFFFFF 锐白（承载主体）
   - 强调色 #FF1744 炽红（承载人名 / 数字 / 反转词）
   - 强调色 #FFD600 警示黄（承载关键词 / 钩子词）
   - 强调色 #00D4FF 电光蓝（承载副标题 / 数据）
3. **错位排版**：色块之间要错位、倾斜（-3° ~ +5°），上下层叠加；不要水平整齐排列。
4. **黑色厚描边**：每块色块描边 6-10px 纯黑 (#000000)，确保暗背景下也清晰。
5. **半透明底板**：色块后加黑色半透明底板 (rgba(0,0,0,0.65))，文字 100% 可读。
6. **点击率元素**：在关键部位加红色箭头 (#FF1744) / 黄色高亮圈 (#FFD600) / 红黄斜条警示条。
7. **画面占比**：文字总占画面 40-55%（不要少于 30%，否则变成普通图）。

=== ⭐ 5 大要素铁律（每条 coverPromptEn 必须覆盖）===
- 【构图】按 A/B/C/D/E/F 方案
- 【光线】cinematic lighting, 85mm lens, shallow depth of field
- 【配色】主体深色 + 字体色板白/红/黄/蓝四色
- 【字体排版】按上述 7 大铁律（巨粗 + 分色块 + 错位 + 黑描边 + 半透明底板）
- 【点击率元素】红色箭头 / 黄色高亮圈 / 红黄警示条 / 夸张表情`;

      const fullPrompt = `${option.coverPromptEn}

=== CRITICAL · 必须在画面上完整显示以下中文标题（一字不漏，禁止简化、禁止拆分成几个词）===
|TEXT (display exactly): "${option.title}"
|===

=== ${layout.name}（方案 ${schemeKey}：${option.schemeName || layout.name}，position ${optionIdx + 1} of 6，必须与其它 5 种方案不同！）===
【${layout.description}】

【颜色组合（严格按此执行，禁止 4 色堆叠）】：${layout.colors}

【构图布局】：${layout.composition}

【关键词强调】：${layout.emphasis}
需要被强调的关键词：${keywords.map((k) => `"${k}"`).join('、')}

【视觉氛围】：${layout.extraDetails}

Style hints: ${option.styleKeywords.join(', ')}${highCtrTypographyDna}

=== 📌 人物描述（${filteredCharacters.length} 位已勾选 — 只画这 ${filteredCharacters.length} 位）===
${charactersDesc || '（未勾选人物，画面仅保留文字与场景）'}
${
  isMulti
    ? `特别提示：本期内容涉及 ${filteredCharacters.length} 位已勾选人物（${filteredCharacters
        .map((c) => c.name || '匿名')
        .join('、')}），请在画面中体现这些人物的并存（多人/双人对峙/群像/分屏构图），不要只画其中一位；未勾选的人物不要出现在画面里。`
    : filteredCharacters.length === 1
    ? `特别提示：本期内容仅涉及 1 位人物（${filteredCharacters[0].name || '匿名'}），请把画面焦点完全集中在此人；不要添加其它人物。`
    : '特别提示：用户未勾选任何人物，画面仅保留文字与场景，不要画任何人物脸孔。'
}
===

=== ⭐ MANDATORY · High-CTR Thumbnail Enforcement（与封面模版赛道 1:1 对齐）===
YouTube thumbnail, ${currentRatio.id} aspect ratio, bold readable main title, high CTR composition.
Mandatory: all Chinese on-image text must be in Traditional Chinese script only (繁體中文); no simplified Chinese forms; no English or other languages.
Mandatory: the title "${option.title}" MUST appear on the image verbatim, split into 2-4 color blocks using {white #FFFFFF, red #FF1744, yellow #FFD600, blue #00D4FF}; each block bold weight 900, 6-10px black outline, slight tilt (-3° to +5°), semi-transparent black plate behind.
Mandatory: include at least one high-CTR visual accent — bright red arrow, yellow highlight ring, or red-yellow warning strip.===`;

      setCoversGenerating((prev) => new Set(prev).add(optionIdx));
      setCoverErrors((prev) => {
        const next = new Map(prev);
        next.delete(optionIdx);
        return next;
      });

      const size = `${currentRatio.w}x${currentRatio.h}`;
      appendLog(
        'IMG',
        `▶ 生成封面 方案${optionIdx + 1} [${option.styleTag}] · ${layout.name}（${schemeKey}）：${size}（${currentRatio.label}）`
      );
      appendLog('IMG', `  标题：${option.title}（${option.title.length}字）`);
      appendLog('IMG', `  关键词：${keywords.join(', ') || '（自动识别）'}`);
      appendLog(
        'IMG',
        `  勾选人物（${filteredCharacters.length}/${characters.length}）：${
          filteredCharacters.length > 0 ? filteredCharacters.map((c) => c.name || '匿名').join('、') : '（无）'
        }${
          filteredCharacters.length < characters.length
            ? `；未勾选：${characters
                .filter((c) => !selectedSet.has((c.name || '').trim()))
                .map((c) => c.name || '匿名')
                .join('、')}`
            : ''
        }`
      );

      try {
        // 合并多人物名到 characterName（用逗号分隔，yunwuService 内部已支持多人识别）
        const allCharacterNames = filteredCharacters
          .map((c) => (c.name || '').trim())
          .filter((x): x is string => !!x);
        const combinedName = allCharacterNames.join(',');

        const r = await generateImage(apiKey, {
          model: 'gpt-image-2',
          prompt: fullPrompt,
          size,
          quality: 'high',
          n: 1,
          referenceDataUrls: characterRefs.length > 0 ? characterRefs : undefined,
          characterName: combinedName || undefined,
          timeoutMs: 240_000,
        });
        if (!r.success) throw new Error(r.error || '生图失败');
        const url = r.url;
        if (!url) throw new Error('生图返回无 URL');

        const entry: CoverImageEntry = {
          index: optionIdx,
          url,
          title: option.title,
          emoji: option.emoji,
          styleTag: option.styleTag,
          schemeId: option.schemeId,
          schemeName: option.schemeName,
        };
        setGeneratedCovers((prev) => {
          const next = new Map(prev);
          next.set(optionIdx, entry);
          return next;
        });
        // 默认终选第一张生成的封面
        setFinalCoverIndex((prev) => (prev == null ? optionIdx : prev));
        appendLog('IMG', `✓ 方案${optionIdx + 1} 封面生成成功 → ${url.slice(0, 60)}...`);
      } catch (e: any) {
        const msg = e?.message || '生成失败';
        setCoverErrors((prev) => new Map(prev).set(optionIdx, msg));
        appendLog('ERROR', `✗ 方案${optionIdx + 1} 封面生成失败：${msg}`);
      } finally {
        setCoversGenerating((prev) => {
          const next = new Set(prev);
          next.delete(optionIdx);
          return next;
        });
      }
    },
    [apiKey, analysisResult, characterRefs, currentRatio, toast, appendLog, selectedCharacterNames]
  );

    /** 单独为某个方案生成封面（不依赖多选） */
  const handleGenerateOneCover = useCallback(
    (idx: number) => {
      const opt = liveTitleOptions[idx];
      if (!opt) return;
      // 单独生成时强制覆盖（即使已锁定）
      if (lockedCoverIndices.has(idx)) {
        setLockedCoverIndices((prev) => {
          const next = new Set(prev);
          next.delete(idx);
          return next;
        });
      }
      // 如果这张不在 selectedIndices 中，临时加入（生成后再决定是否保留）
      if (!selectedIndices.has(idx)) {
        setSelectedIndices((prev) => {
          const next = new Set(prev);
          next.add(idx);
          return next;
        });
      }
      generateSingleCover(idx, opt);
    },
    [liveTitleOptions, lockedCoverIndices, selectedIndices, generateSingleCover]
  );

  /** 批量生成所有选中方案的封面 — 跳过已锁定的 */
  const handleGenerateAllCovers = useCallback(async () => {
    if (selectedOptionList.length === 0) {
      toast.error('请先选择至少 1 套方案', 3000);
      return;
    }
    const idxList = Array.from(selectedIndices) as number[];
    const tasks = selectedOptionList.map((opt, i) => ({
      idx: idxList[i],
      opt,
    }));
    const locked = tasks.filter(({ idx }) => lockedCoverIndices.has(idx));
    const unlocked = tasks.filter(({ idx }) => !lockedCoverIndices.has(idx));
    if (locked.length > 0) {
      appendLog(
        'STAGE',
        `▶ 批量生成 ${tasks.length} 套封面 · 跳过 ${locked.length} 张已锁定的`
      );
      toast.info(`已锁定 ${locked.length} 张封面，将保留不重新生成`, 2500);
    } else {
      appendLog('STAGE', `▶ 批量生成 ${tasks.length} 套封面（并行）`);
    }
    unlocked.forEach(({ idx, opt }) => generateSingleCover(idx, opt));
    // 不 await，Promise.all 让多张同时执行
  }, [selectedOptionList, selectedIndices, lockedCoverIndices, generateSingleCover, toast, appendLog]);

  /** 单张重新生成（强制覆盖，即使锁定也会重新生成） */
  const handleRegenerateOneCover = useCallback(
    (idx: number) => {
      const opt = liveTitleOptions[idx];
      if (!opt) return;
      // 重新生成前从锁定中移除（避免逻辑冲突）
      if (lockedCoverIndices.has(idx)) {
        setLockedCoverIndices((prev) => {
          const next = new Set(prev);
          next.delete(idx);
          return next;
        });
      }
      generateSingleCover(idx, opt);
    },
    [liveTitleOptions, lockedCoverIndices, generateSingleCover]
  );

  /** 终选某张封面 */
  const handlePickFinalCover = useCallback(
    (idx: number) => {
      if (!generatedCovers.has(idx)) return;
      setFinalCoverIndex(idx);
      const c = generatedCovers.get(idx)!;
      appendLog('STAGE', `✓ 已选定终封面：方案${idx + 1} [${c.styleTag}]「${c.title}」`);
      toast.success(`已选定终封面：方案${idx + 1}`, 2000);
    },
    [generatedCovers, appendLog, toast]
  );

  // ──────────────────────────────────────────────
  // 下载封面
  // ──────────────────────────────────────────────
  const handleDownloadCover = useCallback(
    (entry: CoverImageEntry) => {
      try {
        const a = document.createElement('a');
        a.href = entry.url;
        const safeTitle = entry.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
        a.download = `cover_${entry.index + 1}_${safeTitle}_${currentRatio.id.replace(':', 'x')}.png`;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        appendLog('IMG', `↓ 下载封面：方案${entry.index + 1}（${a.download}）`);
      } catch (e: any) {
        appendLog('ERROR', `下载失败：${e.message}`);
      }
    },
    [currentRatio, appendLog]
  );

  // ──────────────────────────────────────────────
  // 5 段并行配音 — 复用多镜头分镜的语音库
  // 注：选中的音色若未同步到 RunningHub，会先上传再调用 TTS，保证真正使用自选音色
  // ──────────────────────────────────────────────
  const handleGenerateTts = useCallback(async () => {
    if (selectedOptionList.length === 0) {
      toast.error('请先选择至少 1 套方案', 3000);
      return;
    }
    if (!runningHubApiKey?.trim()) {
      appendLog('ERROR', 'RunningHub API Key 未配置');
      toast.error('请先在顶部输入 RunningHub API Key', 4000);
      return;
    }
    if (rawCopy.trim().length < 50) {
      toast.error('文案过短，无法配音', 3000);
      return;
    }
    appendLog('STAGE', '▶ 开始 5 段并行配音（使用最终选定方案的标题作为字幕参考）');
    appendLog('TTS', `文案长度：${rawCopy.trim().length} 字`);

    setTtsGenerating(true);
    setTtsError(null);
    setTtsResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // 关键：若选中音色但未同步到 RunningHub，先上传参考音频拿到 path
      let activeVoice = selectedVoice;
      let referenceAudioPath = selectedVoice?.runningHubAudioPath?.trim() || undefined;

      if (selectedVoice) {
        if (!referenceAudioPath) {
          // 还未同步 — 先上传
          if (!selectedVoice.audioDataUrl?.trim()) {
            appendLog('ERROR', `音色「${selectedVoice.name}」缺少音频数据，无法上传到 RunningHub`);
            toast.error('音色数据缺失，请删除后重新上传', 4000);
            setTtsGenerating(false);
            abortRef.current = null;
            return;
          }
          appendLog('TTS', `参考音色未同步，正在上传「${selectedVoice.name}」到 RunningHub…`);
          toast.info(`首次使用「${selectedVoice.name}」正在上传参考音到 RunningHub…`, 3000);
          try {
            referenceAudioPath = await uploadAudioToRunningHub(runningHubApiKey, selectedVoice.audioDataUrl);
            // 把上传后的路径缓存到 voice profile（这样下次就不用再上传）
            try {
              updateVoice(selectedVoice.id, { runningHubAudioPath: referenceAudioPath });
              // 同步刷新本组件的 selectedVoice
              activeVoice = { ...selectedVoice, runningHubAudioPath: referenceAudioPath };
              setSelectedVoice(activeVoice);
            } catch (e) {
              console.warn('[TTS] 缓存 runningHubAudioPath 失败（不影响本次调用）:', e);
            }
            appendLog('TTS', `✓ 参考音已上传到 RunningHub：${referenceAudioPath.slice(0, 40)}`);
          } catch (e: any) {
            appendLog('ERROR', `上传参考音失败：${e?.message || e}`);
            toast.error(`上传参考音失败：${e?.message || e}，将使用系统默认参考音`, 5000);
            // 上传失败 → 回退到系统默认参考音
            referenceAudioPath = undefined;
          }
        } else {
          appendLog('TTS', `参考音色：${selectedVoice.name}（已同步 RunningHub：${referenceAudioPath.slice(0, 40)}）`);
        }
      } else {
        appendLog('TTS', '未选音色，使用系统默认参考音');
      }

      const r = await runParallelTts(
        runningHubApiKey,
        apiKey,
        rawCopy,
        {
          speed: 1.0,
          prosodyEnhance: true,
          breath: true,
          autoPause: true,
          pauseStrength: 0.7,
          emphasisStrength: 0.5,
          referenceLanguage: 'auto',
          // 关键：使用上传后的 RunningHub 路径（即使刚上传）
          referenceAudioPath,
        },
        {
          segmentCount: 5,
          polishWithLlm: !!apiKey?.trim(),
          onProgress: (p) => {
            setTtsProgress(p);
            appendLog('TTS', `${p.stage} | 段进度：${p.segmentsCompleted}/${p.segmentsTotal} ${p.segmentsStatus.map((s) => (s === 'done' ? '✓' : s === 'running' ? '▶' : s === 'failed' ? '✗' : '·')).join('')}`);
          },
          signal: ac.signal,
        }
      );
      setTtsResult(r);
      appendLog('TTS', `✓ 5 段并行配音完成，总时长 ${r.totalDuration.toFixed(1)} 秒（${activeVoice ? `使用「${activeVoice.name}」` : '系统默认音色'}）`);
      const failedCount = r.segments.filter((s) => !s.success).length;
      if (failedCount > 0) appendLog('WARN', `${failedCount} 段配音失败，已用成功片段合并`);
      toast.success(`5 段并行配音完成，总时长 ${r.totalDuration.toFixed(1)} 秒`, 3000);
    } catch (e: any) {
      const msg = e?.message || '配音失败';
      setTtsError(msg);
      appendLog('ERROR', `配音失败：${msg}`);
      toast.error(msg, 5000);
    } finally {
      setTtsGenerating(false);
      setTtsProgress(null);
      abortRef.current = null;
    }
  }, [
    runningHubApiKey,
    apiKey,
    selectedOptionList,
    rawCopy,
    selectedVoice,
    toast,
    appendLog,
  ]);

  const handleCancelTts = () => {
    abortRef.current?.abort();
    appendLog('WARN', '用户取消了配音任务');
  };

  // ──────────────────────────────────────────────
  // BGM（背景音乐）处理器
  // ──────────────────────────────────────────────
  const handleBgmUpload = async (file: File) => {
    setBgmUploading(true);
    try {
      const entry = await cacheLocalBgm(file);
      setCachedBgm(listCachedBgm());
      setRemotionConfig((c) => ({
        ...c,
        bgm: { ...c.bgm, enabled: true, url: entry.dataUrl },
      }));
      appendLog('EXPORT', `↑ 上传 BGM：${entry.name}（${(entry.size / 1024 / 1024).toFixed(2)}MB）`);
      toast.success(`已上传背景音乐：${file.name}`);
    } catch (e: any) {
      appendLog('ERROR', `BGM 上传失败：${e?.message || e}`);
      toast.error(`BGM 上传失败：${e?.message || e}`);
    } finally {
      setBgmUploading(false);
    }
  };

  const handleBgmSelect = (entry: BgmCacheEntry) => {
    setRemotionConfig((c) => ({
      ...c,
      bgm: { ...c.bgm, enabled: true, url: entry.dataUrl },
    }));
    appendLog('EXPORT', `♪ 选用 BGM：${entry.name}`);
  };

  const handleBgmRemove = (entry: BgmCacheEntry) => {
    const key = `${entry.name}::${entry.size}::${0}`;
    removeCachedBgm(key);
    setCachedBgm(listCachedBgm());
    if (remotionConfig.bgm.url === entry.dataUrl) {
      setRemotionConfig((c) => ({ ...c, bgm: { ...c.bgm, url: undefined, enabled: false } }));
    }
    appendLog('EXPORT', `✗ 删除 BGM：${entry.name}`);
  };

  const handleBgmClearAll = () => {
    if (!confirm('确认清空所有缓存的背景音乐？')) return;
    clearCachedBgm();
    setCachedBgm([]);
    setRemotionConfig((c) => ({ ...c, bgm: { ...c.bgm, url: undefined, enabled: false } }));
    appendLog('WARN', '已清空 BGM 缓存');
    toast.success('已清空 BGM 缓存');
  };

  // ──────────────────────────────────────────────
  // MP4 导出（Remotion 渲染）— 单 shot：封面 + 配音
  // ──────────────────────────────────────────────
  const handleExportMp4 = useCallback(async () => {
    if (!finalCover) {
      toast.error('请先选定终封面', 3000);
      return;
    }
    if (!ttsResult) {
      toast.error('请先生成配音', 3000);
      return;
    }
    appendLog('EXPORT', '▶ 准备 MP4 导出（Remotion 单镜头：封面 + 配音）');
    try {
      appendLog('EXPORT', '检查 Remotion 服务可用性...');
      const health = await checkRemotionHealth();
      if (health.status !== 'ok') {
        toast.error('Remotion 服务异常，请先启动本地服务（端口 18093）', 4000);
        appendLog('ERROR', `Remotion 健康检查失败：${health.status}`);
        return;
      }
      if (!health.remotionEntryExists) {
        toast.error('Remotion 项目入口文件不存在', 4000);
        appendLog('ERROR', 'Remotion 入口文件不存在');
        return;
      }
    } catch (e: any) {
      toast.error(`Remotion 服务不可用：${e.message}`, 5000);
      appendLog('ERROR', `Remotion 服务不可用：${e.message}`);
      return;
    }

    setVideoGenerating(true);
    setVideoProgress(0);
    setVideoMessage('准备渲染...');
    setVideoUrl('');

    const totalDuration = ttsResult.totalDuration || 5;
    const caption = finalCover.title;

    // 文案成片是「一镜到底」：把整个封面作为单一镜头，配音时长 = 总时长
    // 字幕支持两种模式：
    // (1) ASR 开启：使用 Whisper 生成词级时间戳（支持卡拉OK字幕）
    // (2) ASR 关闭：按用户选择的切分模式（sentence/word/none）
    let cues: SubtitleCue[] = buildSubtitleCuesFromText(
      rawCopy,
      totalDuration,
      remotionConfig.fps,
      remotionConfig.subtitle.chunking ?? 'sentence',
    );

    if (whisperEnabled && ttsResult.mergedAudioUrl) {
      try {
        setWhisperRunning(true);
        setWhisperProgress({ done: 0, total: 1, current: 'whisper' });
        setVideoMessage('正在分析音频（Whisper ASR）...');
        appendLog('EXPORT', '▶ 启动 Whisper ASR 生成词级时间戳（支持卡拉OK字幕）');
        const asrCues = await transcribeShots(
          [
            {
              shotId: 'copy_based_main',
              audioUrl: ttsResult.mergedAudioUrl,
              caption: rawCopy,
              durationInFrames: Math.round(totalDuration * remotionConfig.fps),
              fps: remotionConfig.fps,
            },
          ],
          (done, total, current) => {
            setWhisperProgress({ done, total, current });
            setVideoMessage(`ASR 进度 ${done}/${total}`);
          }
        );
        if (asrCues['copy_based_main'] && asrCues['copy_based_main'].length > 0) {
          cues = asrCues['copy_based_main'];
          appendLog('EXPORT', `✓ ASR 完成：${cues.length} 个字幕片段（含词级时间戳）`);
          toast.success(`ASR 完成：${cues.length} 个字幕片段`, 2000);
        } else {
          appendLog('WARN', 'ASR 未返回有效 cues，使用按句均分方案');
        }
      } catch (e: any) {
        appendLog('WARN', `ASR 失败，使用按句均分方案：${e?.message || e}`);
        toast.warning(`ASR 失败：${e?.message || e}，使用按句均分方案`);
      } finally {
        setWhisperRunning(false);
        setWhisperProgress({ done: 0, total: 0, current: '' });
      }
    }

    const shot: RemotionShot = {
      id: 'copy_based_main',
      number: 1,
      caption,
      text: caption,
      imageUrl: finalCover.url,
      imageUrls: [finalCover.url],
      videoUrl: undefined,
      audioUrl: ttsResult.mergedAudioUrl,
      voiceoverAudioUrl: ttsResult.mergedAudioUrl,
      audioDurationSec: totalDuration,
      audioDurationExact: totalDuration,
      duration: totalDuration,
      textCues: cues,
      motion: remotionConfig.motion ?? 'kenBurns',
    };

    appendLog(
      'EXPORT',
      `提交渲染 · 模板：${remotionConfig.template.name} · ${remotionConfig.resolution} · ${totalDuration.toFixed(1)}秒`
    );
    if (remotionConfig.bgm.enabled) {
      appendLog('EXPORT', `♪ BGM 已启用：音量=${Math.round((remotionConfig.bgm.volume ?? 0.3) * 100)}% 淡入=${remotionConfig.bgm.fadeIn ?? 1}s 淡出=${remotionConfig.bgm.fadeOut ?? 1}s`);
    }
    if (remotionConfig.videoFilter && Object.keys(remotionConfig.videoFilter).length > 0) {
      appendLog('EXPORT', `🎨 滤镜：${Object.keys(remotionConfig.videoFilter).join(', ')}`);
    }

    try {
      const result = await renderRemotionVideo(
        {
          draftName: `copybased_${Date.now()}`,
          shots: [shot],
          config: remotionConfig,
        },
        (progress, message) => {
          setVideoProgress(progress);
          setVideoMessage(message || '处理中...');
          appendLog('EXPORT', `${progress}% · ${message}`);
        }
      );

      if (!result.success) {
        throw new Error(result.error || '渲染失败');
      }

      const fullUrl = buildRemotionUrl(result.outputUrl);
      setVideoUrl(fullUrl);
      setVideoProgress(100);
      setVideoMessage('渲染完成');
      appendLog('EXPORT', `✓ MP4 渲染完成 · ${result.resolution} · ${(result.videoSizeBytes / 1024 / 1024).toFixed(1)}MB`);

      // 直接下载
      const a = document.createElement('a');
      a.href = fullUrl;
      a.download = `copybased_${Date.now()}.mp4`;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast.success('MP4 已生成并开始下载', 3000);
    } catch (e: any) {
      appendLog('ERROR', `MP4 渲染失败：${e.message}`);
      toast.error(`MP4 渲染失败：${e.message}`, 5000);
    } finally {
      setVideoGenerating(false);
    }
  }, [finalCover, ttsResult, remotionConfig, rawCopy, toast, appendLog, whisperEnabled]);

  // ──────────────────────────────────────────────
  // 重置
  // ──────────────────────────────────────────────
  const handleReset = useCallback(() => {
    if (!confirm('重置会清空所有文案 / 标题 / 封面 / 配音内容，确定继续？')) return;
    appendLog('WARN', '用户点击「重置」');
    setAnalysisResult(null);
    setEditedTitles({});
    setSelectedIndices(new Set([0]));
    setFinalCoverIndex(null);
    setCharacterRefs([]);
    setGeneratedCovers(new Map());
    setLockedCoverIndices(new Set());
    setCoverErrors(new Map());
    setCoverRatio('16:9');
    setTtsResult(null);
    setTtsError(null);
    setTtsProgress(null);
    setVideoUrl('');
    setAnalysisError(null);
    setRawCopy('');
    clearPersisted();
    toast.success('已重置', 1500);
  }, [appendLog, toast]);

  // ──────────────────────────────────────────────
  // 渲染
  // ──────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* ═══════════════ 顶部 ═══════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ───────────── 左栏：文案输入 + 角色参考图 ───────────── */}
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-emerald-400" />
            <h3 className="text-lg font-bold text-emerald-300">文案输入</h3>
            <span className="text-xs text-slate-500">
              一段文案 → 一张封面 → 一段配音 → 一镜到底视频
            </span>
            <span className="ml-auto text-[10px] text-emerald-500/70 bg-emerald-500/10 px-2 py-0.5 rounded">
              v1.2 · 锁定封面 / 标题编辑 / 4 色文字特效 / 语音库 / Remotion 导出
            </span>
          </div>

          <div>
            <label className="text-xs text-slate-400 font-semibold mb-1 block">
              你的文案（500 字以上最佳）
            </label>
            <textarea
              value={rawCopy}
              onChange={(e) => setRawCopy(e.target.value.slice(0, SCRIPT_MAX_LEN))}
              disabled={analyzing}
              rows={10}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500 resize-y min-h-[200px]"
              placeholder="粘贴或输入需要做成视频的文案/口播稿...建议 300-3000 字，系统会切 5 段并行配音。"
            />
            <div className="flex items-center justify-between mt-1">
              <span
                className={`text-[10px] ${
                  charCount > SCRIPT_MAX_LEN * 0.9 ? 'text-amber-400' : 'text-slate-500'
                }`}
              >
                {charCount} / {SCRIPT_MAX_LEN}
              </span>
              <button
                onClick={handleReset}
                className="text-[10px] text-slate-500 hover:text-slate-300 underline"
                type="button"
              >
                重置
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 font-semibold mb-1 block">
              角色参考图（可选，最多 3 张）
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {characterRefs.map((url, idx) => (
                <div key={idx} className="relative w-16 h-16 rounded overflow-hidden border border-slate-600">
                  <img src={url} alt={`ref ${idx + 1}`} className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeRef(idx)}
                    className="absolute top-0 right-0 bg-red-500 text-white p-0.5 rounded-bl"
                    type="button"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              {characterRefs.length < 3 && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={analyzing}
                  className="w-16 h-16 flex flex-col items-center justify-center bg-slate-900 border border-dashed border-slate-600 rounded hover:border-emerald-500 text-slate-500 hover:text-emerald-400 text-[10px]"
                  type="button"
                >
                  <Upload size={16} />
                  <span className="mt-0.5">上传</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleUploadRef}
                className="hidden"
              />
            </div>
            <p className="text-[10px] text-slate-500 mt-1">
              上传人物参考图后，封面生成时会锁定人物面部特征
            </p>
          </div>

          <button
            onClick={handleAnalyze}
            disabled={analyzing || rawCopy.trim().length < 50}
            className="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            type="button"
          >
            {analyzing ? (
              <>
                <Loader2 size={18} className="animate-spin" /> AI 解析中...
              </>
            ) : (
              <>
                <Wand2 size={18} /> 智能解析 → 生成 6 套方案
              </>
            )}
          </button>

          {analysisError && (
            <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300 flex items-start gap-1">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{analysisError}</span>
            </div>
          )}
        </div>

        {/* ───────────── 右栏：方案 + 人物 + 比例 + 批量封面 ───────────── */}
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Zap size={18} className="text-amber-400" />
              <h3 className="text-lg font-bold text-amber-300">方案选择 + 批量生成封面</h3>
            </div>
            {/* 封面比例选择 */}
            <div className="flex items-center gap-1 bg-slate-900 border border-slate-700 rounded p-0.5">
              {COVER_RATIOS.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setCoverRatio(r.id);
                    // v1.10：封面比例联动视频模板分辨率
                    const ratioToRes: Record<string, string> = {
                      '9:16': '1080x1920',
                      '3:4': '1080x1920',
                      '4:3': '1080x1080',
                      '16:9': '1920x1080',
                    };
                    const newRes = ratioToRes[r.id];
                    if (newRes) {
                      setRemotionConfig((c) => {
                        const tpl = REMOTION_TEMPLATES.find((t) => t.resolution === newRes);
                        return {
                          ...c,
                          resolution: newRes,
                          template: tpl
                            ? {
                                ...c.template,
                                id: tpl.id,
                                name: tpl.name,
                                resolution: tpl.resolution,
                                defaultFontSize: tpl.defaultFontSize,
                                defaultColor: tpl.defaultColor,
                                fontFamily: tpl.fontFamily,
                                defaultSubtitlePosition: tpl.defaultSubtitlePosition,
                                fontSizeScale: tpl.fontSizeScale,
                                recommendedMotion: tpl.recommendedMotion,
                              }
                            : c.template,
                        };
                      });
                    }
                    appendLog('IMG', `切换封面比例 → ${r.label}（${r.w}×${r.h}）`);
                  }}
                  className={`text-[10px] px-2 py-1 rounded font-semibold ${
                    coverRatio === r.id
                      ? 'bg-amber-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  type="button"
                  title={`${r.w}×${r.h}`}
                >
                  {r.id}
                </button>
              ))}
            </div>
          </div>

          {/* 6 套方案（多选） */}
          {analysisResult && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">
                点击卡片多选（已选 {selectedIndices.size} / 6）· 标题可直接编辑 · 封面可锁定不重新生成 · 每条方案按封面赛道 A~F 6 种构图方向差异化（场景沉浸/极简底/高反差特写/纵向分屏/信息图数据牌/人像+大字横幅）
              </div>
              <div className="grid grid-cols-1 gap-2">
                {liveTitleOptions.map((opt, idx) => {
                  const originalTitle = analysisResult.titleOptions[idx].title;
                  const currentTitle = opt.title;
                  const isTitleEdited = currentTitle !== originalTitle;
                  const isSelected = selectedIndices.has(idx);
                  const hasCover = generatedCovers.has(idx);
                  const isGenerating = coversGenerating.has(idx);
                  const isLocked = lockedCoverIndices.has(idx);
                  const errMsg = coverErrors.get(idx);
                  const isFinal = finalCoverIndex === idx;
                  return (
                    <div
                      key={idx}
                      className={`text-left p-2.5 rounded-lg border-2 transition-all ${
                        isFinal
                          ? 'border-emerald-400 bg-emerald-900/40 shadow-md'
                          : isSelected
                          ? 'border-amber-400 bg-amber-900/20'
                          : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'
                      }`}
                    >
                      {/* 顶部：风格 + 状态标签 + 锁定按钮 + 单独生成封面按钮 */}
                      <div className="flex items-center justify-between mb-1 gap-1">
                        <button
                          onClick={() => toggleSelectIndex(idx)}
                          className="flex items-center gap-2 flex-1 text-left min-w-0"
                          type="button"
                        >
                          <span className="text-sm font-bold text-amber-300 shrink-0">
                            {opt.emoji} 方案{opt.schemeId || ['A', 'B', 'C', 'D', 'E', 'F'][idx % 6]} · {opt.styleTag}
                          </span>
                          <div className="flex items-center gap-1 flex-wrap">
                            {isFinal && (
                              <span className="text-[10px] px-1.5 bg-emerald-600 text-white rounded font-bold">
                                终选
                              </span>
                            )}
                            {hasCover && !isFinal && (
                              <span className="text-[10px] px-1.5 bg-slate-700 text-slate-300 rounded">
                                已生成
                              </span>
                            )}
                            {isGenerating && (
                              <span className="text-[10px] px-1.5 bg-amber-600/80 text-white rounded flex items-center gap-1">
                                <Loader2 size={8} className="animate-spin" />
                                生成中
                              </span>
                            )}
                            {isTitleEdited && (
                              <span className="text-[10px] px-1.5 bg-blue-700/50 text-blue-200 rounded">
                                已编辑
                              </span>
                            )}
                            {isSelected && !isFinal && (
                              <Check size={16} className="text-amber-400" />
                            )}
                          </div>
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          {/* 锁定按钮（仅在已生成封面时显示） */}
                          {hasCover && (
                            <button
                              onClick={() => toggleLockCover(idx)}
                              className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 ${
                                isLocked
                                  ? 'bg-emerald-600/30 border border-emerald-500/60 text-emerald-300'
                                  : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                              }`}
                              type="button"
                              title={isLocked ? '已锁定：批量生成时不会重新生成' : '未锁定：批量生成时将重新生成'}
                            >
                              {isLocked ? <Lock size={10} /> : <Unlock size={10} />}
                              {isLocked ? '已锁定' : '未锁'}
                            </button>
                          )}
                          {/* 单独生成封面按钮 */}
                          <button
                            onClick={() => handleGenerateOneCover(idx)}
                            disabled={isGenerating}
                            className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 ${
                              isGenerating
                                ? 'bg-amber-600/40 text-amber-200 cursor-wait'
                                : hasCover
                                ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                                : 'bg-gradient-to-r from-amber-600 to-orange-600 text-white hover:from-amber-500 hover:to-orange-500'
                            }`}
                            type="button"
                            title={isGenerating ? '正在生成中...' : hasCover ? '单独重新生成这张封面' : '只为这个方案生成封面'}
                          >
                            {isGenerating ? (
                              <>
                                <Loader2 size={10} className="animate-spin" />
                                生成中
                              </>
                            ) : (
                              <>
                                <ImageIcon size={10} />
                                {hasCover ? '重生' : '生成封面'}
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* 方案标识（封面赛道 A~F 模板） */}
                      <div className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                        <span className="px-1.5 py-0.5 bg-slate-800 rounded font-mono font-bold">
                          VAR {opt.schemeId || ['A', 'B', 'C', 'D', 'E', 'F'][idx % 6]}
                        </span>
                        <span className="text-slate-500">{opt.schemeName || ''}</span>
                      </div>

                      {/* 标题可编辑 */}
                      <div className="flex items-start gap-1 mt-1">
                        <textarea
                          value={currentTitle}
                          onChange={(e) => updateTitle(idx, e.target.value)}
                          rows={2}
                          className={`flex-1 text-sm font-medium leading-snug bg-slate-950/60 border rounded px-2 py-1 resize-none break-words transition-colors ${
                            isTitleEdited
                              ? 'border-blue-500/60 text-blue-100'
                              : 'border-slate-700 text-slate-100 focus:border-emerald-500'
                          }`}
                          placeholder="标题（可编辑）"
                        />
                        <div className="flex flex-col gap-0.5">
                          <button
                            onClick={() => copyTitle(currentTitle)}
                            className="text-slate-400 hover:text-emerald-400 p-1"
                            type="button"
                            title="复制标题"
                          >
                            <CopyIcon size={12} />
                          </button>
                          {isTitleEdited && (
                            <button
                              onClick={() => resetTitle(idx)}
                              className="text-slate-400 hover:text-amber-400 p-1"
                              type="button"
                              title="还原原始标题"
                            >
                              <Save size={12} />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="text-[10px] text-slate-500 flex flex-wrap gap-1 mt-1">
                        {opt.styleKeywords.map((k, i) => (
                          <span key={i} className="bg-slate-800 px-1.5 py-0.5 rounded">
                            {k}
                          </span>
                        ))}
                      </div>

                      {/* 错误提示 */}
                      {errMsg && (
                        <div className="bg-red-900/30 border border-red-700 rounded p-1.5 text-[10px] text-red-300 mt-1">
                          {errMsg}
                        </div>
                      )}

                      {/* 单张封面图（如果有，或者正在生成中） */}
                      {(hasCover || isGenerating) && (
                        <div className="mt-2 space-y-1.5">
                          <div
                            className={`relative border-2 rounded-lg overflow-hidden bg-slate-950 ${
                              isFinal ? 'border-emerald-400' : 'border-slate-600'
                            } ${COVER_RATIO_CLASSES[coverRatio] ?? 'aspect-video'}`}
                          >
                            {hasCover && (
                              <img
                                src={generatedCovers.get(idx)!.url}
                                alt={`封面 ${idx + 1}`}
                                className={`w-full block transition-opacity duration-300 ${
                                  isGenerating ? 'opacity-30' : 'opacity-100'
                                }`}
                              />
                            )}
                            {isGenerating && (
                              <div className="absolute inset-0 flex flex-col items-center justify-center text-xs text-white bg-black/40">
                                <Loader2 size={20} className="animate-spin mb-1" />
                                <span className="font-semibold">正在生成封面...</span>
                                <span className="text-[10px] text-slate-300 mt-0.5">
                                  {opt.styleTag}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-wrap">
                            {!isFinal && hasCover && !isGenerating && (
                              <button
                                onClick={() => handlePickFinalCover(idx)}
                                className="text-[10px] px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded flex items-center gap-1"
                                type="button"
                              >
                                <Check size={10} /> 选为终封面
                              </button>
                            )}
                            {hasCover && !isGenerating && (
                              <>
                                <button
                                  onClick={() => handleDownloadCover(generatedCovers.get(idx)!)}
                                  className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1"
                                  type="button"
                                >
                                  <Download size={10} /> 下载
                                </button>
                                <button
                                  onClick={() => handleRegenerateOneCover(idx)}
                                  className="text-[10px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded"
                                  type="button"
                                  title="重新生成（强制覆盖，即使已锁定）"
                                >
                                  ↻ 重生
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 人物信息 — v1.4：可勾选（默认按"标题中提到的人物"自动勾选；未勾选不进入封面） */}
          {analysisResult && (analysisResult.characters?.length ?? 0) > 0 && (
            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-xs space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-1">
                <div className="flex items-center gap-2 text-emerald-400 font-bold">
                  <span>👤 截图位置人物</span>
                  <span className="text-[10px] text-slate-500 font-normal">
                    已选 {selectedCharacterNames.length} / {analysisResult.characters.length} 位
                    （默认按"标题里提到"勾选）
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      // 全选
                      setSelectedCharacterNames(
                        analysisResult.characters.map((c) => (c.name || '').trim()).filter(Boolean)
                      );
                    }}
                    className="text-[10px] px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded"
                    title="勾选全部"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedCharacterNames([])}
                    className="text-[10px] px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded"
                    title="全部取消（封面无人物）"
                  >
                    清空
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // 按"标题中提到的人物"重新自动勾选
                      const titlesArr = (analysisResult.titleOptions || []).map((o) => o.title);
                      const picked = pickCharactersMentionedInTitles(
                        titlesArr,
                        analysisResult.characters || []
                      );
                      setSelectedCharacterNames(picked);
                      appendLog(
                        'PARSE',
                        `↻ 重新按标题自动勾选（${picked.length}/${(analysisResult.characters || []).length}）：${picked.join('、') || '（无）'}`
                      );
                    }}
                    className="text-[10px] px-1.5 py-0.5 bg-amber-700 hover:bg-amber-600 text-white rounded"
                    title="按当前 6 条标题自动勾选提到的人名"
                  >
                    <Wand2 size={9} className="inline-block mr-0.5" /> 按标题选
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                {analysisResult.characters.map((c, i) => {
                  const name = (c.name || '').trim();
                  const isChecked = !!name && selectedCharacterNames.includes(name);
                  const isMain = i === 0;
                  return (
                    <label
                      key={`${c.name}-${i}`}
                      className={`flex items-start gap-2 rounded p-1.5 cursor-pointer transition-all ${
                        isChecked
                          ? isMain
                            ? 'bg-emerald-900/40 border border-emerald-500/60 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]'
                            : 'bg-amber-900/30 border border-amber-700/60'
                          : 'bg-slate-800/50 border border-slate-700 hover:border-slate-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!name}
                        onChange={(e) => {
                          if (!name) return;
                          if (e.target.checked) {
                            setSelectedCharacterNames((prev) =>
                              prev.includes(name) ? prev : [...prev, name]
                            );
                          } else {
                            setSelectedCharacterNames((prev) =>
                              prev.filter((n) => n !== name)
                            );
                          }
                        }}
                        className="mt-0.5 accent-emerald-500 shrink-0"
                        title={isChecked ? '将出现在封面里' : '不出现在封面里'}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0 ${
                              isMain
                                ? 'bg-emerald-600 text-white'
                                : isChecked
                                ? 'bg-amber-600 text-white'
                                : 'bg-slate-700 text-slate-300'
                            }`}
                          >
                            {isMain ? '主人物' : c.role || `人物${i + 1}`}
                          </span>
                          <span
                            className={`font-semibold truncate ${
                              isChecked ? 'text-slate-100' : 'text-slate-500 line-through'
                            }`}
                          >
                            {name || '（未提取）'}
                          </span>
                          {c.title && (
                            <span className="text-[10px] text-slate-400 truncate">
                              · {c.title}
                            </span>
                          )}
                          {!isChecked && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 text-slate-400 rounded">
                              不出现在封面
                            </span>
                          )}
                        </div>
                        {(c.visualDescription || c.dominantEmotion) && (
                          <div className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                            {c.visualDescription && (
                              <span>
                                <span className="text-slate-500">视觉：</span>
                                {c.visualDescription}
                              </span>
                            )}
                            {c.visualDescription && c.dominantEmotion && (
                              <span className="mx-1 text-slate-600">|</span>
                            )}
                            {c.dominantEmotion && (
                              <span>
                                <span className="text-slate-500">情绪：</span>
                                {c.dominantEmotion}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* 批量生成封面按钮 */}
          {analysisResult && (
            <div className="space-y-2">
              <button
                onClick={handleGenerateAllCovers}
                disabled={
                  selectedOptionList.length === 0 ||
                  coversGenerating.size > 0 ||
                  (Array.from(selectedIndices) as number[]).every((realIdx) =>
                    lockedCoverIndices.has(realIdx)
                  )
                }
                className="w-full px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
                type="button"
              >
                {coversGenerating.size > 0 ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    生成中 {coversGenerating.size} 张…
                  </>
                ) : (
                  <>
                    <ImageIcon size={16} />
                    批量生成封面（{selectedOptionList.length} 张，{coverRatio}）
                    {lockedCoverIndices.size > 0 && (
                      <span className="text-[10px] bg-emerald-500/30 px-1.5 py-0.5 rounded">
                        跳过 {lockedCoverIndices.size} 张已锁定
                      </span>
                    )}
                  </>
                )}
              </button>
              {lockedCoverIndices.size > 0 && (
                <p className="text-[10px] text-emerald-400">
                  💡 已锁定 {lockedCoverIndices.size} 张封面，批量生成时不会重新生成；如需重新生成请点击单张的「↻ 重新生成」按钮（强制覆盖）
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════ 中部：5 段并行配音 ═══════════════ */}
      {analysisResult && (
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Mic size={18} className="text-purple-400" />
            <h3 className="text-lg font-bold text-purple-300">5 段并行配音</h3>
            <span className="text-xs text-slate-500">
              将用户原文完整切成 5 段，5 个 RunningHub TTS 任务同时跑（5倍提速）
            </span>
            <button
              onClick={() => setShowVoiceLibrary(true)}
              className="ml-auto text-[11px] px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded flex items-center gap-1"
              type="button"
              title="管理参考音色（多镜头分镜的语音库）"
            >
              <Volume2 size={12} />
              {selectedVoice ? `音色：${selectedVoice.name}` : '管理语音库'}
            </button>
          </div>

          {/* 配音文案预览 */}
          <details className="bg-slate-900/50 border border-slate-700 rounded p-2">
            <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-200">
              📄 待配音文案预览（{rawCopy.trim().length} 字，点击展开）
            </summary>
            <div className="mt-2 text-xs text-slate-300 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {rawCopy.trim() || '（空）'}
            </div>
          </details>

          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerateTts}
              disabled={ttsGenerating || rawCopy.trim().length < 50}
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
              type="button"
            >
              {ttsGenerating ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> 5 段并行配音中...
                </>
              ) : (
                <>
                  <Mic size={16} /> 5 段并行配音（5倍提速 · {selectedVoice ? `使用「${selectedVoice.name}」` : '系统默认音色'}）
                </>
              )}
            </button>
            {ttsGenerating && (
              <button
                onClick={handleCancelTts}
                className="px-3 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg"
                type="button"
                title="取消"
              >
                <Square size={16} />
              </button>
            )}
          </div>

          {/* 段进度 */}
          {ttsProgress && (
            <div className="bg-slate-900/50 border border-slate-700 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">
                {ttsProgress.stage} ({ttsProgress.segmentsCompleted}/{ttsProgress.segmentsTotal})
              </div>
              <div className="flex gap-1">
                {ttsProgress.segmentsStatus.map((s, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-2 rounded ${
                      s === 'done'
                        ? 'bg-emerald-500'
                        : s === 'running'
                        ? 'bg-amber-500 animate-pulse'
                        : s === 'failed'
                        ? 'bg-red-500'
                        : 'bg-slate-700'
                    }`}
                    title={`段 ${i + 1}: ${s}`}
                  />
                ))}
              </div>
              {ttsProgress.lastLog && (
                <div className="text-[10px] text-slate-500 mt-1 truncate">
                  {ttsProgress.lastLog}
                </div>
              )}
            </div>
          )}

          {ttsError && (
            <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300">
              {ttsError}
            </div>
          )}

          {/* 合并后音频 */}
          {ttsResult && (
            <div className="bg-slate-900/50 border border-emerald-700 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-emerald-400 font-bold">
                  ✓ 配音完成 · {ttsResult.totalDuration.toFixed(1)} 秒
                  {selectedVoice && ` · 音色：${selectedVoice.name}`}
                </span>
                <a
                  href={ttsResult.mergedAudioUrl}
                  download={`tts_${Date.now()}.wav`}
                  className="text-[10px] text-blue-400 hover:text-blue-300 underline flex items-center gap-1"
                >
                  <Download size={10} /> 下载 WAV
                </a>
              </div>
              <audio controls src={ttsResult.mergedAudioUrl} className="w-full h-8" />
              <details className="text-[10px] text-slate-500">
                <summary className="cursor-pointer hover:text-slate-300">
                  段详情（共 {ttsResult.segments.length} 段）
                </summary>
                <div className="mt-1 space-y-1">
                  {ttsResult.segments.map((s) => (
                    <div key={s.index} className="flex items-start gap-1">
                      <span
                        className={`flex-shrink-0 w-4 text-center ${
                          s.success ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {s.success ? '✓' : '✗'}
                      </span>
                      <span className="text-slate-400 truncate">
                        段{s.index + 1}: {s.text.slice(0, 30)}... ({s.duration.toFixed(1)}s)
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ 底部：导出 + Remotion 设置 + 终端日志 ═══════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 导出 */}
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-3">
          <div className="flex items-center gap-2">
            <Film size={18} className="text-blue-400" />
            <h3 className="text-lg font-bold text-blue-300">导出</h3>
            <button
              onClick={() => setRemotionPanelOpen(!remotionPanelOpen)}
              className="ml-auto text-[10px] text-slate-400 hover:text-emerald-400 flex items-center gap-1"
              type="button"
              title="Remotion 渲染设置"
            >
              <SettingsIcon size={12} /> 渲染设置
            </button>
          </div>
          {finalCover ? (
            <div className="bg-slate-900/50 border border-emerald-700 rounded p-2 text-xs space-y-1">
              <div className="text-emerald-400 font-bold">✓ 终封面已选</div>
              <div className="text-slate-300 truncate">
                {finalCover.emoji} [{finalCover.styleTag}] {finalCover.title}
              </div>
            </div>
          ) : (
            <div className="bg-slate-900/50 border border-slate-700 rounded p-2 text-xs text-slate-500">
              尚未选定终封面
            </div>
          )}
          {ttsResult && (
            <div className="bg-slate-900/50 border border-emerald-700 rounded p-2 text-xs space-y-1">
              <div className="text-emerald-400 font-bold">✓ 配音已完成</div>
              <div className="text-slate-300">
                总时长：{ttsResult.totalDuration.toFixed(1)} 秒
              </div>
            </div>
          )}

          {/* Remotion 设置面板 */}
          {remotionPanelOpen && (
            <RemotionSettingsPanel
              config={remotionConfig}
              onChange={setRemotionConfig}
              appendLog={appendLog}
              cachedBgm={cachedBgm}
              bgmUploading={bgmUploading}
              onBgmUpload={handleBgmUpload}
              onBgmSelect={handleBgmSelect}
              onBgmRemove={handleBgmRemove}
              onBgmClearAll={handleBgmClearAll}
              whisperEnabled={whisperEnabled}
              onWhisperToggle={() => setWhisperEnabled((v) => !v)}
              bgmExpanded={bgmExpanded}
              onToggleBgmExpanded={() => setBgmExpanded((v) => !v)}
              filterExpanded={filterExpanded}
              onToggleFilterExpanded={() => setFilterExpanded((v) => !v)}
              motionExpanded={motionExpanded}
              onToggleMotionExpanded={() => setMotionExpanded((v) => !v)}
              subtitleStyleOpen={subtitleStyleOpen}
              onToggleSubtitleStyleOpen={() => setSubtitleStyleOpen((v) => !v)}
            />
          )}

          {/* ASR 进度提示框（导出 MP4 时显示） */}
          {whisperRunning && (
            <div className="bg-purple-900/30 border border-purple-700 rounded p-2 text-[10px] text-purple-300 flex items-center gap-1.5">
              <Loader2 size={10} className="animate-spin" />
              Whisper ASR 进行中 {whisperProgress.done}/{whisperProgress.total} ({whisperProgress.current})
            </div>
          )}

          {/* MP4 导出按钮 */}
          <button
            onClick={handleExportMp4}
            disabled={!finalCover || !ttsResult || videoGenerating}
            className="w-full px-3 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed transition-all"
            type="button"
            title={!finalCover ? '请先选定终封面' : !ttsResult ? '请先生成配音' : '导出 MP4'}
          >
            {videoGenerating ? (
              <>
                <Loader2 size={14} className="animate-spin" /> {videoProgress}% · {videoMessage || '渲染中...'}
              </>
            ) : (
              <>
                <Film size={14} /> 导出 MP4（Remotion 渲染）
              </>
            )}
          </button>

          {/* 进度条 */}
          {videoGenerating && (
            <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-blue-500 h-full transition-all duration-300"
                style={{ width: `${videoProgress}%` }}
              />
            </div>
          )}

          {/* 视频下载链接（渲染完成后） */}
          {videoUrl && !videoGenerating && (
            <a
              href={videoUrl}
              download={`copybased_${Date.now()}.mp4`}
              target="_blank"
              rel="noopener"
              className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs flex items-center justify-center gap-1"
            >
              <Download size={12} /> 下载已生成的 MP4
            </a>
          )}

          <p className="text-[10px] text-slate-500">
            视频导出走 Remotion 渲染服务（端口 18093）。模板/分辨率/字幕/转场/运动均可在「渲染设置」中调整。
          </p>
        </div>

        {/* 终端日志 */}
        <div className="lg:col-span-2 bg-slate-900 p-3 rounded-xl border border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal size={16} className="text-emerald-400" />
              <h3 className="text-sm font-bold text-emerald-300">终端日志</h3>
              <span className="text-[10px] text-slate-500">({logs.length} 条)</span>
            </div>
            <button
              onClick={clearLogs}
              className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1"
              type="button"
              title="清空日志"
            >
              <Trash2 size={10} /> 清空
            </button>
          </div>
          <div
            ref={logScrollRef}
            className="bg-black/60 rounded p-2 h-64 overflow-y-auto font-mono text-[10px] text-slate-300 space-y-0.5"
          >
            {logs.length === 0 ? (
              <div className="text-slate-600 italic">等待操作...所有任务进度、错误、警告都会记录在这里</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex items-start gap-1">
                  <span className="text-slate-600 flex-shrink-0">{log.time}</span>
                  <span
                    className={`flex-shrink-0 px-1 rounded font-bold ${
                      log.tag === 'ERROR'
                        ? 'bg-red-900/60 text-red-300'
                        : log.tag === 'WARN'
                        ? 'bg-amber-900/60 text-amber-300'
                        : log.tag === 'STAGE'
                        ? 'bg-emerald-900/60 text-emerald-300'
                        : log.tag === 'IMG'
                        ? 'bg-purple-900/60 text-purple-300'
                        : log.tag === 'TTS'
                        ? 'bg-blue-900/60 text-blue-300'
                        : log.tag === 'EXPORT'
                        ? 'bg-cyan-900/60 text-cyan-300'
                        : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    {log.tag}
                  </span>
                  <span className="break-all whitespace-pre-wrap flex-1">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 语音库弹窗 */}
      {showVoiceLibrary && (
        <VoiceLibrary
          onClose={() => {
            setShowVoiceLibrary(false);
            setSelectedVoice(getSelectedVoice());
            voiceEpochRef.current++;
          }}
          onVoicesChange={() => {
            setSelectedVoice(getSelectedVoice());
            voiceEpochRef.current++;
          }}
        />
      )}
    </div>
  );
};

// ──────────────────────────────────────────────
// Remotion 设置面板（从多镜头分镜迁移的精简版）
// ──────────────────────────────────────────────
const RemotionSettingsPanel: React.FC<{
  config: RemotionExportConfig;
  onChange: (c: RemotionExportConfig) => void;
  appendLog: (tag: LogEntry['tag'], message: string) => void;
  // BGM
  cachedBgm: BgmCacheEntry[];
  bgmUploading: boolean;
  onBgmUpload: (file: File) => void;
  onBgmSelect: (entry: BgmCacheEntry) => void;
  onBgmRemove: (entry: BgmCacheEntry) => void;
  onBgmClearAll: () => void;
  // ASR
  whisperEnabled: boolean;
  onWhisperToggle: () => void;
  bgmExpanded: boolean;
  onToggleBgmExpanded: () => void;
  filterExpanded: boolean;
  onToggleFilterExpanded: () => void;
  motionExpanded: boolean;
  onToggleMotionExpanded: () => void;
  subtitleStyleOpen: boolean;
  onToggleSubtitleStyleOpen: () => void;
}> = ({
  config,
  onChange,
  appendLog,
  cachedBgm,
  bgmUploading,
  onBgmUpload,
  onBgmSelect,
  onBgmRemove,
  onBgmClearAll,
  whisperEnabled,
  onWhisperToggle,
  bgmExpanded,
  onToggleBgmExpanded,
  filterExpanded,
  onToggleFilterExpanded,
  motionExpanded,
  onToggleMotionExpanded,
  subtitleStyleOpen,
  onToggleSubtitleStyleOpen,
}) => {
  const applyTemplate = (templateId: string) => {
    const tpl = REMOTION_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const baseFontSize = tpl.defaultFontSize ?? config.subtitle.fontSize ?? 48;
    const scaledFontSize = Math.round(baseFontSize * tpl.fontSizeScale);
    onChange({
      ...config,
      template: {
        id: tpl.id,
        name: tpl.name,
        resolution: tpl.resolution,
        defaultFontSize: tpl.defaultFontSize,
        defaultColor: tpl.defaultColor,
        fontFamily: tpl.fontFamily,
        defaultSubtitlePosition: tpl.defaultSubtitlePosition,
        fontSizeScale: tpl.fontSizeScale,
        recommendedMotion: tpl.recommendedMotion,
      },
      resolution: tpl.resolution,
      subtitle: {
        ...config.subtitle,
        fontSize: scaledFontSize,
        color: tpl.defaultColor,
        fontFamily: tpl.fontFamily,
        position: tpl.defaultSubtitlePosition,
      },
      motion: tpl.recommendedMotion ?? config.motion ?? 'kenBurns',
    });
    appendLog('EXPORT', `切换模板：${tpl.name}`);
  };

  const filter = config.videoFilter || ({} as NonNullable<typeof config.videoFilter>);
  const setFilter = (patch: Partial<NonNullable<typeof config.videoFilter>>) => {
    onChange({ ...config, videoFilter: { ...filter, ...patch } });
  };

  return (
    <div className="bg-slate-900/50 border border-blue-700/40 rounded-lg p-3 space-y-2.5">
      <div className="text-[10px] text-blue-400 font-bold mb-1 flex items-center gap-1">
        <SettingsIcon size={12} /> Remotion 渲染设置
      </div>

      {/* 模板 */}
      <div>
        <label className="text-[10px] text-slate-500 block mb-1">模板</label>
        <select
          value={config.template.id}
          onChange={(e) => applyTemplate(e.target.value)}
          className="w-full bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1 focus:outline-none focus:border-emerald-500"
        >
          {REMOTION_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {/* 分辨率 + fps */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-slate-500 block mb-1">分辨率</label>
          <select
            value={config.resolution}
            onChange={(e) => onChange({ ...config, resolution: e.target.value as any })}
            className="w-full bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1"
          >
            {(['1280x720', '1920x1080', '1080x1920', '1080x1080', '2560x1080', '3840x2160'] as const).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-slate-500 block mb-1">帧率</label>
          <select
            value={config.fps}
            onChange={(e) => onChange({ ...config, fps: Number(e.target.value) as any })}
            className="w-full bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1"
          >
            <option value={24}>24 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </div>
      </div>

      {/* ─────── 分镜运动 ─────── */}
      <div className="border-t border-slate-700 pt-2">
        <button
          onClick={onToggleMotionExpanded}
          className="w-full flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-200"
          type="button"
        >
          <span className="flex items-center gap-1">
            <Film size={11} />
            分镜运动 <span className="text-slate-500">({config.motion ?? 'kenBurns'})</span>
          </span>
          <span className="text-[10px] text-slate-500">{motionExpanded ? '收起' : '展开'}</span>
        </button>
        {motionExpanded && (
          <div className="mt-1.5 grid grid-cols-5 gap-1">
            {[
              ['none', '静止'],
              ['kenBurns', '轻微'],
              ['kenBurnsStrong', '强力'],
              ['kenBurnsSlow', '慢速'],
              ['zoomIn', '放大'],
              ['zoomOut', '缩小'],
              ['panLeft', '左移'],
              ['panRight', '右移'],
              ['panUp', '上移'],
              ['panDown', '下移'],
              ['push', '推入'],
              ['pull', '拉远'],
            ].map(([val, label]) => (
              <button
                key={val}
                onClick={() => onChange({ ...config, motion: val as any })}
                className={`text-[10px] px-1.5 py-1 rounded transition-all ${
                  config.motion === val
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
                type="button"
                title={val}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ─────── 转场 ─────── */}
      <div className="border-t border-slate-700 pt-2">
        <label className="text-[10px] text-slate-500 block mb-1">转场（单镜头一般无）</label>
        <select
          value={config.transition?.type ?? 'none'}
          onChange={(e) =>
            onChange({
              ...config,
              transition: {
                type: e.target.value as any,
                duration: config.transition?.duration ?? 0.4,
              },
            })
          }
          className="w-full bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1"
        >
          <option value="none">无（硬切）</option>
          <option value="fade">淡入淡出（最通用）</option>
          <option value="slide">滑动（左右推出）</option>
          <option value="zoom">缩放（兼容旧配置）</option>
          <option value="wipe">方向擦除（侧幕盖上）</option>
          <option value="flip">3D 翻转（深度感）</option>
          <option value="clockWipe">时钟式圆扫（科幻）</option>
          <option value="iris">圆形光圈揭开（电影感）</option>
          <option value="zoomBlur">缩放+模糊聚焦（动态）</option>
          <option value="dreamyZoom">梦幻缩放+白光（MV 感）</option>
          <option value="crossZoom">交差缩放（蒙太奇）</option>
          <option value="filmBurn">电影灼烧（复古）</option>
          <option value="ripple">水波纹扩散（梦幻）</option>
          <option value="pushCut">闪光冲击硬切（动感）</option>
          <option value="dissolve">噪点颗粒溶解（胶片）</option>
        </select>
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className="text-[10px] text-slate-500 shrink-0">时长</span>
          <input
            type="number"
            min="0.1"
            max="3"
            step="0.1"
            value={config.transition?.duration ?? 0.4}
            onChange={(e) =>
              onChange({
                ...config,
                transition: {
                  type: config.transition?.type ?? 'none',
                  duration: Number(e.target.value) || 0.4,
                },
              })
            }
            className="flex-1 bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1"
          />
          <span className="text-[10px] text-slate-500">s</span>
        </div>
      </div>

      {/* ─────── 视频滤镜 ─────── */}
      <div className="border-t border-slate-700 pt-2">
        <button
          onClick={onToggleFilterExpanded}
          className="w-full flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-200"
          type="button"
        >
          <span className="flex items-center gap-1">
            <Filter size={11} />
            视频滤镜{' '}
            <span className="text-slate-500">
              ({Object.keys(filter).length > 0 ? `${Object.keys(filter).length} 项` : '默认'})
            </span>
          </span>
          <span className="text-[10px] text-slate-500 flex items-center gap-2">
            {Object.keys(filter).length > 0 && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onChange({ ...config, videoFilter: {} });
                }}
                className="text-red-400 hover:text-red-300"
              >
                清除
              </span>
            )}
            {filterExpanded ? '收起' : '展开'}
          </span>
        </button>
        {filterExpanded && (
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {/* 模糊 */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500">模糊 (blur)</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min="0"
                  max="20"
                  step="0.5"
                  value={filter.blur ?? 0}
                  onChange={(e) => setFilter({ blur: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                  className="flex-1 accent-blue-500"
                />
                <span className="text-[9px] text-slate-400 w-7 text-right">{filter.blur ?? 0}</span>
              </div>
            </div>
            {/* 亮度 */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500">亮度 (bright)</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min="0.3"
                  max="2"
                  step="0.05"
                  value={filter.brightness ?? 1}
                  onChange={(e) => setFilter({ brightness: Number(e.target.value) !== 1 ? Number(e.target.value) : undefined })}
                  className="flex-1 accent-yellow-500"
                />
                <span className="text-[9px] text-slate-400 w-7 text-right">{(filter.brightness ?? 1).toFixed(1)}</span>
              </div>
            </div>
            {/* 对比度 */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500">对比度 (contrast)</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min="0.3"
                  max="2"
                  step="0.05"
                  value={filter.contrast ?? 1}
                  onChange={(e) => setFilter({ contrast: Number(e.target.value) !== 1 ? Number(e.target.value) : undefined })}
                  className="flex-1 accent-cyan-500"
                />
                <span className="text-[9px] text-slate-400 w-7 text-right">{(filter.contrast ?? 1).toFixed(1)}</span>
              </div>
            </div>
            {/* 饱和度 */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500">饱和度 (saturate)</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={filter.saturation ?? 1}
                  onChange={(e) => setFilter({ saturation: Number(e.target.value) !== 1 ? Number(e.target.value) : undefined })}
                  className="flex-1 accent-pink-500"
                />
                <span className="text-[9px] text-slate-400 w-7 text-right">{(filter.saturation ?? 1).toFixed(1)}</span>
              </div>
            </div>
            {/* 曝光 */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500">曝光 (exposure)</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min="-2"
                  max="2"
                  step="0.1"
                  value={filter.exposure ?? 0}
                  onChange={(e) => setFilter({ exposure: Number(e.target.value) !== 0 ? Number(e.target.value) : undefined })}
                  className="flex-1 accent-amber-500"
                />
                <span className="text-[9px] text-slate-400 w-7 text-right">{(filter.exposure ?? 0).toFixed(1)}</span>
              </div>
            </div>
            {/* 黑白 */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500">黑白 (gray)</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={filter.grayscale ?? 0}
                  onChange={(e) => setFilter({ grayscale: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                  className="flex-1 accent-slate-400"
                />
                <span className="text-[9px] text-slate-400 w-7 text-right">
                  {((filter.grayscale ?? 0) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            {/* 色温 */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500">色温 (temperature)</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={filter.temperature ?? 0.5}
                  onChange={(e) => setFilter({ temperature: Math.abs(Number(e.target.value) - 0.5) > 0.01 ? Number(e.target.value) : undefined })}
                  className="flex-1 accent-orange-500"
                />
                <span className="text-[9px] text-slate-400 w-7 text-right">{((filter.temperature ?? 0.5) * 100).toFixed(0)}</span>
              </div>
            </div>
            {/* 色相 */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500">色相旋转 (hue)</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min="0"
                  max="360"
                  step="5"
                  value={filter.hue ?? 0}
                  onChange={(e) => setFilter({ hue: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                  className="flex-1 accent-purple-500"
                />
                <span className="text-[9px] text-slate-400 w-7 text-right">{filter.hue ?? 0}°</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─────── 背景音乐 BGM ─────── */}
      <div className="border-t border-slate-700 pt-2">
        <button
          onClick={onToggleBgmExpanded}
          className="w-full flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-200"
          type="button"
        >
          <span className="flex items-center gap-1">
            <Music size={11} />
            背景音乐{' '}
            <span className={config.bgm.enabled ? 'text-emerald-400' : 'text-slate-500'}>
              ({config.bgm.enabled ? '已开启' : '关闭'})
            </span>
          </span>
          <span className="text-[10px] text-slate-500">{bgmExpanded ? '收起' : '展开'}</span>
        </button>
        {bgmExpanded && (
          <div className="mt-1.5 space-y-1.5">
            {/* 开关 */}
            <label className="flex items-center gap-1.5 cursor-pointer">
              <button
                onClick={() => onChange({ ...config, bgm: { ...config.bgm, enabled: !config.bgm.enabled } })}
                className={`w-9 h-5 rounded-full relative transition-all duration-200 ${
                  config.bgm.enabled ? 'bg-emerald-600' : 'bg-slate-600'
                }`}
                type="button"
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${
                    config.bgm.enabled ? 'left-[18px]' : 'left-0.5'
                  }`}
                />
              </button>
              <span className="text-[10px] text-slate-300">启用 BGM</span>
              {cachedBgm.length > 0 && (
                <button
                  onClick={onBgmClearAll}
                  className="ml-auto text-[9px] text-slate-500 hover:text-red-400"
                  type="button"
                >
                  清空缓存
                </button>
              )}
            </label>

            {config.bgm.enabled && (
              <div className="flex flex-col gap-1.5 pl-1">
                {/* 上传 */}
                <label className="flex items-center gap-1.5 cursor-pointer px-2 py-1 bg-slate-700/60 hover:bg-slate-700 border border-dashed border-slate-500 rounded text-[10px] text-slate-300">
                  <input
                    type="file"
                    accept="audio/mp3,audio/mpeg,audio/wav,audio/x-wav,audio/aac,audio/m4a,audio/ogg,audio/flac,.mp3,.wav,.aac,.m4a,.ogg,.flac"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onBgmUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <Upload size={11} className="text-emerald-400" />
                  <span>{bgmUploading ? '上传中...' : '本地上传（自动缓存）'}</span>
                </label>
                {/* URL */}
                <input
                  type="text"
                  placeholder="或粘贴音频 URL"
                  value={config.bgm.url?.startsWith('data:') ? '' : config.bgm.url || ''}
                  onChange={(e) => onChange({ ...config, bgm: { ...config.bgm, url: e.target.value } })}
                  className="w-full bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-2 py-1"
                />
                {/* 缓存列表 */}
                {cachedBgm.length > 0 && (
                  <div className="max-h-20 overflow-y-auto flex flex-col gap-1 bg-slate-900/40 rounded p-1">
                    {cachedBgm.map((entry) => (
                      <div
                        key={`${entry.name}-${entry.size}`}
                        className={`flex items-center gap-1 px-1.5 py-1 rounded text-[10px] ${
                          config.bgm.url === entry.dataUrl
                            ? 'bg-emerald-700/50 text-emerald-100'
                            : 'text-slate-300 hover:bg-slate-700/50'
                        }`}
                      >
                        <button
                          onClick={() => onBgmSelect(entry)}
                          className="flex-1 text-left truncate"
                          type="button"
                          title={entry.name}
                        >
                          <Music size={9} className="inline mr-1" />
                          {entry.name} ({(entry.size / 1024 / 1024).toFixed(1)}MB)
                        </button>
                        <button
                          onClick={() => onBgmRemove(entry)}
                          className="text-slate-500 hover:text-red-400"
                          type="button"
                          title="移除"
                        >
                          <X size={9} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {/* 音量 */}
                <div className="flex items-center gap-2 text-[10px] text-slate-400">
                  <span>音量</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={config.bgm.volume ?? 0.3}
                    onChange={(e) => onChange({ ...config, bgm: { ...config.bgm, volume: Number(e.target.value) } })}
                  />
                  <span className="w-9 text-right">{Math.round((config.bgm.volume ?? 0.3) * 100)}%</span>
                </div>
                {/* 淡入淡出 */}
                <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                  <span>淡入</span>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    step="0.5"
                    value={config.bgm.fadeIn ?? 1}
                    onChange={(e) => onChange({ ...config, bgm: { ...config.bgm, fadeIn: Number(e.target.value) } })}
                    className="w-12 bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-1.5 py-0.5"
                  />
                  <span>s</span>
                  <span>淡出</span>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    step="0.5"
                    value={config.bgm.fadeOut ?? 1}
                    onChange={(e) => onChange({ ...config, bgm: { ...config.bgm, fadeOut: Number(e.target.value) } })}
                    className="w-12 bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-1.5 py-0.5"
                  />
                  <span>s</span>
                </div>
                <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.bgm.loop ?? true}
                    onChange={(e) => onChange({ ...config, bgm: { ...config.bgm, loop: e.target.checked } })}
                    className="accent-emerald-500"
                  />
                  循环播放
                </label>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─────── 字幕 ─────── */}
      <div className="border-t border-slate-700 pt-2">
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 cursor-pointer group">
            <button
              onClick={() => onChange({ ...config, subtitle: { ...config.subtitle, enabled: !config.subtitle.enabled } })}
              className={`w-9 h-5 rounded-full relative transition-all duration-200 ${
                config.subtitle.enabled ? 'bg-emerald-600' : 'bg-slate-600 group-hover:bg-slate-500'
              }`}
              type="button"
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${
                  config.subtitle.enabled ? 'left-[18px]' : 'left-0.5'
                }`}
              />
            </button>
            {/* v1.10：与「多镜头分镜」页面 label 同步为「字幕（按句切分）」 */}
            <span className="text-[10px] text-slate-200">字幕（按句切分）</span>
          </label>
          {config.subtitle.enabled && (
            <button
              onClick={onToggleSubtitleStyleOpen}
              type="button"
              className="text-[9px] text-slate-500 hover:text-slate-300"
            >
              {subtitleStyleOpen ? '收起样式' : '样式'}
            </button>
          )}
        </div>
        {/* v1.10：字幕切分模式选择器（按句 / 按词 / 不切分） */}
        {config.subtitle.enabled && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="text-[9px] text-slate-400">切分模式</span>
            <div className="flex gap-0.5 ml-auto">
              {(['sentence', 'word', 'none'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChange({ ...config, subtitle: { ...config.subtitle, chunking: mode } })}
                  className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                    (config.subtitle.chunking ?? 'sentence') === mode
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                  title={
                    mode === 'sentence' ? '按句切分（中文/英文标点，业界默认）'
                      : mode === 'word' ? '按词切分（适合英文 ASR / 卡拉 OK）'
                      : '不切分（整段字幕，适合标题卡片）'
                  }
                >
                  {mode === 'sentence' ? '按句' : mode === 'word' ? '按词' : '不分'}
                </button>
              ))}
            </div>
          </div>
        )}
        {config.subtitle.enabled && (
          <div className="mt-1.5 flex flex-col gap-1.5 pl-1">
            {/* 字幕样式 */}
            <div className="grid grid-cols-2 gap-1.5">
              <select
                value={config.subtitle.style}
                onChange={(e) =>
                  onChange({
                    ...config,
                    subtitle: { ...config.subtitle, style: e.target.value as any },
                  })
                }
                className="bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-2 py-1"
              >
                {SUBTITLE_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select
                value={config.subtitle.position}
                onChange={(e) =>
                  onChange({
                    ...config,
                    subtitle: { ...config.subtitle, position: e.target.value as any },
                  })
                }
                className="bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-2 py-1"
              >
                <option value="top">顶部</option>
                <option value="middle">中间</option>
                <option value="bottom">底部</option>
              </select>
            </div>
            {/* ASR 开关 */}
            <button
              onClick={onWhisperToggle}
              type="button"
              className={`flex items-center gap-1.5 px-2 py-1 text-[10px] rounded border transition-all ${
                whisperEnabled
                  ? 'bg-purple-600 border-purple-400 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles size={10} />
              {whisperEnabled ? 'Whisper ASR 已开启（词级时间戳）' : '开启 Whisper ASR（词级时间戳）'}
            </button>
            {/* 字幕样式详情 */}
            {subtitleStyleOpen && (
              <div className="flex flex-col gap-1.5 bg-slate-900/40 rounded p-2">
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-slate-500">字号 (px)</span>
                    <input
                      type="number"
                      min="12"
                      max="200"
                      value={config.subtitle.fontSize ?? 48}
                      onChange={(e) =>
                        onChange({
                          ...config,
                          subtitle: { ...config.subtitle, fontSize: Number(e.target.value) },
                        })
                      }
                      className="w-full bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-1.5 py-0.5"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-slate-500">颜色</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="color"
                        value={config.subtitle.color || '#ffffff'}
                        onChange={(e) =>
                          onChange({
                            ...config,
                            subtitle: { ...config.subtitle, color: e.target.value },
                          })
                        }
                        className="w-6 h-6 bg-slate-700 border border-slate-600 rounded"
                      />
                      <input
                        type="text"
                        value={config.subtitle.color || '#ffffff'}
                        onChange={(e) =>
                          onChange({
                            ...config,
                            subtitle: { ...config.subtitle, color: e.target.value },
                          })
                        }
                        className="flex-1 bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-1.5 py-0.5"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-slate-500">字体</span>
                  <select
                    value={config.subtitle.fontFamily || ''}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        subtitle: { ...config.subtitle, fontFamily: e.target.value },
                      })
                    }
                    className="w-full bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-1.5 py-0.5"
                  >
                    <option value="">默认（PingFang SC）</option>
                    <option value='"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif'>苹方 / 微软雅黑</option>
                    <option value='"Source Han Sans SC","Noto Sans CJK SC",sans-serif'>思源黑体</option>
                    <option value='"Source Han Serif SC","Noto Serif CJK SC",serif'>思源宋体</option>
                    <option value='"STKaiti","KaiTi","Songti SC",serif'>楷体 / 宋体</option>
                    <option value='"Microsoft YaHei",sans-serif'>微软雅黑</option>
                    <option value='"SimHei","Heiti SC",sans-serif'>黑体</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-slate-500">描边粗细 (px)</span>
                    <input
                      type="number"
                      min="0"
                      max="10"
                      step="0.5"
                      value={config.subtitle.strokeWidth ?? 2}
                      onChange={(e) =>
                        onChange({
                          ...config,
                          subtitle: { ...config.subtitle, strokeWidth: Number(e.target.value) },
                        })
                      }
                      className="w-full bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-1.5 py-0.5"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-slate-500">描边颜色</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="color"
                        value={config.subtitle.strokeColor || '#000000'}
                        onChange={(e) =>
                          onChange({
                            ...config,
                            subtitle: { ...config.subtitle, strokeColor: e.target.value },
                          })
                        }
                        className="w-6 h-6 bg-slate-700 border border-slate-600 rounded"
                      />
                      <input
                        type="text"
                        value={config.subtitle.strokeColor || '#000000'}
                        onChange={(e) =>
                          onChange({
                            ...config,
                            subtitle: { ...config.subtitle, strokeColor: e.target.value },
                          })
                        }
                        className="flex-1 bg-slate-700 border border-slate-600 text-slate-200 text-[10px] rounded px-1.5 py-0.5"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─────── 字幕防遮挡 ─────── */}
      <div className="border-t border-slate-700 pt-2">
        <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-slate-300">
          <input
            type="checkbox"
            checked={config.safeZoneDetection ?? false}
            onChange={(e) => onChange({ ...config, safeZoneDetection: e.target.checked })}
            className="accent-emerald-500"
          />
          <span>字幕防遮挡（自动避开主体）</span>
        </label>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────
// 默认 Remotion 配置
// ──────────────────────────────────────────────
function buildDefaultRemotionConfig(): RemotionExportConfig {
  return {
    template: {
      id: 'landscape_default',
      name: '横屏默认（1920×1080）',
      resolution: '1920x1080',
      defaultFontSize: 48,
      defaultColor: '#ffffff',
      fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
      defaultSubtitlePosition: 'bottom',
      fontSizeScale: 1.0,
      recommendedMotion: 'kenBurns',
    },
    resolution: '1920x1080',
    fps: 30,
    codec: 'h264',
    bgm: { enabled: false, volume: 0.3, fadeIn: 1, fadeOut: 1, loop: true },
    subtitle: {
      enabled: true,
      style: 'default',
      position: 'bottom',
      fontSize: 48,
      color: '#ffffff',
      fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif',
      fontWeight: 700,
      letterSpacing: 0,
      lineHeight: 1.4,
      paddingX: 24,
      paddingY: 8,
      strokeColor: '#000000',
      strokeWidth: 2,
      shadow: true,
      shadowBlur: 6,
      shadowColor: 'rgba(0,0,0,0.75)',
      fadeInFrames: 9,
      fadeOutFrames: 9,
      altColor: '#ffe600',
      preset: 'spring',
      chunking: 'sentence',
    },
    transition: { type: 'none', duration: 0.4 },
    motion: 'kenBurns',
    safeZoneDetection: false,
    videoFilter: {},
    output: { target: 'download' },
  };
}

// ──────────────────────────────────────────────
// 字幕 cue 构建（v1.10：支持 sentence/word/none 三种切分模式）
// ──────────────────────────────────────────────
function buildSubtitleCuesFromText(
  text: string,
  totalSec: number,
  fps: number,
  chunking: 'sentence' | 'word' | 'none' = 'sentence',
): SubtitleCue[] {
  const totalFrames = Math.round(totalSec * fps);
  if (!text.trim() || totalFrames <= 0) return [];
  // 复用 remotion 模块的 buildSubtitleCues（支持三种切分模式 + gapFrames 间隔）
  return buildSubtitleCues(text, totalFrames, fps, undefined, chunking);
}

export default CopyBasedPanel;
