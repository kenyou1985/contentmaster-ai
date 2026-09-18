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
  Plus,
  GripVertical,
  FileVideo,
  FileAudio,
  ArrowUp,
  ArrowDown,
  Search,
  Replace,
  ChevronDown,
  ChevronUp,
  Link2,
  ClipboardList,
  CheckCircle,
  Scissors,
  PartyPopper,
} from 'lucide-react';
import { useToast } from './Toast';
import { VoiceLibrary } from './VoiceLibrary';
import { generateImage, imageGenLimiter } from '../services/yunwuService';
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
import { optimizeSubtitles } from '../services/subtitleOptimizer';
import { prewarmFfmpeg } from '../services/audioExtractor';
import { extractScriptFromUrl, ExtractError } from '../services/scriptExtractor';
import { transcribeVideoFile, transcribeVideoFromUrl } from '../services/scriptExtractor/adapters/douyin';
import {
  CustomTracksPanel,
  createEmptyCustomTracksState,
  type CustomTracksState,
} from './CustomTracksPanel';
import type {
  RemotionExportConfig,
  RemotionShot,
  SubtitleCue,
} from '../services/remotionRenderTypes';
// v1.10：复用 remotion 模块的字幕切分工具（支持 sentence/word/none 三种模式）
import { buildSubtitleCues } from '../remotion/src/compositions/subtitleCues';
// 一键剪映：把当前面板的素材链路转成剪映草稿
import {
  exportJianyingDraft,
  type JianyingShot,
} from '../services/jianyingExportService';
import {
  getLocalCachePaths,
  saveMediaToLocalCache,
} from '../services/localMediaCacheService';

// v11.0：移除文案字数上限（之前 8000 字）；textarea / 视频 ASR / URL 提取都不再截断
// const SCRIPT_MAX_LEN = 8000; // 已废弃：用户要求完全不限字数

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
  // 用所有标题拼接成一个查找源，覆盖 7 套方案不同角度
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
// 注意：4:3 使用 1440x1080（1920x1080 的 3/4），保持像素为 16 的倍数
const COVER_RATIOS = [
  { id: '16:9', label: '16:9 横屏', w: 1920, h: 1080 },
  { id: '9:16', label: '9:16 竖屏', w: 1088, h: 1920 },
  { id: '1:1', label: '1:1 方图', w: 1024, h: 1024 },
  { id: '4:3', label: '4:3 标屏', w: 1440, h: 1080 },
  { id: '3:4', label: '3:4 海报', w: 1088, h: 1440 },
] as const;

/** 固定封面赛道名称（7 种方案模板，对应 A~G）；用于 UI 展示，不依赖 LLM 生成 */
export const COVER_SCHEME_NAMES: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', string> = {
  A: '场景沉浸',
  B: '极简底',
  C: '高反差特写',
  D: '纵向分屏',
  E: '信息图/数据牌',
  F: '人像+大字横幅',
  G: '长文案/复仇海报',
};

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
  // v11.0 新增：本次解析要生成哪几套方案（A~G），用于控制 LLM 输出规模 + 节省 token
  enabledSchemes?: string[];
  // v1.10 新增：模式开关 + 自定义素材轨道（blob URL 不能序列化，仅持久化字幕文本）
  mode?: 'ai' | 'custom';
  customTracks?: {
    videoItems: Array<{
      id: string;
      kind: 'image' | 'video';
      url: string;
      name: string;
      mime: string;
      size: number;
      durationSec?: number;
      width?: number;
      height?: number;
      overrideDurationSec?: number;
      caption?: string;
    }>;
    audioUrl?: string;
    audioName?: string;
    audioDurationSec?: number;
    subtitleCues: Array<{ startSec: number; endSec: number; text: string }>;
    subtitleFileName?: string;
    subtitleEnabled: boolean;
  };
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
  /** v1.6：所属方案 A~G（封面赛道模板，含长文案/复仇海报） */
  schemeId?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  /** v1.4：方案中文名 */
  schemeName?: string;
  /** 监控用：生成时的封面比例 ID（'16:9' | '9:16' | ...） */
  ratio?: string;
  /** 监控用：base64 解码头读出的实际像素宽（null = 远程 URL） */
  actualWidth?: number | null;
  /** 监控用：base64 解码头读出的实际像素高（null = 远程 URL） */
  actualHeight?: number | null;
}

interface LogEntry {
  id: string;
  time: string;
  tag: string; // 'INFO' | 'WARN' | 'ERROR' | 'STAGE' | 'TTS' | 'IMG' | 'PARSE' | 'EXPORT'
  message: string;
}

// ── 方案数 → Prompt 动态构建 ───────────────────────────
/**
 * 根据用户选定的方案数 N (1~7)，动态裁剪 COPY_ANALYSIS_PROMPT：
 *  - 替换硬编码的"7 套"→"{N} 套"
 *  - 删除超出 N 的方案占位行（G/F/E/...）
 *  - 删除"- titleOptions[i] → 方案 X"说明
 *  - 删除"方案 G 专属铁律"段落（仅当 count < 7 时）
 *
 * 目的：让 LLM 只输出 N 套方案，节省 token、缩短延迟、并允许用户灵活控制规模。
 *
 * @param count 用户选定的方案数（1~7），> 7 时返回原 prompt 不做裁剪
 * @param basePrompt 原始 COPY_ANALYSIS_PROMPT（从 constants.ts 导入）
 * @returns 裁剪后的 prompt
 */
