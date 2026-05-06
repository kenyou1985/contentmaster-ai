/**
 * 分段并行长内容：大纲 JSON → 分段并行生成 → 合并润色（全赛道通用，易经等为风格变体）
 */

export type YiJingChapterPlan = {
  title: string;
  min_chars: number;
  max_chars: number;
  core_brief: string;
  /** 本章开头应自然复述的上一章收束语义（第1章可为空） */
  opening_echo: string;
  /** 本章结尾建议保留的收束片段，供下一章衔接（最后章也要写总结向） */
  closing_snippet_hint: string;
  bridge_to_next: string;
};

export type YiJingOutlinePayload = {
  core_theme: string;
  logic_line: string;
  chapters: YiJingChapterPlan[];
};

export function extractJsonObject(raw: string): string | null {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  return body.slice(s, e + 1);
}

export function parseYiJingOutline(raw: string): YiJingOutlinePayload | null {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return null;
  try {
    const o = JSON.parse(jsonStr) as Record<string, unknown>;
    const chapters = o.chapters;
    if (!Array.isArray(chapters) || chapters.length === 0) return null;
    const mapped: YiJingChapterPlan[] = chapters.map((c: any, i: number) => ({
      title: String(c.title || `第${i + 1}章`),
      min_chars: Math.max(800, Number(c.min_chars) || 1800),
      max_chars: Math.max(900, Number(c.max_chars) || 2200),
      core_brief: String(c.core_brief || c.core_content || ''),
      opening_echo: String(c.opening_echo || ''),
      closing_snippet_hint: String(c.closing_snippet_hint || c.closing_hint || ''),
      bridge_to_next: String(c.bridge_to_next || ''),
    }));
    return {
      core_theme: String(o.core_theme || ''),
      logic_line: String(o.logic_line || ''),
      chapters: mapped,
    };
  } catch {
    return null;
  }
}

const PARALLEL_TOTAL_MAX = 70000;
const PARALLEL_TOTAL_MIN = 1000;

/** 按全文目标字数均摊到各章 min/max（保留章节文案字段不变） */
export function rescaleChapterWordCounts(
  parsed: YiJingOutlinePayload,
  totalTarget: number
): YiJingOutlinePayload {
  const n = parsed.chapters.length;
  if (n === 0) return parsed;
  const clampedTotal = Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTarget)));
  const mids: number[] = [];
  let rem = clampedTotal;
  for (let i = 0; i < n; i++) {
    const share = Math.ceil(rem / (n - i));
    mids.push(share);
    rem -= share;
  }
  const avg = clampedTotal / n;
  const band = Math.min(350, Math.max(50, Math.round(avg * 0.08)));
  return {
    ...parsed,
    chapters: parsed.chapters.map((ch, i) => {
      const m = mids[i] ?? avg;
      const lo = Math.max(150, m - band);
      const hi = Math.max(lo + 80, m + band);
      return { ...ch, min_chars: lo, max_chars: hi };
    }),
  };
}

export function outlinePayloadToJsonPretty(parsed: YiJingOutlinePayload): string {
  return JSON.stringify(parsed, null, 2);
}

/**
 * 单次分段流式生成（maxTokens≈12288）下，单章口播汉字的保守上限，用于反推需要多少章才能覆盖全文目标。
 */
export const YI_JING_CHARS_PER_SEGMENT_SOFT_CAP = 3000;

/** 三段式分章常量（长文） */
export const YI_JING_BAND1_MAX = 12000; // ≤ 12000 → 固定 10 章
export const YI_JING_BAND2_MAX = 30000; // 12001–30000 → 10–14 章

/**
 * 长文自动章数：
 * - T ≤ 12000         → 固定 10 章（大国博弈中文版 8000-9000 字专用路径）
 * - 12001 < T ≤ 30000 → ceil(T / 3000)，限制 10–14 章
 * - T > 30000          → ceil(T / 3000)，限制 6–40 章
 */
export function computeYiJingSegmentCount(totalTargetChars: number): number {
  const T = Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)));
  if (T <= YI_JING_BAND1_MAX) {
    return 5;
  }
  const raw = Math.ceil(T / YI_JING_CHARS_PER_SEGMENT_SOFT_CAP);
  if (T <= YI_JING_BAND2_MAX) {
    return Math.max(5, Math.min(10, raw));
  }
  return Math.max(6, Math.min(40, raw));
}

