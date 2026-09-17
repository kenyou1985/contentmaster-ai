/**
 * Humanizer Prompts — LLM 改写提示词
 *
 * 灵感来源：StealthHumanizer lib/prompts.ts
 * 适配：4 个改写级别 × 6 种风格 × 中英文
 *
 * 注意：保留词（freezeWords）必须显式注入，否则可能被改写
 */

import type { WritingStyle, RewriteLevel } from './postprocess';
import { detectLang } from './detector';

const ANTI_DETECTION_CORE_EN = `
You are a text rewriter. Your job is to rewrite AI-generated text so it reads naturally, as if written by a human.

CRITICAL RULES:

1. MEANING PRESERVATION (MOST IMPORTANT):
   - Preserve ALL facts, numbers, names, dates, arguments, and entities.
   - DO NOT add new information or invent details.
   - DO NOT drop sentences or paragraphs.
   - Output length should be within ±15% of original.

2. OUTPUT FORMAT:
   - Return ONLY the rewritten text. No explanations, no headers, no markdown.
   - Preserve paragraph breaks (blank lines) exactly.
   - Every sentence must be complete and grammatically correct.

3. NATURAL SENTENCE VARIATION (BURSTINESS):
   - Mix short punchy sentences (4-8 words) with medium and longer ones.
   - Avoid monotonous, perfectly balanced sentences.

4. WORD CHOICE:
   - NEVER use these AI clichés: furthermore, moreover, additionally, in conclusion, it is important to note, it is worth noting, delve, tapestry, landscape, realm, multifaceted, robust, seamless, paradigm, innovative, utilize, facilitate, leverage.
   - Use natural contractions (it's, don't, can't).
   - Replace formal transitions with plain connectives.

5. NO EM-DASHES (—). Use commas, periods, or parentheses instead.

6. VARIETY: Vary sentence openings. Don't start every sentence with "The" or "This".
`;

const ANTI_DETECTION_CORE_ZH = `
你是一名文本改写助手。你的任务是把 AI 生成的文本改写成自然的人类写作风格。

核心规则：

1. 意义保持（最重要）：
   - 保留所有事实、数字、人名、日期、论点和实体。
   - 不要添加新信息或杜撰细节。
   - 不要删减句子或段落。
   - 输出长度应在原文的 ±15% 以内。

2. 输出格式：
   - 仅返回改写后的文本。不要任何解释、标题或 markdown。
   - 保留段落分隔（空行）。
   - 每句话必须完整且语法正确。

3. 自然句长变化（突发性）：
   - 短促有力的句子（4-8 字）与中等、较长句子混合使用。
   - 避免单调、完美均衡的句子节奏。

4. 用词：
   - 禁止使用这些 AI 套话：此外 / 另外 / 总之 / 综上所述 / 深入探讨 / 全面分析 / 详细阐述 / 系统研究 / 值得注意的是 / 显而易见 / 不可否认。
   - 控制连接词密度：每段最多 1 个显式连接词，更多用语义衔接。
   - 长短句交替，句长差 ≥ 8 字。

5. 平衡句式打破：
   - 避免 A、B、C 三段式并列。
   - 不要使用"既…又…""不仅…而且…"等完美对仗。
   - 每段至少有一个短句（≤ 10 字）和一个长句（≥ 35 字）。

6. 主语显隐交替：
   - 有时省略主语（中文口语常见）。
   - 偶尔切换到第一人称（我/我们）。
   - 避免每句都有明确主语。
`;

const LEVEL_OVERLAYS_EN: Record<RewriteLevel, string> = {
  light: `
LEVEL: LIGHT (minimal touch)
- Substitute 2-3 AI clichés
- Add 1 short sentence per paragraph
- Keep original structure mostly intact
- Output should still closely resemble original`,
  medium: `
LEVEL: MEDIUM (balanced)
- Apply burstiness engine rules
- Replace AI phrases
- Vary sentence openings
- Re-arrange a few clauses for better flow
- Output should read naturally without losing meaning`,
  aggressive: `
LEVEL: AGGRESSIVE (major rewrite)
- Full anti-detection treatment
- Sentence reordering (keeping first/last in place)
- Heavy burstiness injection
- Casual register where appropriate
- Paraphrase arguments completely`,
  ninja: `
LEVEL: NINJA (maximum stealth, multi-pass)
Run this rewriting in your head TWICE:
Pass 1: Aggressive rewrite
Pass 2: Self-check — are there any AI clichés left? Any two adjacent sentences of similar length? Any perfectly balanced sentences? Any AI-style paragraph structure?

Then produce the final output that:
- Eliminates every AI fingerprint
- Uses diverse vocabulary and sentence patterns
- Includes a personal touch (occasional first-person, rhetorical question)
- Reads like a real human wrote it at 2am after a coffee
- Output: ONLY the rewritten text, no commentary`,
};