function buildAnalysisPrompt(count: number, basePrompt: string): string {
  if (!Number.isFinite(count) || count >= 7) return basePrompt;

  const schemeChars = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
  const lastChar = schemeChars[Math.max(0, Math.min(count, 7) - 1)];
  const safeCount = Math.max(1, Math.min(count, 7));

  let p = basePrompt;

  // ── 1) 替换硬编码的"7"为动态 count ──
  p = p.replace(/输出\s*\*\*7\s*套/g, `输出 **${safeCount} 套`);
  p = p.replace(/7\s*套方案/g, `${safeCount} 套方案`);
  p = p.replace(/对应\s*A~G\s*方案/g, `对应 A~${lastChar} 方案`);
  p = p.replace(/严禁输出少于\s*7\s*套/g, `严禁输出少于 ${safeCount} 套`);
  p = p.replace(/7\s*条 prompt 必须彼此差异巨大/g, `${safeCount} 条 prompt 必须彼此差异巨大`);
  p = p.replace(
    /【7\s*套风格标签池（必须 7 种不同）】/g,
    `【${safeCount} 套风格标签池（必须 ${safeCount} 种不同）】`
  );

  // ── 2) 删除 titleOptions 模板中超出 count 的方案行 ──
  // 单行格式（C~G）：{ "schemeId": "X", "schemeName": "...", "...": "..." },
  // 多行格式（A, B 是多行兜底）：从 "schemeId": "X" 到 "coverDescriptionZh": "..." 结束
  for (let i = 7; i > safeCount; i--) {
    const ch = schemeChars[i - 1];
    // 单行简略格式（C~G 用此写法）
    const reSingle = new RegExp(
      `\\s*\\{\\s*"schemeId":\\s*"${ch}",\\s*"schemeName":\\s*"[^"]+",\\s*"\\.\\.\\.":\\s*"\\.\\.\\."\\s*\\},?`,
      'g'
    );
    p = p.replace(reSingle, '');
    // 多行完整格式（A, B 是多行；本应删不到，但兜底兼容）
    const reMulti = new RegExp(
      `\\s*\\{\\s*"schemeId":\\s*"${ch}",[\\s\\S]*?"coverDescriptionZh":\\s*"[^"]*"\\s*\\},?`,
      'g'
    );
    p = p.replace(reMulti, '');
  }

  // ── 3) 删除"方案对应关系"列表中超出 count 的方案说明 ──
  // - titleOptions[3] → 方案 D（纵向分屏）: ...
  for (let i = safeCount; i < 7; i++) {
    const ch = schemeChars[i];
    const re = new RegExp(`\\s*- titleOptions\\[${i}\\] → 方案 ${ch}[^\\n]*\\n?`, 'g');
    p = p.replace(re, '');
  }

  // ── 4) 删除"方案 G 专属铁律"段落（仅当 count < 7 时） ──
  if (safeCount < 7) {
    const startMarker = '**⭐⭐⭐ 方案 G 专属铁律';
    const startIdx = p.indexOf(startMarker);
    if (startIdx >= 0) {
      // 下一段以 "\n\n【" 或 "\n\n#" 开头
      const afterStart = p.slice(startIdx);
      const nextSectionMatch = afterStart.match(/\n\n(?=【|\[|#)/);
      if (nextSectionMatch && nextSectionMatch.index !== undefined) {
        const endIdx = startIdx + nextSectionMatch.index;
        p = p.slice(0, startIdx) + p.slice(endIdx);
      } else {
        // 兜底：截到字符串末尾
        p = p.slice(0, startIdx);
      }
    }
  }

  return p;
}

const CopyBasedPanel: React.FC<{
  apiKey: string;
  runningHubApiKey: string;
  /**
   * v11.1：组件变体
   *  - 'full'（默认）：完整的文案成片（输入文案 → 封面 → 配音 → 导出 MP4）
   *  - 'cover-only'：仅显示输入文案 + 生成 7 套封面方案，隐藏配音 / 导出模块
   *                    用于独立"封面"模块入口（底部导航栏的"封面"菜单）
   */
  variant?: 'full' | 'cover-only';
}> = ({ apiKey, runningHubApiKey, variant = 'full' }) => {
  const isCoverOnly = variant === 'cover-only';
  const toast = useToast();
  const initial = useMemo(() => loadPersisted(), []);

  // ──────────────────────────────────────────────
  // 状态
  // ──────────────────────────────────────────────
  // ── v1.10 模式开关：'ai' = AI 一键成片；'custom' = 自定义素材成片 ──
  const [mode, setMode] = useState<'ai' | 'custom'>(() => {
    return (initial.mode as 'ai' | 'custom') || 'ai';
  });
  // ── 自定义素材成片状态（仅 mode='custom' 时使用）──
  const [customTracks, setCustomTracks] = useState<CustomTracksState>(() => {
    return initial.customTracks || createEmptyCustomTracksState();
  });

  const [rawCopy, setRawCopy] = useState<string>(initial.rawCopy ?? '');
  const [analysisResult, setAnalysisResult] = useState<CopyAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  /** v2.0：智能解析前勾选"同时生成5段并行配音"，解析完成后自动开始配音 */
  const [parallelTtsEnabled, setParallelTtsEnabled] = useState<boolean>(false);

  // v2.2：手动上传音频（单段）—— 上传一个完整配音音频后，5 段配音任务全部跳过 AI
  const [uploadedFullAudio, setUploadedFullAudio] = useState<string | null>(null);
  const [uploadedFullAudioBlob, setUploadedFullAudioBlob] = useState<Blob | null>(null);

  /** v10.6：链接提取文案 loading 状态（文案成片面板） */
  const [extractingUrl, setExtractingUrl] = useState<boolean>(false);

  /** v10.6.2：视频文件上传 ASR 状态 */
  const [transcribingVideo, setTranscribingVideo] = useState<boolean>(false);
  /** v10.6.3：抖音短链需要视频文件时，显示引导条 */
  const [needsVideoUpload, setNeedsVideoUpload] = useState<boolean>(false);
  /** v10.6.3：用户粘贴的无水印视频直链（从外部解析工具获取） */
  const [videoUrlInput, setVideoUrlInput] = useState<string>('');
  const extractVideoFileRef = useRef<HTMLInputElement | null>(null);

  /**
   * v10.6.2：当 extractScriptFromUrl 抛 NEEDS_VIDEO_FILE 时，由 UI 触发：
   *   - 用户点的是「提取文案」按钮，但平台拿不到 desc / play_addr
   *   - 此函数让用户上传抖音视频文件（mp4/mov），走 audioExtractor + Whisper ASR 全链路
   */
  const handleExtractVideoFile = useCallback(async (file: File) => {
    setTranscribingVideo(true);
    toast.info(`正在识别视频文案：${file.name}（Whisper ASR）...`, { autoClose: 3000 });
    try {
      const result = await transcribeVideoFile(file);
      // v11.0：解除 8000 字上限，与 textarea 一致（用户可粘贴/转写任意长度文案）
      setRawCopy(result.text);
      setNeedsVideoUpload(false);
      toast.success(`✓ 已转写 ${result.text.length} 字（${file.name}）`, { autoClose: 4000 });
    } catch (e: any) {
      const msg = e instanceof ExtractError
        ? `[${e.code}] ${e.message}`
        : (e?.message || String(e));
      console.error('[CopyBasedPanel] transcribeVideoFile failed:', e);
      toast.error(`视频转写失败：${msg}`, { autoClose: 6000 });
    } finally {
      setTranscribingVideo(false);
    }
  }, [toast]);

  /**
   * v10.6.3：从用户粘贴的「无水印视频直链」下载 + 转写
   * 适用：用户从抖音 app 下载到本地后，复制视频文件 URL（云盘/COS 链接）
   *       或从外部解析工具拿到 mp4 CDN URL
   */
  const handleExtractVideoUrl = useCallback(async () => {
    const url = videoUrlInput.trim();
    if (!url) {
      toast.warning('请粘贴视频直链');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast.warning('视频直链应以 http:// 或 https:// 开头');
      return;
    }
    setTranscribingVideo(true);
    toast.info('正在下载并转写视频文案...', { autoClose: 3000 });
    try {
      const result = await transcribeVideoFromUrl(url);
      // v11.0：解除 8000 字上限，与 textarea 一致
      setRawCopy(result.text);
      setNeedsVideoUpload(false);
      setVideoUrlInput('');
      toast.success(`✓ 已转写 ${trimmed.length} 字（视频直链）`, { autoClose: 4000 });
    } catch (e: any) {
      const msg = e instanceof ExtractError
        ? `[${e.code}] ${e.message}`
        : (e?.message || String(e));
      console.error('[CopyBasedPanel] transcribeVideoFromUrl failed:', e);
      toast.error(`视频转写失败：${msg}`, { autoClose: 6000 });
    } finally {
      setTranscribingVideo(false);
    }
  }, [videoUrlInput, toast]);

  /**
   * v10.6：链接一键提取文案（抖音 / 今日头条）
   * - 用户粘贴抖音/头条链接 → 自动识别平台 → 提取文案 → 填入 rawCopy
   * - 复用 services/scriptExtractor（与 Generator 同一套逻辑）
   */
  const handleExtractScript = useCallback(async () => {
    const raw = (rawCopy || '').trim();
    if (!raw) {
      toast.warning('请先粘贴一个抖音或今日头条链接');
      return;
    }
    setExtractingUrl(true);
    toast.info('正在提取文案（抖音 / 头条）...', { autoClose: 2000 });
    try {
      const result = await extractScriptFromUrl(raw);
      // v11.0：解除 8000 字上限，与 textarea 一致（用户可粘贴/提取任意长度文案）
      setRawCopy(result.text);
      const sourceLabel =
        result.source === 'author-desc' ? '作者手写文案' :
        result.source === 'asr' ? 'Whisper ASR 转写' :
        result.source === 'article' ? '文章正文' : '降级提取';
      toast.success(`✓ 已提取 ${trimmed.length} 字（${sourceLabel}）`, { autoClose: 3000 });
    } catch (e: any) {
      // v10.6.3：抖音适配器拿不到 desc + play_addr 时，弹引导条让用户选「上传文件」或「粘贴视频 URL」
      if (e instanceof ExtractError && e.code === 'NEEDS_VIDEO_FILE') {
        toast.warning(e.message, { autoClose: 6000 });
        // 标记需要引导视频输入（不自动 click file input，避免误以为打开访达）
        setNeedsVideoUpload(true);
      } else {
        const msg = e instanceof ExtractError
          ? `[${e.code}] ${e.message}`
          : (e?.message || String(e));
        console.error('[CopyBasedPanel] extractScript failed:', e);
        toast.error(`提取失败：${msg}`, { autoClose: 5000 });
      }
    } finally {
      setExtractingUrl(false);
    }
  }, [rawCopy, toast]);

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
  // v2.2 / v11.1：手动上传音频的 input ref（label 包裹 input 在某些浏览器
  // 点击不触发 file picker，改用 button + ref 模式更可靠）
  const audioInputRef = useRef<HTMLInputElement>(null);

  /** 比例 */
  const [coverRatio, setCoverRatio] = useState<CoverRatioId>(
    (initial.coverRatio as CoverRatioId) ?? '16:9'
  );

  /** v11.0：本次解析要生成哪几套方案（A~G），默认全选 7 个。
   *  - 用户通过「方案选择器」勾选哪些方案参与生成
   *  - 持久化到 localStorage，刷新页面保留 */
  const [enabledSchemes, setEnabledSchemes] = useState<Set<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'>>(() => {
    const storedArr = initial.enabledSchemes;
    if (Array.isArray(storedArr) && storedArr.length >= 1 && storedArr.length <= 7) {
      const valid = storedArr.filter((s): s is 'A'|'B'|'C'|'D'|'E'|'F'|'G' =>
        ['A','B','C','D','E','F','G'].includes(s)
      );
      if (valid.length >= 1) return new Set(valid as ('A'|'B'|'C'|'D'|'E'|'F'|'G')[]);
    }
    return new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G'] as ('A'|'B'|'C'|'D'|'E'|'F'|'G')[]);
  });
  const schemeCount = enabledSchemes.size;

  /** 动态裁剪后的 LLM Prompt（按 enabledSchemes 即时裁剪） */
  const dynamicAnalysisPrompt = useMemo(
    () => buildAnalysisPrompt(schemeCount, COPY_ANALYSIS_PROMPT),
    [schemeCount]
  );

  /** 切换单个方案的勾选状态 */
  const toggleScheme = (k: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G') => {
    setEnabledSchemes((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        if (next.size <= 1) return prev; // 至少保留 1 个
        next.delete(k);
      } else {
        next.add(k);
      }
      // 立即记录日志（用 next 而非闭包中的 prev）
      appendLog('STAGE', `方案调整：${[...next].join('')}（下次解析生效）`);
      return next;
    });
  };

  /** 绘图模型 */
  const [coverImageModel, setCoverImageModel] = useState<'gpt-image-2' | 'gpt-image-2-c' | 'gemini-flash'>('gpt-image-2');

  /** v1.4：参与封面生成的人物名单（按名字勾选；不勾选的人物不出现在画面里）
   *  默认：解析完成后按"7 套标题中出现过的人名"自动勾选，用户可手动调整 */
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

  // 全局限流状态（轮询 imageGenLimiter.stats() 用于 UI 显示）
  const [limiterState, setLimiterState] = useState<{
    cooldownMs: number;
    inFlight: number;
    waiters: number;
    maxConcurrent: number;
  }>({ cooldownMs: 0, inFlight: 0, waiters: 0, maxConcurrent: 4 });

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

  // ── 一键剪映（生成剪映草稿）状态 ──
  const [jianyingExporting, setJianyingExporting] = useState<boolean>(false);
  const [jianyingProgress, setJianyingProgress] = useState<number>(0);
  const [jianyingProgressMessage, setJianyingProgressMessage] = useState<string>('');
  const [jianyingDownloadUrl, setJianyingDownloadUrl] = useState<string>('');
  const [jianyingDraftPath, setJianyingDraftPath] = useState<string>('');
  const [jianyingBatchLinks, setJianyingBatchLinks] = useState<
    Array<{ filename: string; url: string; partLabel: string }>
  >([]);
  const jianyingExportCancelledRef = useRef<boolean>(false);

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

  /** 自动 AI 优化字幕开关 */
  const [autoOptimize, setAutoOptimize] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('AUTO_OPTIMIZE_SUBTITLE');
      return stored !== null ? stored === 'true' : true;
    } catch { return true; }
  });

  /** 字幕编辑面板 */
  const [subtitleEditOpen, setSubtitleEditOpen] = useState<boolean>(false);
  const [editingCueIdx, setEditingCueIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>('');
  const [findText, setFindText] = useState<string>('');
  const [replaceText, setReplaceText] = useState<string>('');
  const [optimizingSubtitles, setOptimizingSubtitles] = useState<boolean>(false);

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
      enabledSchemes: Array.from(enabledSchemes),
      mode,
      // 仅持久化字幕文本与时长；blob URL 不可序列化，重新上传即可
      customTracks: {
        videoItems: customTracks.videoItems.map((it) => ({
          ...it,
          // 清掉 blob URL（重启后失效）
          url: it.url.startsWith('blob:') ? '' : it.url,
        })),
        audioUrl: customTracks.audioUrl?.startsWith('blob:') ? '' : customTracks.audioUrl,
        audioName: customTracks.audioName,
        audioDurationSec: customTracks.audioDurationSec,
        subtitleCues: customTracks.subtitleCues,
        subtitleFileName: customTracks.subtitleFileName,
        subtitleEnabled: customTracks.subtitleEnabled,
      },
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
    enabledSchemes,
    mode,
    customTracks,
  ]);

  // 全局限流状态轮询（用于 UI 显示冷却进度）
  useEffect(() => {
    const tick = () => {
      try {
        const stats = imageGenLimiter.stats();
        setLimiterState(stats);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);

  // ── 预热 ffmpeg.wasm（用户进入页面时就开始下载 32MB WASM） ──
  //    等用户真的上传视频时，ffmpeg 已经在内存中，无需等待
  useEffect(() => {
    prewarmFfmpeg();
  }, []);

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
  // 字幕编辑辅助函数
  // ──────────────────────────────────────────────
  /** 统计查找词出现次数 */
  const countFindOccurrences = (cues: SubtitleCue[], find: string): number => {
    if (!find.trim()) return 0;
    return cues.reduce((cnt, c) => {
      let idx = 0;
      const lower = c.text.toLowerCase();
      const lowerFind = find.toLowerCase();
      while ((idx = lower.indexOf(lowerFind, idx)) !== -1) { cnt++; idx += lowerFind.length; }
      return cnt;
    }, 0);
  };

  /** 批量替换 */
  const handleBatchReplace = useCallback(() => {
    if (!findText.trim()) return;
    const count = countFindOccurrences(customTracks.subtitleCues, findText);
    if (count === 0) return;
    const confirmed = confirm(`确定将 "${findText}" 全部替换为 "${replaceText}" 吗？\n将替换 ${count} 处。`);
    if (!confirmed) return;
    setCustomTracks((prev) => ({
      ...prev,
      subtitleCues: prev.subtitleCues.map((c) => ({ ...c, text: c.text.split(findText).join(replaceText) })),
    }));
    setFindText('');
    appendLog('EDIT', `✓ 批量替换：${count} 处 "${findText}" → "${replaceText}"`);
  }, [findText, replaceText, customTracks.subtitleCues, appendLog]);

  /** 保存单条编辑 */
  const handleSaveEdit = useCallback((idx: number) => {
    setCustomTracks((prev) => ({
      ...prev,
      subtitleCues: prev.subtitleCues.map((c, i) => i === idx ? { ...c, text: editingText } : c),
    }));
    setEditingCueIdx(null);
    setEditingText('');
  }, [editingText]);

  /** 自动 AI 优化字幕（非阻塞） */
  const triggerAutoOptimize = useCallback((cues: SubtitleCue[]) => {
    const apiKey = (typeof window !== 'undefined'
      ? (window.localStorage.getItem('API_KEY_yunwu')
          || window.localStorage.getItem('API_KEY_google')
          || window.localStorage.getItem('YUNWU_API_KEY')
          || window.localStorage.getItem('GEMINI_API_KEY')
          || window.localStorage.getItem('OPENLUX_API_KEY')
          || (window as any).localStorage.getItem('OPENAI_API_KEY'))
      : null);
    if (!apiKey) {
      appendLog('ASR', `⚠ 自动优化跳过：未配置 API Key`);
      return;
    }
    setOptimizingSubtitles(true);
    appendLog('ASR', `▸ AI 优化字幕中…`);
    import('../services/subtitleOptimizer').then(({ optimizeSubtitles }) => {
      optimizeSubtitles(cues as any, apiKey, (cur, total) => {
        appendLog('ASR', `  AI 优化: ${cur}/${total}`);
      }).then((result) => {
        if (result.success) {
          setCustomTracks((prev) => ({ ...prev, subtitleCues: result.optimizedCues as unknown as SubtitleCue[] }));
          appendLog('ASR', `✓ AI 优化完成：${result.correctedCount ? `纠正了 ${result.correctedCount} 条` : '无明显错误'} · ${result.optimizedCues.length} 条`);
        } else {
          appendLog('ASR', `⚠ 自动优化失败: ${result.error}`);
        }
        setOptimizingSubtitles(false);
      }).catch((e: any) => {
        appendLog('ASR', `✗ AI 优化出错: ${e.message}`);
        setOptimizingSubtitles(false);
      });
    });
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
    finalCoverIndex != null
      ? generatedCovers.get(finalCoverIndex) || null
      : Array.from(generatedCovers.values())[0] || null; // v2.3：未选定时回退到第 1 张已生成的封面，便于"导出 MP4"立即可用

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
    // 默认选中前 min(schemeCount, 3) 个方案（A/B/C 对比性最强）；让用户能批量生成
    const defaultSelCount = Math.min(schemeCount, 3);
    setSelectedIndices(new Set(Array.from({ length: defaultSelCount }, (_, i) => i)));
    setFinalCoverIndex(null);
    setEditedTitles({});
    setLockedCoverIndices(new Set());
    setGeneratedCovers(new Map());
    setCoverErrors(new Map());
    setTtsResult(null);
    setVideoUrl('');
    try {
      appendLog(
        'PARSE',
        `调用 GPT-5.6-Luna 解析 ${schemeCount} 套方案（预计 15~90s，max_tokens=16384，不再截断原文）...`
      );
      // v1.6：用对象形式传参：开启超时 180s / 1 次重试 / **不截断原文**（用户要求保留完整文案，避免丢关键信息）
      // v11.0：使用按 schemeCount 动态裁剪的 prompt（buildAnalysisPrompt 在 useMemo 算好）
      const r = await analyzeCopyWithLlm(apiKey, rawCopy, dynamicAnalysisPrompt, {
        onLog: (msg) => {
          // 把 [文案解析] / [文案解析] ⚠... 这类前缀去掉，UI 简洁
          appendLog('PARSE', msg.replace(/^\[文案解析\]\s*/, ''));
        },
        timeoutMs: 180_000,
        retries: 1,
        maxTokens: 16384, // 7 套方案需要较大值避免 JSON 截断
        // 不再传 maxInputChars → 默认 0 = 不截断
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

      // v2.0：解析前勾选了"同时生成5段并行配音" → 解析完成后自动开始配音
      if (parallelTtsEnabled) {
        appendLog('TTS', '🔔 勾选了并行配音，解析完成后自动开始 5 段配音...');
        // handleGenerateTts 依赖 selectedOptionList，但解析后已自动 select，
        // 故延迟一点让 setSelectedIndices 渲染完成
        setTimeout(() => handleGenerateTts(), 100);
      }
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
  }, [apiKey, rawCopy, toast, appendLog, parallelTtsEnabled, schemeCount, dynamicAnalysisPrompt]);

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
  // 生成封面（单套）— 7 种不同排版方案（复用封面赛道 A~G 模板，含长文案/复仇海报）
  // ──────────────────────────────────────────────

  /**
   * 7 种不同的封面排版设计（与封面赛道 A~G 一一对应，含长文案/复仇海报 G）
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
    {
      id: 'G_longcopy_poster',
      schemeId: 'G' as const,
      name: '排版 G · 长文案/复仇海报',
      colors: '主文字 #FFFFFF 白 + 关键词 #FFD400 警示黄 + 高亮人名 #B91C1C 暗血红，背景深色 + 暗角胶片颗粒',
      description:
        '9:16 竖屏复仇故事卡片海报（Reddit/TikTok 病毒小说卡片风）：主角半身正面/3/4 侧脸特写居于画面下半部中央（主角性别/年龄/气质必须从文案内容动态识别，禁止硬编码女性或任何特定性别），主体周围点缀烛光/破碎镜面/匕首等氛围元素；上半部排版 5–9 行 ALL-CAPS 英文长文案（**这是方案 G 的核心 —— 必须是完整的故事情节叙述，采用"第一视角叙事 + 对话引用 + 悬念结尾"的复仇故事卡片结构**，而非单纯的一行标题；故事结构示例：①开场"WHEN MY HUSBAND & M.I.L HEARD THE DOCTOR SAY I HAD 3 DAYS LEFT..." ②冲突"MY MIL SMIRKED: \"3 DAYS? PERFECT. I\'M TAKING THE HOUSE.\"" ③反转"AFTER THEY LEFT, I CALLED MY FATHER." ④悬念"HE SAID: \"I\'VE BEEN WAITING FOR THIS CALL.\""），每行 4–10 词，电影海报字体（粗体、大写、紧凑、尖锐切角），关键人名与动作动词亮黄 #FFD400 或暗血红 #B91C1C 高亮、其余亮白 #F8FAFC，行间紧凑、字号自上而下可逐级微缩；对话引用用英文双引号 " " 包裹；文案末行下方加斜切的暗血红或纯黑实色矩形条带，里面写故事型续写钩子（如「"I\'VE BEEN WAITING FOR THIS CALL."」「"CANCEL HIS ACQUISITION DEAL…"」）；底部 1/4 处再加一条暗红或纯黑实色横条压一句全新的续写悬念（不超过 12 个英文单词，如「THE ENDING WAS INCREDIBLY SATISFYING.」）；边缘做旧噪点 + 暗角 + 胶片颗粒；整体 Reddit / TikTok 复仇故事卡片海报质感。',
      composition:
        '上半部（约 60% 画面高度）：5–9 行 ALL-CAPS 长文案堆叠（每行 4–10 词，**完整的故事叙述**——开场/冲突/反转/悬念四段式，电影海报字体，关键人名/动词亮黄或暗血红高亮、其余白色）；下半部（约 40% 画面高度）：主角半身特写（动态识别性别/年龄/气质）；底部 1/4：暗血红或纯黑实色横条 + 一句全新续写悬念；整体暗角 + 胶片颗粒。',
      emphasis:
        '关键人名/动作动词用亮黄 #FFD400 或暗血红 #B91C1C 双重高亮；对话用英文双引号包裹；故事型续写钩子用斜切条带强调；底部条带再压一句短句',
      extraDetails: 'Reddit / TikTok 复仇故事卡片海报 / 暗角 + 胶片颗粒 / 电影海报字体 / IMDb-Criterion 风',
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

      // 按 schemeId 选排版：A~G 与封面赛道 7 方案模板一一对应（含长文案/复仇海报 G）
      // 兼容旧数据（无 schemeId）则按 optionIdx 取模
      const schemeKey = (option.schemeId || ['A', 'B', 'C', 'D', 'E', 'F', 'G'][optionIdx % 7]) as
        | 'A'
        | 'B'
        | 'C'
        | 'D'
        | 'E'
        | 'F'
        | 'G';
      const layout =
        COVER_LAYOUT_VARIANTS.find((v) => v.schemeId === schemeKey) ||
        COVER_LAYOUT_VARIANTS[optionIdx % 7];

      // 按方案 A~G 的"对应关系"映射 single-character / multi-character 提示
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
      // 关键 2：使用「排版方案」机制（7 种方案 7 种排版），与封面赛道 A~G 一一对应
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

      /** 检测封面标题语言：英文 → 强制英文 ALL-CAPS；中文 → 简体中文；其它语言 → 原文照搬 */
      const detectTitleLang = (s: string): 'en' | 'zh' | 'other' => {
        const t = (s || '').trim();
        if (!t) return 'other';
        const hasCJK = /[\u4e00-\u9fff]/.test(t);
        const hasLatin = /[A-Za-z]/.test(t);
        if (hasLatin && !hasCJK) return 'en';
        if (hasCJK && !hasLatin) return 'zh';
        if (hasCJK && hasLatin) return 'zh';
        return 'other';
      };
      const titleLang = detectTitleLang(option.title);
      const onImageTextRule =
        titleLang === 'en'
          ? `Mandatory: all on-image text must be English only; the title "${option.title}" MUST appear in ALL-CAPS as multi-line stacked text (split into 2–4 color blocks using {white #FFFFFF, red #FF1744, yellow #FFD600, blue #00D4FF}); do NOT translate to Chinese, do NOT replace with other languages.`
          : titleLang === 'zh'
          ? `Mandatory: 画面所有中文文字使用简体中文（不再硬性繁体化）；标题"${option.title}"必须**完整、一字不漏**地按用户原文语言出现在画面上，分色块（白/红/黄/蓝四色）承载，禁止简化、禁止拆分成几个无关词、禁止翻译成其它语言。`
          : `Mandatory: 画面文字保持用户原文语言；标题"${option.title}"必须**完整、一字不漏**地出现在画面上，分色块（白/红/黄/蓝四色）承载，禁止简化、禁止拆分成几个无关词。`;

      const fullPrompt = `${option.coverPromptEn}

=== CRITICAL · 必须在画面上完整显示以下封面标题（一字不漏，禁止简化、禁止拆分成几个词；语言 = ${titleLang === 'en' ? '英文' : titleLang === 'zh' ? '中文' : '原文语言'}）===
|TEXT (display exactly, in ${titleLang === 'en' ? 'English ALL-CAPS' : titleLang === 'zh' ? 'Simplified Chinese' : 'the source language'}): "${option.title}"
|===

=== ${layout.name}（方案 ${schemeKey}：${option.schemeName || layout.name}，position ${optionIdx + 1} of 7，必须与其它 6 种方案不同！）===
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

=== ⭐ MANDATORY · High-CTR Thumbnail Enforcement（与封面模版赛道 1:1 对齐；语言匹配用户文案）===
YouTube thumbnail, ${currentRatio.id} aspect ratio, bold readable main title, high CTR composition.
${onImageTextRule}
Mandatory: the title "${option.title}" MUST appear on the image verbatim, split into 2-4 color blocks using {white #FFFFFF, red #FF1744, yellow #FFD600, blue #00D4FF}; each block bold weight 900, 6-10px black outline, slight tilt (-3° to +5°), semi-transparent black plate behind.
Mandatory: include at least one high-CTR visual accent — bright red arrow, yellow highlight ring, or red-yellow warning strip.===`;

      setCoversGenerating((prev) => new Set(prev).add(optionIdx));
      setCoverErrors((prev) => {
        const next = new Map(prev);
        next.delete(optionIdx);
        return next;
      });

      const size = `${currentRatio.w}x${currentRatio.h}`;
      // ── 监控点 #1：coverRatio 状态溯源 ──
      console.log('[封面比例监控]', {
        coverRatio,                                              // React state 值
        currentRatioId: currentRatio.id,                          // 查表匹配结果
        currentRatioW: currentRatio.w,                            // 宽度
        currentRatioH: currentRatio.h,                            // 高度
        size,                                                     // "WxH" 字符串
        promptAspectRatio: currentRatio.id,                       // prompt 里写的比例指令
        aspectRatioClass: COVER_RATIO_CLASSES[coverRatio] ?? 'aspect-video', // UI 容器类名
      });
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
          model: coverImageModel,
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

        // ── 监控点 #2：拿到图片后的实际尺寸（base64 解码头获取真实尺寸）──
        let actualW: number | null = null;
        let actualH: number | null = null;
        if (url.startsWith('data:image/png;base64,')) {
          try {
            const b64 = url.slice('data:image/png;base64,'.length);
            // 浏览器环境没有 Node.js Buffer，用 Uint8Array + atob 替代
            const binary = atob(b64);
            const buf = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
            // PNG IHDR at offset 16: width (4 bytes BE) + height (4 bytes BE)
            if (buf.length >= 24) {
              const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
              actualW = view.getUint32(16, false);
              actualH = view.getUint32(20, false);
            }
          } catch (e) { /* ignore */ }
        }
        console.log('[封面比例监控] API 返回图片', {
          urlPrefix: url.slice(0, 30),
          isDataUrl: url.startsWith('data:'),
          actualWidth: actualW,
          actualHeight: actualH,
          actualRatio: actualW && actualH ? `${actualW}:${actualH}` : null,
          requestedSize: size,
          requestedRatio: `${currentRatio.w}:${currentRatio.h}`,
          coverRatio,
          ratioMatch: actualW === currentRatio.w && actualH === currentRatio.h,
        });

        const entry: CoverImageEntry = {
          index: optionIdx,
          url,
          title: option.title,
          emoji: option.emoji,
          styleTag: option.styleTag,
          schemeId: option.schemeId,
          schemeName: option.schemeName,
          ratio: coverRatio,
          actualWidth: actualW,
          actualHeight: actualH,
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
  // 手动上传封面（v2.7）：用户可直接上传本地图片作为某个方案的封面，
  // 跳过 AI 生成。blob URL 保存在 generatedCovers，导出 Remotion 时直接复用。
  // ──────────────────────────────────────────────
  const handleUploadManualCover = useCallback(
    (idx: number, file: File) => {
      const opt = liveTitleOptions[idx];
      if (!opt) {
        // 没点智能解析时也允许上传：用一个默认 placeholder
        // 让用户可以直接传封面，不依赖 AI 解析
        try {
          const probeImg = new Image();
          const blobUrl = URL.createObjectURL(file);
          probeImg.onload = () => {
            const w = probeImg.naturalWidth;
            const h = probeImg.naturalHeight;
            const placeholderOpt: CopyTitleOption = {
              title: rawCopy.trim().slice(0, 20) || `方案${idx + 1}`,
              emoji: '✨',
              styleTag: '震惊悬念',
              styleKeywords: [],
              coverPromptEn: '',
              coverDescriptionZh: '手动上传',
              schemeId: ['A', 'B', 'C', 'D', 'E', 'F', 'G'][idx % 7] as 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G',
              schemeName: '手动上传',
            };
            const entry: CoverImageEntry = {
              index: idx,
              url: blobUrl,
              title: placeholderOpt.title,
              emoji: placeholderOpt.emoji,
              styleTag: `${placeholderOpt.styleTag} · 未解析`,
              schemeId: placeholderOpt.schemeId,
              schemeName: placeholderOpt.schemeName,
              ratio: coverRatio,
              actualWidth: w,
              actualHeight: h,
            };
            setGeneratedCovers((prev) => {
              const next = new Map(prev);
              const old = next.get(idx) as CoverImageEntry | undefined;
              if (old && old.url?.startsWith('blob:')) URL.revokeObjectURL(old.url);
              next.set(idx, entry);
              return next;
            });
            setCoverErrors((prev) => {
              if (!prev.has(idx)) return prev;
              const next = new Map(prev);
              next.delete(idx);
              return next;
            });
            setFinalCoverIndex((prev) => (prev == null ? idx : prev));
            appendLog('IMG', `✓ 方案${idx + 1} 手动上传封面成功 (${w}×${h})（未点智能解析）`);
            toast.success(`方案${idx + 1} 封面已上传（${w}×${h}）`, 2000);
          };
          probeImg.onerror = () => {
            URL.revokeObjectURL(blobUrl);
            appendLog('ERROR', `方案${idx + 1} 封面图片解析失败`);
            toast.error('图片解析失败，请使用 PNG/JPG/WebP 格式', 4000);
          };
          probeImg.src = blobUrl;
        } catch (e: any) {
          appendLog('ERROR', `手动上传封面失败：${e?.message || e}`);
          toast.error(`上传失败：${e?.message || e}`, 4000);
        }
        return;
      }
      // 有 analysisResult 时的逻辑
      try {
        // 读实际像素宽高（用于封面比例监控）
        const probeImg = new Image();
        const blobUrl = URL.createObjectURL(file);
        probeImg.onload = () => {
          const w = probeImg.naturalWidth;
          const h = probeImg.naturalHeight;
          const entry: CoverImageEntry = {
            index: idx,
            url: blobUrl,
            title: opt.title,
            emoji: opt.emoji,
            styleTag: `${opt.styleTag} · 手动上传`,
            schemeId: opt.schemeId,
            schemeName: opt.schemeName,
            ratio: coverRatio,
            actualWidth: w,
            actualHeight: h,
          };
          setGeneratedCovers((prev) => {
            const next = new Map(prev);
            // 释放上一个 blob URL（避免内存泄漏）
            const old = next.get(idx) as CoverImageEntry | undefined;
            if (old && old.url?.startsWith('blob:')) URL.revokeObjectURL(old.url);
            next.set(idx, entry);
            return next;
          });
          setCoverErrors((prev) => {
            if (!prev.has(idx)) return prev;
            const next = new Map(prev);
            next.delete(idx);
            return next;
          });
          // 默认终选第一张手动上传的封面
          setFinalCoverIndex((prev) => (prev == null ? idx : prev));
          appendLog('IMG', `✓ 方案${idx + 1} 手动上传封面成功 (${w}×${h})`);
          toast.success(`方案${idx + 1} 封面已上传（${w}×${h}）`, 2000);
        };
        probeImg.onerror = () => {
          URL.revokeObjectURL(blobUrl);
          appendLog('ERROR', `方案${idx + 1} 封面图片解析失败`);
          toast.error('图片解析失败，请使用 PNG/JPG/WebP 格式', 4000);
        };
        probeImg.src = blobUrl;
      } catch (e: any) {
        appendLog('ERROR', `手动上传封面失败：${e?.message || e}`);
        toast.error(`上传失败：${e?.message || e}`, 4000);
      }
    },
    [liveTitleOptions, coverRatio, rawCopy, appendLog, toast]
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

  /** v2.2 helper：通过 HTMLAudioElement 解码任意 audio Blob 取时长（秒） */
  const getAudioBlobDuration = useCallback((blob: Blob): Promise<number> => {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.preload = 'metadata';
      audio.src = url;
      audio.onloadedmetadata = () => {
        const d = audio.duration;
        URL.revokeObjectURL(url);
        if (!isFinite(d) || d <= 0) reject(new Error('音频时长解析失败'));
        else resolve(d);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('音频解码失败，请确认文件格式'));
      };
    });
  }, []);

  /**
   * v2.7 helper：把任意 audio Blob（wav/mp3/m4a）转成 MP3 Blob。
   * 纯客户端，零服务端依赖。
   * 原理：用 OfflineAudioContext + AudioBuffer → MediaStreamDestinationNode → MediaRecorder
   *       MediaRecorder 用 'audio/mpeg'（即 mp3）作为 mimeType 输出。
   * 浏览器兼容性：
   *   - Chrome / Edge：✅ audio/mpeg
   *   - Firefox：✅ audio/mpeg
   *   - Safari：⚠️ 部分支持；失败时自动降级到服务端
   */
  const convertWavBlobToMp3 = useCallback(async (inputBlob: Blob): Promise<Blob> => {
    if (typeof window === 'undefined') throw new Error('非浏览器环境');

    // 1) 解码音频 → AudioBuffer
    const arrayBuffer = await inputBlob.arrayBuffer();
    // AudioContext 必须是用户手势后调用，这里已经是 onClick 内，符合要求
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    const decodeCtx = new Ctor();
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      try { decodeCtx.close(); } catch {}
    }

    // 2) 准备离线渲染：AudioBuffer → MediaStreamDestination
    const sampleRate = audioBuffer.sampleRate;
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;

    // MediaStreamDestination 需要 AudioContext（不是 OfflineAudioContext）
    const streamCtx = new Ctor({ sampleRate });
    const dest = streamCtx.createMediaStreamDestination();

    const offline = new OfflineAudioContext(channels, length, sampleRate);
    const source = offline.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(dest);
    source.start();

    // 3) MediaRecorder 录制（必须先 start，再 startRendering，再 stop）
    const mimeCandidates = [
      'audio/mpeg',
      'audio/mp3',
      'audio/mpeg;codecs=mp3',
    ];
    const supported = mimeCandidates.find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m));
    if (!supported) {
      throw new Error('当前浏览器不支持 MediaRecorder 输出 MP3');
    }
    const recorder = new MediaRecorder(dest.stream, { mimeType: supported, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

    const recordedPromise = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (e: any) => reject(new Error(e?.error?.message || 'MediaRecorder 出错'));
    });

    // 必须在 startRendering 之前启动 recorder，否则会丢失音频数据
    recorder.start();
    const renderedBuffer = await offline.startRendering();
    // 渲染完成后立即停止
    recorder.stop();

    await recordedPromise;

    if (chunks.length === 0) throw new Error('MediaRecorder 没产生数据');

    const outputBlob = new Blob(chunks, { type: 'audio/mpeg' });
    if (outputBlob.size < 200) throw new Error('MP3 输出文件过小（可能转码失败）');
    return outputBlob;
  }, []);

  const handleGenerateTts = useCallback(async () => {
    if (rawCopy.trim().length < 50) {
      toast.error('文案过短，无法配音', 3000);
      return;
    }

    // ── v2.2 短路：用户上传了手动音频 → 直接用上传的音频，跳过 AI 配音 ──
    if (uploadedFullAudio && uploadedFullAudioBlob) {
      appendLog('STAGE', '▶ 使用手动上传的音频（跳过 AI 配音）');
      appendLog('TTS', `音频文件：${uploadedFullAudio}`);
      try {
        const durationSec = await getAudioBlobDuration(uploadedFullAudioBlob);
        const url = URL.createObjectURL(uploadedFullAudioBlob);
        // v2.7+：如果是 mp3/m4a 等压缩格式，直接把原 blob 当作 mp3 blob 供下载使用
        //       （用户既然上传了完整配音音频，就用原文件，不再做 wav→mp3 转码）
        const headBuf = await uploadedFullAudioBlob.slice(0, 16).arrayBuffer();
        const headBytes = new Uint8Array(headBuf);
        const isMp3Like =
          uploadedFullAudioBlob.type.includes('mpeg') ||
          uploadedFullAudioBlob.type.includes('mp3') ||
          uploadedFullAudioBlob.type.includes('m4a') ||
          uploadedFullAudioBlob.type.includes('mp4') ||
          (headBytes[0] === 0x49 && headBytes[1] === 0x44 && headBytes[2] === 0x33) ||
          (headBytes[0] === 0xff && (headBytes[1] & 0xe0) === 0xe0);
        const fakeResult: ParallelTtsResult = {
          mergedAudioUrl: url,
          mergedAudioBlob: uploadedFullAudioBlob,
          mergedMp3Blob: isMp3Like ? uploadedFullAudioBlob : undefined,
          totalDuration: durationSec,
          segments: [
            {
              index: 0,
              text: rawCopy.trim(),
              audioUrl: url,
              duration: durationSec,
              success: true,
            },
          ],
        };
        setTtsResult(fakeResult);
        setTtsError(null);
        appendLog('TTS', `✓ 手动音频已就绪，时长 ${durationSec.toFixed(1)} 秒`);
        toast.success(`已使用手动上传的音频（${durationSec.toFixed(1)}s）`, 3000);
      } catch (e: any) {
        appendLog('ERROR', `读取手动音频失败：${e?.message || e}`);
        toast.error(`读取手动音频失败：${e?.message || e}`, 5000);
      }
      return;
    }

    // v2.7：5 段配音不再要求先选方案 — 只要有文案 + 配音声色即可触发
    // 之前的限制（必须先点「智能解析」并选择方案）让"只有文案"的场景无法配音
    if (!runningHubApiKey?.trim()) {
      appendLog('ERROR', 'RunningHub API Key 未配置');
      toast.error('请先在顶部输入 RunningHub API Key', 4000);
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
    uploadedFullAudio,
    uploadedFullAudioBlob,
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
  // 自定义素材成片 — shots 构建
  // ──────────────────────────────────────────────
  /**
   * 把 CustomTracksState 转换为 RemotionShot[]
   * - 每个 videoItem 单独一个 shot
   * - 时长按 effectiveItemDuration 算；总时长对齐到音频时长
   * - 字幕优先用 subtitleCues（用户上传的）；否则走 ASR 或 sentence-split
   */
  const buildCustomShots = useCallback(
    (
      tracks: CustomTracksState,
      totalDurationSec: number,
    ): RemotionShot[] => {
      const items = tracks.videoItems;
      if (items.length === 0) return [];
      const shots: RemotionShot[] = [];

      // 视频轨道总时长
      const videoTotalActual = items.reduce((s, it) => {
        if (typeof it.overrideDurationSec === 'number' && it.overrideDurationSec > 0) {
          return s + it.overrideDurationSec;
        }
        if (it.kind === 'video' && it.durationSec && it.durationSec > 0) {
          return s + it.durationSec;
        }
        return s + 4; // 图片兜底 4s
      }, 0);

      // 取音频与视频轨道长者，并按比例拉伸每个 shot
      const targetTotal = Math.max(videoTotalActual, totalDurationSec);
      const scale = videoTotalActual > 0 ? targetTotal / videoTotalActual : 1;

      let cursorSec = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const baseDur =
          typeof it.overrideDurationSec === 'number' && it.overrideDurationSec > 0
            ? it.overrideDurationSec
            : it.kind === 'video' && it.durationSec
            ? it.durationSec
            : 4;
        const dur = baseDur * scale;
        // caption 优先级：用户输入 > 自动 caption > 通用占位
        // 不使用 it.name（文件名），避免如 "cover_1.png" 这种带下划线的文件名被作为字幕文本
        const caption = (it.caption && it.caption.trim()) || `镜头 ${i + 1}`;
        // 取该 shot 时间窗口内的字幕 cues
        const winEnd = cursorSec + dur;
        const shotCues: SubtitleCue[] = tracks.subtitleCues
          .filter((c) => c.endSec > cursorSec && c.startSec < winEnd)
          .map((c) => ({
            startFrame: Math.max(0, Math.round((c.startSec - cursorSec) * remotionConfig.fps)),
            endFrame: Math.min(
              Math.round(dur * remotionConfig.fps),
              Math.round((c.endSec - cursorSec) * remotionConfig.fps),
            ),
            text: c.text,
          }))
          .filter((c) => c.endFrame > c.startFrame);
        shots.push({
          id: `custom_${i}_${it.id}`,
          number: i + 1,
          caption,
          text: caption,
          imageUrl: it.kind === 'image' ? it.url : undefined,
          imageUrls: it.kind === 'image' ? [it.url] : undefined,
          videoUrl: it.kind === 'video' ? it.url : undefined,
          audioUrl: tracks.audioUrl,
          voiceoverAudioUrl: tracks.audioUrl,
          audioDurationSec: tracks.audioDurationSec,
          audioDurationExact: tracks.audioDurationSec,
          duration: dur,
          textCues: tracks.subtitleEnabled ? shotCues : undefined,
          motion: remotionConfig.motion ?? 'kenBurns',
        });
        cursorSec = winEnd;
      }
      return shots;
    },
    [remotionConfig.fps, remotionConfig.motion]
  );

  // ──────────────────────────────────────────────
  // MP4 导出（Remotion 渲染）— 双模式分发
  // ──────────────────────────────────────────────
  const handleExportMp4 = useCallback(async () => {
    // ── 模式分流 ──
    if (mode === 'custom') {
      // 自定义素材成片：必须有视频素材 + 音频；字幕可选
      if (customTracks.videoItems.length === 0) {
        toast.error('请先上传视频/图片素材', 3000);
        return;
      }
      if (!customTracks.audioUrl) {
        toast.error('请先上传音频', 3000);
        return;
      }
      appendLog('EXPORT', `▶ 准备 MP4 导出（自定义素材成片 · ${customTracks.videoItems.length} 镜头 · 字幕=${customTracks.subtitleEnabled ? (customTracks.subtitleFileName || 'Whisper') : 'OFF'}）`);
    } else {
      // AI 模式：保持原有逻辑
      if (!finalCover) {
        toast.error('请先选定终封面', 3000);
        return;
      }
      if (!ttsResult) {
        toast.error('请先生成配音', 3000);
        return;
      }
      appendLog('EXPORT', '▶ 准备 MP4 导出（Remotion 单镜头：封面 + 配音）');
    }

    // Remotion 健康检查
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

    // ── 构建 shots 数组 + 字幕 cues ──
    let shots: RemotionShot[] = [];
    let asrAudioUrl: string | undefined;

    if (mode === 'custom') {
      const totalDur = customTracks.audioDurationSec || 5;
      shots = buildCustomShots(customTracks, totalDur);
      asrAudioUrl = customTracks.audioUrl;
      // 自定义模式：用户已上传字幕 → 直接用；否则走 ASR
      if (customTracks.subtitleEnabled && customTracks.subtitleCues.length === 0 && whisperEnabled) {
        // ASR 路径在下面统一处理
      }
    } else {
      const totalDuration = ttsResult!.totalDuration || 5;
      const caption = finalCover!.title;
      // AI 模式默认字幕切分
      const fallbackCues = buildSubtitleCuesFromText(
        rawCopy,
        totalDuration,
        remotionConfig.fps,
        remotionConfig.subtitle.chunking ?? 'sentence',
      );
      shots = [
        {
          id: 'copy_based_main',
          number: 1,
          caption,
          text: caption,
          imageUrl: finalCover!.url,
          imageUrls: [finalCover!.url],
          videoUrl: undefined,
          audioUrl: ttsResult!.mergedAudioUrl,
          voiceoverAudioUrl: ttsResult!.mergedAudioUrl,
          audioDurationSec: totalDuration,
          audioDurationExact: totalDuration,
          duration: totalDuration,
          textCues: fallbackCues,
          motion: remotionConfig.motion ?? 'kenBurns',
        },
      ];
      asrAudioUrl = ttsResult!.mergedAudioUrl;
    }

    // ── Whisper ASR（仅当启用字幕 & 字幕 cues 为空 & 非手动上传音频）──
    // v2.4：手动上传配音音频不需要 ASR（用户已自己配好音，ASR 只是做字幕时间戳）
    const shouldAsr =
      whisperEnabled &&
      asrAudioUrl &&
      !uploadedFullAudio && // 手动上传音频 → 跳过 ASR，直接用时间戳均分
      ((mode === 'ai') ||
        (mode === 'custom' && customTracks.subtitleEnabled && customTracks.subtitleCues.length === 0));
    if (uploadedFullAudio) {
      appendLog('EXPORT', '检测到手动上传音频，跳过 Whisper ASR（使用文案均分字幕）');
    }
    if (shouldAsr && asrAudioUrl) {
      try {
        setWhisperRunning(true);
        setWhisperProgress({ done: 0, total: shots.length, current: 'whisper' });
        setVideoMessage('正在分析音频（Whisper ASR）...');
        appendLog('EXPORT', `▶ 启动 Whisper ASR 生成词级时间戳（${shots.length} 个镜头）`);
        const asrShots = shots.map((s) => ({
          shotId: s.id,
          audioUrl: asrAudioUrl!,
          caption: s.caption || '',
          durationInFrames: Math.round((s.duration || 5) * remotionConfig.fps),
          fps: remotionConfig.fps,
        }));
        const asrCues = await transcribeShots(
          asrShots,
          (done, total, current) => {
            setWhisperProgress({ done, total, current });
            setVideoMessage(`ASR 进度 ${done}/${total}`);
          }
        );
        let asrCount = 0;
        shots = shots.map((s) => {
          const cs = asrCues[s.id];
          if (cs && cs.length > 0) {
            asrCount += cs.length;
            return { ...s, textCues: cs };
          }
          return s;
        });
        if (asrCount > 0) {
          appendLog('EXPORT', `✓ ASR 完成：${asrCount} 个字幕片段（含词级时间戳）`);
          toast.success(`ASR 完成：${asrCount} 个字幕片段`, 2000);
          // 自动 AI 优化字幕
          if (autoOptimize && asrShots.length > 0) {
            const allCues: SubtitleCue[] = asrShots.flatMap((s: any) => s.textCues || []) as SubtitleCue[];
            if (allCues.length > 0) {
              setCustomTracks((prev) => ({ ...prev, subtitleCues: allCues }));
              triggerAutoOptimize(allCues);
            }
          }
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

    // ── 字幕开关过滤 ──
    if (mode === 'custom' && !customTracks.subtitleEnabled) {
      shots = shots.map((s) => ({ ...s, textCues: undefined }));
    }

    // ── 日志 + 渲染 ──
    const totalDuration = shots.reduce((s, x) => s + (x.duration || 0), 0);
    appendLog(
      'EXPORT',
      `提交渲染 · ${shots.length} 个镜头 · ${totalDuration.toFixed(1)}秒 · 模板：${remotionConfig.template.name} · ${remotionConfig.resolution}`
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
          shots,
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
  }, [
    mode,
    finalCover,
    ttsResult,
    customTracks,
    remotionConfig,
    rawCopy,
    toast,
    appendLog,
    whisperEnabled,
    buildCustomShots,
  ]);

  // ──────────────────────────────────────────────
  // 一键剪映：把当前面板的素材链路转成剪映草稿
  // - AI 模式：1 个镜头（封面 + 配音 + 字幕）
  // - 自定义模式：N 个镜头（每项素材一个镜头 + 整段音频轨）
  // ──────────────────────────────────────────────

  /**
   * 把 CustomTracksState 转换为 JianyingShot[]
   *  - 每个视频/图片素材 = 1 个镜头
   *  - 整段 audioUrl = 整段配音（用于剪映草稿的 audioDurationSec 兜底时长）
   *  - 字幕文本优先用素材自带 caption；否则用 Whisper 自动生成的 subtitleCues
   */
  const buildJianyingShotsFromCustomTracks = useCallback((): JianyingShot[] => {
    const shots: JianyingShot[] = [];
    for (const it of customTracks.videoItems) {
      const dur =
        (typeof it.overrideDurationSec === 'number' && it.overrideDurationSec > 0
          ? it.overrideDurationSec
          : it.kind === 'video' && it.durationSec && it.durationSec > 0
          ? it.durationSec
          : 4) || 4;
      const url = it.url;
      shots.push({
        caption: it.caption || '',
        duration: dur,
        // 图片 / 视频 二选一（剪映镜头只支持一种 media）
        imageUrl: it.kind === 'image' ? url : undefined,
        videoUrl: it.kind === 'video' ? url : undefined,
        // 整段音频轨 + 时长（剪映会按 audioDurationSec 兜底每个镜头的时长）
        audioUrl: customTracks.audioUrl,
        voiceoverAudioUrl: customTracks.audioUrl,
        audioDurationSec: customTracks.audioDurationSec,
      });
    }
    return shots;
  }, [customTracks]);

  /**
   * AI 模式：单镜头（封面 + 配音）
   */
  const buildJianyingShotsFromAiMode = useCallback((): JianyingShot[] => {
    if (!finalCover || !ttsResult) return [];
    return [
      {
        caption: rawCopy || finalCover.title || '',
        duration: ttsResult.totalDuration || 5,
        imageUrl: finalCover.url,
        audioUrl: ttsResult.mergedAudioUrl,
        voiceoverAudioUrl: ttsResult.mergedAudioUrl,
        audioDurationSec: ttsResult.totalDuration,
        audioDurationExact: ttsResult.totalDuration,
      },
    ];
  }, [finalCover, ttsResult, rawCopy]);

  /**
   * 把镜头中的 HTTP URL / Blob URL 转成 dataURL 并尝试缓存到本地，
   * 避免剪映导出时遇到临时链接过期 / Blob URL 无法跨进程访问 的问题。
   * 逻辑参考 MediaGenerator.tsx 的 prepareShotsForExport
   */
  const prepareShotsForJianyingExport = useCallback(
    async (shots: JianyingShot[]): Promise<JianyingShot[]> => {
      const allUrls: string[] = [];
      for (const s of shots) {
        if (s.imageUrl) allUrls.push(s.imageUrl);
        if (s.videoUrl) allUrls.push(s.videoUrl);
        if (s.audioUrl) allUrls.push(s.audioUrl);
        if (s.voiceoverAudioUrl && s.voiceoverAudioUrl !== s.audioUrl) {
          allUrls.push(s.voiceoverAudioUrl);
        }
      }

      // ── Step 1: HTTP URL → 检查本地缓存 ──
      const httpUrls = allUrls.filter((u) => /^https?:/i.test(u));
      const cachedPaths = await getLocalCachePaths(httpUrls);

      // ── Step 2: 未缓存的 HTTP URL → 下载 → 转 dataURL → 写本地缓存 ──
      const newCachedPaths = new Map<string, string>();
      const pending = httpUrls.filter((u) => !cachedPaths.has(u));
      if (pending.length > 0) {
        appendLog('Jianying', `▸ 缓存 ${pending.length} 个远程媒体到本地…`);
        for (const url of pending) {
          try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            const localPath = await saveMediaToLocalCache(url, dataUrl);
            if (localPath) {
              newCachedPaths.set(url, localPath);
              appendLog('Jianying', `  ✓ 已缓存: ${url.slice(0, 60)}`);
            }
          } catch (e: any) {
            appendLog('WARN', `缓存失败 ${url.slice(0, 60)}: ${e.message}`);
          }
        }
      }

      const allLocalPaths = new Map<string, string>();
      cachedPaths.forEach((p, u) => allLocalPaths.set(u, p));
      newCachedPaths.forEach((p, u) => allLocalPaths.set(u, p));

      // ── Step 3: Blob URL → 转 dataURL（剪映服务无法访问浏览器 Blob）──
      const blobUrls = allUrls.filter((u) => u.startsWith('blob:'));
      const blobDataUrls = new Map<string, string>();
      if (blobUrls.length > 0) {
        appendLog('Jianying', `▸ 转 ${blobUrls.length} 个 Blob 媒体为 dataURL…`);
      }
      await Promise.all(
        blobUrls.map(async (u) => {
          try {
            const resp = await fetch(u);
            if (!resp.ok) throw new Error(`Blob fetch HTTP ${resp.status}`);
            const blob = await resp.blob();
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            blobDataUrls.set(u, dataUrl);
          } catch (e: any) {
            appendLog('WARN', `Blob 转 dataURL 失败 ${u.slice(0, 60)}: ${e.message}`);
          }
        })
      );

      // ── Step 4: 替换镜头中的 URL ──
      const localMediaPaths: Array<{ url: string; localPath: string }> = [];
      const replaceUrl = (u?: string): string | undefined => {
        if (!u) return u;
        if (allLocalPaths.has(u)) {
          const lp = allLocalPaths.get(u)!;
          localMediaPaths.push({ url: u, localPath: lp });
          return lp;
        }
        if (u.startsWith('blob:') && blobDataUrls.has(u)) {
          return blobDataUrls.get(u);
        }
        return u;
      };

      return shots.map((s) => ({
        ...s,
        imageUrl: replaceUrl(s.imageUrl),
        videoUrl: replaceUrl(s.videoUrl),
        audioUrl: replaceUrl(s.audioUrl),
        voiceoverAudioUrl: replaceUrl(s.voiceoverAudioUrl),
      }));
    },
    [appendLog]
  );

  /** 一键剪映主处理函数 */
  const handleExportJianying = useCallback(async () => {
    // ── 输入校验 ──
    let shots: JianyingShot[] = [];
    if (mode === 'custom') {
      if (customTracks.videoItems.length === 0) {
        toast.error('请先上传视频/图片素材', 3000);
        return;
      }
      if (!customTracks.audioUrl) {
        toast.error('请先上传音频', 3000);
        return;
      }
      shots = buildJianyingShotsFromCustomTracks();
      if (shots.length === 0) {
        toast.error('没有可用的镜头', 3000);
        return;
      }
      appendLog('Jianying', `▸ 准备一键剪映（自定义素材 · ${shots.length} 镜头 · 字幕=${customTracks.subtitleEnabled ? `${customTracks.subtitleCues.length} 条` : 'OFF'}）`);
    } else {
      if (!finalCover || !ttsResult) {
        toast.error('请先选定终封面并生成配音', 3000);
        return;
      }
      shots = buildJianyingShotsFromAiMode();
      appendLog('Jianying', `▸ 准备一键剪映（AI 模式 · 单镜头）`);
    }

    // ── 初始化导出状态 ──
    jianyingExportCancelledRef.current = false;
    setJianyingExporting(true);
    setJianyingProgress(0);
    setJianyingProgressMessage('准备导出...');
    setJianyingDownloadUrl('');
    setJianyingDraftPath('');
    setJianyingBatchLinks([]);

    try {
      // ── 预处理镜头 URL（远程缓存 / Blob → dataURL）──
      setJianyingProgressMessage('预处理媒体文件...');
      const preparedShots = await prepareShotsForJianyingExport(shots);

      if (jianyingExportCancelledRef.current) {
        appendLog('Jianying', '导出已取消');
        return;
      }

      // ── 草稿名称（带时间戳避免重名）──
      const draftName =
        (mode === 'ai'
          ? `${(finalCover?.title || 'AI成片').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)}`
          : '自定义素材成片') +
        `_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now().toString().slice(-4)}`;

      const result = await exportJianyingDraft(
        {
          draftName,
          shots: preparedShots,
          // 自定义模式优先按音频时长作为分辨率基准（竖屏）
          resolution: '1080x1920',
          fps: 30,
          randomTransitions: false,
          randomVideoEffects: false,
        },
        (progress, message) => {
          if (jianyingExportCancelledRef.current) {
            appendLog('Jianying', '导出已取消');
            return;
          }
          setJianyingProgress(progress);
          setJianyingProgressMessage(message || '处理中...');
        }
      );

      if (jianyingExportCancelledRef.current) {
        appendLog('Jianying', '导出已取消');
        return;
      }

      if (!result.success) {
        throw new Error(result.error || '剪映导出失败');
      }

      // ── 成功：解析结果 ──
      setJianyingProgress(100);
      setJianyingProgressMessage('导出完成');

      // 1) 本地模式：有 draft_folder 直接显示路径
      if (result.draft_folder) {
        setJianyingDraftPath(result.draft_folder);
        appendLog('Jianying', `✓ 剪映草稿已生成：${result.draft_folder}（${shots.length} 镜头）`);
      }

      // 2) 远程 ZIP 模式：显示下载链接
      const zipUrl = (result.zip_download_url || '').trim();
      if (zipUrl) {
        setJianyingDownloadUrl(zipUrl);
        appendLog('Jianying', `✓ 剪映草稿 ZIP：${zipUrl}`);
      }

      // 3) 分批导出：展示多个 ZIP 链接
      if ((result as any)._batched) {
        const urls: string[] = (result as any)._batchZipUrls || [];
        const labels: string[] = (result as any)._batchPartLabels || [];
        const batchLinks = urls
          .map((u, i) => ({
            filename: `${draftName}_part${i + 1}.zip`,
            url: u,
            partLabel: labels[i] || `Part ${i + 1}`,
          }))
          .filter((x) => !!x.url);
        setJianyingBatchLinks(batchLinks);
        if (batchLinks.length > 0) {
          toast.success(`剪映分批导出成功：${shots.length} 镜头（${batchLinks.length} 个 ZIP）`, 5000);
        }
      } else {
        toast.success('剪映草稿导出成功', 3000);
      }
    } catch (e: any) {
      appendLog('ERROR', `剪映导出失败：${e.message}`);
      toast.error(`剪映导出失败：${e.message}`, 5000);
    } finally {
      setJianyingExporting(false);
    }
  }, [
    mode,
    finalCover,
    ttsResult,
    customTracks,
    rawCopy,
    toast,
    appendLog,
    buildJianyingShotsFromAiMode,
    buildJianyingShotsFromCustomTracks,
    prepareShotsForJianyingExport,
  ]);

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
    setEnabledSchemes(new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G'] as ('A'|'B'|'C'|'D'|'E'|'F'|'G')[]));
    setTtsResult(null);
    setTtsError(null);
    setTtsProgress(null);
    setVideoUrl('');
    setAnalysisError(null);
    setRawCopy('');
    setMode('ai');
    setCustomTracks(createEmptyCustomTracksState());
    clearPersisted();
    toast.success('已重置', 1500);
  }, [appendLog, toast]);

  // ──────────────────────────────────────────────
  // 渲染
  // ──────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* ═══════════════ 模式切换 ═══════════════ */}
      {/* v11.1：cover-only 模式下隐藏模式切换 UI（封面模块只走 AI 模式） */}
      {!isCoverOnly && (
      <div className="flex items-center gap-1 bg-slate-900/70 border border-slate-700 rounded-lg p-1 w-fit">
        <button
          onClick={() => setMode('ai')}
          className={`px-4 py-2 text-sm font-bold rounded-md flex items-center gap-2 transition-all ${
            mode === 'ai'
              ? 'bg-emerald-600 text-white shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          type="button"
        >
          <Sparkles size={14} /> AI 一键成片
        </button>
        <button
          onClick={() => setMode('custom')}
          className={`px-4 py-2 text-sm font-bold rounded-md flex items-center gap-2 transition-all ${
            mode === 'custom'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          type="button"
        >
          <ImageIcon size={14} /> 自定义素材成片
        </button>
      </div>
      )}

      {/* ═══════════════ 顶部 ═══════════════ */}
      {/* v11.1：cover-only 模式下强制走 AI 模式（封面模块不需要自定义素材功能） */}
      {(mode === 'ai' || isCoverOnly) ? (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ───────────── 左栏：文案输入 + 角色参考图 ───────────── */}
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-emerald-400" />
            <h3 className="text-lg font-bold text-emerald-300">{isCoverOnly ? '封面生成' : '文案输入'}</h3>
            <span className="text-xs text-slate-500">
              {isCoverOnly
                ? '一段文案 → 7 种封面方案（场景沉浸/极简底/高反差特写/纵向分屏/信息图/人像+大字/长文案复仇海报）'
                : '一段文案 → 一张封面 → 一段配音 → 一镜到底视频'}
            </span>
            <span className="ml-auto text-[10px] text-emerald-500/70 bg-emerald-500/10 px-2 py-0.5 rounded">
              {isCoverOnly ? 'v11.1 · 封面模块 · 7 套方案对比' : 'v1.2 · 锁定封面 / 标题编辑 / 4 色文字特效 / 语音库 / Remotion 导出'}
            </span>
          </div>

          {/* v10.6.2：隐藏的视频文件 input（抖音 NEEDS_VIDEO_FILE 时自动触发） */}
          <input
            ref={extractVideoFileRef}
            type="file"
            accept="video/mp4,video/quicktime,video/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleExtractVideoFile(f);
              // reset so selecting same file again still fires change
              e.target.value = '';
            }}
          />

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-slate-400 font-semibold block">
                你的文案（500 字以上最佳）
              </label>
              {/* v10.6：链接一键提取文案（抖音 / 今日头条） */}
              <div className="flex items-center gap-1">
                {transcribingVideo ? (
                  <span className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-violet-300 bg-violet-500/10 rounded">
                    <Loader2 size={11} className="animate-spin" />
                    <span>视频转写中</span>
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={handleExtractScript}
                  disabled={extractingUrl || transcribingVideo || analyzing}
                  title="粘贴抖音/今日头条链接后点击，自动提取文案填入下方输入框"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-violet-600 hover:bg-violet-500 text-white shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {extractingUrl ? (
                    <>
                      <Loader2 size={11} className="animate-spin" />
                      <span>提取中</span>
                    </>
                  ) : (
                    <>
                      <Link2 size={11} />
                      <span>提取文案</span>
                    </>
                  )}
                </button>
              </div>
            </div>
            <textarea
              value={rawCopy}
              onChange={(e) => setRawCopy(e.target.value)}
              disabled={analyzing}
              rows={10}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500 resize-y min-h-[200px]"
              placeholder="粘贴抖音/今日头条链接，点击右上「提取文案」自动导入；或直接粘贴需要做成视频的文案/口播稿...建议 300-3000 字，系统会切 5 段并行配音。"
            />
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-slate-500">
                当前 <span className={charCount >= 50 ? 'text-emerald-400 font-semibold' : 'text-amber-400'}>{charCount}</span> 字 · 字数不限（按需粘贴完整文案/口播稿）
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

          {/* v10.6.3：抖音短链 → 需要视频文件，引导条（不再自动 click file input） */}
          {needsVideoUpload && (
            <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-3">
              <div className="flex items-start gap-2">
                <span className="text-amber-400 text-base leading-none">⚠️</span>
                <div className="flex-1 text-xs text-amber-200/90 leading-relaxed">
                  <div className="font-semibold text-amber-300 mb-1">抖音 SSR 不再内嵌作者文案</div>
                  <div className="text-amber-200/70">
                    现代抖音页面（2026+ SPA）的详情数据走前端 SDK + 签名，前端无法直接抓。
                    请通过以下任一方式提供视频源，系统会用 Whisper ASR 转写为文案：
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setNeedsVideoUpload(false)}
                  className="text-amber-400/60 hover:text-amber-300 text-xs"
                  title="关闭引导"
                >
                  ✕
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-2">
                {/* 方式 1：上传本地视频文件 */}
                <button
                  type="button"
                  onClick={() => extractVideoFileRef.current?.click()}
                  disabled={transcribingVideo}
                  className="flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {transcribingVideo ? <Loader2 size={12} className="animate-spin" /> : '📁'}
                  <span>上传视频文件 (mp4/mov)</span>
                </button>

                {/* 方式 2：粘贴视频直链 */}
                <div className="flex items-stretch gap-1">
                  <input
                    type="text"
                    value={videoUrlInput}
                    onChange={(e) => setVideoUrlInput(e.target.value)}
                    placeholder="或粘贴无水印视频直链 https://..."
                    disabled={transcribingVideo}
                    className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-[11px] text-slate-100 focus:outline-none focus:border-violet-500 placeholder-slate-600"
                  />
                  <button
                    type="button"
                    onClick={handleExtractVideoUrl}
                    disabled={transcribingVideo || !videoUrlInput.trim()}
                    className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    转写
                  </button>
                </div>
              </div>
            </div>
          )}

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

          {/* v11.0：方案选择器（A~G 勾选），控制一次解析生成哪些方案
              - 点击方案按钮切换勾选状态（最少保留 1 个）
              - 全选/全不选快捷操作
              - 实际传给 LLM 的 prompt 会按勾选数量动态裁剪 */}
          <div className="bg-slate-900/50 border border-emerald-700/40 rounded-lg p-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <SettingsIcon size={14} className="text-emerald-400" />
                <span className="text-xs text-slate-300 font-semibold">
                  一次生成 <span className="text-emerald-300 font-bold">{schemeCount}</span> 套方案
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setEnabledSchemes(new Set(['A','B','C','D','E','F','G'] as ('A'|'B'|'C'|'D'|'E'|'F'|'G')[]))}
                  className="text-[10px] px-2 py-0.5 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/40 transition-colors"
                >
                  全选
                </button>
                <button
                  type="button"
                  onClick={() => setEnabledSchemes(new Set(['A'] as ('A'|'B'|'C'|'D'|'E'|'F'|'G')[]))}
                  className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700 transition-colors"
                >
                  全不选
                </button>
                <span className="text-[10px] text-slate-500 font-mono ml-1">
                  已选 {enabledSchemes.size}/7
                </span>
              </div>
            </div>
            {/* 7 个方案按钮：方案名 + 描述，类似模版选择器风格 */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {(
                [
                  { k: 'A' as const, label: 'A', desc: '场景沉浸' },
                  { k: 'B' as const, label: 'B', desc: '极简底' },
                  { k: 'C' as const, label: 'C', desc: '高反差特写' },
                  { k: 'D' as const, label: 'D', desc: '纵向分屏' },
                  { k: 'E' as const, label: 'E', desc: '信息图/数据牌' },
                  { k: 'F' as const, label: 'F', desc: '人像+大字横幅' },
                  { k: 'G' as const, label: 'G', desc: '长文案/复仇海报' },
                ] as const
              ).map(({ k, label, desc }) => {
                const on = enabledSchemes.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleScheme(k)}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-all font-medium ${
                      on
                        ? 'bg-emerald-600/30 border-emerald-500/50 text-emerald-200'
                        : 'bg-slate-900/60 border-slate-700 text-slate-500 hover:border-slate-600'
                    }`}
                    title={on ? `取消勾选 方案${label}（${desc}）` : `勾选 方案${label}（${desc}）`}
                  >
                    {on ? <Check size={11} className="text-emerald-400 flex-shrink-0" /> : null}
                    <span className={on ? 'text-emerald-200' : ''}>方案{label}</span>
                    <span className="text-slate-500">·</span>
                    <span className={on ? 'text-emerald-300/80' : 'text-slate-600'}>{desc}</span>
                  </button>
                );
              })}
            </div>
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
                <Wand2 size={18} /> 智能解析 → 生成 {schemeCount} 套方案
              </>
            )}
          </button>
          {/* v2.7：跳过 AI 直接上传封面（即便不点智能解析也能用） */}
          {/* v2.7：跳过 AI 直接上传封面 + 即时预览（不依赖智能解析） */}
          <div className="bg-slate-900/50 border border-emerald-700/60 rounded-lg p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-emerald-300 font-bold">
                ✨ 跳过 AI · 手动上传封面
              </div>
              {finalCover && (
                <button
                  type="button"
                  onClick={() => {
                    setGeneratedCovers(new Map());
                    setFinalCoverIndex(null);
                    appendLog('IMG', '已清除终封面');
                    toast.info('已清除终封面');
                  }}
                  className="text-[10px] text-red-400 hover:text-red-300"
                  title="清除终封面，重新选择"
                >
                  ✕ 清除
                </button>
              )}
            </div>
            {finalCover ? (
              <>
                <div
                  className={`relative w-full ${COVER_RATIO_CLASSES[coverRatio] ?? 'aspect-video'} rounded overflow-hidden border border-slate-700 bg-slate-950`}
                  data-cover-ratio={coverRatio}
                  data-actual-size={
                    finalCover.actualWidth && finalCover.actualHeight
                      ? `${finalCover.actualWidth}x${finalCover.actualHeight}`
                      : 'unknown'
                  }
                >
                  <img
                    src={finalCover.url}
                    alt="终封面预览"
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                </div>
                <div className="text-[10px] text-slate-400 truncate" title={finalCover.title}>
                  {finalCover.emoji} {finalCover.title}
                </div>
                <button
                  type="button"
                  onClick={() => handleDownloadCover(finalCover)}
                  className="w-full text-[10px] px-2 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center justify-center gap-1"
                >
                  <Download size={10} /> 下载终封面
                </button>
              </>
            ) : (
              <div className="text-[10px] text-slate-500">尚未上传封面，点下方按钮选择本地图片</div>
            )}
            <label
              className="w-full px-3 py-2 bg-emerald-700/40 hover:bg-emerald-700/60 border border-emerald-600/50 text-emerald-100 rounded-lg flex items-center justify-center gap-2 cursor-pointer transition-all text-xs font-medium"
              title="上传本地图片作为终封面（PNG/JPG/WebP）"
            >
              <Upload size={14} />
              <span>{finalCover ? '换一张' : '选择本地图片'}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUploadManualCover(0, f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {analyzing && (
            <label className="flex items-center gap-2 bg-slate-800/50 border border-purple-700 rounded-lg px-3 py-2 cursor-pointer hover:bg-slate-700/50 transition-colors">
              <input
                type="checkbox"
                checked={parallelTtsEnabled}
                onChange={(e) => setParallelTtsEnabled(e.target.checked)}
                className="w-4 h-4 accent-purple-500"
              />
              <Mic size={14} className="text-purple-400" />
              <span className="text-xs text-purple-300">
                解析完成后自动生成 5 段并行配音
              </span>
            </label>
          )}

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
                    // ── 监控点 #0：用户点击比例按钮 ──
                    console.log('[封面比例监控] 用户切换比例', {
                      from: coverRatio,
                      to: r.id,
                      willTriggerReset: true, // setGeneratedCovers(new Map()) 会清空旧的
                    });
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

          {/* 多套方案（多选） */}
          {analysisResult && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">
                点击卡片多选（已选 {selectedIndices.size} / {liveTitleOptions.length}）· 标题可直接编辑 · 封面可锁定不重新生成 · 每条方案按封面赛道差异化（{liveTitleOptions.length >= 7 ? '场景沉浸/极简底/高反差特写/纵向分屏/信息图数据牌/人像+大字横幅/长文案复仇海报' : `本次解析生成 ${liveTitleOptions.length} 套 A~${['A','B','C','D','E','F','G'][Math.max(0, liveTitleOptions.length - 1)]}`}）
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
                            {opt.emoji} 方案{opt.schemeId || ['A', 'B', 'C', 'D', 'E', 'F', 'G'][idx % 7]} · {COVER_SCHEME_NAMES[opt.schemeId as keyof typeof COVER_SCHEME_NAMES] || COVER_SCHEME_NAMES[['A', 'B', 'C', 'D', 'E', 'F', 'G'][idx % 7] as keyof typeof COVER_SCHEME_NAMES]}
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
                          {/* v2.7：手动上传封面（无需 AI） */}
                          <label
                            className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 bg-emerald-700/60 text-emerald-100 hover:bg-emerald-600/80 cursor-pointer"
                            title="手动上传本地图片作为此方案封面（跳过 AI 生成）"
                          >
                            <Upload size={10} />
                            上传封面
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleUploadManualCover(idx, f);
                                e.target.value = '';
                              }}
                            />
                          </label>
                        </div>
                      </div>

                      {/* 方案标识（封面赛道 A~G 模板，含长文案/复仇海报 G） */}
                      <div className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                        <span className="px-1.5 py-0.5 bg-slate-800 rounded font-mono font-bold">
                          VAR {opt.schemeId || ['A', 'B', 'C', 'D', 'E', 'F', 'G'][idx % 7]}
                        </span>
                        <span className="text-slate-500">{COVER_SCHEME_NAMES[opt.schemeId as keyof typeof COVER_SCHEME_NAMES] || COVER_SCHEME_NAMES[['A', 'B', 'C', 'D', 'E', 'F', 'G'][idx % 7] as keyof typeof COVER_SCHEME_NAMES]}</span>
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
                            data-cover-ratio={coverRatio}
                            data-actual-size={(() => {
                              const e = generatedCovers.get(idx);
                              return e?.actualWidth && e?.actualHeight ? `${e.actualWidth}x${e.actualHeight}` : 'unknown';
                            })()}
                            data-generated-ratio={generatedCovers.get(idx)?.ratio || 'unknown'}
                            title={`coverRatio=${coverRatio} | generated=${generatedCovers.get(idx)?.ratio || '?'}`}
                          >
                            {hasCover && (
                              <img
                                src={generatedCovers.get(idx)!.url}
                                alt={`封面 ${idx + 1}`}
                                className={`absolute inset-0 w-full h-full object-contain block transition-opacity duration-300 ${
                                  isGenerating ? 'opacity-30' : 'opacity-100'
                                }`}
                              />
                            )}
                            {isGenerating && (
                              <div className="absolute inset-0 flex flex-col items-center justify-center text-xs text-white bg-black/40">
                                <Loader2 size={20} className="animate-spin mb-1" />
                                <span className="font-semibold">正在生成封面...</span>
                                <span className="text-[10px] text-slate-300 mt-0.5">
                                  {COVER_SCHEME_NAMES[opt.schemeId as keyof typeof COVER_SCHEME_NAMES] || COVER_SCHEME_NAMES[['A', 'B', 'C', 'D', 'E', 'F', 'G'][idx % 7] as keyof typeof COVER_SCHEME_NAMES]}
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
              {/* 绘图模型选择 */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500 shrink-0">绘图模型：</span>
                <select
                  value={coverImageModel}
                  onChange={(e) => setCoverImageModel(e.target.value as 'gpt-image-2' | 'gpt-image-2-c' | 'gemini-flash')}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] text-slate-200 focus:outline-none focus:border-amber-500 min-w-[200px]"
                >
                  <option value="gpt-image-2">gpt-image-2（/v1/images/generations）</option>
                  <option value="gpt-image-2-c">gpt-image-2-c（/v1/images/edits，需参考图）</option>
                  <option value="gemini-flash">gemini-3.1-flash-image-preview</option>
                </select>
              </div>
              {/* 全局限流状态条（仅在冷却或等待时显示） */}
              {(limiterState.cooldownMs > 0 || limiterState.waiters > 0) && (
                <div className="bg-orange-900/30 border border-orange-700 rounded p-2 text-[10px] text-orange-200 space-y-1">
                  {limiterState.cooldownMs > 0 && (
                    <div className="flex items-center gap-1.5">
                      <Loader2 size={10} className="animate-spin" />
                      <span>上游限流冷却中 · 剩余 {(limiterState.cooldownMs / 1000).toFixed(1)}s · 已自动串行化后续请求</span>
                    </div>
                  )}
                  {limiterState.waiters > 0 && limiterState.cooldownMs === 0 && (
                    <div className="flex items-center gap-1.5">
                      <Loader2 size={10} className="animate-spin" />
                      <span>排队等待槽位 · {limiterState.waiters} 个 / 最大并发 {limiterState.maxConcurrent}</span>
                    </div>
                  )}
                  <div className="text-orange-400/70">
                    当前并发 {limiterState.inFlight}/{limiterState.maxConcurrent}
                  </div>
                </div>
              )}
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
      ) : (
        /* ═══════════════ 自定义素材成片模式 ═══════════════ */
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-3">
          <div className="flex items-center gap-2">
            <ImageIcon size={18} className="text-blue-400" />
            <h3 className="text-lg font-bold text-blue-300">自定义素材成片</h3>
            <span className="text-xs text-slate-500">
              自由上传图片/视频 + 音频 → Remotion 多镜头渲染 → MP4
            </span>
            <span className="ml-auto text-[10px] text-blue-500/70 bg-blue-500/10 px-2 py-0.5 rounded">
              v1.10 · 自定义素材轨道
            </span>
          </div>
          <CustomTracksPanel
            state={customTracks}
            onChange={setCustomTracks}
            onLog={appendLog}
          />
        </div>
      )}

      {/* ═══════════════ 中部：5 段并行配音 ═══════════════ */}
      {/* v2.1：始终显示，无需等解析完成；只要文案够长（≥50 字）就可配音 */}
      {/* v11.1：cover-only 模式下隐藏配音模块（独立"封面"模块入口不提供配音） */}
      {!isCoverOnly && rawCopy.trim().length >= 50 && (
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

          {/* v2.2：手动上传音频（单段）—— 上传一个完整音频后，5 段全部跳过 AI 配音 */}
          <div className="bg-slate-900/40 border border-purple-800/50 rounded p-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-shrink-0">
                <Upload size={13} className="text-purple-400" />
                <span className="text-xs font-bold text-purple-300">手动上传音频</span>
                <span className="text-[10px] text-slate-500">（可选，上传后跳过 AI 配音，直接使用此音频）</span>
              </div>
              {uploadedFullAudio ? (
                <div className="flex items-center gap-2 ml-auto">
                  <CheckCircle size={14} className="text-emerald-400 flex-shrink-0" />
                  <span className="text-xs text-emerald-400 truncate max-w-[260px]" title={uploadedFullAudio}>
                    {uploadedFullAudio.split('/').pop()}
                  </span>
                  {uploadedFullAudioBlob && (
                    <audio src={URL.createObjectURL(uploadedFullAudioBlob)} controls className="h-7" />
                  )}
                  <button
                    onClick={() => {
                      setUploadedFullAudio(null);
                      setUploadedFullAudioBlob(null);
                      toast.info('已移除手动音频，恢复 AI 配音');
                    }}
                    className="text-[10px] text-red-400 hover:text-red-300"
                    type="button"
                  >
                    移除
                  </button>
                </div>
              ) : (
                <>
                  {/* v11.1：把 <label> + hidden <input> 改成 button + ref，避免点击 label 不触发 file picker */}
                  <button
                    onClick={() => audioInputRef.current?.click()}
                    type="button"
                    className="ml-auto cursor-pointer px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-purple-300 rounded text-xs flex items-center gap-1 transition-colors"
                  >
                    <Plus size={12} /> 选择音频文件
                  </button>
                  <input
                    ref={audioInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      // v11.2：手动上传音频不再依赖服务端 /upload-media
                      //   之前调 uploadAudioFile 上传，但服务端对大文件（≥18MB）始终返回 HTTP 500
                      //   实际上手动音频只需要本地 blob 即可：
                      //     - 显示文件名 → 直接用 file.name
                      //     - 渲染时使用 → URL.createObjectURL(file) 本地 blob URL
                      //     - Remotion 渲染时 prepareShotsForRender 会自动把 blob 转 data URL
                      //       并通过 uploadInlineDataUrlsToServer 上传到服务端（那时才需要服务端）
                      appendLog('TTS', `✓ 手动音频已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`);
                      try {
                        const durationSec = await getAudioBlobDuration(file);
                        const url = URL.createObjectURL(file);
                        const readyResult: ParallelTtsResult = {
                          mergedAudioUrl: url,
                          mergedAudioBlob: file,
                          totalDuration: durationSec,
                          segments: [
                            {
                              index: 0,
                              text: rawCopy.trim(),
                              audioUrl: url,
                              duration: durationSec,
                              success: true,
                            },
                          ],
                        };
                        setTtsResult(readyResult);
                        setTtsError(null);
                        appendLog('TTS', `✓ 手动音频就绪，时长 ${durationSec.toFixed(1)} 秒；可直接「导出 MP4」`);
                        setUploadedFullAudio(file.name);
                        setUploadedFullAudioBlob(file);
                        toast.success('✓ 手动音频已就绪，可直接「导出 MP4」');
                      } catch (dErr: any) {
                        // v11.2：解码失败也要把音频设置好（不依赖音频时长也能用）
                        appendLog('WARN', `手动音频解码失败：${dErr?.message || dErr}（仍可点击「5 段并行配音」激活）`);
                        const url = URL.createObjectURL(file);
                        const readyResult: ParallelTtsResult = {
                          mergedAudioUrl: url,
                          mergedAudioBlob: file,
                          totalDuration: 0,
                          segments: [
                            {
                              index: 0,
                              text: rawCopy.trim(),
                              audioUrl: url,
                              duration: 0,
                              success: true,
                            },
                          ],
                        };
                        setTtsResult(readyResult);
                        setTtsError(null);
                        setUploadedFullAudio(file.name);
                        setUploadedFullAudioBlob(file);
                        toast.warning(`手动音频已就绪，但时长探测失败：${dErr?.message || dErr}`);
                      }
                      e.target.value = '';
                    }}
                  />
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerateTts}
              disabled={ttsGenerating || rawCopy.trim().length < 50 || !runningHubApiKey?.trim()}
              title={
                rawCopy.trim().length < 50
                  ? '文案需 ≥ 50 字才能配音'
                  : !runningHubApiKey?.trim()
                  ? '请先在顶部输入 RunningHub API Key'
                  : '只需有文案即可启动 5 段并行配音（不依赖智能解析）'
              }
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
                <div className="flex items-center gap-2">
                  {/* MP3 下载（合并后） */}
                  <button
                    onClick={async () => {
                      if (!ttsResult) return;
                      const triggerDownload = (blob: Blob, label: string) => {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `tts_${Date.now()}.mp3`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(() => URL.revokeObjectURL(url), 30000);
                        toast.success(`MP3 下载成功 · ${label} (${(blob.size / 1024).toFixed(1)} KB)`, 2500);
                      };

                      // 调试日志：让用户能看到实际下载的字节数和源 URL
                      console.log('[MP3 下载] mergedMp3Blob 状态:', {
                        exists: !!ttsResult.mergedMp3Blob,
                        size: ttsResult.mergedMp3Blob?.size,
                        type: ttsResult.mergedMp3Blob?.type,
                        segmentsCount: ttsResult.segments.length,
                        successSegments: ttsResult.segments.filter(s => s.success).length,
                      });

                      // 主路径 1：TTS 已经合并好 mp3（来自 RunningHub 原始 mp3 段拼接，零重编码损失）
                      if (ttsResult.mergedMp3Blob && ttsResult.mergedMp3Blob.size > 1024) {
                        try {
                          triggerDownload(ttsResult.mergedMp3Blob, '来自 RunningHub 原始 mp3');
                          appendLog('TTS', `✓ MP3 下载成功 (合并 mp3, ${(ttsResult.mergedMp3Blob.size / 1024).toFixed(1)} KB)`);
                          return;
                        } catch (e) {
                          console.warn('[MP3] 原始 mp3 blob 下载失败，降级', e);
                          appendLog('WARN', `原始 mp3 blob 下载失败：${e?.message || e}`);
                        }
                      }

                      // 主路径 2：手动上传的音频本身就是 mp3/m4a，直接用
                      try {
                        const headBlob = ttsResult.mergedAudioBlob;
                        const headType = headBlob?.type || '';
                        const headBuf = await (headBlob || await (await fetch(ttsResult.mergedAudioUrl)).blob()).slice(0, 16).arrayBuffer();
                        const headBytes = new Uint8Array(headBuf);
                        // ID3 开头 = "ID3" (0x49 0x44 0x33) → 是 mp3
                        const isMp3 = headType.includes('mpeg') || headType.includes('mp3') ||
                          (headBytes[0] === 0x49 && headBytes[1] === 0x44 && headBytes[2] === 0x33) ||
                          // MP3 sync byte: 0xFF 0xFB / 0xFF 0xFA / 0xFF 0xF3 / 0xFF 0xF2
                          (headBytes[0] === 0xff && (headBytes[1] & 0xe0) === 0xe0);
                        if (isMp3 && headBlob && headBlob.size > 1024) {
                          triggerDownload(headBlob, '原始上传即为 MP3');
                          return;
                        }
                      } catch { /* ignore */ }

                      // 兜底 1：客户端 MediaRecorder 转码
                      toast.info('正在浏览器内转码 MP3...', 1500);
                      try {
                        const mp3Blob = await convertWavBlobToMp3(
                          ttsResult.mergedAudioBlob || await (await fetch(ttsResult.mergedAudioUrl)).blob()
                        );
                        triggerDownload(mp3Blob, '浏览器转码');
                        return;
                      } catch (e: any) {
                        console.warn('[MP3] 客户端 MediaRecorder 转码失败：', e);
                      }

                      // 兜底 2：服务端 ffmpeg 路径（旧的 /audio/convert-to-mp3）
                      try {
                        toast.warning('客户端转码失败，尝试服务端转码...', 3000);
                        const baseUrl = (window as any).__REMOTION_SERVER_URL__ || getRemotionApiBase();
                        const res = await fetch(ttsResult.mergedAudioUrl);
                        const blob = await res.blob();
                        const arrayBuffer = await blob.arrayBuffer();
                        const fd = new FormData();
                        fd.append('audio', new File([arrayBuffer], 'merged.wav', { type: 'audio/wav' }));
                        const resp = await fetch(`${baseUrl}/audio/convert-to-mp3`, {
                          method: 'POST',
                          body: fd,
                        });
                        const result = await resp.json();
                        if (result.success && result.mp3Url) {
                          const a = document.createElement('a');
                          a.href = result.mp3Url;
                          a.download = `tts_${Date.now()}.mp3`;
                          a.click();
                          toast.success('MP3 下载成功（服务端转码）', 2500);
                        } else {
                          toast.error(result.error || 'MP3 转换失败');
                        }
                      } catch (e2: any) {
                        toast.error(`MP3 下载失败：${e2?.message || e2}`, 6000);
                      }
                    }}
                    className="text-[10px] text-green-400 hover:text-green-300 flex items-center gap-1"
                  >
                    <Download size={10} /> 下载 MP3
                  </button>
                  {/* 分段 mp3 下载（保底：5 段 mp3 URL 直接下载，由用户用 Audacity 等合并） */}
                  <button
                    onClick={async () => {
                      if (!ttsResult) return;
                      const successSegs = ttsResult.segments.filter((s) => s.success && s.audioUrl);
                      if (successSegs.length === 0) {
                        toast.error('没有可下载的 mp3 段');
                        return;
                      }
                      toast.info(`正在下载 ${successSegs.length} 段 mp3...`, 2000);
                      for (let i = 0; i < successSegs.length; i++) {
                        const s = successSegs[i];
                        try {
                          // 如果是 blob: URL 直接 fetch；http: URL 也 fetch
                          const res = await fetch(s.audioUrl);
                          if (!res.ok) throw new Error(`HTTP ${res.status}`);
                          const blob = await res.blob();
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `tts_segment_${i + 1}_of_${successSegs.length}.mp3`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          setTimeout(() => URL.revokeObjectURL(url), 30000);
                          // 浏览器多文件下载会被拦截，这里串行延迟触发
                          await new Promise((r) => setTimeout(r, 600));
                        } catch (e: any) {
                          appendLog('ERROR', `分段 mp3 ${i + 1} 下载失败：${e?.message || e}`);
                        }
                      }
                      appendLog('TTS', `✓ 分段 mp3 下载完成（${successSegs.length} 段）`);
                      toast.success(`分段 mp3 下载完成（${successSegs.length} 段），用 Audacity 拼接`, 4000);
                    }}
                    className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1"
                    title="下载 5 段原始 mp3 到本地，用 Audacity/ffmpeg 拼接（保底方案）"
                  >
                    <Download size={10} /> 下载分段
                  </button>
                  {/* WAV 下载 */}
                  <a
                    href={ttsResult.mergedAudioUrl}
                    download={`tts_${Date.now()}.wav`}
                    className="text-[10px] text-blue-400 hover:text-blue-300 underline flex items-center gap-1"
                  >
                    <Download size={10} /> 下载 WAV
                  </a>
                </div>
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
      {/* v11.1：cover-only 模式下隐藏"导出"和"Remotion 设置"部分，仅保留终端日志 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {!isCoverOnly && (
          <>
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
            <div className="bg-slate-900/50 border border-emerald-700 rounded p-2 text-xs space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-emerald-400 font-bold">✓ 终封面已选</div>
                <button
                  type="button"
                  onClick={() => {
                    setGeneratedCovers(new Map());
                    setFinalCoverIndex(null);
                    appendLog('IMG', '已清除终封面');
                    toast.info('已清除终封面');
                  }}
                  className="text-[10px] text-red-400 hover:text-red-300"
                  title="清除终封面，重新选择"
                >
                  ✕ 清除
                </button>
              </div>
              <div className="text-slate-300 truncate" title={finalCover.title}>
                {finalCover.emoji} [{finalCover.schemeId ? COVER_SCHEME_NAMES[finalCover.schemeId] || COVER_SCHEME_NAMES.A : COVER_SCHEME_NAMES.A}] {finalCover.title}
              </div>
              {/* 实际显示终封面图片（v2.7：跳过 AI 场景的关键，让用户立即看到上传的图） */}
              <div
                className={`relative w-full ${COVER_RATIO_CLASSES[coverRatio] ?? 'aspect-video'} rounded overflow-hidden border border-slate-700 bg-slate-950`}
                data-cover-ratio={coverRatio}
                data-actual-size={
                  finalCover.actualWidth && finalCover.actualHeight
                    ? `${finalCover.actualWidth}x${finalCover.actualHeight}`
                    : 'unknown'
                }
              >
                <img
                  src={finalCover.url}
                  alt="终封面预览"
                  className="absolute inset-0 w-full h-full object-contain"
                />
              </div>
              {/* 下载按钮 */}
              <button
                type="button"
                onClick={() => handleDownloadCover(finalCover)}
                className="w-full text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center justify-center gap-1"
              >
                <Download size={10} /> 下载终封面
              </button>
            </div>
          ) : (
            <div className="bg-slate-900/50 border border-slate-700 rounded p-2 text-xs text-slate-500">
              尚未选定终封面（点上方「跳过 AI，直接上传封面图」即可手动上传）
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

          {(customTracks.subtitleCues?.length ?? 0) > 0 && (
            <div className="flex items-center gap-2 mt-2 px-2">
              <label className="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoOptimize}
                  onChange={(e) => {
                    setAutoOptimize(e.target.checked);
                    localStorage.setItem('AUTO_OPTIMIZE_SUBTITLE', String(e.target.checked));
                  }}
                  className="accent-emerald-500"
                />
                ASR 后自动 AI 优化字幕
              </label>
            </div>
          )}

          {/* 手动 AI 优化字幕按钮 */}
          {(customTracks.subtitleCues?.length ?? 0) > 0 && (
            <button
              onClick={async () => {
                if (!customTracks.subtitleCues?.length) return;
                const effectiveKey = typeof window !== 'undefined'
                  ? (window.localStorage.getItem('API_KEY_yunwu')
                      || window.localStorage.getItem('API_KEY_google')
                      || window.localStorage.getItem('API_KEY_runninghub')
                      || window.localStorage.getItem('YUNWU_API_KEY')
                      || window.localStorage.getItem('GEMINI_API_KEY')
                      || window.localStorage.getItem('OPENLUX_API_KEY')
                      || (window as any).localStorage.getItem('OPENAI_API_KEY'))
                  : null;
                if (!effectiveKey) {
                  appendLog('ASR', `⚠ 请先在设置中配置 AI API Key`);
                  toast.error('请先在设置中配置 AI API Key', 4000);
                  return;
                }
                setWhisperRunning(true);
                appendLog('ASR', `▸ AI 优化字幕中…`);
                try {
                  const result = await optimizeSubtitles(customTracks.subtitleCues, effectiveKey, (cur, total) => {
                    appendLog('ASR', `  AI 优化: ${cur}/${total}`);
                  });
                  if (result.success) {
                    setCustomTracks((prev) => ({
                      ...prev,
                      subtitleCues: result.optimizedCues,
                      subtitleFileName: undefined,
                    }));
                    appendLog('ASR', `✓ AI 优化完成：${result.optimizedCues.length} 条字幕`);
                  } else {
                    appendLog('ASR', `⚠ AI 优化失败: ${result.error}`);
                    alert('AI 优化失败: ' + (result.error || '未知错误'));
                  }
                } catch (e: any) {
                  appendLog('ASR', `✗ AI 优化出错: ${e.message}`);
                  alert('AI 优化出错: ' + e.message);
                } finally {
                  setWhisperRunning(false);
                }
              }}
              disabled={whisperRunning || !(customTracks.subtitleCues?.length ?? 0)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded border bg-emerald-600 border-emerald-500 text-white hover:bg-emerald-500 disabled:opacity-40 transition-all"
              type="button"
            >
              ✨ AI 优化字幕
            </button>
          )}

          {/* ASR 进度提示框（导出 MP4 时显示） */}
          {whisperRunning && (
            <div className="bg-purple-900/30 border border-purple-700 rounded p-2 text-[10px] text-purple-300 flex items-center gap-1.5">
              <Loader2 size={10} className="animate-spin" />
              Whisper ASR 进行中 {whisperProgress.done}/{whisperProgress.total} ({whisperProgress.current})
            </div>
          )}

          {/* 导出前置条件提示（缺图/缺音时显示，让用户明确知道还差什么） */}
          {(() => {
            const missing: string[] = [];
            if (mode === 'ai') {
              if (!finalCover) missing.push('封面');
              if (!ttsResult) missing.push('配音');
            } else {
              if (customTracks.videoItems.length === 0) missing.push('视频/图片素材');
              if (!customTracks.audioUrl) missing.push('音频');
            }
            if (missing.length === 0 || videoGenerating) return null;
            return (
              <div className="bg-amber-900/30 border border-amber-700/60 rounded p-2 text-[10px] text-amber-200 flex items-start gap-1.5">
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                <span>导出按钮已置灰，需先添加：<b>{missing.join(' + ')}</b>。提示：封面可点击方案卡片的「上传封面」按钮手动上传；音频可点上方「选择音频文件」按钮。</span>
              </div>
            );
          })()}

          {/* MP4 导出按钮 */}
          <button
            onClick={handleExportMp4}
            disabled={
              videoGenerating ||
              (mode === 'ai'
                ? !finalCover || !ttsResult
                : customTracks.videoItems.length === 0 || !customTracks.audioUrl)
            }
            className="w-full px-3 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed transition-all"
            type="button"
            title={
              mode === 'ai'
                ? !finalCover
                  ? '请先生成至少 1 张封面（或选定终封面）'
                  : !ttsResult
                  ? '请先生成配音（点上方「5 段并行配音」或先上传手动音频）'
                  : '导出 MP4'
                : customTracks.videoItems.length === 0
                ? '请先上传视频/图片素材'
                : !customTracks.audioUrl
                ? '请先上传音频'
                : '导出 MP4'
            }
          >
            {videoGenerating ? (
              <>
                <Loader2 size={14} className="animate-spin" /> {videoProgress}% · {videoMessage || '渲染中...'}
              </>
            ) : (
              <>
                <Film size={14} /> 导出 MP4（{mode === 'ai' ? `${(finalCover?.title || '').slice(0, 16)}` : `${customTracks.videoItems.length} 镜头`} · Remotion 渲染）
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

          {/* ── 一键剪映：分开发按钮 ── */}
          <div className="border-t border-slate-700/60 pt-3 mt-1 space-y-2">
            <button
              onClick={handleExportJianying}
              disabled={
                jianyingExporting ||
                videoGenerating ||
                (mode === 'ai'
                  ? !finalCover || !ttsResult
                  : customTracks.videoItems.length === 0 || !customTracks.audioUrl)
              }
              className="w-full px-3 py-2.5 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed transition-all"
              type="button"
              title={
                mode === 'ai'
                  ? !finalCover
                    ? '请先选定终封面'
                    : !ttsResult
                    ? '请先生成配音'
                    : '一键生成剪映草稿（本地服务导出到剪映目录 / 远程打包 ZIP 下载）'
                  : customTracks.videoItems.length === 0
                  ? '请先上传视频/图片素材'
                  : !customTracks.audioUrl
                  ? '请先上传音频'
                  : '一键生成剪映草稿（本地服务导出到剪映目录 / 远程打包 ZIP 下载）'
              }
            >
              {jianyingExporting ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> 导出剪映草稿中…
                </>
              ) : (
                <>
                  <Scissors size={14} /> 一键剪映（生成剪映草稿）
                </>
              )}
            </button>

            {/* 剪映进度条 */}
            {jianyingExporting && (
              <div className="space-y-1">
                <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-fuchsia-500 h-full transition-all duration-300"
                    style={{ width: `${Math.max(0, Math.min(100, jianyingProgress))}%` }}
                  />
                </div>
                <div className="text-[10px] text-slate-400 flex items-center justify-between">
                  <span className="truncate">{jianyingProgressMessage || '处理中...'}</span>
                  <span className="ml-2 flex-shrink-0">{Math.round(jianyingProgress)}%</span>
                </div>
              </div>
            )}

            {/* 剪映草稿路径（本地模式） */}
            {jianyingDraftPath && !jianyingExporting && (
              <div className="bg-emerald-900/30 border border-emerald-700 rounded p-2 text-[10px] text-emerald-200 space-y-1">
                <div className="flex items-center gap-1 font-bold">
                  <PartyPopper size={11} className="text-emerald-400" />
                  剪映草稿已生成到本地：
                </div>
                <div className="font-mono break-all text-emerald-100/90">{jianyingDraftPath}</div>
                <div className="text-emerald-300/70">
                  打开剪映 →「草稿」会自动刷新看到；或直接拖入剪映即可继续编辑。
                </div>
              </div>
            )}

            {/* 剪映 ZIP 下载链接（远程模式） */}
            {jianyingDownloadUrl && !jianyingExporting && (
              <a
                href={jianyingDownloadUrl}
                download={`copybased_jianying_${Date.now()}.zip`}
                target="_blank"
                rel="noopener"
                className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs flex items-center justify-center gap-1"
              >
                <Download size={12} /> 下载剪映草稿 ZIP
              </a>
            )}

            {/* 分批 ZIP 链接列表 */}
            {jianyingBatchLinks.length > 0 && !jianyingExporting && (
              <div className="bg-fuchsia-900/20 border border-fuchsia-700/60 rounded p-2 space-y-1">
                <div className="text-[10px] text-fuchsia-200 font-bold flex items-center gap-1">
                  <PartyPopper size={11} /> 分批导出（共 {jianyingBatchLinks.length} 个 ZIP，需全部下载后解压到同一目录合并草稿）：
                </div>
                {jianyingBatchLinks.map((b) => (
                  <a
                    key={b.url}
                    href={b.url}
                    download={b.filename}
                    target="_blank"
                    rel="noopener"
                    className="block w-full px-2 py-1.5 bg-fuchsia-700 hover:bg-fuchsia-600 text-white rounded text-[10px] flex items-center gap-1"
                  >
                    <Download size={10} /> {b.partLabel} · {b.filename}
                  </a>
                ))}
              </div>
            )}
          </div>

          <p className="text-[10px] text-slate-500">
            视频导出走 Remotion 渲染服务（端口 18093）。模板/分辨率/字幕/转场/运动均可在「渲染设置」中调整。
          </p>
          <p className="text-[10px] text-slate-500">
            剪映草稿走本地 18091 / Railway 服务（Python 直接写入剪映草稿目录或打包 ZIP）。
          </p>
        </div>
          </>
        )}

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

      {/* ─────── 片头设置（与多镜头分镜同步）─────── */}
      <div className="border-t border-slate-700 pt-2">
        <div className="text-[10px] text-slate-500 mb-1">片头（与多镜头分镜同步）</div>
        <div className="flex flex-col gap-1.5">
          <select
            value={config.intro?.style ?? 'none'}
            onChange={(e) => onChange({ ...config, intro: { ...(config.intro ?? {}), style: e.target.value } })}
            className="w-full bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1 focus:outline-none focus:border-emerald-500"
          >
            <option value="none">无片头</option>
            <option value="fade_in">纯色淡入（黑底渐显标题）</option>
            <option value="slide_up">底部滑入（黄色强调）</option>
            <option value="typewriter">打字机（蓝色等宽，逐字打出）</option>
            <option value="glitch">故障风（赛博抖动感）</option>
            <option value="zoom_in">从大变小（冲击感）</option>
            <option value="split">分裂入场（左右合拢）</option>
            <option value="slide_left">左侧滑入（电光蓝，时尚节奏）</option>
            <option value="rotate_in">旋转入场（黄色，旋转放大）</option>
            <option value="blur_focus">模糊到清晰（电影感）</option>
            <option value="flash_white">闪白入场（戏剧感强）</option>
          </select>
          {(config.intro?.style ?? 'none') !== 'none' && (
            <input
              type="text"
              value={config.intro?.text ?? ''}
              onChange={(e) => onChange({ ...config, intro: { ...(config.intro ?? {}), text: e.target.value } })}
              placeholder="片头文字（可空）"
              className="w-full bg-slate-950 border border-slate-700 rounded text-[10px] text-slate-200 px-2 py-1"
            />
          )}
          {(config.intro?.style ?? 'none') !== 'none' && (
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-slate-500">时长</span>
              <input
                type="number"
                min="0.5"
                max="10"
                step="0.1"
                value={config.intro?.duration ?? ''}
                placeholder="默认"
                onChange={(e) =>
                  onChange({
                    ...config,
                    intro: {
                      ...(config.intro ?? {}),
                      duration: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
                className="flex-1 bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1"
              />
              <span className="text-[9px] text-slate-500">秒</span>
            </div>
          )}
          <div className="text-[9px] text-slate-500 leading-relaxed">
            💡 片头会加在视频最前面，独占帧时长（不影响镜头顺序）
          </div>
        </div>
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