/** 短视频/短脚本：章数少一些，避免强行拆得过碎 */
export function computeShortParallelSegmentCount(totalTargetChars: number): number {
  const T = Math.min(8000, Math.max(300, Math.round(totalTargetChars)));
  return Math.max(1, Math.min(4, Math.ceil(T / 700)));
}

export function computeParallelSegmentCount(
  totalTargetChars: number,
  scriptMode: 'LONG' | 'SHORT'
): number {
  return scriptMode === 'SHORT'
    ? computeShortParallelSegmentCount(totalTargetChars)
    : computeYiJingSegmentCount(totalTargetChars);
}

/** 通用逻辑线（非易经赛道） */
export const PARALLEL_LOGIC_GENERIC =
  '逻辑线清晰：开场抓注意力 → 展开核心论述或叙事推进 → 案例/细节/论据支撑 → 可执行结论或情感收束 → 自然结尾（可按章数合并或拆分，须层层递进）。';

/** 易经专用逻辑线 */
export const PARALLEL_LOGIC_YI_JING =
  '逻辑线清晰：痛点破局 → 易经天道/阴阳 → 故事与案例 → 落地心法 → 收束金句（可根据章数合并或拆分，但须层层递进）。';

export type ParallelOutlinePromptOpts = {
  /** 如「易经命理·长视频口播」 */
  channelLabel: string;
  /** 如「口播正文」「解说稿」 */
  contentKind: string;
  /** 第 2 条「逻辑线」全文 */
  logicBlueprint: string;
  /** 大纲里 T 与各章 min/max 按英文口播字符（含空格标点）计，非汉字字数 */
  englishCharOutline?: boolean;
};

export function buildParallelOutlineUserPrompt(
  topic: string,
  segmentCount: number,
  totalTargetChars: number,
  opts: ParallelOutlinePromptOpts,
  leadContext?: string
): string {
  const T = Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)));
  const low = Math.round(T * 0.95);
  const high = Math.round(T * 1.05);
  const perBase = Math.floor(T / segmentCount);
  const perLo = Math.max(200, perBase - Math.min(200, Math.round(perBase * 0.12)));
  const perHi = perBase + Math.min(200, Math.round(perBase * 0.12));
  const head = leadContext?.trim()
    ? `${leadContext.trim()}\n\n---\n\n`
    : '';
  const unitNote = opts.englishCharOutline
    ? '\n【计量说明】全文总目标与各章 min_chars / max_chars 均为 **英文口播字符**（字母、空格、标点；与常见编辑器「字符数」一致），**不是**中文汉字字数。\n'
    : '';
  return `${head}【选题】${topic}

【任务】为以上选题生成${opts.channelLabel}的**章节大纲**（${opts.contentKind}），用于后续分段并发生成（每段单独请求，最后合并）。
${unitNote}
【硬性要求】
1. 共 **${segmentCount}** 章；全片合并后目标约 **${T} 字**（允许合理偏差），每章 min_chars / max_chars 需合理分摊，单章约 ${perLo}–${perHi}（在 JSON 里逐章给出，max_chars - min_chars ≤ 600）。
2. ${opts.logicBlueprint}
3. 每章必须包含：
   - title：章标题（4–12 字，**禁止**使用「第X章」「第一章」「第三章」等章节编号，只能是自然的短句标题，如「深夜的客厅」「被看见的瞬间」）
   - min_chars / max_chars：整数
   - core_brief：本章要讲透的论点与素材方向（50–120 字）
   - opening_echo：**从上一章收束语义自然承接**的开头提示（第1章填空字符串 ""）；约 40–80 字，供写稿时嵌入开篇
   - closing_snippet_hint：本章结尾希望出现的收束语义摘要（40–80 字），供下一章 opening_echo 使用
   - bridge_to_next：本章末 1–2 句过渡到下一章的自然过渡提示（最后一章写总结升华）

4. **章节编号禁止**：严格禁止输出任何「第1章」「第二章」「第一部分」「Section 1」「Chapter 3」等带编号的章节标记。所有章节标题必须是纯自然短句，不含数字编号。

5. 只输出 **一个 JSON 对象**，不要 Markdown、不要注释。键名必须完全一致：
{
  "core_theme": "string",
  "logic_line": "string",
  "chapters": [
    {
      "title": "string",
      "min_chars": number,
      "max_chars": number,
      "core_brief": "string",
      "opening_echo": "string",
      "closing_snippet_hint": "string",
      "bridge_to_next": "string"
    }
  ]
}

chapters 数组长度必须恰好为 ${segmentCount}。`;
}

