/**
 * 翻译服务（中文治愈心理学专用）
 *
 * 策略：不让 AI 处理宠物名，防止 AI 幻觉出新的宠物名。
 * 步骤：
 * 1. 英文 pet name → 替换为 [DOG_NAME] / [CAT_NAME] 占位符
 * 2. AI 翻译时，"[DOG_NAME]" 作为固定占位符不翻译（但会在中文 prompt 里变成对应中文字符串）
 * 3. 最终后处理：[DOG_NAME] → 糯米（狗）/ [CAT_NAME] → 小满（猫）
 * 4. 删除所有可能残留的中文宠物名
 */

import { streamContentGeneration } from './geminiService';

/** 英文宠物名列表（狗+猫的候选名） */
const ENGLISH_PET_NAMES = [
  'Bean', 'Mochi', 'Junie', 'Muffin', 'Charlie', 'Max', 'Buddy', 'Ollie',
  'Luna', 'Bella', 'Taco', 'Noodle', 'Fudge', 'Biscuit', 'Coco', 'Peanut',
  'Shadow', 'Ginger', 'Milo', 'Oscar', 'Leo', 'Simba', 'Nala', 'Smokey',
  'Tiger', 'Poppy', 'Daisy', 'Harley', 'Duke', 'Bear', 'Tucker', 'Winston',
];

/** 已知中文宠物名（用于后处理安全网） */
const KNOWN_CHINESE_PET_NAMES = [
  '小满', '年糕', '团子', '咪咪', '煤球', '肉包', '橘子', '阿橘',
  '布丁', '果冻', '奶糖', '花花', '小白', '小灰', '小黑', '黑豆',
  '豆豆', '阿黄', '来福', '旺财', '球球', '阿福', '大黄', '笨笨', '毛毛', '乐乐', '欢欢',
  '糯米', '像是', '梁子',
];

/**
 * 翻译前：检测英文原文的主题（猫/狗）
 */
function detectEnglishPetTheme(text: string): 'cat' | 'dog' {
  const catWords = ['cat', 'kitten', 'meow', 'feline', 'whisker', 'purr'];
  const dogWords = ['dog', 'puppy', 'paw', 'canine', 'woof'];
  const lower = text.toLowerCase();
  const catCount = catWords.reduce((n, w) => n + ((lower.match(new RegExp('\\b' + w + '\\b', 'g')) || []).length), 0);
  const dogCount = dogWords.reduce((n, w) => n + ((lower.match(new RegExp('\\b' + w + '\\b', 'g')) || []).length), 0);
  return catCount >= dogCount ? 'cat' : 'dog';
}

/**
 * 翻译前：删除英文 pet name selection instructions
 */
function stripEnglishPetInstructions(text: string): string {
  return text.split('\n').filter(line => {
    const s = line.trim();
    if (s.match(/^[-*]\s*(dog theme|cat theme|狗主题|猫主题)/i)) return false;
    if (s.match(/^my (cat|dog) is/i)) return false;
    if (s.match(/^this name will only appear/i)) return false;
    if (s.match(/I chose the (cat|dog) theme/i)) return false;
    if (s.match(/^I chose:/i)) return false;
    if (s.match(/^Dog theme:/i)) return false;
    if (s.match(/^Cat theme:/i)) return false;
    if (s.match(/my (cat|dog) is named /i)) return false;
    if (s.match(/named /i) && s.length < 60) return false;
    return true;
  }).join('\n');
}

/**
 * 翻译前预处理：
 * 1. 把所有英文 pet name 替换为 [DOG_NAME] / [CAT_NAME] 占位符
 * 2. 用多种模式捕获所有出现形式
 */
