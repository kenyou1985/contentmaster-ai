/**
 * ContentMaster AI - 字幕智能优化服务
 *
 * 使用 AI 根据上下文和语境纠正 ASR 识别的字幕错误：
 * - 同音字错误（如"万安"误识别为"万安"需确认）
 * - 人名、专业术语纠正
 * - 语句通顺性和语义修正
 *
 * 依赖：geminiService.ts 的 AI 调用能力
 */

/**
 * 字幕片段类型（兼容旧定义）
 */
export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

// 兼容旧的导入路径（不引发循环依赖）
export type { SubtitleCue as CustomSubtitleCue };

/**
 * 支持的目标语言
 */
export type TargetLanguage = 'auto' | 'zh' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'es' | 'fr' | 'de' | 'ru';

export const SUPPORTED_LANGUAGES: { code: TargetLanguage; label: string; flag: string }[] = [
  { code: 'auto', label: '自动检测（保留原语言）', flag: '🌐' },
  { code: 'zh', label: '简体中文', flag: '🇨🇳' },
  { code: 'zh-TW', label: '繁體中文', flag: '🇹🇼' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
];

/**
 * 优化结果
 */
export interface OptimizationResult {
  success: boolean;
  optimizedCues: SubtitleCue[];
  error?: string;
  correctedCount?: number; // 实际被修改的字幕条数
}

/**
 * 字幕优化选项
 */
export interface OptimizeSubtitlesOptions {
  /** 主模型名称，默认 gemini-3.1-pro-preview */
  primaryModel?: string;
  /** 备用模型名称，默认 gpt-5.6-luna */
  fallbackModel?: string;
  /** 目标语言：'auto'（自动检测/保持原语言）、'zh'、'en'、'ja' 等 */
  targetLanguage?: TargetLanguage | string;
  /** 源语言（ASR 输出的语言代码，可选；不传则由 AI 自动判断） */
  sourceLanguage?: string;
  /** 是否启用翻译模式（true: 翻译；false: 仅纠错，保留原语言） */
  enableTranslation?: boolean;
  /** 分批大小（字幕条数），默认 50 */
  batchSize?: number;
}

/**
 * 批量优化字幕（单次 AI 调用，性能更好）
 *
 * @param cues 原始字幕数组（按时间顺序）
 * @param apiKey AI API Key（YUNWU_API_KEY / GEMINI_API_KEY）
 * @param onProgress 进度回调 (current, total)
 * @param options 优化选项
 * @returns 优化后的字幕数组
 */
export async function optimizeSubtitles(
  cues: SubtitleCue[],
  apiKey?: string | null,
  onProgress?: (current: number, total: number) => Promise<void> | void,
  options?: OptimizeSubtitlesOptions
): Promise<OptimizationResult> {
  if (!cues || cues.length === 0) {
    return { success: true, optimizedCues: [], correctedCount: 0 };
  }

  // 优先使用传入的 apiKey，否则尝试从 localStorage 兼容旧逻辑
  const effectiveKey =
    apiKey?.trim() ||
    (typeof window !== 'undefined'
      ? localStorage.getItem('API_KEY_yunwu') ||
        localStorage.getItem('API_KEY_google') ||
        localStorage.getItem('YUNWU_API_KEY') ||
        localStorage.getItem('GEMINI_API_KEY') ||
        localStorage.getItem('OPENLUX_API_KEY') ||
        (localStorage as any).getItem('OPENAI_API_KEY')
      : null);

  console.log('[subtitleOptimizer] 开始优化字幕', {
    cueCount: cues.length,
    hasApiKey: !!effectiveKey,
    apiKeyPrefix: effectiveKey ? effectiveKey.substring(0, 8) + '...' : null,
    primaryModel: options?.primaryModel || 'gemini-3.1-pro-preview',
    enableTranslation: options?.enableTranslation,
    targetLanguage: options?.targetLanguage || 'auto',
  });

  if (!effectiveKey) {
    console.error('[subtitleOptimizer] API Key 未配置');
    return {
      success: false,
      optimizedCues: cues,
      error: '请先在设置中配置 AI API Key',
    };
  }

  const PRIMARY_MODEL = options?.primaryModel || 'gemini-3.1-pro-preview';
  const FALLBACK_MODEL = options?.fallbackModel || 'gpt-5.6-luna';
  const BATCH_SIZE = options?.batchSize ?? 50;

  let apiCall: (prompt: string, systemInstruction: string) => Promise<string>;
  try {
    const { streamContentGeneration } = await import('../services/geminiService');

    apiCall = (prompt: string, systemInstruction: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        let fullContent = '';
        let aborted = false;

        console.log('[subtitleOptimizer] 准备调用 streamContentGeneration', {
          model: PRIMARY_MODEL,
          keyPrefix: effectiveKey.substring(0, 8)
        });

        // 单次调用的超时：120s（针对 50 条一批）
        const timeoutId = setTimeout(() => {
          if (!aborted) {
            aborted = true;
            console.error('[subtitleOptimizer] 单批调用超时（120秒）');
            reject(new Error('AI 优化超时（120秒），请稍后重试'));
          }
        }, 120_000);

        // 使用 OpenLux API，通过 modelName 选择具体模型
        streamContentGeneration(
          prompt,
          systemInstruction,
          (chunk) => {
            if (!aborted) fullContent += chunk;
          },
          PRIMARY_MODEL, // 主模型
          {
            temperature: 0.3,
            maxTokens: 8192,
            apiKeyOverride: effectiveKey,
            fallbackModelOnStall: FALLBACK_MODEL // 备用模型
          }
        )
          .then((result) => {
            console.log('[subtitleOptimizer] streamContentGeneration 成功');
            if (!aborted) {
              clearTimeout(timeoutId);
              resolve(fullContent.trim());
            }
          })
          .catch((err) => {
            console.error('[subtitleOptimizer] streamContentGeneration 失败:', err.message);
            if (!aborted) {
              clearTimeout(timeoutId);
              reject(err);
            }
          });
      });
    };
  } catch (e) {
    console.error('[subtitleOptimizer] geminiService 加载失败:', e);
    return {
      success: false,
      optimizedCues: cues,
      error: 'AI 服务加载失败: ' + (e instanceof Error ? e.message : String(e)),
    };
  }

  onProgress?.(0, cues.length);

  try {
    // 根据翻译开关动态构建 system instruction
    const enableTranslation = options?.enableTranslation ?? false;
    const targetLanguage = options?.targetLanguage ?? 'auto';
    const sourceLanguage = options?.sourceLanguage;

    const systemInstruction = buildSystemInstruction({
      enableTranslation,
      targetLanguage,
      sourceLanguage,
    });

    // 大字幕列表分批处理，避免单次 token 超限 / 超时
    // - ≤50 条：单次调用
    // - >50 条：分批调用（每批 BATCH_SIZE 条），并行最多 2 批（避免触发限流）
    const batches: SubtitleCue[][] = [];
    if (cues.length <= BATCH_SIZE) {
      batches.push(cues);
    } else {
      for (let i = 0; i < cues.length; i += BATCH_SIZE) {
        batches.push(cues.slice(i, i + BATCH_SIZE));
      }
    }

    console.log(`[subtitleOptimizer] 分批处理：${cues.length} 条 → ${batches.length} 批（每批 ≤${BATCH_SIZE} 条）`);

    const optimizedAllBatches: SubtitleCue[][] = [];

    // 串行处理批次（避免触发 API 限流）
    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batch = batches[bIdx];
      const startNum = bIdx * BATCH_SIZE;
      const numberedOriginal = batch.map((c, i) => `${startNum + i + 1}. ${c.text}`).join('\n');
      const userPrompt = `请处理以下 ${batch.length} 条字幕（第 ${startNum + 1} 至 ${startNum + batch.length} 条，${batches.length > 1 ? `共 ${batches.length} 批，第 ${bIdx + 1} 批` : '单批'}）：

${numberedOriginal}

请只返回 JSON 数组，格式如：[ "处理后的第1条", "处理后的第2条", ... ]
数组长度必须等于 ${batch.length}，不要包含其他文字。`;

      console.log(`[subtitleOptimizer] 处理第 ${bIdx + 1}/${batches.length} 批（${batch.length} 条）`);

      const result = await apiCall(userPrompt, systemInstruction);
      const optimizedBatch = parseBatchResult(result, batch, startNum);

      optimizedAllBatches.push(optimizedBatch);

      // 进度回调（已处理完的条数）
      const doneSoFar = optimizedAllBatches.reduce((sum, b) => sum + b.length, 0);
      onProgress?.(doneSoFar, cues.length);
    }

    // 合并所有批次
    const optimizedCues = optimizedAllBatches.flat();

    let correctedCount = 0;
    optimizedCues.forEach((opt, idx) => {
      if (opt.text !== cues[idx].text) correctedCount++;
    });

    onProgress?.(cues.length, cues.length);

    return {
      success: true,
      optimizedCues,
      correctedCount,
    };
  } catch (e) {
    return {
      success: false,
      optimizedCues: cues,
      error: '优化失败: ' + (e instanceof Error ? e.message : String(e)),
    };
  }
}