/** 大纲 JSON 系统指令：总编导人设 */
export function buildParallelOutlineSystem(directorLine: string): string {
  return `${directorLine}只输出合法 JSON，禁止其它文字。`;
}

/** 大纲 JSON 系统指令：Bo Yi / 大国博弈赛道专用 — 强制英文输出 */
export function buildBoYiParallelOutlineSystem(directorLine: string): string {
  return `${directorLine}Output valid JSON only. No other text. Every field in the JSON must be in English — the chapter titles, core_brief, logic hints, bridge lines, all text values. Zero Chinese characters in the JSON output.`;
}

/** @deprecated 请用 buildParallelOutlineUserPrompt + 赛道 opts */
export function buildOutlineUserPrompt(
  topic: string,
  segmentCount: number,
  totalTargetChars: number
): string {
  return buildParallelOutlineUserPrompt(topic, segmentCount, totalTargetChars, {
    channelLabel: '曾仕强风格长视频口播',
    contentKind: '口播大纲',
    logicBlueprint: PARALLEL_LOGIC_YI_JING,
  });
}

export const YI_JING_OUTLINE_SYSTEM = buildParallelOutlineSystem(
  '你是曾仕强教授风格的易经命理长视频总编导。'
);

export type ParallelSegmentPromptOpts = {
  /** 来自赛道 systemInstruction 压缩后的写作铁律 */
  voiceRules: string;
  outputLanguage: 'zh' | 'en';
  /**
   * 治愈心理学英文口播：本章按「字符」计（含空格标点），严守 min/max，禁止「宁多勿少」式膨胀
   */
  englishChapterCharStrict?: boolean;
  /** 多语言输出时的语言，用于生成正确的结尾 CTA */
  mindfulLanguage?: string;
  /** 结语风格：yijin=曾仕强口吻，mindful=治愈心理学自然随意风（默认 mindful） */
  closingStyle?: 'yijin' | 'mindful';
};