function replaceEnglishPetNamesWithPlaceholders(text: string, theme: 'cat' | 'dog'): string {
  const placeholder = theme === 'cat' ? '[CAT_NAME]' : '[DOG_NAME]';
  let result = text;

  for (const name of ENGLISH_PET_NAMES) {
    // 1. 精确词边界（Bean → [DOG_NAME]）
    const exact = new RegExp('\\b' + name + '\\b', 'gi');
    result = result.replace(exact, placeholder);

    // 2. 所有格（Bean's → [DOG_NAME]的）
    const possessive = new RegExp(name + "'s\\b", 'gi');
    result = result.replace(possessive, placeholder + '的');

    // 3. "my dog, Bean" / "my cat, Bean"
    const animalWord = theme === 'cat' ? 'cat' : 'dog';
    const withComma = new RegExp('(my ' + animalWord + '),\\s*' + name + '\\b', 'gi');
    result = result.replace(withComma, placeholder);

    // 4. "named Bean" / "the dog Bean"
    const named = new RegExp('(named|the ' + animalWord + ')\\s+' + name + '\\b', 'gi');
    result = result.replace(named, placeholder);
  }

  return result;
}

/**
 * 翻译后处理（最终安全网）
 * 把 [DOG_NAME] → 糯米、[CAT_NAME] → 小满
 * 并彻底清理所有已知中文宠物名
 *
 * 注意：pet content 检测用于区分"治愈心理学宠物故事"和"其他内容（如大国博弈）"。
 * 只有当文本看起来是宠物故事时，才进行宠物名标准化。
 */
function isLikelyPetContent(text: string): boolean {
  const lower = text.toLowerCase();
  const petIndicators = [
    'pet', 'cat', 'cats', 'dog', 'dogs', 'kitten', 'kittens',
    'puppy', 'puppies', 'purr', 'purring', 'meow', 'woof',
    '呼噜', '打呼噜', '跳上床', '趴在', '爪子', '毛茸茸',
    '我的猫', '我的狗', '它就', '它把', '它又',
  ];
  const politicalIndicators = [
    '白宫', '国会', '伊朗', '制裁', '核谈', '以色列',
    '特朗普', '总统', '谈判', '外交', '盟友', '选举',
    '方案', '否决', '博弈', '筹码', '地区', '安全',
    '美国', '国务院', '鹰派', '强硬', '压力',
  ];

  const petScore = petIndicators.filter(w => lower.includes(w.toLowerCase()) || text.includes(w)).length;
  const politicalScore = politicalIndicators.filter(w => text.includes(w)).length;

  // 宠物指标多且政治指标少 → 宠物内容
  if (petScore >= 2 && politicalScore === 0) return true;
  // 政治指标明显更多 → 非宠物内容
  if (politicalScore >= 3) return false;
  // 宠物指标弱、政治指标中等 → 非宠物内容
  if (politicalScore >= 2 && petScore <= 1) return false;
  // 单纯依赖宠物指标
  return petScore >= 2;
}