/**
 * 根据翻译开关和目标语言，构造对应的系统提示词
 */
function buildSystemInstruction(opts: {
  enableTranslation: boolean;
  targetLanguage: TargetLanguage | string;
  sourceLanguage?: string;
}): string {
  const { enableTranslation, targetLanguage, sourceLanguage } = opts;
  const langInfo = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage);
  const targetLangLabel = langInfo ? langInfo.label : targetLanguage;

  if (!enableTranslation || targetLanguage === 'auto') {
    // 模式：仅纠错，保留原语言
    const langHint = sourceLanguage
      ? `\n源语言（ASR 识别结果）已检测为：${sourceLanguage}`
      : '';
    return `你是一个专业的多语言字幕纠错专家。

任务：根据上下文语境，一次性纠正给定的所有 ASR 字幕错误。${langHint}

纠错范围：
1. 同音字/同音词错误（如"在干嘛"误识别为"再干嘛"、"thank you"误识别为"三克油"等）
2. 人名纠正：根据上下文识别说话者提到的人物姓名
3. 专业术语：行业专业词汇的准确识别
4. 语句通顺：修正因口音、连读、吞音导致的语句不通顺
5. 繁简统一：保留原文的简体或繁体风格

重要原则：
- **绝对不要翻译**！必须保留原字幕的语言（如原字幕是英文就保留英文，日文就保留日文，中文就保留中文）
- 只修改明显的错误，保持原文风格和语义
- 不要过度修改，不要添加原文没有的内容
- 如果某条字幕没有明显错误，原样返回

输出格式：
- 你必须输出一个 JSON 数组，每个元素对应原始字幕的纠正后文本
- 数组长度必须等于输入字幕条数
- 只输出 JSON，不要包含其他说明文字
- 示例：[ "纠正后的第1条", "纠正后的第2条", ... ]`;
  }

  // 模式：翻译模式（纠错 + 翻译到目标语言）
  return `你是一个专业的多语言字幕翻译与纠错专家。

任务：根据上下文语境，一次性纠正并翻译给定的所有 ASR 字幕。

具体步骤：
1. 先识别每条字幕的原文语言（可能是中文、英文、日文、繁体中文等）
2. 纠正同音字/同音词、人名、专业术语等明显错误
3. 将纠正后的文本翻译成：${targetLangLabel}

翻译要求：
- 译文要自然流畅，符合${targetLangLabel}的表达习惯
- 保留原文的语气和情感
- 专业术语使用${targetLangLabel}的标准译法
- 人名地名按${targetLangLabel}习惯处理（可保留原文音译或使用通用译名）
- 如有俚语/成语，翻译出对应的${targetLangLabel}表达

输出格式：
- 你必须输出一个 JSON 数组，每个元素对应原始字幕的"纠正+翻译后"文本
- 数组长度必须等于输入字幕条数
- 只输出 JSON，不要包含其他说明文字
- 示例：[ "处理后的第1条", "处理后的第2条", ... ]`;
}