export function buildParallelSegmentUserPrompt(
  params: {
    topic: string;
    coreTheme: string;
    logicLine: string;
    chapter: YiJingChapterPlan;
    chapterIndex: number;
    totalChapters: number;
  },
  opts: ParallelSegmentPromptOpts
): string {
  const { topic, coreTheme, logicLine, chapter, chapterIndex, totalChapters } = params;
  const isFirst = chapterIndex === 0;
  const isLast = chapterIndex === totalChapters - 1;
  const isEnglishOutput = opts.outputLanguage === 'en';

  const langLine = isEnglishOutput
    ? '【语言强制】全文必须使用**英文**输出，包括所有正文、金句、衔接句。禁止出现任何中文字符。'
    : '【语言强制】全文必须使用**简体中文**输出，包括所有正文、金句、衔接句。禁止出现任何英文或其他语言的正文字符。';

  const charRule = opts.englishChapterCharStrict
    ? `【本章字数】英文正文有效字符（含空格与标点）尽量控制在 ${chapter.min_chars}–${chapter.max_chars} 之间；如字数略有偏差可以接受，**内容完整性优先**。`
    : `【本章字数】有效字符尽量在 ${chapter.min_chars}–${chapter.max_chars} 字范围内；字数略有偏差可接受，**内容完整性优先**。`;

  const closingStyle = opts.closingStyle ?? 'mindful';

  const lastChapterInstruction = isLast
    ? (isEnglishOutput
        ? closingStyle === 'yijin'
          ? `\\n\\n【结语收尾方式（英文内容）】\\n- 英文内容**禁止**使用「please like and subscribe」等营销腔结尾，也**禁止**使用「Good night, my friends」「Take care, everyone」「Rest well, my friends」等偏公开化的收尾——全文是曾仕强口吻，"my friends"会让读者从「我」的讲学里被拽出来。\\n- 推荐收尾方式（用曾仕强风格自然收束）：\\n  - "Okay, that's all for today. You figure it out yourself."\\n  - "I have said what I needed to say. Believe it or not, it's up to you."\\n  - "Remember what the ancients taught. Figure it out yourself."\\n- 禁止加粗、禁止 Markdown。`
          : `\\n\\n【Ending (English content)】\\n- **ABSOLUTELY FORBIDDEN**: Do NOT use "Please like and subscribe", "Good night, my friends", "Take care, everyone", "Rest well, my friends", "The game continues.", "The game never stops.", or any other public/broadcast-style closing.\\n- **ONLY use casual, first-person endings** — like a friend saying goodnight or a quiet self-reflective moment. Examples:\\n  - "Anyway, that's it from me."\\n  - "I guess that's enough for now."\\n  - "Okay. I'll stop here."\\n  - "That's all I've got."\\n- Keep it under 2 sentences. No Markdown, no bold.`
        : closingStyle === 'yijin'
          ? `\\n\\n【结语收尾方式（中文内容）】\\n- 中文内容**禁止**使用旁观式互动话术结尾：禁止「好了，我今天就讲到这里」「好了，今天就到这里。」「各位朋友」「各位家人」「保重」「晚安各位」「我们下次再聊」「感谢观看」等——这些词一出口，读者会立刻从「我」的讲学里被拽出来。\\n- 推荐收尾方式（用曾仕强风格自然收束）：\\n  - 「好了，讲了这么多，你自己去悟。」\\n  - 「我今天就讲到这里，信不信由你。」\\n  - 「记住老祖宗的话，自己去体会。」\\n- 禁止加粗、禁止 Markdown。`
          : `\\n\\n【结语收尾方式（中文内容）】\\n- 中文内容**禁止**使用旁观式互动话术结尾：禁止「好了，我今天就讲到这里」「好了，今天就到这里。」「各位朋友」「各位家人」「保重」「晚安各位」「我们下次再聊」「感谢观看」等。\\n- 推荐收尾方式：用宠物行为描写+自嘲直接收束，例如：\\n  - 「好了，不说了。家里的那只正用尾巴敲我键盘催我停了。」\\n  - 「好了，就到这儿吧。角落里有双眼睛正在催我睡了。」\\n- 禁止加粗、禁止 Markdown。`
    )
    : '';

  return `【总选题】${topic}
【全文主题】${coreTheme}
【逻辑主线】${logicLine}

【本章】${chapter.title}
${charRule}

【本章核心】${chapter.core_brief}

【衔接】
${isFirst ? '开篇直接从痛点/反常识切入，不要复述「上一章」。' : `开篇必须用 1–3 句自然承接下面语义（可改写，勿整段照抄）：\n「${chapter.opening_echo}」`}
${isLast ? '结尾收束全文：总结金句、呼应主题，自然收尾。' : `结尾必须自然收束，并融入过渡意图（供剪辑连贯）：\n「${chapter.bridge_to_next}」`}
${lastChapterInstruction}

【写作铁律】
${langLine}
${opts.voiceRules}
3. 本段是全文的一段中间稿，**不要写「谢谢大家」「感谢收看」等全场收场语**，除非当前为最后一章且字数已接近本章上限。
4. 只输出正文，不要标题行。`;
}

/**
 * Bo Yi / GREAT_POWER_GAME 赛道专用英文分段落 prompt 构造器。
 * 完全绕过 buildParallelSegmentUserPrompt，避免中文结构标签（【写作铁律】等）
 * 干扰英文输出。
 */
