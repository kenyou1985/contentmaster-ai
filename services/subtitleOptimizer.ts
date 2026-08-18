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
}

/**
 * 调用 AI 优化单条字幕
 */
async function optimizeSingleCue(
  originalText: string,
  contextBefore: string,
  contextAfter: string,
  apiCall: (prompt: string, systemInstruction: string) => Promise<string>
): Promise<string> {
  const systemInstruction = `你是一个专业的中文语音转文字纠错专家。

任务：根据上下文语境，纠正语音识别（ASR）产生的字幕错误。

纠错范围：
1. 同音字错误：如"万安"误识别、"讲万安"应为"蒋万安"等
2. 人名纠正：根据上下文识别说话者提到的人物姓名
3. 专业术语：行业专业词汇的准确识别
4. 语句通顺：修正因口音、连读、吞音导致的语句不通顺
5. 繁简转换：保留原文的简体或繁体风格

重要原则：
- 只修改明显错误，保持原文风格和语义
- 不要过度修改，不要添加原文没有的内容
- 人名地名等专有名词要结合上下文判断
- 保持原句长度大致不变`;

  const userPrompt = `请纠正以下字幕中的错误：

上一句：${contextBefore || '（无）'}
当前字幕：${originalText}
下一句：${contextAfter || '（无）'}

请只返回纠正后的字幕文本，不要解释，不要添加任何标记。`;

  const result = await apiCall(userPrompt, systemInstruction);
  return result.trim();
}

/**
 * 批量优化字幕
 *
 * @param cues 原始字幕数组（按时间顺序）
 * @param onProgress 进度回调 (current, total)
 * @returns 优化后的字幕数组
 */
export async function optimizeSubtitles(
  cues: SubtitleCue[],
  onProgress?: (current: number, total: number) => void
): Promise<OptimizationResult> {
  if (!cues || cues.length === 0) {
    return { success: true, optimizedCues: [] };
  }

  // 动态导入 AI 服务（避免循环依赖）
  let apiCall: (prompt: string, systemInstruction: string) => Promise<string>;
  let apiKey: string | null = null;

  // 从 localStorage 获取 API Key
  if (typeof window !== 'undefined') {
    apiKey = localStorage.getItem('GEMINI_API_KEY');
  }

  if (!apiKey) {
    return {
      success: false,
      optimizedCues: cues,
      error: '请先在设置中配置 AI API Key',
    };
  }

  try {
    const { streamContentGeneration } = await import('../services/geminiService');

    // 非流式调用的包装函数
    apiCall = async (prompt: string, systemInstruction: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        let fullContent = '';
        streamContentGeneration(
          prompt,
          systemInstruction,
          (chunk) => {
            fullContent += chunk;
          },
          undefined,
          { temperature: 0.3, maxTokens: 4096 }
        )
          .then(() => {
            resolve(fullContent.trim());
          })
          .catch(reject);
      });
    };
  } catch (e) {
    return {
      success: false,
      optimizedCues: cues,
      error: 'AI 服务加载失败: ' + (e instanceof Error ? e.message : String(e)),
    };
  }

  const optimizedCues: SubtitleCue[] = [];
  const total = cues.length;

  try {
    // 分批处理，每批 5 条（避免 prompt 过长）
    const batchSize = 5;
    for (let i = 0; i < total; i += batchSize) {
      const batch = cues.slice(i, Math.min(i + batchSize, total));
      const batchPromises = batch.map((cue, idx) => {
        const actualIdx = i + idx;
        const prevCue = actualIdx > 0 ? cues[actualIdx - 1] : null;
        const nextCue = actualIdx < total - 1 ? cues[actualIdx + 1] : null;

        const contextBefore = prevCue?.text || '';
        const contextAfter = nextCue?.text || '';

        return optimizeSingleCue(cue.text, contextBefore, contextAfter, apiCall)
          .then((corrected) => ({
            ...cue,
            text: corrected,
          }));
      });

      const batchResults = await Promise.all(batchPromises);
      optimizedCues.push(...batchResults);

      onProgress?.(Math.min(i + batchSize, total), total);
    }

    return { success: true, optimizedCues };
  } catch (e) {
    return {
      success: false,
      optimizedCues,
      error: '优化失败: ' + (e instanceof Error ? e.message : String(e)),
    };
  }
}

/**
 * 快速检查单条字幕是否有明显错误（不调用 AI）
 */
export function detectLikelyErrors(text: string): string[] {
  const errors: string[] = [];

  // 检测明显的 ASR 错误模式
  const patterns = [
    { regex: /[a-zA-Z]{3,}/g, desc: '可能包含未翻译的英文' }, // 连续3个以上英文字母
    { regex: /\d{5,}/g, desc: '可能包含错误的数字' }, // 连续5位以上数字
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
 * 适用于快速修正少量字幕
 */
export async function quickOptimize(
  subtitleText: string,
  context?: string
): Promise<string> {
  let apiKey: string | null = null;

  if (typeof window !== 'undefined') {
    apiKey = localStorage.getItem('GEMINI_API_KEY');
  }

  if (!apiKey) {
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
    streamContentGeneration(
      userPrompt,
      systemInstruction,
      (chunk) => {
        fullContent += chunk;
      },
      undefined,
      { temperature: 0.3, maxTokens: 2048 }
    )
      .then(() => {
        resolve(fullContent.trim());
      })
      .catch(reject);
  });
}
