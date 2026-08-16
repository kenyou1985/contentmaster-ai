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
import { getSelectedVoice, type VoiceProfile } from '../services/voiceLibraryService';
import {
  renderRemotionVideo,
  checkRemotionHealth,
  getRemotionApiBase,
  buildRemotionUrl,
} from '../services/remotionExportService';
import type {
  RemotionExportConfig,
  RemotionShot,
} from '../services/remotionRenderTypes';

const SCRIPT_MAX_LEN = 8000; // 文案成片文案上限

// ── 封面比例 ───────────────────────────
const COVER_RATIOS = [
  { id: '16:9', label: '16:9 横屏', w: 1280, h: 720 },
  { id: '9:16', label: '9:16 竖屏', w: 720, h: 1280 },
  { id: '4:3', label: '4:3 标屏', w: 1280, h: 960 },
  { id: '3:4', label: '3:4 海报', w: 960, h: 1280 },
] as const;

type CoverRatioId = (typeof COVER_RATIOS)[number]['id'];

// ── Remotion 模板（与 MediaGenerator 的 RemotionTemplates 对齐） ────────
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
  recommendedMotion: 'kenBurns' | 'kenBurnsSlow' | 'zoomIn' | 'push';
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
];

const SUBTITLE_STYLES = [
  { id: 'default', label: '经典（单色描边）' },
  { id: 'stroke', label: '强描边（多色字）' },
  { id: 'tiktok', label: 'TikTok 双色' },
  { id: 'karaoke', label: '卡拉 OK' },
] as const;

type SubtitleStyleId = (typeof SUBTITLE_STYLES)[number]['id'];

// ── 持久化 ───────────────────────────
const STORAGE_KEY = 'COPY_BASED_STATE_V1_2';

interface PersistedState {
  rawCopy: string;
  editedTitles: Record<number, string>; // 用户编辑后的标题
  lockedCoverIndices: number[]; // 锁定的封面索引（不重新生成）
  coverRatio: CoverRatioId;
  selectedIndices: number[];
  finalCoverIndex: number | null;
  selectedVoiceId: string | null;
  remotionConfig: RemotionExportConfig | null;
  // 重新解析时不会保存 result（避免大对象），用户主动刷新时清空
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
        : [0]
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

  /** 多套封面图 */
  const [generatedCovers, setGeneratedCovers] = useState<Map<number, CoverImageEntry>>(new Map());
  const [coversGenerating, setCoversGenerating] = useState<Set<number>>(new Set());
  const [coverErrors, setCoverErrors] = useState<Map<number, string>>(new Map());

  const [ttsProgress, setTtsProgress] = useState<ParallelTtsProgress | null>(null);
  const [ttsGenerating, setTtsGenerating] = useState<boolean>(false);
  const [ttsResult, setTtsResult] = useState<ParallelTtsResult | null>(null);
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