function postProcessChinese(text: string, theme: 'cat' | 'dog'): string {
  const fixedCN = theme === 'cat' ? '小满' : '糯米';
  const isPetContent = isLikelyPetContent(text);

  let result = text;

  // 只有宠物内容才进行占位符替换和安全网清理
  if (isPetContent) {
    // 步骤1：占位符替换
    if (theme === 'cat') {
      result = result.split('[CAT_NAME]').join('小满');
      result = result.split('[DOG_NAME]').join('小满');
    } else {
      result = result.split('[DOG_NAME]').join('糯米');
      result = result.split('[CAT_NAME]').join('糯米');
    }

    // 步骤1b：无条件替换"煤球"（边界检查会漏掉"煤球就"、"煤球在"等情况）
    result = result.split('煤球').join(fixedCN);

    // 步骤2：清理所有已知中文宠物名（无条件替换，不依赖边界检查）
    for (const name of KNOWN_CHINESE_PET_NAMES) {
      if (name === fixedCN) continue;
      result = result.split(name).join(fixedCN);
    }

    // 步骤2b：最终全面清理——把所有非目标宠物名统一替换为固定名
    // 狗主题：把所有中文宠物名（含猫名）替换为糯米
    // 猫主题：把所有中文宠物名（含狗名）替换为小满
    const allPetNames = [
      '小满', '年糕', '团子', '咪咪', '煤球', '肉包', '橘子', '阿橘',
      '布丁', '果冻', '奶糖', '花花', '小白', '小灰', '小黑', '黑豆',
      '豆豆', '阿黄', '来福', '旺财', '球球', '阿福', '大黄', '笨笨', '毛毛', '乐乐', '欢欢',
      '糯米', '像是', '梁子',
    ];
    for (const name of allPetNames) {
      if (name === fixedCN) continue;
      result = result.split(name).join(fixedCN);
    }

    // 步骤3：处理"像是"开头的宠物名（无条件，不依赖边界检查）
    result = result.split('像是').join(fixedCN);
  }

  // 步骤4：清理残留英文宠物类别词
  const petWordReplacements: [RegExp, string][] = [
    [/\bcat\b/gi, theme === 'cat' ? '猫' : '狗'],
    [/\bcats\b/gi, theme === 'cat' ? '猫' : '狗'],
    [/\bkitten\b/gi, '小猫'],
    [/\bkittens\b/gi, '小猫'],
    [/\bfeline\b/gi, theme === 'cat' ? '猫' : '狗'],
    [/\bmeow\b/gi, '喵'],
    [/\bmeows\b/gi, '喵'],
    [/\bmeowing\b/gi, '喵喵叫'],
    [/\bpurr\b/gi, '呼噜'],
    [/\bpurrs\b/gi, '呼噜'],
    [/\bpurring\b/gi, '打呼噜'],
    [/\bwhisker\b/gi, '胡须'],
    [/\bwhiskers\b/gi, '胡须'],
    [/\bdog\b/gi, theme === 'cat' ? '猫' : '狗'],
    [/\bdogs\b/gi, theme === 'cat' ? '猫' : '狗'],
    [/\bpuppy\b/gi, '小狗'],
    [/\bpuppies\b/gi, '小狗'],
    [/\bcanine\b/gi, theme === 'cat' ? '猫' : '狗'],
    [/\bwoof\b/gi, '汪'],
    [/\bwoofs\b/gi, '汪'],
    [/\bwoofing\b/gi, '汪汪叫'],
    [/\bpaw\b/gi, '爪子'],
    [/\bpaws\b/gi, '爪子'],
    [/\bpet\b/gi, '宠物'],
    [/\bpets\b/gi, '宠物'],
    [/\banimal\b/gi, '动物'],
    [/\banimals\b/gi, '动物'],
  ];

  for (const [pattern, replacement] of petWordReplacements) {
    result = result.replace(pattern, replacement);
  }

  // 步骤5：清理残留英文短语
  const phraseReplacements: [RegExp, string][] = [
    [/\bmy cat\b/gi, theme === 'cat' ? '我的猫' : '我的狗'],
    [/\bmy dog\b/gi, theme === 'cat' ? '我的猫' : '我的狗'],
    [/\bthe cat\b/gi, theme === 'cat' ? '那只猫' : '那只狗'],
    [/\bthe dog\b/gi, theme === 'cat' ? '那只猫' : '那只狗'],
    [/\bpurring now\b/gi, '正在打呼噜'],
    [/\bis purring\b/gi, '在打呼噜'],
    [/\bwas purring\b/gi, '在打呼噜'],
    [/\bis asleep\b/gi, '睡着了'],
    [/\bwas asleep\b/gi, '睡着了'],
    [/\bfell asleep\b/gi, '睡着了'],
    [/\btime to sleep\b/gi, '该睡觉了'],
    [/\bGood night\b/gi, '晚安'],
    [/\bgood night\b/gi, '晚安'],
    [/\bGoodnight\b/gi, '晚安'],
    [/\bI guess\b/gi, '我猜'],
    [/\banyway\b/gi, '算了'],
    [/\bmy puppy\b/gi, '小狗'],
    [/\bmy kitten\b/gi, '小猫'],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    result = result.replace(pattern, replacement);
  }

  // 步骤6：删除纯英文行
  result = result.split('\n').map(line => {
    const trimmed = line.trim();
    if (!/[\u4e00-\u9fff]/.test(trimmed) && /[a-zA-Z]{3,}/.test(trimmed)) {
      return '';
    }
    return trimmed.replace(/\b[a-zA-Z]{3,}\b/g, '').trim();
  }).join('\n');

  // 步骤7：删除 pet name selection 说明行
  result = result.split('\n').filter(line => {
    const s = line.trim();
    if (s.includes('我选的是') || s.includes('这个名字在全文中只会出现')) return false;
    if (s.match(/^□\s*(狗主题|猫主题)/)) return false;
    if (s.match(/^狗主题：/) || s.match(/^猫主题：/)) return false;
    if (s.match(/^Dog theme:/) || s.match(/^Cat theme:/)) return false;
    if (s.match(/^I chose the (cat|dog) theme/i)) return false;
    return true;
  }).join('\n');

  return result;
}

