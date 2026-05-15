#!/usr/bin/env python3
"""Apply TCM 9-lesson framework fixes to Generator.tsx"""

import re

with open('/Users/kenyou/Desktop/Ai/contentmaster-ai/components/Generator.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

original_len = len(content)

# ====== FIX 1: Manual TCM outline prompt (around line 3394) ======
# Replace the outline prompt to include TCM 9-lesson framework details

old_outline_block = '''    const chapterTitlesBlock = isTimeTaboo
      ? `\\n【强制章节标题（共9章，禁止自行命名）】\\n以下标题为固定章节目录，你的 JSON 中 chapters[0]~chapters[8] 的 title 必须与下列标题一一对应，不得修改、不得省略、不得打乱顺序：\\n${fixedChapterTitles!.map((t, i) => `  ${i === 0 ? '（引子）' : `第${i}章`}：${t}`).join('\\n')}`
      : '';
    const outlinePrompt = `【选题】${topicTitle}${chapterTitlesBlock}

【任务】为以上选题生成倪海厦中医玄学风格口播大纲，共 **${actualSegN}** 章，全片合并后目标约 ${parallelTotalTargetChars} 字。

倪海厦风格内容结构参考（任选其一或自由组合）：
1. 引子破局 → 干支能量解读 → 禁忌色详解 → 生肖分组 → 急救实操 → 功德收尾
2. 直击痛点 → 中医规律导入 → 正反案例 → 落地实操 → 霸气收尾

【硬性要求】
1. 共 **${actualSegN}** 章；每章 **min_chars / max_chars** 须合理分摊，单章约 ${Math.round(parallelTotalTargetChars / actualSegN * 0.9)}–${Math.round(parallelTotalTargetChars / actualSegN * 1.1)} 字
2. 每章包含：title（时辰禁忌必须使用上述固定标题；其他模式用自然短句标题，禁止"第X章"）、min_chars、max_chars、core_brief、opening_echo、closing_snippet_hint、bridge_to_next
3. **chapters 数组长度必须恰好为 ${actualSegN}，不得多一个也不得少一个**
4. 只输出一个 JSON 对象，键名：core_theme, logic_line, chapters`;'''

new_outline_block = '''    const outlinePrompt = isTimeTaboo
      ? `【选题】${topicTitle}
【任务】为以上选题生成倪海厦中医玄学时辰禁忌风格口播大纲，共 9 章（1个引子 + 8节课），全片合并后目标约 ${parallelTotalTargetChars} 字。

【强制章节标题（共9章，禁止自行命名）】
以下标题为固定章节目录，你的 JSON 中 chapters[0]~chapters[8] 的 title 必须与下列标题一一对应，不得修改、不得省略、不得打乱顺序：
${fixedChapterTitles!.map((t, i) => `  ${i === 0 ? '（引子）' : `第${i}章`}：${t}`).join('\\n')}

【强制 core_brief 要求（各章内容方向，必须严格遵守）】
- chapters[0]（引子）：描述当天干支能量特征，制造紧迫感；直接警告当天最大风险点（颜色穿错=破财伤身）；先公布本集结论（大吉推荐色/全体禁忌色）
- chapters[1]（第一节课）：点出特定节气/日子的危险性，痛骂观众的致命错误，制造生存危机；语气延续引子
- chapters[2]（第二节课）：展开干支分析，天干地支各自含义，为什么这一天能量特殊
- chapters[3]（第三节课）：全体禁忌色——直接告诉观众当天所有人都不能穿的某几种颜色，讲清楚为什么穿=破财/伤身
- chapters[4]（第四节课）：大凶警戒组，3个生肖+严禁什么颜色+穿了的后果
- chapters[5]（第五节课）：平稳过渡组，3个生肖+为什么穿这个颜色+穿对后效果
- chapters[6]（第六节课）：小幸运儿组（当天合相加持生肖）+ 逆天改命组（3个生肖+吸金行动+吸金颜色）
- chapters[7]（第七节课）：民俗大忌，祭祀/出行致命错误，辅以真实案例
- chapters[8]（第八节课）：千金难买接气法，3个极低成本实操动作，每个讲清楚做法+为什么有效+什么时间做

【硬性要求】
1. chapters 数组长度必须恰好为 9，不得多一个也不得少一个
2. 每章 min_chars / max_chars 须合理分摊，单章约 ${Math.round(parallelTotalTargetChars / 9 * 0.9)}–${Math.round(parallelTotalTargetChars / 9 * 1.1)} 字
3. 每章包含：title（必须使用上述固定标题）、min_chars、max_chars、core_brief（必须严格对应上述各章内容要求）、opening_echo（引子章填空 ""；第2-9章从上一章收束语义自然承接）、closing_snippet_hint（本章结尾收束摘要）、bridge_to_next（过渡到下一章；第9章写总结升华）
4. 只输出一个 JSON 对象，键名：core_theme, logic_line, chapters`
      : `【选题】${topicTitle}

【任务】为以上选题生成倪海厦中医玄学风格口播大纲，共 **${actualSegN}** 章，全片合并后目标约 ${parallelTotalTargetChars} 字。

倪海厦风格内容结构参考（任选其一或自由组合）：
1. 引子破局 → 干支能量解读 → 禁忌色详解 → 生肖分组 → 急救实操 → 功德收尾
2. 直击痛点 → 中医规律导入 → 正反案例 → 落地实操 → 霸气收尾

【硬性要求】
1. 共 **${actualSegN}** 章；每章 **min_chars / max_chars** 须合理分摊，单章约 ${Math.round(parallelTotalTargetChars / actualSegN * 0.9)}–${Math.round(parallelTotalTargetChars / actualSegN * 1.1)} 字
2. 每章包含：title（用自然短句标题，禁止"第X章"）、min_chars、max_chars、core_brief、opening_echo、closing_snippet_hint、bridge_to_next
3. **chapters 数组长度必须恰好为 ${actualSegN}，不得多一个也不得少一个**
4. 只输出一个 JSON 对象，键名：core_theme, logic_line, chapters`;'''

if old_outline_block in content:
    content = content.replace(old_outline_block, new_outline_block, 1)
    print("FIX 1 (manual TCM outline prompt): APPLIED")
else:
    print("FIX 1: Pattern not found")

# ====== FIX 2: Manual TCM segment generation (add lesson instructions) ======
old_segment = '''          try {
            const user = buildParallelSegmentUserPrompt(
              {
                topic: topicTitle,
                coreTheme: '中医玄学·倪海厦风格·直击痛点·故事对冲·落地实操',
                logicLine: ch.core_brief,
                chapter: ch as unknown as YiJingChapterPlan,
                chapterIndex: idx,
                totalChapters: n,
              },
              bundle.segment
            );'''

new_segment = '''          try {
            const lessonInstruction = isTimeTaboo
              ? (idx === 0
                ? '【本节任务：引子】描述当天干支能量特征，制造紧迫感；直接警告当天最大风险点（颜色穿错=破财伤身）；先公布本集结论（大吉推荐色/全体禁忌色）；语气要狠，像在骂醒观众'
                : idx === 1
                ? '【第一节课：紧急通报与警示】点出特定节气/日子的危险性，痛骂观众的致命错误，制造生存危机；语气延续引子的紧迫感，一气呵成；可用真实临床案例辅证（台湾/美国地点，铁齿后果）'
                : idx === 2
                ? '【第二节课：干支能量深度解读】展开干支分析，天干地支各自含义，用大白话讲透，不要堆术语，讲清楚为什么这一天能量特殊，自然过渡到禁忌色话题'
                : idx === 3
                ? '【第三节课：全体禁忌色】全体禁忌色——直接告诉观众当天所有人都不能穿的某几种颜色，讲清楚为什么穿=火上浇油/破财/伤身，口语化描述后果'
                : idx === 4
                ? '【第四节课：大凶警戒组】讲清哪几个生肖+严禁什么颜色+穿了的后果'
                : idx === 5
                ? '【第五节课：平稳过渡组】讲清哪些生肖+为什么穿这个颜色+穿对后效果'
                : idx === 6
                ? '【第六节课：小幸运儿与逆天改命】小幸运儿组（当天合相加持生肖）+逆天改命组（3个生肖+吸金行动+吸金颜色）'
                : idx === 7
                ? '【第七节课：民俗大忌】祭祀/出行致命错误，打死不能丢或不能做的事，辅以真实案例，用大白话讲清楚禁忌的原因和后果'
                : '【第八节课：千金难买接气法】3个极低成本实操动作，每个讲清楚具体做法（要可执行）+为什么有效（用大白话解释）+什么时间做效果最好')
              : '';
            const enhancedLogicLine = isTimeTaboo
              ? `${lessonInstruction}\n\n本章核心论点：${ch.core_brief}`
              : ch.core_brief;

            const user = buildParallelSegmentUserPrompt(
              {
                topic: topicTitle,
                coreTheme: '中医玄学·倪海厦风格·时辰禁忌·颜色穿搭配色',
                logicLine: enhancedLogicLine,
                chapter: ch as unknown as YiJingChapterPlan,
                chapterIndex: idx,
                totalChapters: n,
              },
              bundle.segment
            );'''

if old_segment in content:
    content = content.replace(old_segment, new_segment, 1)
    print("FIX 2 (manual TCM segment generation): APPLIED")
else:
    print("FIX 2: Pattern not found")

# ====== FIX 3: 全自动 TCM plannedSeg to force 9 ======
old_plannedseg = '''    const plannedSeg =
      niche === NicheType.GREAT_POWER_GAME && greatPowerLanguage === 'zh'
        ? 10
        : computeParallelSegmentCount(
            parallelTotalTargetChars,
            scriptLengthMode === 'SHORT' ? 'SHORT' : 'LONG'
          );'''

new_plannedseg = '''    const plannedSeg =
      niche === NicheType.GREAT_POWER_GAME && greatPowerLanguage === 'zh'
        ? 10
        : niche === NicheType.TCM_METAPHYSICS && scriptLengthMode !== 'SHORT'
        ? 9
        : computeParallelSegmentCount(
            parallelTotalTargetChars,
            scriptLengthMode === 'SHORT' ? 'SHORT' : 'LONG'
          );'''

if old_plannedseg in content:
    content = content.replace(old_plannedseg, new_plannedseg, 1)
    print("FIX 3 (全自动 TCM plannedSeg = 9): APPLIED")
else:
    print("FIX 3: Pattern not found")

with open('/Users/kenyou/Desktop/Ai/contentmaster-ai/components/Generator.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\nOriginal: {original_len} chars, New: {len(content)} chars")
print("All fixes applied!")