  /** 终端日志 */
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
    savePersisted({
      rawCopy,
      editedTitles,
      lockedCoverIndices: Array.from(lockedCoverIndices),
      coverRatio,
      selectedIndices: Array.from(selectedIndices),
      finalCoverIndex,
      selectedVoiceId: selectedVoice?.id ?? null,
      remotionConfig,
    });
  }, [
    rawCopy,
    editedTitles,
    lockedCoverIndices,
    coverRatio,
    selectedIndices,
    finalCoverIndex,
    selectedVoice,
    remotionConfig,
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
    setSelectedIndices(new Set([0]));
    setFinalCoverIndex(null);
    setEditedTitles({});
    setLockedCoverIndices(new Set());
    setGeneratedCovers(new Map());
    setCoverErrors(new Map());
    setTtsResult(null);
    setVideoUrl('');
    try {
      appendLog('PARSE', '调用 GPT-5.6-Luna 解析（预计 10~30s）...');
      const r = await analyzeCopyWithLlm(apiKey, rawCopy, COPY_ANALYSIS_PROMPT, (msg) => {
        appendLog('PARSE', msg.replace(/^\[.*?\] /, ''));
      });
      setAnalysisResult(r);
      appendLog('PARSE', `解析成功：${r.titleOptions.length} 套方案 + 人物「${r.characterInfo.name || '未识别'}」`);
      if (r.summary) appendLog('PARSE', `摘要：${r.summary}`);
      r.titleOptions.forEach((opt, i) => {
        appendLog('PARSE', `方案${i + 1} [${opt.styleTag}]：${opt.title}`);
      });
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
  // 生成封面（单套）— 强化提示词：白/黄/红/绿 + 关键词加粗放大
  // ──────────────────────────────────────────────
  const generateSingleCover = useCallback(
    async (optionIdx: number, option: CopyTitleOption) => {
      if (!apiKey?.trim()) {
        appendLog('ERROR', '云雾 API Key 未配置');
        toast.error('请先在顶部输入云雾 API Key', 4000);
        return;
      }
      const character = analysisResult?.characterInfo as CopyCharacterInfo | undefined;

      // 关键 1：把完整标题嵌入 prompt，强制 AI 显示完整文字
      // 关键 2：白/黄/红/绿 主色 + 关键词加粗放大
      const fullPrompt = `${option.coverPromptEn}

=== CRITICAL · 必须在画面上完整显示以下中文标题（一字不漏，禁止简化、禁止拆分成几个词）===
TEXT (display exactly): "${option.title}"
===

=== 封面文字特效铁律（务必遵循，让封面震撼）===
【主色调·4 色交替】：标题文字必须以白色 (FFFFFF)、黄色 (FFD700)、红色 (FF3300)、绿色 (00C853) 四种颜色为主。
【关键词加粗放大】：从标题中识别 1–2 个核心关键词（如人名 / 数字 / 反转词 / 动作词），将其字号放大到普通字的 1.6–1.8 倍、加粗 (font-weight 900)，并配以高对比色（白/黄/红/绿）。
【分层排版·拒绝单行】：
  - 主标题（最大字号 + 加粗 + 白/黄/红/绿色）：放在画面上 1/3 区域，占 60% 视觉重量。
  - 副标题（小字号 + 描边）：放在画面下 1/4 区域，颜色对比（黑底白字 or 红字黄底）。
  - 角标 / 印章 / 关键词徽章（小字 + 亮色）：可放右上 / 左下，作为视觉锚点。
【字体】：所有中文必须为粗体黑体 / 思源黑体 / 微软雅黑 Bold；必须有 2–4px 黑色或暗色描边；阴影模糊 6–10px。
【特效】：可加渐变光晕、爆炸式冲击、星条/箭头/红圈高亮；不允许纯黑背景上的纯白字（太单调）。
===

Style hints: ${option.styleKeywords.join(', ')}`;

      setCoversGenerating((prev) => new Set(prev).add(optionIdx));
      setCoverErrors((prev) => {
        const next = new Map(prev);
        next.delete(optionIdx);
        return next;
      });

      const size = `${currentRatio.w}x${currentRatio.h}`;
      appendLog(
        'IMG',
        `▶ 生成封面 方案${optionIdx + 1} [${option.styleTag}]：${size}（${currentRatio.label}）`
      );
      appendLog('IMG', `  标题：${option.title}（${option.title.length}字）`);
      appendLog('IMG', `  标题已嵌入 prompt，强制 AI 完整显示 · 含 4 色 + 关键词加粗放大指令`);
      if (character?.name) appendLog('IMG', `  人物：${character.name}（${character.title}）`);

      try {
        const r = await generateImage(apiKey, {
          model: 'gpt-image-2',
          prompt: fullPrompt,
          size,
          quality: 'high',
          n: 1,
          referenceDataUrls: characterRefs.length > 0 ? characterRefs : undefined,
          characterName: character?.name || undefined,
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
    [apiKey, analysisResult, characterRefs, currentRatio, toast, appendLog]
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
    if (selectedVoice) {
      appendLog('TTS', `参考音色：${selectedVoice.name}（${selectedVoice.runningHubAudioPath || '未同步 RunningHub'}）`);
    } else {
      appendLog('TTS', '未选音色，使用系统默认参考音');
    }
    setTtsGenerating(true);
    setTtsError(null);
    setTtsResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
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
          // 关键：复用语音库的 referenceAudioPath
          referenceAudioPath: selectedVoice?.runningHubAudioPath || undefined,
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
      appendLog('TTS', `✓ 5 段并行配音完成，总时长 ${r.totalDuration.toFixed(1)} 秒`);
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
    // 字幕取文案全文，按句号切分均分到时长上
    const cues = buildSubtitleCuesFromText(rawCopy, totalDuration, remotionConfig.fps);

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
  }, [finalCover, ttsResult, remotionConfig, rawCopy, toast, appendLog]);

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
                <Wand2 size={18} /> 智能解析 → 生成 3 套方案
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

          {/* 3 套方案（多选） */}
          {analysisResult && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">
                点击卡片多选（已选 {selectedIndices.size} / 3）· 标题可直接编辑 · 封面可锁定不重新生成
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
                      {/* 顶部：风格 + 状态标签 + 锁定按钮 */}
                      <div className="flex items-center justify-between mb-1">
                        <button
                          onClick={() => toggleSelectIndex(idx)}
                          className="flex items-center gap-2 flex-1 text-left"
                          type="button"
                        >
                          <span className="text-sm font-bold text-amber-300">
                            {opt.emoji} {opt.styleTag}
                          </span>
                          <div className="flex items-center gap-1">
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
                      </div>

                      {/* 标题可编辑 */}
                      <div className="flex items-start gap-1">
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

                      {/* 单张封面图（如果有） */}
                      {hasCover && (
                        <div className="mt-2 space-y-1.5">
                          <div
                            className={`relative border-2 rounded-lg overflow-hidden bg-slate-950 ${
                              isFinal ? 'border-emerald-400' : 'border-slate-600'
                            }`}
                          >
                            <img
                              src={generatedCovers.get(idx)!.url}
                              alt={`封面 ${idx + 1}`}
                              className="w-full block"
                            />
                            {isGenerating && (
                              <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-xs text-white">
                                <Loader2 size={16} className="animate-spin mr-1" />
                                生成中…
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-wrap">
                            {!isFinal && (
                              <button
                                onClick={() => handlePickFinalCover(idx)}
                                className="text-[10px] px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded flex items-center gap-1"
                                type="button"
                              >
                                <Check size={10} /> 选为终封面
                              </button>
                            )}
                            <button
                              onClick={() => handleRegenerateOneCover(idx)}
                              disabled={isGenerating}
                              className="text-[10px] px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-50"
                              type="button"
                              title="重新生成（强制覆盖，即使已锁定）"
                            >
                              ↻ 重新生成
                            </button>
                            <button
                              onClick={() => handleDownloadCover(generatedCovers.get(idx)!)}
                              className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1"
                              type="button"
                            >
                              <Download size={10} /> 下载
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 人物信息 */}
          {analysisResult?.characterInfo && (
            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-xs space-y-1">
              <div className="text-emerald-400 font-bold mb-1">👤 人物信息</div>
              <div className="text-slate-300">
                <span className="text-slate-500">姓名：</span>
                {analysisResult.characterInfo.name || '（未提取）'}
              </div>
              <div className="text-slate-300">
                <span className="text-slate-500">身份：</span>
                {analysisResult.characterInfo.title || '（未提取）'}
              </div>
              <div className="text-slate-300">
                <span className="text-slate-500">视觉：</span>
                {analysisResult.characterInfo.visualDescription || '（未提取）'}
              </div>
              <div className="text-slate-300">
                <span className="text-slate-500">情绪：</span>
                {analysisResult.characterInfo.dominantEmotion || '（未提取）'}
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
            />
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
}> = ({ config, onChange, appendLog }) => {
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

  return (
    <div className="bg-slate-900/50 border border-blue-700/40 rounded-lg p-3 space-y-3">
      <div className="text-[10px] text-blue-400 font-bold mb-1 flex items-center gap-1">
        <SettingsIcon size={12} /> Remotion 渲染设置（从多镜头分镜迁移）
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
            {(['1280x720', '1920x1080', '1080x1920', '1080x1080', '2560x1080'] as const).map((r) => (
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

      {/* 字幕样式 */}
      <div>
        <label className="text-[10px] text-slate-500 block mb-1">字幕样式</label>
        <select
          value={config.subtitle.style}
          onChange={(e) =>
            onChange({
              ...config,
              subtitle: { ...config.subtitle, style: e.target.value as any },
            })
          }
          className="w-full bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1"
        >
          {SUBTITLE_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* 字幕位置 */}
      <div className="flex items-center gap-2 text-[10px] text-slate-400">
        <span className="shrink-0">字幕位置：</span>
        {(['top', 'middle', 'bottom'] as const).map((p) => (
          <button
            key={p}
            onClick={() =>
              onChange({ ...config, subtitle: { ...config.subtitle, position: p } })
            }
            className={`px-2 py-0.5 rounded text-[10px] ${
              config.subtitle.position === p
                ? 'bg-emerald-600/30 border border-emerald-500/60 text-emerald-200'
                : 'bg-slate-800 border border-slate-700 text-slate-400'
            }`}
            type="button"
          >
            {p === 'top' ? '顶部' : p === 'middle' ? '中间' : '底部'}
          </button>
        ))}
      </div>

      {/* 运动 */}
      <div>
        <label className="text-[10px] text-slate-500 block mb-1">镜头运动</label>
        <select
          value={config.motion ?? 'kenBurns'}
          onChange={(e) => onChange({ ...config, motion: e.target.value as any })}
          className="w-full bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-200 px-2 py-1"
        >
          {[
            { v: 'kenBurns', l: 'Ken Burns（轻微推近）' },
            { v: 'kenBurnsStrong', l: 'Ken Burns 强（明显推近）' },
            { v: 'kenBurnsSlow', l: 'Ken Burns 慢（平滑）' },
            { v: 'zoomIn', l: '持续放大' },
            { v: 'zoomOut', l: '持续缩小' },
            { v: 'push', l: '推入（拉远）' },
            { v: 'pull', l: '拉出（推近）' },
            { v: 'panLeft', l: '左移' },
            { v: 'panRight', l: '右移' },
            { v: 'none', l: '静止' },
          ].map((opt) => (
            <option key={opt.v} value={opt.v}>
              {opt.l}
            </option>
          ))}
        </select>
      </div>

      {/* 转场 */}
      <div>
        <label className="text-[10px] text-slate-500 block mb-1">转场</label>
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
          <option value="none">无（单镜头无转场）</option>
          <option value="fade">淡入淡出</option>
          <option value="slide">滑动</option>
          <option value="zoom">缩放</option>
        </select>
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
    },
    transition: { type: 'none', duration: 0.4 },
    motion: 'kenBurns',
    safeZoneDetection: false,
    output: { target: 'download' },
  };
}

// ──────────────────────────────────────────────
// 字幕 cue 构建（按句号/问号/感叹号切分，均分到总时长）
// ──────────────────────────────────────────────
function buildSubtitleCuesFromText(text: string, totalSec: number, fps: number) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const hasChinese = /[\u4e00-\u9fff]/.test(trimmed);
  const splitter = hasChinese ? /(?<=[。！？；\n])/ : /(?<=[.!?;\n])/g;
  const sentences = trimmed.split(splitter).map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) return [];

  const totalChars = sentences.reduce((s, x) => s + x.length, 0);
  const totalFrames = Math.round(totalSec * fps);
  let accFrames = 0;
  return sentences.map((s) => {
    const ratio = s.length / totalChars;
    const frames = Math.max(1, Math.round(totalFrames * ratio));
    const cue = {
      text: s,
      startFrame: accFrames,
      endFrame: accFrames + frames,
    };
    accFrames += frames;
    return cue;
  });
}

export default CopyBasedPanel;
