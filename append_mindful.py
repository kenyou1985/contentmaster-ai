#!/usr/bin/env python3
import sys

# The mindful psychology code to append (as a raw string - no backticks that would confuse Python)
MINDFUL_CODE = r'''// ==========================================
// 3. MINDUL PSYCHOLOGY (AI-Undetectable Healing Psychology)
// ==========================================

/**
 * 治愈心理学赛道专用逻辑线（AI去味版）
 * 参照对标账号文案风格：反常识Hook → 颠覆常见解释 → 科学研究支撑 → 叙事递进 → 情感落点
 */
export const PARALLEL_LOGIC_MINDUL_PSYCHOLOGY =
  "逻辑线：反常识Hook（凌晨2点的细节切入）→ 颠覆常见解释 → 科学研究（大学+年份+具体数字） → 神经化学机制（催产素循环） → 进化故事（考古证据） → 意外发现（颠覆认知的研究） → 神经系统同步 → 情感落点与自然CTA";

export type MindfulPsychologyOutlinePromptOpts = {
  channelLabel: string;
  contentKind: string;
  englishCharOutline?: boolean;
};

export function buildMindfulPsychologyOutlineUserPrompt(
  topic: string,
  segmentCount: number,
  totalTargetChars: number,
  opts: MindfulPsychologyOutlinePromptOpts,
  leadContext?: string
): string {
  const T = Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)));
  const perBase = Math.floor(T / segmentCount);
  const perLo = Math.max(200, perBase - Math.min(200, Math.round(perBase * 0.15)));
  const perHi = perBase + Math.min(200, Math.round(perBase * 0.15));

  const head = leadContext?.trim()
    ? `${leadContext.trim()}\n\n---\n\n`
    : '';

  const unitNote = opts.englishCharOutline
    ? '\n【计量说明】全文总目标与各章 min_chars / max_chars 均为 **英文口播字符**（字母、空格、标点），**不是**中文字数。\n'
    : '';

  return `${head}【选题】${topic}

【任务】为以上选题生成治愈心理学频道的**章节大纲**（${opts.contentKind}），用于后续分段并发生成。

## 核心风格要求（必须严格遵循）
${unitNote}
**本赛道的核心目标：生成 AI 检测为 0% 的自然脚本。**

1. **反常识Hook**：每章开头必须从小细节切入（凌晨2点的场景、反常识观察），逐步颠覆认知。不要写"本期视频""欢迎回来"等套话。
2. **科学研究锚点**：每章必须至少包含一个具体的研究引用，包括：大学/机构名称 + 年份 + 样本量 + 具体数字。不要写"研究表明""科学家发现"等泛泛表述。
3. **叙事驱动**：禁止使用编号列表、"3个原因""5个方法"等结构。用故事线串联知识点，每段之间自然递进。
4. **亲密第二人称**：频繁使用"your""you"，避免"people""humans"等泛泛第三人称。
5. **自然过渡**：使用"But here's where it gets intense..."、"And this is where it gets deep..."、"There's one last thing I need to tell you..."等递进过渡语。

## 大纲结构要求

【硬性要求】
1. 共 **${segmentCount}** 章；全片合并后目标约 **${T}** 英文字符（允许合理偏差），每章 min_chars / max_chars 需合理分摊，单章约 ${perLo}–${perHi}。
2. ${opts.channelLabel}
3. 每章必须包含：
   - title：章标题（4–12 字，英文或中文均可）
   - min_chars / max_chars：整数
   - core_brief：本章要讲透的论点与素材方向（50–120 字）
   - opening_echo：**从上一章收束语义自然承接**的开头提示（第1章填空字符串 ""）；约 40–80 字
   - closing_snippet_hint：本章结尾希望出现的收束语义摘要（40–80 字），供下一章 opening_echo 使用
   - bridge_to_next：本章末 1–2 句过渡到下一章的提示（最后一章写情感落点与自然CTA）

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

chapters 数组长度必须恰好为 ${segmentCount}。

## 各章参考方向（可根据选题调整，但保持递进结构）
- 第1章：反常识Hook（凌晨2点的具体场景 + 反直觉主张）
- 第2章：颠覆常见解释（为什么不是你想的那样）
- 第3章：依附科学研究（大学实验 + 具体数据）
- 第4章：神经化学机制（催产素循环的具体过程）
- 第5章：进化故事（15,000年驯化史 + 考古证据）
- 第6章：意外发现（颠覆认知的研究 + 矛盾结果）
- 第7章：神经系统同步（两个生物体的同步现象）
- 第8章：情感落点（温柔提醒 + 自然CTA）
`;
}

export function buildMindfulPsychologyOutlineSystem(directorLine: string): string {
  return directorLine + ' Only output valid JSON, nothing else.';
}

export function buildMindfulPsychologySegmentUserPrompt(
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
    mindfulLanguage?: string;
  }
): string {
  const { topic, coreTheme, logicLine, chapter, chapterIndex, totalChapters } = params;
  const isFirst = chapterIndex === 0;
  const isLast = chapterIndex === totalChapters - 1;

  return `【总选题】${topic}
【全文主题】${coreTheme}
【逻辑主线】${logicLine}

【当前章节】${chapterIndex + 1} / ${totalChapters} — ${chapter.title}

【本章核心】${chapter.core_brief}

## AI去味写作铁律（必须严格遵循）

### 1. 开场Hook（仅第1章）
第1章必须在第一句就切入一个具体的反常识场景。禁止使用：
- "In this video..." / "Today we're going to..."
- "Welcome back" / "Hey everyone"
- 任何模板化的开场白

正确示例：
"It's 2 in the morning. Your dog has a perfectly good bed somewhere in the house, and yet here they are, circling your mattress..."

### 2. 科学研究锚点
如果本章涉及科学研究，必须包含：
- 具体大学/机构名称（真实名称）
- 研究年份（如果已知）
- 样本量（如"30 pairs"）
- 具体发现（包含数字）

错误："Studies show dogs love their owners."
正确："In 2015, a team at Azabu University in Japan published a study in Science. They measured oxytocin levels in 30 dog-owner pairs..."

### 3. 叙事驱动
- 禁止使用编号列表、"3个原因""5个方法"
- 每个论点必须用叙事方式展开：背景→机制→例子
- 使用"But here's where it gets intense..."等过渡语推进到下一个论点

### 4. 亲密第二人称
- 频繁使用"your""you"，避免"people generally"
- 直接称呼观众：Your brain, your nervous system, your dog

### 5. 字数要求
本章英文正文字符数（含空格标点）尽量控制在 ${chapter.min_chars}–${chapter.max_chars} 之间。
内容完整性优先，字数可略有偏差。

### 6. 衔接规则
${isFirst
    ? "开篇直接从反常识切入。不要复述\"上一章\"。"
    : `开篇必须用 1–3 句自然承接下面语义（可改写，勿整段照抄）：\n"${chapter.opening_echo}"`}
${isLast
    ? '结尾必须情感落点。禁止"please like and subscribe"。用自然的一句话引导互动，例如："I would love to know where your dog sleeps tonight."'
    : `结尾必须自然收束，并融入过渡意图（供剪辑连贯）：\n"${chapter.bridge_to_next}"`}

## 写作要求
${opts.voiceRules}
- 全文必须使用**英文**输出
- 禁止加粗、禁止Markdown、禁止列表骨架
- 只输出正文，不输出任何元信息
- 禁止输出 <break> 标签或任何舞台提示`;
}

export type MindfulPsychologyMergePromptOpts = {
  toneInstruction: string;
  mindfulLanguage?: string;
  englishMergedCharClamp?: { min: number; max: number };
};

export function buildMindfulPsychologyMergeUserPrompt(
  topic: string,
  combinedDraft: string,
  totalTargetChars: number | undefined,
  opts: MindfulPsychologyMergePromptOpts
): string {
  const T = totalTargetChars
    ? Math.min(PARALLEL_TOTAL_MAX, Math.max(PARALLEL_TOTAL_MIN, Math.round(totalTargetChars)))
    : 12000;

  const clamp = opts.englishMergedCharClamp;
  const lengthRule = clamp
    ? `7. 全文字符数尽量接近 ${clamp.min}–${clamp.max} 范围；内容完整性优先，字数可略有偏差。`
    : `7. 保留原文完整内容，不得因字数要求而截断任何段落。`;

  return `【任务】以下是由「${topic}」分段生成的初稿拼接而成。请执行「合并初稿 + 统一全文语气」。

## 核心原则：内容完整性优先
- **必须保留所有分段的完整内容**，禁止删除、截断任何段落
- **禁止对正文内容进行改写、重写、润色**
- **只允许微调段落开头1-2句**，使其与上一段自然衔接
- **最后一段（情感落点与CTA）的全部内容必须原样保留**

## AI去味合并检查清单

在合并过程中，请检查并修复以下问题：

1. **开场检查**：全文第一句必须是具体的反常识场景切入。禁止以"In this video""Welcome back"开头。
2. **过渡语检查**：确保每章之间的过渡自然流畅，有"But here's where it gets intense..."、"And this is where it gets deep..."等递进过渡。
3. **研究引用检查**：确保每个研究引用都包含大学名称、年份、具体数字。
4. **CTA检查**：最后一段只能有一个自然的订阅引导，禁止"please like and subscribe"。例如："If this changed how you see your dog tonight, drop a comment below."

## 具体操作要求

1. **保留分段内容**：
   - 各段：只微调开头1-2句与上一段衔接，主体内容原样保留
   - 最后一段：100% 原样保留，禁止任何修改

2. **语气统一**：
   ${opts.toneInstruction}

3. **语言强制**：全文必须使用**英文**。将所有片段翻译为英文语义对等表达。

4. **禁止行为**：
   - 禁止删除任何内容
   - 禁止截断任何段落
   - 禁止合并或拆分句子
   - 禁止替换词语
   - 禁止修改末尾 CTA

5. ${lengthRule}

【初稿完整内容】
${combinedDraft}

请直接输出**完整终稿**，必须包含所有分段的完整内容，不得截断。`;
}

export function buildMindfulPsychologyMergeSystem(editorLine: string): string {
  return editorLine + ' Only output the merged script text, nothing else.';
}
'''

with open('services/yiJingParallelLongForm.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Remove trailing newlines
content = content.rstrip('\n')

# Check the last few chars
print(f'Original file ends with: {repr(content[-50:])}')
print(f'Original length: {len(content)}')

# Append the new code
new_content = content + '\n' + MINDFUL_CODE + '\n'

print(f'New length: {len(new_content)}')

with open('services/yiJingParallelLongForm.ts', 'w', encoding='utf-8') as f:
    f.write(new_content)

print('Done!')
