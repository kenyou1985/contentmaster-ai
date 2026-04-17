// ========== 分镜文本切分工具函数 ==========
/** 检测文本是否为英文（超过50%字符为拉丁字母） */
const isEnglishText = (text: string): boolean => {
  const sample = text.slice(0, Math.min(500, text.length));
  const latinChars = (sample.match(/[A-Za-z]/g) || []).length;
  const totalChars = sample.replace(/\s/g, '').length;
  return totalChars > 0 && latinChars / totalChars > 0.5;
};

/**
 * 按句子边界切割文本，保证句子/单词完整性
 */
const splitIntoSentences = (text: string): string[] => {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const sentences: string[] = [];
  let remaining = cleaned;

  while (remaining.length > 0) {
    // 中文句子（优先）
    const chineseMatch = remaining.match(/^([^。！？]*[。！？])/);
    if (chineseMatch) {
      sentences.push(chineseMatch[0].trim());
      remaining = remaining.slice(chineseMatch[0].length).trim();
      continue;
    }

    // 英文句子
    const englishMatch = remaining.match(/^([^.!?]*[.!?]+[\s]?)/);
    if (englishMatch) {
      sentences.push(englishMatch[0].trim());
      remaining = remaining.slice(englishMatch[0].length).trim();
      continue;
    }

    // 没有匹配到句子，添加剩余文本
    if (remaining.length > 0) {
      sentences.push(remaining.trim());
      break;
    }
  }

  return sentences.filter(s => s.length > 0);
};

/**
 * 智能切分文本为分镜段落
 * - 中文：每段200-300字
 * - 英文：每段300-450字符
 * - 禁止句子/单词中间切割
 */
const segmentTextByShots = (text: string, targetShots: number): string[] => {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const isEnglish = isEnglishText(cleaned);

  // 根据语言设置目标字数范围
  const avgChars = isEnglish
    ? Math.max(350, Math.round(cleaned.length / targetShots))
    : Math.max(200, Math.round(cleaned.length / targetShots));
  const minLen = Math.round(avgChars * 0.8);
  const maxLen = Math.round(avgChars * 1.2);

  // 按句子分割
  const sentences = splitIntoSentences(cleaned);
  if (sentences.length === 0) return [cleaned];

  const segments: string[] = [];
  let buffer = '';

  const flushBuffer = () => {
    if (buffer.trim()) {
      segments.push(buffer.trim());
      buffer = '';
    }
  };

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    if (!buffer) {
      buffer = trimmedSentence;
      continue;
    }

    const tentative = `${buffer} ${trimmedSentence}`.trim();
    if (tentative.length > maxLen && buffer.length >= minLen) {
      flushBuffer();
      buffer = trimmedSentence;
    } else if (tentative.length <= maxLen) {
      buffer = tentative;
    } else if (buffer.length < minLen) {
      buffer = tentative;
    } else {
      flushBuffer();
      buffer = trimmedSentence;
    }
  }
  flushBuffer();

  // 合并段落直到达到目标
  if (segments.length > targetShots) {
    while (segments.length > targetShots) {
      let minPairIdx = 0;
      let minPairSum = Infinity;
      for (let i = 0; i < segments.length - 1; i++) {
        const sum = segments[i].length + segments[i + 1].length;
        if (sum < minPairSum) {
          minPairSum = sum;
          minPairIdx = i;
        }
      }
      const merged = `${segments[minPairIdx]} ${segments[minPairIdx + 1]}`.trim();
      segments.splice(minPairIdx, 2, merged);
    }
  } else if (segments.length < targetShots && segments.length > 0) {
    // 拆分最长的段落
    let splitHappened = true;
    while (segments.length < targetShots && splitHappened) {
      splitHappened = false;
      let maxIdx = 0;
      let maxSegLen = 0;
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].length > maxSegLen) {
          maxSegLen = segments[i].length;
          maxIdx = i;
        }
      }

      const seg = segments[maxIdx];
      if (seg.length <= avgChars * 0.6) break;

      const mid = Math.floor(seg.length / 2);
      let splitAt = -1;

      splitAt = seg.lastIndexOf('。', mid);
      if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('！', mid);
      if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('？', mid);
      if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('. ', mid);
      if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('! ', mid);
      if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('? ', mid);
      if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('.', mid);

      if (splitAt > seg.length * 0.25 && splitAt < seg.length * 0.85) {
        const first = seg.slice(0, splitAt + 1).trim();
        const second = seg.slice(splitAt + 1).trim();
        if (first.length >= minLen * 0.5 && second.length >= minLen * 0.5) {
          segments.splice(maxIdx, 1, first, second);
          splitHappened = true;
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }

  return segments.slice(0, targetShots);
};
// ========== 分镜文本切分工具函数结束 ==========

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  ApiProvider,
  NicheType,
  NicheConfig,
  Topic,
  GeneratedContent,
  GenerationStatus,
  TcmSubModeId,
  FinanceSubModeId,
  RevengeSubModeId,
  NewsSubModeId,
  StoryLanguage,
  StoryDuration,
} from '../types';
import { NICHES, TCM_SUB_MODES, FINANCE_SUB_MODES, REVENGE_SUB_MODES, NEWS_SUB_MODES, INTERACTIVE_ENDING_TEMPLATE, PSYCHOLOGY_LONG_SCRIPT_PROMPT, PSYCHOLOGY_SHORT_SCRIPT_PROMPT, PHILOSOPHY_LONG_SCRIPT_PROMPT, PHILOSOPHY_SHORT_SCRIPT_PROMPT, EMOTION_TABOO_LONG_SCRIPT_PROMPT, EMOTION_TABOO_SHORT_SCRIPT_PROMPT, YI_JING_SHORT_SCRIPT_PROMPT, MINDFUL_PSYCHOLOGY_SCRIPT_PROMPT, applyTopicCountToPrompt } from '../constants';
import { NicheSelector } from './NicheSelector';
import { generateTopics, streamContentGeneration, initializeGemini } from '../services/geminiService';
import { fetchMacroNewsDigestForPrompt } from '../services/macroNewsFeedService';
import { fetchPsychologyDigestForPrompt } from '../services/psychologyFeedService';
import { needsParagraphNormalization, normalizeDenseChineseParagraphs } from '../services/textFormat';
import { detectAiFeatures, type AiDetectionResult } from '../services/aiDetectionService';
import { polishTextForAntiAi } from '../services/antiAiPolishService';



import { Sparkles, Calendar, Loader2, Download, Eye, Zap, AlertTriangle, Copy, Check, Globe, Clock, PlusCircle, History, ListOrdered, Film, ChevronDown, ChevronRight, Rocket, Trash2 } from 'lucide-react';
import {
  buildParallelOutlineUserPrompt,
  buildParallelOutlineSystem,
  buildParallelSegmentUserPrompt,
  buildParallelMergeUserPrompt,
  buildParallelMergeSystem,
  parseYiJingOutline,
  rescaleChapterWordCounts,
  outlinePayloadToJsonPretty,
  computeParallelSegmentCount,
  YI_JING_CHARS_PER_SEGMENT_SOFT_CAP,
  YI_JING_BAND1_MAX,
  YI_JING_BAND2_MAX,
  PARALLEL_LOGIC_GENERIC,
  PARALLEL_LOGIC_YI_JING,
  type YiJingOutlinePayload,
  type YiJingChapterPlan,
} from '../services/yiJingParallelLongForm';
import JSZip from 'jszip';
import {
  saveHistory,
  getHistory,
  getHistoryKey,
  deleteHistory,
  clearHistory,
  HistoryRecord,
  generateDatedRandomHistoryLabel,
} from '../services/historyService';
import { HistorySelector } from './HistorySelector';
import { useToast } from './Toast';
import { ProgressBar } from './ProgressBar';
import {
  getMediaImageStylePromptEn,
  MEDIA_IMAGE_STYLE_STORAGE_KEY,
  MEDIA_IMAGE_STYLE_SELECT_OPTIONS,
} from '../services/coverStylePresets';
import {
  MINDFUL_EN_SCRIPT_CHARS_MAX,
  MINDFUL_EN_SCRIPT_CHARS_MIN,
  clampMindfulParallelTargetChars,
  truncateMindfulScript,
  mindfulMergeCharClamp,
} from '../services/mindfulScriptPostProcess';

