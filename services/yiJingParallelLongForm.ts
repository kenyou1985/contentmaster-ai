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
export const YI_JING_BAND1_MAX = 10000; // ≤ 10000 → 固定 5 章
export const YI_JING_BAND2_MAX = 25000; // 10001–25000 → 5–10 章

/**
 * 长文自动章数：
 * - T ≤ 10000          → 固定 5 章
 * - 10000 < T ≤ 25000  → ceil(T / 3000)，限制 5–10 章
 * - T > 25000          → ceil(T / 3000)，限制 6–40 章
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
1. 共 **${segmentCount}** 章；全片合并后有效字数目标约 **${T} 字**（允许成稿落在约 ${low}–${high} 字区间），每章 min_chars / max_chars 需合理分摊总目标，单章 min_chars 约 ${perLo}–${perHi}（在 JSON 里逐章给出，且 max_chars - min_chars ≤ 450）。
2. ${opts.logicBlueprint}
3. 每章必须包含：
   - title：章标题（4–12 字，title 内可不写「第X章」）
   - min_chars / max_chars：整数
   - core_brief：本章要讲透的论点与素材方向（50–120 字）
   - opening_echo：**从上一章收束语义自然承接**的开头提示（第1章填空字符串 ""）；约 40–80 字，供写稿时嵌入开篇
   - closing_snippet_hint：本章结尾希望出现的收束语义摘要（40–80 字），供下一章 opening_echo 使用
   - bridge_to_next：本章末 1–2 句过渡到下一章的提示（最后一章写总结升华，不写引出新话题）

4. 只输出 **一个 JSON 对象**，不要 Markdown、不要注释。键名必须完全一致：
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
  const langLine =
    opts.outputLanguage === 'en'
      ? '全文使用**英文**输出（与频道要求一致），不要中文正文。'
      : '全文使用**简体中文**输出。';

  const charRule = opts.englishChapterCharStrict
    ? `【本章字数】英文正文有效字符（含空格与标点）**必须**落在 ${chapter.min_chars}–${chapter.max_chars} 之间；禁止低于 ${chapter.min_chars}，禁止高于 ${chapter.max_chars}；宁简勿灌。`
    : `【本章字数】有效字符约 ${chapter.min_chars}–${chapter.max_chars} 字（宁多勿少，但不要超过 ${chapter.max_chars + 150}）`;

  return `【总选题】${topic}
【全文主题】${coreTheme}
【逻辑主线】${logicLine}

【当前章节】${chapterIndex + 1} / ${totalChapters} — ${chapter.title}
${charRule}

【本章核心】${chapter.core_brief}

【衔接】
${isFirst ? '开篇直接从痛点/反常识切入，不要复述「上一章」。' : `开篇必须用 1–3 句自然承接下面语义（可改写，勿整段照抄）：\n「${chapter.opening_echo}」`}
${isLast ? '结尾收束全文：总结金句、呼应主题，可引导互动；禁止再引出新的大话题。' : `结尾必须自然收束，并融入过渡意图（供剪辑连贯）：\n「${chapter.bridge_to_next}」`}

【写作铁律】
${langLine}
${opts.voiceRules}
3. 本段是全文的一段中间稿，**不要写「谢谢大家」「感谢收看」等全场收场语**，除非当前为最后一章且字数已接近本章上限。
4. 只输出正文，不要标题行。`;
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
    voiceRules: `1. 曾仕强口吻：各位朋友、我常常讲、易经告诉我们、老祖宗说、你仔细去看、不要瞎折腾、这就是智慧、大错特错 等自然穿插。
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
  const head = combinedDraft.slice(0, 12000);
  const tail = combinedDraft.length > 12000 ? combinedDraft.slice(-8000) : '';
  const kind = opts.contentKind || '正文';
  const lang =
    opts.outputLanguage === 'en'
      ? '合并后全文使用**英文**，与各段语言一致。'
      : '合并后全文使用**简体中文**。';

  const clamp = opts.englishMergedCharClamp;
  const lengthRule = clamp
    ? `6. 合并后英文全文有效字符（含空格与标点）**必须**落在 **${clamp.min}–${clamp.max}** 之间；若初稿总长超出上限，须删繁就简、去重合并，**禁止**为凑字数灌水；若不足下限，仅允许少量补过渡，仍不得超 ${clamp.max}。`
    : `6. 保留足够字数（目标总有效字数约 ${T} 字，合并后尽量落在约 ${low}–${high} 字），不要随意大删。`;

  return `【任务】以下是由「${topic}」分段生成的${opts.channelTag}${kind}初稿拼接而成。请执行「合并初稿 + 统一全文语气」：

1. 删除段与段之间的重复开头/重复金句（若有）。
2. 理顺衔接：微调上一段尾与下一段首的重复或断裂，使一口气读完/听完自然。
3. ${opts.toneInstruction}
4. ${lang}
5. 禁止新增与主题无关的大段；禁止改变核心事实与论点。
${lengthRule}
7. 全文仅允许**一处**自然的尾声（最后 200 字内）：可感谢与引导互动，不要在中途写收场语。

【初稿】
${head}
${tail && combinedDraft.length > 12000 ? `\n\n...（中略 ${combinedDraft.length - 20000} 字）...\n\n` : ''}
${tail ? `【初稿末段】\n${tail}` : ''}

请直接输出合并润色后的**完整终稿**（单篇），不要前言后记。`;
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