/**
 * 解析 AI 返回的批量字幕结果
 */
function parseBatchResult(content: string, originalCues: SubtitleCue[], startNum = 0): SubtitleCue[] {
  const trimmed = content.trim();

  // 尝试解析 JSON 数组
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        return originalCues.map((cue, idx) => {
          const item = arr[idx];
          if (typeof item === 'string') {
            return { ...cue, text: item };
          }
          if (item && typeof item === 'object' && item.text) {
            return { ...cue, text: item.text };
          }
          return cue;
        });
      }
    } catch (e) {
      // 继续尝试其他格式
    }
  }

  // 按行解析（兼容 AI 返回"1. xxx"格式）
  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= originalCues.length * 0.7) {
    return originalCues.map((cue, idx) => {
      const line = lines[idx];
      if (line) {
        // 去掉编号前缀（兼容 "1.", "1、", "1:", "1：" 等格式）
        const cleaned = line
          .replace(new RegExp(`^[\\s]*${startNum + idx + 1}[\\.、:：\\s]+`), '')
          .replace(/^[\[\(][^\]]+[\]\)]\s*/, '');
        return { ...cue, text: cleaned };
      }
      return cue;
    });
  }

  return originalCues;
}

/**
 * 快速检查单条字幕是否有明显错误（不调用 AI）
 */