function clampSystemSummary(raw: string, maxLen = 960): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/** 治愈心理学选题：去掉 * / **，竖线改「：」，英文与中文之间的半角冒号改全角「：」，保留【分类标签】 */
function sanitizeMindfulPsychologyTopicLine(raw: string): string {
  // 提取分类标签
  const labelMatch = raw.match(/^\s*【([^】]+)】/);
  const label = labelMatch ? labelMatch[0] : '';
  let t = raw.replace(/^\s*【[^】]*】\s*/, '').trim();
  t = t.replace(/\*+/g, '');
  t = t.replace(/\s*\|\s*/, '：');
  t = t.replace(/([a-zA-Z0-9\)?.!'"…])\s*:\s*([\u4e00-\u9fff])/g, '$1：$2');
  t = t.replace(/\s{2,}/g, ' ').trim();
  // 还原标签
  return label + (label ? ' ' : '') + t;
}

// 治愈心理学语言类型定义（需要在使用前定义）
type MindfulLanguage = 'en' | 'zh' | 'ko' | 'ja' | 'es' | 'de' | 'hi' | 'ru' | 'pt' | 'fr' | 'id' | 'th';

/** 各赛道分段并行：大纲 / 分段 / 合并 的提示与人设 */
function getParallelPipelineBundle(
  niche: NicheType,
  scriptLengthMode: 'LONG' | 'SHORT',
  storyLanguage: StoryLanguage,
  storyDuration: StoryDuration,
  nicheConfig: NicheConfig,
  mindfulLang?: MindfulLanguage
) {
  const baseName = nicheConfig.name;
  const isEnRevenge =
    niche === NicheType.STORY_REVENGE && storyLanguage === StoryLanguage.ENGLISH;
  const isMindfulEnglish = niche === NicheType.MINDFUL_PSYCHOLOGY;
  const effectiveLang = mindfulLang || 'en';
  const outputLanguage: 'zh' | 'en' = isMindfulEnglish ? (effectiveLang === 'en' ? 'en' : 'zh') : (isEnRevenge ? 'en' : 'zh');

  let logicBlueprint = PARALLEL_LOGIC_GENERIC;
  let channelLabel = `「${baseName}」频道长内容`;
  let contentKindOutline =
    scriptLengthMode === 'SHORT' ? '短视频口播/解说大纲' : '长视频口播/解说大纲';
  let contentKindMerge = '口播';
  let directorLine = `你是「${baseName}」频道的长内容总编导，须严格符合该频道人设与输出规范。`;
  let mergeEditorLine =
    outputLanguage === 'en'
      ? 'You are a senior editor merging long-form scripts for audio/video.'
      : `你是资深长文编辑，熟悉「${baseName}」的叙事与语气。`;

  if (niche === NicheType.YI_JING_METAPHYSICS) {
    logicBlueprint = PARALLEL_LOGIC_YI_JING;
    channelLabel = '曾仕强风格长视频口播';
    contentKindOutline = '口播大纲';
    contentKindMerge = '口播';
    directorLine = '你是曾仕强教授风格的易经命理长视频总编导。';
    mergeEditorLine = '你是资深口播编辑，熟悉曾仕强讲学风格。';
  }

  if (niche === NicheType.STORY_REVENGE) {
    channelLabel = `「复仇故事」${storyLanguage} 叙事`;
    contentKindOutline =
      storyDuration === StoryDuration.LONG ? '长篇叙事分章大纲' : '短篇叙事分章大纲';
    contentKindMerge = '叙事脚本';
    directorLine = `你是专业叙事总编导；须规划 **${storyLanguage}** 语种的分章结构，符合该赛道复仇/打脸叙事节奏。`;
    if (outputLanguage === 'en') {
      mergeEditorLine = 'You are a senior story editor merging serialized narrative acts.';
    }
  }

  const mindfulEnglishLongParallel =
    niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG';

  if (niche === NicheType.MINDFUL_PSYCHOLOGY) {
    // 根据选择的语言确定输出语言
    const langMap: Record<MindfulLanguage, 'en' | 'zh'> = {
      'en': 'en', 'zh': 'zh', 'ko': 'en', 'ja': 'en', 'es': 'en',
      'de': 'en', 'hi': 'en', 'ru': 'en', 'pt': 'en', 'fr': 'en',
      'id': 'en', 'th': 'en'
    };
    const outputLang = langMap[effectiveLang] || 'en';
    const isZhOutput = effectiveLang === 'zh';

    channelLabel = isZhOutput
      ? 'Mindful Paws–style 中文治愈心理学口播'
      : 'Mindful Paws–style English healing psychology voice-over';
    contentKindOutline = isZhOutput
      ? (scriptLengthMode === 'SHORT' ? '短视频口播大纲（中文）' : '长视频口播大纲（中文）')
      : (scriptLengthMode === 'SHORT' ? 'short-form voice-over outline (English)' : 'long-form voice-over outline (English)');
    contentKindMerge = isZhOutput ? '口播脚本（中文）' : 'voice-over script';
    directorLine = isZhOutput
      ? '你是治愈心理学频道的制作人，负责生成中文 TTS 口播脚本。'
      : 'You are the lead producer for a faceless YouTube healing-psychology channel (cat/dog/human emotional metaphors). Plan and write for **English** TTS.';
    mergeEditorLine = isZhOutput
      ? '你是资深编辑，合并中文口播脚本，保持温暖、口语化、心理咨询师风格的表达。结尾固定为：请点赞并订阅我的频道。'
      : 'You are a senior editor merging English voice-over scripts; keep warm, spoken, therapist-like English. End with a simple subscribe line: say "my channel", never the brand name.';
  }

  const voiceRules = `1. 严格遵循下列「频道创作铁律摘要」与人设。\n2. 禁止【】、[] 舞台提示、禁止「模块一/第一节」等露骨章节标、禁止 Markdown 标题层级、避免纯列表骨架。\n【频道创作铁律摘要】\n${clampSystemSummary(nicheConfig.systemInstruction)}`;

  const mergeTone =
    outputLanguage === 'en'
      ? 'Unify narrative voice, tense, and pacing; keep the same language as the segment drafts.'
      : `全文语气、视角与「${baseName}」人设保持一致，衔接自然。`;

  return {
    outline: {
      channelLabel,
      contentKind: contentKindOutline,
      logicBlueprint,
      englishCharOutline: mindfulEnglishLongParallel,
    },
    outlineSystem: buildParallelOutlineSystem(directorLine),
    segment: {
      outputLanguage,
      voiceRules,
      englishChapterCharStrict: mindfulEnglishLongParallel,
      mindfulLanguage: effectiveLang,
    },
    merge: {
      channelTag: baseName,
      toneInstruction: mergeTone,
      outputLanguage,



      contentKind: contentKindMerge,
      mindfulLanguage: effectiveLang,
    },
    mergeSystem: buildParallelMergeSystem(mergeEditorLine),
  };
}

interface GeneratorProps {
  apiKey: string;
  provider: ApiProvider;
  toast?: ReturnType<typeof useToast>;
}

export const Generator: React.FC<GeneratorProps> = ({ apiKey, provider, toast: externalToast }) => {
  // 优先使用外部传入的 toast，如果没有则使用内部的
  const internalToast = useToast();
  const toast = externalToast || internalToast;
  
  // 调试日志降噪：避免每次渲染都打印导致控制台刷屏
  React.useEffect(() => {
    console.log('[Generator] Toast 实例检查:', {
      hasExternalToast: !!externalToast,
      hasInternalToast: !!internalToast,
      toastMethods: toast ? Object.keys(toast) : 'null',
      toastToasts: toast?.toasts?.length || 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 中医玄学长文：达到此字数后才允许节目收尾语；与续写停止条件一致 */
  const MIN_TCM_SCRIPT_CHARS = 7500;
  const MAX_TCM_SCRIPT_CHARS = 12000;
  const MIN_YI_JING_SCRIPT_CHARS = 8000;
  const MAX_YI_JING_SCRIPT_CHARS = 12000;
  const MAX_YI_JING_SCRIPT_CONTINUATIONS = 20;
  /** 清洗后字数未满此时，禁止出现最后一节（第9节/第5节等）标题与收束 */
  const TCM_MIN_CHARS_BEFORE_FINAL_LESSON = 7000;
  /** 清洗后字数未满此时，剥离提前出现的收尾语 */
  const TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES = 7500;
  const MIN_FIN_SCRIPT_CHARS = 7000; // 28 min * 250 chars/min
  const MAX_FIN_SCRIPT_CHARS = 8200; // ~33 min * 250 chars/min, hard ceiling
  const MIN_NEWS_SCRIPT_CHARS = 7000; // 软目标下限
  const MAX_NEWS_SCRIPT_CHARS = 9000; // 硬上限
  const MAX_SCRIPT_CONTINUATIONS = 3;
  const MAX_TCM_SCRIPT_CONTINUATIONS = 20;
  const REVENGE_SHORT_MIN = 13500; // 15 min * 900 chars/min
  const REVENGE_SHORT_MAX = 27000; // 30 min * 900 chars/min
  const REVENGE_LONG_CN_MIN = 18000; // 60 min * 300 chars/min
  const REVENGE_LONG_CN_MAX = 21000; // 70 min * 300 chars/min
  const REVENGE_LONG_EN_MIN = 54000; // 60 min * 900 chars/min
  const REVENGE_LONG_EN_MAX = 63000; // ~70 min buffer
  const MAX_REVENGE_CONTINUATIONS = 4;
  const [niche, setNiche] = useState<NicheType>(NicheType.TCM_METAPHYSICS);
  
  // Sub-mode states
  const [tcmSubMode, setTcmSubMode] = useState<TcmSubModeId>(TcmSubModeId.TIME_TABOO);
  const [financeSubMode, setFinanceSubMode] = useState<FinanceSubModeId>(FinanceSubModeId.MACRO_WARNING);
  const [revengeSubMode, setRevengeSubMode] = useState<RevengeSubModeId>(RevengeSubModeId.CULTURAL_ORIGINAL);
  const [newsSubMode, setNewsSubMode] = useState<NewsSubModeId>(NewsSubModeId.GEO_POLITICS);
  
  // Script length mode for TCM/Finance/Psychology
  const [scriptLengthMode, setScriptLengthMode] = useState<'LONG' | 'SHORT'>('LONG');

  /** 策划选题条数：默认 5；预设 5/10/15/20 或自定义 1–50 */
  const [planTopicCountPreset, setPlanTopicCountPreset] = useState<5 | 10 | 15 | 20>(5);
  const [planTopicCountIsCustom, setPlanTopicCountIsCustom] = useState(false);
  const [planTopicCountCustomValue, setPlanTopicCountCustomValue] = useState('8');

  // Revenge Story Settings
  const [storyLanguage, setStoryLanguage] = useState<StoryLanguage>(StoryLanguage.ENGLISH);
  const [storyDuration, setStoryDuration] = useState<StoryDuration>(StoryDuration.SHORT);

  const [inputVal, setInputVal] = useState('');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [status, setStatus] = useState<GenerationStatus>(GenerationStatus.IDLE);
  // Adaptation mode: store adapted content
  const [adaptedContent, setAdaptedContent] = useState('');
  const [isAdapting, setIsAdapting] = useState(false);
  
  // Stores the content of all articles
  const [generatedContents, setGeneratedContents] = useState<GeneratedContent[]>([]);
  
  // Set of indices that are currently being generated (for loading spinners)
  const [activeIndices, setActiveIndices] = useState<Set<number>>(new Set());
  
  // Which article is currently displayed in the main editor
  const [viewIndex, setViewIndex] = useState<number>(0);
  
  // errorMsg 已移除，改用 Toast 通知
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 金融·宏观预警：最近一次「一键生成选题」拉取的国际 RSS 摘要，供长文引子对齐 */
  const financeMacroNewsDigestRef = useRef<string>('');
  const newsMacroNewsDigestRef = useRef<string>('');
  
  // 历史记录相关状态
  const [showHistorySelector, setShowHistorySelector] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [pendingSubModeChange, setPendingSubModeChange] = useState<{ niche: NicheType; submode: string } | null>(null);
  /** 治愈心理学·一键动画分镜：独立历史弹窗（与脚本历史 key 分离为 mindful_mode2） */
  const [showStoryboardHistorySelector, setShowStoryboardHistorySelector] = useState(false);
  const [storyboardHistoryRecords, setStoryboardHistoryRecords] = useState<HistoryRecord[]>([]);

  // Mindful Psychology 频道相关状态
  const [mindfulMode, setMindfulMode] = useState<'mode1' | 'mode2'>('mode1');
  const [mindfulScript, setMindfulScript] = useState('');
  const [storyboard, setStoryboard] = useState('');
  const [isGeneratingStoryboard, setIsGeneratingStoryboard] = useState(false);
  /** 分镜生成进度百分比（0-100） */
  const [storyboardProgress, setStoryboardProgress] = useState(0);
  /** 治愈心理学：一键动画分镜默认折叠，点击标题展开 */
  const [mindfulStoryboardExpanded, setMindfulStoryboardExpanded] = useState(false);
  const mindfulStoryboardAnchorRef = useRef<HTMLDivElement>(null);
  /** 一键动画分镜画面风格：与媒体生成「风格设置」同一套选项与 localStorage */
  const [mindfulStoryboardStyleId, setMindfulStoryboardStyleId] = useState(() => {
    try {
      const s = localStorage.getItem(MEDIA_IMAGE_STYLE_STORAGE_KEY);
      if (s && MEDIA_IMAGE_STYLE_SELECT_OPTIONS.some((o) => o.id === s)) return s;
    } catch {
      /* ignore */
    }
    return 'none';
  });
  useEffect(() => {
    try {
      localStorage.setItem(MEDIA_IMAGE_STYLE_STORAGE_KEY, mindfulStoryboardStyleId);
    } catch {
      /* ignore */
    }
  }, [mindfulStoryboardStyleId]);

  // 治愈心理学多语言输出选项
  const mindfulLanguages: { id: MindfulLanguage; name: string; native: string }[] = [
    { id: 'en', name: 'English', native: '英文' },
    { id: 'zh', name: '中文', native: '中文' },
    { id: 'ko', name: '한국어', native: '韩文' },
    { id: 'ja', name: '日本語', native: '日文' },
    { id: 'es', name: 'Español', native: '西班牙文' },
    { id: 'de', name: 'Deutsch', native: '德文' },
    { id: 'hi', name: 'हिन्दी', native: '印地文' },
    { id: 'ru', name: 'Русский', native: '俄文' },
    { id: 'pt', name: 'Português', native: '葡萄牙文' },
    { id: 'fr', name: 'Français', native: '法文' },
    { id: 'id', name: 'Bahasa Indonesia', native: '印尼文' },
    { id: 'th', name: 'ภาษาไทย', native: '泰文' },
  ];

  // 多语言 CTA 结尾语映射
  const MINDFUL_LANGUAGE_CTAS: Record<MindfulLanguage, { cta: string; ctaRegex: RegExp }> = {
    'zh': { cta: '请点赞并订阅我的频道。', ctaRegex: /请点赞并订阅我的频道/ },
    'en': { cta: 'Please like and subscribe to my channel.', ctaRegex: /please like and subscribe to my channel/i },
    'ko': { cta: '좋아요와 구독 부탁드립니다.', ctaRegex: /좋아요와 구독/i },
    'ja': { cta: 'いいねと登録をお願いします。', ctaRegex: /いいね.*登録/i },
    'es': { cta: 'Por favor, dale like y suscríbete a mi canal.', ctaRegex: /like.*suscr/i },
    'de': { cta: 'Bitte liken und meinen Kanal abonnieren.', ctaRegex: /liken.*abonnieren/i },
    'hi': { cta: 'कृपया लाइक करें और मेरी चैनल को सब्सक्राइब करें।', ctaRegex: /लाइक.*सब्सक्राइब/i },
    'ru': { cta: 'Пожалуйста, поставьте лайк и подпишитесь на мой канал.', ctaRegex: /лайк.*подписк/i },
    'pt': { cta: 'Por favor, clique em gostei e se inscreva no meu canal.', ctaRegex: /gostei.*inscrev/i },
    'fr': { cta: 'Veuillez aimer et vous abonner à ma chaîne.', ctaRegex: /aimer.*abonn/i },
    'id': { cta: 'Silakan like dan subscribe channel saya.', ctaRegex: /like.*subscribe/i },
    'th': { cta: 'กรุณากดไลค์และติดตามช่องของฉันด้วยครับ', ctaRegex: /ไลค์.*ติดตาม/i },
  };

  const [mindfulLanguage, setMindfulLanguage] = useState<MindfulLanguage>('en');

  /** 易经命理·长视频：大纲 + 分段并行 + 合并润色 */
  /** 全文目标字数（分段并行的总目标，默认 3500，与各章 min/max 联动） */
  const [yiJingTotalTargetChars, setYiJingTotalTargetChars] = useState(3500);
  /** 治愈心理学长视频：并行目标为英文总字符数，限制在 10000–15000 */
  useEffect(() => {
    if (niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG') {
      setYiJingTotalTargetChars((prev) => clampMindfulParallelTargetChars(prev));
    }
  }, [niche, scriptLengthMode]);
  const parallelTotalTargetChars = useMemo(
    () =>
      niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG'
        ? clampMindfulParallelTargetChars(yiJingTotalTargetChars)
        : yiJingTotalTargetChars,
    [niche, scriptLengthMode, yiJingTotalTargetChars]
  );
  /** 按目标总字数与单次输出上限自动推算章数（非固定 3–7） */
  const yiJingComputedSegCount = useMemo(
    () =>
      computeParallelSegmentCount(
        parallelTotalTargetChars,
        scriptLengthMode === 'SHORT' ? 'SHORT' : 'LONG'
      ),
    [parallelTotalTargetChars, scriptLengthMode]
  );
  const [yiJingOutlineText, setYiJingOutlineText] = useState('');
  const [yiJingOutlineParsed, setYiJingOutlineParsed] = useState<YiJingOutlinePayload | null>(null);
  /** 可读浏览 / 表单编辑（不再默认编辑 JSON） */
  const [yiJingOutlineViewMode, setYiJingOutlineViewMode] = useState<'readable' | 'edit'>('readable');
  /** 表单编辑时的草稿（与 yiJingOutlineParsed 分离，取消可丢弃） */
  const [yiJingOutlineEditDraft, setYiJingOutlineEditDraft] = useState<YiJingOutlinePayload | null>(null);
  const [yiJingSegDrafts, setYiJingSegDrafts] = useState<string[]>([]);
  const [yiJingSegStatus, setYiJingSegStatus] = useState<('idle' | 'running' | 'done' | 'error')[]>([]);
  const [yiJingPipelineLogs, setYiJingPipelineLogs] = useState<string[]>([]);
  const [yiJingMergedOutput, setYiJingMergedOutput] = useState('');
  const [yiJingPipelineBusy, setYiJingPipelineBusy] = useState(false);
  /** AI 味检测结果 */
  const [yiJingAiDetection, setYiJingAiDetection] = useState<AiDetectionResult | null>(null);
  const [yiJingIsRunningAiDetection, setYiJingIsRunningAiDetection] = useState(false);
  const [yiJingIsPolishing, setYiJingIsPolishing] = useState(false);

  type ParallelTopicStage = 'idle' | 'outline' | 'segments' | 'merge' | 'done' | 'error';
  type ParallelTopicRun = {
    id: string;
    title: string;
    status: 'pending' | 'running' | 'done' | 'error';
    stage: ParallelTopicStage;
    progress: number;
    logs: string[];
  };
  const [parallelTopicRuns, setParallelTopicRuns] = useState<ParallelTopicRun[]>([]);
  const [activeParallelTopicId, setActiveParallelTopicId] = useState<string | null>(null);
  const [parallelTopicOutlineMap, setParallelTopicOutlineMap] = useState<Record<string, string>>({});
  const [parallelTopicSegDraftsMap, setParallelTopicSegDraftsMap] = useState<Record<string, string[]>>({});
  const [parallelTopicSegStatusMap, setParallelTopicSegStatusMap] = useState<Record<string, ('idle' | 'running' | 'done' | 'error')[]>>({});

  // UTC 时间锚定（仅在需要时间锚的赛道/子模式注入）
  const getUtcAnchor = (): string => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hour = String(now.getUTCHours()).padStart(2, '0');
    const minute = String(now.getUTCMinutes()).padStart(2, '0');
    return `时间锚（内部推演，不可原样输出）：${year}年${month}月${day}日 ${hour}:${minute}。若用户未给年份，默认按${year}年推演；若用户已给年份，以用户年份为准。正文禁止出现“UTC/系统时间/时间锚”等字样。`;
  };

  const getUtcYearGuardrail = (): string => {
    const y = getCurrentUtcYear();
    return `【全赛道时空锚定铁律（最高优先级）】\n- 现在的基准年份按 UTC 当日：${y}年。\n- 若用户未明确指定年份，正文中凡出现“今年/本年/年初/年中/年末/跨年/明年/去年”等时间指代，必须与${y}年一致推导（如“今年年底”即${y}年年底，“明年”即${y + 1}年）。\n- 禁止把“当前”写成过去年份（如 ${y - 1} / ${y - 2} 等）或滞后时间线。\n- 仅当用户明确给出年份时，才可使用用户年份；否则一律按${y}年锚定。`;
  };

  const shouldInjectUtcAnchor = (): boolean => {
    // 全部赛道都注入内部时间锚，但禁止正文输出技术字样
    return true;
  };

  const getCurrentUtcYear = (): number => new Date().getUTCFullYear();

  const getChineseZodiac = (year: number): string => {
    const animals = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
    const idx = (year - 4) % 12;
    return animals[(idx + 12) % 12];
  };

  /** 分段并行·生成大纲时前置：时间锚 / 宏观 RSS / 新闻摘要等 */
  const getParallelOutlineLeadContext = useCallback((): string => {
    const parts: string[] = [];
    if (shouldInjectUtcAnchor()) {
      parts.push(getUtcAnchor());
      parts.push(getUtcYearGuardrail());
    }
    if (
      niche === NicheType.FINANCE_CRYPTO &&
      financeSubMode === FinanceSubModeId.MACRO_WARNING &&
      scriptLengthMode === 'LONG'
    ) {
      const m = financeMacroNewsDigestRef.current?.trim();
      if (m) parts.push(m);
    }
    if (niche === NicheType.GENERAL_VIRAL) {
      const n = newsMacroNewsDigestRef.current?.trim();
      if (n) parts.push(n);
    }
    return parts.join('\n\n');
  }, [niche, financeSubMode, scriptLengthMode]);

  // Auto-scroll logic
  useEffect(() => {
    if (activeIndices.has(viewIndex) && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [generatedContents, viewIndex, activeIndices]);

  // 生成历史记录 key 的统一函数
  const getHistoryKeyForSubMode = (nicheType: NicheType, submodeId: string): string => {
    return `${nicheType}_${submodeId}`;
  };

  /** 治愈心理学动画分镜历史（与 save 分镜时使用的 submode 一致） */
  const getMindfulStoryboardHistoryKey = () =>
    getHistoryKeyForSubMode(NicheType.MINDFUL_PSYCHOLOGY, 'mindful_mode2');

  const openMindfulStoryboardHistory = () => {
    const historyKey = getMindfulStoryboardHistoryKey();
    const records = getHistory('generator', historyKey);
    if (records.length === 0) {
      toast.info('暂无分镜历史，请先生成过一次「一键动画分镜」');
      return;
    }
    setStoryboardHistoryRecords(records);
    setShowStoryboardHistorySelector(true);
  };

  const handleStoryboardHistorySelect = (record: HistoryRecord) => {
    const text = record.content?.trim();
    if (!text) {
      toast.warning('该条记录没有分镜内容');
      return;
    }
    setStoryboard(text);
    const src = record.metadata?.input?.trim();
    if (src) setMindfulScript(src);
    setMindfulStoryboardExpanded(true);
    toast.success('已载入分镜历史');
    setShowStoryboardHistorySelector(false);
  };

  /**
   * 无「子选题」网格的赛道：用固定虚拟 subModeId 读写历史，须与 saveHistory 使用同一 id。
   * （易经 / 心理学 / 哲学 / 情感禁忌 / 富人思维 / 治愈心理学）
   */
  const getStaticGeneratorSubModeId = (nicheType: NicheType): string | null => {
    switch (nicheType) {
      case NicheType.YI_JING_METAPHYSICS:
        return 'yi_jing';
      case NicheType.PSYCHOLOGY:
        return 'psychology';
      case NicheType.PHILOSOPHY_WISDOM:
        return 'philosophy';
      case NicheType.EMOTION_TABOO:
        return 'emotion_taboo';
      case NicheType.RICH_MINDSET:
        return 'rich_mindset';
      case NicheType.MINDFUL_PSYCHOLOGY:
        return 'mindful_mode1';
      default:
        return null;
    }
  };

  /** 分段并行保存历史：与当前子模式 id 对齐 */
  const getParallelHistorySubModeId = useCallback((): string => {
    const st = getStaticGeneratorSubModeId(niche);
    if (st) return st;
    if (niche === NicheType.TCM_METAPHYSICS) return tcmSubMode;
    if (niche === NicheType.FINANCE_CRYPTO) return financeSubMode;
    if (niche === NicheType.STORY_REVENGE) return revengeSubMode;
    if (niche === NicheType.GENERAL_VIRAL) return newsSubMode;
    return 'default';
  }, [niche, tcmSubMode, financeSubMode, revengeSubMode, newsSubMode]);

  // 处理子模式切换（不带自动弹窗）
  const handleSubModeChange = (nicheType: NicheType, submodeId: string, setFunc: (id: any) => void) => {
    console.log('[Generator] 切换子模式:', { nicheType, submodeId });
    // 直接切换，不自动弹窗
    setFunc(submodeId);
    setInputVal('');
    setTopics([]);
    setAdaptedContent('');
    setIsAdapting(false);
  };

  // 手动触发历史记录选择弹窗
  const handleManualHistoryClick = (e: React.MouseEvent, nicheType: NicheType, submodeId: string) => {
    e.stopPropagation(); // 阻止冒泡到父按钮
    const historyKey = getHistoryKeyForSubMode(nicheType, submodeId);
    const records = getHistory('generator', historyKey);
    
    console.log('[Generator] 手动点击历史记录:', {
      nicheType,
      submodeId,
      historyKey,
      recordsCount: records.length
    });
    
    if (records.length > 0) {
      setHistoryRecords(records);
      setPendingSubModeChange({ niche: nicheType, submode: submodeId });
      setShowHistorySelector(true);
    }
  };
  
  // 处理历史记录选择
  const handleHistorySelect = (record: HistoryRecord) => {
    if (pendingSubModeChange) {
      const expectedKey = getHistoryKeyForSubMode(pendingSubModeChange.niche, pendingSubModeChange.submode);
      
      console.log('[Generator] 加载历史记录:', {
        pendingSubMode: pendingSubModeChange,
        expectedKey,
        recordTopic: record.metadata?.topic,
        recordContentLength: record.content?.length,
        recordTimestamp: new Date(record.timestamp).toLocaleString()
      });
      
      // 切换子模式
      if (pendingSubModeChange.niche === NicheType.TCM_METAPHYSICS) {
        setTcmSubMode(pendingSubModeChange.submode as TcmSubModeId);
      } else if (pendingSubModeChange.niche === NicheType.FINANCE_CRYPTO) {
        setFinanceSubMode(pendingSubModeChange.submode as FinanceSubModeId);
      } else if (pendingSubModeChange.niche === NicheType.STORY_REVENGE) {
        setRevengeSubMode(pendingSubModeChange.submode as RevengeSubModeId);
      } else if (pendingSubModeChange.niche === NicheType.GENERAL_VIRAL) {
        setNewsSubMode(pendingSubModeChange.submode as NewsSubModeId);
      }
      
      // 加载历史记录内容
      // 由于现在每篇文章单独保存，直接加载单篇文章
      if (record.content && record.content.trim()) {
        const topic = record.metadata?.topic || '历史记录';
        const contentPreview = record.content.substring(0, 100);
        
        console.log('[Generator] 加载历史记录内容:', {
          expectedKey,
          recordTopic: topic,
          contentPreview: contentPreview,
          contentLength: record.content.length,
          recordTimestamp: new Date(record.timestamp).toLocaleString()
        });
        
        // 清空当前内容，避免混乱
        setTopics([]);
        setGeneratedContents([{
          topic,
          content: record.content,
        }]);
        setViewIndex(0);
        setStatus(GenerationStatus.COMPLETED);
      } else {
        console.warn('[Generator] 历史记录内容为空，无法加载');
      }
      
      if (record.metadata?.input) {
        setInputVal(record.metadata.input);
      } else {
        setInputVal(''); // 如果没有输入，清空输入框
      }
      
      setPendingSubModeChange(null);
      setShowHistorySelector(false);
    }
  };

  // Reset input when niche or submode changes
  useEffect(() => {
    if (!showHistorySelector) {
    setInputVal('');
    setTopics([]);
      setAdaptedContent('');
      setIsAdapting(false);
    }
  }, [niche, tcmSubMode, financeSubMode, revengeSubMode, newsSubMode, showHistorySelector]);

  // SAFE ACCESS HELPER
  const getCurrentSubModeConfig = () => {
    if (niche === NicheType.TCM_METAPHYSICS) return TCM_SUB_MODES[tcmSubMode];
    if (niche === NicheType.FINANCE_CRYPTO) return FINANCE_SUB_MODES[financeSubMode];
    if (niche === NicheType.STORY_REVENGE) return REVENGE_SUB_MODES[revengeSubMode];
    if (niche === NicheType.GENERAL_VIRAL) return NEWS_SUB_MODES[newsSubMode];
    if (niche === NicheType.YI_JING_METAPHYSICS) return null;
    if (niche === NicheType.PSYCHOLOGY) return null;
    if (niche === NicheType.PHILOSOPHY_WISDOM) return null;
    if (niche === NicheType.EMOTION_TABOO) return null;
    if (niche === NicheType.RICH_MINDSET) return null;
    if (niche === NicheType.MINDFUL_PSYCHOLOGY) return null;
    return null;
  };

  const getSubModesForRender = () => {
     if (niche === NicheType.TCM_METAPHYSICS) return TCM_SUB_MODES;
     if (niche === NicheType.FINANCE_CRYPTO) return FINANCE_SUB_MODES;
     if (niche === NicheType.STORY_REVENGE) return REVENGE_SUB_MODES;
     if (niche === NicheType.GENERAL_VIRAL) return NEWS_SUB_MODES;
     if (niche === NicheType.YI_JING_METAPHYSICS) return null;
     if (niche === NicheType.PSYCHOLOGY) return null;
     if (niche === NicheType.PHILOSOPHY_WISDOM) return null;
     if (niche === NicheType.EMOTION_TABOO) return null;
     if (niche === NicheType.RICH_MINDSET) return null;
     if (niche === NicheType.MINDFUL_PSYCHOLOGY) return null;
     return null;
  };

  const isInputRequired = () => {
    const config = getCurrentSubModeConfig();
    if (config) return config.requiresInput;
    if (niche === NicheType.YI_JING_METAPHYSICS) return false;
    if (niche === NicheType.PSYCHOLOGY) return false;
    if (niche === NicheType.PHILOSOPHY_WISDOM) return false;
    if (niche === NicheType.EMOTION_TABOO) return false;
    if (niche === NicheType.RICH_MINDSET) return false;
    if (niche === NicheType.MINDFUL_PSYCHOLOGY) return false;
    return true; // Default input required for other niches
  };

  const shouldShowInput = () => {
    const config = getCurrentSubModeConfig();
    if (config) return config.requiresInput || config.optionalInput;
    if (niche === NicheType.YI_JING_METAPHYSICS) return true;
    if (niche === NicheType.PSYCHOLOGY) return false;
    if (niche === NicheType.PHILOSOPHY_WISDOM) return false;
    if (niche === NicheType.EMOTION_TABOO) return false;
    if (niche === NicheType.RICH_MINDSET) return true;
    if (niche === NicheType.MINDFUL_PSYCHOLOGY) return true;
    return true;
  };

  const getInputPlaceholder = () => {
      const config = getCurrentSubModeConfig();
      if (config) return config.inputPlaceholder || "输入关键词";
      if (niche === NicheType.YI_JING_METAPHYSICS) {
        return '（可选）侧重方向、关键词或素材提示，留空则按易经命理爆款逻辑生成';
      }
      if (niche === NicheType.RICH_MINDSET) {
        return '（可选）输入选题方向关键词，如：子女啃老、亲戚算计、养老困境';
      }
      if (niche === NicheType.MINDFUL_PSYCHOLOGY) {
        return '（可选）输入选题方向关键词，如：性格心理学、情绪疗愈、潜意识';
      }
      return "输入关键词/趋势";
  };

  const parseErrorMessage = (err: any): string => {
      // Try to parse if it's a JSON string error from the logs
      let msg = err.message || '';
      
      // If error message looks like JSON (e.g. from the provided error logs), try to extract nested message
      if (typeof msg === 'string' && msg.trim().startsWith('{')) {
          try {
              const parsed = JSON.parse(msg);
              if (parsed.error && parsed.error.message) {
                  msg = parsed.error.message;
              }
          } catch (e) {
              // ignore parse error
          }
      }

      // Fallback
      if (!msg) msg = JSON.stringify(err);

      // Convert to lowercase for easier matching
      const msgLower = msg.toLowerCase();

      // Check for specific error types
      if (msgLower.includes('failed to fetch') || msgLower.includes('fetch failed') || msgLower.includes('network')) {
          return "网络连接失败。请检查：1) 网络连接是否正常 2) API Key 是否正确设置 3) Base URL 是否可访问 4) 浏览器控制台是否有 CORS 错误";
      } else if (msgLower.includes('not initialized')) {
          return "API 未初始化。请確保已在设置中输入 API Key 並點擊「完成」按鈕。";
      } else if (msgLower.includes('api key') || msgLower.includes('unauthorized') || msgLower.includes('401') || msgLower.includes('403')) {
          return "API Key 無效或未授權。请檢查：1) API Key 是否正確 2) API Key 是否已過期 3) API Key 是否有相應權限。";
      } else if (msgLower.includes('xhr error') || msgLower.includes('500') || msgLower.includes('rpc failed')) {
          return "网络连接或服务器暂时不稳定 (500/XHR)。请检查您的网络连接或稍后再试。";
      } else if (msgLower.includes('429') || msgLower.includes('quota') || msgLower.includes('resource_exhausted')) {
          return "API 配額已滿 (429)。建議等待 1 分鐘後再試。";
      } else if (msgLower.includes('cors')) {
          return "CORS 跨域错误。请检查 Base URL 配置或使用代理服务。";
      }
      
      // Truncate very long error messages
      return msg.length > 200 ? msg.substring(0, 200) + "..." : msg;
  };

  const handlePlanTopics = async () => {
    if (!apiKey || !apiKey.trim()) {
        toast.error("请先在设置中输入您的 API Key。");
        return;
    }

    // Initialize API
    initializeGemini(apiKey, { provider });
    
    setStatus(GenerationStatus.PLANNING);
    // 清除错误消息（使用 Toast 后不再需要）

    const config = NICHES[niche];
    if (!config) {
        toast.error("配置错误：找不到該赛道配置");
        return;
    }

    const resolvedPlanTopicCount = planTopicCountIsCustom
      ? Math.min(50, Math.max(1, parseInt(planTopicCountCustomValue, 10) || 5))
      : planTopicCountPreset;

    let prompt = '';

    // Logic for Niches with Sub-Modes
    const subModeConfig = getCurrentSubModeConfig();

    if (subModeConfig) {
        // Check input requirement
        if (subModeConfig.requiresInput && !inputVal) {
             toast.warning(`请输入${subModeConfig.title.split('：')[0]}所需的信息。`);
             return;
        }

        prompt = subModeConfig.prompt;
        
        // --- Input Injection Logic ---
        // 1. User Input
        if (inputVal) {
            prompt = prompt.replace('{input}', inputVal);
            if (niche === NicheType.FINANCE_CRYPTO) {
                prompt += `\n\n# 关键词强制规则\n所有输出标题必须包含关键词「${inputVal}」，不得省略或替换。`;
            }
            if (niche === NicheType.TCM_METAPHYSICS && tcmSubMode === TcmSubModeId.TIME_TABOO) {
                prompt += `\n\n# 日期/节气强制规则（最高优先级）\n用户输入：${inputVal}\n- ${resolvedPlanTopicCount}个标题必须逐条包含上述输入原词（逐字出现），不得替换为其他日期、不得改写为当天/当前UTC日期。\n- 若输入为节气或节日（如清明节），每条标题必须包含该节气/节日词本身。\n- 标题禁止第一人称（我/我们/俺），必须使用第三方人称“倪海厦”或“倪师”。\n- 标题用大白话，强钩子、强悬念、强警示，禁止堆砌物理术语（磁场/共振/光波/频率等）。\n- 标题尽量附带对应农历节点或民俗吉日点（如观音救难日、文昌日）。\n- 若任一标题未满足以上规则，整组结果作废并重写。`;
            }
            if (niche === NicheType.TCM_METAPHYSICS) {
                prompt += `\n\n# 中医玄学选题标题人称规则（最高优先级）\n- 所有选题标题必须使用第三方人称“倪海厦”或“倪师”。\n- 禁止第一人称（我/我们/俺）出现在标题中。\n- 若任一标题违反，整组结果作废并重写。`;

            }
        } else {
            prompt = prompt.replace(/.*\{input\}.*\n?/g, '').replace('{input}', '');
        }

        // 2. UTC 时间锚定（中医玄学仅时辰禁忌注入）
        if (shouldInjectUtcAnchor()) {
          prompt = `${getUtcAnchor()}\n\n${getUtcYearGuardrail()}\n\n${prompt}`;
        }

        // 3. Story Specific Injection
        if (niche === NicheType.STORY_REVENGE) {
             prompt = prompt.replace('{language}', storyLanguage);
             prompt = prompt.replace('{duration}', storyDuration);
        }

    } else {
        // Logic for other niches without sub-modes
        if (niche === NicheType.PSYCHOLOGY) {
            prompt = config.topicPromptTemplate;
            if (scriptLengthMode === 'SHORT') {
                prompt += '\n\n# 输出要求\n只输出短视频选题，不要出现【短视频】或【长视频】等标签。';
            } else {
                prompt += '\n\n# 输出要求\n只输出长视频选题，不要出现【短视频】或【长视频】等标签。';
            }
        } else if (niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO) {
            prompt = config.topicPromptTemplate;
        } else if (niche === NicheType.YI_JING_METAPHYSICS) {
            prompt = config.topicPromptTemplate;
            if (inputVal.trim()) {
                prompt += `\n\n# 用户侧重（可选）\n用户输入：${inputVal}\n各选题须与此相关或可自然延伸，禁止完全无关主题。`;
            }
        } else if (niche === NicheType.MINDFUL_PSYCHOLOGY) {
            // Mindful Psychology 频道选题生成
            prompt = config.topicPromptTemplate;
            if (inputVal.trim()) {
                prompt += `\n\n# 用户侧重（可选）\n用户输入：${inputVal}\n各选题须与此相关或可自然延伸。`;
            }
        } else {
            prompt = config.topicPromptTemplate.replace('{input}', inputVal);
        }
        // UTC 时间锚定（中医玄学仅时辰禁忌注入）
        if (shouldInjectUtcAnchor()) {
          prompt = `${getUtcAnchor()}\n\n${getUtcYearGuardrail()}\n\n${prompt}`;
        }
    }

    prompt = applyTopicCountToPrompt(prompt, resolvedPlanTopicCount);

    if (niche === NicheType.YI_JING_METAPHYSICS) {
      const n = resolvedPlanTopicCount;
      const womenMin = n >= 2 ? 2 : 1;
      prompt += `\n\n【女性向选题铁律·最高优先级】本次须恰好输出 ${n} 条标题，其中至少 ${womenMin} 条必须为「女性向爆款」（标题须显式出现：女人/女性/妻子/母亲/宝妈/儿媳妇 等之一，或语义上明确写女性之财富、家运、心态、改运、面相印记等；可参考爆款向：女人想暴富、命好女人不炫耀、命苦女人特征、女性改运）。若不足 ${womenMin} 条满足，整组作废重写。`;
    }

    if (niche === NicheType.MINDFUL_PSYCHOLOGY) {
      const n = resolvedPlanTopicCount;
      const catMin = n >= 2 ? 2 : 1;  // 猫主题至少
      const humanMin = n >= 2 ? 1 : 1;  // 人类主题至少1条
      const dogMin = n >= 2 ? 1 : 1;  // 狗主题至少1条（保留）

      // 抓取热门内容 RSS
      toast.info('正在抓取治愈心理学热门内容（微博/小红书/知乎等）…');
      try {
        const digest = await fetchPsychologyDigestForPrompt();
        prompt = `${digest}\n\n---\n\n` + prompt;
      } catch (e) {
        console.error('[Generator] 治愈心理学 RSS 抓取失败', e);
        toast.warning('热门内容抓取失败，使用内置备选。');
      }

      prompt += `\n\n【猫主题铁律·最高优先级】本次须恰好输出 ${n} 条标题，其中**至少 ${catMin} 条**必须显式包含猫/喵星人元素（英文标题须含 cat、kitten、meow、feline、whisker、purr 等关键词之一；中文标题须含"猫""喵星人""喵主子""毛孩子""猫咪"等）。`;

      prompt += `\n\n【人类心理健康铁律·最高优先级】本次须恰���输出 ${n} 条标题，其中**至少 ${humanMin} 条**必须围绕人类情感/心理健康/人际关系主题（如：情绪管理、焦虑疗愈、人与人的关系、亲密关系、自我成长等），不得出现猫狗宠物元素。`;

      prompt += `\n\n【狗主题补充·次优先级】本次须恰好输出 ${n} 条标题，其中**至少 ${dogMin} 条**可包含狗/宠物元素（英文标题须含 dog、puppy、paw、canine、man's best friend、furry、pet、companion 等关键词之一；中文标题须含"狗""汪星人""毛孩子"等）。`;

      prompt += `\n\n【综合要求】其余选题可围绕人宠关系、宠物对人类心理的治愈作用等交叉主题。总计 ${n} 条选题须确保：猫主题≥${catMin}条、人类主题≥${humanMin}条。若任一类别不满足要求，整组结果作废重写。`;
    }

    if (
      (niche === NicheType.FINANCE_CRYPTO && financeSubMode === FinanceSubModeId.MACRO_WARNING) ||
      niche === NicheType.GENERAL_VIRAL
    ) {
      toast.info('正在抓取国际 RSS 要闻（BBC / DW / Al Jazeera 等）…');
      try {
        const digest = await fetchMacroNewsDigestForPrompt();
        if (niche === NicheType.GENERAL_VIRAL) {
          newsMacroNewsDigestRef.current = digest;
        } else {
          financeMacroNewsDigestRef.current = digest;
        }
        const isNews = niche === NicheType.GENERAL_VIRAL;
        const extraRules = isNews
          ? `\n\n【选题对齐铁律】每条标题须与上方「国际要闻投喂」中至少一条新闻在主题上可对应（小美辣评风格改写）；禁止 10 条标题只围绕同一条新闻换皮，须尽量覆盖不同地缘/市场线索。\n【标题党铁律】每条须含强钩子：悬念/反问/震撼词/第二人称刺痛至少其二；禁止写成通讯社导语或「……说明……」式说明体；单条建议 22–48 字，可用冒号或破折号断句，追求「一眼想点进去」。`
          : `\n\n【选题对齐铁律】每条标题须与上方「国际要闻投喂」中至少一条新闻在主题上可对应（可芒格式改写）；禁止 10 条标题只围绕同一条新闻换皮，须尽量覆盖不同地缘/市场线索。\n【标题党铁律】每条须含强钩子：悬念/反问/震撼词/读者切身利益至少其二；禁止写成通讯社导语或「……说明……」式说明体；单条建议 22–48 字，可用冒号或破折号断句，追求「一眼想点进去」。`;
        prompt =
          `${digest}\n\n---\n\n` +
          prompt +
          extraRules;
      } catch (e) {
        console.error('[Generator] 宏观要闻 RSS 抓取失败', e);
        financeMacroNewsDigestRef.current = '';
        if (niche === NicheType.GENERAL_VIRAL) {
          newsMacroNewsDigestRef.current = '';
        } else {
          financeMacroNewsDigestRef.current = '';
        }
        toast.warning('国际要闻抓取失败，已退回纯模型生成选题。');
      }
    }
    
    // Status already set above

    try {
      const rawTopics = await generateTopics(prompt, config.systemInstruction, {
        topicCount: resolvedPlanTopicCount,
      });
      
      const newTopics: Topic[] = rawTopics.map((t, i) => ({
        id: `topic-${i}`,
        title:
          niche === NicheType.MINDFUL_PSYCHOLOGY ? sanitizeMindfulPsychologyTopicLine(t) : t,
        selected: true,
      }));
      setTopics(newTopics);
      setStatus(GenerationStatus.IDLE);
    } catch (err: any) {
      console.error(err);
      const errorMsg = parseErrorMessage(err);
      toast.error(errorMsg);
      setStatus(GenerationStatus.ERROR);
    }
  };

  // Mindful Psychology 频道：生成分镜（可选 scriptOverride 避免 setState 异步导致未取到最新文案）
  const handleGenerateStoryboard = async (scriptOverride?: string) => {
    if (!apiKey || !apiKey.trim()) {
      toast.error("请先在设置中输入您的 API Key。");
      return;
    }

    if (isGeneratingStoryboard) {
      toast.info('分镜正在生成中，请稍候…');
      return;
    }

    const effectiveScript = (scriptOverride ?? mindfulScript).trim();
    if (!effectiveScript) {
      toast.warning("请先在左侧输入要生成分镜的脚本内容。");
      return;
    }

    if (scriptOverride !== undefined && scriptOverride.trim()) {
      setMindfulScript(scriptOverride);
    }

    initializeGemini(apiKey, { provider });
    setIsGeneratingStoryboard(true);
    setStoryboard('');

    let localContent = '';

    const cleanOutput = (text: string): string =>
      text
        .replace(/\[TYPE:[^\]]+\]\s*/g, '')
        // 统一图片标签：清除所有乱码变体（卡纳达语 ಚಿತ್ರ、孟加拉语 ছবি、印地语 चित्र 等）
        .replace(/(?:^|\n)\s*ಚಿತ್ರ\s*prompt\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ಚಿತ್ರ\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ಚಿತ್ರ\s*提示词\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ಚಿತ್ರ提示词\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ಚಿತ್ರ提示词\b/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ಚಿತ್ರ\b/gim, '')
        .replace(/(?:^|\n)\s*ছবি\s*prompt\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ছবি\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ছবি\s*提示词\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ছবি提示词\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ছবি提示词\b/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*ছবি\b/gim, '')
        .replace(/(?:^|\n)\s*चित्र\s*prompt\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*चित्र\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*चित्र\s*提示词\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*चित्र提示词\s*[:：]\s*/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*चित्र提示词\b/gim, '图片提示词:')
        .replace(/(?:^|\n)\s*चित्र\b/gim, '')
        // 统一英文 Image prompts 标签
        .replace(/(?:^|\n)\s*Image prompts\s*[:：]\s*/gim, '图片提示词:')
        // 统一视频标签：清除所有乱码变体（含格鲁吉亚语 ვიდიო/ვიდეო、孟加拉语 ভিডিও、卡纳达语 ವೀಡಿಯೊ、印地语 वीडियो）
        .replace(/(?:^|\n)\s*ვიდიო\s*(?:prompt(?:s)?)\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდიო\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდიო\s*提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდიო提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდიო提示词\b/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდიო\b/gim, '')
        .replace(/(?:^|\n)\s*ვიდეო\s*(?:prompt(?:s)?)\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდეო\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდეო\s*提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდეო提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდეო提示词\b/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდეო\b/gim, '')
        .replace(/(?:^|\n)\s*ვიდო\s*(?:prompt(?:s)?)\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდო\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდო\s*提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდო提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდო提示词\b/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ვიდო\b/gim, '')
        .replace(/(?:^|\n)\s*ভিডিও\s*(?:prompt(?:s)?)\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ভিডিও\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ভিডিও\s*提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ভিডিও提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ভিডিও提示词\b/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ভিডিও\b/gim, '')
        .replace(/(?:^|\n)\s*ವೀಡಿಯೊ\s*(?:prompt(?:s)?)\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ವೀಡಿಯೊ\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ವೀಡಿಯೊ\s*提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ವೀಡಿಯೊ提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ವೀಡಿಯೊ提示词\b/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*ವೀಡಿಯೊ\b/gim, '')
        .replace(/(?:^|\n)\s*वीडियो\s*(?:prompt(?:s)?)\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*वीडियो\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*वीडियो\s*提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*वीडियो提示词\s*[:：]\s*/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*वीडियो提示词\b/gim, '视频提示词:')
        .replace(/(?:^|\n)\s*वीडियो\b/gim, '')
        // 通用兜底：所有语言前缀 + 任意混合字符 + 提示词或prompts + 冒号（覆盖未预见的变体）
        .replace(/(?:^|\n)\s*(?:视频|ვიდიო|ვიდეო|ভিডিও|ವೀಡಿಯೊ|वीडियो|ვიდიო|ვიდეო)[^\n:]*\s*(?:提示词|prompt(?:s)?)[^\n:]*\s*[:：]\s*/gim, '视频提示词:')
        // 统一英文 Video prompts 标签
        .replace(/(?:^|\n)\s*Video prompts?\s*[:：]\s*/gim, '视频提示词:')
        // 修复换行问题：确保标签之间有换行（支持无空格或有多空格的情况）
        // 图片提示词 和 视频提示词 之间
        .replace(/(图片提示词[：:]\s*)([^\n视频提示词景别语音分镜音效]*)(\s*)(视频提示词[：:])/g, '$1$2\n$4')
        // 图片提示词 和 景别 之间
        .replace(/(图片提示词[：:]\s*)([^\n视频提示词景别语音分镜音效]*)(\s*)(景别[：:])/g, '$1$2\n$4')
        // 视频提示词 和 景别 之间
        .replace(/(视频提示词[：:]\s*)([^\n视频提示词景别语音分镜音效]*)(\s*)(景别[：:])/g, '$1$2\n$4')
        // 视频提示词 和 语音分镜 之间
        .replace(/(视频提示词[：:]\s*)([^\n视频提示词景别语音分镜音效]*)(\s*)(语音分镜[：:])/g, '$1$2\n$4')
        // 景别 和 语音分镜 之间
        .replace(/(景别[：:]\s*)([^\n视频提示词景别语音分镜音效]*)(\s*)(语音分镜[：:])/g, '$1$2\n$4')
        // 语音分镜 和 音效 之间
        .replace(/(语音分镜[：:]\s*)([^\n视频提示词景别语音分镜音效]*)(\s*)(音效[：:])/g, '$1$2\n$4')
        // 统一换行
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    try {
      const { SCRIPT_MODE_SYSTEM } = await import('../constants');

      const scriptLength = effectiveScript.length;
      
      // 检测原文语言
      const scriptSample = effectiveScript.slice(0, Math.min(500, effectiveScript.length));
      const latinChars = (scriptSample.match(/[A-Za-z]/g) || []).length;
      const totalSampleChars = scriptSample.replace(/\s/g, '').length;
      const isEnglishScript = totalSampleChars > 0 && latinChars / totalSampleChars > 0.5;
      
      // 【核心逻辑】动态计算分镜数量（30-60个）和每镜头目标字数
      // 中文：200-300字/镜头，英文：300-450字符/镜头
      // 分镜数量 = ceil(原文字数 / 目标每镜头字数)
      const targetCharsPerShot = isEnglishScript ? 380 : 250;  // 英文更长因为字符更多
      let estimatedShots = Math.ceil(scriptLength / targetCharsPerShot);
      // 限制在30-60个镜头之间
      estimatedShots = Math.max(30, Math.min(60, estimatedShots));
      // 重新计算每镜头字数（根据实际分镜数）
      const charsPerShot = Math.ceil(scriptLength / estimatedShots);

      const systemInstruction =
        '你是一个全领域万能短视频分镜生成器。接收故事文本，通过"语义合并"与"抽象概念具象化"生成动画/实拍视频提示词。**严格按照格式输出分镜内容，禁止输出任何前缀说明或分析过程。**';

      const stylePromptEn = getMediaImageStylePromptEn(mindfulStoryboardStyleId);
      const isMinimalistStyle = mindfulStoryboardStyleId === 'minimalist';
      const isAnimeAestheticsStyle = mindfulStoryboardStyleId === 'anime_aesthetics';
      
      // 【预切分原文】严格按照句子边界切分，保证完整性
      const scriptSegments = segmentTextByShots(effectiveScript, estimatedShots);
      
      // 构建每镜头的预切分文案提示
      const segmentsPrompt = scriptSegments
        .map((seg, i) => `【镜头 ${i + 1} 原文段落（约 ${seg.length} 字）】\n${seg}`)
        .join('\n\n');

      // 图片提示词语言跟随原文
      const promptLangHint = isEnglishScript
        ? '图片提示词和视频提示词使用英文，描述画面内容。'
        : '图片提示词使用简体中文，禁止纯英文。用中文描写画面内容。';
      const styleDirective = isMinimalistStyle
        ? `**【Minimalist 极简风格铁律（仅本风格生效）】**\n1) 图片提示词风格描述：极简扁平插画风、干净简洁的设计、整洁构图、大量留白、低细节、柔和低饱和度配色、莫兰迪色调、统一色系、黑色线条、简化几何形状、流畅线条、精致高级感、现代互联网插画风格。\n2) ${promptLangHint}\n3) 画面描述必须是简易易懂的场景，极度简洁。\n4) 绝对禁止：PPT、图表、表格、数据类元素；禁止干扰性/解释性/否定性提示词；禁止复杂构图、复杂隐喻。`
        : isAnimeAestheticsStyle
          ? `**【复古动漫（anime aesthetics）铁律（仅本风格生效）】**\n1) 图片提示词风格描述：干净柔和的勾线笔风格、角色居中、拒绝冗杂、画面清爽简洁有呼吸感、局部点缀淡雅水彩、现代数字插画风格、米白色背景、编辑插画风格、心理学概念艺术、充满情感且柔和。\n2) ${promptLangHint}\n3) 画面描述必须是简易易懂的场景，极度简洁。\n4) 绝对禁止：PPT、图表、表格、数据类元素；禁止干扰性/解释性/否定性提示词；禁止复杂构图、复杂隐喻。`
          : stylePromptEn
            ? `**【画面风格预设】**用户已选画面风格；${promptLangHint}可融入英文风格关键词（如 anime aesthetics、minimalist 等风格词保留英文）。`
            : `**【图片提示词语言】**${promptLangHint}`;

      // 【关键Prompt】明确告诉模型：镜头文案=预切分的原文，不做任何修改
      const prompt = `${SCRIPT_MODE_SYSTEM}

# 用户脚本（共 ${scriptLength} 字，${estimatedShots} 个镜头，每镜头约 ${charsPerShot} 字）

**【核心逻辑 - 必须严格遵守】**
1. 镜头数量：${estimatedShots} 个
2. 每个镜头文案字数：约 ${charsPerShot} 字（允许±20%浮动）
3. **镜头文案 = 上面预切分的原文段落，一字不差！禁止删减、压缩、扩写！**

${segmentsPrompt}

## 输出格式

镜头 1
镜头文案:（直接使用上面的【镜头 1 原文段落】原文，一字不差）
图片提示词:（根据镜头1原文推理画面描述，语言与原文一致）
视频提示词:（运镜描述，语言与原文一致）
景别:全景/中景/特写
语音分镜:${isEnglishScript ? 'Narrator' : '旁白'}
音效:环境音或无

（按同样格式输出所有 ${estimatedShots} 个镜头...）

${styleDirective}
${isEnglishScript 
  ? '**【语言一致性】英文原文的镜头文案用完整英文，图片/视频提示词用英文。**'
  : '**【语言一致性】中文原文的镜头文案用完整中文，图片/视频提示词用中文。**'
}
**【标签一致性 - 关键】视频提示词标签必须严格使用"视频提示词"四个字，不得使用英文 Video prompts、不得使用其他语言的视频词汇（如 Video、ვიდიო、ვიდეო、ভিডিও、वीडियो 等），不得自创任何标签格式。图片提示词同理。**
**【禁止】不要输出赛道分类描述。图片提示词只描述画面内容本身。**`;

      const appendChunk = (chunk: string) => {
        localContent += chunk;
        setStoryboard(cleanOutput(localContent));
        // 估算进度：脚本长度约 effectiveScript.length，生成内容约为 localContent.length
        // 到达角色信息后视为基本完成
        const raw = localContent;
        if (/角色信息/.test(raw)) {
          setStoryboardProgress(95);
        } else {
          const ratio = Math.min(90, (raw.length / (effectiveScript.length * 1.5)) * 80);
          setStoryboardProgress(Math.round(ratio));
        }
      };

      const model = 'gpt-5.4-mini';

      console.log(`[Storyboard] 启动，模型=${model}，预计 ${estimatedShots} 个镜头`);
      toast.info(`正在生成分镜（${estimatedShots} 个镜头）…`);
      setStoryboardProgress(5);

      await streamContentGeneration(
        prompt,
        systemInstruction,
        appendChunk,
        model,
        { maxTokens: 128_000, idleTimeoutMs: 180_000, firstChunkTimeoutMs: 60_000 }
      );

      localContent = cleanOutput(localContent);
      setStoryboard(localContent);
      setStoryboardProgress(100);
      console.log('[Storyboard] 生成完成');

      if (!localContent || localContent.trim().length === 0) {
        toast.error('分镜生成失败：返回内容为空');
        return;
      }

      const hasRoleInfo = /角色信息/.test(localContent);
      const hasSceneInfo = /场景信息/.test(localContent);

      if (hasRoleInfo && hasSceneInfo) {
        toast.success('分镜生成完成！');
      } else if (hasRoleInfo || hasSceneInfo) {
        toast.warning('分镜已生成，请检查角色/场景信息是否完整。');
      } else {
        toast.warning('分镜已生成，但未检测到角色/场景信息，请检查输出内容。');
      }

      try {
        const historyKey = getMindfulStoryboardHistoryKey();
        const recordName = generateDatedRandomHistoryLabel();
        saveHistory('generator', historyKey, localContent, {
          topic: recordName,
          input: effectiveScript,
        });
        console.log('[Generator] 分镜已保存历史记录，key:', historyKey, 'name:', recordName);
      } catch (e) {
        console.error('[Generator] 保存分镜历史记录失败:', e);
      }
    } catch (err: any) {
      console.error(err);
      const errorMsg = parseErrorMessage(err);
      toast.error(errorMsg);
    } finally {
      setIsGeneratingStoryboard(false);
      setStoryboardProgress(0);
    }
  };

  // Handle adaptation for ShadowWriter mode
  const handleAdaptContent = async () => {
    if (!apiKey || !apiKey.trim()) {
      toast.error("请先在设置中输入您的 API Key。");
      return;
    }

    if (!inputVal || !inputVal.trim()) {
      toast.warning("请输入需要改編的原文內容。");
      return;
    }

    // Initialize API
    initializeGemini(apiKey, { provider });
    
    setIsAdapting(true);
    setAdaptedContent('');
    // 清除错误消息（使用 Toast 后不再需要）

    // Length control helper (IMPORTANT: must use SAME rule for source & output)
    // DO NOT strip all whitespace/newlines, otherwise length control will be wrong and cause expansion.
    const getControlLength = (text: string): number => {
      const cleaned = (text || '')
        .replace(/\r\n/g, '\n')
        // Remove statistics/markers if they appear in output (shouldn't, but be safe)
        .replace(/\[字數統計[^\]]*\]/gi, '')
        .replace(/字數統計[：:][^\n]*/gi, '')
        .replace(/已洗稿[：:][^\n]*/gi, '')
        .replace(/原文字數[：:][^\n]*/gi, '')
        .replace(/目標字數[：:][^\n]*/gi, '')
        .replace(/進度[：:][^\n]*/gi, '')
        .replace(/還需[：:][^\n]*/gi, '')
        // Remove continuation markers
        .replace(/^-----+\s*$/gm, '')
        .replace(/\n-----+\n/g, '\n');
      return cleaned.length;
    };

    // Calculate source text length - 像素级洗稿，严格一比一输出
    const sourceLength = getControlLength(inputVal.trimEnd());
    const targetLength = sourceLength; // 目标就是原文长度
    const tolerance = Math.ceil(sourceLength * 0.01); // 1% tolerance - 极严格
    const minLength = sourceLength - tolerance; // 最少少1%
    const maxLength = sourceLength + tolerance; // 最多多1%
    
    console.log(`[Adaptation] Source: ${sourceLength} chars, ULTRA STRICT Target: ${sourceLength} ±${tolerance} (${minLength}-${maxLength})`);

    const config = NICHES[niche];
    if (!config) {
      toast.error("配置错误：找不到該赛道配置");
      return;
    }

    // ShadowWriter system prompt - ULTRA STRICT 1:1 Rewriting Mode
    const shadowWriterSystemPrompt = `**Role:** You are **ShadowWriter (暗影写手)**, a word-level content rewriter.

**ABSOLUTE IRON-CLAD RULES (绝对铁律):**

🚫 **EXPANSION IS FORBIDDEN (扩写=失败)**
- You are NOT a writer, you are a WORD REPLACER
- You CANNOT add ANY new content
- You CANNOT elaborate or explain ANYTHING
- You CANNOT add descriptions
- You CANNOT expand sentences
- You can ONLY replace words with synonyms

🎯 **1:1 CHARACTER COUNT RULE (一比一字数铁律)**
- Input: ${sourceLength} chars → Output: MUST be ${sourceLength} chars (±${tolerance} ONLY)
- If input paragraph = 100 chars → output = 97-103 chars MAXIMUM
- Count every character in real-time
- If approaching ${maxLength}, STOP IMMEDIATELY

📏 **YOUR MISSION:**
Replace words while keeping EXACT same length. That's ALL.

✅ **ONLY Allowed Actions:**
1. Replace word with synonym (例：很好 → 非常好，极好 → 很好)
2. Change sentence structure (例：他走了 → 走了的是他)
3. Reorder words (例：我很生气 → 生气的我)

❌ **ABSOLUTELY FORBIDDEN:**
- Adding ANY new sentence
- Adding ANY new word not in original
- Adding ANY description
- Adding ANY elaboration
- Using closing phrases like "下课", "散会", "再见" in middle of content
- Any expansion whatsoever

🔴 **CRITICAL:**
- DO NOT add ending phrases until the VERY END
- DO NOT write "下课", "散会", "各位再见" in the middle
- These phrases ONLY appear at the absolute final conclusion

**Output Language**: ${storyLanguage}
**Output**: ONLY the rewritten text. NO technical notes.`;

    try {
      let localContent = '';
      const MAX_SEGMENTS = 50; // Maximum number of segments to process
      let segmentIndex = 0;
      let isFinished = false;

      // Helper to remove premature ending phrases (移除提前出现的收尾词汇)
      const removePrematureEndings = (text: string, isMiddleSegment: boolean): string => {
        if (!isMiddleSegment) return text; // Only clean middle segments
        
        // List of ending phrases that should NOT appear in middle segments
        const endingPhrases = [
          /好了[，,、。\s]*今天[就的]?[講讲][到这這][里裡儿兒]?/gi,
          /下課了?[，,。\s]*/gi,
          /散會了?[，,。\s]*/gi,
          /今天[就的]?[到这這][里裡儿兒]?了?/gi,
          /各位[同学同學]?再見/gi,
          /後會有期/gi,
          /后会有期/gi,
          /咱們[就的]?[到这這][里裡儿兒]?/gi,
          /下次再[講讲聊見见]/gi,
          /我們今天[就的]?[講讲]?[到这這][里裡儿兒]?/gi
        ];
        
        let cleaned = text;
        for (const phrase of endingPhrases) {
          cleaned = cleaned.replace(phrase, '');
        }
        
        return cleaned;
      };
      
      // Helper to clean final output (remove all stats and technical markers)
      const cleanFinalOutput = (text: string): string => {
        return text
          // Remove statistics blocks
          .replace(/\[字數統計[^\]]*\]/gi, '')
          .replace(/字數統計[：:][^\n]*/gi, '')
          .replace(/已洗稿[：:][^\n]*/gi, '')
          .replace(/原文字數[：:][^\n]*/gi, '')
          .replace(/目標字數[：:][^\n]*/gi, '')
          .replace(/進度[：:][^\n]*/gi, '')
          .replace(/還需[：:][^\n]*/gi, '')
          .replace(/當前字數[：:][^\n]*/gi, '')
          .replace(/剩餘字數[：:][^\n]*/gi, '')
          .replace(/字數對比[：:][^\n]*/gi, '')
          // Remove continuation markers
          .replace(/^-----+\s*$/gm, '')
          .replace(/\n-----+\n/g, '\n')
          .replace(/-----+/g, '').replace(/----+/g, '')
          // Clean up multiple blank lines
          .replace(/\n\s*\n\s*\n+/g, '\n\n')
          .trim();
      };

      // Split source text into paragraphs
      const sourceParagraphs = inputVal.split(/\n\s*\n/).filter(p => p.trim().length > 0);
      const sourceParagraphCount = sourceParagraphs.length;
      
      // STRICT strategy: process 1-2 paragraphs at a time for precise control
      const paragraphsPerSegment = Math.min(2, sourceParagraphCount); // Maximum 2 paragraphs per segment
      const totalSegments = Math.ceil(sourceParagraphCount / paragraphsPerSegment);
      
      console.log(`[Adaptation] Total paragraphs: ${sourceParagraphCount}, Processing ${paragraphsPerSegment} per segment, Total segments: ${totalSegments}`);

      // Segment-based rewriting: process paragraphs in segments
      while (segmentIndex < totalSegments && !isFinished) {
        const startParaIndex = segmentIndex * paragraphsPerSegment;
        const endParaIndex = Math.min(startParaIndex + paragraphsPerSegment, sourceParagraphCount);
        const currentSegmentParagraphs = sourceParagraphs.slice(startParaIndex, endParaIndex);
        const segmentSourceText = currentSegmentParagraphs.join('\n\n');
        
        // Calculate current length and progress
        const currentLength = getControlLength(localContent);
        const lengthDiff = currentLength - sourceLength;
        const progress = (endParaIndex / sourceParagraphCount) * 100;
        
        console.log(`[Adaptation] Segment ${segmentIndex + 1}/${totalSegments}: Para ${startParaIndex + 1}-${endParaIndex}/${sourceParagraphCount} (${progress.toFixed(1)}%), Current: ${currentLength}/${sourceLength} chars, Diff: ${lengthDiff > 0 ? '+' : ''}${lengthDiff}`);
        
        // CRITICAL: Stop immediately if we've reached or exceeded source length
        if (currentLength >= sourceLength) {
          console.log(`[Adaptation] STOP: Already reached source length (${currentLength}/${sourceLength})`);
          isFinished = true;
          break;
        }
        
        // Stop if we've exceeded 98% of source and processed most content
        if (currentLength >= sourceLength * 0.98 && endParaIndex >= sourceParagraphCount * 0.90) {
          console.log(`[Adaptation] STOP: At 98% length and 90% content processed`);
          isFinished = true;
          break;
        }
        
        // CRITICAL: Stop if we approach max tolerance
        if (currentLength >= maxLength * 0.85) {
          console.log(`[Adaptation] STOP: Approaching max tolerance (${currentLength}/${maxLength})`);
          isFinished = true;
          break;
        }
        
        // Calculate segment-specific character counts (same metric as global control)
        const segmentSourceLength = getControlLength(segmentSourceText);
        const targetSegmentLength = segmentSourceLength; // 1:1 target
        const segmentTolerance = Math.ceil(segmentSourceLength * 0.03); // 3% per segment
        
        const segmentPrompt = `# 洗稿任務（第 ${startParaIndex + 1}-${endParaIndex} 段，共 ${sourceParagraphCount} 段）

⚠️ **字數鐵律** ⚠️
本段原文：${segmentSourceLength} 字 → 你的输出：${targetSegmentLength} 字（±${segmentTolerance}）
超過 ${targetSegmentLength + segmentTolerance} 字 = 失敗

📊 **進度：${Math.floor((currentLength / sourceLength) * 100)}%**（已完成 ${currentLength}/${sourceLength} 字）

---

## 【原文段落】（${segmentSourceLength} 字）
${segmentSourceText}

---

## 🚫 **絕對禁止（違反=失敗）**

1. **禁止添加任何內容**：不要加新句子、新詞、新描述
2. **禁止扩写**：不要解釋、不要展開、不要詳細說明
3. **禁止收尾詞彙**：嚴禁使用「下課」「散會」「再見」「後會有期」「今天就講到這」等結束語
4. **禁止改變長度**：输出必須和原文一樣長

## ✅ **只准做的事**

- 替換詞彙（很好→非常好、因為→由於）
- 改變句式（主動→被動、長句→短句）
- 調整語序（他很生氣→生氣的他）

## 📝 **输出格式**

- 純文本
- 保持段落結構
- 段落間空一行
- 不要有任何技術說明

---

立即输出洗稿內容：`;

        // Generate into a segment buffer first, enforce HARD caps (segment + global),
        // then append. This prevents uncontrolled expansion even if the model ignores instructions.
        let segmentOut = '';
        const segmentMaxLength = targetSegmentLength + segmentTolerance;
        const maxTokens = Math.min(2048, Math.max(256, Math.ceil(segmentMaxLength * 1.2) + 64));

        const onSegmentChunk = (chunk: string) => {
          const globalRemaining = maxLength - getControlLength(localContent);
          const segmentRemaining = segmentMaxLength - getControlLength(segmentOut);
          const remaining = Math.min(globalRemaining, segmentRemaining);
          if (remaining <= 0) return;
          const safeChunk = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
          segmentOut += safeChunk;
          setAdaptedContent(localContent + segmentOut);
        };

        await streamContentGeneration(segmentPrompt, shadowWriterSystemPrompt, onSegmentChunk, undefined, {
          temperature: 0.2,
          maxTokens
        });

        localContent += segmentOut;
        setAdaptedContent(localContent);
        
        // Wait a bit for content to settle
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // CRITICAL: Remove premature ending phrases from middle segments
        const isMiddleSegment = endParaIndex < sourceParagraphCount;
        if (isMiddleSegment) {
          const beforeClean = localContent;
          localContent = removePrematureEndings(localContent, true);
          if (beforeClean !== localContent) {
            console.log(`[Adaptation] ⚠️ Removed premature ending phrases from segment ${segmentIndex + 1}`);
            setAdaptedContent(localContent);
          }
        }
        
        // Check length after this segment
        const newLength = getControlLength(localContent);
        const newLengthDiff = newLength - sourceLength;
        const newProgress = (endParaIndex / sourceParagraphCount) * 100;
        
        // Calculate expected vs actual length ratio
        const expectedLength = Math.floor((endParaIndex / sourceParagraphCount) * sourceLength);
        const lengthRatio = newLength / expectedLength;
        
        console.log(`[Adaptation] ✓ Segment ${segmentIndex + 1} done: ${newLength}/${sourceLength} chars (${newProgress.toFixed(1)}% content), Diff: ${newLengthDiff > 0 ? '+' : ''}${newLengthDiff}, Ratio: ${lengthRatio.toFixed(2)}`);
        
        // ⚠️ ALERT: If length is growing too fast (超过预期比例), warn
        if (lengthRatio > 1.15) {
          console.log(`[Adaptation] ⚠️ WARNING: Length growing too fast! Ratio: ${lengthRatio.toFixed(2)} (expected ~1.0)`);
        }
        
        // CRITICAL STOP CONDITIONS (严格停止条件)
        
        // 0. EMERGENCY: If length ratio exceeds 1.2x, STOP immediately (防止失控)
        if (lengthRatio > 1.2) {
          console.log(`[Adaptation] 🚨 EMERGENCY STOP: Length ratio ${lengthRatio.toFixed(2)} > 1.2, expansion detected!`);
          isFinished = true;
          break;
        }
        
        // 1. If we've reached or exceeded source length, STOP immediately
        if (newLength >= sourceLength) {
          console.log(`[Adaptation] ✋ STOP: Reached source length (${newLength}/${sourceLength})`);
          isFinished = true;
          break;
        }
        
        // 2. If we've exceeded 97% and processed 80% of content, STOP
        if (newLength >= sourceLength * 0.97 && endParaIndex >= sourceParagraphCount * 0.80) {
          console.log(`[Adaptation] ✋ STOP: At 97% length, 80% content done`);
          isFinished = true;
          break;
        }
        
        // 3. If we approach max tolerance, STOP
        if (newLength >= maxLength * 0.85) {
          console.log(`[Adaptation] ✋ STOP: Approaching max tolerance (${newLength}/${maxLength})`);
          isFinished = true;
          break;
        }
        
        // 4. If all content processed, STOP
        if (endParaIndex >= sourceParagraphCount) {
          console.log(`[Adaptation] ✋ STOP: All content processed`);
          isFinished = true;
          break;
        }
        
        segmentIndex++;
      }

      // Check final result and add ending ONLY if we have remaining content
      const finalLength = getControlLength(localContent);
      const finalLengthDiff = finalLength - sourceLength;
      const processedParaCount = Math.min(segmentIndex * paragraphsPerSegment + paragraphsPerSegment, sourceParagraphCount);
      const remainingParaCount = sourceParagraphCount - processedParaCount;
      
      console.log(`[Adaptation] Final check: ${finalLength}/${sourceLength} chars (Diff: ${finalLengthDiff > 0 ? '+' : ''}${finalLengthDiff}), Processed: ${processedParaCount}/${sourceParagraphCount} paragraphs`);
      
      // NOTE: Fallback "remaining paragraphs" generation is DISABLED.
      // It often causes duplication/expansion by reintroducing previous context and breaking 1:1 length control.
      
      // Final cleanup: remove all statistics and technical markers
      localContent = cleanFinalOutput(localContent);
      
      // Final validation and reporting
      const absoluteFinalLength = getControlLength(localContent);
      const absoluteFinalDiff = absoluteFinalLength - sourceLength;
      const diffPercentage = ((absoluteFinalDiff / sourceLength) * 100).toFixed(2);
      
      console.log(`[Adaptation] ✅ COMPLETED!`);
      console.log(`[Adaptation] Source: ${sourceLength} chars`);
      console.log(`[Adaptation] Output: ${absoluteFinalLength} chars`);
      console.log(`[Adaptation] Diff: ${absoluteFinalDiff > 0 ? '+' : ''}${absoluteFinalDiff} chars (${absoluteFinalDiff > 0 ? '+' : ''}${diffPercentage}%)`);
      console.log(`[Adaptation] Target range: ${minLength}-${maxLength} chars (±${tolerance})`);
      console.log(`[Adaptation] Status: ${absoluteFinalLength >= minLength && absoluteFinalLength <= maxLength ? '✅ PASS' : '❌ OUT OF RANGE'}`);
      
      setAdaptedContent(localContent);

    } catch (err: any) {
      console.error(err);
      toast.error(parseErrorMessage(err));
    } finally {
      setIsAdapting(false);
    }
  };

  const toggleTopic = (id: string) => {
    setTopics(topics.map(t => t.id === id ? { ...t, selected: !t.selected } : t));
  };

  // 批量生成进度状态
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    hint?: string;
  } | null>(null);

  const pushYiJingLog = useCallback((line: string) => {
    const ts = new Date().toLocaleTimeString();
    setYiJingPipelineLogs((prev) => [...prev.slice(-220), `[${ts}] ${line}`]);
  }, []);

  const collectStreamText = useCallback(
    async (prompt: string, systemInstruction: string, maxTokens?: number): Promise<string> => {
      let acc = '';
      await streamContentGeneration(prompt, systemInstruction, (chunk) => {
        acc += chunk;
      }, undefined, { maxTokens: maxTokens ?? 8192 });
      return acc;
    },
    []
  );

  const normalizeYiJingBody = useCallback((content: string): string => {
    if (!content || content.length < 400) return content;
    if (!needsParagraphNormalization(content)) return content;
    return normalizeDenseChineseParagraphs(content);
  }, []);

  const clearYiJingPipelinePanel = useCallback(() => {
    setYiJingOutlineText('');
    setYiJingOutlineParsed(null);
    setYiJingOutlineViewMode('readable');
    setYiJingOutlineEditDraft(null);
    setYiJingSegDrafts([]);
    setYiJingSegStatus([]);
    setYiJingPipelineLogs([]);
    setYiJingMergedOutput('');
  }, []);

  const emptyYiJingChapter = (i: number): YiJingChapterPlan => ({
    title: `第 ${i + 1} 章（请修改标题）`,
    min_chars: 800,
    max_chars: 1200,
    core_brief: '',
    opening_echo: '',
    closing_snippet_hint: '',
    bridge_to_next: '',
  });

  const clampYiJingTotalTarget = (v: number) =>
    Math.min(70000, Math.max(1000, Math.round(Number.isFinite(v) ? v : 8000)));

  /** 在已有大纲上按当前「目标全文字数」重算各章 min_chars / max_chars，并同步 JSON 文本 */
  const applyYiJingTotalTargetToOutline = useCallback(
    (total: number) => {
      const mindfulLong = niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG';
      const n = mindfulLong ? clampMindfulParallelTargetChars(total) : clampYiJingTotalTarget(total);
      setYiJingTotalTargetChars(n);
      setYiJingOutlineParsed((prev) => {
        if (!prev) return null;
        const next = rescaleChapterWordCounts(prev, n);
        setYiJingOutlineText(outlinePayloadToJsonPretty(next));
        return next;
      });
    },
    [niche, scriptLengthMode]
  );

  /** 仅生成并解析大纲（可编辑后再并行） */
  const handleYiJingGenerateOutline = useCallback(async () => {
    const sel = topics.filter((t) => t.selected);
    if (!sel[0]) {
      toast.warning('请先选择一个选题');
      return;
    }
    if (!apiKey?.trim()) {
      toast.error('请先配置 API Key');
      return;
    }
    initializeGemini(apiKey, { provider });
    setYiJingPipelineBusy(true);
    const segN = yiJingComputedSegCount;
    const bundle = getParallelPipelineBundle(
      niche,
      scriptLengthMode,
      storyLanguage,
      storyDuration,
      NICHES[niche],
      mindfulLanguage
    );
    const lead = getParallelOutlineLeadContext();
    setBatchProgress({
      current: 0,
      total: 1,
      hint: `正在生成大纲（约 ${segN} 章）…`,
    });
    pushYiJingLog(
      `开始生成大纲（自动约 ${segN} 章，全文目标约 ${parallelTotalTargetChars} 字）…`
    );
    try {
      const raw = await collectStreamText(
        buildParallelOutlineUserPrompt(
          sel[0].title,
          segN,
          parallelTotalTargetChars,
          bundle.outline,
          lead || undefined
        ),
        bundle.outlineSystem,
        6144
      );
      const parsedRaw = parseYiJingOutline(raw);
      const parsed = parsedRaw
        ? rescaleChapterWordCounts(parsedRaw, parallelTotalTargetChars)
        : null;
      setYiJingOutlineParsed(parsed);
      setYiJingOutlineText(parsed ? outlinePayloadToJsonPretty(parsed) : raw);
      setYiJingOutlineViewMode('readable');
      setYiJingOutlineEditDraft(null);
      if (parsed) {
        pushYiJingLog(`大纲已解析：${parsed.chapters.length} 章`);
        setYiJingSegDrafts(Array(parsed.chapters.length).fill(''));
        setYiJingSegStatus(Array(parsed.chapters.length).fill('idle'));
        setBatchProgress({ current: 1, total: 1, hint: '大纲已生成' });
      } else {
        pushYiJingLog('大纲 JSON 解析失败，请检查模型输出或点击「清空面板」重试');
        toast.error('大纲解析失败，请重试');
        setBatchProgress({ current: 0, total: 1, hint: '大纲解析失败' });
      }
    } catch (e: any) {
      pushYiJingLog(`大纲失败：${e?.message || e}`);
      toast.error(e?.message || '大纲生成失败');
      setBatchProgress({ current: 0, total: 1, hint: '大纲请求失败' });
    } finally {
      setYiJingPipelineBusy(false);
      setTimeout(() => setBatchProgress(null), 1000);
    }
  }, [
    apiKey,
    provider,
    niche,
    scriptLengthMode,
    storyLanguage,
    storyDuration,
    topics,
    yiJingComputedSegCount,
    parallelTotalTargetChars,
    collectStreamText,
    pushYiJingLog,
    toast,
    getParallelOutlineLeadContext,
  ]);

  /** 基于已解析大纲，分段并行生成 */
  const handleYiJingRunSegments = useCallback(async () => {
    const sel = topics.filter((t) => t.selected);
    if (!sel[0]) {
      toast.warning('请先选择一个选题');
      return;
    }
    let parsed = yiJingOutlineParsed;
    if (!parsed) {
      parsed = parseYiJingOutline(yiJingOutlineText);
      if (!parsed) {
        toast.error('请先「生成大纲」，或在编辑大纲中保存有效结构');
        return;
      }
      parsed = rescaleChapterWordCounts(parsed, parallelTotalTargetChars);
      setYiJingOutlineParsed(parsed);
      setYiJingOutlineText(outlinePayloadToJsonPretty(parsed));
    } else {
      parsed = rescaleChapterWordCounts(parsed, parallelTotalTargetChars);
      setYiJingOutlineParsed(parsed);
      setYiJingOutlineText(outlinePayloadToJsonPretty(parsed));
    }
    if (!apiKey?.trim()) {
      toast.error('请先配置 API Key');
      return;
    }
    initializeGemini(apiKey, { provider });
    const config = NICHES[niche];
    const sys = config.systemInstruction;
    const bundle = getParallelPipelineBundle(
      niche,
      scriptLengthMode,
      storyLanguage,
      storyDuration,
      config,
      mindfulLanguage
    );
    const topicTitle = sel[0].title;
    const n = parsed.chapters.length;
    setYiJingPipelineBusy(true);
    setYiJingSegDrafts(Array(n).fill(''));
    setYiJingSegStatus(Array(n).fill('idle'));
    pushYiJingLog(`并行生成 ${n} 段…`);
    const segDone = new Set<number>();
    setBatchProgress({ current: 0, total: n, hint: `并行生成 0/${n} 段` });

    try {
      const results = await Promise.all(
        parsed.chapters.map(async (ch, idx) => {
          setYiJingSegStatus((prev) => {
            const next = [...prev];
            next[idx] = 'running';
            return next;
          });
          pushYiJingLog(`第 ${idx + 1}/${n} 段 开始…`);
          try {
            const user = buildParallelSegmentUserPrompt(
              {
                topic: topicTitle,
                coreTheme: parsed!.core_theme,
                logicLine: parsed!.logic_line,
                chapter: ch,
                chapterIndex: idx,
                totalChapters: n,
              },
              bundle.segment
            );
            let local = '';
            await streamContentGeneration(user, sys, (c) => {
              local += c;
              setYiJingSegDrafts((prev) => {
                const arr = [...prev];
                arr[idx] = local;
                return arr;
              });
            }, undefined, { maxTokens: 12288 });
            setYiJingSegStatus((prev) => {
              const next = [...prev];
              next[idx] = 'done';
              return next;
            });
            pushYiJingLog(`第 ${idx + 1}/${n} 段 完成（约 ${local.length} 字）`);
            segDone.add(idx);
            setBatchProgress({
              current: segDone.size,
              total: n,
              hint: `并行生成 ${segDone.size}/${n} 段`,
            });
            return local;
          } catch (err: any) {
            setYiJingSegStatus((prev) => {
              const next = [...prev];
              next[idx] = 'error';
              return next;
            });
            pushYiJingLog(`第 ${idx + 1} 段 错误：${err?.message || err}`);
            segDone.add(idx);
            setBatchProgress({
              current: segDone.size,
              total: n,
              hint: `并行生成 ${segDone.size}/${n} 段（含失败）`,
            });
            return `[本段生成失败：${err?.message || err}]`;
          }
        })
      );
      setYiJingSegDrafts(results);
      pushYiJingLog('全部分段请求已结束');
      setBatchProgress({ current: n, total: n, hint: '各段请求已结束' });
    } finally {
      setYiJingPipelineBusy(false);
      setTimeout(() => setBatchProgress(null), 900);
    }
  }, [
    apiKey,
    provider,
    niche,
    scriptLengthMode,
    storyLanguage,
    storyDuration,
    topics,
    yiJingOutlineParsed,
    yiJingOutlineText,
    parallelTotalTargetChars,
    pushYiJingLog,
    toast,
  ]);

  const handleYiJingMergeFinal = useCallback(async () => {
    const sel = topics.filter((t) => t.selected);
    if (!sel[0]) {
      toast.warning('请先选择一个选题');
      return;
    }
    const parts = yiJingSegDrafts.filter((s) => s && s.trim());
    if (parts.length === 0) {
      toast.error('没有可合并的分段正文');
      return;
    }
    if (!apiKey?.trim()) {
      toast.error('请先配置 API Key');
      return;
    }
    initializeGemini(apiKey, { provider });
    setYiJingPipelineBusy(true);
    pushYiJingLog('合并初稿 + 统一全文语气…');
    setBatchProgress({ current: 0, total: 1, hint: '正在合并、统一语气…' });

    // 计算输出语言
    const isEnRevenge = niche === NicheType.STORY_REVENGE && storyLanguage === StoryLanguage.ENGLISH;
    const isMindfulEnglish = niche === NicheType.MINDFUL_PSYCHOLOGY;
    const effectiveLang = mindfulLanguage || 'en';
    const outputLanguage: 'zh' | 'en' = isMindfulEnglish ? (effectiveLang === 'en' ? 'en' : 'zh') : (isEnRevenge ? 'en' : 'zh');

    try {
      const bundle = getParallelPipelineBundle(
        niche,
        scriptLengthMode,
        storyLanguage,
        storyDuration,
        NICHES[niche],
        mindfulLanguage
      );
      const combined = parts.join('\n\n');
      const mindfulLong =
        niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG';
      const merged = await collectStreamText(
        buildParallelMergeUserPrompt(sel[0].title, combined, parallelTotalTargetChars, {
          ...bundle.merge,
          englishMergedCharClamp: mindfulLong
            ? mindfulMergeCharClamp(parallelTotalTargetChars)
            : undefined,
          mindfulLanguage,
        }),
        bundle.mergeSystem,
        32768
      );
      let norm = normalizeYiJingBody(merged);
      if (mindfulLong) {
        norm = truncateMindfulScript(norm, MINDFUL_EN_SCRIPT_CHARS_MAX);
      }

      // 提取并保留文末 CTA（互动引导）
      const ctaPatterns = [
        // 英文 CTA - 更宽松的匹配
        /(If this resonated with you,?\s*(?:please\s+)?(?:like\s+and\s+subscribe|subscribe\s+to\s+my\s+channel)[^.]*(?:\.)?\s*)$/i,
        /(please\s+(?:like\s+and\s+)?subscribe\s+to\s+my\s+channel[^.]*(?:\.)?\s*)$/i,
        /(like\s+and\s+subscribe\s+to\s+my\s+channel[^.]*(?:\.)?\s*)$/i,
        /(subscribe\s+to\s+my\s+channel[^.]*(?:\.)?\s*)$/i,
        // 中文 CTA - 使用捕获组
        /((?:请点赞|喜欢本文|如果觉得有收获)[^\n。！？]{0,100}[。！？]?)\s*$/i,
        /((?:评论区|留言区|留言)[^\n。！？]{0,100}[。！？]?)\s*$/i,
        /((?:咱们下期|下期继续)[^\n。！？]{0,100}[。！？]?)\s*$/i,
        /((?:转发给|分享给)[^\n。！？]{0,100}[。！？]?)\s*$/i,
      ];
      let savedCta = '';
      for (const pattern of ctaPatterns) {
        const match = norm.match(pattern);
        if (match && match[1]) {
          savedCta = match[1].trim();
          break;
        }
      }

      // 如果没有匹配到 CTA，尝试从末尾提取最后一段
      if (!savedCta && norm.length > 50) {
        const lastParagraph = norm.split(/\n\n+/).filter(p => p.trim()).pop() || '';
        const ctaKeywords = ['like and subscribe', 'subscribe to my channel', 'please like', 'if this resonated', '请点赞', '喜欢本文', '如果觉得'];
        for (const keyword of ctaKeywords) {
          if (lastParagraph.toLowerCase().includes(keyword.toLowerCase())) {
            savedCta = lastParagraph.trim();
            break;
          }
        }
      }

      setYiJingMergedOutput(norm);
      setBatchProgress({ current: 1, total: 1, hint: '合并完成' });
      setGeneratedContents((prev) => {
        if (prev.length === 0) return [{ topic: sel[0].title, content: norm }];
        const next = [...prev];
        const hit = next.findIndex((x) => x.topic === sel[0].title);
        if (hit >= 0) {
          next[hit] = { ...next[hit], content: norm };
          return next;
        }
        return [{ topic: sel[0].title, content: norm }];
      });
      pushYiJingLog(`合并完成，终稿约 ${norm.length} 字` + (savedCta ? '（已保留末尾CTA）' : ''));

      // ===== 原创爆款模块：去AI味清洗 + AI味检测 =====
      pushYiJingLog('[去AI味] 开始内容清洗...');
      pushYiJingLog(`[去AI味] 输入文本长度: ${(norm || '').replace(/\s+/g, '').length} 字`);
      pushYiJingLog('[去AI味] 正在调用 AI 模型进行深度去味改写...');

      let antiAiPolished = '';
      let antiAiSuccess = false;
      let antiAiPolishingResult: Awaited<ReturnType<typeof polishTextForAntiAi>> | null = null;
      try {
        antiAiPolishingResult = await polishTextForAntiAi(
          norm,
          {
            apiKey,
            onLog: (msg) => pushYiJingLog(`[去AI味] ${msg}`),
            onChunk: (chunk) => {
              antiAiPolished = chunk;
            },
            outputLanguage,
          },
          apiKey,
          { provider }
        );
        antiAiSuccess = antiAiPolishingResult.success;

        const polishedLen = (antiAiPolished || '').replace(/\s+/g, '').length;
        pushYiJingLog(`[去AI味] AI 返回结果长度: ${polishedLen} 字`);

        if (antiAiPolished.trim() && polishedLen > 0) {
          // 禁止删除 CTA！保留原文 CTA 完整性
          let cleanedPolish = antiAiPolished.trim();

          // 检查去 AI 味后文末是否还有 CTA，如果没有则添加保留的 CTA
          let hasCtaInResult = false;
          for (const pattern of ctaPatterns) {
            if (pattern.test(cleanedPolish)) {
              hasCtaInResult = true;
              break;
            }
          }

          // 如果保留了 CTA 但去 AI 味后丢失了，则添加回来
          if (savedCta && !hasCtaInResult) {
            cleanedPolish = cleanedPolish.trim() + '\n\n' + savedCta;
            pushYiJingLog('[去AI味] 已补充保留的末尾 CTA');
          }

          if (!/[。！？.!?]$/.test(cleanedPolish.trim())) {
            cleanedPolish = cleanedPolish.trim() + '。';
          }

          const cleanedLen = (cleanedPolish || '').replace(/\s+/g, '').length;
          pushYiJingLog(`[去AI味] 清理残留后长度: ${cleanedLen} 字`);

          norm = cleanedPolish;
          setYiJingMergedOutput(norm);
          setGeneratedContents((prev) => {
            const next = [...prev];
            const hit = next.findIndex((x) => x.topic === sel[0].title);
            if (hit >= 0) {
              next[hit] = { ...next[hit], content: norm };
            }
            return next;
          });
          pushYiJingLog('[去AI味] ✅ 清洗完成');
          antiAiSuccess = true;
        } else {
          pushYiJingLog('[去AI味] ⚠️ 清洗返回为空，保留合并结果');
        }
      } catch (e: any) {
        pushYiJingLog(`[去AI味] ❌ 清洗失败: ${e?.message || e}`);
      }

      // AI 味检测
      pushYiJingLog('[AI检测] 开始检测内容 AI 味...');
      setYiJingIsRunningAiDetection(true);
      try {
        const detection = detectAiFeatures(norm);
        setYiJingAiDetection(detection);
        pushYiJingLog(`[AI检测] 完成 - AI 味等级: ${detection.level === 'weak' ? '弱' : detection.level === 'medium' ? '中' : '强'} (${detection.score}分)`);
        if (detection.issues.length > 0) {
          detection.issues.slice(0, 3).forEach(issue => {
            pushYiJingLog(`[AI检测] 问题: ${issue}`);
          });
        }
        if (antiAiSuccess) {
          const polishingResult = antiAiPolishingResultRef;
          if (polishingResult?.isEffective) {
            pushYiJingLog('[AI检测] ✅ 验证通过：AI 去味清洗已成功执行');
          } else {
            pushYiJingLog('[AI检测] ⚠️ 验证通过但口语词添加较少，建议再次清洗');
          }
        }
        if (detection.level === 'strong') {
          pushYiJingLog('[AI检测] ⚠️ AI 味过强，建议点击"重新去AI味"按钮再次清洗');
          toast.warning('AI 味检测为"强"，建议继续清洗', 5000);
        }
      } catch (e: any) {
        pushYiJingLog(`[AI检测] 检测失败: ${e?.message || e}`);
      } finally {
        setYiJingIsRunningAiDetection(false);
      }
      // ===== 去AI味清洗结束 =====

      toast.success('已合并并写入右侧编辑器');
      try {
        const historyKey = getHistoryKeyForSubMode(niche, getParallelHistorySubModeId());
        if (norm.length > 200) {
          saveHistory('generator', historyKey, norm, { topic: sel[0].title, input: inputVal });
        }
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      pushYiJingLog(`合并失败：${e?.message || e}`);
      toast.error(e?.message || '合并失败');
      setBatchProgress({ current: 0, total: 1, hint: '合并失败' });
    } finally {
      setYiJingPipelineBusy(false);
      setTimeout(() => setBatchProgress(null), 1000);
    }
  }, [
    apiKey,
    provider,
    niche,
    scriptLengthMode,
    storyLanguage,
    storyDuration,
    topics,
    yiJingSegDrafts,
    parallelTotalTargetChars,
    collectStreamText,
    pushYiJingLog,
    normalizeYiJingBody,
    toast,
    inputVal,
    getParallelHistorySubModeId,
    mindfulLanguage,
  ]);

  // 原创爆款模块：重新执行去AI味清洗
  const handleYiJingReAntiAiPolish = useCallback(async () => {
    if (!yiJingMergedOutput.trim()) {
      toast.warning('没有可清洗的内容');
      return;
    }
    if (!apiKey?.trim()) {
      toast.warning('请先配置 API Key');
      return;
    }

    pushYiJingLog('[去AI味] 手动重新执行去AI味清洗...');
    setYiJingIsPolishing(true);
    setYiJingAiDetection(null);

    // 计算输出语言
    const isEnRevenge = niche === NicheType.STORY_REVENGE && storyLanguage === StoryLanguage.ENGLISH;
    const isMindfulEnglish = niche === NicheType.MINDFUL_PSYCHOLOGY;
    const effectiveLang = mindfulLanguage || 'en';
    const outputLanguage: 'zh' | 'en' = isMindfulEnglish ? (effectiveLang === 'en' ? 'en' : 'zh') : (isEnRevenge ? 'en' : 'zh');

    try {
      let antiAiPolished = '';

      await polishTextForAntiAi(
        yiJingMergedOutput,
        {
          apiKey,
          onLog: (msg) => pushYiJingLog(`[去AI味] ${msg}`),
          onChunk: (chunk) => {
            antiAiPolished = chunk;
          },
          outputLanguage,
        },
        apiKey,
        { provider }
      );

      if (antiAiPolished.trim()) {
        // 禁止删除 CTA！保留原文 CTA 完整性
        let cleanedPolish = antiAiPolished.trim();

        if (!/[。！？.!?]$/.test(cleanedPolish.trim())) {
          cleanedPolish = cleanedPolish.trim() + '。';
        }

        setYiJingMergedOutput(cleanedPolish);
        pushYiJingLog('[去AI味] 重新清洗完成');

        // 重新检测
        const detection = detectAiFeatures(cleanedPolish);
        setYiJingAiDetection(detection);
        pushYiJingLog(`[AI检测] 重新检测完成 - AI 味等级: ${detection.level === 'weak' ? '弱' : detection.level === 'medium' ? '中' : '强'} (${detection.score}分)`);

        if (detection.level === 'strong') {
          toast.warning('AI 味仍为"强"，可继续清洗', 5000);
        } else {
          toast.success(`AI 味检测为"${detection.level === 'weak' ? '弱' : '中'}"，清洗效果良好`, 5000);
        }
      } else {
        pushYiJingLog('[去AI味] 清洗返回为空');
        toast.warning('清洗返回为空，保留原内容');
      }
    } catch (e: any) {
      pushYiJingLog(`[去AI味] 重新清洗失败: ${e?.message || e}`);
      toast.error('重新清洗失败');
    } finally {
      setYiJingIsPolishing(false);
    }
  }, [yiJingMergedOutput, apiKey, provider, pushYiJingLog, toast]);

  const handleYiJingAutoPilot = useCallback(async (): Promise<boolean> => {
    const sel = topics.filter((t) => t.selected);
    if (!sel.length) {
      toast.warning('请先选择至少一个选题');
      return false;
    }
    if (!apiKey?.trim()) {
      toast.error('请先配置 API Key');
      return false;
    }

    initializeGemini(apiKey, { provider });
    setYiJingPipelineBusy(true);

    const plannedSeg = computeParallelSegmentCount(
      parallelTotalTargetChars,
      scriptLengthMode === 'SHORT' ? 'SHORT' : 'LONG'
    );
    const bundle = getParallelPipelineBundle(
      niche,
      scriptLengthMode,
      storyLanguage,
      storyDuration,
      NICHES[niche],
      mindfulLanguage
    );
    const outlineLead = getParallelOutlineLeadContext();

    const initRuns: ParallelTopicRun[] = sel.map((t) => ({
      id: t.id,
      title: t.title,
      status: 'pending',
      stage: 'idle',
      progress: 0,
      logs: [],
    }));
    setParallelTopicRuns(initRuns);
    setActiveParallelTopicId(sel[0].id);

    const totalSteps = sel.length * (plannedSeg + 2);
    let finishedSteps = 0;
    const bumpGlobalProgress = (hint: string) => {
      finishedSteps += 1;
      setBatchProgress({
        current: Math.min(totalSteps, finishedSteps),
        total: totalSteps,
        hint,
      });
    };

    const appendRunLog = (topicId: string, line: string) => {
      setParallelTopicRuns((prev) =>
        prev.map((r) =>
          r.id === topicId
            ? { ...r, logs: [...r.logs.slice(-39), `[${new Date().toLocaleTimeString()}] ${line}`] }
            : r
        )
      );
    };

    const patchRun = (topicId: string, patch: Partial<ParallelTopicRun>) => {
      setParallelTopicRuns((prev) => prev.map((r) => (r.id === topicId ? { ...r, ...patch } : r)));
    };

    setBatchProgress({ current: 0, total: totalSteps, hint: `并行处理 ${sel.length} 个选题…` });
    pushYiJingLog(`全自动并行：共 ${sel.length} 个选题`);

    const runSingleTopic = async (topic: Topic): Promise<{ ok: boolean; content?: string }> => {
      const topicTitle = topic.title;
      patchRun(topic.id, { status: 'running', stage: 'outline', progress: 5 });
      appendRunLog(topic.id, '开始：生成大纲');

      try {
        const raw = await collectStreamText(
          buildParallelOutlineUserPrompt(
            topicTitle,
            plannedSeg,
            parallelTotalTargetChars,
            bundle.outline,
            outlineLead || undefined
          ),
          bundle.outlineSystem,
          6144
        );
        const parsedRaw = parseYiJingOutline(raw);
        if (!parsedRaw) throw new Error('大纲 JSON 解析失败');
        const parsed = rescaleChapterWordCounts(parsedRaw, parallelTotalTargetChars);
        const n = parsed.chapters.length;

        patchRun(topic.id, { stage: 'segments', progress: 18 });
        appendRunLog(topic.id, `大纲完成：${n} 章`);
        bumpGlobalProgress(`已完成大纲：${topicTitle}`);

        const config = NICHES[niche];
        const sys = config.systemInstruction;
        const segDone = new Set<number>();
        const results = await Promise.all(
          parsed.chapters.map(async (ch, idx) => {
            let local = '';
            const user = buildParallelSegmentUserPrompt(
              {
                topic: topicTitle,
                coreTheme: parsed.core_theme,
                logicLine: parsed.logic_line,
                chapter: ch,
                chapterIndex: idx,
                totalChapters: n,
              },
              bundle.segment
            );
            try {
              await streamContentGeneration(user, sys, (c) => {
                local += c;
              }, undefined, { maxTokens: 12288 });
              segDone.add(idx);
              const p = 18 + Math.round((segDone.size / n) * 58);
              patchRun(topic.id, { progress: p });
              bumpGlobalProgress(`分段 ${segDone.size}/${n}：${topicTitle}`);
              return local;
            } catch (err: any) {
              segDone.add(idx);
              bumpGlobalProgress(`分段异常（已跳过）：${topicTitle}`);
              appendRunLog(topic.id, `第 ${idx + 1} 段失败：${err?.message || err}`);
              return `[本段生成失败：${err?.message || err}]`;
            }
          })
        );

        patchRun(topic.id, { stage: 'merge', progress: 82 });
        appendRunLog(topic.id, '分段完成：开始合并');

        const combined = results.join('\n\n');
        const mindfulLongAp =
          niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG';
        const merged = await collectStreamText(
          buildParallelMergeUserPrompt(topicTitle, combined, parallelTotalTargetChars, {
            ...bundle.merge,
            englishMergedCharClamp: mindfulLongAp
              ? mindfulMergeCharClamp(parallelTotalTargetChars)
              : undefined,
            mindfulLanguage,
          }),
          bundle.mergeSystem,
          32768
        );
        let norm = normalizeYiJingBody(merged);
        if (mindfulLongAp) {
          norm = truncateMindfulScript(norm, MINDFUL_EN_SCRIPT_CHARS_MAX);
        }

        patchRun(topic.id, { status: 'done', stage: 'done', progress: 100 });
        appendRunLog(topic.id, `完成：终稿约 ${norm.length} 字`);
        bumpGlobalProgress(`已完成：${topicTitle}`);

        try {
          const historyKey = getHistoryKeyForSubMode(niche, getParallelHistorySubModeId());
          if (norm.length > 200) {
            saveHistory('generator', historyKey, norm, { topic: topicTitle, input: inputVal });
          }
        } catch {
          /* ignore */
        }

        return { ok: true, content: norm };
      } catch (e: any) {
        patchRun(topic.id, { status: 'error', stage: 'error' });
        appendRunLog(topic.id, `失败：${e?.message || e}`);
        return { ok: false };
      }
    };

    try {
      const settled = await Promise.all(sel.map((t) => runSingleTopic(t)));
      const okCount = settled.filter((x) => x.ok).length;

      const nextContents = sel.map((t, i) => ({
        topic: t.title,
        content: settled[i]?.content || generatedContents.find((g) => g.topic === t.title)?.content || '',
      }));
      setGeneratedContents(nextContents);
      setViewIndex(0);

      const firstOkIdx = settled.findIndex((x) => x.ok && x.content);
      if (firstOkIdx >= 0) {
        const firstTopic = sel[firstOkIdx];
        setActiveParallelTopicId(firstTopic.id);
        setYiJingMergedOutput(settled[firstOkIdx].content || '');
      }

      if (okCount > 0) {
        const firstOkParsed = settled.find((x) => x.ok && x.content)?.content;
        if (firstOkParsed) {
          setYiJingOutlineText('（多选并行模式：各选题独立大纲已完成，详见题签日志）');
          setYiJingOutlineViewMode('readable');
        }
      }

      if (okCount === sel.length) {
        pushYiJingLog(`全流程完成：${okCount}/${sel.length} 个选题成功`);
        toast.success(`分段并行完成：${okCount}/${sel.length}`);
        return true;
      }

      pushYiJingLog(`部分完成：${okCount}/${sel.length} 个选题成功`);
      toast.warning(`部分完成：${okCount}/${sel.length}`);
      return okCount > 0;
    } finally {
      setYiJingPipelineBusy(false);
    }
  }, [
    apiKey,
    provider,
    niche,
    scriptLengthMode,
    storyLanguage,
    storyDuration,
    topics,
    parallelTotalTargetChars,
    collectStreamText,
    pushYiJingLog,
    normalizeYiJingBody,
    toast,
    inputVal,
    getParallelOutlineLeadContext,
    getParallelHistorySubModeId,
    generatedContents,
    mindfulLanguage,
  ]);

  const handleBatchGenerate = async () => {
    if (!apiKey || !apiKey.trim()) {
        toast.error("请先在设置中输入您的 API Key。");
        return;
    }
    
    const selectedTopics = topics.filter(t => t.selected);
    if (selectedTopics.length === 0) {
        toast.warning("请至少选择一個选题。");
        return;
    }

    // ⚠️ 关键：在生成开始时就锁定当前子模式配置，避免生成过程中子模式被切换导致历史记录 key 错误
    const currentSubModeConfig = getCurrentSubModeConfig();
    const currentNiche = niche;
    
    // 根据当前赛道获取对应的子模式ID（更可靠的方式）
    let currentSubModeId: string;
    if (niche === NicheType.TCM_METAPHYSICS) {
      currentSubModeId = tcmSubMode;
    } else if (niche === NicheType.FINANCE_CRYPTO) {
      currentSubModeId = financeSubMode;
    } else if (niche === NicheType.STORY_REVENGE) {
      currentSubModeId = revengeSubMode;
    } else if (niche === NicheType.GENERAL_VIRAL) {
      currentSubModeId = newsSubMode;
    } else {
      currentSubModeId =
        getStaticGeneratorSubModeId(niche) || currentSubModeConfig?.id || '';
    }
    
    console.log('[Generator] 锁定子模式配置:', { 
      niche: currentNiche, 
      submodeId: currentSubModeId,
      configId: currentSubModeConfig?.id 
    });

    // Initialize API
    initializeGemini(apiKey, { provider });

    /** 全赛道统一：大纲 → 分段并行 → 合并（复仇改编模式仍走原流式路径） */
    const useGlobalParallelPipeline =
      !(niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION);

    if (useGlobalParallelPipeline) {
      setStatus(GenerationStatus.WRITING);
      setGeneratedContents(selectedTopics.map((t) => ({ topic: t.title, content: '' })));
      setViewIndex(0);
      setActiveIndices(new Set(selectedTopics.map((_, i) => i)));

      const runItems: ParallelTopicRun[] = selectedTopics.map((t) => ({
        id: t.id,
        title: t.title,
        status: 'pending',
        stage: 'idle',
        progress: 0,
        logs: [],
      }));
      setParallelTopicRuns(runItems);
      setActiveParallelTopicId(selectedTopics[0]?.id || null);
      setParallelTopicOutlineMap({});
      setParallelTopicSegDraftsMap({});
      setParallelTopicSegStatusMap({});

      const plannedPerTopic =
        computeParallelSegmentCount(
          parallelTotalTargetChars,
          scriptLengthMode === 'SHORT' ? 'SHORT' : 'LONG'
        ) + 2;
      const totalSteps = Math.max(1, plannedPerTopic * selectedTopics.length);
      let doneSteps = 0;
      const bumpProgress = (hint?: string) => {
        doneSteps += 1;
        setBatchProgress({
          current: Math.min(doneSteps, totalSteps),
          total: totalSteps,
          hint,
        });
      };
      const patchRun = (topicId: string, patch: Partial<ParallelTopicRun>) => {
        setParallelTopicRuns((prev) => prev.map((r) => (r.id === topicId ? { ...r, ...patch } : r)));
      };
      const appendRunLog = (topicId: string, line: string) => {
        setParallelTopicRuns((prev) =>
          prev.map((r) =>
            r.id === topicId
              ? { ...r, logs: [...r.logs.slice(-39), `[${new Date().toLocaleTimeString()}] ${line}`] }
              : r
          )
        );
      };

      const runPipelineForTopic = async (topic: Topic, idx: number) => {
        const topicTitle = topic.title;
        patchRun(topic.id, { status: 'running', stage: 'outline', progress: 8 });
        appendRunLog(topic.id, '开始生成大纲');
        try {
          const bundle = getParallelPipelineBundle(
            niche,
            scriptLengthMode,
            storyLanguage,
            storyDuration,
            NICHES[niche],
            mindfulLanguage
          );
          const outlineLead = getParallelOutlineLeadContext();

          // 1) 大纲
          const plannedSeg = computeParallelSegmentCount(
            parallelTotalTargetChars,
            scriptLengthMode === 'SHORT' ? 'SHORT' : 'LONG'
          );
          const raw = await collectStreamText(
            buildParallelOutlineUserPrompt(
              topicTitle,
              plannedSeg,
              parallelTotalTargetChars,
              bundle.outline,
              outlineLead || undefined
            ),
            bundle.outlineSystem,
            6144
          );
          const parsedRaw = parseYiJingOutline(raw);
          if (!parsedRaw) throw new Error('大纲解析失败');
          const parsed = rescaleChapterWordCounts(parsedRaw, parallelTotalTargetChars);
          setParallelTopicOutlineMap((prev) => ({
            ...prev,
            [topic.id]: outlinePayloadToJsonPretty(parsed),
          }));
          setParallelTopicSegDraftsMap((prev) => ({ ...prev, [topic.id]: Array(parsed.chapters.length).fill('') }));
          setParallelTopicSegStatusMap((prev) => ({ ...prev, [topic.id]: Array(parsed.chapters.length).fill('idle') }));
          patchRun(topic.id, { stage: 'segments', progress: 20 });
          appendRunLog(topic.id, `大纲完成：${parsed.chapters.length} 章`);
          pushYiJingLog(`【${topicTitle.slice(0, 18)}】大纲完成：${parsed.chapters.length} 章`);
          bumpProgress(`「${topicTitle.slice(0, 16)}${topicTitle.length > 16 ? '…' : ''}」大纲完成`);

          // 2) 分段并行
          const config = NICHES[niche];
          const sys = config.systemInstruction;
          const segResults = await Promise.all(
            parsed.chapters.map(async (ch, chIdx) => {
              const user = buildParallelSegmentUserPrompt(
                {
                  topic: topicTitle,
                  coreTheme: parsed.core_theme,
                  logicLine: parsed.logic_line,
                  chapter: ch,
                  chapterIndex: chIdx,
                  totalChapters: parsed.chapters.length,
                },
                bundle.segment
              );
              let local = '';
              setParallelTopicSegStatusMap((prev) => {
                const arr = [...(prev[topic.id] || [])];
                if (arr.length <= chIdx) arr[chIdx] = 'idle';
                arr[chIdx] = 'running';
                return { ...prev, [topic.id]: arr };
              });
              await streamContentGeneration(user, sys, (c) => {
                local += c;
                setParallelTopicSegDraftsMap((prev) => {
                  const arr = [...(prev[topic.id] || [])];
                  arr[chIdx] = local;
                  return { ...prev, [topic.id]: arr };
                });
                setGeneratedContents((prev) => {
                  const next = [...prev];
                  const partial = next[idx]?.content || '';
                  next[idx] = {
                    ...next[idx],
                    content: `${partial.slice(0, 1200)}\n\n[正在并行生成各分段…已完成第 ${chIdx + 1}/${parsed.chapters.length} 段]`,
                  };
                  return next;
                });
              }, undefined, { maxTokens: 12288 });
              setParallelTopicSegStatusMap((prev) => {
                const arr = [...(prev[topic.id] || [])];
                arr[chIdx] = 'done';
                return { ...prev, [topic.id]: arr };
              });
              appendRunLog(topic.id, `第 ${chIdx + 1}/${parsed.chapters.length} 段完成（约 ${local.length} 字）`);
              const per = 20 + Math.round(((chIdx + 1) / parsed.chapters.length) * 56);
              patchRun(topic.id, { progress: per });
              return local;
            })
          );
          patchRun(topic.id, { stage: 'merge', progress: 80 });
          appendRunLog(topic.id, '分段完成：开始合并');
          pushYiJingLog(`【${topicTitle.slice(0, 18)}】分段完成，开始合并`);
          bumpProgress(`「${topicTitle.slice(0, 16)}${topicTitle.length > 16 ? '…' : ''}」分段完成`);

          // 3) 合并
          const combined = segResults.join('\n\n');
          const mindfulLong =
            niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG';
          const merged = await collectStreamText(
            buildParallelMergeUserPrompt(topicTitle, combined, parallelTotalTargetChars, {
              ...bundle.merge,
              englishMergedCharClamp: mindfulLong
                ? mindfulMergeCharClamp(parallelTotalTargetChars)
                : undefined,
              mindfulLanguage,
            }),
            bundle.mergeSystem,
            32768
          );
          let finalText = normalizeYiJingBody(merged);
          if (mindfulLong) {
            finalText = truncateMindfulScript(finalText, MINDFUL_EN_SCRIPT_CHARS_MAX);
          }

          // 提取并保留文末 CTA（互动引导）
          const ctaPatterns = [
            // 英文 CTA - 更宽松的匹配
            /(If this resonated with you,?\s*(?:please\s+)?(?:like\s+and\s+subscribe|subscribe\s+to\s+my\s+channel)[^.]*(?:\.)?\s*)$/i,
            /(please\s+(?:like\s+and\s+)?subscribe\s+to\s+my\s+channel[^.]*(?:\.)?\s*)$/i,
            /(like\s+and\s+subscribe\s+to\s+my\s+channel[^.]*(?:\.)?\s*)$/i,
            /(subscribe\s+to\s+my\s+channel[^.]*(?:\.)?\s*)$/i,
            // 中文 CTA - 使用捕获组
            /((?:请点赞|喜欢本文|如果觉得有收获)[^\n。！？]{0,100}[。！？]?)\s*$/i,
            /((?:评论区|留言区|留言)[^\n。！？]{0,100}[。！？]?)\s*$/i,
            /((?:咱们下期|下期继续)[^\n。！？]{0,100}[。！？]?)\s*$/i,
            /((?:转发给|分享给)[^\n。！？]{0,100}[。！？]?)\s*$/i,
          ];
          let savedCta = '';
          for (const pattern of ctaPatterns) {
            const match = finalText.match(pattern);
            if (match && match[1]) {
              savedCta = match[1].trim();
              break;
            }
          }

          // 如果没有匹配到 CTA，尝试从末尾提取最后一段
          if (!savedCta && finalText.length > 50) {
            const lastParagraph = finalText.split(/\n\n+/).filter(p => p.trim()).pop() || '';
            const ctaKeywords = ['like and subscribe', 'subscribe to my channel', 'please like', 'if this resonated', '请点赞', '喜欢本文', '如果觉得'];
            for (const keyword of ctaKeywords) {
              if (lastParagraph.toLowerCase().includes(keyword.toLowerCase())) {
                savedCta = lastParagraph.trim();
                break;
              }
            }
          }

          // ===== 自动生成流程：去AI味清洗 + AI味检测 =====
          pushYiJingLog('[去AI味] 开始深度去味改写（替换+添加）...');
          pushYiJingLog(`[去AI味] 输入文本长度: ${(finalText || '').replace(/\s+/g, '').length} 字` + (savedCta ? '（已保留末尾CTA）' : ''));

          // 计算输出语言
          const isEnRevengeBatch = niche === NicheType.STORY_REVENGE && storyLanguage === StoryLanguage.ENGLISH;
          const isMindfulEnglishBatch = niche === NicheType.MINDFUL_PSYCHOLOGY;
          const effectiveLangBatch = mindfulLanguage || 'en';
          const outputLanguageBatch: 'zh' | 'en' = isMindfulEnglishBatch ? (effectiveLangBatch === 'en' ? 'en' : 'zh') : (isEnRevengeBatch ? 'en' : 'zh');

          let antiAiPolished = '';
          let antiAiSuccess = false;
          let antiAiPolishingResult: Awaited<ReturnType<typeof polishTextForAntiAi>> | null = null;
          try {
            antiAiPolishingResult = await polishTextForAntiAi(
              finalText,
              {
                apiKey,
                onLog: (msg) => pushYiJingLog(`[去AI味] ${msg}`),
                onChunk: (chunk) => {
                  antiAiPolished = chunk;
                },
                outputLanguage: outputLanguageBatch,
              },
              apiKey,
              { provider }
            );
            antiAiSuccess = antiAiPolishingResult.success;

            const polishedLen = (antiAiPolished || '').replace(/\s+/g, '').length;
            pushYiJingLog(`[去AI味] AI 返回结果长度: ${polishedLen} 字`);

            if (antiAiPolished.trim() && polishedLen > 0) {
              // 禁止删除 CTA！保留原文 CTA 完整性
              let cleanedPolish = antiAiPolished.trim();

              // 检查去 AI 味后文末是否还有 CTA，如果没有则添加保留的 CTA
              let hasCtaInResult = false;
              for (const pattern of ctaPatterns) {
                if (pattern.test(cleanedPolish)) {
                  hasCtaInResult = true;
                  break;
                }
              }
              if (savedCta && !hasCtaInResult) {
                cleanedPolish = cleanedPolish.trim() + '\n\n' + savedCta;
                pushYiJingLog('[去AI味] 已补充保留的末尾 CTA');
              }

              if (!/[。！？.!?]$/.test(cleanedPolish.trim())) {
                cleanedPolish = cleanedPolish.trim() + '。';
              }

              const cleanedLen = (cleanedPolish || '').replace(/\s+/g, '').length;
              pushYiJingLog(`[去AI味] 清理残留后长度: ${cleanedLen} 字`);

              finalText = cleanedPolish;
              pushYiJingLog('[去AI味] ✅ 清洗完成');
              antiAiSuccess = true;
            } else {
              pushYiJingLog('[去AI味] ⚠️ 清洗返回为空，保留合并结果');
            }
          } catch (e: any) {
            pushYiJingLog(`[去AI味] ❌ 清洗失败: ${e?.message || e}`);
          }

          // AI 味检测
          pushYiJingLog('[AI检测] 开始检测内容 AI 味...');
          setYiJingIsRunningAiDetection(true);
          try {
            const detection = detectAiFeatures(finalText);
            setYiJingAiDetection(detection);
            pushYiJingLog(`[AI检测] 完成 - AI 味等级: ${detection.level === 'weak' ? '弱' : detection.level === 'medium' ? '中' : '强'} (${detection.score}分)`);
            if (detection.issues.length > 0) {
              detection.issues.slice(0, 3).forEach(issue => {
                pushYiJingLog(`[AI检测] 问题: ${issue}`);
              });
            }
            if (antiAiSuccess) {
              if (antiAiPolishingResult?.isEffective) {
                pushYiJingLog('[AI检测] ✅ 验证通过：AI 去味清洗已成功执行');
              } else {
                pushYiJingLog('[AI检测] ⚠️ 验证通过但口语词添加较少，建议再次清洗');
              }
            }
            if (detection.level === 'strong') {
              pushYiJingLog('[AI检测] ⚠️ AI 味过强，建议点击"重新去AI味"按钮再次清洗');
            }
          } catch (e: any) {
            pushYiJingLog(`[AI检测] 检测失败: ${e?.message || e}`);
          } finally {
            setYiJingIsRunningAiDetection(false);
          }
          // ===== 去AI味清洗结束 =====

          setGeneratedContents((prev) => {
            const next = [...prev];
            next[idx] = { topic: topicTitle, content: finalText };
            return next;
          });
          patchRun(topic.id, { status: 'done', stage: 'done', progress: 100 });
          appendRunLog(topic.id, `完成：终稿约 ${finalText.length} 字`);
          pushYiJingLog(`【${topicTitle.slice(0, 18)}】终稿完成，约 ${finalText.length} 字`);

          try {
            const historyKey = getHistoryKeyForSubMode(niche, getParallelHistorySubModeId());
            if (finalText.length > 200) {
              saveHistory('generator', historyKey, finalText, { topic: topicTitle, input: inputVal });
            }
          } catch {
            /* ignore */
          }
          bumpProgress(`「${topicTitle.slice(0, 16)}${topicTitle.length > 16 ? '…' : ''}」合并完成`);
        } catch (e: any) {
          setGeneratedContents((prev) => {
            const next = [...prev];
            next[idx] = {
              topic: topicTitle,
              content: `生成失败：${e?.message || e}`,
            };
            return next;
          });
          patchRun(topic.id, { status: 'error', stage: 'error' });
          appendRunLog(topic.id, `失败：${e?.message || e}`);
          pushYiJingLog(`【${topicTitle.slice(0, 18)}】失败：${e?.message || e}`);
          // 失败也推进步数，避免总进度卡住
          bumpProgress(`「${topicTitle.slice(0, 16)}${topicTitle.length > 16 ? '…' : ''}」失败`);
          bumpProgress();
          bumpProgress();
        } finally {
          setActiveIndices((prev) => {
            const next = new Set(prev);
            next.delete(idx);
            return next;
          });
        }
      };

      setBatchProgress({
        current: 0,
        total: totalSteps,
        hint: `分段并行流水线启动（${selectedTopics.length} 个选题）…`,
      });

      await Promise.all(selectedTopics.map((t, i) => runPipelineForTopic(t, i)));
      setStatus(GenerationStatus.COMPLETED);
      setBatchProgress({ current: totalSteps, total: totalSteps, hint: '全部选题已完成' });
      setActiveIndices(new Set());
      setTimeout(() => setBatchProgress(null), 1600);
      return;
    }

    setStatus(GenerationStatus.WRITING);
    // 清除错误消息（使用 Toast 后不再需要）
    
    // 1. Initialize empty content
    const initialContents = selectedTopics.map(t => ({ topic: t.title, content: '' }));
    setGeneratedContents(initialContents);
    
    // 2. Mark all as active initially
    const allIndices = new Set(selectedTopics.map((_, i) => i));
    setActiveIndices(allIndices);
    setViewIndex(0);

    const config = NICHES[niche];
    
    // 3. Process in Parallel (Promise.all)
    // We map each topic to a promise that handles its own generation lifecycle
    const sanitizeTtsScript = (raw: string) => {
        if (!raw) return '';
        let text = raw
            // 移除引擎输出标记和技术性说明
            .replace(/\[END OF ENGINE OUTPUT\]/gi, '')
            .replace(/\[ENGINE OUTPUT\]/gi, '')
            .replace(/\[END OF OUTPUT\]/gi, '')
            .replace(/\[OUTPUT\]/gi, '')
            .replace(/\[END\]/gi, '')
            .replace(/\[COMPLETE\]/gi, '')
            .replace(/\[FINISHED\]/gi, '')
            .replace(/\[DONE\]/gi, '')
            // 移除所有方括号内的技术性说明（但保留对话中的方括号内容，通过更精确的匹配）
            .replace(/\[[A-Z\s]+\]/gi, '') // 移除全大写的技术标记
            .replace(/\[[^\]]*ENGINE[^\]]*\]/gi, '')
            .replace(/\[[^\]]*OUTPUT[^\]]*\]/gi, '')
            .replace(/\[[^\]]*END[^\]]*\]/gi, '')
            .replace(/\[[^\]]*COMPLETE[^\]]*\]/gi, '')
            .replace(/\[[^\]]*FINISH[^\]]*\]/gi, '')
            // 移除Markdown标题标记
            .replace(/^\s*#{1,6}\s+/gm, '')
            // 移除列表标记
            .replace(/^\s*[-*+•]\s+/gm, '')
            .replace(/^\s*\d+\.\s+/gm, '')
            // 移除所有Markdown特殊符号
            .replace(/\*\*/g, '')
            .replace(/\*/g, '')
            .replace(/__/g, '')
            .replace(/_/g, '')
            .replace(/~~/g, '')
            .replace(/~/g, '')
            .replace(/`/g, '')
            .replace(/</g, '')
            .replace(/>/g, '')
            .replace(/\|/g, '')
            .replace(/\\/g, '')
            // 移除括号内的描述性内容（场景、动作描述）
            .replace(/（[^）]{0,100}?）/g, '')
            .replace(/\([^)]{0,100}?\)/g, '')
            .replace(/【[^】]{0,100}?】/g, '')
            .replace(/《[^》]{0,100}?》/g, '')
            // 移除整行的括号内容
            .replace(/^\s*\(.*?\)\s*$/gm, '')
            .replace(/^\s*（.*?）\s*$/gm, '')
            // 移除结尾标记
            .replace(/^\s*全[書书]完.*$/gm, '')
            .replace(/^\s*完[结結]語.*$/gm, '')
            .replace(/^\s*后记.*$/gm, '')
            .replace(/^\s*後記.*$/gm, '')
            .replace(/^\s*附註.*$/gm, '')
            .replace(/^\s*注釋.*$/gm, '')
            .replace(/^\s*旁白[:：].*$/gm, '')
            // 移除章节标题
            .replace(/^\s*第\s*[一二三四五六七八九十百千0-9]+\s*章[:：]?\s*.*$/gm, '')
            .replace(/^\s*第\s*[一二三四五六七八九十百千0-9]+\s*節[:：]?\s*.*$/gm, '')
            .replace(/^\s*Chapter\s*\d+[:：]?\s*.*$/gmi, '')
            .replace(/^\s*Part\s*\d+[:：]?\s*.*$/gmi, '')
            .replace(/^\s*章节[:：]?\s*.*$/gm, '')
            // 移除续写标记
            .replace(/^\s*Story Continuation.*$/gmi, '')
            .replace(/^\s*Target Language.*$/gmi, '')
            .replace(/^\s*Continuation.*$/gmi, '')
            .replace(/^\s*-----+\s*$/gm, '')
            .replace(/^\s*----+\s*$/gm, '')
            .replace(/-{4,}/g, '')
            // 移除技术性提示词和元信息
            .replace(/^\s*Note[:：].*$/gmi, '')
            .replace(/^\s*提示[:：].*$/gmi, '')
            .replace(/^\s*提示词[:：].*$/gmi, '')
            .replace(/^\s*Prompt[:：].*$/gmi, '')
            .replace(/^\s*Instruction[:：].*$/gmi, '')
            .replace(/^\s*指令[:：].*$/gmi, '')
            .replace(/^\s*要求[:：].*$/gmi, '')
            .replace(/^\s*Requirement[:：].*$/gmi, '')
            // 移除下课等收尾语（但保留"下期再见"）
            // 移除提前出现的收尾语（会在合适的时候重新添加）
            .replace(/^\s*下課.*$/gm, '')
            .replace(/^\s*散會.*$/gm, '')
            .replace(/^\s*散会.*$/gm, '')
            .replace(/^\s*今天的課到這裡.*$/gm, '')
            .replace(/^\s*今天的课到这里.*$/gm, '')
            .replace(/^\s*今天就到這.*$/gm, '')
            .replace(/^\s*今天就到这.*$/gm, '')
            .replace(/^\s*咱們下期再見.*$/gm, '')
            .replace(/^\s*咱们下期再见.*$/gm, '')
            .replace(/^\s*咱們下次.*$/gm, '')
            .replace(/^\s*咱们下次.*$/gm, '')
            .replace(/^\s*我们下期再见.*$/gm, '')
            .replace(/^\s*我們下期再見.*$/gm, '')
            .replace(/^\s*我们下期见.*$/gm, '')
            .replace(/^\s*我們下期見.*$/gm, '')
            .replace(/^\s*下期再見.*$/gm, '')
            .replace(/^\s*下期再见.*$/gm, '')
            .replace(/^\s*下期見.*$/gm, '')
            .replace(/^\s*下期见.*$/gm, '')
            // 移除行内提前收尾语（避免“下期再见”后又被强行续写导致突兀）
            .replace(/(?:我們|我们|咱們|咱们)?下期再見[！!。,.，]*/gi, '')
            .replace(/(?:我們|我们|咱們|咱们)?下期再见[！!。,.，]*/gi, '')
            .replace(/(?:我們|我们|咱們|咱们)?下期見[！!。,.，]*/gi, '')
            .replace(/(?:我們|我们|咱們|咱们)?下期见[！!。,.，]*/gi, '')
            .replace(/下課[！!。,.，]*/gi, '')
            .replace(/下课[！!。,.，]*/gi, '')
            .replace(/散會[！!。,.，]*/gi, '')
            .replace(/散会[！!。,.，]*/gi, '')
            .replace(/今天就到這[！!。,.，]*/gi, '')
            .replace(/今天就到这[！!。,.，]*/gi, '')
            .replace(/感謝收看/gi, '')
            .replace(/感谢收看/gi, '')
            .replace(/謝謝觀看/gi, '')
            .replace(/谢谢观看/gi, '')
            .replace(/各位再見/gi, '')
            .replace(/各位再见/gi, '')
            .replace(/感谢大家收看/gi, '')
            .replace(/感謝大家收看/gi, '')
            // 移除摘要标记
            .replace(/^\s*===\s*summary\s*===.*$/gmi, '')
            .replace(/^\s*summary[:：].*$/gmi, '')
            .replace(/^\s*总结[:：].*$/gmi, '')
            .replace(/^\s*总结[:：].*$/gmi, '')
            // 移除多余空行
            .replace(/\n\s*\n\s*\n+/g, '\n\n')
            .replace(/^\s+/gm, '')
            .replace(/\s+$/gm, '');
        return text.trim();
    };

    /** 强力移除第十节及以后（无换行密文同样有效：按全文匹配第一节「第十节」位置截断） */
    const stripBeyondLesson9 = (text: string): string => {
        if (!text) return text;
        let t = text.replace(/^#{1,6}\s+/gm, '').trim();
        const reLesson10 =
            /第\s*(?:1?0|十零|十[一二三四五六七八九]|[1-9][0-9])\s*(?:节课|堂课)[:：]/;
        const m = reLesson10.exec(t);
        if (m && m.index !== undefined) {
            return t.slice(0, m.index).trim();
        }
        return t;
    };

    /** 提前出现第九节标题 → 截断至该标题之前（配合字数限制，防止模型在字数不足时跳入第九节） */
    const stripPrematureLesson9 = (
        text: string,
        cleanedLen: number,
        minBefore: number
    ): string => {
        if (!text || cleanedLen >= minBefore) return text;
        const re = /第\s*(?:九|9)\s*(?:节课|堂课)[:：]/;
        const m = re.exec(text);
        if (m && m.index !== undefined) {
            return text.slice(0, m.index).replace(/\s+$/u, '');
        }
        return text;
    };

    /** 统计课程标题次数（全文匹配，不依赖换行；修复备用模型无换行导致节数为 0、无限续写） */
    const countLessonHeaders = (text: string): number => {
        const matches = text.match(/第\s*[一二三四五六七八九十0-9]+\s*(?:节课|堂课)[:：]/g);
        return matches ? matches.length : 0;
    };

    const getRequiredLessonCount = (currentNiche: NicheType, isShort: boolean, subModeId?: string): number => {
        if (currentNiche !== NicheType.TCM_METAPHYSICS || isShort) return 0;
        const sub = subModeId ?? tcmSubMode;
        if (sub === TcmSubModeId.TIME_TABOO) return 9;
        return 5;
    };

    const TCM_LESSON_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

    /** 未满 minBefore 字时，若已出现最后一节课标题，截断至该标题之前，避免过早第9节/第5节 */
    const stripPrematureFinalLessonHeader = (
        text: string,
        finalLessonNum: number,
        cleanedLen: number,
        minBefore: number
    ): string => {
        if (!text || cleanedLen >= minBefore || finalLessonNum < 1 || finalLessonNum > 9) return text;
        const cn = TCM_LESSON_CN[finalLessonNum - 1];
        const re = new RegExp(`第\\s*${cn}\\s*(?:节课|堂课)[:：]`);
        const m = re.exec(text);
        if (m && m.index !== undefined) {
            return text.slice(0, m.index).replace(/\s+$/u, '');
        }
        const reDigit = new RegExp(`第\\s*${finalLessonNum}\\s*(?:节课|堂课)[:：]`);
        const m2 = reDigit.exec(text);
        if (m2 && m2.index !== undefined) {
            return text.slice(0, m2.index).replace(/\s+$/u, '');
        }
        return text;
    };

    const removePrematureEndingsForTcm = (text: string, minLength: number): string => {
        if (!text) return text;
        const cleaned = sanitizeTtsScript(text);
        if (cleaned.length >= minLength) return text;
        return cleaned;
    };

    const stripPrematureEndingPhrases = (text: string): string => {
        if (!text) return text;
        return text
            .replace(/(?:我們|我们|咱們|咱们)?下期再見[！!。,.，]*/gi, '')
            .replace(/(?:我們|我们|咱們|咱们)?下期再见[！!。,.，]*/gi, '')
            .replace(/(?:我們|我们|咱們|咱们)?下期节目再见[！!。,.，]*/gi, '')
            .replace(/(?:我們|我们|咱們|咱们)?下期節目再見[！!。,.，]*/gi, '')
            .replace(/(?:我們|我们|咱們|咱们)?下期見[！!。,.，]*/gi, '')
            .replace(/(?:我們|我们|咱們|咱们)?下期见[！!。,.，]*/gi, '')
            .replace(/下課[！!。,.，]*/gi, '')
            .replace(/下课[！!。,.，]*/gi, '')
            .replace(/散會[！!。,.，]*/gi, '')
            .replace(/散会[！!。,.，]*/gi, '')
            .replace(/今天就到這[！!。,.，]*/gi, '')
            .replace(/今天就到这[！!。,.，]*/gi, '')
            .replace(/感谢收看[！!。,.，]*/gi, '')
            .replace(/感謝收看[！!。,.，]*/gi, '')
            .replace(/谢谢观看[！!。,.，]*/gi, '')
            .replace(/謝謝觀看[！!。,.，]*/gi, '')
            .replace(/这堂课讲到这里[^。！？]*[。！？]?/gi, '')
            .replace(/這堂課講到這裡[^。！？]*[。！？]?/gi, '')
            .replace(/今天这堂课讲到这里[^。！？]*[。！？]?/gi, '')
            .replace(/今天這堂課講到這裡[^。！？]*[。！？]?/gi, '')
            .replace(/节目再见[！!。,.，]*/gi, '')
            .replace(/節目再見[！!。,.，]*/gi, '');
    };

    /** 易经长文：致谢/收场后仍有大段正文 → 视为假收尾，截断至致谢前，避免「谢谢后再强行续写」的割裂感 */
    const stripPrematureZengThanksClosing = (text: string, minLen: number): string => {
        if (!text || minLen <= 0) return text;
        if (sanitizeTtsScript(text).length >= minLen) return text;
        const re =
            /谢谢大家|謝謝大家|感谢各位|感謝各位|谢谢你的耐心|謝謝你的耐心|感谢收听|感謝收聽|感谢观看|謝謝觀看|今天先聊|今天就先聊|咱们今天就说到|咱們今天就說到|刚才我说谢谢大家|剛才我說謝謝大家/g;
        let earliest = -1;
        let m: RegExpExecArray | null;
        const copy = text;
        re.lastIndex = 0;
        while ((m = re.exec(copy)) !== null) {
            const beforeLen = sanitizeTtsScript(copy.slice(0, m.index)).length;
            const afterMatch = copy.slice(m.index + m[0].length);
            const tailCompact = afterMatch.replace(/[\s\u3000\u00a0]/gu, '');
            const hasSubstantialTail = tailCompact.length > 35;
            if (beforeLen < minLen && hasSubstantialTail && m.index >= 120) {
                if (earliest < 0 || m.index < earliest) earliest = m.index;
            }
        }
        if (earliest >= 0) {
            return copy.slice(0, earliest).replace(/[\s\u3000\u00a0]+$/u, '');
        }
        return text;
    };

    const enforceTcmLessonLimit = (text: string): string => {
        if (!text) return text;
        // 强力移除第十节及以后所有内容（标题+正文）
        return stripBeyondLesson9(text);
    };

    /**
     * 语义截断：优先在段落边界（\n\n）截断，其次完整句末，其次单换行。
     * 确保截断不发生在句子中间，且在收尾语处停止。
     */
    const truncateToMax = (text: string, maxChars: number) => {
        if (text.length <= maxChars) return text;

        // 0. 如果文末有收尾语（说明不该截断），跳过截断直接返回原文
        // 用原始文本检测（sanitize 会删「咱们下期见」）
        const tail = text.slice(-2000);
        if (
            /咱们下期见|咱们下期再见|咱们下期继续拆|咱们下期再聊|咱们下期再|下期再见/.test(tail)
        ) {
            console.log(`[Generator] truncateToMax: detected closing phrase, skipping truncation`);
            return text;
        }

        const slice = text.slice(0, maxChars);

        // 1. 最近段落边界
        const lastDoubleNl = slice.lastIndexOf('\n\n');
        if (lastDoubleNl > maxChars * 0.6) {
            return text.slice(0, lastDoubleNl).trim();
        }

        // 2. 向前扩展最多 500 字符，找最近的完整句末（包括中文句号、感叹号、问号）
        const extended = text.slice(0, maxChars + 500);
        const sentenceEndings = ['。', '！', '？', '.', '!', '?'];
        let lastPunct = -1;
        for (const punct of sentenceEndings) {
            const idx = extended.lastIndexOf(punct);
            if (idx > lastPunct) lastPunct = idx;
        }
        if (lastPunct > maxChars * 0.75 && lastPunct < text.length) {
            return text.slice(0, lastPunct + 1).trim();
        }
        if (lastPunct > 0) {
            return text.slice(0, lastPunct + 1).trim();
        }

        // 3. 最近单换行
        const lastNl = slice.lastIndexOf('\n');
        if (lastNl > maxChars * 0.7) {
            return text.slice(0, lastNl).trim();
        }

        return slice.trim();
    };

    // 检查内容是否已经有收尾的迹象
    const hasEndingIndicators = (text: string): boolean => {
        const strictPatterns = [
            /下期再見/i,
            /下期再见/i,
            /下期节目再见/i,
            /下期節目再見/i,
            /下期見/i,
            /下期见/i,
            /咱們下期再見/i,
            /咱们下期再见/i,
            /咱們下期見/i,
            /咱们下期见/i,
            /我們下期再見/i,
            /我们下期再见/i,
            /我們下期見/i,
            /我们下期见/i,
            /我們下期节目再見/i,
            /我们下期节目再见/i,
            /下課/i,
            /下课/i,
            /散會/i,
            /散会/i,
            /今天的課到這裡/i,
            /今天的课到这里/i,
            /今天就到這/i,
            /今天就到这/i,
            /这堂课讲到这里/i,
            /這堂課講到這裡/i,
            /这节课讲到这里/i,
            /這節課講到這裡/i,
            /今天这堂课讲到这里/i,
            /今天這堂課講到這裡/i,
            /节目再见/i,
            /節目再見/i,
            /诸位乡亲.*再见/i,
            /諸位鄉親.*再見/i,
        ];
        if (strictPatterns.some((pattern) => pattern.test(text))) {
            return true;
        }
        // 仅在文末 2000 字范围内检测新闻人设收尾，避免正文「咱们下期继续分析」误判
        const tail = text.length <= 2000 ? text : text.slice(-2000);
        const newsTailClosingPatterns = [
            // 狭义：仅「下期」+ 继续/再 X
            /咱[們们]下期[，,、]?\s*继续/i,
            /咱[們们]下期[，,、]?\s*再[相见聊會会]/i,
            /下期[，,、]?\s*继续(撕|拆|聊)/i,
            /咱[們们]下期[，,、]?\s*(接着|再)(撕|拆)/i,
            // 广义：评论区引导 + 咱们下期见（组合模式，同时覆盖「评论区留言，咱们下期见」）
            /评论区[留说告诉].*咱[們们]下期/i,
            /咱[們们]下期[，,、]?\s*(见|聊|拆|撕|潜|唠)/i,
        ];
        return newsTailClosingPatterns.some((pattern) => pattern.test(tail));
    };

    /** 已达字数、收尾语、节数齐全 → 不再强制续写 */
    const shouldStopTcmContinuation = (text: string, requiredLessons: number): boolean => {
        if (requiredLessons <= 0) return false;
        const cleanedLen = sanitizeTtsScript(text).length;
        if (cleanedLen < TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES) return false;
        if (!hasEndingIndicators(text)) return false;
        if (countLessonHeaders(text) < requiredLessons) return false;
        return true;
    };

    /** 新闻终稿：扫描文末约 2000 字，找正式收尾语（含互动引导）。在原始文本上检测（sanitize 会删除收尾语） */
    const hasNewsFormalClosingInTail = (text: string): boolean => {
        const cleaned = text; // 不用 sanitizeTtsScript，因为 sanitize 会删「咱们下期见」
        if (cleaned.length < 80) return false;
        const t = cleaned.slice(-2000);
        if (/下期再见|下期再見/.test(t)) return true;
        if (/咱们下期见|咱們下期見|咱们下期再见|咱們下期再見/.test(t)) return true;
        if (/咱们下期继续拆/.test(t)) return true;
        if (/咱们下期再聊/.test(t)) return true;
        if (/咱们下期[，,、]?\s*继续撕/.test(t)) return true;
        if (/咱们下期再/.test(t)) return true;
        if ((/评论区|留言区|留言/.test(t) || /点赞|转发/.test(t)) && /下期/.test(t)) return true;
        return false;
    };

    /** 新闻/金融：找到收尾语「咱们下期见」等在文中的最后位置，截断其后所有内容，防止强制续写。在原始文本上检测 */
    const stripAfterClosingPhrase = (text: string): string => {
        const cleaned = text; // 不用 sanitizeTtsScript
        if (cleaned.length < 200) return text;

        // 从后往前扫描最后 2000 字，找「咱们下期见」等正式收尾语的最后位置
        const tail = cleaned.slice(-2000);
        const closingPatterns = [
            /咱们下期见/,
            /咱们下期再见/,
            /咱们下期继续拆/,
            /咱们下期再聊/,
            /咱们下期再/,
            /咱们下期[，,、]继续撕/,
            /下期再见/,
            /下期再見/,
        ];

        let lastClosingPos = -1;
        for (const pattern of closingPatterns) {
            const match = tail.match(pattern);
            if (match && match.index !== undefined) {
                const pos = cleaned.length - 2000 + match.index + match[0].length;
                if (pos > lastClosingPos) lastClosingPos = pos;
            }
        }

        // 收尾语在文末超过 30% 位置就截断（更激进保留）
        if (lastClosingPos > cleaned.length * 0.3) {
            // 截断到句末（找收尾语后面的句号/感叹号/问号）
            const afterClosing = cleaned.slice(lastClosingPos);
            const sentenceEndMatch = afterClosing.match(/[。！？.!?]/);
            if (sentenceEndMatch && sentenceEndMatch.index !== undefined) {
                lastClosingPos = lastClosingPos + sentenceEndMatch.index + 1;
            }
            const truncated = cleaned.slice(0, lastClosingPos).trim();
            if (truncated.length > 5000) {
                console.log(`[Generator] stripAfterClosingPhrase: stripped content after closing, kept ${truncated.length} chars`);
                return truncated;
            }
        }
        return text;
    };

    const getCtaKeyword = (topic: string) => {
        const keywordMap: Array<{ match: RegExp; word: string }> = [
            { match: /病|醫|療|藥|痛|癌|症|保健|養生/, word: '安康' },
            { match: /財|錢|富|貴|破財|投資|股|金|銀/, word: '聚財' },
            { match: /家|婚|夫妻|子女|父母|親|緣/, word: '家和' },
            { match: /風水|宅|屋|房|門|窗|床|擺件/, word: '鎮宅' },
            { match: /禁忌|避|凶|災|厄|煞/, word: '避厄' },
            { match: /運|命|改命|時辰|日子|黃曆/, word: '轉運' }
        ];

        for (const rule of keywordMap) {
            if (rule.match.test(topic)) return rule.word;
        }

        const fallback = ['平安', '安好', '吉祥', '順遂', '福安', '清心', '護身', '守正'];
        let hash = 0;
        for (let i = 0; i < topic.length; i += 1) {
            hash = (hash * 31 + topic.charCodeAt(i)) % fallback.length;
        }
        return fallback[hash] || '平安';
    };

    // 用于收集所有生成的内容，最后统一保存历史记录
    const generatedContentsMap = new Map<number, { topic: string; content: string }>();
    
    // 计算预期总长度（用于进度计算）
    const calculateExpectedTotalLength = () => {
        let totalExpected = 0;
        selectedTopics.forEach((topic) => {
            const shouldEnforceLength =
                niche === NicheType.TCM_METAPHYSICS ||
                niche === NicheType.FINANCE_CRYPTO ||
                niche === NicheType.PSYCHOLOGY ||
                niche === NicheType.PHILOSOPHY_WISDOM ||
                niche === NicheType.EMOTION_TABOO ||
                niche === NicheType.YI_JING_METAPHYSICS ||
                niche === NicheType.GENERAL_VIRAL ||
                niche === NicheType.MINDFUL_PSYCHOLOGY;
            const isRevengeShort =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.SHORT;
            const isRevengeLong =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.LONG;
            const isShortScript =
                (niche === NicheType.TCM_METAPHYSICS || niche === NicheType.FINANCE_CRYPTO || niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO || niche === NicheType.YI_JING_METAPHYSICS || niche === NicheType.MINDFUL_PSYCHOLOGY) &&
                scriptLengthMode === 'SHORT';
            
            if (shouldEnforceLength) {
                if (isShortScript) {
                    totalExpected +=
                        niche === NicheType.PSYCHOLOGY ||
                        niche === NicheType.PHILOSOPHY_WISDOM ||
                        niche === NicheType.EMOTION_TABOO ||
                        niche === NicheType.YI_JING_METAPHYSICS ||
                        niche === NicheType.MINDFUL_PSYCHOLOGY
                            ? 450
                            : 500;
                } else {
                    const minChars =
                        niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO
                            ? 3000
                            : niche === NicheType.MINDFUL_PSYCHOLOGY
                                ? Math.round(
                                    (MINDFUL_EN_SCRIPT_CHARS_MIN + MINDFUL_EN_SCRIPT_CHARS_MAX) / 2
                                  )
                                : niche === NicheType.YI_JING_METAPHYSICS
                                    ? MIN_YI_JING_SCRIPT_CHARS
                                    : niche === NicheType.TCM_METAPHYSICS
                                        ? MIN_TCM_SCRIPT_CHARS
                                        : niche === NicheType.FINANCE_CRYPTO
                                            ? MIN_FIN_SCRIPT_CHARS
                                            : MIN_NEWS_SCRIPT_CHARS;
                    totalExpected += minChars;
                }
            } else if (isRevengeShort) {
                totalExpected += REVENGE_SHORT_MIN;
            } else if (isRevengeLong) {
                const isEnglish = storyLanguage === StoryLanguage.ENGLISH;
                totalExpected += isEnglish ? REVENGE_LONG_EN_MIN : REVENGE_LONG_CN_MIN;
            } else {
                // 默认估算
                totalExpected += 3000;
            }
        });
        return totalExpected;
    };
    
    const expectedTotalLength = calculateExpectedTotalLength();
    
    // 初始化进度条：首包未到时避免长时间显示 0%
    setBatchProgress({ current: 3, total: 100 });
    
    const generationPromises = selectedTopics.map(async (topic, index) => {
        const mapIsShortScript =
            (niche === NicheType.TCM_METAPHYSICS ||
                niche === NicheType.FINANCE_CRYPTO ||
                niche === NicheType.PSYCHOLOGY ||
                niche === NicheType.PHILOSOPHY_WISDOM ||
                niche === NicheType.EMOTION_TABOO ||
                niche === NicheType.YI_JING_METAPHYSICS ||
                niche === NicheType.MINDFUL_PSYCHOLOGY) &&
            scriptLengthMode === 'SHORT';
        const tcmRequiredLessons = getRequiredLessonCount(
            niche,
            mapIsShortScript,
            currentSubModeId
        );

        // Determine the correct script template
        let scriptTemplate = config.scriptPromptTemplate;
        const subModeConfig = getCurrentSubModeConfig();

        if (subModeConfig && subModeConfig.scriptPromptTemplate) {
            scriptTemplate = subModeConfig.scriptPromptTemplate;
        } else if (niche === NicheType.PSYCHOLOGY) {
            scriptTemplate = scriptLengthMode === 'SHORT'
                ? PSYCHOLOGY_SHORT_SCRIPT_PROMPT
                : PSYCHOLOGY_LONG_SCRIPT_PROMPT;
        } else if (niche === NicheType.PHILOSOPHY_WISDOM) {
            scriptTemplate = scriptLengthMode === 'SHORT'
                ? PHILOSOPHY_SHORT_SCRIPT_PROMPT
                : PHILOSOPHY_LONG_SCRIPT_PROMPT;
        } else if (niche === NicheType.EMOTION_TABOO) {
            scriptTemplate = scriptLengthMode === 'SHORT'
                ? EMOTION_TABOO_SHORT_SCRIPT_PROMPT
                : EMOTION_TABOO_LONG_SCRIPT_PROMPT;
        } else if (niche === NicheType.YI_JING_METAPHYSICS) {
            scriptTemplate =
                scriptLengthMode === 'SHORT' ? YI_JING_SHORT_SCRIPT_PROMPT : config.scriptPromptTemplate;
        } else if (niche === NicheType.MINDFUL_PSYCHOLOGY) {
            // Mindful Psychology 使用自己的脚本模板
            scriptTemplate = MINDFUL_PSYCHOLOGY_SCRIPT_PROMPT;
        }

        // 清理选题标题：去掉【猫】【狗】【人】分类标签
        const cleanTopicTitle = topic.title.replace(/^\s*【[^】]*】\s*/, '').trim();
        // Use the selected script prompt
        let prompt = scriptTemplate.replace('{topic}', cleanTopicTitle);

        const macroRef =
          currentNiche === NicheType.GENERAL_VIRAL
            ? newsMacroNewsDigestRef.current
            : (currentNiche === NicheType.FINANCE_CRYPTO &&
               currentSubModeId === FinanceSubModeId.MACRO_WARNING &&
               scriptLengthMode === 'LONG'
              ? financeMacroNewsDigestRef.current
              : '');
        if (macroRef) {
          prompt =
            `${macroRef}\n\n---\n\n` +
            prompt +
            `\n\n【长文铁律】引子必须从上方「国际要闻投喂」中择取具体事实落笔（国家/人物/市场或机构），勿用与要闻列表无关的空泛开场。`;
        }

        // 中医玄学（时辰禁忌）脚本：统一注入当前UTC年份生肖锚，修复“2025蛇年”漂移
        if (niche === NicheType.TCM_METAPHYSICS && tcmSubMode === TcmSubModeId.TIME_TABOO) {
            const utcYear = getCurrentUtcYear();
            const zodiac = getChineseZodiac(utcYear);
            prompt += `\n\n【年份锚定规则（最高优先级）】\n- 若用户输入未明确年份，默认按${utcYear}年推演（${zodiac}年）。\n- 禁止输出${utcYear - 1}年或其他过期年份（如2025蛇年）作为当年。\n- 可以输出“${utcYear}${zodiac}年”这类自然表达，但禁止出现“UTC/系统时间/时间锚”字样。\n- 必须严格按9节课铁律框架分段推进，完整连贯，目标字数${MIN_TCM_SCRIPT_CHARS}-${MAX_TCM_SCRIPT_CHARS}（允许约±8%自然浮动）。`;
        }

        if (niche === NicheType.TCM_METAPHYSICS && scriptLengthMode !== 'SHORT') {
            const lastCn =
                tcmRequiredLessons > 0 && tcmRequiredLessons <= 9
                    ? TCM_LESSON_CN[tcmRequiredLessons - 1]
                    : '九';
            prompt += `\n\n【中医玄学长文节奏铁律（全子模式通用·最高优先级）】
1. 以正文有效字数计：全文未满约 ${TCM_MIN_CHARS_BEFORE_FINAL_LESSON} 字前，禁止出现「第${lastCn}节课」或「第${lastCn}堂课」及其后的收束、总结、互动收尾段。
2. 未满 ${TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES} 字前，禁止使用任何节目收尾语（如下期再见、下期节目再见、下课、散会、今天就讲到这、节目再见、各位/诸位乡亲道别等）。
3. 仅当字数≥${TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES}、且已按顺序完成全部 ${tcmRequiredLessons} 节课、并在最后一节课内自然收束时，才输出收尾语；收尾语输出后即视为终稿，不要重复前文。
4. 目标总字数约 ${MIN_TCM_SCRIPT_CHARS}–${MAX_TCM_SCRIPT_CHARS} 字，优先充实第1–${Math.max(1, tcmRequiredLessons - 1)}节后再进入最后一节。`;
        }

        // 短视频脚本模式：覆盖为短视频文案指令（仅中医玄学/金融投资）
        if ((niche === NicheType.TCM_METAPHYSICS || niche === NicheType.FINANCE_CRYPTO) && scriptLengthMode === 'SHORT') {
            prompt = [
                '你是短视频脚本写手。请根据选题生成 500 字以内短视频文案。',
                '要求：语言风格必须与当前人设一致——中医玄学使用倪海厦风格，金融投资使用查理·芒格风格；保持强个性化表达；开头不要过多涉及具体时日时辰；围绕主题详细展开；一环接一环；适当使用排比句；包含“第一、第二、第三”等总结排列；必须有标点符号。',
                '结尾必须加入自然的引导转发评论语句（结合对应人设口吻），不要生硬。',
                '格式：不分段；不加标题；不加编号；不加 Markdown。',
                `选题：${topic.title}`
            ].join('\n');
        }

        // UTC 时间锚定（中医玄学仅时辰禁忌注入）
        if (shouldInjectUtcAnchor()) {
          prompt = `${getUtcAnchor()}\n\n${getUtcYearGuardrail()}\n\n${prompt}`;
        }

        if (niche === NicheType.YI_JING_METAPHYSICS && !mapIsShortScript) {
            prompt += `\n\n【易经命理长文字数铁律（最高优先级）】
1) 目标总字数约 ${MIN_YI_JING_SCRIPT_CHARS}–${MAX_YI_JING_SCRIPT_CHARS} 字；全文为一篇连贯口播，禁止输出「模块一」「第二节」等章节标记。
2) **未满 ${MIN_YI_JING_SCRIPT_CHARS} 字前**：禁止「谢谢大家」「谢谢各位」「感谢各位」「感谢收听」「今天先聊到这」及任何节目收场语；禁止互动引导后再接致谢、又接「话说到这份上还不能停」式二次开场。
3) **第五模块（结语）**仅在前四模块（痛点、易经理、故事、心法）已写透且有效字数已达约 ${MIN_YI_JING_SCRIPT_CHARS} 字后再写；**结语只写一轮**，写完即终稿，禁止自我否定式续写。`;
        }
        
        // Inject Story Variables if applicable
        if (niche === NicheType.STORY_REVENGE) {
             prompt = prompt.replace('{language}', storyLanguage);
             prompt = prompt.replace('{duration}', storyDuration);
        }
        
        // Determine system instruction based on mode
        let systemInstruction = config.systemInstruction;
        // For Adaptation mode, use ShadowWriter system prompt
        if (niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION) {
            // ShadowWriter system prompt with language injection
            systemInstruction = `**Role:** You are **ShadowWriter (暗影写手)**, an elite story architect who excels in human psychology, creative writing, and traffic algorithms. You specialize in transforming plain, fragmented, or reused source material into high-completion-rate, high-emotional-value "revenge thrillers" that pass originality checks.