export function buildBoYiParallelSegmentUserPrompt(
  params: {
    topic: string;
    coreTheme: string;
    logicLine: string;
    chapter: YiJingChapterPlan;
    chapterIndex: number;
    totalChapters: number;
  },
  opts: {
    voiceRules: string;
    outputLanguage?: string;
    englishChapterCharStrict?: boolean;
    mindfulLanguage?: string;
  }
): string {
  const { topic, coreTheme, logicLine, chapter, chapterIndex, totalChapters } = params;
  const isFirst = chapterIndex === 0;
  const isLast = chapterIndex === totalChapters - 1;
  const isZhOutput = opts.outputLanguage === 'zh';

  // 英文输出
  const enCharRule = `Target: approximately ${chapter.min_chars}–${chapter.max_chars} English characters (including spaces and punctuation). Content completeness takes priority over strict word count.`;
  const enOpening = isFirst
    ? `Opening: Begin directly with the most counterintuitive, most devastating point. No preamble. No "In this video..." or "Today I want to talk about..."`
    : `Opening: Begin with 1-3 sentences that naturally承接 the previous chapter ("${chapter.opening_echo}"). Then immediately dive into the core argument.`;
  const enClosing = isLast
    ? `CLOSING: Summarize the core revelation. Then close with one of: "The game continues." or "The game never stops." — then stop immediately. No text after.`
    : `Closing: Provide a natural closing thought and a 1-2 sentence bridge to the next chapter ("${chapter.bridge_to_next}").`;

  // 中文输出
  const zhCharRule = `正文目标：约 ${chapter.min_chars}–${chapter.max_chars} 个中文字符（含标点空格）。内容完整性优先。`;
  const zhOpening = isFirst
    ? `开篇：直接切入最反直觉、最震撼的内幕爆料点。不要任何开场白。不要"在本视频中"或"今天我想讲讲"。`
    : `开篇：用 1–3 句话自然承接上一章（「${chapter.opening_echo}」），然后立即深入核心论点。`;
  const zhClosing = isLast
    ? `结语：总结核心内幕爆料，然后以"这场博弈还在继续。"或"博弈从未停止。"结尾——立即停止，不要任何后续文字。`
    : `结语：提供自然的收束语句，以及 1–2 句衔接下一章的过渡（「${chapter.bridge_to_next}」）。`;

  const charRule = isZhOutput ? zhCharRule : enCharRule;
  const sectionHeader = isZhOutput ? '【本章核心】' : 'Chapter core focus:';
  const logicHeader = isZhOutput ? '【逻辑主线】' : 'Logic:';
  const outputNote = isZhOutput
    ? '只输出正文。不要标题行。不要章节标记。纯自然段落。'
    : 'Output only the chapter body text. No titles. No headings. No stage directions. Pure prose.';

  const bridgeInstruction = isZhOutput
    ? isFirst
      ? zhOpening
      : `开篇：${zhOpening}\n结语：${zhClosing}`
    : enOpening;
  const closingInstruction = isZhOutput ? zhClosing : enClosing;

  return `${bridgeInstruction}
${charRule}

${sectionHeader} ${chapter.core_brief}

${logicHeader} ${logicLine}

${closingInstruction}

${opts.voiceRules}

${outputNote}`;
}

/**
 * Bo Yi / GREAT_POWER_GAME 赛道专用英文合并 prompt 构造器。
 * 完全绕过 buildParallelMergeUserPrompt，避免中文结构标签（【任务】等）
 * 干扰英文输出。
 */
