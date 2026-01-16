import React, { useState, useRef, useEffect } from 'react';
import { ApiProvider, NicheType, Topic, GeneratedContent, GenerationStatus, TcmSubModeId, FinanceSubModeId, RevengeSubModeId, NewsSubModeId, StoryLanguage, StoryDuration } from '../types';
import { NICHES, TCM_SUB_MODES, FINANCE_SUB_MODES, REVENGE_SUB_MODES, NEWS_SUB_MODES } from '../constants';
import { NicheSelector } from './NicheSelector';
import { generateTopics, streamContentGeneration, initializeGemini } from '../services/geminiService';
import { Sparkles, Calendar, Loader2, Download, Eye, Zap, AlertTriangle, Copy, Check, Globe, Clock, PlusCircle } from 'lucide-react';
import JSZip from 'jszip';

interface GeneratorProps {
  apiKey: string;
  provider: ApiProvider;
}

export const Generator: React.FC<GeneratorProps> = ({ apiKey, provider }) => {
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
  
  const [errorMsg, setErrorMsg] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logic
  useEffect(() => {
    if (activeIndices.has(viewIndex) && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [generatedContents, viewIndex, activeIndices]);

  // Reset input when niche or submode changes
  useEffect(() => {
    setInputVal('');
    setTopics([]);
    setAdaptedContent('');
    setIsAdapting(false);
  }, [niche, tcmSubMode, financeSubMode, revengeSubMode, newsSubMode]);

  // SAFE ACCESS HELPER
  const getCurrentSubModeConfig = () => {
    if (niche === NicheType.TCM_METAPHYSICS) return TCM_SUB_MODES[tcmSubMode];
    if (niche === NicheType.FINANCE_CRYPTO) return FINANCE_SUB_MODES[financeSubMode];
    if (niche === NicheType.STORY_REVENGE) return REVENGE_SUB_MODES[revengeSubMode];
    if (niche === NicheType.GENERAL_VIRAL) return NEWS_SUB_MODES[newsSubMode];
    return null;
  };

  const getSubModesForRender = () => {
     if (niche === NicheType.TCM_METAPHYSICS) return TCM_SUB_MODES;
     if (niche === NicheType.FINANCE_CRYPTO) return FINANCE_SUB_MODES;
     if (niche === NicheType.STORY_REVENGE) return REVENGE_SUB_MODES;
     if (niche === NicheType.GENERAL_VIRAL) return NEWS_SUB_MODES;
     return null;
  };

  const isInputRequired = () => {
    const config = getCurrentSubModeConfig();
    if (config) return config.requiresInput;
    return true; // Default input required for other niches
  };

  const shouldShowInput = () => {
    const config = getCurrentSubModeConfig();
    if (config) return config.requiresInput || config.optionalInput;
    return true;
  };

  const getInputPlaceholder = () => {
      const config = getCurrentSubModeConfig();
      if (config) return config.inputPlaceholder || "輸入關鍵詞";
      return "輸入關鍵詞/趨勢";
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
          return "網絡連接失敗。請檢查：1) 網絡連接是否正常 2) API Key 是否正確設置 3) Base URL 是否可訪問 4) 瀏覽器控制台是否有 CORS 錯誤";
      } else if (msgLower.includes('not initialized')) {
          return "API 未初始化。請確保已在設置中輸入 API Key 並點擊「完成」按鈕。";
      } else if (msgLower.includes('api key') || msgLower.includes('unauthorized') || msgLower.includes('401') || msgLower.includes('403')) {
          return "API Key 無效或未授權。請檢查：1) API Key 是否正確 2) API Key 是否已過期 3) API Key 是否有相應權限。";
      } else if (msgLower.includes('xhr error') || msgLower.includes('500') || msgLower.includes('rpc failed')) {
          return "網絡連接或服務器暫時不穩定 (500/XHR)。請檢查您的網絡連接或稍後再試。";
      } else if (msgLower.includes('429') || msgLower.includes('quota') || msgLower.includes('resource_exhausted')) {
          return "API 配額已滿 (429)。建議等待 1 分鐘後再試。";
      } else if (msgLower.includes('cors')) {
          return "CORS 跨域錯誤。請檢查 Base URL 配置或使用代理服務。";
      }
      
      // Truncate very long error messages
      return msg.length > 200 ? msg.substring(0, 200) + "..." : msg;
  };

  const handlePlanTopics = async () => {
    if (!apiKey || !apiKey.trim()) {
        setErrorMsg("請先在設置中輸入您的 API Key。");
        return;
    }

    // Initialize API
    initializeGemini(apiKey, { provider });
    
    setStatus(GenerationStatus.PLANNING);
    setErrorMsg('');

    const config = NICHES[niche];
    if (!config) {
        setErrorMsg("配置錯誤：找不到該賽道配置");
        return;
    }

    let prompt = '';

    // Logic for Niches with Sub-Modes
    const subModeConfig = getCurrentSubModeConfig();

    if (subModeConfig) {
        // Check input requirement
        if (subModeConfig.requiresInput && !inputVal) {
             setErrorMsg(`請輸入${subModeConfig.title.split('：')[0]}所需的資訊。`);
             return;
        }

        prompt = subModeConfig.prompt;
        
        // --- Input Injection Logic ---
        // 1. User Input
        if (inputVal) {
            prompt = prompt.replace('{input}', inputVal);
            if (niche === NicheType.FINANCE_CRYPTO) {
                prompt += `\n\n# 關鍵詞強制規則\n所有輸出標題必須包含關鍵詞「${inputVal}」，不得省略或替換。`;
            }
        } else {
            prompt = prompt.replace(/.*\{input\}.*\n?/g, '').replace('{input}', '');
        }
        
        // 2. Story Specific Injection
        if (niche === NicheType.STORY_REVENGE) {
             prompt = prompt.replace('{language}', storyLanguage);
             prompt = prompt.replace('{duration}', storyDuration);
        }

    } else {
        // Logic for other niches without sub-modes
        if (!inputVal) {
             setErrorMsg("請輸入關鍵詞。");
             return;
        }
        prompt = config.topicPromptTemplate.replace('{input}', inputVal);
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
      setErrorMsg(parseErrorMessage(err));
      setStatus(GenerationStatus.ERROR);
    }
  };

  // Handle adaptation for ShadowWriter mode
  const handleAdaptContent = async () => {
    if (!apiKey || !apiKey.trim()) {
      setErrorMsg("請先在設置中輸入您的 API Key。");
      return;
    }

    if (!inputVal || !inputVal.trim()) {
      setErrorMsg("請輸入需要改編的原文內容。");
      return;
    }

    // Initialize API
    initializeGemini(apiKey, { provider });
    
    setIsAdapting(true);
    setAdaptedContent('');
    setErrorMsg('');

    // Calculate source text length
    const sourceLength = inputVal.trim().length;
    const targetLength = Math.max(sourceLength, Math.floor(sourceLength * 1.1)); // At least same length, or 10% more
    const minLength = Math.floor(sourceLength * 0.95); // 95% of source as minimum
    const maxLength = Math.floor(sourceLength * 1.5); // 150% of source as maximum

    const config = NICHES[niche];
    if (!config) {
      setErrorMsg("配置錯誤：找不到該賽道配置");
      return;
    }

    // ShadowWriter system prompt - Structure Preservation Mode
    const shadowWriterSystemPrompt = `**Role:** You are **ShadowWriter (暗影写手)**, an elite story architect specializing in deep rewriting while preserving original structure and paragraphs.

**Core Objective:** Deeply rewrite the source material paragraph by paragraph, maintaining the exact same structure, paragraph breaks, and narrative flow. Change only the wording, expressions, and details to pass originality checks, while keeping the story structure identical.

🧠 **Core Competencies (核心能力)**

1. **Structure Preservation (結構保持 - CRITICAL)**
   - **MUST preserve**: Original paragraph structure, paragraph breaks, narrative sequence
   - **MUST preserve**: Story flow, scene order, character introduction order
   - **DO NOT**: Change narrative structure, add flashbacks, or rearrange content
   - **DO NOT**: Merge or split paragraphs

2. **Deep Rewriting (深度洗稿)**
   - **Word Replacement**: Replace every sentence with different wording while keeping the same meaning
   - **Expression Enhancement**: Use more vivid, emotional expressions
   - **Detail Expansion**: Add more descriptive details within the same paragraph structure
   - **Synonym Usage**: Use synonyms and alternative phrasings throughout

3. **Humanization (擬人化)**
   - Use colloquialisms, slang, inner monologues
   - Show, Don't Tell: Use actions and descriptions
   - Natural, human-like narration

**Output Language**: Use target language (${storyLanguage}) for all creative content.
**Output Format**: ONLY pure rewritten content. NO technical markers, NO meta-commentary, NO explanations.`;

    try {
      let localContent = '';
      const MAX_CONTINUATIONS = 20; // Increased for long texts
      let continuationCount = 0;
      let isFinished = false;

      const appendChunk = (chunk: string) => {
        localContent += chunk;
        setAdaptedContent(localContent);
      };

      // Helper to clean content for length calculation
      const getCleanLength = (text: string): number => {
        return text.replace(/^-----+\s*$/gm, '').replace(/\n-----+\n/g, '\n').replace(/\s+/g, '').length;
      };

      // Helper to estimate progress in source text based on adapted content length
      const estimateSourceProgress = (adaptedLength: number, sourceLength: number): number => {
        // Rough estimation: if adapted is X% of target, we've covered about X% of source
        const progressRatio = Math.min(adaptedLength / sourceLength, 1);
        return Math.floor(sourceLength * progressRatio);
      };

      // Split source text into paragraphs for reference
      const sourceParagraphs = inputVal.split(/\n\s*\n/).filter(p => p.trim().length > 0);
      const sourceParagraphCount = sourceParagraphs.length;

      // Initial adaptation - rewrite from beginning
      const initialPrompt = `# ShadowWriter 深度洗稿任務（結構保持模式）

## 原始素材完整內容 (Complete Source Material)
${inputVal}

## 洗稿要求 (Rewriting Requirements)

### 核心原則 (CRITICAL RULES)
1. **結構保持**：必須完全保持原文的段落結構、段落順序、段落數量
2. **逐段洗稿**：按照原文的段落順序，逐段進行深度洗稿
3. **字數保證**：每個段落洗稿後的字數應該接近或略多於原文對應段落
4. **不改變結構**：嚴禁合併段落、拆分段落、改變段落順序

### 字數要求 (CRITICAL)
- **原文字數**：${sourceLength} 字
- **目標字數**：${targetLength} 字（必須達到或超過原文字數）
- **最小字數**：${minLength} 字（不得少於原文的 95%）
- **段落數量**：原文共 ${sourceParagraphCount} 個段落，必須保持相同數量

### 洗稿策略 (Rewriting Strategy)
1. **詞彙替換**：將每個句子用不同的詞彙和表達方式重寫，保持相同意思
2. **句式變換**：改變句子結構（主動變被動、長句變短句、短句合併等）
3. **細節擴充**：在保持段落結構的前提下，適當增加描述性細節
4. **語氣調整**：使用更生動、更情緒化的表達方式
5. **同義替換**：大量使用同義詞、近義詞替換原有詞彙

### 輸出要求
- 目標語言：${storyLanguage}
- **逐段洗稿**：按照原文段落順序，逐段輸出洗稿後的內容
- **保持段落**：每個段落之間用空行分隔，保持原文的段落結構
- **續寫標記**：如果一次性無法完成全部內容，在最後一個完整段落後輸出「-----」（5個橫線），系統會自動續寫
- **禁止提前收尾**：在未完成全部段落洗稿前，嚴禁使用任何收尾語
- **絕對純淨輸出**：只輸出洗稿後的內容，嚴禁輸出任何技術標記、元信息或解釋

## 開始洗稿
請從第一段開始，按照原文的段落順序，逐段進行深度洗稿。`;

      await streamContentGeneration(
        initialPrompt,
        shadowWriterSystemPrompt,
        appendChunk
      );

      // Continuation loop - continue rewriting remaining paragraphs
      while (continuationCount < MAX_CONTINUATIONS && !isFinished) {
        // Wait a bit for content to settle
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Clean content for length calculation
        const cleanedContent = localContent.replace(/^-----+\s*$/gm, '').replace(/\n-----+\n/g, '\n');
        const currentLength = getCleanLength(cleanedContent);
        
        // Estimate how much of source we've covered
        const estimatedSourceProgress = estimateSourceProgress(currentLength, sourceLength);
        const remainingSourceLength = sourceLength - estimatedSourceProgress;
        
        console.log(`[Adaptation] Current: ${currentLength} chars, Source: ${sourceLength} chars, Progress: ~${Math.floor((currentLength / sourceLength) * 100)}%`);

        // Check if we've covered enough content
        if (currentLength >= minLength && currentLength >= sourceLength * 0.9) {
          // Close to or exceeding source length, check if we need to finish
          if (currentLength >= sourceLength * 0.95) {
            console.log(`[Adaptation] Content length ${currentLength} meets requirement, finishing`);
            isFinished = true;
            break;
          }
        }

        // Continue rewriting if not enough length
        if (currentLength < minLength || currentLength < sourceLength * 0.9) {
          continuationCount += 1;
          
          // Get the last part of adapted content for context
          const adaptedContext = cleanedContent.slice(-3000);
          
          // More accurate estimation: use paragraph-based progress
          const adaptedParagraphs = cleanedContent.split(/\n\s*\n/).filter(p => p.trim().length > 0);
          const adaptedParagraphCount = adaptedParagraphs.length;
          
          // Estimate progress based on paragraph count
          const paragraphProgress = Math.min(adaptedParagraphCount / sourceParagraphCount, 0.95);
          const sourceStartIndex = Math.floor(paragraphProgress * inputVal.length);
          const remainingSource = inputVal.slice(sourceStartIndex);
          
          // Get next portion of source (enough for continuation)
          const sourceContext = remainingSource.slice(0, Math.min(8000, remainingSource.length));
          
          const continuePrompt = `# 繼續洗稿任務（比對原文續寫）

你正在逐段洗稿一個故事，當前已洗稿 ${currentLength} 字，原文共 ${sourceLength} 字。

## 進度狀態
- 已洗稿字數：${currentLength} 字
- 目標字數：${targetLength} 字（原文 ${sourceLength} 字）
- 已洗稿段落：約 ${adaptedParagraphCount} 個段落
- 原文總段落：${sourceParagraphCount} 個段落
- 預計進度：約 ${Math.floor((currentLength / sourceLength) * 100)}%
- 仍需洗稿：約 ${remainingSourceLength} 字

## 原文剩餘部分（必須比對此部分繼續洗稿）
以下是原文中尚未洗稿的部分，你必須按照此部分的內容和段落結構進行洗稿：

${sourceContext}

## 已洗稿內容（最後 3000 字，供參考上下文和銜接）
${adaptedContext}

## 洗稿要求（CRITICAL）
1. **比對原文洗稿**：必須比對上述「原文剩餘部分」，按照原文的段落順序逐段洗稿
2. **保持段落結構**：必須保持原文的段落結構、段落順序、段落數量
3. **字數保證**：每個段落洗稿後的字數應該接近或略多於原文對應段落
4. **逐段完成**：必須完成原文剩餘部分的所有段落洗稿
5. **續寫標記**：如果本次輸出無法完成全部剩餘內容，在最後一個完整段落後輸出「-----」（5個橫線）
6. **禁止提前收尾**：在未完成全部段落洗稿前，嚴禁使用任何收尾語（如「完結」「結局」「結束」「全書完」等）
7. **輸出格式**：輸出第一行必須是「-----」，下一行直接開始洗稿剩餘段落
8. **保持連貫**：確保與前文自然銜接，保持故事連貫

## 開始繼續洗稿
請從「-----」下一行開始，比對「原文剩餘部分」，按照原文的段落順序繼續逐段進行深度洗稿。`;

          await streamContentGeneration(
            continuePrompt,
            shadowWriterSystemPrompt,
            appendChunk
          );
        } else {
          // Already reached minimum length
          isFinished = true;
          break;
        }
      }

      // Clean up continuation markers (-----)
      localContent = localContent
        .replace(/^-----+\s*$/gm, '') // Remove standalone ----- lines
        .replace(/\n-----+\n/g, '\n') // Remove ----- between lines
        .replace(/-----+/g, '') // Remove any remaining -----
        .replace(/\n\s*\n\s*\n+/g, '\n\n') // Clean up multiple blank lines
        .trim();
      
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

  const handleBatchGenerate = async () => {
    if (!apiKey || !apiKey.trim()) {
        setErrorMsg("請先在設置中輸入您的 API Key。");
        return;
    }
    
    const selectedTopics = topics.filter(t => t.selected);
    if (selectedTopics.length === 0) {
        setErrorMsg("請至少選擇一個選題。");
        return;
    }

    // Initialize API
    initializeGemini(apiKey, { provider });

    setStatus(GenerationStatus.WRITING);
    setErrorMsg('');
    
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
            .replace(/^\s*總結[:：].*$/gmi, '')
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

    const generationPromises = selectedTopics.map(async (topic, index) => {
        // Determine the correct script template
        let scriptTemplate = config.scriptPromptTemplate;
        const subModeConfig = getCurrentSubModeConfig();
        
        if (subModeConfig && subModeConfig.scriptPromptTemplate) {
            scriptTemplate = subModeConfig.scriptPromptTemplate;
        }

        // Use the selected script prompt
        let prompt = scriptTemplate.replace('{topic}', topic.title);
        
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
                niche === NicheType.GENERAL_VIRAL;
            const isRevengeShort =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.SHORT;
            const isRevengeLong =
                niche === NicheType.STORY_REVENGE && storyDuration === StoryDuration.LONG;

            if (shouldEnforceLength) {
                let continueCount = 0;
                const minChars =
                    niche === NicheType.TCM_METAPHYSICS
                        ? MIN_TCM_SCRIPT_CHARS
                        : niche === NicheType.FINANCE_CRYPTO
                            ? MIN_FIN_SCRIPT_CHARS
                            : MIN_NEWS_SCRIPT_CHARS;
                const maxChars =
                    niche === NicheType.TCM_METAPHYSICS
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
                        const continuePrompt = [
                            niche === NicheType.GENERAL_VIRAL
                                ? `請用第一人稱續寫新聞評論，保持評論員的犀利與獨家視角，不要重覆前文。當前已寫${currentLength}字，如果內容充分完整且達到4000字以上，可以自然收尾並以「下期再見」「我們下期見」或「咱們下期再見」結束。如果內容尚不完整，請繼續深入分析，暫時不要收尾。`
                                : '請續寫以下內容，保持原風格與第一人稱口吻，不要重覆前文。',
                            '不要出現「下課」「今天的課到這裡」等其他收尾語。',
                            '輸出第一行必須是「-----」，下一行直接續寫正文。',
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
                            '請用第一人稱對上述內容進行總結收尾，結尾要升華點題並形成明確觀點收束。',
                            '最後必須以「下期再見」或「咱們下期再見」或「我們下期見」作為結尾語。',
                            '輸出第一行必須是「-----」，下一行直接續寫收尾段落。',
                            '不要標題、不要段落標記、不要元信息。',
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
                } else if (niche === NicheType.FINANCE_CRYPTO) {
                    localContent = cleaned;
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

                // Append CTA for TCM niche
                if (niche === NicheType.TCM_METAPHYSICS) {
                    const ctaWord = getCtaKeyword(topic.title);
                    const cta = `\n\n如果覺得今天倪師講的這番話對你有幫助，請動動你的手，點個讚、訂閱並轉發。如果你聽懂了，請在留言區打一個「${ctaWord}」或留一句祈福的話，為自己與家人積聚正向磁場。`;
                    localContent = `${localContent}${cta}`;
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
                            : '請用第一人稱續寫故事。輸出第一行必須是「-----」，下一行直接續寫正文。使用簡短自然的過渡句直接銜接情節，保持原有風格與節奏，不要重覆前文。不要輸出任何元信息。',
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
                            : '請用第一人稱收尾。輸出第一行必須是「-----」，下一行直接續寫正文。給出清楚結局，不要標題或總結。',
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
                        '請用中文輸出 2-4 句的簡短故事總結，不得超過 200 字。',
                        '只輸出總結內容，不要標題、不要符號、不要前言後語。',
                        '禁止輸出例如「Suggested Title Options」或任何非故事總結內容。',
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
        }
    });

    // Wait for all to finish (or fail)
    await Promise.all(generationPromises);

    setStatus(GenerationStatus.COMPLETED);
  };

  const handleContinueGeneration = async () => {
      if (!apiKey || !apiKey.trim()) {
          setErrorMsg("請先在設置中輸入您的 API Key。");
          return;
      }
      
      if (generatedContents.length === 0) {
          setErrorMsg("沒有可續寫的內容。");
          return;
      }

      // Initialize API
      const { initializeGemini } = await import('../services/geminiService');
      initializeGemini(apiKey, { provider });

      const currentContent = generatedContents[viewIndex];
      const subModeConfig = getCurrentSubModeConfig();

      if (!subModeConfig || !subModeConfig.continuePromptTemplate) {
          setErrorMsg("此模式不支持自動續寫。");
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
              newArr[newIndex].content += `\n\n[續寫失敗: ${cleanMsg}]`;
              return newArr;
          });
      } finally {
          setActiveIndices(prev => {
              const newSet = new Set(prev);
              newSet.delete(newIndex);
              return newSet;
          });
          setStatus(GenerationStatus.COMPLETED);
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
          <span className="bg-indigo-600 w-6 h-6 rounded-full flex items-center justify-center text-xs text-white">1</span>
          選擇賽道 (Select Track)
        </h2>
        <NicheSelector selectedNiche={niche} onSelect={setNiche} />
      </section>

      {/* 2. Planning Phase */}
      <section className="bg-slate-900/50 border border-slate-800 rounded-2xl p-6">
         <h2 className="text-lg font-medium text-slate-300 mb-6 flex items-center gap-2">
          <span className="bg-indigo-600 w-6 h-6 rounded-full flex items-center justify-center text-xs text-white">2</span>
          策劃選題 (Plan Topics)
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
                    
                    return (
                        <button
                            key={mode.id}
                            onClick={() => setActiveFunc(mode.id)}
                            className={`p-3 rounded-lg border text-left transition-all relative overflow-hidden ${
                                isSelected 
                                ? 'bg-indigo-900/40 border-indigo-500 ring-1 ring-indigo-500' 
                                : 'bg-slate-800/40 border-slate-700 hover:bg-slate-800 hover:border-slate-600'
                            }`}
                        >
                            <div className="flex items-center gap-2 mb-2">
                                <Icon size={18} className={isSelected ? 'text-indigo-400' : 'text-slate-400'} />
                                <span className={`text-xs font-bold ${isSelected ? 'text-white' : 'text-slate-300'}`}>
                                    {mode.title.split('：')[0].split('(')[0]}
                                </span>
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
                    <label className="text-xs font-bold text-indigo-400 flex items-center gap-1">
                        <Globe size={14} /> 目標語言 (Target Language)
                    </label>
                    <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                         {Object.values(StoryLanguage).map((lang) => (
                             <button
                                key={lang}
                                onClick={() => setStoryLanguage(lang)}
                                className={`px-2 py-1.5 rounded text-xs border transition-all ${
                                    storyLanguage === lang 
                                    ? 'bg-indigo-600 text-white border-indigo-500' 
                                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                                }`}
                             >
                                 {lang}
                             </button>
                         ))}
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-xs font-bold text-indigo-400 flex items-center gap-1">
                        <Clock size={14} /> 故事時長 (Story Duration)
                    </label>
                    <div className="flex gap-2">
                         <button
                            onClick={() => setStoryDuration(StoryDuration.SHORT)}
                            className={`flex-1 px-3 py-1.5 rounded text-xs border transition-all ${
                                storyDuration === StoryDuration.SHORT 
                                ? 'bg-indigo-600 text-white border-indigo-500' 
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                            }`}
                         >
                             短篇 (15-30m)
                         </button>
                         <button
                            onClick={() => setStoryDuration(StoryDuration.LONG)}
                            className={`flex-1 px-3 py-1.5 rounded text-xs border transition-all ${
                                storyDuration === StoryDuration.LONG 
                                ? 'bg-indigo-600 text-white border-indigo-500' 
                                : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                            }`}
                         >
                             長篇 (1hr+)
                         </button>
                    </div>
                </div>
             </div>
        )}

        {/* Input Area (Conditional) */}
        {niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION ? (
          // Adaptation Mode: Large textarea input + output area
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-sm text-slate-400 font-medium">
                輸入原文 (Source Text)
              </label>
              <textarea
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder="請在此粘貼需要改編的原文內容..."
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all resize-none custom-scrollbar h-[300px]"
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
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    <Copy size={12} /> 複製
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
                  <div className="text-slate-600 text-sm">改編後的內容將顯示於此</div>
                ))}
                {isAdapting && adaptedContent && <span className="inline-block w-2 h-4 bg-indigo-500 ml-1 animate-pulse" />}
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
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-10 pr-4 py-3 text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                            />
                        </div>
                    </div>
                ) : (
                    <div className="p-4 bg-indigo-900/20 border border-indigo-500/30 rounded-lg flex items-center gap-3 animate-in fade-in duration-300">
                        <div className="bg-indigo-600/20 p-2 rounded-full">
                            <Sparkles className="text-indigo-400 w-5 h-5" />
                        </div>
                        <div>
                            <p className="text-indigo-200 text-sm font-medium">智能生成就緒</p>
                            <p className="text-indigo-300/60 text-xs">此模式無需輸入，AI 將自動根據核心邏輯生成爆款選題。</p>
                        </div>
                    </div>
                )}
            </div>

            <button 
                onClick={handlePlanTopics}
                disabled={status === GenerationStatus.PLANNING}
                className={`mt-0 md:mt-7 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 w-full md:w-auto justify-center whitespace-nowrap shadow-lg shadow-indigo-900/20`}
            >
                {status === GenerationStatus.PLANNING ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {isInputRequired() ? '預測選題' : '一鍵生成爆款Hooks'}
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

        {errorMsg && <div className="mt-4 p-3 bg-red-900/20 border border-red-800 text-red-200 rounded-lg text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2"><AlertTriangle size={16}/> {errorMsg}</div>}

        {/* Topics List - Hide in Adaptation Mode */}
        {topics.length > 0 && !(niche === NicheType.STORY_REVENGE && revengeSubMode === RevengeSubModeId.ADAPTATION) && (
            <div className="mt-8 animate-in slide-in-from-bottom-4 duration-500">
                <div className="flex justify-between items-center mb-3">
                    <span className="text-sm text-slate-400">
                        {niche === NicheType.STORY_REVENGE 
                            ? `選擇要生成的故事 (${storyDuration === StoryDuration.SHORT ? '短篇' : '長篇'}/${storyLanguage}):`
                            : "選擇要生成的長文 (約 8000 字/篇):"
                        }
                    </span>
                    <span className="text-sm text-indigo-400 font-medium">已選 {topics.filter(t => t.selected).length} 個</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[350px] overflow-y-auto pr-2 custom-scrollbar mb-6">
                    {topics.map(topic => (
                        <div 
                            key={topic.id}
                            onClick={() => toggleTopic(topic.id)}
                            className={`p-4 rounded-lg border cursor-pointer transition-all flex items-start gap-3 group ${
                                topic.selected 
                                ? 'bg-indigo-900/30 border-indigo-500/50 shadow-inner' 
                                : 'bg-slate-800 border-slate-700 opacity-70 hover:opacity-100 hover:border-slate-500'
                            }`}
                        >
                            <div className={`w-5 h-5 rounded border mt-0.5 flex items-center justify-center flex-shrink-0 transition-colors ${topic.selected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-500 group-hover:border-slate-400'}`}>
                                {topic.selected && <Sparkles size={12} className="text-white" />}
                            </div>
                            <span className="text-sm text-slate-200 leading-snug font-medium">{topic.title}</span>
                        </div>
                    ))}
                </div>
                
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
                    <span className="bg-indigo-600 w-6 h-6 rounded-full flex items-center justify-center text-xs text-white">3</span>
                    即時編輯器 (Live Editor)
                    {activeIndices.size > 0 && <span className="text-xs text-emerald-400 animate-pulse font-mono">({activeIndices.size} writing...)</span>}
                </h2>
                {status === GenerationStatus.COMPLETED && (
                    <button onClick={downloadAll} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-md border border-slate-700 text-sm flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition-all shadow-sm">
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
                                ? 'bg-indigo-900/40 border-indigo-500 shadow-md ring-1 ring-indigo-500/50' 
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
                                    <span className={`font-mono text-xs ${idx === viewIndex ? 'text-indigo-200' : 'text-slate-400'}`}>Topic {idx + 1}</span>
                                </div>
                                {idx === viewIndex && <Eye size={14} className="text-indigo-400" />}
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
                                        title="複製全文"
                                    >
                                        {copiedId === viewIndex ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                        {copiedId === viewIndex ? '已複製' : '複製'}
                                    </button>
                                </div>
                            </div>

                            <div className="whitespace-pre-wrap leading-relaxed tracking-wide text-slate-300">
                                {generatedContents[viewIndex].content}
                                {activeIndices.has(viewIndex) && <span className="inline-block w-2 h-4 bg-indigo-500 ml-1 animate-pulse" />}
                            </div>
                        </div>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-4">
                            <div className="w-16 h-16 rounded-full bg-slate-900 flex items-center justify-center">
                                <Eye className="w-8 h-8 text-slate-700" />
                            </div>
                            <p>請從左側選擇一個選題以查看內容...</p>
                        </div>
                    )}
                </div>
             </div>
        </section>
      )}
    </div>
  );
};