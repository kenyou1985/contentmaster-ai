/**
 * Humanizer Module — 主入口
 *
 * 功能：
 *  - humanize(text, options): LLM 改写 + 本地后处理 + AI 检测评分
 *  - humanizeLocal(text, options): 仅本地后处理（无网络 / 无 API key）
 *  - humanizeSentence(sentence, options): 单句再人化
 *  - detectAI(text): AI 检测（来自 detector.ts）
 *
 * 流程：
 *   输入文本
 *     ↓
 *   [LLM 改写] - 使用 prompts.ts 构建提示词
 *     ↓
 *   [本地后处理] - 使用 postprocess.ts 二次处理（替换 AI 短语 / em-dash / 长句拆分等）
 *     ↓
 *   [AI 检测] - 检测前后分数对比
 *     ↓
 *   输出（原文 + 改写 + 检测报告）
 */

import { streamContentGeneration, type StreamContentOptions } from '../geminiService';
import {
  postprocess,
  type RewriteLevel,
  type WritingStyle,
  type PostprocessOptions,
} from './postprocess';
import {
  buildHumanizerPrompt,
  buildSingleSentencePrompt,
  buildNinjaPassPrompt,
} from './prompts';
import {
  detectAI,
  type DetectorReport,
  type Lang,
} from './detector';

export type { RewriteLevel, WritingStyle, Lang, DetectorReport };
export { detectAI, getScoreColor, getScoreBgColor, getClassificationColor, getVerdictLabel } from './detector';
export { postprocess } from './postprocess';

export interface HumanizeOptions {
  level?: RewriteLevel;
  style?: WritingStyle;
  freezeWords?: string[];
  lang?: Lang;
  /** API Key 直接传入（不传则走全局 geminiService） */
  apiKeyOverride?: string;
  /** 自定义模型（不传则用项目默认） */
  modelName?: string;
  /** 是否跳过本地后处理（默认 false = 启用） */
  skipLocalPostprocess?: boolean;
  /** 是否在改写后做 AI 检测（默认 true） */
  withDetection?: boolean;
  /** 进度回调 */
  onProgress?: (stage: string, message: string) => void;
}

export interface HumanizeResult {
  original: string;
  rewritten: string;
  /** 经过本地后处理的最终输出（通常 = rewritten + 后处理） */
  final: string;
  lang: 'zh' | 'en';
  /** 改写前后的 AI 检测报告 */
  before?: DetectorReport;
  after?: DetectorReport;
  /** 改进幅度（after.score - before.score） */
  improvement?: number;
  /** 是否走了 LLM 改写 */
  usedLlm: boolean;
  /** 改写级别 / 风格 */
  level: RewriteLevel;
  style: WritingStyle;
}

/**
 * 单句再人化（用于点击 AI 检测热图中的红句）
 */
export async function humanizeSentence(
  sentence: string,
  options: HumanizeOptions & { issues?: string[] } = {},
): Promise<string> {
  const { systemInstruction, prompt } = buildSingleSentencePrompt(
    sentence,
    options.issues ?? [],
    { lang: options.lang === 'auto' ? undefined : options.lang, freezeWords: options.freezeWords },
  );

  let rewritten = '';
  await streamContentGeneration(
    prompt,
    systemInstruction,
    chunk => {
      rewritten += chunk;
    },
    options.modelName,
    {
      temperature: 0.8,
      maxTokens: Math.max(256, sentence.length * 2),
      apiKeyOverride: options.apiKeyOverride,
    } as StreamContentOptions,
  );

  rewritten = rewritten.trim();
  if (!rewritten) return sentence;

  // 本地后处理
  if (!options.skipLocalPostprocess) {
    rewritten = postprocess(rewritten, {
      level: options.level ?? 'light',
      style: options.style,
      lang: options.lang,
      freezeWords: options.freezeWords,
    });
  }

  return rewritten;
}

/**
 * LLM 改写 + 本地后处理 + AI 检测
 */
