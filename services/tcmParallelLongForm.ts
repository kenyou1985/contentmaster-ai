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
export const TCM_BAND1_MAX = 10000;
export const TCM_BAND2_MAX = 25000;

/**
 * 长文自动章数：
 * - T ≤ 10000          → 固定 5 章
 * - 10000 < T ≤ 25000 → ceil(T / 3000)，限制 5–10 章
 * - T > 25000          → ceil(T / 3000)，限制 6–40 章
 */
export function computeTCMSegmentCount(totalTargetChars: number): number {
  const T = Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)));
  if (T <= TCM_BAND1_MAX) {
    return 5;
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

  return `【任务】以下是由「${topic}」分段生成的倪海厦风格口播初稿拼接而成。请执行「合并初稿 + 去除重复 + 统一全文语气」。

## ⚠️ 核心原则

1. **只删除重复的模板句/套话/开场白/结尾语**，禁止删除正文内容
2. **去除重复内容**（详见下方）
3. **只微调段落开头1-2句**，使其与上一段自然衔接
4. **最后一段的结尾必须原样保留**

## 必须去除的重复内容

### 致命重复（全文只保留一次）
- ❌ 「各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。」→ 只保留第一章开头
- ❌ 「好了，我们开始上课。」→ 只保留第一章引子后
- ❌ 「说真的，我这话难听，但是不骗你。」→ 只保留第一次出现
- ❌ 「你说你不信？行，你继续不信，我讲完你自己掂量。」→ 只保留第一次出现
- ❌ 「你们不要笑，这种事情我见太多了，有时候我自己回想起来也觉得……真的，说不下去了。」→ 只保留第一次出现
- ❌ 「我年轻时候也铁齿，有年交运日偏要去爬山，结果摔了一跤，膝盖肿了半个月。」→ 只保留第一次出现
- ❌ 「我跟你讲，有时候我自己在诊所里也……唉算了，不说这个了。」→ 只保留第一次出现
- ❌ 「我在临床上看太多了。」→ 只保留第一次出现
- ❌ 「从那以后我才知道，有些事不是迷信，是经验。」→ 只保留第一次出现
- ❌ 「我讲到这里，你可能觉得……不对，等等，我说的是」→ 只保留第一次出现
- ❌ 「你这是在作死。」→ 只保留第一次出现（任意上下文）
- ❌ 「诸位乡亲」→ 只保留第一次出现
- ❌ 「我今天必须骂醒你们」→ 只保留第一次出现
- ❌ 「你说这是不是自找麻烦」→ 只保留第一次出现
- ❌ 「气一乱，脸和身体先知道。」或「气一乱，脸先变，身体先喊话。」→ 只保留第一次出现
- ❌ 「真有这么明显吗」→ 只保留第一次出现
- ❌ 「好了，讲了这么多，你自己去悟。」→ 只保留最后一次出现（结尾）
- ❌ 「好了，今天就讲到这儿。」→ 只保留最后一次出现（结尾）
- ❌ 「好了，我话讲完了，信不信由你。」→ 只保留最后一次出现（结尾）
- ❌ 「好了，我话讲完了，信不信随你。」→ 只保留最后一次出现（结尾）
- ❌ 「下课！」→ 只保留全文最后末尾一次，删除所有中间的"下课！"
- ❌ 「你铁齿」→ 只保留第一次出现（任意上下文，包括"别铁齿"、"还在那里铁齿"）
- ❌ 「人不是铁打的」→ 只保留第一次出现
- ❌ 「身体已经给你脸色看」或「身体很老实」或「气不会骗人」→ 只保留第一次出现
- ❌ 「你自己把自己搞乱」→ 只保留第一次出现
- ❌ 「不是在讲时髦」→ 只保留第一次出现
- ❌ 「不是在吓人」或「不是开玩笑」→ 只保留第一次出现
- ❌ 「不是巧合」或「你以为是巧合」→ 只保留第一次出现
- ❌ 「面色发白/发黄/发青 + 脾胃/气血报警」类段落 → 全文只保留1个最完整的
- ❌ 「粗盐洗手」类段落（洗手+躁气+浊气）→ 全文只保留1个最完整的
- ❌ 「临床案例：台中阿伯」类段落 → 全文只保留1个最完整的
- ❌ 「白黄收稳/黑蓝下沉」类段落 → 全文只保留1个最完整的
- ❌ 「铁齿的人最后自己倒霉」类段落 → 全文只保留1个最完整的
- ❌ 「早睡早起少熬夜」类段落 → 全文只保留1个最完整的
- ❌ 「说实在的」开头句式 → 只保留第一次出现
- ❌ 「你们最容易」开头句式 → 只保留第一次出现
- ❌ 「你以为只是」开头句式 → 只保留1个最完整的
- ❌ 「你说这是不是」开头句式 → 只保留1个
- ❌ 「我今天非/先/要/把话/骂」开头句式 → 只保留1个最完整的
- ❌ 「好了」单独过渡句（无实质内容）→ 删除
- ❌ 「不是巧合」类转折句 → 只保留1个
- ❌ 「你以为只是天气热」类解释句 → 只保留1个最完整的
- ❌ 「光讲道理」开头句 → 只保留1个
- ❌ 「有的人/有些人」开头句式 → 只保留1个最完整的
- ❌ 「脸色/脾胃/睡眠/火气」症状罗列类段落 → 只保留1个最完整的
- ❌ 「临床上/诊所里 + 阿伯/太太」案例段落 → 只保留1个最完整的
- ❌ 「回家先洗手」类操作指导段落 → 全文只保留1个最完整的
- ❌ 「好了，开始上课」→ 只保留第一章后第一次出现
- 任何其他重复超过2次的套话/金句 → 删除多余出现

### 重复段落检查（最重要！）
- **逐段对比全文所有段落**：如果两个完整段落内容相似度>85%，删除后出现的那个
- 特别注意：结尾部分最容易出现"所以你看，所谓避忌，不是叫你迷信"这类整段重复
- 如果发现连续两段讲同一件事，只保留内容更丰富的那段
- 正文超过2次出现的同义段落，删除多余版本
- **段落开场去重**：全文同一类型段落开头模式只允许出现1次，严格执行：
  - 「我今天非...」「我今天先...」「我今天把话...」「我今天要...」「我今天骂...」→ 只保留1个最完整的，其余删除
  - 「你以为...」「你以为只是...」「你以为这...」→ 只保留1个最完整的，其余删除
  - 「你铁齿」→ 只保留第一个，其余全部删除（含"别铁齿"、"还在那里铁齿"）
  - 「我年轻时候也铁齿」→ 只保留第一个，其余删除
  - 「我在临床上看过」「我在诊所里看过」「我在诊所里也」→ 只保留1个最完整的案例段落，其余删除
  - 「你说...」「你说这是不是...」「你说你不信...」→ 只保留第一个，其余删除
  - 「我讲到这里，你可能觉得」→ 只保留第一个，其余删除
  - 「我跟你讲」「我跟你说」→ 只保留第一个，其余删除
  - 「好了」单独句（无后续实质内容）→ 删除
  - 「你们不要笑」开头 → 只保留第一个，其余删除
  - 「真有这么明显吗」→ 只保留第一个，其余删除
  - 「光讲道理还不够」「光讲理论」→ 只保留第一个，其余删除
  - 「真要转顺」「事情说到这里」→ 只保留第一个，其余删除
- **语义重复检查**：不同表述但讲同一件事的段落，只保留1个最完整的：
  - 立夏/节气/交运日前后 + 铁齿 + 乱穿 + 乱吃 + 乱睡 → 只保留1个最完整的
  - 脸色发白/发黄/发青 + 脾胃报警 → 只保留1个最完整的
  - 白黄收稳/黑蓝下沉/颜色让人更沉 → 只保留1个最完整的
  - 铁齿的人最后自己倒霉 → 只保留1个最完整的
  - 早睡早起少熬夜/晚上早点收心 → 只保留1个最完整的
  - 洗手/洗手换衣服/把乱气挡外面 → 只保留1个最完整的
  - 「你以为只是天气热一点」类 → 只保留1个最完整的
  - 「有的人/有些人...脸色不对」类 → 只保留1个最完整的

## 具体操作要求

1. **处理开场白**：
   - 保留第一章的开场白
   - 删除第2-N章中所有的开场白

2. **处理过渡语**：
   - 保留第一章的「好了，我们开始上课。」
   - 删除其他章节的「好了，我们开始上课。」

3. **处理套话**：
   - 搜索全文，保留每种套话/金句的第一次出现（或最后一次出现，视情况而定）
   - 删除后续章节中的重复套话

4. **处理案例**：
   - 检查各章节的案例，将重复案例合并为一个最完整的版本
   - 删除其他重复的案例描述

5. **整段重复检查**：
   - 逐段扫描全文
   - 如果发现两个段落高度相似（>85%），删除后出现的那个
   - 如果发现某段在全文中出现超过2次，删除多余出现

6. ${opts.toneInstruction}

7. **禁止行为**：
   - ❌ 禁止删除正文内容（只删除重复的模板句/开场白/套话/重复段落）
   - ❌ 禁止截断任何段落
   - ❌ 禁止修改正文句子（只微调衔接句）
   - ❌ 禁止添加新内容

8. 保留原文完整内容，不得因字数要求而截断任何段落。如字数略有偏差可接受。

【初稿完整内容】
${combinedDraft}

请直接输出**完整终稿**，必须包含所有分段的完整内容，去除重复模板句后自然衔接。`;
}

