/**
 * 分段并行长内容：大纲 JSON → 分段并行生成 → 合并润色（中医玄学倪海厦风格专用）
 */

export type TCMChapterPlan = {
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

export type TCMOutlinePayload = {
  core_theme: string;
  logic_line: string;
  chapters: TCMChapterPlan[];
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

export function parseTCMOutline(raw: string): TCMOutlinePayload | null {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return null;
  try {
    const o = JSON.parse(jsonStr) as Record<string, unknown>;
    const chapters = o.chapters;
    if (!Array.isArray(chapters) || chapters.length === 0) return null;
    const mapped: TCMChapterPlan[] = chapters.map((c: any, i: number) => ({
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

/** 按全文目标字数均摊到各章 min/max */
export function rescaleChapterWordCounts(
  parsed: TCMOutlinePayload,
  totalTarget: number
): TCMOutlinePayload {
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

export function outlinePayloadToJsonPretty(parsed: TCMOutlinePayload): string {
  return JSON.stringify(parsed, null, 2);
}

/** 单次分段流式生成下，单章口播汉字的保守上限 */
export const TCM_CHARS_PER_SEGMENT_SOFT_CAP = 3000;

/** 三段式分章常量（长文） */
export const TCM_BAND1_MAX = 8000;
export const TCM_BAND2_MAX = 25000;

/**
 * 长文自动章数：
 * - T ≤ 8000           → ceil(T / 900)（约 5–9 章，每段约 900-1600 字）
 * - 8000 < T ≤ 25000   → ceil(T / 3000)，限制 5–10 章
 * - T > 25000          → ceil(T / 3000)，限制 6–40 章
 */
export function computeTCMSegmentCount(totalTargetChars: number): number {
  const T = Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)));
  if (T <= TCM_BAND1_MAX) {
    return Math.max(5, Math.ceil(T / 900));
  }
  const raw = Math.ceil(T / TCM_CHARS_PER_SEGMENT_SOFT_CAP);
  if (T <= TCM_BAND2_MAX) {
    return Math.max(5, Math.min(10, raw));
  }
  return Math.max(6, Math.min(40, raw));
}

/** 短视频/短脚本：章数少一些 */
export function computeShortTCMSegmentCount(totalTargetChars: number): number {
  const T = Math.min(8000, Math.max(300, Math.round(totalTargetChars)));
  return Math.max(1, Math.min(4, Math.ceil(T / 700)));
}

export function computeParallelSegmentCount(
  totalTargetChars: number,
  scriptMode: 'LONG' | 'SHORT'
): number {
  return scriptMode === 'SHORT'
    ? computeShortTCMSegmentCount(totalTargetChars)
    : computeTCMSegmentCount(totalTargetChars);
}

/** 倪海厦风格逻辑线 */
export const PARALLEL_LOGIC_TCM =
  '逻辑线清晰：开场抓注意力（骂醒式破局）→ 展开核心论述（面相与身体警报）→ 案例支撑（临床故事）→ 总结收束（金句点题）→ 自然结尾（下课式收尾）。各章须层层递进，禁止重复。';

export type ParallelOutlinePromptOpts = {
  channelLabel: string;
  contentKind: string;
  logicBlueprint: string;
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
  return `${head}【选题】${topic}

【任务】为以上选题生成${opts.channelLabel}的**章节大纲**（${opts.contentKind}），用于后续分段并发生成（每段单独请求，最后合并）。
【计量说明】全文总目标与各章 min_chars / max_chars 均为**中文字符**（含标点），**不是**英文单词数。

【硬性要求】
1. 共 **${segmentCount}** 章；全片合并后目标约 **${T} 字**（允许合理偏差），每章 min_chars / max_chars 需合理分摊，单章约 ${perLo}–${perHi}（在 JSON 里逐章给出，max_chars - min_chars ≤ 600）。
2. ${opts.logicBlueprint}
3. 每章必须包含：
   - title：章标题（4–12 字，**禁止**使用「第X章」「第一章」「第三章」等章节编号，只能是自然的短句标题）
   - min_chars / max_chars：整数
   - core_brief：本章要讲透的论点与素材方向（50–120 字）
   - opening_echo：**从上一章收束语义自然承接**的开头提示（第1章填空字符串 ""）；约 40–80 字
   - closing_snippet_hint：本章结尾希望出现的收束语义摘要（40–80 字）
   - bridge_to_next：本章末 1–2 句过渡到下一章的自然过渡提示（最后一章写总结升华）

4. **章节编号禁止**：严格禁止输出任何「第1章」「第二章」「第一部分」「Section 1」等带编号的章节标记。

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

export type ParallelMergePromptOpts = {
  toneInstruction: string;
  outputLanguage: string;
  contentKind: string;
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

  return `【任务】以下是由「${topic}」分段生成的倪海厦风格口播初稿拼接而成。请执行「合并 + 去除少量重复套话 + 统一语气」。

## ⚠️ 核心原则（极其重要）

1. **正文内容一个字都不许删**——每段每句的正文内容必须原样保留在终稿中
2. **只删除**下面明确列出的"精确重复套话"
3. **只微调**各段开头1-2句，使其与前段自然衔接
4. **最后一段的结尾必须原样保留，不得截断**

## 精确重复套话（全文只保留一次，其余删除）

以下为**完全匹配**的重复句式，只删除后续出现，保留第一次出现（或最后一次，视标注）：

- 「各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。」→ 只保留全文最开头那一次
- 「好了，我们开始上课。」→ 只保留第一章引子后那一次
- 「下课！」→ 只保留全文最后末尾那一次，删除所有中间的
- 「说真的，我这话难听，但是不骗你。」→ 只保留第一次
- 「你说你不信？行，你继续不信，我讲完你自己掂量。」→ 只保留第一次
- 「诸位乡亲」→ 只保留第一次
- 「我今天必须骂醒你们」→ 只保留第一次
- 「你这是在作死」→ 只保留第一次
- 「好了，今天先讲到这儿」→ 只保留最后一次（结尾）
- 「好了，我话讲完了，信不信随你」→ 只保留最后一次（结尾）
- 「好了」单独成句（前后无实质内容）→ 删除该句

## 操作方法

1. **扫描全文**：找到上述精确重复套话的第2次及后续出现
2. **仅删除该套句本身**：保留该句前后的所有正文内容
3. **微调衔接句**：各段开头如与前段末尾有明显断裂，微调1-2句使其自然衔接
4. **检查最后一段**：确保结尾完整保留，不得截断
5. **禁止行为**：
   - ❌ 禁止删除任何正文句子
   - ❌ 禁止删除整段内容
   - ❌ 禁止以"语义相似"为由删除内容
   - ❌ 禁止合并两个段落导致内容丢失
   - ❌ 禁止截断任何段落

## 结尾要求

全文结尾必须包含：
- 互动引导：请观众在评论区留言（安康、顺遂、平安、吉祥、福寿、如意、康宁、无恙之一）
- 收尾语：以「咱们下期再见」或「下课！」自然结尾

【初稿完整内容】
${combinedDraft}

请直接输出**完整终稿**，正文内容与原文完全一致，只去除上述精确重复套话。`;
}

export function buildParallelMergeSystem(editorLine: string): string {
  return `${editorLine}只输出合并后的正文，禁止输出任何说明、注释或标记。`;
}

export const TCM_MERGE_SYSTEM = `你是资深口播编辑，熟悉倪海厦讲学风格。执行以下任务：

1. 合并分段初稿，自然衔接各段内容
2. 【关键】只删除精确重复的套话句，全文正文内容必须原样保留：
   - 「各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。」→ 只保留最开头那一次
   - 「好了，我们开始上课。」→ 只保留第一次
   - 「下课！」→ 只保留最后末尾那一次
   - 「诸位乡亲」→ 只保留第一次
   - 「我今天必须骂醒你们」→ 只保留第一次
   - 「你这是在作死」→ 只保留第一次
   - 「说真的，我这话难听，但是不骗你。」→ 只保留第一次
   - 「好了，今天先讲到这儿」→ 只保留最后一次（结尾）
   - 「好了，我话讲完了，信不信随你」→ 只保留最后一次（结尾）
   - 「好了」单独成句（无实质内容）→ 删除
3. 只微调各段开头1-2句使衔接自然
4. 最后一段结尾必须完整保留，不得截断
5. 【禁止行为】禁止删除正文句子，禁止以"语义相似"为由删除内容
6. 结尾引导：请观众在评论区留言（安康、顺遂、平安、吉祥、福寿、如意、康宁、无恙之一），以「咱们下期再见」或「下课！」结尾
7. 只输出合并后的正文，禁止输出任何说明、注释或标记。`;