/**
 * 将英文文本翻译为温暖口语化的目标语言
 */
export async function translateToDisplayLanguage(
  text: string,
  targetLang: string,
  onLog?: (msg: string) => void,
  onChunk?: (t: string) => void
): Promise<string> {
  const langLabels: Record<string, string> = {
    zh: '简体中文',
    ko: '韩文',
    ja: '日文',
    es: '西班牙文',
    de: '德文',
    hi: '印地文',
    ru: '俄文',
    pt: '葡萄牙文',
    fr: '法文',
    id: '印尼文',
    th: '泰文',
  };

  const label = langLabels[targetLang] || targetLang;

  // 中文翻译（中文治愈心理学专用策略）
  if (targetLang === 'zh') {
    onLog?.(`[翻译] 正在翻译为简体中文...`);

    // 步骤0：删除英文 pet name selection instructions
    const stripped = stripEnglishPetInstructions(text);

    // 步骤1：检测主题
    const theme = detectEnglishPetTheme(stripped);
    const fixedCN = theme === 'cat' ? '小满' : '糯米';
    onLog?.(`[翻译] 主题: ${theme}，宠物名固定为"${fixedCN}"`);

    // 步骤2：英文 pet name → 占位符 [DOG_NAME] / [CAT_NAME]
    const placeholdered = replaceEnglishPetNamesWithPlaceholders(stripped, theme);
    onLog?.(`[翻译] 英文 pet name 已替换为占位符`);

    // 步骤3：翻译
    // 关键：prompt 里写清楚"[DOG_NAME]"是占位符，翻译时保持原样
    const systemInstruction =
      `You are a professional translator. Translate ALL English text to 简体中文. IMPORTANT: The placeholder "[DOG_NAME]" (for dog theme) or "[CAT_NAME]" (for cat theme) must NOT be translated — it is a placeholder that will be replaced later. Keep it exactly as is. All other English text (endings, filler words, transitions) must be translated to 简体中文. Keep paragraph breaks. Output only the translation.`;

    const userPrompt = `Translate to 简体中文. Translate ALL English text (endings, filler words, transitions, everything) to 简体中文.

CRITICAL: Do NOT translate these placeholders. Keep them exactly as written in the text:
- "[DOG_NAME]" (for dog theme)
- "[CAT_NAME]" (for cat theme)

Everything else must be translated to 简体中文. Keep paragraph breaks. Output only the translation.

Text:
${placeholdered}`;

    let result = '';
    try {
      await streamContentGeneration(userPrompt, systemInstruction, (chunk) => {
        result += chunk;
        onChunk?.(result);
      });

      // 步骤4：最终后处理（占位符替换 + 安全网清理）
      const postProcessed = postProcessChinese((result || '').trim(), theme);
      onLog?.(`[翻译] 完成，约${postProcessed.replace(/\s+/g, '').length}字`);
      return postProcessed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onLog?.(`[翻译] 失败: ${msg}`);
      return text;
    }
  }

  // 其他语言翻译
  const systemInstruction = `You are a translation editor. Translate English to ${label}.`;
  const userPrompt = `Translate the following English text to ${label}. Keep the warm, conversational tone. Output only the translation.

Text:
${text}`;

  onLog?.(`[翻译] 正在翻译为${label}...`);

  let result = '';
  try {
    await streamContentGeneration(userPrompt, systemInstruction, (chunk) => {
      result += chunk;
      onChunk?.(result);
    });
    onLog?.(`[翻译] 完成，约${result.replace(/\s+/g, '').length}字`);
    return (result || '').trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog?.(`[翻译] 失败: ${msg}`);
    return text;
  }
}