export function buildBoYiParallelMergeUserPrompt(
  topic: string,
  combinedDraft: string,
  totalTargetChars: number | undefined,
  opts: {
    toneInstruction: string;
    outputLanguage?: string;
    mindfulLanguage?: string;
    englishMergedCharClamp?: { min: number; max: number };
    /** 显式指定合并后字数区间（优先级高于 auto 计算的 T*0.92/T*1.08） */
    mergeCharRange?: { min: number; max: number };
  }
): string {
  const T = totalTargetChars
    ? Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)))
    : 10000;

  // 优先使用显式区间；否则 auto 从 T 推导
  const { low, high } = opts.mergeCharRange
    ? { low: opts.mergeCharRange.min, high: opts.mergeCharRange.max }
    : { low: Math.round(T * 0.92), high: Math.round(T * 1.08) };

  const isZhOutput = opts.outputLanguage === 'zh';

  // Bo Yi 大国博弈：禁用字数目标强制约束，改为「自由输出 + 内容完整优先」
  // 原因：6段并行分段约20000字符，强制字数目标会让模型删减内容来凑字数
  // Bo Yi 赛道：去掉 enLengthRule/zhLengthRule 中的字数上限提示
  const clamp = opts.englishMergedCharClamp;
  // 英文：改为「不得少于原文」，不提上限
  const enLengthRule = clamp
    ? `Length requirement: The merged script must be AT LEAST as long as the combined draft (approximately ${clamp.min}+ characters). Do NOT shorten, truncate, or delete any content to meet a word count target. If the draft is longer than ${clamp.max} characters, that is acceptable — content completeness is non-negotiable.`
    : `Length requirement: The merged script must be AT LEAST as long as the combined draft. Do NOT shorten or delete any content to meet a word count target. If the merged result exceeds ${high} characters, that is acceptable — content completeness is non-negotiable.`;
  // 中文：改为「不得少于原文」，不提上限
  const zhLengthRule = `字数要求：合并后全文不得少于原文长度（至少约 ${low} 个中文字符）。不得因字数限制而删减任何内容。如合并后超出 ${high} 字，完全可以接受——内容完整性高于字数控制。`;

  if (isZhOutput) {
    // 中文合并 prompt
    return `任务：你是"博弈"（Bo Yi）地缘政治内幕爆料频道的资深编辑，正在合并多个分段的草稿。

## 核心原则——内容完整性优先
- 你必须保留每个草稿分段的所有内容。不要删除、不要截断、不要裁剪任何段落。
- 不要重写或润色正文主体文字。
- 只调整每个分段开头的 1–2 句话以创建流畅过渡。
- 最后一章（含结语）必须原封不动保留——包括其准确的结尾语句。

## 允许的操作
- 平滑过渡（仅限开头 1–2 句）。
- 删除连续重复的完全相同句子。
- 全文保持统一的博奕爆料人叙事语气。

## 禁止的操作
- 删除任何内容
- 截断任何段落
- 合并或拆分句子
- 替换词汇或改写正文
- 修改最后一段的自然结尾

## 语言强制（最高优先级）
全文必须使用**简体中文**输出，包括所有正文、金句、衔接句。禁止出现任何英文字符。如草稿包含英文——翻译为语义对等的简体中文。不要在正文中保留任何英文，禁止中英混合。

## 语气与风格
${opts.toneInstruction}

## 字数目标
${zhLengthRule}

## 草稿分段（必须全部包含）
${combinedDraft}

直接输出完整合并后的文案。不要加任何前言。不要写"以下是合并后的文案："或类似内容。直接输出文案。`;
  }

  return `TASK: You are merging draft segments for the topic: "${topic}". This is a Bo Yi geopolitical insider analysis voice-over script.

## Core Principles — Content Integrity First
- You MUST retain ALL content from every draft segment. Do NOT delete, truncate, or cut any paragraph.
- Do NOT rewrite, rephrase, or polish the main body text.
- Only make minor adjustments to the opening 1-2 sentences of each segment to create smooth transitions.
- The FINAL segment (closing) must be kept 100% intact — including its exact closing line.

## What You May Do
- Smooth transitions between segments (opening 1-2 sentences only).
- Remove duplicate identical sentences if they appear back-to-back.
- Apply the unified voice tone consistently across the full piece.

## What You Must NOT Do
- Delete any content
- Truncate any paragraph
- Merge or split sentences
- Replace words or rephrase the core text
- Modify the natural ending of the final segment

## Language Rule (CRITICAL — Zero Tolerance)
The ENTIRE merged script must be in **pure English**. If the draft contains ANY Chinese characters, Chinese phrases, or mixed language — translate everything to English. Do NOT preserve Chinese in any form: not in the main text, not in parentheses, not in brackets. Pure English only.

## Voice & Tone
${opts.toneInstruction}

## Length Target
${enLengthRule}

## Draft Segments (MUST ALL BE INCLUDED)
${combinedDraft}

Output the complete merged script. Do not add any preamble. Do not write "Here is the merged script:" or similar. Just output the script directly.`;
}

