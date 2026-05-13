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

const TIME_TABOO_LESSON_CORE_BRIEFS = [
  // 0: 引子
  '先描述当天干支能量特征，制造紧迫感。包含：国历日期（农历XX月XX）、干支日、天干地支能量描述、当天整体磁场特征（用大白话，不用术语）、直接警告当天最大风险点（颜色穿错=火上浇油/破财伤身）、直接公布结论（大吉推荐色/全体禁忌色）。格式参考："这一天，很多人会感到莫名焦虑、睡眠极差。这是天地的火毒在焚烧你的气血！"',
  // 1: 第一节课
  '点出特定节气/日子的危险性，痛骂观众的致命错误，制造生存危机；语气自然延续引子。讲清楚为什么这一天特别危险，重点在制造紧迫感和危机意识。',
  // 2: 第二节课
  '展开引子中的干支分析：天干地支各自含义（用大白话讲透，不要堆术语）、为什么这一天能量特殊（与前一天/后一天对比）、三天连看模式下分别讲每天的能量特点、点出"哪一天最适合签合同/冲业绩/见客户"。',
  // 3: 第三节课
  '全体禁忌色全章核心：直接告诉观众当天所有人都不能穿的某几种颜色，讲清楚为什么穿这个颜色=火上浇油/破财/伤身，口语化描述后果（轻则破财，重则伤病）。参考句式："今天你穿这个颜色，就是在自己身上点火！"',
  // 4: 第四节课
  '大凶警戒组：3个生肖+严禁什么颜色+穿了的后果。讲清哪几个生肖严禁什么颜色。参考："属龙属鼠属猪，今天严禁红色！水被火压，穿红=火上浇油！"',
  // 5: 第五节课
  '平稳过渡组：3个生肖+安抚情绪+防守颜色。讲清哪些生肖为什么穿这个颜色+穿对后效果。参考："属虎属马属狗属蛇，今天必穿白色——这是老天爷给你的开运色！"',
  // 6: 第六节课
  '生肖分组·小幸运儿与逆天改命：分两组——小幸运儿组（当天合相加持生肖，穿某色=加分/意外好运，如"属兔卯戌相合，穿绿色最加分"）+ 逆天改命组（3个生肖+吸金行动+吸金颜色）。',
  // 7: 第七节课
  '民俗大忌：祭祀/出行致命错误，打死不能丢或不能做的事，辅以真实案例，用大白话讲清楚禁忌的原因和后果。',
  // 8: 第八节课
  '千金难买接气法：3个极低成本实操动作，每个动作讲清楚具体做法（要可执行，如"买一双蓝袜子""阴阳水泡脚"）、为什么有效（用大白话解释）、什么时间做效果最好。参考："你今天花十块钱买一双蓝袜子穿上，比你烧一百块香还管用！"',
];

export function buildTCMTimeTabooOutlineUserPrompt(
  topic: string,
  segmentCount: number,
  totalTargetChars: number,
  opts: ParallelOutlinePromptOpts,
  leadContext?: string
): string {
  const T = Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)));
  const perBase = Math.floor(T / segmentCount);
  const perLo = Math.max(200, perBase - Math.min(200, Math.round(perBase * 0.12)));
  const perHi = perBase + Math.min(200, Math.round(perBase * 0.12));
  const head = leadContext?.trim()
    ? `${leadContext.trim()}\n\n---\n\n`
    : '';

  const lessonCoreBriefs = TIME_TABOO_LESSON_CORE_BRIEFS.map((brief, i) => {
    const titles = ['引子', '第一节课：紧急通报与警示', '第二节课：干支能量深度解读', '第三节课：全体禁忌色·全章核心', '第四节课：大凶警戒组', '第五节课：平稳过渡组', '第六节课：生肖分组·小幸运儿与逆天改命', '第七节课：民俗大忌', '第八节课：千金难买接气法'];
    return `    {\n      "title": "${titles[i]}",\n      "min_chars": ${perLo},\n      "max_chars": ${perHi},\n      "core_brief": "${brief}",\n      "opening_echo": "${i === 0 ? '' : '自然承接上文情绪与语义，继续往下讲'}",\n      "closing_snippet_hint": "收束本章核心，自然引出下一节内容${i < 8 ? '，为下一节埋下伏笔' : '，总结升华本集主题'}",\n      "bridge_to_next": "${i < 8 ? '用口语化转折句衔接下一节（如"我还没讲完"、"还有一点你们必须知道"），禁止用"好了"开头' : '全文总结升华，以终局判断收束'}"\n    }`;
  }).join(',\n');

  return `${head}【选题】${topic}

【任务】为以上选题生成倪海厦中医玄学风格**时辰禁忌长视频口播大纲**，用于后续分段并发生成（每段单独请求，最后合并）。
【计量说明】全文总目标与各章 min_chars / max_chars 均为**中文字符**（含标点），**不是**英文单词数。

【硬性要求】
1. 共 **${segmentCount}** 章（强制9章）；全片合并后目标约 **${T} 字**（允许合理偏差），每章 min_chars / max_chars 需合理分摊，单章约 ${perLo}–${perHi}（在 JSON 里逐章给出，max_chars - min_chars ≤ 600）。
2. ${opts.logicBlueprint}
3. **强制9节课内容框架**：每章必须对应以下框架，不得缺节、不得乱序：
${TIME_TABOO_LESSON_CORE_BRIEFS.map((b, i) => `   第${i + 1}章（${['引子', '第一节课', '第二节课', '第三节课', '第四节课', '第五节课', '第六节课', '第七节课', '第八节课'][i]}）：${b.split('：')[1] || b.slice(0, 80)}`).join('\n')}
4. 每章必须包含：
   - title：章标题（禁止使用「第X章」「第一章」等章节编号，只能是自然的短句标题；**禁止**使用引号包裹）
   - min_chars / max_chars：整数
   - core_brief：本章要讲透的论点与素材方向（50–120 字，必须覆盖对应节课的核心内容）
   - opening_echo：**从上一章收束语义自然承接**的开头提示（第1章填空字符串 ""）；约 40–80 字
   - closing_snippet_hint：本章结尾希望出现的收束语义摘要（40–80 字）
   - bridge_to_next：本章末 1–2 句过渡到下一章的自然过渡提示（最后一章写总结升华）

5. **章节编号禁止**：严格禁止输出任何「第1章」「第二章」「第一部分」「Section 1」等带编号的章节标记。

6. 只输出 **一个 JSON 对象**，不要 Markdown、不要注释。键名必须完全一致：
{
  "core_theme": "string",
  "logic_line": "string",
  "chapters": [
${lessonCoreBriefs}
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