const LEVEL_OVERLAYS_ZH: Record<RewriteLevel, string> = {
  light: `
改写等级：轻度（LIGHT）
- 替换 2-3 个 AI 典型连接词
- 每段加入 1 个短句
- 基本保留原文结构
- 输出与原文高度相似`,
  medium: `
改写等级：中度（MEDIUM）
- 应用突发性引擎规则
- 替换 AI 短语
- 变化句首
- 适度调整部分子句顺序
- 输出应自然流畅，不丢失原意`,
  aggressive: `
改写等级：强力（AGGRESSIVE）
- 全套反检测处理
- 句子重排（保留首尾）
- 大幅注入突发性
- 适当口语化
- 完全改述论点`,
  ninja: `
改写等级：忍者（NINJA，最高隐匿）
在脑海中跑两遍：
第一遍：强力改写
第二遍：自查 —— 还有 AI 套话吗？相邻两句句长相似吗？有完美均衡的句子吗？有 AI 段落结构吗？

最终输出：
- 消除每个 AI 特征
- 用词与句式多样化
- 加一点个人色彩（偶现第一人称 / 反问）
- 读起来像真人凌晨两点写出来的文章
- 输出：仅改写后文本，不要评论`,
};

const STYLE_OVERLAYS_EN: Record<WritingStyle, string> = {
  natural: `
STYLE: Natural general writing. Mix short and medium sentences. Use clear direct words. Use contractions freely (it's, don't, isn't). No AI clichés.`,
  academic: `
STYLE: Academic writing (journal humanized). Objective, evidence-based, measured. Avoid robotic transitions. Use precise terminology. No "furthermore", "moreover", "in conclusion".`,
  professional: `
STYLE: Professional (executive). Direct, authoritative, strategic. Short clear sentences. No marketing fluff.`,
  casual: `
STYLE: Casual conversational. Like explaining something to a friend. Contractions freely. Relaxed but complete (no fragments).`,
  creative: `
STYLE: Vivid, engaging, alive. Sensory details, fresh comparisons. Unexpected word choices. Show don't tell.`,
  technical: `
STYLE: Technical but human. Precise terms, concrete examples. Clear step-by-step. Avoid robotic transitions.`,
};

const STYLE_OVERLAYS_ZH: Record<WritingStyle, string> = {
  natural: `
写作风格：通用自然写作。长短句交替。用词直接清晰。允许自然口语化（说实话、其实、说白了）。不要 AI 套话。`,
  academic: `
写作风格：学术写作（人性化版）。客观、有据、严谨。避免机器人式过渡。不要"因此、然而、综上"。使用精确术语。`,
  professional: `
写作风格：专业（管理层级）。直接、权威、有策略。短句有力。无营销废话。`,
  casual: `
写作风格：口语轻松。像跟朋友解释问题。可自由使用口语词（其实、怎么说呢）。放松但完整，不要半句话。`,
  creative: `
写作风格：生动有感染力。感官细节、新鲜比喻、出人意料的用词。展示而非叙述。`,
  technical: `
写作风格：技术但人性化。精确术语、具体示例。清晰的步骤逻辑。避免机器人式过渡。`,
};

function buildFreezeWordsBlock(words: string[], lang: 'zh' | 'en'): string {
  if (!words.length) return '';
  const list = words.map(w => `"${w}"`).join(', ');
  if (lang === 'en') {
    return `\n\nFREEZE WORDS: The following words/phrases MUST be preserved exactly as written. NEVER replace with synonyms or modify them in any way:\n[${list}]\n`;
  }
  return `\n\n保留词汇：以下词汇必须原样保留，绝对不能替换为同义词或任何形式修改：\n[${list}]\n`;
}

/**
 * 强制语言输出指令
 *
 * 即使原文语言与目标语言不同，也必须把改写后的文本翻译为目标语言。
 * 这是修复"目标语言选中文但输出仍是英文"的关键。
 */