/** @deprecated 请用 buildParallelSegmentUserPrompt */
export function buildSegmentUserPrompt(params: {
  topic: string;
  coreTheme: string;
  logicLine: string;
  chapter: YiJingChapterPlan;
  chapterIndex: number;
  totalChapters: number;
}): string {
  return buildParallelSegmentUserPrompt(params, {
    outputLanguage: 'zh',
    voiceRules: `1. 曾仕强口吻：自然穿插，**有节制**——"各位朋友"≤2次、"我常常讲/我告诉你"≤2次、"你仔细去看"≤1次；多用"你看""你说""你不要小看""这就是智慧""大错特错"等变化句式替代重复。
2. 纯净口播：禁止【】、[] 舞台提示、禁止「模块一/第一节」等章节标、禁止 Markdown、禁止列表骨架腔。`,
  });
}

export type ParallelMergePromptOpts = {
  channelTag: string;
  toneInstruction: string;
  outputLanguage: 'zh' | 'en';
  /** 口播/解说/脚本 */
  contentKind?: string;
  /** 治愈心理学英文：合并后全文字符（含空格）必须落在此闭区间内 */
  englishMergedCharClamp?: { min: number; max: number };
  /** 多语言输出时的语言，用于生成正确的结尾 CTA */
  mindfulLanguage?: string;
};

export function buildParallelMergeUserPrompt(
  topic: string,
  combinedDraft: string,
  totalTargetChars: number | undefined,
  opts: ParallelMergePromptOpts
): string {
  const T = totalTargetChars
    ? Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)))
    : 10000;
  const low = Math.round(T * 0.92);
  const high = Math.round(T * 1.08);
  const kind = opts.contentKind || '正文';
  const isEnglish = opts.outputLanguage === 'en';

  const lang = isEnglish
    ? '【语言强制】合并后全文必须使用**英文**。将所有中文片段翻译为英文语义对等表达。禁止保留任何中文字符。'
    : '【语言强制】合并后全文必须使用**简体中文**。将所有英文片段翻译为中文语义对等表达。禁止保留任何英文正文字符。';

  const clamp = opts.englishMergedCharClamp;
  const lengthRule = clamp
    ? `7. 全文字符数尽量接近 **${clamp.min}–${clamp.max}** 范围；如超出上限仅允许小幅删减，如不足下限仅允许小幅补过渡；但**内容完整性优先**，不得因字数要求而截断任何段落。`
    : `7. 保留原文完整内容，不得因字数要求而截断任何段落。如字数略有偏差可接受。`;

  return `【任务】以下是由「${topic}」分段生成的${opts.channelTag}${kind}初稿拼接而成。请执行「合并初稿 + 统一全文语气」。

## ⚠️ 核心原则：内容完整性优先
- **必须保留所有分段的完整内容**，禁止删除、截断任何段落
- **禁止对正文内容进行改写、重写、润色**
- **只允许微调段落开头1-2句**，使其与上一段自然衔接
- **最后一段（结语）的全部内容必须原样保留**，包括完整结尾

## 具体操作要求

1. **保留分段内容**：
   - 前4段：只微调开头1-2句与上一段衔接，主体内容原样保留
   - **最后一段：100% 原样保留，禁止任何修改或删除**

2. **处理重复内容**：
   - 如果段与段之间有完全重复的句子，可选择性保留一处

3. **语气统一**：
   ${opts.toneInstruction}

4. ${lang}

5. **禁止行为**：
   - ❌ 禁止删除任何内容
   - ❌ 禁止截断任何段落
   - ❌ 禁止合并或拆分句子
   - ❌ 禁止替换词语
   - ❌ 禁止修改末尾自然结尾

6. ${lengthRule}

【初稿完整内容】
${combinedDraft}

请直接输出**完整终稿**，必须包含所有分段的完整内容，不得截断。`;
}

export function buildParallelMergeSystem(editorLine: string): string {
  return `${editorLine}只输出合并后的正文。`;
}

export const YI_JING_MERGE_SYSTEM = buildParallelMergeSystem('你是资深口播编辑，熟悉曾仕强讲学风格。');

/** @deprecated 请用 buildParallelMergeUserPrompt */
export function buildMergeUserPrompt(
  topic: string,
  combinedDraft: string,
  totalTargetChars?: number
): string {
  return buildParallelMergeUserPrompt(topic, combinedDraft, totalTargetChars, {
    channelTag: '',
    toneInstruction: '全文语气统一为曾仕强式娓娓道来；保持简体中文。',
    outputLanguage: 'zh',
    contentKind: '口播',
  });
}