export async function humanize(
  text: string,
  options: HumanizeOptions = {},
): Promise<HumanizeResult> {
  const level = options.level ?? 'medium';
  const style = options.style ?? 'natural';
  const withDetection = options.withDetection !== false;

  // 改写前检测
  let before: DetectorReport | undefined;
  if (withDetection) {
    before = detectAI(text, { lang: options.lang });
  }

  // 构建 LLM 提示词
  const { systemInstruction, prompt, lang, sourceLang } = buildHumanizerPrompt(text, {
    level,
    style,
    freezeWords: options.freezeWords,
    lang: options.lang === 'auto' ? undefined : options.lang,
  });

  // 跨语言改写：在终端里给出明确日志（方便用户排查）
  if (lang !== sourceLang) {
    const fromLabel = sourceLang === 'zh' ? '中文' : '英文';
    const toLabel = lang === 'zh' ? '中文' : '英文';
    options.onProgress?.('lang', `跨语言改写：${fromLabel} → ${toLabel}（prompt 已强制要求翻译）`);
  }

  options.onProgress?.('llm', '调用 LLM 改写中...');

  // 流式调用
  let rewritten = '';
  await streamContentGeneration(
    prompt,
    systemInstruction,
    chunk => {
      rewritten += chunk;
    },
    options.modelName,
    {
      temperature: level === 'light' ? 0.6 : level === 'medium' ? 0.8 : 1.0,
      maxTokens: Math.max(1024, Math.round(text.length * 1.8)),
      apiKeyOverride: options.apiKeyOverride,
    } as StreamContentOptions,
  );

  rewritten = rewritten.trim();

  // 关键修复：LLM 输出为空时，绝不能再 fallback 回原文（否则会出现"语言没生效"的假象）
  let final = rewritten;
  if (!final) {
    options.onProgress?.('warn', 'LLM 返回为空，已中止改写。请检查 API key / 模型名。');
    final = text;
  }
  if (!options.skipLocalPostprocess && rewritten) {
    options.onProgress?.('postprocess', '本地后处理（替换 AI 短语、固定格式等）...');
    final = postprocess(rewritten, {
      level: level === 'light' ? 'light' : 'medium', // 后处理强度：light→light，其余→medium
      style,
      lang,
      freezeWords: options.freezeWords,
    });
  }

  // Ninja 模式：再跑一轮本地后处理（强化）
  if (level === 'ninja' && rewritten) {
    options.onProgress?.('ninja', 'Ninja 强化：第二轮后处理...');
    final = postprocess(final, {
      level: 'aggressive',
      style,
      lang,
      freezeWords: options.freezeWords,
    });
  }

  // 改写后检测
  let after: DetectorReport | undefined;
  if (withDetection && final) {
    options.onProgress?.('detect', 'AI 检测评分...');
    after = detectAI(final, { lang });
  }

  const result: HumanizeResult = {
    original: text,
    rewritten,
    final,
    lang,
    before,
    after,
    improvement: before && after ? after.score - before.score : undefined,
    usedLlm: Boolean(rewritten),
    level,
    style,
  };

  options.onProgress?.('done', '改写完成');
  return result;
}

/**
 * Ninja 多遍改写（每遍不同侧重点）
 */
export async function humanizeNinja(
  text: string,
  options: HumanizeOptions = {},
): Promise<HumanizeResult> {
  const level: RewriteLevel = 'ninja';
  const style = options.style ?? 'natural';
  const withDetection = options.withDetection !== false;

  let before: DetectorReport | undefined;
  if (withDetection) {
    before = detectAI(text, { lang: options.lang });
  }

  let current = text;
  const passes = 3;
  for (let i = 0; i < passes; i++) {
    options.onProgress?.('ninja-pass', `Ninja 第 ${i + 1}/${passes} 遍...`);
    const { systemInstruction, prompt } = buildNinjaPassPrompt(current, i, {
      freezeWords: options.freezeWords,
      lang: options.lang === 'auto' ? undefined : options.lang,
    });
    let passOut = '';
    await streamContentGeneration(
      prompt,
      systemInstruction,
      chunk => {
        passOut += chunk;
      },
      options.modelName,
      {
        temperature: 0.9,
        maxTokens: Math.max(1024, Math.round(current.length * 1.8)),
        apiKeyOverride: options.apiKeyOverride,
      } as StreamContentOptions,
    );
    if (passOut.trim()) {
      current = passOut.trim();
    }
  }

  // 本地后处理
  let final = current;
  if (!options.skipLocalPostprocess) {
    options.onProgress?.('postprocess', '本地后处理...');
    final = postprocess(current, {
      level: 'aggressive',
      style,
      lang: options.lang === 'auto' ? undefined : options.lang,
      freezeWords: options.freezeWords,
    });
  }

  let after: DetectorReport | undefined;
  if (withDetection && final) {
    options.onProgress?.('detect', 'AI 检测评分...');
    after = detectAI(final, { lang: options.lang === 'auto' ? undefined : options.lang });
  }

  return {
    original: text,
    rewritten: current,
    final,
    lang: options.lang === 'auto' || !options.lang ? (before?.language ?? 'zh') : options.lang,
    before,
    after,
    improvement: before && after ? after.score - before.score : undefined,
    usedLlm: true,
    level,
    style,
  };
}

/**
 * 仅本地后处理（不调 LLM）
 *
 * 适用：
 *  - 无 API Key 时（隐私模式）
 *  - 敏感稿件（不出网）
 *  - 对 LLM 输出做二次打磨
 */
export function humanizeLocal(
  text: string,
  options: PostprocessOptions & { lang?: Lang } = {},
): string {
  return postprocess(text, options);
}

/**
 * 清理 LLM 输出中的元描述（有些模型会输出"这是改写后的版本："等）
 */
export function cleanLlmOutput(text: string, lang: 'zh' | 'en' = 'zh'): string {
  if (!text) return text;
  let result = text.trim();

  // 去掉常见的前置短语
  const stripPrefixes = lang === 'zh'
    ? [
        /^(好的|这是|以下是|改写[：:]?\s*|改写后[：:]?\s*|重写[：:]?\s*|重写后[：:]?)\s*/i,
        /^当然[，,]?\s*/,
        /^下面是改写后的[文本]*[：:]?\s*/,
      ]
    : [
        /^(Sure|Here's|Here is|Below is|Rewritten|Rewrite|Revised)[,:]\s*/i,
        /^Of course[.,]?\s*/i,
      ];

  for (const p of stripPrefixes) {
    result = result.replace(p, '');
  }

  // 去掉 markdown 代码块包装
  result = result.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');

  // 去掉首尾的引号包裹（仅当整段被引号包住）
  if (/^["""'''].*["""''']$/.test(result)) {
    const stripped = result.slice(1, -1).trim();
    if (stripped.length > 20) result = stripped;
  }

  return result.trim();
}