**Core Objective:** Deeply "rewrite" and adapt input source material (Raw Text) to make it logically tighter, emotionally more extreme, and original enough to pass plagiarism checks, while preserving core satisfaction points.

🧠 **Core Competencies (核心能力)**

1. **Emotion Amplification (情绪增压 - Dopamine Engineering)**
   - **Hate-Building (仇恨铺垫)**: Must use detailed descriptions (micro-expressions, malicious language, unfair treatment) to make the villain extremely hateful.
   - **Cold Logic (冷静执行)**: The revenge process must showcase the protagonist's high intelligence or patience. No mindless venting. Emphasize "dimensional reduction" or "using others to kill."
   - **The Climax (核爆时刻)**: The ending must be devastating yet logical (Pro/Nuclear Revenge), delivering extreme satisfaction through karmic retribution.

2. **Humanization & De-duplication (拟人化与去重)**
   - **Anti-AI Tone**: Prohibit textbook-style flat narration. Use extensive colloquialisms, slang, inner monologues, and parenthetical asides.
   - **Show, Don't Tell**: Don't say "I'm angry." Show through actions and descriptions.
   - **Structure Shift**: Disrupt the original narrative structure. Use flashback or interleaving techniques to completely change the article's fingerprint.

**Output Language**: Use target language (${storyLanguage}) for all creative content.
**Output Format**: ONLY pure TTS voice content. NO technical markers, NO meta-commentary, NO explanations.`;
        }
        
        try {
            const layoutEligibleNiche =
                niche === NicheType.TCM_METAPHYSICS ||
                niche === NicheType.FINANCE_CRYPTO ||
                niche === NicheType.PSYCHOLOGY ||
                niche === NicheType.PHILOSOPHY_WISDOM ||
                niche === NicheType.EMOTION_TABOO ||
                niche === NicheType.YI_JING_METAPHYSICS ||
                niche === NicheType.MINDFUL_PSYCHOLOGY;

            const maybeNormalizeLayout = (content: string): string => {
                if (mapIsShortScript) return content;
                if (
                    !layoutEligibleNiche &&
                    !(niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.LONG)
                ) {
                    return content;
                }
                // 新闻赛道不需要段落规范化（且正则会误插「第X节课」标题）
                if (niche === NicheType.GENERAL_VIRAL) return content;
                if (content.length < 400) return content;
                if (!needsParagraphNormalization(content)) return content;
                return normalizeDenseChineseParagraphs(content);
            };

            let localContent = '';
                const appendChunk = (chunk: string) => {
                localContent += chunk;
                if (niche === NicheType.TCM_METAPHYSICS && scriptLengthMode !== 'SHORT') {
                    // 顺序：先 sanitize（清除 markdown/编号残留以防干扰匹配），再 strip 第10节及内容
                    let cleanedLen = sanitizeTtsScript(localContent).length;

                    // 仅 9 节课模式：提前第九节标题（字数不足时）
                    if (tcmRequiredLessons === 9) {
                        localContent = stripPrematureLesson9(
                            localContent,
                            cleanedLen,
                            TCM_MIN_CHARS_BEFORE_FINAL_LESSON
                        );
                        cleanedLen = sanitizeTtsScript(localContent).length;
                    }

                    // 强力移除第十节及以后所有内容（标题+正文）
                    localContent = stripBeyondLesson9(localContent);
                    cleanedLen = sanitizeTtsScript(localContent).length;

                    if (cleanedLen < TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES) {
                        localContent = stripPrematureEndingPhrases(localContent);
                    }
                }
                if (niche === NicheType.YI_JING_METAPHYSICS && !mapIsShortScript) {
                    let yjLen = sanitizeTtsScript(localContent).length;
                    if (yjLen < MIN_YI_JING_SCRIPT_CHARS) {
                        localContent = stripPrematureZengThanksClosing(
                            localContent,
                            MIN_YI_JING_SCRIPT_CHARS
                        );
                        yjLen = sanitizeTtsScript(localContent).length;
                        if (yjLen < MIN_YI_JING_SCRIPT_CHARS) {
                            localContent = stripPrematureEndingPhrases(localContent);
                        }
                    }
                }
                    setGeneratedContents(prev => {
                        const newArr = [...prev];
                        if (newArr[index]) {
                            newArr[index] = {
                                ...newArr[index],
                                content: localContent
                            };
                        }
                        
                        // 实时更新生成进度（基于所有文章的总内容长度）
                        if (expectedTotalLength > 0) {
                            // 计算所有已生成内容的总长度（包括当前正在生成的内容）
                            let totalGeneratedLength = 0;
                            newArr.forEach((item) => {
                                if (item && item.content) {
                                    totalGeneratedLength += item.content.length;
                                }
                            });
                            
                            // 最多 99%，完成时由 Promise.all 后设为 100（避免长期卡在 95%）
                            const progress = Math.min(
                              99,
                              Math.max(3, (totalGeneratedLength / expectedTotalLength) * 100)
                            );
                            setBatchProgress({ current: Math.round(progress), total: 100 });
                        }
                        
                        return newArr;
                    });
            };

            await streamContentGeneration(
                prompt,
                systemInstruction,
                appendChunk,
                undefined,
                {
                    maxTokens:
                        niche === NicheType.TCM_METAPHYSICS ||
                        (niche === NicheType.YI_JING_METAPHYSICS && !mapIsShortScript) ||
                        niche === NicheType.GENERAL_VIRAL ||
                        niche === NicheType.MINDFUL_PSYCHOLOGY
                            ? 24576
                            : 8192,
                }
            );
            localContent = maybeNormalizeLayout(localContent);

            const shouldEnforceLength =
                niche === NicheType.TCM_METAPHYSICS ||
                niche === NicheType.FINANCE_CRYPTO ||
                niche === NicheType.PSYCHOLOGY ||
                niche === NicheType.PHILOSOPHY_WISDOM ||
                niche === NicheType.EMOTION_TABOO ||
                niche === NicheType.YI_JING_METAPHYSICS ||
                niche === NicheType.GENERAL_VIRAL ||
                niche === NicheType.MINDFUL_PSYCHOLOGY;
            const isRevengeShort =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.SHORT;
            const isRevengeLong =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.LONG;
            const isShortScript =
                (niche === NicheType.TCM_METAPHYSICS || niche === NicheType.FINANCE_CRYPTO || niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO || niche === NicheType.YI_JING_METAPHYSICS || niche === NicheType.MINDFUL_PSYCHOLOGY) &&
                scriptLengthMode === 'SHORT';

            if (shouldEnforceLength) {
                let continueCount = 0;
                const minChars = isShortScript
                    ? (niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO || niche === NicheType.YI_JING_METAPHYSICS ? 400 : 300)
                    : niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO
                        ? 2000
                        : niche === NicheType.YI_JING_METAPHYSICS
                            ? MIN_YI_JING_SCRIPT_CHARS
                            : niche === NicheType.TCM_METAPHYSICS
                                ? MIN_TCM_SCRIPT_CHARS
                                : niche === NicheType.FINANCE_CRYPTO
                                    ? MIN_FIN_SCRIPT_CHARS
                                    : niche === NicheType.MINDFUL_PSYCHOLOGY
                                        ? MINDFUL_EN_SCRIPT_CHARS_MIN
                                        : MIN_NEWS_SCRIPT_CHARS;
                const maxChars = isShortScript
                    ? 500
                    : niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO
                        ? 3000
                        : niche === NicheType.YI_JING_METAPHYSICS
                            ? MAX_YI_JING_SCRIPT_CHARS
                            : niche === NicheType.TCM_METAPHYSICS
                                ? MAX_TCM_SCRIPT_CHARS
                                : niche === NicheType.FINANCE_CRYPTO
                                    ? MAX_FIN_SCRIPT_CHARS
                                    : niche === NicheType.MINDFUL_PSYCHOLOGY
                                        ? MINDFUL_EN_SCRIPT_CHARS_MAX
                                        : MAX_NEWS_SCRIPT_CHARS;
                
                // GENERAL_VIRAL（小美）：严格字数控制，禁止强制续写
                // 核心原则：正文未满 minC 前禁止出现收尾语 → 达标后才写收尾 → 收尾后停笔
                if (niche === NicheType.GENERAL_VIRAL) {
                    const minC = MIN_NEWS_SCRIPT_CHARS; // 7000
                    const maxC = MAX_NEWS_SCRIPT_CHARS; // 9000
                    let clLen = sanitizeTtsScript(localContent).length;

                    // Step 1: 严格字数控制循环
                    // 参考金融宏观逻辑：在 minC 达标前，如果检测到收尾语则剥离（视为无效），
                    // 如果字数不足则补足正文，禁止写收尾。
                    // 循环上限 3 次，防止无限循环。
                    let salvageRounds = 0;
                    while (clLen < minC && salvageRounds < 3) {
                        salvageRounds += 1;
                        // 如果有无效收尾语，先剥离
                        localContent = stripAfterClosingPhrase(localContent);
                        clLen = sanitizeTtsScript(localContent).length;
                        if (clLen >= minC) break;

                        console.log(`[Generator] News: body ${clLen} < ${minC}, salvage pass #${salvageRounds}`);
                        await streamContentGeneration(
                            [
                                `第一人称新闻口播（小美犀利视角），承接上文继续深入分析。**绝对禁止写任何收尾语、互动引导、点赞/留言要求、「咱们下期见」等。**继续展开正文分析。`,
                                `当前约${clLen}字，目标至少${minC}字。不要分段标记，不要分隔符。`,
                                '',
                                '【上文】',
                                localContent.slice(-3000)
                            ].join('\n'),
                            systemInstruction,
                            appendChunk,
                            undefined,
                            { maxTokens: 8192 }
                        );
                        localContent = maybeNormalizeLayout(localContent);
                        clLen = sanitizeTtsScript(localContent).length;
                    }

                    // 达标后，再次剥离可能提前出现的无效收尾语
                    localContent = stripAfterClosingPhrase(localContent);
                    clLen = sanitizeTtsScript(localContent).length;

                    // Step 2: 正文已达标（≥ minC），且没有正式收尾 → 写一次收尾
                    if (!hasNewsFormalClosingInTail(localContent)) {
                        console.log(`[Generator] News: body ${clLen} >= ${minC}, writing closing`);
                        await streamContentGeneration(
                            [
                                `上文约${clLen}字，已达目标字数。现在写最后收束段（约500–700字）：先升华点题形成终局判断，然后用互动引导（选一：「评论区聊聊」「点赞咱们下期见」「转发给朋友」），**文末必须以「咱们下期见」或「咱们下期继续拆」结尾；写完即停笔，绝对不得续写任何内容。**`,
                                '不要分段标记，不要分隔符。',
                                '',
                                '【上文】',
                                localContent.slice(-3000)
                            ].join('\n'),
                            systemInstruction,
                            appendChunk,
                            undefined,
                            { maxTokens: 4096 }
                        );
                        localContent = maybeNormalizeLayout(localContent);
                    }

                    // Step 3: 剥离收尾后可能又续写的内容（写完「咱们下期见」后又写了新内容）
                    localContent = stripAfterClosingPhrase(localContent);
                    clLen = sanitizeTtsScript(localContent).length;

                    // Step 4: 语义截断，确保不超过硬上限
                    if (clLen > maxC) {
                        localContent = truncateToMax(localContent, maxC);
                        console.log(`[Generator] News truncated to ${localContent.length} chars (semantic boundary)`);
                    }
                } else if (niche === NicheType.MINDFUL_PSYCHOLOGY) {
                    // 治愈心理学赛道：AI 已在各段末尾自行输出 CTA（根据语言），此处不做强制添加
                    // 仅做字数截断保护
                    if (localContent.length > maxChars) {
                        if (mindfulLanguage === 'zh') {
                            localContent = truncateToMax(localContent, maxChars);
                        } else {
                            localContent = truncateMindfulScript(localContent, maxChars);
                        }
                        console.log(`[Generator] Mindful Psychology (${mindfulLanguage}) truncated to ${localContent.length} chars`);
                    }
                } else {
                    // 需要续写的情况
                    const continuationLimit =
                        niche === NicheType.TCM_METAPHYSICS
                            ? MAX_TCM_SCRIPT_CONTINUATIONS
                            : niche === NicheType.YI_JING_METAPHYSICS && !isShortScript
                                ? MAX_YI_JING_SCRIPT_CONTINUATIONS
                                : MAX_SCRIPT_CONTINUATIONS;
                    const requiredLessonCount = getRequiredLessonCount(niche, isShortScript, currentSubModeId);
                    while (continueCount < continuationLimit) {
                        if (
                            niche === NicheType.TCM_METAPHYSICS &&
                            !isShortScript &&
                            shouldStopTcmContinuation(localContent, requiredLessonCount)
                        ) {
                            console.log('[Generator] 中医玄学：已达收尾与节数要求，停止续写');
                            if (expectedTotalLength > 0) {
                                setBatchProgress({ current: 99, total: 100 });
                            }
                            break;
                        }
                        const cleanedLoop = sanitizeTtsScript(localContent).length;
                        const lessonLoop = countLessonHeaders(localContent);
                        const tcmMinTarget =
                            niche === NicheType.TCM_METAPHYSICS && !isShortScript
                                ? MIN_TCM_SCRIPT_CHARS
                                : minChars;
                        const needMoreBody =
                            cleanedLoop < tcmMinTarget ||
                            (requiredLessonCount > 0 && lessonLoop < requiredLessonCount);
                        const tcmNeedClosingOnly =
                            niche === NicheType.TCM_METAPHYSICS &&
                            !isShortScript &&
                            cleanedLoop >= TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES &&
                            requiredLessonCount > 0 &&
                            lessonLoop >= requiredLessonCount &&
                            !hasEndingIndicators(localContent);
                        if (!needMoreBody && !tcmNeedClosingOnly) {
                            break;
                        }
                        // [GENERAL_VIRAL moved to dedicated block above — safe to remove]
                        
                        continueCount += 1;
                        const context = localContent.slice(-2000);
                        const currentLength = sanitizeTtsScript(localContent).length;
                        const remainingBudget = maxChars - currentLength;
                        const continuePrompt = [
                            isShortScript
                                ? (niche === NicheType.PSYCHOLOGY
                                    ? `请继续补充短视频文案，保持人间清醒型心理导师口吻，当前已写${currentLength}字，目标400-500字，要求结尾有互动引导，必须有标点。`
                                    : niche === NicheType.PHILOSOPHY_WISDOM
                                        ? `请继续补充短视频文案，保持禅意与觉醒心理学口吻，当前已写${currentLength}字，目标400-500字，结尾要有“结善缘/能量共振/留下一句xxx”的引导，必须有标点。`
                                        : niche === NicheType.EMOTION_TABOO
                                            ? `请继续补充短视频文案，保持禁忌张力与心理崩塌感，当前已写${currentLength}字，目标400-500字，结尾自然互动引导，必须有标点。`
                                            : niche === NicheType.YI_JING_METAPHYSICS
                                                ? `请继续补充短视频易经命理文案，保持曾仕强口吻（各位朋友、易经告诉我们、老祖宗说等），当前已写${currentLength}字，目标400-500字，结尾自然互动引导，必须有标点。`
                                                : `请继续补充短视频文案，保持一环接一环的节奏与排比句结构，加入“第一、第二、第三”的总结排列。当前已写${currentLength}字，目标300-500字，必须有标点。`)
                                : niche === NicheType.TCM_METAPHYSICS
                                    ? (tcmNeedClosingOnly
                                        ? `请承接上文，仅输出自然收尾段落（约150–400字）：感谢收听、叮嘱身体、引导点赞订阅转发与留言区互动。必须以「下期再见」「下期节目再见」「咱们下期再见」或「我们下期见」之一结尾。禁止重复已写正文、禁止从第一节重讲、禁止输出分隔符。当前已写${currentLength}字，节数已齐，只需收束。`
                                        : tcmSubMode === TcmSubModeId.TIME_TABOO
                                        ? `请严格继续生成中医玄学长文（时辰禁忌），必须遵循9节课铁律且按顺序推进，当前已写${currentLength}字，目标总字数${MIN_TCM_SCRIPT_CHARS}-${MAX_TCM_SCRIPT_CHARS}字。在未满约${TCM_MIN_CHARS_BEFORE_FINAL_LESSON}字前禁止出现「第九节课/第九堂课」及其正文；在未满${TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES}字前禁止任何节目收尾语（如下期再见/下课/节目再见/这堂课讲到这里等）。严禁第十节课及以上。满${TCM_MIN_CHARS_BEFORE_FINAL_LESSON}字后才可进入第9节；满${TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES}字且第9节写完后才可收尾。严禁输出第十节课及以上内容。不要改写已生成内容，不要跳节，不要输出分隔符。`
                                        : `请严格继续生成中医玄学长文（${tcmSubMode}），按课程化结构顺序推进（至少${requiredLessonCount}节课，建议5或7节），当前已写${currentLength}字，目标${MIN_TCM_SCRIPT_CHARS}-${MAX_TCM_SCRIPT_CHARS}字。在未满约${TCM_MIN_CHARS_BEFORE_FINAL_LESSON}字前禁止出现「第${TCM_LESSON_CN[requiredLessonCount - 1]}节课/堂课」及最后一节收束；在未满${TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES}字前禁止任何节目收尾语。满${TCM_MIN_CHARS_BEFORE_FINAL_LESSON}字后再写最后一节；满${TCM_MIN_CHARS_BEFORE_CLOSING_PHRASES}字并完成全部节次后才可收尾。不要改写已生成内容，不要跳节，不要输出分隔符。`)
                                    : niche === NicheType.YI_JING_METAPHYSICS
                                        ? (remainingBudget <= 400
                                            ? `请用200-400字完成收束：曾仕强式通透结语与金句，可自然引导评论互动。当前已写${currentLength}字，勿重复前文。`
                                            : `请严格续写曾仕强风格易经命理长文，从上文**最后一句**自然接下去，把曾氏5大模块里尚未写透的故事与心法继续写深写细；禁止输出章节标题或「模块一」等字样；禁止整段重复已写内容；**全文未满${MIN_YI_JING_SCRIPT_CHARS}字前禁止再写「谢谢大家」「感谢各位」等收场语**；若上文曾出现过早致谢且后面又自我纠正续写，当作无效，直接接前文伏笔续讲。保持「各位朋友」「易经告诉我们」「老祖宗说」等口吻。当前已写${currentLength}字，目标${MIN_YI_JING_SCRIPT_CHARS}-${MAX_YI_JING_SCRIPT_CHARS}字。`)
                                        : niche === NicheType.EMOTION_TABOO
                                        ? (remainingBudget <= 400
                                            ? `请用200-400字完成收束，确保故事完整闭合与反思结尾，保持禁忌张力与心理崩塌感。当前已写${currentLength}字，务必在字数上限内完成。`
                                            : `请继续续写，重点加强禁忌与羞耻的心理描写与含蓄暗示，确保故事完整闭合，目标2000-2500字，最多不超过3000字。当前已写${currentLength}字。`)
                                        : '请续写以下內容，保持原風格與第一人称口吻，不要重覆前文。',
                            ...(niche === NicheType.TCM_METAPHYSICS && tcmNeedClosingOnly
                                ? []
                                : (niche === NicheType.YI_JING_METAPHYSICS && !isShortScript) || niche === NicheType.FINANCE_CRYPTO
                                  ? []
                                  : ['不要出現「下課」「今天的課到這裡」等其他收尾語。']),
                            '直接续写正文，不要任何分隔符、标记或元信息。',
                            `目標字數：至少 ${minChars} 字，當前已${currentLength}字。`,
                            getUtcYearGuardrail(),
                            '',
                            '【上文】',
                            context
                        ].join('\n');

                        await streamContentGeneration(
                            continuePrompt,
                            systemInstruction,
                            appendChunk,
                            undefined,
                            {
                                maxTokens:
                                    niche === NicheType.TCM_METAPHYSICS ||
                                    (niche === NicheType.YI_JING_METAPHYSICS && !isShortScript)
                                        ? 12288
                                        : 8192,
                            }
                        );
                        localContent = maybeNormalizeLayout(localContent);

                        if (
                            sanitizeTtsScript(localContent).length >=
                            (niche === NicheType.TCM_METAPHYSICS && !isShortScript
                                ? MAX_TCM_SCRIPT_CHARS
                                : niche === NicheType.YI_JING_METAPHYSICS && !isShortScript
                                  ? MAX_YI_JING_SCRIPT_CHARS
                                  : maxChars)
                        ) {
                            break;
                        }
                        
                    }
                }

                let cleaned = sanitizeTtsScript(localContent);
                if (niche === NicheType.TCM_METAPHYSICS) {
                    const requiredLessonCount = getRequiredLessonCount(niche, isShortScript, currentSubModeId);
                    if (
                        !isShortScript &&
                        cleaned.length < MIN_TCM_SCRIPT_CHARS &&
                        !shouldStopTcmContinuation(localContent, requiredLessonCount)
                    ) {
                        let autoFillRounds = 0;
                        let lastLength = cleaned.length;
                        while (cleaned.length < MIN_TCM_SCRIPT_CHARS && autoFillRounds < 12) {
                            autoFillRounds += 1;
                            const tcmAutoPrompt = [
                                `继续无缝衔接上文，不要重复已输出内容。当前约${cleaned.length}字，必须补足到至少${MIN_TCM_SCRIPT_CHARS}字。`,
                                '必须保持“好了，我们开始上课。”后的课程化结构，课程标题与正文自然衔接，不生硬。',
                                getUtcYearGuardrail(),
                                '若已进入某节中间，则继续该节；若该节完成，再进入下一节。禁止跳节、禁止重写已完成内容。',
                                `严禁第十节课及以上（仅允许${tcmRequiredLessons}节课）。`,
                                '不要输出任何分隔符、说明文字、元信息。',
                                '',
                                '【上文】',
                                cleaned.slice(-2600)
                            ].join('\n');

                            await streamContentGeneration(
                                tcmAutoPrompt,
                                systemInstruction,
                                appendChunk,
                                undefined,
                                { maxTokens: 12288 }
                            );
                            localContent = maybeNormalizeLayout(localContent);

                            cleaned = sanitizeTtsScript(localContent);
                            cleaned = stripBeyondLesson9(cleaned);
                            localContent = cleaned;
                            if (cleaned.length <= lastLength + 120) {
                                // 进展过小，放宽约束再补一次
                                const rescuePrompt = [
                                    `继续补充正文，不要重复，直接承接当前段落写下去，直到总字数达到${MIN_TCM_SCRIPT_CHARS}字。严禁第十节课及以上（仅允许${tcmRequiredLessons}节课）。`,
                                    '保持第一人称与课堂口吻，禁止输出分隔符和注释。',
                                    getUtcYearGuardrail(),
                                    '',
                                    cleaned.slice(-2000)
                                ].join('\n');
                                await streamContentGeneration(
                                    rescuePrompt,
                                    systemInstruction,
                                    appendChunk,
                                    undefined,
                                    { maxTokens: 12288 }
                                );
                                localContent = maybeNormalizeLayout(localContent);
                                cleaned = sanitizeTtsScript(localContent);
                                cleaned = stripBeyondLesson9(cleaned);
                                localContent = cleaned;
                            }
                            lastLength = cleaned.length;
                        }
                    }

                    // 若节数不足，优先补足课程节数（已自然收尾且达标则跳过）
                    if (
                        !isShortScript &&
                        requiredLessonCount > 0 &&
                        !shouldStopTcmContinuation(localContent, requiredLessonCount)
                    ) {
                        let lessonFillRounds = 0;
                        let currentLessonCount = countLessonHeaders(cleaned);
                        while (currentLessonCount < requiredLessonCount && lessonFillRounds < 8) {
                            lessonFillRounds += 1;
                            const tcmLessonFillPrompt = [
                                `继续无缝衔接上文，确保补足到至少${requiredLessonCount}节课。当前已出现${currentLessonCount}节课。`,
                                '必须保持“好了，我们开始上课。”后的课程化结构，课程标题与正文自然衔接，不生硬。',
                                '若已进入某节中间，则继续该节；若该节完成，再进入下一节。禁止跳节、禁止重写已完成内容。',
                                `严禁第十节课及以上（仅允许${requiredLessonCount}节课）。`,
                                '不要输出任何分隔符、说明文字、元信息。',
                                '',
                                '【上文】',
                                cleaned.slice(-2600)
                            ].join('\n');

                            await streamContentGeneration(
                                tcmLessonFillPrompt,
                                systemInstruction,
                                appendChunk,
                                undefined,
                                { maxTokens: 12288 }
                            );
                            localContent = maybeNormalizeLayout(localContent);

                            cleaned = sanitizeTtsScript(localContent);
                            cleaned = stripBeyondLesson9(cleaned);
                            localContent = cleaned;
                            currentLessonCount = countLessonHeaders(cleaned);
                        }
                    }

                    const capped = truncateToMax(cleaned, Math.round(MAX_TCM_SCRIPT_CHARS * 1.1));
                    cleaned = sanitizeTtsScript(capped);
                    localContent = stripBeyondLesson9(cleaned);
                    if (isShortScript) {
                        localContent = truncateToMax(localContent, 500);
                    } else {
                        localContent = removePrematureEndingsForTcm(localContent, MIN_TCM_SCRIPT_CHARS);
                        const finalCleanLength = sanitizeTtsScript(localContent).length;
                        const lessonCount = countLessonHeaders(localContent);
                        if (finalCleanLength >= MIN_TCM_SCRIPT_CHARS && lessonCount >= requiredLessonCount) {
                            // Append CTA for TCM niche
                            const ctaWord = getCtaKeyword(topic.title);
                            const cta = `\n\n如果覺得今天倪師講的這番話對你有幫助，请動動你的手，點個讚、訂閱並轉發。如果你聽懂了，请在留言區打一個「${ctaWord}」或留一句祈福的話，為自己與家人積聚正向磁場。`;
                            localContent = `${localContent}${cta}`;
                        }
                    }
                    
                    // 保存到 Map 中，用于最后统一保存历史记录
                    generatedContentsMap.set(index, { topic: topic.title, content: localContent });
                    
                    setGeneratedContents(prev => {
                        const newArr = [...prev];
                        if (newArr[index]) {
                            newArr[index] = {
                                ...newArr[index],
                                content: localContent
                            };
                        }
                        return newArr;
                    });
                } else if (niche === NicheType.FINANCE_CRYPTO) {
                    // 金融宏观预警处理流程：
                    // 1. 先剥离可能提前出现的无效续写内容
                    // 2. 检测字数是否达标 → 未达标则补足正文
                    // 3. 检测是否有正式收尾 → 没有则写收尾
                    // 4. 再次剥离收尾后可能又续写的内容
                    // 5. 最后才做语义截断（保证收尾语不被截掉）
                    if (isShortScript) {
                        localContent = truncateToMax(localContent, 500);
                    } else {
                        // Step 1: 剥离提前的续写
                        localContent = stripAfterClosingPhrase(localContent);

                        // Step 2: 严格字数控制循环（在 minC 达标前禁止写收尾）
                        let finLen = sanitizeTtsScript(localContent).length;
                        let salvageRounds = 0;
                        while (finLen < minChars && salvageRounds < 3) {
                            salvageRounds += 1;
                            // 先剥离可能无效的收尾语
                            localContent = stripAfterClosingPhrase(localContent);
                            finLen = sanitizeTtsScript(localContent).length;
                            if (finLen >= minChars) break;

                            console.log(`[Generator] Finance: body ${finLen} < ${minChars}, salvage pass #${salvageRounds}`);
                            await streamContentGeneration(
                                [
                                    `第一人称查理·芒格口吻，承接上文继续深入分析。**绝对禁止写任何收尾语、互动引导、「咱们下期见」等。**继续展开正文分析。`,
                                    `当前约${finLen}字，目标至少${minChars}字。不要分段标记，不要分隔符。`,
                                getUtcYearGuardrail(),
                                    '',
                                    '【上文】',
                                    localContent.slice(-3000)
                                ].join('\n'),
                                systemInstruction,
                                appendChunk,
                                undefined,
                                { maxTokens: 4096 }
                            );
                            localContent = maybeNormalizeLayout(localContent);
                            finLen = sanitizeTtsScript(localContent).length;
                        }

                        // 达标后，再次剥离可能提前出现的无效收尾语
                        localContent = stripAfterClosingPhrase(localContent);
                        finLen = sanitizeTtsScript(localContent).length;

                        // Step 3: 正文已达标（≥ minChars），且没有正式收尾 → 写一次收尾
                        if (!hasNewsFormalClosingInTail(localContent)) {
                            console.log(`[Generator] Finance: body ${finLen} >= ${minChars}, writing closing`);
                            await streamContentGeneration(
                                [
                                    `上文约${finLen}字，已达目标字数。现在写最后收束段（约400–600字）：先用芒格式冷笑话或对华尔街的调侃收束，然后自然过渡到互动引导（选一：「评论区聊聊」「点赞咱们下期见」「转发给朋友」），**文末必须以「咱们下期见」或「咱们下期继续拆」结尾；出现这句话后立即停笔，绝对不得续写任何内容。**`,
                                    '不要分段标记，不要分隔符。',
                                    getUtcYearGuardrail(),
                                    '',
                                    '【上文】',
                                    localContent.slice(-3000)
                                ].join('\n'),
                                systemInstruction,
                                appendChunk,
                                undefined,
                                { maxTokens: 4096 }
                            );
                            localContent = maybeNormalizeLayout(localContent);
                        }

                        // Step 4: 剥离收尾后可能续写的内容（raw）
                        localContent = stripAfterClosingPhrase(localContent);

                        // Step 5: 语义截断（raw文本，在收尾检测之后）
                        const finFinalLen = localContent.length;
                        if (finFinalLen > maxChars) {
                            localContent = truncateToMax(localContent, maxChars);
                            console.log(`[Generator] Finance truncated to ${localContent.length} chars`);
                        }

                        // Step 6: sanitize（收尾语在 raw 中，sanitize 后会被删）
                        const beforeSanitize = localContent;
                        localContent = sanitizeTtsScript(localContent);

                        // Step 7: 剥离金融内容中不应该出现的"第X节课/第X堂课"等中医玄学模式
                        localContent = localContent
                            .replace(/第[一二三四五六七八九十百0-9]+节课[：:]/g, '')
                            .replace(/第[一二三四五六七八九十百0-9]+堂课[：:]/g, '')
                            .replace(/第[一二三四五六七八九十百0-9]+节[：:]/g, '')
                            .replace(/第一[层节模块][：:]/gi, '')
                            .replace(/第二[层节模块][：:]/gi, '')
                            .replace(/第三[层节模块][：:]/gi, '')
                            .replace(/第四[层节模块][：:]/gi, '')
                            .replace(/第五[层节模块][：:]/gi, '')
                            .replace(/第六[层节模块][：:]/gi, '')
                            .replace(/第七[层节模块][：:]/gi, '')
                            .replace(/第八[层节模块][：:]/gi, '')
                            .replace(/第九[层节模块][：:]/gi, '')
                            .replace(/\n\s*第[一二三四五六七八九十]+节课\n*/g, '\n')
                            .replace(/\n\s*第[一二三四五六七八九十]+堂课\n*/g, '\n');

                        // Step 8: sanitize 后收尾语被删，若内容达标则补上
                        // 达标条件：sanitize 后 ≥ minChars，且 sanitize 前文末有收尾语
                        const sanitizedLen = localContent.length;
                        if (
                            sanitizedLen >= minChars &&
                            hasNewsFormalClosingInTail(beforeSanitize) &&
                            !hasNewsFormalClosingInTail(localContent)
                        ) {
                            const closingOption = [
                                '各位朋友，这期内容如果让你觉得有点东西，别忘了点个赞，咱们下期见。',
                                '如果你也有想让我拆解的宏观热点，评论区留言，咱们下期见。',
                                '各位观众，你们觉得这局面谁才是真正的输家？评论区告诉我，咱们下期继续拆。',
                            ][Math.floor(Math.random() * 3)];
                            localContent = localContent.trimEnd() + '\n\n' + closingOption;
                            console.log(`[Generator] Finance: re-added closing phrase after sanitize (len=${localContent.length})`);
                        }
                    }
                    cleaned = localContent;

                    // 保存到 Map 中，用于最后统一保存历史记录
                    generatedContentsMap.set(index, { topic: topic.title, content: localContent });
                    
                    setGeneratedContents(prev => {
                        const newArr = [...prev];
                        if (newArr[index]) {
                            newArr[index] = {
                                ...newArr[index],
                                content: localContent
                            };
                        }
                        return newArr;
                    });
                } else if (niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO || niche === NicheType.YI_JING_METAPHYSICS || niche === NicheType.MINDFUL_PSYCHOLOGY) {
                    localContent = cleaned;
                    if (niche === NicheType.YI_JING_METAPHYSICS && !isShortScript) {
                        localContent = stripPrematureZengThanksClosing(
                            localContent,
                            MIN_YI_JING_SCRIPT_CHARS
                        );
                    }
                    if (localContent.length > maxChars + 200) {
                        localContent = truncateToMax(localContent, maxChars);
                    }

                    // 保存到 Map 中，用于最后统一保存历史记录
                    generatedContentsMap.set(index, { topic: topic.title, content: localContent });

                    setGeneratedContents(prev => {
                        const newArr = [...prev];
                        if (newArr[index]) {
                            newArr[index] = {
                                ...newArr[index],
                                content: localContent
                            };
                        }
                        return newArr;
                    });
                } else {
                    // 其他类型内容
                    if (cleaned.length > maxChars) {
                        localContent = truncateToMax(cleaned, maxChars);
                    } else {
                        localContent = cleaned;
                    }
                    
                    // 保存到 Map 中，用于最后统一保存历史记录
                    generatedContentsMap.set(index, { topic: topic.title, content: localContent });
                    
                    setGeneratedContents(prev => {
                        const newArr = [...prev];
                        if (newArr[index]) {
                            newArr[index] = {
                                ...newArr[index],
                                content: localContent
                            };
                        }
                        return newArr;
                    });
                }
            }

            if (isRevengeShort || isRevengeLong) {
                const isEnglish = storyLanguage === StoryLanguage.ENGLISH;
                const minChars = isRevengeLong
                    ? (isEnglish ? REVENGE_LONG_EN_MIN : REVENGE_LONG_CN_MIN)
                    : REVENGE_SHORT_MIN;
                const maxChars = isRevengeLong
                    ? (isEnglish ? REVENGE_LONG_EN_MAX : REVENGE_LONG_CN_MAX)
                    : REVENGE_SHORT_MAX;

                let continueCount = 0;
                let ended = false;
                const cnLongFlavor = isRevengeLong && !isEnglish
                    ? '加強細節描寫與氛圍鋪陳，融入禁忌、暗黑、情色擦邊元素，但保持故事合理與連貫。'
                    : '';
                while (localContent.length < minChars && continueCount < MAX_REVENGE_CONTINUATIONS) {
                    continueCount += 1;
                    const context = localContent.slice(-2500);
                    const continuePrompt = [
                        isEnglish
                            ? 'Continue the story in first person. Continue directly with a brief natural transition and move the plot forward. Do not repeat earlier content. Do not output separators or any meta text.'
                            : '请用第一人称续写故事。直接续写正文，使用简短自然的过渡句直接衔接情节，保持原有风格与节奏，不要重复前文。不要输出分隔符或任何元信息。',
                        cnLongFlavor,
                        isEnglish
                            ? `Requirement: total length at least ${minChars} characters; keep it within about ${maxChars} characters if possible.`
                            : `要求：全文至少 ${minChars} 字，盡量控制在 ${maxChars} 字左右。`,
                        '',
                        context
                    ].join('\n');

                    await streamContentGeneration(
                        continuePrompt,
                        systemInstruction,
                        appendChunk
                    );
                    localContent = maybeNormalizeLayout(localContent);
                }

                if (!ended) {
                    const endPrompt = [
                        isEnglish
                            ? 'Conclude the story now with a clear, final ending. Continue directly, keep first person, and do not add any headings, separators, or summaries. Make sure it reads like a complete short story.'
                            : '请用第一人称收尾。直接输出结尾正文，给出清楚结局，不要标题、分隔符或总结。',
                        cnLongFlavor,
                        '',
                        localContent.slice(-2500)
                    ].join('\n');

                    await streamContentGeneration(
                        endPrompt,
                        systemInstruction,
                        appendChunk
                    );
                    localContent = maybeNormalizeLayout(localContent);
                    ended = true;
                }

                let cleaned = sanitizeTtsScript(localContent);
                if (isEnglish) {
                    cleaned = cleaned
                        .split('\n')
                        .filter(line => !/[\u4e00-\u9fff]/.test(line))
                        .join('\n');
                }
                localContent = cleaned;

                // Generate a short Chinese summary and append
                let summaryText = '';
                await streamContentGeneration(
                    [
                        '请用中文输出 2-4 句的簡短故事总结，不得超過 200 字。',
                        '只输出总结内容，不要标题、不要符号、不要前言后语。',
                        '禁止输出例如「Suggested Title Options」或任何非故事总结內容。',
                        '',
                        localContent.slice(-3000)
                    ].join('\n'),
                    '你是中文摘要助手。',
                    (chunk) => {
                        summaryText += chunk;
                    }
                );

                summaryText = summaryText
                    .replace(/[\r\n]+/g, ' ')
                    .replace(/^\s+|\s+$/g, '')
                    .slice(0, 200);

                const finalContent = `${localContent}\n\n=== SUMMARY ===\n${summaryText}`;
                // 保存到 Map 中，用于最后统一保存历史记录
                generatedContentsMap.set(index, { topic: topic.title, content: finalContent });
                
                setGeneratedContents(prev => {
                    const newArr = [...prev];
                    if (newArr[index]) {
                        newArr[index] = {
                            ...newArr[index],
                            content: finalContent
                        };
                    }
                    return newArr;
                });
            }
        } catch (err: any) {
            console.error(`Error generating topic ${topic.title}`, err);
             setGeneratedContents(prev => {
                const newArr = [...prev];
                if (newArr[index]) {
                    const cleanMsg = parseErrorMessage(err);
                    newArr[index].content += `\n\n[系統提示: ${cleanMsg}]`;
                }
                return newArr;
            });
        } finally {
            // Remove from active indices when done
            setActiveIndices(prev => {
                const newSet = new Set(prev);
                newSet.delete(index);
                return newSet;
            });
            
            // 更新进度（基于实际生成内容）
            setBatchProgress(prev => {
                if (prev && expectedTotalLength > 0) {
                    // 计算所有已生成内容的总长度
                    let totalGeneratedLength = 0;
                    generatedContentsMap.forEach((item) => {
                        totalGeneratedLength += item.content.length;
                    });
                    
                    const progress = Math.min(
                      99,
                      Math.max(3, (totalGeneratedLength / expectedTotalLength) * 100)
                    );
                    return { current: Math.round(progress), total: 100 };
                }
                return prev;
            });
        }
    });

    // Wait for all to finish (or fail)
    await Promise.all(generationPromises);

    setStatus(GenerationStatus.COMPLETED);
    
    // 所有文章生成完成，进度条设为100%
    setBatchProgress({ current: 100, total: 100 });
    
    const totalBatch = selectedTopics.length;
    const successBatchCount = generatedContentsMap.size;
    const failBatchCount = totalBatch - successBatchCount;

    // 显示完成通知（成功数以 Map 为准，避免闭包中 generatedContents 过期导致误报）
    console.log('[Generator] 准备显示 Toast 通知:', {
      totalBatch,
      successBatchCount,
      failBatchCount,
      hasToast: !!toast,
      isExternal: toast === externalToast,
    });

    if (!externalToast) {
      console.error('[Generator] externalToast 未传入！无法显示 Toast 通知');
      return;
    }

    try {
      if (successBatchCount === totalBatch && totalBatch > 0) {
        if (typeof externalToast.success === 'function') {
          externalToast.success(`成功生成 ${successBatchCount} 篇文章！`, 8000);
        }
      } else if (successBatchCount === 0) {
        if (typeof externalToast.error === 'function') {
          externalToast.error(
            `生成失敗：${totalBatch} 篇均未完成，請查看正文中的系統提示或稍後重試（若頻繁出現請檢查 API 配額與網路）。`,
            10000
          );
        } else if (typeof externalToast.warning === 'function') {
          externalToast.warning(
            `生成失敗：${totalBatch} 篇均未完成，請查看正文中的系統提示。`,
            10000
          );
        }
      } else {
        if (typeof externalToast.warning === 'function') {
          externalToast.warning(
            `部分完成：成功 ${successBatchCount} 篇，失敗 ${failBatchCount} 篇，請檢查未完成篇的正文提示。`,
            10000
          );
        } else if (typeof externalToast.success === 'function') {
          externalToast.success(
            `完成 ${successBatchCount}/${totalBatch} 篇，其餘篇請查看正文錯誤提示。`,
            10000
          );
        }
      }
    } catch (error) {
      console.error('[Generator] 显示批量完成 Toast 失败:', error);
    }
    
    // 延迟清除进度条，让用户看到完成状态
    setTimeout(() => {
      setBatchProgress(null);
    }, 1000);
    
    // 保存历史记录：每篇文章单独保存，避免多篇文章合并导致错乱
    // ⚠️ 使用生成开始时锁定的子模式配置，而不是当前的配置（避免生成过程中子模式被切换）
    // ⚠️ 使用 Map 中收集的内容，而不是状态（避免状态更新延迟问题和重复保存）
    try {
      if (currentSubModeId && generatedContentsMap.size > 0) {
        const historyKey = getHistoryKeyForSubMode(currentNiche, currentSubModeId);
        
        console.log('[Generator] 开始保存历史记录:', { 
          niche: currentNiche, 
          submodeId: currentSubModeId, 
          historyKey, 
          articleCount: generatedContentsMap.size,
          articleTopics: Array.from(generatedContentsMap.values()).map(item => item.topic)
        });
        
        // 为每篇文章单独保存历史记录（只保存一次，避免重复）
        let savedCount = 0;
        const savedContentHashes = new Set<string>(); // 用于去重
        
        generatedContentsMap.forEach((item, index) => {
          if (item.content && item.content.trim() && item.content.length > 100) {
            // 生成内容哈希，用于去重
            const contentHash = `${item.topic}_${item.content.length}_${item.content.substring(0, 50)}`;
            
            // 检查是否已保存过相同内容
            if (savedContentHashes.has(contentHash)) {
              console.warn('[Generator] 跳过重复内容:', { 
                index,
                topic: item.topic 
              });
              return;
            }
            
            savedContentHashes.add(contentHash);
            
            console.log('[Generator] 保存单篇文章历史记录:', { 
              index,
              topic: item.topic, 
              contentLength: item.content.length,
              historyKey 
            });
            saveHistory('generator', historyKey, item.content, {
              topic: item.topic,
              input: inputVal,
            });
            savedCount++;
          } else {
            console.warn('[Generator] 跳过保存（内容无效）:', { 
              index,
              topic: item.topic, 
              contentLength: item.content?.length || 0 
            });
          }
        });
        
        console.log('[Generator] 历史记录已保存，共', savedCount, '篇文章（每篇单独保存），key:', historyKey);
      } else {
        console.warn('[Generator] 跳过保存历史记录:', { 
          currentSubModeId, 
          mapSize: generatedContentsMap.size 
        });
      }
    } catch (error) {
      console.error('[Generator] 保存历史记录失败:', error);
    }
  };

  const handleContinueGeneration = async () => {
      if (!apiKey || !apiKey.trim()) {
          toast.error("请先在设置中输入您的 API Key。");
          return;
      }
      
      if (generatedContents.length === 0) {
          toast.warning("沒有可续写的內容。");
          return;
      }

      // Initialize API
      const { initializeGemini } = await import('../services/geminiService');
      initializeGemini(apiKey, { provider });

      const currentContent = generatedContents[viewIndex];
      const subModeConfig = getCurrentSubModeConfig();

      if (!subModeConfig || !subModeConfig.continuePromptTemplate) {
          toast.warning("此模式不支持自动续写。");
          return;
      }

      // 1. Determine new topic title (e.g. "Story (Part 2)")
      const partMatch = currentContent.topic.match(/\(Part (\d+)\)$/);
      const nextPartNum = partMatch ? parseInt(partMatch[1]) + 1 : 2;
      const baseTitle = partMatch ? currentContent.topic.replace(/\(Part \d+\)$/, '').trim() : currentContent.topic;
      const newTitle = `${baseTitle} (Part ${nextPartNum})`;

      // 2. Prepare Context (Last 3000 chars)
      const context = currentContent.content.slice(-3000);

      // 3. Add new placeholder
      const newIndex = generatedContents.length;
      
      // Update UI state to include new topic
      const newTopic: Topic = { id: `topic-part-${Date.now()}`, title: newTitle, selected: true };
      setTopics(prev => [...prev, newTopic]);
      setGeneratedContents(prev => [...prev, { topic: newTitle, content: '' }]);
      
      setActiveIndices(prev => new Set(prev).add(newIndex));
      setViewIndex(newIndex);
      setStatus(GenerationStatus.WRITING);

      // 4. Build Prompt
      let prompt = subModeConfig.continuePromptTemplate
          .replace('{topic}', baseTitle)
          .replace('{previous_context}', context);
      
      if (niche === NicheType.STORY_REVENGE) {
          prompt = prompt.replace('{language}', storyLanguage);
      }

      // 5. Stream Generation
      try {
          const config = NICHES[niche];
          // Determine system instruction based on mode
          let systemInstruction = config.systemInstruction;
          // For Adaptation mode, use ShadowWriter system prompt
          if (niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION) {
              systemInstruction = `**Role:** You are **ShadowWriter (暗影写手)**, an elite story architect who excels in human psychology, creative writing, and traffic algorithms. You specialize in transforming plain, fragmented, or reused source material into high-completion-rate, high-emotional-value "revenge thrillers" that pass originality checks.

**Core Objective:** Deeply "rewrite" and adapt input source material (Raw Text) to make it logically tighter, emotionally more extreme, and original enough to pass plagiarism checks, while preserving core satisfaction points.

**Output Language**: Use target language (${storyLanguage}) for all creative content.
**Output Format**: ONLY pure TTS voice content. NO technical markers, NO meta-commentary, NO explanations.`;
          }
          
          await streamContentGeneration(
              prompt,
              systemInstruction,
              (chunk) => {
                  setGeneratedContents(prev => {
                      const newArr = [...prev];
                      if (newArr[newIndex]) {
                          newArr[newIndex] = {
                              ...newArr[newIndex],
                              content: newArr[newIndex].content + chunk
                          };
                      }
                      return newArr;
                  });
              }
          );
      } catch (err: any) {
           console.error(`Error generating continuation`, err);
           setGeneratedContents(prev => {
              const newArr = [...prev];
              const cleanMsg = parseErrorMessage(err);
              newArr[newIndex].content += `\n\n[续写失敗: ${cleanMsg}]`;
              return newArr;
          });
      } finally {
          setActiveIndices(prev => {
              const newSet = new Set(prev);
              newSet.delete(newIndex);
              return newSet;
          });
          setStatus(GenerationStatus.COMPLETED);
          
          // 保存续写后的历史记录
          try {
            const finalContent = generatedContents[newIndex];
            if (finalContent && finalContent.content && finalContent.content.trim() && finalContent.content.length > 100) {
              // 锁定当前子模式配置
              const currentNicheForHistory = niche;
              let currentSubModeIdForHistory: string;
              if (niche === NicheType.TCM_METAPHYSICS) {
                currentSubModeIdForHistory = tcmSubMode;
              } else if (niche === NicheType.FINANCE_CRYPTO) {
                currentSubModeIdForHistory = financeSubMode;
              } else if (niche === NicheType.STORY_REVENGE) {
                currentSubModeIdForHistory = revengeSubMode;
              } else if (niche === NicheType.GENERAL_VIRAL) {
                currentSubModeIdForHistory = newsSubMode;
              } else {
                const sid = getStaticGeneratorSubModeId(niche);
                if (!sid) return;
                currentSubModeIdForHistory = sid;
              }
              
              const historyKey = getHistoryKeyForSubMode(currentNicheForHistory, currentSubModeIdForHistory);
              console.log('[Generator] 续写完成，保存历史记录:', { 
                topic: finalContent.topic, 
                contentLength: finalContent.content.length,
                historyKey 
              });
              
              saveHistory('generator', historyKey, finalContent.content, {
                topic: finalContent.topic,
                input: inputVal,
              });
            }
          } catch (error) {
            console.error('[Generator] 续写后保存历史记录失败:', error);
          }
      }
  };

  const sanitizeFilename = (name: string) => {
      return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
  };

  const downloadAll = async () => {
      if (generatedContents.length === 0) return;
      const zip = new JSZip();
      generatedContents.forEach((item) => {
          if (item.content.trim()) {
              const fileName = `${sanitizeFilename(item.topic)}.txt`;
              zip.file(fileName, item.content);
          }
      });
      const content = await zip.generateAsync({ type: "blob" });
      const element = document.createElement("a");
      element.href = URL.createObjectURL(content);
      element.download = `ContentMaster_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
  };

  const handleCopy = (content: string, idx: number) => {
    navigator.clipboard.writeText(content);
    setCopiedId(idx);
    setTimeout(() => setCopiedId(null), 2000);
  };

  /** 从即時編輯器跳转：展开上方分镜区、填入当前文稿并立即开始流式生成分镜 */
  const openMindfulStoryboardFromEditor = () => {
    const item = generatedContents[viewIndex];
    const text = item?.content?.trim() ?? '';
    if (!text) {
      toast.warning('当前暂无文案，无法生成分镜');
      return;
    }
    setMindfulScript(text);
    setMindfulStoryboardExpanded(true);
    void handleGenerateStoryboard(text);
    window.setTimeout(() => {
      mindfulStoryboardAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  };

  const activeSubModes = getSubModesForRender();

  return (
    <div className="space-y-8">
      {/* 1. Select Niche */}
      <section>
        <h2 className="text-lg font-medium text-slate-300 mb-4 flex items-center gap-2">
          <span className="bg-emerald-600 w-6 h-6 rounded-full flex items-center justify-center text-xs text-white">1</span>
          选择赛道 (Select Track)
        </h2>
        <NicheSelector selectedNiche={niche} onSelect={setNiche} />
      </section>

      {/* 2. Planning Phase */}
      <section className="bg-slate-900/50 border border-slate-800 rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <h2 className="text-lg font-medium text-slate-300 flex items-center gap-2">
            <span className="bg-emerald-600 w-6 h-6 rounded-full flex items-center justify-center text-xs text-white shrink-0">
              2
            </span>
            策划选题 (Plan Topics)
          </h2>
          {(() => {
            const staticSid = getStaticGeneratorSubModeId(niche);
            if (!staticSid) return null;
            const hk = getHistoryKeyForSubMode(niche, staticSid);
            const cnt = getHistory('generator', hk).length;
            return (
              <button
                type="button"
                onClick={() => {
                  const records = getHistory('generator', hk);
                  if (records.length === 0) {
                    toast.info('暂无脚本历史记录，请先生成长文后再试');
                    return;
                  }
                  setHistoryRecords(records);
                  setPendingSubModeChange({ niche, submode: staticSid });
                  setShowHistorySelector(true);
                }}
                className="shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-600 bg-slate-800/80 hover:bg-slate-700/90 text-slate-300 text-sm transition-colors"
                title="查看并加载本赛道已保存的成稿脚本"
              >
                <History size={16} className="text-emerald-400" />
                脚本历史
                {cnt > 0 && (
                  <span className="text-[10px] font-mono text-emerald-400/90 bg-emerald-950/50 px-1.5 py-0.5 rounded">
                    {cnt}
                  </span>
                )}
              </button>
            );
          })()}
        </div>

        {/* 选题数量：默认 5，可选 10/15/20 或自定义 */}
        <div className="mb-6 rounded-xl border border-slate-700/70 bg-gradient-to-br from-slate-950/80 to-slate-900/40 p-4 md:p-5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-3">
            <label className="text-xs font-bold text-emerald-400 flex items-center gap-2">
              <ListOrdered size={16} className="text-emerald-500 shrink-0" />
              生成选题数量
            </label>
            <p className="text-[10px] text-slate-500 leading-relaxed max-w-md">
              默认每次生成 <span className="text-slate-400">5</span> 条；可快速选 10 / 15 / 20，或自定义 1–50 条（适用于全部赛道与子模式）。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {([5, 10, 15, 20] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setPlanTopicCountPreset(n);
                  setPlanTopicCountIsCustom(false);
                }}
                className={`min-w-[4.5rem] px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${
                  !planTopicCountIsCustom && planTopicCountPreset === n
                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-md shadow-emerald-900/30'
                    : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                }`}
              >
                {n} 条
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPlanTopicCountIsCustom(true)}
              className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${
                planTopicCountIsCustom
                  ? 'bg-emerald-600 text-white border-emerald-500 shadow-md shadow-emerald-900/30'
                  : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
              }`}
            >
              自定义
            </button>
            {planTopicCountIsCustom && (
              <div className="flex items-center gap-2 w-full sm:w-auto mt-1 sm:mt-0">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={planTopicCountCustomValue}
                  onChange={(e) => setPlanTopicCountCustomValue(e.target.value)}
                  className="w-24 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  aria-label="自定义选题数量"
                />
                <span className="text-xs text-slate-500 whitespace-nowrap">条（1–50）</span>
              </div>
            )}
          </div>
        </div>
        
        {/* Sub-Category Selection Grid */}
        {activeSubModes && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
                {Object.values(activeSubModes).map((mode) => {
                    const Icon = mode.icon;
                    let activeModeId;
                    let setActiveFunc: any;

                    if (niche === NicheType.TCM_METAPHYSICS) {
                        activeModeId = tcmSubMode;
                        setActiveFunc = setTcmSubMode;
                    } else if (niche === NicheType.FINANCE_CRYPTO) {
                        activeModeId = financeSubMode;
                        setActiveFunc = setFinanceSubMode;
                    } else if (niche === NicheType.STORY_REVENGE) {
                        activeModeId = revengeSubMode;
                        setActiveFunc = setRevengeSubMode;
                    } else if (niche === NicheType.GENERAL_VIRAL) {
                        activeModeId = newsSubMode;
                        setActiveFunc = setNewsSubMode;
                    }

                    const isSelected = activeModeId === mode.id;
                    
                    // 检查是否有历史记录
                    const historyKey = getHistoryKeyForSubMode(niche, mode.id);
                    const hasHistory = getHistory('generator', historyKey).length > 0;
                    
                    return (
                        <div
                            key={mode.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => handleSubModeChange(niche, mode.id, setActiveFunc)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                handleSubModeChange(niche, mode.id, setActiveFunc);
                              }
                            }}
                            className={`p-3 rounded-lg border text-left transition-all relative overflow-hidden cursor-pointer ${
                                isSelected 
                                ? 'bg-emerald-900/40 border-emerald-500 ring-1 ring-emerald-500' 
                                : 'bg-slate-800/40 border-slate-700 hover:bg-slate-800 hover:border-slate-600'
                            }`}
                        >
                            <div className="flex items-center gap-2 mb-2">
                                <Icon size={18} className={isSelected ? 'text-emerald-400' : 'text-slate-400'} />
                                <span className={`text-xs font-bold ${isSelected ? 'text-white' : 'text-slate-300'}`}>
                                    {mode.title.split('：')[0].split('(')[0]}
                                </span>
                                {hasHistory && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleManualHistoryClick(e, niche, mode.id)}
                                      className="ml-auto p-0.5 rounded hover:bg-slate-700/50 transition-colors"
                                      title="点击查看历史记录"
                                    >
                                        <History size={14} className="text-emerald-400 hover:text-emerald-300" />
                                    </button>
                                )}
                            </div>
                            <p className="text-[10px] text-slate-500 leading-tight">
                                {mode.subtitle}
                            </p>
                        </div>
                    );
                })}
            </div>
        )}

        {/* Revenge Story Specific Selectors */}
        {niche === NicheType.STORY_REVENGE && (
             <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6 animate-in fade-in duration-300 bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                <div className="space-y-2">
                    <label className="text-xs font-bold text-emerald-400 flex items-center gap-1">
                        <Globe size={14} /> 目標語言 (Target Language)
                    </label>
                    <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                         {Object.values(StoryLanguage).map((lang) => (
                             <button
                                key={lang}
                                onClick={() => setStoryLanguage(lang)}
                                className={`px-2 py-1.5 rounded text-xs border transition-all ${
                                    storyLanguage === lang 
                                    ? 'bg-emerald-600 text-white border-emerald-500' 
                                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                                }`}
                             >
                                 {lang}
                             </button>
                         ))}
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-bold text-emerald-400 flex items-center gap-1">
                        <Clock size={14} /> 故事時長 (Story Duration)
                    </label>
                    <div className="flex gap-2">
                         <button
                            onClick={() => setStoryDuration(StoryDuration.SHORT)}
                            className={`flex-1 px-3 py-1.5 rounded text-xs border transition-all ${
                                storyDuration === StoryDuration.SHORT 
                                ? 'bg-emerald-600 text-white border-emerald-500' 
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                            }`}
                         >
                             短篇 (15-30m)
                         </button>
                         <button
                            onClick={() => setStoryDuration(StoryDuration.LONG)}
                            className={`flex-1 px-3 py-1.5 rounded text-xs border transition-all ${
                                storyDuration === StoryDuration.LONG 
                                ? 'bg-emerald-600 text-white border-emerald-500' 
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                            }`}
                         >
                             長篇 (1hr+)
                         </button>
                    </div>
                </div>
             </div>
        )}

        {/* Script length selector for TCM/Finance */}
        {(niche === NicheType.TCM_METAPHYSICS || niche === NicheType.FINANCE_CRYPTO || niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO || niche === NicheType.YI_JING_METAPHYSICS || niche === NicheType.MINDFUL_PSYCHOLOGY) && (
          <div className="mb-6 animate-in fade-in duration-300 bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
            <label className="text-xs font-bold text-emerald-400 flex items-center gap-1 mb-2">
              <Clock size={14} /> 脚本时长
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setScriptLengthMode('LONG')}
                className={`flex-1 px-3 py-1.5 rounded text-xs border transition-all ${
                  scriptLengthMode === 'LONG'
                    ? 'bg-emerald-600 text-white border-emerald-500'
                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                }`}
              >
                长视频脚本（默认）
              </button>
              <button
                onClick={() => setScriptLengthMode('SHORT')}
                className={`flex-1 px-3 py-1.5 rounded text-xs border transition-all ${
                  scriptLengthMode === 'SHORT'
                    ? 'bg-emerald-600 text-white border-emerald-500'
                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                }`}
              >
                短视频脚本（≤500字）
              </button>
            </div>
            <p className="text-[10px] text-slate-500 mt-2">
              {niche === NicheType.PSYCHOLOGY
                ? '短视频：400-500字，反直觉开场，1-2个概念降维打击，结尾互动引导。'
                : niche === NicheType.PHILOSOPHY_WISDOM
                  ? '短视频：400-500字，开篇即高潮，痛点+底层逻辑+金句+引导，结尾结善缘。'
                  : niche === NicheType.EMOTION_TABOO
                    ? '短视频：400-500字，悬念开场+感官铺垫+心理拉扯+高光瞬间+反思引导。'
                    : niche === NicheType.YI_JING_METAPHYSICS
                      ? '长视频：默认「大纲→多段并行→合并润色」生成约万字口播，减轻单请求截断；仍沿用曾氏口吻；短视频：≤500字快讲。'
                      : niche === NicheType.MINDFUL_PSYCHOLOGY
                        ? `长视频：英文全文约 ${MINDFUL_EN_SCRIPT_CHARS_MIN}–${MINDFUL_EN_SCRIPT_CHARS_MAX} 字符（含空格）；分段并行工作台「目标全文字数」与此一致。短视频：≤500 字。`
                        : '短视频：在选题基础上详细展开，加入排比与总结排列，输出 500 字以内短视频文案。'}
            </p>
          </div>
        )}

        {/* 治愈心理学多语言输出选项 */}
        {niche === NicheType.MINDFUL_PSYCHOLOGY && (
          <div className="mb-6 animate-in fade-in duration-300 bg-gradient-to-r from-purple-900/30 to-indigo-900/30 p-4 rounded-xl border border-purple-500/30">
            <label className="text-xs font-bold text-purple-400 flex items-center gap-1 mb-3">
              <Globe size={14} /> 多语言全球化输出
            </label>
            <p className="text-[10px] text-slate-500 mb-3">选择输出语言，脚本和选题将根据目标语言和文化习惯调整风格</p>
            <div className="flex flex-wrap gap-2">
              {mindfulLanguages.map((lang) => (
                <button
                  key={lang.id}
                  onClick={() => setMindfulLanguage(lang.id)}
                  className={`px-3 py-1.5 rounded text-xs border transition-all flex items-center gap-1.5 ${
                    mindfulLanguage === lang.id
                      ? 'bg-purple-600 text-white border-purple-500'
                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-purple-500 hover:text-purple-300'
                  }`}
                >
                  <span>{lang.name}</span>
                  <span className="text-[9px] opacity-60">({lang.native})</span>
                </button>
              ))}
            </div>
            {mindfulLanguage !== 'en' && (
              <p className="text-[10px] text-purple-300/70 mt-2">
                当前选择：{mindfulLanguages.find(l => l.id === mindfulLanguage)?.name} 输出，脚本将据此文化习惯调整
              </p>
            )}
          </div>
        )}

        {/* Input Area (Conditional) */}
        {niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION ? (
          // Adaptation Mode: Large textarea input + output area
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-sm text-slate-400 font-medium">
                输入原文 (Source Text)
              </label>
              <textarea
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder="请在此粘貼需要改編的原文內容..."
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all resize-none custom-scrollbar h-[300px]"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm text-slate-400 font-medium flex items-center justify-between">
                <span>改編結果 (Adapted Content)</span>
                {adaptedContent && (
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(adaptedContent);
                    }}
                    className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                  >
                    <Copy size={12} /> 复制
                  </button>
                )}
              </label>
              <div className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 text-slate-200 h-[300px] overflow-y-auto whitespace-pre-wrap leading-relaxed custom-scrollbar">
                {adaptedContent || (isAdapting ? (
                  <div className="flex items-center gap-2 text-slate-500">
                    <Loader2 className="animate-spin" size={16} />
                    <span>正在改編中...</span>
                  </div>
                ) : (
                  <div className="text-slate-600 text-sm">改编后的内容将显示于此</div>
                ))}
                {isAdapting && adaptedContent && <span className="inline-block w-2 h-4 bg-emerald-500 ml-1 animate-pulse" />}
              </div>
            </div>
          </div>
        ) : (
          // Normal Mode: Original input layout
        <div className="flex flex-col md:flex-row gap-4 items-start">
            <div className="flex-1 w-full">
              {shouldShowInput() ? (
                    <div className="animate-in fade-in duration-300">
                        <label className="block text-sm text-slate-400 mb-2">
                             {getInputPlaceholder()}
                        </label>
                        <div className="relative">
                            <Calendar className="absolute left-3 top-3 text-slate-500 w-5 h-5" />
                            <input
                                type="text"
                                value={inputVal}
                                onChange={(e) => setInputVal(e.target.value)}
                                placeholder={getInputPlaceholder()}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-10 pr-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
                            />
                        </div>
                    </div>
                ) : (
                    <div className="p-4 bg-emerald-900/20 border border-emerald-500/30 rounded-lg flex items-center gap-3 animate-in fade-in duration-300">
                        <div className="bg-emerald-600/20 p-2 rounded-full">
                            <Sparkles className="text-emerald-400 w-5 h-5" />
                        </div>
                        <div>
                            <p className="text-emerald-200 text-sm font-medium">智能生成就緒</p>
                            <p className="text-emerald-300/60 text-xs">此模式无需输入，AI 将自动根据核心逻辑生成爆款选题。</p>
                        </div>
                    </div>
                )}
            </div>

            <button
                onClick={handlePlanTopics}
                disabled={status === GenerationStatus.PLANNING}
                className={`mt-0 md:mt-7 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 w-full md:w-auto justify-center whitespace-nowrap shadow-lg shadow-emerald-900/20`}
            >
                {status === GenerationStatus.PLANNING ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {isInputRequired()
                  ? '预测选题'
                  : niche === NicheType.YI_JING_METAPHYSICS
                    ? '一键生成爆款选题'
                    : '一键生成爆款Hooks'}
            </button>
        </div>
        )}

        {/* Adaptation Mode Button */}
        {niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION && (
          <div className="flex justify-end mt-4">
            <button 
              onClick={handleAdaptContent}
              disabled={isAdapting || !inputVal.trim()}
              className={`px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-900/20 flex items-center justify-center gap-2 transition-all transform hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:transform-none`}
            >
              {isAdapting ? (
                <>
                  <Loader2 className="animate-spin" />
                  正在改編中...
                </>
              ) : (
                <>
                  開始改編
                  <Zap size={18} fill="currentColor" />
                </>
              )}
            </button>
          </div>
        )}

        {/* 错误提示已改用 Toast 通知 */}

        {/* Topics List - Hide in Adaptation Mode */}
        {topics.length > 0 &&
          !(niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION) && (
            <div className="mt-8 animate-in slide-in-from-bottom-4 duration-500">
                <div className="flex justify-between items-center mb-3">
                    <span className="text-sm text-slate-400">
                        {niche === NicheType.STORY_REVENGE 
                            ? `选择要生成的故事 (${storyDuration === StoryDuration.SHORT ? '短篇' : '長篇'}/${storyLanguage})；全文统一走分段并行 → 合并：`
                            : '选择选题后，可并行处理多个选题；每个选题独立执行「大纲 → 并行各章 → 合并终稿」。'
                        }
                    </span>
                    <span className="text-sm text-emerald-400 font-medium">已选 {topics.filter(t => t.selected).length} 个</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[350px] overflow-y-auto pr-2 custom-scrollbar mb-6">
                    {topics.map(topic => (
                        <div 
                            key={topic.id}
                            onClick={() => toggleTopic(topic.id)}
                            className={`p-4 rounded-lg border cursor-pointer transition-all flex items-start gap-3 group ${
                                topic.selected 
                                ? 'bg-emerald-900/30 border-emerald-500/50 shadow-inner' 
                                : 'bg-slate-800 border-slate-700 opacity-70 hover:opacity-100 hover:border-slate-500'
                            }`}
                        >
                            <div className={`w-5 h-5 rounded border mt-0.5 flex items-center justify-center flex-shrink-0 transition-colors ${topic.selected ? 'bg-emerald-600 border-emerald-600' : 'border-slate-500 group-hover:border-slate-400'}`}>
                                {topic.selected && <Sparkles size={12} className="text-white" />}
                            </div>
                            <span className="text-sm text-slate-200 leading-snug font-medium">{topic.title}</span>
                        </div>
                    ))}
                </div>

                <div className="mb-6 p-4 rounded-xl border border-cyan-500/35 bg-slate-950/70 space-y-4">
                    <div className="flex flex-wrap items-center gap-2 justify-between">
                      <h3 className="text-sm font-semibold text-cyan-300 flex items-center gap-2">
                        <ListOrdered size={16} />
                        全赛道 · 分段并行工作台
                      </h3>
                      <span className="text-[10px] text-slate-500 text-right max-w-[min(100%,22rem)] leading-snug">
                        《原创万字长文生成分段输出重构合并技术》：保证最强的情绪张力和细节还原
                      </span>
                    </div>
                    {parallelTopicRuns.length > 0 && (
                      <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 space-y-3">
                        <div className="text-[11px] text-slate-400">多选题签并行状态</div>
                        <div className="flex flex-wrap gap-2">
                          {parallelTopicRuns.map((run) => (
                            <button
                              key={run.id}
                              type="button"
                              onClick={() => {
                                setActiveParallelTopicId(run.id);
                                const idx = generatedContents.findIndex((g) => g.topic === run.title);
                                if (idx >= 0) setViewIndex(idx);
                              }}
                              className={`px-3 py-1.5 rounded-lg border text-xs transition-all ${
                                activeParallelTopicId === run.id
                                  ? 'border-cyan-400 bg-cyan-900/40 text-cyan-200'
                                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                              }`}
                            >
                              <span className="font-medium">{run.title.length > 14 ? `${run.title.slice(0, 14)}…` : run.title}</span>
                              <span
                                className={`ml-2 ${
                                  run.status === 'done'
                                    ? 'text-emerald-400'
                                    : run.status === 'error'
                                      ? 'text-rose-400'
                                      : run.status === 'running'
                                        ? 'text-amber-300'
                                        : 'text-slate-500'
                                }`}
                              >
                                {run.status === 'done'
                                  ? '完成'
                                  : run.status === 'error'
                                    ? '失败'
                                    : run.status === 'running'
                                      ? '进行中'
                                      : '待开始'}
                              </span>
                            </button>
                          ))}
                        </div>
                        {(() => {
                          const active = parallelTopicRuns.find((r) => r.id === activeParallelTopicId) || parallelTopicRuns[0];
                          if (!active) return null;
                          const stageLabel: Record<ParallelTopicStage, string> = {
                            idle: '待开始',
                            outline: '大纲阶段',
                            segments: '并行分段',
                            merge: '合并润色',
                            done: '完成',
                            error: '失败',
                          };
                          return (
                            <div className="rounded-md border border-slate-700 bg-black/30 p-2.5 space-y-2">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                                <span className="text-slate-300">当前题签：{active.title}</span>
                                <span className="text-cyan-300">阶段：{stageLabel[active.stage]} · {active.progress}%</span>
                              </div>
                              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                                <div
                                  className="h-full bg-cyan-500 transition-all"
                                  style={{ width: `${Math.max(0, Math.min(100, active.progress))}%` }}
                                />
                              </div>
                              {(() => {
                                const outline = parallelTopicOutlineMap[active.id];
                                if (!outline) return null;

                                let parsedOutline: YiJingOutlinePayload | null = null;
                                try {
                                  parsedOutline = JSON.parse(outline) as YiJingOutlinePayload;
                                } catch {
                                  parsedOutline = null;
                                }

                                if (!parsedOutline) {
                                  return (
                                    <div className="rounded-md border border-slate-700/70 bg-slate-950/80 p-2">
                                      <div className="text-[10px] text-slate-400 mb-1">章节大纲（当前题签）</div>
                                      <pre className="text-[10px] leading-relaxed text-slate-300 max-h-32 overflow-y-auto custom-scrollbar whitespace-pre-wrap">
                                        {outline}
                                      </pre>
                                    </div>
                                  );
                                }

                                return (
                                  <div className="rounded-md border border-slate-700/70 bg-slate-950/80 p-2.5 space-y-2">
                                    <div className="text-[10px] text-slate-400">章节大纲（当前题签）</div>
                                    <div className="text-[11px] text-slate-300 leading-relaxed">
                                      <span className="text-slate-500">核心主题：</span>
                                      {parsedOutline.core_theme}
                                    </div>
                                    <div className="text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap">
                                      <span className="text-slate-500">逻辑主线：</span>
                                      {parsedOutline.logic_line}
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto custom-scrollbar pr-1">
                                      {parsedOutline.chapters.map((ch, i) => (
                                        <div key={i} className="rounded border border-slate-700/80 bg-black/30 p-2">
                                          <div className="text-[10px] text-cyan-300 font-medium mb-1">
                                            第 {i + 1} 章 · {ch.title}
                                          </div>
                                          <div className="text-[10px] text-slate-400 mb-1">
                                            {ch.min_chars}–{ch.max_chars} 字
                                          </div>
                                          <div className="text-[10px] text-slate-500 leading-relaxed line-clamp-3">
                                            {ch.core_brief || '（本章要点待生成）'}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()}

                              <pre className="text-[10px] leading-relaxed font-mono text-emerald-500/90 max-h-28 overflow-y-auto custom-scrollbar whitespace-pre-wrap">
                                {active.logs.length ? active.logs.join('\n') : '等待该题签开始…'}
                              </pre>

                              {(() => {
                                const drafts = parallelTopicSegDraftsMap[active.id] || [];
                                const statuses = parallelTopicSegStatusMap[active.id] || [];
                                if (!drafts.length && !statuses.length) return null;
                                return (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                    {Array.from({ length: Math.max(drafts.length, statuses.length) }).map((_, i) => {
                                      const st = statuses[i] || 'idle';
                                      const draft = drafts[i] || '';
                                      const wordCount = draft ? draft.replace(/\s+/g, '').length : 0;
                                      return (
                                        <div
                                          key={i}
                                          className="rounded-md border border-slate-700/80 bg-slate-950/70 p-2 min-h-[110px]"
                                        >
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="text-[10px] text-slate-400">第 {i + 1} 段 · {wordCount} 字</span>
                                            <span
                                              className={`text-[10px] ${
                                                st === 'done'
                                                  ? 'text-emerald-400'
                                                  : st === 'running'
                                                    ? 'text-amber-400'
                                                    : st === 'error'
                                                      ? 'text-rose-400'
                                                      : 'text-slate-500'
                                              }`}
                                            >
                                              {st === 'done' ? '完成' : st === 'running' ? '生成中' : st === 'error' ? '失败' : '待生成'}
                                            </span>
                                          </div>
                                          <div className="text-[10px] text-slate-400 leading-relaxed max-h-20 overflow-y-auto custom-scrollbar whitespace-pre-wrap">
                                            {draft || '等待内容…'}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <div className="text-xs text-slate-300">
                        <span className="text-slate-500">自动分章：</span>
                        约 <span className="text-cyan-400 font-medium">{yiJingComputedSegCount}</span> 章
                        <span className="text-slate-500 text-[10px] ml-1">
                          （≤{YI_JING_BAND1_MAX} 字：固定 5 章；{YI_JING_BAND1_MAX + 1}–{YI_JING_BAND2_MAX} 字：按约 {YI_JING_CHARS_PER_SEGMENT_SOFT_CAP} 字/段折 5–10 章；超过 {YI_JING_BAND2_MAX} 字：按约 {YI_JING_CHARS_PER_SEGMENT_SOFT_CAP} 字/段折算，最多 40 章）
                        </span>
                      </div>
                      <label className="text-xs text-slate-400 shrink-0">目标全文字数：</label>
                      <input
                        type="number"
                        min={
                          niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG'
                            ? MINDFUL_EN_SCRIPT_CHARS_MIN
                            : 1000
                        }
                        max={
                          niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG'
                            ? MINDFUL_EN_SCRIPT_CHARS_MAX
                            : 70000
                        }
                        step={100}
                        disabled={yiJingPipelineBusy}
                        value={yiJingTotalTargetChars}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          if (!Number.isNaN(n)) setYiJingTotalTargetChars(n);
                        }}
                        onBlur={() => applyYiJingTotalTargetToOutline(yiJingTotalTargetChars)}
                        className="w-[7.5rem] bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                      />
                      <span className="text-[10px] text-slate-500">
                        {niche === NicheType.MINDFUL_PSYCHOLOGY && scriptLengthMode === 'LONG'
                          ? `治愈心理学长视频：此处为英文正文目标总字符数（含空格与标点），${MINDFUL_EN_SCRIPT_CHARS_MIN}–${MINDFUL_EN_SCRIPT_CHARS_MAX}；失焦后均摊各章 min/max。`
                          : '1000–70000；失焦后按总字数均摊各章字数区间。生成/全自动时按上式向模型要对应章数'}
                      </span>
                    </div>
                    {yiJingOutlineParsed &&
                      yiJingOutlineParsed.chapters.length !== yiJingComputedSegCount && (
                        <div className="text-[11px] text-amber-400/90 bg-amber-950/30 border border-amber-700/40 rounded-lg px-3 py-2">
                          当前大纲为 {yiJingOutlineParsed.chapters.length} 章，与「目标字数」推算的{' '}
                          {yiJingComputedSegCount} 章不一致；并行仍按<strong>现有</strong>章数执行。若需对齐结构，请再点「仅生成大纲」或「全自动」。
                        </div>
                      )}
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <label className="block text-xs text-slate-400">
                          章节大纲（一键生成；默认可读，点「编辑大纲」用表单改正文结构）
                        </label>
                        {parallelTopicRuns.length > 1 && (
                          <span className="text-[10px] text-cyan-300/90">
                            多选并行时，此区域显示手动模式大纲；各题完整大纲请看上方「当前题签」卡片
                          </span>
                        )}
                        {yiJingOutlineParsed && yiJingOutlineViewMode === 'readable' && (
                          <button
                            type="button"
                            disabled={yiJingPipelineBusy}
                            onClick={() => {
                              setYiJingOutlineEditDraft(
                                JSON.parse(JSON.stringify(yiJingOutlineParsed)) as YiJingOutlinePayload
                              );
                              setYiJingOutlineViewMode('edit');
                            }}
                            className="text-[10px] text-cyan-400 hover:text-cyan-300 disabled:opacity-40"
                          >
                            编辑大纲
                          </button>
                        )}
                        {yiJingOutlineParsed && yiJingOutlineViewMode === 'edit' && yiJingOutlineEditDraft && (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={yiJingPipelineBusy}
                              onClick={() => {
                                const scaled = rescaleChapterWordCounts(
                                  yiJingOutlineEditDraft,
                                  parallelTotalTargetChars
                                );
                                setYiJingOutlineParsed(scaled);
                                setYiJingOutlineText(outlinePayloadToJsonPretty(scaled));
                                setYiJingSegDrafts(Array(scaled.chapters.length).fill(''));
                                setYiJingSegStatus(Array(scaled.chapters.length).fill('idle'));
                                setYiJingOutlineEditDraft(null);
                                setYiJingOutlineViewMode('readable');
                                toast.success('大纲已保存');
                              }}
                              className="text-[10px] text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                            >
                              完成编辑
                            </button>
                            <button
                              type="button"
                              disabled={yiJingPipelineBusy}
                              onClick={() => {
                                setYiJingOutlineEditDraft(null);
                                setYiJingOutlineViewMode('readable');
                              }}
                              className="text-[10px] text-slate-500 hover:text-slate-300 disabled:opacity-40"
                            >
                              取消
                            </button>
                          </div>
                        )}
                      </div>
                      {yiJingOutlineParsed && yiJingOutlineViewMode === 'edit' && yiJingOutlineEditDraft ? (
                        <div className="w-full min-h-[140px] max-h-[min(75vh,32rem)] overflow-y-auto custom-scrollbar bg-slate-900 border border-cyan-500/35 rounded-lg px-3 py-3 text-sm text-slate-200 space-y-4">
                          <div>
                            <div className="text-[11px] font-semibold text-cyan-300/90 mb-1">核心主题</div>
                            <textarea
                              value={yiJingOutlineEditDraft.core_theme}
                              onChange={(e) =>
                                setYiJingOutlineEditDraft((d) =>
                                  d ? { ...d, core_theme: e.target.value } : null
                                )
                              }
                              rows={2}
                              className="w-full bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
                            />
                          </div>
                          <div>
                            <div className="text-[11px] font-semibold text-cyan-300/90 mb-1">逻辑主线</div>
                            <textarea
                              value={yiJingOutlineEditDraft.logic_line}
                              onChange={(e) =>
                                setYiJingOutlineEditDraft((d) =>
                                  d ? { ...d, logic_line: e.target.value } : null
                                )
                              }
                              rows={3}
                              className="w-full bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
                            />
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-[11px] font-semibold text-cyan-300/90">分章结构（表单）</div>
                            <button
                              type="button"
                              disabled={yiJingPipelineBusy}
                              onClick={() =>
                                setYiJingOutlineEditDraft((d) =>
                                  d
                                    ? {
                                        ...d,
                                        chapters: [...d.chapters, emptyYiJingChapter(d.chapters.length)],
                                      }
                                    : null
                                )
                              }
                              className="text-[10px] text-cyan-400 hover:text-cyan-300"
                            >
                              + 添加一章
                            </button>
                          </div>
                          <div className="space-y-4">
                            {yiJingOutlineEditDraft.chapters.map((ch, i) => (
                              <div
                                key={i}
                                className="rounded-lg border border-slate-700/80 bg-slate-950/60 p-3 space-y-2"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-[11px] text-slate-500">第 {i + 1} 章</span>
                                  {yiJingOutlineEditDraft.chapters.length > 1 && (
                                    <button
                                      type="button"
                                      disabled={yiJingPipelineBusy}
                                      onClick={() =>
                                        setYiJingOutlineEditDraft((d) =>
                                          d && d.chapters.length > 1
                                            ? {
                                                ...d,
                                                chapters: d.chapters.filter((_, j) => j !== i),
                                              }
                                            : d
                                        )
                                      }
                                      className="text-[10px] text-rose-400/90 hover:text-rose-300"
                                    >
                                      删除本章
                                    </button>
                                  )}
                                </div>
                                <input
                                  type="text"
                                  value={ch.title}
                                  onChange={(e) =>
                                    setYiJingOutlineEditDraft((d) => {
                                      if (!d) return null;
                                      const chapters = [...d.chapters];
                                      chapters[i] = { ...chapters[i], title: e.target.value };
                                      return { ...d, chapters };
                                    })
                                  }
                                  placeholder="章标题"
                                  className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-100"
                                />
                                <div className="flex flex-wrap gap-2 items-center">
                                  <label className="text-[10px] text-slate-500 shrink-0">字数 min</label>
                                  <input
                                    type="number"
                                    min={100}
                                    value={ch.min_chars}
                                    onChange={(e) =>
                                      setYiJingOutlineEditDraft((d) => {
                                        if (!d) return null;
                                        const chapters = [...d.chapters];
                                        chapters[i] = {
                                          ...chapters[i],
                                          min_chars: Math.max(100, parseInt(e.target.value, 10) || 0),
                                        };
                                        return { ...d, chapters };
                                      })
                                    }
                                    className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                                  />
                                  <label className="text-[10px] text-slate-500 shrink-0">max</label>
                                  <input
                                    type="number"
                                    min={100}
                                    value={ch.max_chars}
                                    onChange={(e) =>
                                      setYiJingOutlineEditDraft((d) => {
                                        if (!d) return null;
                                        const chapters = [...d.chapters];
                                        chapters[i] = {
                                          ...chapters[i],
                                          max_chars: Math.max(100, parseInt(e.target.value, 10) || 0),
                                        };
                                        return { ...d, chapters };
                                      })
                                    }
                                    className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
                                  />
                                </div>
                                {(
                                  [
                                    ['core_brief', '本章要点'],
                                    ['opening_echo', '开篇承接'],
                                    ['closing_snippet_hint', '收束提示'],
                                    ['bridge_to_next', '过渡至下章'],
                                  ] as const
                                ).map(([key, lab]) => (
                                  <div key={key}>
                                    <div className="text-[10px] text-slate-500 mb-0.5">{lab}</div>
                                    <textarea
                                      value={ch[key]}
                                      onChange={(e) =>
                                        setYiJingOutlineEditDraft((d) => {
                                          if (!d) return null;
                                          const chapters = [...d.chapters];
                                          chapters[i] = { ...chapters[i], [key]: e.target.value };
                                          return { ...d, chapters };
                                        })
                                      }
                                      rows={key === 'core_brief' ? 3 : 2}
                                      className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-[11px] text-slate-300 leading-relaxed"
                                    />
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : yiJingOutlineParsed && yiJingOutlineViewMode === 'readable' ? (
                        <div className="w-full min-h-[140px] max-h-[min(70vh,28rem)] overflow-y-auto custom-scrollbar bg-slate-900 border border-cyan-500/35 rounded-lg px-3 py-3 text-sm text-slate-200 space-y-4">
                          <div>
                            <div className="text-[11px] font-semibold text-cyan-300/90 mb-1">核心主题</div>
                            <p className="text-xs text-slate-300 leading-relaxed">
                              {yiJingOutlineParsed.core_theme}
                            </p>
                          </div>
                          <div>
                            <div className="text-[11px] font-semibold text-cyan-300/90 mb-1">逻辑主线</div>
                            <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                              {yiJingOutlineParsed.logic_line}
                            </p>
                          </div>
                          <div className="text-[11px] font-semibold text-cyan-300/90">分章结构</div>
                          <div className="space-y-3">
                            {yiJingOutlineParsed.chapters.map((ch, i) => (
                              <div
                                key={i}
                                className="rounded-lg border border-slate-700/80 bg-slate-950/60 p-3 space-y-1.5"
                              >
                                <div className="text-xs font-medium text-slate-100">
                                  第 {i + 1} 章 · {ch.title}
                                </div>
                                <div className="text-[11px] text-slate-500">
                                  建议字数：{ch.min_chars}～{ch.max_chars} 字
                                </div>
                                {ch.core_brief ? (
                                  <div>
                                    <span className="text-[10px] text-slate-500">本章要点 · </span>
                                    <span className="text-[11px] text-slate-400 leading-relaxed">
                                      {ch.core_brief}
                                    </span>
                                  </div>
                                ) : null}
                                {ch.opening_echo ? (
                                  <div>
                                    <span className="text-[10px] text-slate-500">开篇承接 · </span>
                                    <span className="text-[11px] text-slate-400 leading-relaxed">
                                      {ch.opening_echo}
                                    </span>
                                  </div>
                                ) : null}
                                {ch.closing_snippet_hint ? (
                                  <div>
                                    <span className="text-[10px] text-slate-500">收束提示 · </span>
                                    <span className="text-[11px] text-slate-400 leading-relaxed">
                                      {ch.closing_snippet_hint}
                                    </span>
                                  </div>
                                ) : null}
                                {ch.bridge_to_next ? (
                                  <div>
                                    <span className="text-[10px] text-slate-500">过渡至下章 · </span>
                                    <span className="text-[11px] text-slate-400 leading-relaxed">
                                      {ch.bridge_to_next}
                                    </span>
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <textarea
                          value={yiJingOutlineText}
                          onChange={(e) => {
                            setYiJingOutlineText(e.target.value);
                            const p = parseYiJingOutline(e.target.value);
                            setYiJingOutlineParsed(p);
                            if (p) {
                              setYiJingSegDrafts(Array(p.chapters.length).fill(''));
                              setYiJingSegStatus(Array(p.chapters.length).fill('idle'));
                            }
                          }}
                          placeholder="尚无解析结果：请先点「仅生成大纲」；若粘贴了可解析的结构化大纲，失焦后会自动解析。"
                          className="w-full min-h-[140px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500/40 custom-scrollbar"
                        />
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                      <button
                        type="button"
                        disabled={
                          yiJingPipelineBusy ||
                          status === GenerationStatus.WRITING ||
                          topics.filter((t) => t.selected).length !== 1
                        }
                        onClick={() => void handleYiJingGenerateOutline()}
                        className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-sm hover:bg-slate-700 disabled:opacity-40"
                        title="手动模式需先只勾选 1 个选题"
                      >
                        仅生成大纲
                      </button>
                      <button
                        type="button"
                        disabled={
                          yiJingPipelineBusy ||
                          status === GenerationStatus.WRITING ||
                          topics.filter((t) => t.selected).length !== 1
                        }
                        onClick={() => void handleYiJingRunSegments()}
                        className="px-4 py-2 rounded-lg bg-cyan-900/40 border border-cyan-600/50 text-cyan-200 text-sm hover:bg-cyan-900/60 disabled:opacity-40"
                        title="手动模式需先只勾选 1 个选题"
                      >
                        并行生成各段
                      </button>
                      <button
                        type="button"
                        disabled={
                          yiJingPipelineBusy ||
                          status === GenerationStatus.WRITING ||
                          topics.filter((t) => t.selected).length !== 1
                        }
                        onClick={() => void handleYiJingMergeFinal()}
                        className="px-4 py-2 rounded-lg bg-violet-900/40 border border-violet-600/50 text-violet-200 text-sm hover:bg-violet-900/60 disabled:opacity-40"
                        title="手动模式需先只勾选 1 个选题"
                      >
                        合并最终文案
                      </button>
                      {topics.filter((t) => t.selected).length !== 1 && (
                        <span className="text-[10px] text-amber-400/90">
                          手动模式请只勾选 1 个选题；多选请用「全自动并行」
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={yiJingPipelineBusy}
                        onClick={clearYiJingPipelinePanel}
                        className="px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-400 text-sm hover:text-slate-200 inline-flex items-center gap-1"
                      >
                        <Trash2 size={14} /> 清空面板
                      </button>
                    </div>
                    {yiJingSegDrafts.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {yiJingSegDrafts.map((draft, i) => {
                          const st = yiJingSegStatus[i] || 'idle';
                          const label =
                            yiJingOutlineParsed?.chapters[i]?.title || `第 ${i + 1} 段`;
                          return (
                            <div
                              key={i}
                              className="rounded-lg border border-slate-700 bg-slate-900/80 p-3 flex flex-col min-h-[160px]"
                            >
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <span className="text-xs font-medium text-slate-300 truncate">
                                  第 {i + 1} 步 · {label}
                                </span>
                                <span
                                  className={`text-[10px] shrink-0 ${
                                    st === 'done'
                                      ? 'text-emerald-400'
                                      : st === 'running'
                                        ? 'text-amber-400'
                                        : st === 'error'
                                          ? 'text-red-400'
                                          : 'text-slate-500'
                                  }`}
                                >
                                  {st === 'done'
                                    ? '✓ 完成'
                                    : st === 'running'
                                      ? '生成中…'
                                      : st === 'error'
                                        ? '失败'
                                        : '待生成'}
                                </span>
                              </div>
                              <div className="flex-1 text-[11px] text-slate-400 max-h-32 overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                                {draft || '…'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div>
                      <div className="text-xs text-slate-500 mb-1">终端日志</div>
                      <pre className="text-[10px] leading-relaxed font-mono bg-black/70 border border-slate-800 rounded-lg p-3 max-h-36 overflow-y-auto text-emerald-600/90 whitespace-pre-wrap custom-scrollbar">
                        {yiJingPipelineLogs.length === 0
                          ? '等待指令…'
                          : yiJingPipelineLogs.join('\n')}
                      </pre>
                    </div>
                    {yiJingMergedOutput && (
                      <div>
                        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                          <span className="text-xs font-medium text-amber-400/90 flex items-center gap-2">
                            合并后终稿预览
                            {yiJingAiDetection && (
                              <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                                yiJingAiDetection.level === 'weak' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' :
                                yiJingAiDetection.level === 'medium' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' :
                                'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                              }`}>
                                AI味:{yiJingAiDetection.level === 'weak' ? '弱' : yiJingAiDetection.level === 'medium' ? '中' : '强'} {yiJingAiDetection.score}分
                              </span>
                            )}
                            {yiJingIsRunningAiDetection && (
                              <span className="text-[10px] text-cyan-400 animate-pulse">检测中...</span>
                            )}
                          </span>
                          <div className="flex items-center gap-2">
                            {yiJingAiDetection?.level === 'strong' && (
                              <button
                                type="button"
                                onClick={() => void handleYiJingReAntiAiPolish()}
                                disabled={yiJingIsPolishing}
                                className="text-[10px] px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 disabled:text-slate-500 text-white flex items-center gap-1"
                              >
                                {yiJingIsPolishing ? (
                                  <><Loader2 size={10} className="animate-spin" />清洗中...</>
                                ) : (
                                  '重新去AI味'
                                )}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(yiJingMergedOutput);
                                toast.success('已复制终稿');
                              }}
                              className="text-[10px] text-cyan-400 hover:text-cyan-300"
                            >
                              复制终稿
                            </button>
                          </div>
                        </div>
                        {/* AI 味检测详情 */}
                        {yiJingAiDetection && (
                          <div className="mb-2 p-2 rounded bg-slate-900/60 border border-slate-800 space-y-1">
                            <div className="flex gap-3 text-[9px]">
                              <div className="flex items-center gap-1">
                                <span className="text-slate-500">模板词:</span>
                                <span className={yiJingAiDetection.dimensions.templateWords > 60 ? 'text-rose-400' : yiJingAiDetection.dimensions.templateWords > 30 ? 'text-amber-400' : 'text-emerald-400'}>
                                  {yiJingAiDetection.dimensions.templateWords}%
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                <span className="text-slate-500">句式:</span>
                                <span className={yiJingAiDetection.dimensions.sentencePattern > 60 ? 'text-rose-400' : yiJingAiDetection.dimensions.sentencePattern > 30 ? 'text-amber-400' : 'text-emerald-400'}>
                                  {yiJingAiDetection.dimensions.sentencePattern}%
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                <span className="text-slate-500">人味:</span>
                                <span className={yiJingAiDetection.dimensions.humanFeatures < 40 ? 'text-rose-400' : yiJingAiDetection.dimensions.humanFeatures < 70 ? 'text-amber-400' : 'text-emerald-400'}>
                                  {100 - yiJingAiDetection.dimensions.humanFeatures}%
                                </span>
                              </div>
                            </div>
                            {yiJingAiDetection.issues.length > 0 && yiJingAiDetection.level !== 'weak' && (
                              <div className="text-[9px] text-slate-500">
                                建议: {yiJingAiDetection.issues.slice(0, 2).join('; ')}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="text-[11px] text-slate-400 max-h-40 overflow-y-auto border border-slate-800 rounded-lg p-2 bg-slate-950/80 whitespace-pre-wrap custom-scrollbar">
                          {yiJingMergedOutput.slice(0, 4000)}
                          {yiJingMergedOutput.length > 4000 ? '\n…' : ''}
                        </div>
                      </div>
                    )}
                  </div>
                
                {/* 批量生成进度条 */}
                {batchProgress && (
                  <div className="mb-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                    <ProgressBar
                      current={batchProgress.current}
                      total={batchProgress.total}
                      label="生成进度"
                      showPercentage={true}
                      showCount={true}
                      color="emerald"
                      statusHint={batchProgress.hint}
                    />
                  </div>
                )}
                
                <div className="flex justify-end">
                     <button 
                        onClick={handleBatchGenerate}
                        disabled={status === GenerationStatus.WRITING || yiJingPipelineBusy}
                        className="w-full md:w-auto px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-900/20 flex items-center justify-center gap-2 transition-all transform hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:transform-none"
                    >
                        {status === GenerationStatus.WRITING || yiJingPipelineBusy ? (
                            <>
                                <Loader2 className="animate-spin" />
                                分段并行生成中…
                            </>
                        ) : (
                            <>
                                <>
                                  <Rocket size={18} className="text-amber-200" />
                                  啟動分段并行撰寫（全自動）
                                </>
                            </>
                        )}
                    </button>
                </div>
            </div>
        )}

        {/* 治愈心理学：动画分镜（选题与「分段并行工作台」见上方，与全赛道一致） */}
        {niche === NicheType.MINDFUL_PSYCHOLOGY && (
          <div className="mt-8 p-4 bg-slate-800/50 border border-slate-700 rounded-xl">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-lg">🐾</span>
              <span className="text-slate-200 font-medium">治愈心理学频道</span>
            </div>
            <div ref={mindfulStoryboardAnchorRef}>
              <button
                type="button"
                onClick={() => setMindfulStoryboardExpanded((v) => !v)}
                className="w-full flex items-center justify-between gap-2 rounded-lg border border-slate-600 bg-slate-900/50 px-3 py-2.5 mb-2 text-left hover:bg-slate-800/70 transition-colors"
              >
                <span className="flex items-center gap-2 text-sm text-slate-300 font-medium min-w-0">
                  <Film size={14} className="text-purple-400 shrink-0" />
                  <span className="truncate">一键动画分镜</span>
                  <span className="text-xs font-normal text-slate-500 shrink-0">（点击展开）</span>
                </span>
                {mindfulStoryboardExpanded ? (
                  <ChevronDown size={18} className="text-slate-400 shrink-0" />
                ) : (
                  <ChevronRight size={18} className="text-slate-400 shrink-0" />
                )}
              </button>
              {mindfulStoryboardExpanded && (
                <>
                  <div className="mb-3 flex flex-wrap items-end gap-3">
                    <div className="min-w-[200px] max-w-[320px] flex-1">
                      <label className="text-[10px] text-slate-500 mb-0.5 block">风格设置（与媒体生成一致）</label>
                      <select
                        value={
                          MEDIA_IMAGE_STYLE_SELECT_OPTIONS.some((o) => o.id === mindfulStoryboardStyleId)
                            ? mindfulStoryboardStyleId
                            : 'none'
                        }
                        onChange={(e) => setMindfulStoryboardStyleId(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                      >
                        {MEDIA_IMAGE_STYLE_SELECT_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <div className="flex-1">
                      <textarea
                        value={mindfulScript}
                        onChange={(e) => setMindfulScript(e.target.value)}
                        placeholder="在此粘贴脚本内容，一键生成动画分镜..."
                        className="w-full h-[280px] bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-slate-200 focus:outline-none focus:border-emerald-500 resize-none custom-scrollbar text-sm"
                      />
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-center mb-2 gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <label className="text-sm text-slate-400">分镜输出</label>
                          {isGeneratingStoryboard && (
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                              <span>{storyboardProgress}%</span>
                              <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-purple-500 transition-all duration-300"
                                  style={{ width: `${storyboardProgress}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={openMindfulStoryboardHistory}
                            className="px-3 py-1 bg-slate-700/90 hover:bg-slate-600 text-slate-200 text-sm rounded-lg flex items-center gap-1.5 transition-all border border-slate-600/80"
                            title="按日期+随机数命名的历史分镜记录"
                          >
                            <History size={12} />
                            读取历史
                          </button>
                          {storyboard && (
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(storyboard);
                                toast.success('分镜内容已复制到剪贴板');
                              }}
                              className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg flex items-center gap-1 transition-all"
                            >
                              <Copy size={12} /> 复制
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="w-full h-[280px] bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 text-slate-200 overflow-y-auto whitespace-pre-wrap leading-relaxed custom-scrollbar text-sm">
                        {storyboard ? (
                          <>
                            {storyboard}
                            {isGeneratingStoryboard && (
                              <div className="mt-3 pt-3 border-t border-slate-800 flex items-center gap-2 text-slate-500 text-sm">
                                <Loader2 className="animate-spin shrink-0" size={14} />
                                <span>正在流式输出…</span>
                              </div>
                            )}
                          </>
                        ) : isGeneratingStoryboard ? (
                          <div className="flex items-center gap-2 text-slate-500">
                            <Loader2 className="animate-spin" size={14} />
                            <span>正在生成分镜...</span>
                          </div>
                        ) : (
                          <div className="text-slate-600 text-sm">分镜结果将显示在此处</div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-center mt-3">
                    <button
                      type="button"
                      onClick={() => void handleGenerateStoryboard()}
                      disabled={isGeneratingStoryboard || !mindfulScript.trim()}
                      className="px-8 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {isGeneratingStoryboard ? (
                        <>
                          <Loader2 className="animate-spin" size={14} />
                          生成分镜中...
                        </>
                      ) : (
                        <>
                          <Film size={14} />
                          🎬 一键生成动画分镜
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      {/* 3. Output Section */}
      {(status === GenerationStatus.WRITING || status === GenerationStatus.COMPLETED || generatedContents.length > 0) && (
        <section className="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 min-h-[600px] flex flex-col animate-in fade-in duration-500">
             <div className="flex flex-wrap justify-between items-center mb-4 gap-4">
                <h2 className="text-lg font-medium text-slate-300 flex items-center gap-2">
                    <span className="bg-emerald-600 w-6 h-6 rounded-full flex items-center justify-center text-xs text-white">3</span>
                    即時編輯器 (Live Editor)
                    {activeIndices.size > 0 && <span className="text-xs text-emerald-400 animate-pulse font-mono">({activeIndices.size} writing...)</span>}
                </h2>
                {status === GenerationStatus.COMPLETED && (
                    <button onClick={downloadAll} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-md border border-slate-700 text-sm flex items-center gap-2 text-emerald-400 hover:text-emerald-300 transition-all shadow-sm">
                        <Download size={16} />
                        打包下載 (.zip)
                    </button>
                )}
             </div>

             <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Sidebar: Progress */}
                <div className="lg:col-span-4 space-y-2 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                    {generatedContents.map((item, idx) => (
                        <div 
                            key={idx} 
                            onClick={() => setViewIndex(idx)}
                            className={`p-3 rounded-lg border text-sm cursor-pointer transition-all hover:bg-slate-800 ${
                            idx === viewIndex
                                ? 'bg-emerald-900/40 border-emerald-500 shadow-md ring-1 ring-emerald-500/50' 
                                : 'bg-slate-800/30 border-slate-700 opacity-80'
                        }`}>
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <div className="flex items-center gap-2">
                                    {/* Spinner if active, Check if done */}
                                    {activeIndices.has(idx) ? (
                                        <Loader2 size={14} className="animate-spin text-amber-400" />
                                    ) : (
                                        <div className="w-3.5 h-3.5 rounded-full bg-emerald-500 flex items-center justify-center shadow-sm shadow-emerald-500/50">
                                            <div className="w-1.5 h-1.5 bg-white rounded-full" />
                                        </div>
                                    )}
                                    <span className={`font-mono text-xs ${idx === viewIndex ? 'text-emerald-200' : 'text-slate-400'}`}>Topic {idx + 1}</span>
                                </div>
                                {idx === viewIndex && <Eye size={14} className="text-emerald-400" />}
                            </div>
                            <p className={`line-clamp-2 ${idx === viewIndex ? 'text-white font-medium' : 'text-slate-400'}`}>{item.topic}</p>
                            <p className="text-xs mt-2 opacity-50 font-mono text-right">{item.content.length} characters</p>
                        </div>
                    ))}
                </div>

                {/* Editor Area */}
                <div className="lg:col-span-8 bg-slate-950 rounded-xl border border-slate-800 p-4 font-mono text-sm text-slate-300 overflow-y-auto max-h-[600px] relative shadow-inner" ref={scrollRef}>
                    {generatedContents[viewIndex] ? (
                        <div className="pb-8">
                             {/* Sticky Header with Title and Copy Button */}
                            <div className="sticky top-0 bg-slate-950/95 py-3 border-b border-slate-900 z-10 backdrop-blur-sm flex justify-between items-start gap-4 mb-4">
                                <h3 className="text-lg font-bold text-amber-500 flex-1">
                                    {generatedContents[viewIndex].topic}
                                </h3>

                                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                                    {/* AI 味检测显示 */}
                                    {yiJingAiDetection && (
                                        <span className={`text-xs font-bold px-2 py-1 rounded ${
                                          yiJingAiDetection.level === 'weak' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' :
                                          yiJingAiDetection.level === 'medium' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' :
                                          'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                        }`}>
                                          AI味:{yiJingAiDetection.level === 'weak' ? '弱' : yiJingAiDetection.level === 'medium' ? '中' : '强'} {yiJingAiDetection.score}分
                                        </span>
                                    )}
                                    {yiJingIsRunningAiDetection && (
                                        <span className="text-[10px] text-cyan-400 animate-pulse">检测中...</span>
                                    )}
                                    {yiJingAiDetection?.level === 'strong' && (
                                        <button
                                            type="button"
                                            onClick={() => void handleYiJingReAntiAiPolish()}
                                            disabled={yiJingIsPolishing}
                                            className="text-[10px] px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 disabled:text-slate-500 text-white flex items-center gap-1"
                                        >
                                            {yiJingIsPolishing ? (
                                                <><Loader2 size={10} className="animate-spin" />清洗中...</>
                                            ) : (
                                                '重新去AI味'
                                            )}
                                        </button>
                                    )}
                                    {niche === NicheType.MINDFUL_PSYCHOLOGY && (
                                        <button
                                            type="button"
                                            onClick={openMindfulStoryboardFromEditor}
                                            className="px-3 py-2 bg-purple-600/20 hover:bg-purple-600/35 text-purple-200 hover:text-purple-50 border border-purple-500/40 rounded-md transition-all flex items-center gap-1.5 text-xs"
                                            title="展开策划区「一键动画分镜」并填入当前文案"
                                        >
                                            <Film size={14} />
                                            一键动画分镜
                                        </button>
                                    )}
                                    <button
                                        onClick={() => handleCopy(generatedContents[viewIndex].content, viewIndex)}
                                        className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-md transition-all flex items-center gap-2 text-xs"
                                        title="复制全文"
                                    >
                                        {copiedId === viewIndex ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                        {copiedId === viewIndex ? '已复制' : '复制'}
                                    </button>
                                </div>
                            </div>

                            <div className="whitespace-pre-wrap leading-relaxed tracking-wide text-slate-300">
                                {generatedContents[viewIndex].content}
                                {activeIndices.has(viewIndex) && <span className="inline-block w-2 h-4 bg-emerald-500 ml-1 animate-pulse" />}
                            </div>
                        </div>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-4">
                            <div className="w-16 h-16 rounded-full bg-slate-900 flex items-center justify-center">
                                <Eye className="w-8 h-8 text-slate-700" />
                            </div>
                            <p>请從左側选择一個选题以查看內容...</p>
                        </div>
                    )}
                </div>
             </div>
        </section>
      )}
      
      {showStoryboardHistorySelector && (
        <HistorySelector
          records={storyboardHistoryRecords}
          onSelect={handleStoryboardHistorySelect}
          onClose={() => setShowStoryboardHistorySelector(false)}
          onDelete={(record) => {
            const historyKey = getMindfulStoryboardHistoryKey();
            deleteHistory('generator', historyKey, record.timestamp);
            setStoryboardHistoryRecords(getHistory('generator', historyKey));
          }}
          onClearAll={() => {
            const historyKey = getMindfulStoryboardHistoryKey();
            clearHistory('generator', historyKey);
            setStoryboardHistoryRecords([]);
          }}
          title="一键动画分镜历史"
        />
      )}

      {/* 历史记录选择器 */}
      {showHistorySelector && (
        <HistorySelector
          records={historyRecords}
          onSelect={handleHistorySelect}
          onClose={() => {
            // 如果用户关闭选择器，仍然执行切换操作
            if (pendingSubModeChange) {
              const { niche: nicheType, submode: submodeId } = pendingSubModeChange;
              
              // 根据 niche 类型找到对应的 setFunc
              if (nicheType === NicheType.TCM_METAPHYSICS) {
                setTcmSubMode(submodeId as TcmSubModeId);
              } else if (nicheType === NicheType.FINANCE_CRYPTO) {
                setFinanceSubMode(submodeId as FinanceSubModeId);
              } else if (nicheType === NicheType.STORY_REVENGE) {
                setRevengeSubMode(submodeId as RevengeSubModeId);
              } else if (nicheType === NicheType.GENERAL_VIRAL) {
                setNewsSubMode(submodeId as NewsSubModeId);
              }
              
              // 清空输入和内容
              setInputVal('');
              setTopics([]);
              setAdaptedContent('');
              setIsAdapting(false);
            }
            
            setShowHistorySelector(false);
            setPendingSubModeChange(null);
          }}
          onDelete={(record) => {
            if (pendingSubModeChange) {
              const historyKey = getHistoryKeyForSubMode(pendingSubModeChange.niche, pendingSubModeChange.submode);
              deleteHistory('generator', historyKey, record.timestamp);
              setHistoryRecords(getHistory('generator', historyKey));
            }
          }}
          onClearAll={() => {
            if (pendingSubModeChange) {
              const historyKey = getHistoryKeyForSubMode(pendingSubModeChange.niche, pendingSubModeChange.submode);
              clearHistory('generator', historyKey);
              setHistoryRecords([]);
            }
          }}
          title="脚本历史记录"
        />
      )}
    </div>
  );
};