function buildOutputLanguageBlock(targetLang: 'zh' | 'en', sourceLang: 'zh' | 'en'): string {
  if (targetLang === sourceLang) {
    // 同语言改写：仅声明即可
    return targetLang === 'zh'
      ? '\n\n输出语言：中文（保持原文语言）。'
      : '\n\nOUTPUT LANGUAGE: English (keep the original language).';
  }
  // 跨语言：必须翻译
  if (targetLang === 'zh') {
    return `\n\n⚠️ 输出语言强制要求：中文

原文语言：${sourceLang === 'zh' ? '中文' : '英文'}
目标语言：中文

你必须：
1. 把改写后的文本**完整翻译为中文**（包括所有事实、数字、人名）。
2. 如果原文中的专有名词（人名 / 品牌 / 术语）有公认的中文译名，用中文；否则保留原文拼写并加注或直接保留。
3. 不要在中文输出里夹杂英文段落或句子（保留词除外）。
4. 输出长度应与中文表达的篇幅相符，与原文长度可比即可，不必逐词对齐。`;
  }
  return `\n\n⚠️ OUTPUT LANGUAGE REQUIREMENT: English

Source language: ${sourceLang === 'zh' ? 'Chinese' : 'English'}
Target language: English

You MUST:
1. Fully TRANSLATE the rewritten text into English (including all facts, numbers, names).
2. For proper nouns (names / brands / terms) that have established English equivalents, use the English form; otherwise keep the original spelling.
3. Do NOT mix Chinese paragraphs or sentences into the English output (except for freeze words).
4. Output length should be comparable to the original in natural English expression, not a word-for-word alignment.`;
}

function buildLengthBlock(originalText: string, lang: 'zh' | 'en'): string {
  const len = lang === 'zh'
    ? originalText.replace(/\s+/g, '').length
    : originalText.trim().split(/\s+/).length;
  if (lang === 'en') {
    return `Original length: ${len} words. Output length MUST be within ±15% (${Math.round(len * 0.85)}–${Math.round(len * 1.15)} words).`;
  }
  return `原文长度：${len} 字。输出长度必须在 ±15% 以内（${Math.round(len * 0.85)}–${Math.round(len * 1.15)} 字）。`;
}

export interface BuildPromptOptions {
  level: RewriteLevel;
  style: WritingStyle;
  freezeWords?: string[];
  /** 强制指定语言 */
  lang?: 'zh' | 'en';
}

export function buildHumanizerPrompt(
  originalText: string,
  options: BuildPromptOptions,
): { systemInstruction: string; prompt: string; lang: 'zh' | 'en'; sourceLang: 'zh' | 'en' } {
  const sourceLang: 'zh' | 'en' = detectLang(originalText);
  // 关键修复：目标语言与源语言不同时，必须明确告诉 LLM 翻译到目标语言
  const lang: 'zh' | 'en' = options.lang ?? sourceLang;
  const isZh = lang === 'zh';

  const core = isZh ? ANTI_DETECTION_CORE_ZH : ANTI_DETECTION_CORE_EN;
  const levelOverlay = (isZh ? LEVEL_OVERLAYS_ZH : LEVEL_OVERLAYS_EN)[options.level];
  const styleOverlay = (isZh ? STYLE_OVERLAYS_ZH : STYLE_OVERLAYS_EN)[options.style];
  const freezeBlock = buildFreezeWordsBlock(options.freezeWords ?? [], lang);
  const lengthBlock = buildLengthBlock(originalText, lang);
  const langBlock = buildOutputLanguageBlock(lang, sourceLang);

  const systemInstruction = [
    core,
    levelOverlay,
    styleOverlay,
    freezeBlock,
    lengthBlock,
    langBlock,
    isZh
      ? '\n输出：仅返回改写后的文本，不要任何前言/注释/标题。'
      : '\nOUTPUT: Return ONLY the rewritten text. No preamble, no commentary, no markdown.',
  ].join('\n');

  const prompt = isZh
    ? `原文（${sourceLang === 'zh' ? '中文' : '英文'}）：\n"""\n${originalText}\n"""\n\n请按上述规则${sourceLang !== lang ? '翻译并改写为中文' : '改写'}：`
    : `Original text (${sourceLang === 'zh' ? 'Chinese' : 'English'}):\n"""\n${originalText}\n"""\n\n${sourceLang !== lang ? 'Translate and rewrite into English' : 'Rewrite'} according to the rules above:`;

  return { systemInstruction, prompt, lang, sourceLang };
}

/**
 * 单句再人化（点中 AI 检测热图中的红句后调用）
 */