export function detectLikelyErrors(text: string): string[] {
  const errors: string[] = [];

  const patterns = [
    { regex: /[a-zA-Z]{3,}/g, desc: '可能包含未翻译的英文' },
    { regex: /\d{5,}/g, desc: '可能包含错误的数字' },
    { regex: /[。！？，、；：""''（）【】]{2,}/g, desc: '标点符号重复' },
    { regex: /^\s*[的得地]/g, desc: '可能开头有语气词' },
  ];

  for (const { regex, desc } of patterns) {
    if (regex.test(text)) {
      errors.push(desc);
    }
  }

  return errors;
}

/**
 * 简化的单次优化（直接调用 AI）
 */
export async function quickOptimize(
  subtitleText: string,
  context?: string,
  apiKey?: string | null
): Promise<string> {
  const effectiveKey =
    apiKey?.trim() ||
    (typeof window !== 'undefined'
      ? localStorage.getItem('YUNWU_API_KEY') ||
        localStorage.getItem('GEMINI_API_KEY')
      : null);

  if (!effectiveKey) {
    throw new Error('请先在设置中配置 AI API Key');
  }

  const { streamContentGeneration } = await import('../services/geminiService');

  const systemInstruction = `你是一个专业的多语言字幕纠错专家。
只修改明显错误，保持原文风格和语言。不要翻译！不要添加任何解释或标记。`;

  const userPrompt = context
    ? `上下文：${context}\n请纠正：${subtitleText}\n只返回纠正后的文本。`
    : `请纠正以下字幕中的错误：${subtitleText}\n只返回纠正后的文本。`;

  return new Promise((resolve, reject) => {
    let fullContent = '';
    const timeoutId = setTimeout(() => {
      reject(new Error('AI 调用超时'));
    }, 60_000);

    streamContentGeneration(
      userPrompt,
      systemInstruction,
      (chunk) => {
        fullContent += chunk;
      },
      'gpt-5.6-luna',
      { temperature: 0.3, maxTokens: 2048, apiKeyOverride: effectiveKey }
    )
      .then(() => {
        clearTimeout(timeoutId);
        resolve(fullContent.trim());
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}
