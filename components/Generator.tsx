import React, { useState, useRef, useEffect } from 'react';
import { ApiProvider, NicheType, Topic, GeneratedContent, GenerationStatus, TcmSubModeId, FinanceSubModeId, RevengeSubModeId, NewsSubModeId, StoryLanguage, StoryDuration } from '../types';
import { NICHES, TCM_SUB_MODES, FINANCE_SUB_MODES, REVENGE_SUB_MODES, NEWS_SUB_MODES, INTERACTIVE_ENDING_TEMPLATE, PSYCHOLOGY_LONG_SCRIPT_PROMPT, PSYCHOLOGY_SHORT_SCRIPT_PROMPT, PHILOSOPHY_LONG_SCRIPT_PROMPT, PHILOSOPHY_SHORT_SCRIPT_PROMPT, EMOTION_TABOO_LONG_SCRIPT_PROMPT, EMOTION_TABOO_SHORT_SCRIPT_PROMPT } from '../constants';
import { NicheSelector } from './NicheSelector';
import { generateTopics, streamContentGeneration, initializeGemini } from '../services/geminiService';
import { Sparkles, Calendar, Loader2, Download, Eye, Zap, AlertTriangle, Copy, Check, Globe, Clock, PlusCircle, History } from 'lucide-react';
import JSZip from 'jszip';
import { saveHistory, getHistory, getHistoryKey, deleteHistory, HistoryRecord } from '../services/historyService';
import { HistorySelector } from './HistorySelector';
import { useToast } from './Toast';
import { ProgressBar } from './ProgressBar';

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
  const MIN_TCM_SCRIPT_CHARS = 7500; // 30 min * 250 chars/min
  const MAX_TCM_SCRIPT_CHARS = 10000; // 40 min * 250 chars/min
  const MIN_FIN_SCRIPT_CHARS = 7500; // 30 min * 250 chars/min
  const MAX_FIN_SCRIPT_CHARS = 10000; // 40 min * 250 chars/min
  const MIN_NEWS_SCRIPT_CHARS = 4500; // 15 min * 300 chars/min
  const MAX_NEWS_SCRIPT_CHARS = 8000; // 上限8000字，约26-27分钟
  const MAX_SCRIPT_CONTINUATIONS = 3;
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
  
  // 历史记录相关状态
  const [showHistorySelector, setShowHistorySelector] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [pendingSubModeChange, setPendingSubModeChange] = useState<{ niche: NicheType; submode: string } | null>(null);

  // UTC 时间锚定（仅在需要时间锚的赛道/子模式注入）
  const getUtcAnchor = (): string => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hour = String(now.getUTCHours()).padStart(2, '0');
    const minute = String(now.getUTCMinutes()).padStart(2, '0');
    return `当前UTC时间：${year}年${month}月${day}日 ${hour}:${minute} UTC（以此为唯一时间锚，所有输出中的年份必须为${year}年，禁止使用其他年份或过期年份）`;
  };

  const shouldInjectUtcAnchor = (): boolean => {
    // 中医玄学：仅“时辰禁忌”允许注入具体 UTC 时间锚
    if (niche === NicheType.TCM_METAPHYSICS) {
      return tcmSubMode === TcmSubModeId.TIME_TABOO;
    }
    return true;
  };

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

  // 处理子模式切换（带历史记录选择）
  const handleSubModeChange = (nicheType: NicheType, submodeId: string, setFunc: (id: any) => void) => {
    const historyKey = getHistoryKeyForSubMode(nicheType, submodeId);
    const records = getHistory('generator', historyKey);
    
    console.log('[Generator] 切换子模式:', { 
      nicheType, 
      submodeId, 
      historyKey, 
      recordsCount: records.length,
      recordTopics: records.map(r => r.metadata?.topic)
    });
    
    if (records.length > 0) {
      // 有历史记录，显示选择器
      console.log('[Generator] 显示历史记录选择器，记录数:', records.length, '第一条记录主题:', records[0]?.metadata?.topic);
      setHistoryRecords(records);
      setPendingSubModeChange({ niche: nicheType, submode: submodeId });
      setShowHistorySelector(true);
    } else {
      // 没有历史记录，直接切换
      setFunc(submodeId);
      setInputVal('');
      setTopics([]);
      setAdaptedContent('');
      setIsAdapting(false);
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
    if (niche === NicheType.PSYCHOLOGY) return null;
    if (niche === NicheType.PHILOSOPHY_WISDOM) return null;
    if (niche === NicheType.EMOTION_TABOO) return null;
    return null;
  };

  const getSubModesForRender = () => {
     if (niche === NicheType.TCM_METAPHYSICS) return TCM_SUB_MODES;
     if (niche === NicheType.FINANCE_CRYPTO) return FINANCE_SUB_MODES;
     if (niche === NicheType.STORY_REVENGE) return REVENGE_SUB_MODES;
     if (niche === NicheType.GENERAL_VIRAL) return NEWS_SUB_MODES;
     if (niche === NicheType.PSYCHOLOGY) return null;
     if (niche === NicheType.PHILOSOPHY_WISDOM) return null;
     if (niche === NicheType.EMOTION_TABOO) return null;
     return null;
  };

  const isInputRequired = () => {
    const config = getCurrentSubModeConfig();
    if (config) return config.requiresInput;
    if (niche === NicheType.PSYCHOLOGY) return false;
    if (niche === NicheType.PHILOSOPHY_WISDOM) return false;
    if (niche === NicheType.EMOTION_TABOO) return false;
    return true; // Default input required for other niches
  };

  const shouldShowInput = () => {
    const config = getCurrentSubModeConfig();
    if (config) return config.requiresInput || config.optionalInput;
    if (niche === NicheType.PSYCHOLOGY) return false;
    if (niche === NicheType.PHILOSOPHY_WISDOM) return false;
    if (niche === NicheType.EMOTION_TABOO) return false;
    return true;
  };

  const getInputPlaceholder = () => {
      const config = getCurrentSubModeConfig();
      if (config) return config.inputPlaceholder || "输入关键词";
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
        } else {
            prompt = prompt.replace(/.*\{input\}.*\n?/g, '').replace('{input}', '');
        }

        // 2. UTC 时间锚定（中医玄学仅时辰禁忌注入）
        if (shouldInjectUtcAnchor()) {
          prompt = `${getUtcAnchor()}\n\n${prompt}`;
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
        } else {
            if (!inputVal) {
                toast.warning("请输入关键词。");
                return;
            }
            prompt = config.topicPromptTemplate.replace('{input}', inputVal);
        }
        // UTC 时间锚定（中医玄学仅时辰禁忌注入）
        if (shouldInjectUtcAnchor()) {
          prompt = `${getUtcAnchor()}\n\n${prompt}`;
        }
    }
    
    // Status already set above

    try {
      const rawTopics = await generateTopics(prompt, config.systemInstruction);
      
      const newTopics: Topic[] = rawTopics.map((t, i) => ({
        id: `topic-${i}`,
        title: t,
        selected: true
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
      setErrorMsg("配置错误：找不到該赛道配置");
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
          .replace(/-----+/g, '')
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
      setErrorMsg(parseErrorMessage(err));
    } finally {
      setIsAdapting(false);
    }
  };

  const toggleTopic = (id: string) => {
    setTopics(topics.map(t => t.id === id ? { ...t, selected: !t.selected } : t));
  };

  // 批量生成进度状态
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);

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
      currentSubModeId = currentSubModeConfig?.id || '';
    }
    
    console.log('[Generator] 锁定子模式配置:', { 
      niche: currentNiche, 
      submodeId: currentSubModeId,
      configId: currentSubModeConfig?.id 
    });

    // Initialize API
    initializeGemini(apiKey, { provider });

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
            .replace(/感謝收看/gi, '')
            .replace(/感谢收看/gi, '')
            .replace(/謝謝觀看/gi, '')
            .replace(/谢谢观看/gi, '')
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

    const truncateToMax = (text: string, maxChars: number) => {
        if (text.length <= maxChars) return text;
        const slice = text.slice(0, maxChars);
        const lastPunct = Math.max(
            slice.lastIndexOf('。'),
            slice.lastIndexOf('！'),
            slice.lastIndexOf('？'),
            slice.lastIndexOf('.'),
            slice.lastIndexOf('!'),
            slice.lastIndexOf('?')
        );
        return (lastPunct > 0 ? slice.slice(0, lastPunct + 1) : slice).trim();
    };

    // 检查内容是否已经有收尾的迹象（检查原始文本，不清理）
    const hasEndingIndicators = (text: string): boolean => {
        const endingPatterns = [
            /下期再見/i,
            /下期再见/i,
            /下期見/i,
            /下期见/i,
            /咱們下期再見/i,
            /咱们下期再见/i,
            /咱們下期見/i,
            /咱们下期见/i,
            /我們下期再見/i,
            /我们下期再见/i,
            /我們下期見/i,
            /我们下期见/i
        ];
        return endingPatterns.some(pattern => pattern.test(text));
    };

    // 检查内容是否完整且字数合理（用于新闻评论）
    // 当出现收尾语且字数>=4000时，认为内容已完整
    const isContentComplete = (text: string, minChars: number, maxChars: number): boolean => {
        // 检查原始文本是否有收尾语
        const hasEnding = hasEndingIndicators(text);
        if (!hasEnding) {
            return false;
        }
        // 检查字数（使用清理后的文本计算）
        const cleaned = sanitizeTtsScript(text);
        const length = cleaned.length;
        // 有收尾语且字数>=4000，认为内容完整（不限制上限，优先保证完整性）
        return length >= 4000;
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
                niche === NicheType.GENERAL_VIRAL;
            const isRevengeShort =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.SHORT;
            const isRevengeLong =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.LONG;
            const isShortScript =
                (niche === NicheType.TCM_METAPHYSICS || niche === NicheType.FINANCE_CRYPTO || niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO) &&
                scriptLengthMode === 'SHORT';
            
            if (shouldEnforceLength) {
                if (isShortScript) {
                    totalExpected += niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO ? 450 : 500;
                } else {
                    const minChars =
                        niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO
                            ? 2000
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
    
    // 初始化进度条（基于百分比）
    setBatchProgress({ current: 0, total: 100 });
    
    const generationPromises = selectedTopics.map(async (topic, index) => {
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
        }

        // Use the selected script prompt
        let prompt = scriptTemplate.replace('{topic}', topic.title);

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
          prompt = `${getUtcAnchor()}\n\n${prompt}`;
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
            let localContent = '';
            const appendChunk = (chunk: string) => {
                localContent += chunk;
                    setGeneratedContents(prev => {
                        const newArr = [...prev];
                        if (newArr[index]) {
                            newArr[index] = {
                                ...newArr[index],
                                content: newArr[index].content + chunk
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
                            
                            // 计算百分比（最多95%，留5%给收尾和清理）
                            const progress = Math.min(95, (totalGeneratedLength / expectedTotalLength) * 100);
                            setBatchProgress({ current: Math.round(progress), total: 100 });
                        }
                        
                        return newArr;
                    });
            };

            await streamContentGeneration(
                prompt,
                systemInstruction,
                appendChunk
            );

            const shouldEnforceLength =
                niche === NicheType.TCM_METAPHYSICS ||
                niche === NicheType.FINANCE_CRYPTO ||
                niche === NicheType.PSYCHOLOGY ||
                niche === NicheType.PHILOSOPHY_WISDOM ||
                niche === NicheType.EMOTION_TABOO ||
                niche === NicheType.GENERAL_VIRAL;
            const isRevengeShort =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.SHORT;
            const isRevengeLong =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.LONG;
            const isShortScript =
                (niche === NicheType.TCM_METAPHYSICS || niche === NicheType.FINANCE_CRYPTO || niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO) &&
                scriptLengthMode === 'SHORT';

            if (shouldEnforceLength) {
                let continueCount = 0;
                const minChars = isShortScript
                    ? (niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO ? 400 : 300)
                    : niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO
                        ? 2000
                        : niche === NicheType.TCM_METAPHYSICS
                            ? MIN_TCM_SCRIPT_CHARS
                            : niche === NicheType.FINANCE_CRYPTO
                                ? MIN_FIN_SCRIPT_CHARS
                                : MIN_NEWS_SCRIPT_CHARS;
                const maxChars = isShortScript
                    ? 500
                    : niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO
                        ? 3000
                        : niche === NicheType.TCM_METAPHYSICS
                            ? MAX_TCM_SCRIPT_CHARS
                            : niche === NicheType.FINANCE_CRYPTO
                                ? MAX_FIN_SCRIPT_CHARS
                                : MAX_NEWS_SCRIPT_CHARS;
                
                // 对于新闻评论，先检查是否已经完整（有收尾且字数合理）
                if (niche === NicheType.GENERAL_VIRAL && isContentComplete(localContent, minChars, maxChars)) {
                    // 内容已经完整，直接进入收尾阶段，不再续写
                    console.log('[Generator] Content already complete, skipping continuation');
                } else {
                    // 需要续写的情况
                    while (localContent.length < minChars && continueCount < MAX_SCRIPT_CONTINUATIONS) {
                        // 对于新闻评论，每次续写前都检查是否已经完整
                        if (niche === NicheType.GENERAL_VIRAL && isContentComplete(localContent, minChars, maxChars)) {
                            console.log('[Generator] Content became complete during continuation, stopping');
                            break;
                        }
                        
                        // 对于新闻评论，如果字数已经达到4000以上，停止续写，进入强制收尾阶段
                        if (niche === NicheType.GENERAL_VIRAL) {
                            const cleanedLength = sanitizeTtsScript(localContent).length;
                            if (cleanedLength >= 4000 && !hasEndingIndicators(localContent)) {
                                console.log('[Generator] Content reached 4000+ chars, stopping continuation to force ending');
                                break;
                            }
                        }
                        
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
                                            : `请继续补充短视频文案，保持一环接一环的节奏与排比句结构，加入“第一、第二、第三”的总结排列。当前已写${currentLength}字，目标300-500字，必须有标点。`)
                                : niche === NicheType.GENERAL_VIRAL
                                    ? `请用第一人称续写新聞評論，保持評論員的犀利與獨家視角，不要重覆前文。當前已寫${currentLength}字，如果內容充分完整且達到4000字以上，可以自然收尾並以「下期再見」「我們下期見」或「咱們下期再見」結束。如果內容尚不完整，请繼續深入分析，暫時不要收尾。`
                                    : niche === NicheType.EMOTION_TABOO
                                        ? (remainingBudget <= 400
                                            ? `请用200-400字完成收束，确保故事完整闭合与反思结尾，保持禁忌张力与心理崩塌感。当前已写${currentLength}字，务必在字数上限内完成。`
                                            : `请继续续写，重点加强禁忌与羞耻的心理描写与含蓄暗示，确保故事完整闭合，目标2000-2500字，最多不超过3000字。当前已写${currentLength}字。`)
                                        : '请续写以下內容，保持原風格與第一人称口吻，不要重覆前文。',
                            '不要出現「下課」「今天的課到這裡」等其他收尾語。',
                            '输出第一行必須是「-----」，下一行直接续写正文。',
                            `目標字數：至少 ${minChars} 字，當前已${currentLength}字。`,
                            '',
                            '【上文】',
                            context
                        ].join('\n');

                        await streamContentGeneration(
                            continuePrompt,
                            systemInstruction,
                            appendChunk
                        );

                        if (localContent.length >= maxChars) {
                            break;
                        }
                        
                        // 对于新闻评论，检查是否已经出现"下期再见"，如果是则立即停止
                        if (niche === NicheType.GENERAL_VIRAL && hasEndingIndicators(localContent)) {
                            console.log('[Generator] Detected "下期再见" during continuation, stopping immediately');
                            break;
                        }
                    }
                }

                if (niche === NicheType.GENERAL_VIRAL) {
                    // 检查内容是否已经完整（有收尾语且字数>=4000）
                    const hasEnding = hasEndingIndicators(localContent);
                    const cleanedBeforeEnd = sanitizeTtsScript(localContent);
                    
                    if (isContentComplete(localContent, minChars, maxChars)) {
                        // 内容已完整（有收尾语且字数>=4000），直接结束，不做任何额外操作
                        console.log('[Generator] Content is complete with ending and sufficient length, finishing');
                    } else if (hasEnding && cleanedBeforeEnd.length < 4000) {
                        // 有收尾语但字数不足4000，警告但不续写（避免循环）
                        console.log('[Generator] Warning: Content has ending but length < 4000, skipping to avoid loop');
                    } else if (cleanedBeforeEnd.length >= 4000) {
                        // 字数已经达到4000以上但没有收尾语，必须强制收尾
                        console.log('[Generator] Content reached 4000+ chars without ending, forcing conclusion');
                        const endPrompt = [
                            '请用第一人称對上述內容進行总结收尾，結尾要升華點題並形成明確觀點收束。',
                            '最後必須以「下期再見」或「咱們下期再見」或「我們下期見」作為結尾語。',
                            '输出第一行必須是「-----」，下一行直接续写收尾段落。',
                            '不要标题、不要段落标记、不要元信息。',
                            '收尾段落控制在300-500字之內，要簡潔有力、點題升華。',
                            '',
                            '【需要收尾的內容】',
                            localContent.slice(-2000)
                        ].join('\n');

                        await streamContentGeneration(
                            endPrompt,
                            systemInstruction,
                            appendChunk
                        );
                    }
                }

                let cleaned = sanitizeTtsScript(localContent);
                if (niche === NicheType.TCM_METAPHYSICS) {
                    const capped = truncateToMax(cleaned, maxChars);
                    if (capped !== localContent) {
                        localContent = capped;
                    }
                    if (isShortScript) {
                        localContent = truncateToMax(localContent, 500);
                    } else {
                        // Append CTA for TCM niche
                        const ctaWord = getCtaKeyword(topic.title);
                        const cta = `\n\n如果覺得今天倪師講的這番話對你有幫助，请動動你的手，點個讚、訂閱並轉發。如果你聽懂了，请在留言區打一個「${ctaWord}」或留一句祈福的話，為自己與家人積聚正向磁場。`;
                        localContent = `${localContent}${cta}`;
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
                    localContent = cleaned;
                    if (isShortScript) {
                        localContent = truncateToMax(localContent, 500);
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
                } else if (niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO) {
                    localContent = cleaned;
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
                    // 新闻评论：优先保证内容完整性
                    if (niche === NicheType.GENERAL_VIRAL) {
                        // 检查是否有"下期再见"收尾
                        const hasEnding = hasEndingIndicators(cleaned);
                        if (hasEnding) {
                            // 有收尾语，保留完整内容，即使超过8000字
                            console.log('[Generator] Content has proper ending, keeping full content even if exceeds limit');
                            localContent = cleaned;
                        } else if (cleaned.length > maxChars) {
                            // 没有收尾语且超过上限（不应该发生），截断到上限
                            console.log('[Generator] Content exceeds limit without ending, truncating');
                            const capped = truncateToMax(cleaned, maxChars);
                            localContent = capped;
                        } else {
                            localContent = cleaned;
                        }
                    } else {
                        // 其他类型内容的处理
                        if (cleaned.length > maxChars) {
                            const capped = truncateToMax(cleaned, maxChars);
                            localContent = capped;
                        } else {
                            localContent = cleaned;
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
                            ? 'Continue the story in first person. Start your output with a single line of "-----" and then continue immediately. Use a brief, natural transition sentence and move the plot forward. Do not repeat earlier content. Do not output any meta text.'
                            : '请用第一人称续写故事。输出第一行必須是「-----」，下一行直接续写正文。使用簡短自然的過渡句直接銜接情節，保持原有風格與節奏，不要重覆前文。不要输出任何元信息。',
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
                }

                if (!ended) {
                    const endPrompt = [
                        isEnglish
                            ? 'Conclude the story now with a clear, final ending. Start your output with a single line of "-----" and then continue immediately. Keep first person and do not add any headings or summaries. Make sure it reads like a complete short story.'
                            : '请用第一人称收尾。输出第一行必须是「-----」，下一行直接续写正文。给出清楚结局，不要标题或总结。',
                        cnLongFlavor,
                        '',
                        localContent.slice(-2500)
                    ].join('\n');

                    await streamContentGeneration(
                        endPrompt,
                        systemInstruction,
                        appendChunk
                    );
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
                    
                    // 计算百分比（最多95%，留5%给收尾和清理）
                    const progress = Math.min(95, (totalGeneratedLength / expectedTotalLength) * 100);
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
    
    // 获取最终生成的内容数量（从 Map 中获取，因为状态可能还没更新）
    const finalCount = generatedContentsMap.size > 0 ? generatedContentsMap.size : generatedContents.length;
    
    // 显示完成通知
    console.log('[Generator] 准备显示 Toast 通知:', { 
      finalCount, 
      hasToast: !!toast,
      isExternal: toast === externalToast,
      isInternal: toast === internalToast,
      toastType: typeof toast,
      hasSuccess: toast && 'success' in toast,
      successType: toast && typeof toast.success,
      currentToasts: toast?.toasts?.length || 0,
    });
    
    // ⚠️ 关键：必须使用 externalToast（App.tsx 中的 toast 实例）
    // 因为 ToastContainer 在 App.tsx 中使用的是 App 的 toast.toasts
    if (!externalToast) {
      console.error('[Generator] externalToast 未传入！无法显示 Toast 通知');
      return;
    }
    
    console.log('[Generator] 使用 externalToast:', {
      hasSuccess: typeof externalToast.success === 'function',
      currentToasts: externalToast.toasts?.length || 0,
      toastKeys: Object.keys(externalToast)
    });
    
    if (typeof externalToast.success === 'function') {
      try {
        console.log('[Generator] 调用 externalToast.success，参数:', {
          message: `成功生成 ${finalCount} 篇文章！`,
          duration: 8000
        });
        const result = externalToast.success(`成功生成 ${finalCount} 篇文章！`, 8000);
        console.log('[Generator] externalToast.success 调用成功，返回 ID:', result);
        
        // 延迟检查状态（React 状态更新是异步的）
        setTimeout(() => {
          console.log('[Generator] Toast 状态检查（延迟 200ms）:', {
            toastsLength: externalToast.toasts?.length || 0,
            toasts: externalToast.toasts?.map(t => ({ id: t.id, type: t.type, message: t.message })) || []
          });
        }, 200);
      } catch (error) {
        console.error('[Generator] externalToast.success 调用失败:', error);
      }
    } else {
      console.error('[Generator] externalToast.success 不是函数:', {
        success: externalToast.success,
        successType: typeof externalToast.success
      });
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
                return; // 无法确定子模式，不保存
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
         <h2 className="text-lg font-medium text-slate-300 mb-6 flex items-center gap-2">
          <span className="bg-emerald-600 w-6 h-6 rounded-full flex items-center justify-center text-xs text-white">2</span>
          策划选题 (Plan Topics)
        </h2>
        
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
                        <button
                            key={mode.id}
                            onClick={() => handleSubModeChange(niche, mode.id, setActiveFunc)}
                            className={`p-3 rounded-lg border text-left transition-all relative overflow-hidden ${
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
                                    <History size={12} className="text-emerald-400" title="有历史记录" />
                                )}
                            </div>
                            <p className="text-[10px] text-slate-500 leading-tight">
                                {mode.subtitle}
                            </p>
                        </button>
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
        {(niche === NicheType.TCM_METAPHYSICS || niche === NicheType.FINANCE_CRYPTO || niche === NicheType.PSYCHOLOGY || niche === NicheType.PHILOSOPHY_WISDOM || niche === NicheType.EMOTION_TABOO) && (
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
                    : '短视频：在选题基础上详细展开，加入排比与总结排列，输出 500 字以内短视频文案。'}
            </p>
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
                {isInputRequired() ? '预测选题' : '一键生成爆款Hooks'}
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
        {topics.length > 0 && !(niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION) && (
            <div className="mt-8 animate-in slide-in-from-bottom-4 duration-500">
                <div className="flex justify-between items-center mb-3">
                    <span className="text-sm text-slate-400">
                        {niche === NicheType.STORY_REVENGE 
                            ? `选择要生成的故事 (${storyDuration === StoryDuration.SHORT ? '短篇' : '長篇'}/${storyLanguage}):`
                            : "选择要生成的長文 (約 8000 字/篇):"
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
                    />
                  </div>
                )}
                
                <div className="flex justify-end">
                     <button 
                        onClick={handleBatchGenerate}
                        disabled={status === GenerationStatus.WRITING}
                        className="w-full md:w-auto px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-900/20 flex items-center justify-center gap-2 transition-all transform hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:transform-none"
                    >
                        {status === GenerationStatus.WRITING ? (
                            <>
                                <Loader2 className="animate-spin" />
                                {niche === NicheType.STORY_REVENGE ? '正在撰寫視覺化腳本...' : '正在撰寫 8000 字長文中...'}
                            </>
                        ) : (
                            <>
                                啟動{niche === NicheType.STORY_REVENGE ? '故事引擎 (v22.0)' : '極速撰寫'}
                                <Zap size={18} fill="currentColor" />
                            </>
                        )}
                    </button>
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
                                
                                <div className="flex items-center gap-2 flex-shrink-0">
                                    {/* Continue button removed: auto-continue only */}

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
          onDelete={(timestamp) => {
            if (pendingSubModeChange) {
              const historyKey = getHistoryKeyForSubMode(pendingSubModeChange.niche, pendingSubModeChange.submode);
              deleteHistory('generator', historyKey, timestamp);
              setHistoryRecords(getHistory('generator', historyKey));
            }
          }}
          title="选择历史记录"
        />
      )}
    </div>
  );
};