export function buildSingleSentencePrompt(
  sentence: string,
  issues: string[],
  options: { lang?: 'zh' | 'en'; freezeWords?: string[] } = {},
): { systemInstruction: string; prompt: string } {
  const lang = options.lang ?? detectLang(sentence);
  const isZh = lang === 'zh';
  const freezeBlock = buildFreezeWordsBlock(options.freezeWords ?? [], lang);

  if (isZh) {
    const systemInstruction = `你是一名中文句子改写助手。给定一个被判定为 AI 味道的句子，你要把它改写成更自然的版本。

严格规则：
- 保留所有事实、数字、人名、日期。
- 输出必须是一个完整、语法正确的句子，不能是片段。
- 不要加入未在原句中的新信息。
- 不要使用 AI 套话：此外、另外、总之、深入探讨、全面分析。
- 不使用 em-dash（—）。
- 不要添加注释、标题、markdown。
${freezeBlock}

输出：仅返回改写后的一句话。`;

    const issuesText = issues.length ? `\n该句的 AI 特征：\n${issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}\n` : '';
    const prompt = `原句：\n${sentence}\n${issuesText}\n请重写：`;
    return { systemInstruction, prompt };
  }

  const systemInstruction = `You are a sentence rewriter. Given a sentence flagged as AI-sounding, rewrite it to read naturally.

CRITICAL RULES:
- Preserve all facts, numbers, names, dates.
- Output must be a complete, grammatically correct sentence (not a fragment).
- Do not add new information not in the original.
- Do NOT use AI clichés: furthermore, moreover, additionally, in conclusion, it is important to note, delve, leverage, utilize.
- No em-dashes (—).
- No commentary, no markdown, no preamble.
${freezeBlock}

OUTPUT: Return ONLY the rewritten sentence.`;

  const issuesText = issues.length ? `\nIssues identified:\n${issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}\n` : '';
  const prompt = `Original sentence:\n${sentence}\n${issuesText}\nRewrite:`;
  return { systemInstruction, prompt };
}

/**
 * Ninja 模式：N 轮渐进改写（每轮用同 system，prompt 强调不同维度）
 */
export function buildNinjaPassPrompt(
  originalText: string,
  pass: number,
  options: { freezeWords?: string[]; lang?: 'zh' | 'en' },
): { systemInstruction: string; prompt: string } {
  const sourceLang: 'zh' | 'en' = detectLang(originalText);
  const lang: 'zh' | 'en' = options.lang ?? sourceLang;
  const isZh = lang === 'zh';
  const freezeBlock = buildFreezeWordsBlock(options.freezeWords ?? [], lang);
  const lengthBlock = buildLengthBlock(originalText, lang);
  const langBlock = buildOutputLanguageBlock(lang, sourceLang);

  const passInstructions = isZh
    ? [
        // pass 1
        '第一遍：用强力改写等级处理，重点消除 AI 连接词与短语。',
        // pass 2
        '第二遍：检查句长方差。如果相邻两句字数相近，合并或拆分以制造节奏变化。',
        // pass 3
        '第三遍：变化句首。避免连续两句以相同字开头（如"此外"或"因此"）。',
      ]
    : [
        'Pass 1: Apply aggressive rewrite. Eliminate all AI clichés.',
        'Pass 2: Check burstiness. If two adjacent sentences have similar length, merge or split.',
        'Pass 3: Vary sentence openings. No two consecutive sentences should start with the same word.',
      ];

  const passDesc = passInstructions[Math.min(pass, passInstructions.length - 1)];

  const systemInstruction = isZh
    ? `你是一名忍者级中文文本改写助手。\n${lengthBlock}\n${freezeBlock}\n${langBlock}\n${passDesc}\n\n输出：仅返回改写后的文本。`
    : `You are a ninja-level text rewriter.\n${lengthBlock}\n${freezeBlock}\n${langBlock}\n${passDesc}\n\nOUTPUT: Return ONLY the rewritten text.`;

  const prompt = isZh
    ? `原文（${sourceLang === 'zh' ? '中文' : '英文'}）：\n"""\n${originalText}\n"""\n\n请${sourceLang !== lang ? '翻译并改写为中文' : '改写'}：`
    : `Original text (${sourceLang === 'zh' ? 'Chinese' : 'English'}):\n"""\n${originalText}\n"""\n\n${sourceLang !== lang ? 'Translate and rewrite into English' : 'Rewrite'}:`;

  return { systemInstruction, prompt };
}
