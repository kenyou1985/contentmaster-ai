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
 * 字幕片段类型
 */
export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

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
  /** 主模型名称，默认 gpt-5.6-luna */
  primaryModel?: string;
  /** 备用模型名称，默认 gpt-5.4-mini */
  fallbackModel?: string;
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

  if (!effectiveKey) {
    return {
      success: false,
      optimizedCues: cues,
      error: '请先在设置中配置 AI API Key',
    };
  }

  const PRIMARY_MODEL = options?.primaryModel || 'gpt-5.6-luna';
  const FALLBACK_MODEL = options?.fallbackModel || 'gpt-5.4-mini';

  let apiCall: (prompt: string, systemInstruction: string) => Promise<string>;
  try {
    const { streamContentGeneration } = await import('../services/geminiService');

    apiCall = (prompt: string, systemInstruction: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        let fullContent = '';
        let aborted = false;

        const timeoutId = setTimeout(() => {
          if (!aborted) {
            aborted = true;
            reject(new Error('AI 优化超时（120秒），请稍后重试或减少字幕条数'));
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
          .then(() => {
            if (!aborted) {
              clearTimeout(timeoutId);
              resolve(fullContent.trim());
            }
          })
          .catch((err) => {
            if (!aborted) {
              clearTimeout(timeoutId);
              reject(err);
            }
          });
      });
    };
  } catch (e) {
    return {
      success: false,
      optimizedCues: cues,
      error: 'AI 服务加载失败: ' + (e instanceof Error ? e.message : String(e)),
    };
  }

  onProgress?.(0, cues.length);

  try {
    const systemInstruction = `你是一个专业的中文语音转文字纠错专家。

任务：根据上下文语境，一次性纠正给定的所有 ASR 字幕错误。

纠错范围：
1. 同音字错误：如"在干嘛"误识别为"再干嘛"、"曾杰凯"误识别等
2. 人名纠正：根据上下文识别说话者提到的人物姓名（如根据时事背景纠正"蒋万安"vs"姜万安"）
3. 专业术语：行业专业词汇的准确识别
4. 语句通顺：修正因口音、连读、吞音导致的语句不通顺
5. 繁简统一：保留原文的简体或繁体风格

重要原则：
- 只修改明显的错误，保持原文风格和语义
- 不要过度修改，不要添加原文没有的内容
- 人名地名等专有名词要结合上下文判断
- 如果某条字幕没有明显错误，原样返回

输出格式：
- 你必须输出一个 JSON 数组，每个元素对应原始字幕的纠正后文本
- 数组长度必须等于输入字幕条数
- 只输出 JSON，不要包含其他说明文字
- 示例：[ "纠正后的第1条", "纠正后的第2条", ... ]`;

    const numberedOriginal = cues.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
    const userPrompt = `请纠正以下 ${cues.length} 条字幕中的错误（基于上下文语境）：

${numberedOriginal}

请只返回 JSON 数组，格式如：[ "纠正后的第1条", "纠正后的第2条", ... ]
数组长度必须等于 ${cues.length}，不要修改其他内容。`;

    const result = await apiCall(userPrompt, systemInstruction);

    onProgress?.(Math.floor(cues.length * 0.8), cues.length);

    const optimizedCues = parseBatchResult(result, cues);

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
 * 解析 AI 返回的批量字幕结果
 */
function parseBatchResult(content: string, originalCues: SubtitleCue[]): SubtitleCue[] {
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

  // 按行解析
  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= originalCues.length * 0.8) {
    return originalCues.map((cue, idx) => {
      const line = lines[idx];
      if (line) {
        const cleaned = line.replace(/^[\d]+[\.、:：\s]+/, '').replace(/^[\[\(][^\]]+[\]\)]\s*/, '');
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

  const systemInstruction = `你是一个专业的中文语音转文字纠错专家。
只修改明显错误，保持原文风格。不要添加任何解释或标记。`;

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