export function buildParallelMergeSystem(editorLine: string): string {
  return `${editorLine}只输出合并后的正文，禁止输出任何说明、注释或标记。`;
}

export const TCM_MERGE_SYSTEM = `你是资深口播编辑，熟悉倪海厦讲学风格。你必须执行以下任务：
1. 合并分段初稿，自然衔接各段内容
2. 【关键】删除所有重复的模板句/开场白/套话/结尾语（全文只保留第一次或最后一次）：
   - "我在临床上看太多了" → 只保留第一次
   - "从那以后我才知道，有些事不是迷信，是经验" → 只保留第一次
   - "我年轻时候也铁齿，有年交运日偏要去爬山，结果摔了一跤，膝盖肿了半个月" → 只保留第一次（全文只允许1次）
   - "我讲到这里，你可能觉得……不对，等等，我说的是" → 只保留第一次
   - "你这是在作死" → 只保留第一次（任意上下文）
   - "人一乱，家就乱；家一乱" → 只保留第一次
   - "诸位乡亲" → 只保留第一次
   - "我今天必须骂醒你们" → 只保留第一次
   - "你们不要笑，这种事情我见太多了，有时候我自己回想起来也觉得……真的，说不下去了" → 只保留第一次（全文只允许1次）
   - "我跟你讲，有时候我自己在诊所里也……唉算了，不说这个了" → 只保留第一次（全文只允许1次）
   - "你说你不信？行，你继续不信，我讲完你自己掂量" → 只保留第一次
   - "你说这是不是自找麻烦" → 只保留第一次
   - "气一乱，脸和身体先知道" → 只保留第一次
   - "真有这么明显吗" → 只保留第一次
   - "好了，讲了这么多，你自己去悟。" → 只保留最后一次（结尾）
   - "好了，今天就讲到这儿。" → 只保留最后一次（结尾）
   - "好了，我话讲完了，信不信由你。" → 只保留最后一次（结尾）
   - "好了，我话讲完了，信不信随你。" → 只保留最后一次（结尾）
   - "说真的" → 全文只保留最多1次，删除其余所有出现（含"说实在的"、"讲真的"）
   - "我这话难听" → 全文只保留最多1次，删除其余
   - "说真的，我这话难听，但是不骗你。" → 只保留第一次
   - "下课！" → 只保留全文最后末尾一次，删除所有中间的
   - "你铁齿" → 只保留第一次（任意上下文，含"别铁齿"、"还在那里铁齿"）
   - "人不是铁打的" → 只保留第一次
   - "身体已经给你脸色看"或"身体很老实"或"气不会骗人" → 只保留第一次
   - "你自己把自己搞乱" → 只保留第一次
   - "不是在讲时髦" → 只保留第一次
   - "不是在吓人"或"不是开玩笑" → 只保留第一次
   - "不是巧合"或"你以为是巧合" → 只保留第一次
   - 临床案例段落（"我在临床上看过"、"我在诊所里看过"等）→ 全文只保留最多2个最完整的
   - "面色发白/发黄/发青 + 脾胃/气血"类段落 → 全文只保留1个最完整的
   - "白黄收稳/黑蓝下沉"类段落 → 全文只保留1个最完整的
   - "粗盐洗手"类段落 → 全文只保留1个最完整的
   - 任何重复超过2次的套话/金句 → 删除多余出现
3. 【关键】检查整段重复：如果两个段落相似度>85%，删除后出现的那个
4. 【关键】段落开场去重：全文同一类型段落开头模式不得超过规定次数
   - "我今天非/先/要/把话/骂..." → 全文只保留最多2个最完整的，其余删除
   - "你以为..." → 全文只保留最多2个最完整的，其余删除
   - "你铁齿" → 全文只保留第一个（含"别铁齿"、"还在那里铁齿"）
   - "我年轻时候也铁齿" → 全文只保留第一个，其余删除
   - "我在临床上看过" → 全文只保留最多2个最完整的案例段落
   - "你说..." → 全文只保留第一个，其余删除
   - "我讲到这里，你可能觉得" → 全文只保留第一个，其余删除
   - "我跟你讲" → 全文只保留第一个，其余删除
   - "好了"单独句 → 删除
   - "光讲道理" → 全文只保留第一个
5. 【结尾要求】全文结尾段必须包含互动引导 + 收尾语：
   - 互动引导：请观众在评论区留言输入正向祈福词语（安康、顺遂、平安、吉祥、福寿、如意、康宁、无恙之一）
   - 收尾语：必须以"咱们下期再见"、"下期再见"、"下期节目再见"、"我们下期见"或"下课！"之一自然结尾
   - 删除结尾段中任何"博弈还在继续"、"The game continues"等非中医玄学风格的结尾
6. 只删除重复部分，保留正文完整内容
7. 只输出合并后的正文，禁止输出任何说明、注释或标记。`;
