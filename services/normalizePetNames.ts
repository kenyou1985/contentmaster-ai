/**
 * 治愈心理学脚本：宠物名一致性后处理
 *
 * AI 在生成分段内容时，容易在不同段落中使用不同的宠物名字
 *（如前半段"豆豆"，中段"阿福"，结尾"阿黄"）。
 * 此函数在合并后扫描全文，找出所有出现的宠物名，
 * 保留出现次数最多的那个，将其他名字统一替换为它。
 *
 * 核心策略：
 * 1. 用已知候选名单词扫描（逐字精确匹配，带边界检查）
 * 2. 用行为短语后向匹配（"名字趴在我脚边"→提取"名字"）
 * 3. 用"叫/是/名叫"结构正向匹配
 * 4. 选最频繁的名字为规范名，其余全部替换
 */

interface NameStats {
  name: string;
  count: number;
  lastPos: number;
}

/** 已知非宠物名的常用词（排除误匹配） */
const NON_PET_PATTERNS = new Set([
  '什么', '这个', '那个', '自己', '我们', '他们', '这么', '那么',
  '时候', '地方', '感觉', '知道', '觉得', '就是', '不是', '还是',
  '真的', '应该', '可以', '没有', '一样', '一定',
  '可能', '所以', '因为', '但是', '而且', '或者', '如果',
]);

/** 常见宠物候选名（用于检测和强制替换） */
export const CANDIDATE_NAMES = [
  '小满', '年糕', '团子', '咪咪', '煤球', '肉包', '橘子', '阿橘',
  '布丁', '果冻', '奶糖', '花花', '小白', '小灰', '小黑', '黑豆',
  '豆豆', '阿黄', '来福', '旺财', '球球', '阿福', '大黄', '笨笨', '毛毛', '乐乐', '欢欢',
  // 以下用于被行为短语捕获时的保护
  '小满在', '年糕在', '团子在', '咪咪在', '豆豆在', '阿黄在', '阿福在',
];

/**
 * 判断一个 2-4 字片段是否是有效的宠物名
 * （不是常见词，前后边界检查）
 */
function isLikelyPetName(name: string): boolean {
  if (name.length < 2 || name.length > 4) return false;
  if (NON_PET_PATTERNS.has(name)) return false;
  // 前两字是否在非宠物名列表
  if (NON_PET_PATTERNS.has(name.slice(0, 2))) return false;
  return true;
}

/**
 * 在全文中扫描所有疑似宠物名
 */
function findChinesePetNames(text: string): NameStats[] {
  const counter = new Map<string, { count: number; lastPos: number }>();
  let absPos = 0; // 在原文中的绝对字符位置

  for (const line of text.split('\n')) {
    const lineLen = line.length;

    // 方式1：逐字扫描已知候选名
    for (let pos = 0; pos < lineLen; pos++) {
      for (const name of CANDIDATE_NAMES) {
        const endPos = pos + name.length;
        if (endPos > lineLen) continue;
        if (line.slice(pos, endPos) !== name) continue;

        const charBefore = pos > 0 ? line[pos - 1] : ' ';
        const charAfter = endPos < lineLen ? line[endPos] : ' ';
        const beforeIsCN = /[\u4e00-\u9fff]/.test(charBefore);
        const afterIsCN = /[\u4e00-\u9fff]/.test(charAfter);

        // 前后都不是汉字 → 独立词
        if (!beforeIsCN && !afterIsCN) {
          const existing = counter.get(name);
          if (existing) {
            existing.count++;
            existing.lastPos = absPos + pos;
          } else {
            counter.set(name, { count: 1, lastPos: absPos + pos });
          }
        }
      }
    }

    // 方式2：行为短语后向匹配（"名字在/把/趴"前面的词就是名字）
    // 例如："豆豆已经站在床边了" → 匹配到"在" → 前面的"豆豆"是名字
    // 例如："阿黄把下巴搁在我腿上" → 匹配到"把下巴" → 前面的"阿黄"是名字
    const behaviorPatterns = [
      // 行为词及其前面的名字宽度
      { pattern: /(?:已经)?([\u4e00-\u9fff]{2,4})(?:已经)?在/g, behavior: '在' },
      { pattern: /(?:已经)?([\u4e00-\u9fff]{2,4})(?:已经)?在/g, behavior: '已经' },
      { pattern: /([\u4e00-\u9fff]{2,4})趴在/g, behavior: '趴在' },
      { pattern: /([\u4e00-\u9fff]{2,4})把下巴/g, behavior: '把下巴' },
      { pattern: /([\u4e00-\u9fff]{2,4})把头/g, behavior: '把头' },
      { pattern: /([\u4e00-\u9fff]{2,4})睡着了/g, behavior: '睡着了' },
      { pattern: /([\u4e00-\u9fff]{2,4})在打呼噜/g, behavior: '在打呼噜' },
      { pattern: /([\u4e00-\u9fff]{2,4})在发呆/g, behavior: '在发呆' },
      { pattern: /([\u4e00-\u9fff]{2,4})这会儿/g, behavior: '这会儿' },
      { pattern: /([\u4e00-\u9fff]{2,4})(?:它|它就)/g, behavior: '它' },
      { pattern: /(?:叫|是|名叫)([\u4e00-\u9fff]{2,4})(?:的|狗|那只)?/g, behavior: '叫' },
    ];

    for (const { pattern, behavior } of behaviorPatterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line)) !== null) {
        const name = m[1];
        if (!isLikelyPetName(name)) continue;

        // 确认行为词在匹配位置之后
        const behaviorStart = m.index + m[0].indexOf(behavior);
        const behaviorText = line.slice(behaviorStart, behaviorStart + behavior.length);
        if (behaviorText !== behavior) continue;

        const existing = counter.get(name);
        if (existing) {
          existing.count++;
          existing.lastPos = absPos + m.index;
        } else {
          counter.set(name, { count: 1, lastPos: absPos + m.index });
        }
      }
    }

    absPos += lineLen + 1; // +1 for newline
  }

  return Array.from(counter.entries()).map(([name, stats]) => ({
    name,
    count: stats.count,
    lastPos: stats.lastPos,
  }));
}

/**
 * 合并后统一宠物名：找出所有名字，保留最常见的，替换其余
 */
export function normalizePetNames(text: string): string {
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  if (!hasChinese) return text;

  const stats = findChinesePetNames(text);
  if (stats.length <= 1) return text;

  // 找出现次数最多的名字（出现次数相同则选最后出现的）
  let canonical = stats[0];
  for (const s of stats) {
    if (s.count > canonical.count || (s.count === canonical.count && s.lastPos > canonical.lastPos)) {
      canonical = s;
    }
  }

  // 如果最高频的名字只出现 1 次，选最后出现的那个
  if (canonical.count === 1) {
    let latest = stats[0];
    for (const s of stats) {
      if (s.lastPos > latest.lastPos) latest = s;
    }
    canonical = latest;
  }

  // 替换所有其他名字
  let normalized = text;
  for (const s of stats) {
    if (s.name === canonical.name) continue;
    const toReplace = s.name;

    let i = 0;
    while ((i = normalized.indexOf(toReplace, i)) !== -1) {
      const before = i > 0 ? normalized[i - 1] : ' ';
      const afterPos = i + toReplace.length;
      const after = afterPos < normalized.length ? normalized[afterPos] : ' ';
      const beforeIsCN = /[\u4e00-\u9fff]/.test(before);
      const afterIsCN = /[\u4e00-\u9fff]/.test(after);

      if (!beforeIsCN && !afterIsCN) {
        normalized = normalized.slice(0, i) + canonical.name + normalized.slice(i + toReplace.length);
        i += canonical.name.length;
      } else {
        i += toReplace.length;
      }
    }
  }

  return normalized;
}

/**
 * 返回检测到的宠物名统计（供外部记录日志用）
 */
export function getPetNameStats(text: string): NameStats[] {
  return findChinesePetNames(text);
}

// ============================================================
// 英文宠物名一致性后处理
// ============================================================

/** 英文宠物名列表 */
const ENGLISH_PET_NAMES = new Set([
  'Bean', 'Mochi', 'Junie', 'Muffin', 'Charlie', 'Max', 'Buddy', 'Ollie',
  'Luna', 'Bella', 'Taco', 'Noodle', 'Fudge', 'Biscuit', 'Coco', 'Peanut',
  'Shadow', 'Ginger', 'Milo', 'Oscar', 'Leo', 'Simba', 'Nala', 'Smokey',
  'Tiger', 'Poppy', 'Daisy', 'Harley', 'Duke', 'Bear', 'Tucker', 'Winston',
]);

/**
 * 统一英文文本中的宠物名：
 * 1. 检测文本中出现的所有英文宠物名
 * 2. 找出出现最多的名字作为规范名
 * 3. 把所有其他宠物名替换为规范名
 * 4. 保留大小写（规范名首次出现时用原大小写）
 */
export function normalizeEnglishPetNames(text: string): string {
  // 1. 收集所有出现的宠物名及位置
  const foundNames: { name: string; index: number }[] = [];
  const nameRegex = new RegExp('\\b(' + [...ENGLISH_PET_NAMES].join('|') + ')\\b', 'gi');
  let match;
  const regexCopy = new RegExp(nameRegex.source, 'gi');
  while ((match = regexCopy.exec(text)) !== null) {
    foundNames.push({ name: match[0], index: match.index });
  }

  if (foundNames.length === 0) return text;

  // 2. 统计各名字出现次数
  const counts: Record<string, number> = {};
  for (const { name } of foundNames) {
    const lower = name.toLowerCase();
    counts[lower] = (counts[lower] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  // 如果只有一个名字，不需要处理
  if (sorted.length <= 1) return text;

  const canonical = sorted[0][0]; // 最高频的名字（小写）
  const canonicalDisplay = foundNames.find(f => f.name.toLowerCase() === canonical)?.name || sorted[0][0];

  // 3. 替换所有其他名字
  let result = text;
  for (const [nameLower] of sorted.slice(1)) {
    const pattern = new RegExp('\\b(' + nameLower + ')\\b', 'gi');
    result = result.replace(pattern, canonicalDisplay);
  }

  // 4. 把所有小写 canonicalDisplay 替换为正确大小写
  const canonicalLowerPattern = new RegExp('\\b(' + canonical + ')\\b', 'gi');
  result = result.replace(canonicalLowerPattern, canonicalDisplay);

  return result;
}

// ============================================================
// 翻译后残留英文清理（用于中文治愈心理学 pipeline）
// 翻译可能不完美，残留英文宠物词需要被替换
// ============================================================

/**
 * 清理中文文本中残留的英文宠物相关词
 * 翻译可能不彻底，如 "my cat is snoring" 译成中文后可能还有 "cat" 等词
 */
export function cleanResidualEnglishInChinese(text: string): string {
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  if (!hasChinese) return text;

  let result = text;

  // 英文宠物类别词 → 中文
  const petWordReplacements: [RegExp, string][] = [
    // 猫相关
    [/\bcat\b/gi, '猫'],
    [/\bcats\b/gi, '猫'],
    [/\bkitten\b/gi, '小猫'],
    [/\bkittens\b/gi, '小猫'],
    [/\bfeline\b/gi, '猫'],
    [/\bmeow\b/gi, '喵'],
    [/\bmeows\b/gi, '喵'],
    [/\bmeowing\b/gi, '喵喵叫'],
    [/\bpurr\b/gi, '呼噜'],
    [/\bpurrs\b/gi, '呼噜'],
    [/\bpurring\b/gi, '打呼噜'],
    [/\bwhisker\b/gi, '胡须'],
    [/\bwhiskers\b/gi, '胡须'],
    // 狗相关
    [/\bdog\b/gi, '狗'],
    [/\bdogs\b/gi, '狗'],
    [/\bpuppy\b/gi, '小狗'],
    [/\bpuppies\b/gi, '小狗'],
    [/\bcanine\b/gi, '狗'],
    [/\bwoof\b/gi, '汪'],
    [/\bwoofs\b/gi, '汪'],
    [/\bwoofing\b/gi, '汪汪叫'],
    [/\bpaw\b/gi, '爪子'],
    [/\bpaws\b/gi, '爪子'],
    // 常见动物总称
    [/\bpet\b/gi, '宠物'],
    [/\bpets\b/gi, '宠物'],
    [/\banimal\b/gi, '动物'],
    [/\banimals\b/gi, '动物'],
  ];

  for (const [pattern, replacement] of petWordReplacements) {
    result = result.replace(pattern, replacement);
  }

  // 清理残留英文短语（更完整的上下文）
  const phraseReplacements: [RegExp, string][] = [
    // 结尾句残留
    [/\bmy cat is snoring\b/gi, '我的猫在打呼噜'],
    [/\bmy dog is snoring\b/gi, '我的狗在打呼噜'],
    [/\bmy cat\b/gi, '我的猫'],
    [/\bmy dog\b/gi, '我的狗'],
    [/\bmy kitten\b/gi, '我的小猫'],
    [/\bmy puppy\b/gi, '我的小狗'],
    [/\bmy pet\b/gi, '我的宠物'],
    [/\bcat is\b/gi, '猫在'],
    [/\bdog is\b/gi, '狗在'],
    [/\bcat was\b/gi, '猫当时'],
    [/\bdog was\b/gi, '狗当时'],
    [/\bcat just\b/gi, '猫刚'],
    [/\bdog just\b/gi, '狗刚'],
    [/\bcat and\b/gi, '猫和'],
    [/\bdog and\b/gi, '狗和'],
    [/\bthe cat\b/gi, '这只猫'],
    [/\bthe dog\b/gi, '这只狗'],
    [/\bthe kitten\b/gi, '这只小猫'],
    [/\bthe puppy\b/gi, '这只小狗'],
    // 呼噜相关残留
    [/\bpurring now\b/gi, '正在打呼噜'],
    [/\bis purring\b/gi, '在打呼噜'],
    [/\bwas purring\b/gi, '在打呼噜'],
    [/\bare purring\b/gi, '在打呼噜'],
    // 睡觉相关
    [/\bis asleep\b/gi, '睡着了'],
    [/\bwas asleep\b/gi, '睡着了'],
    [/\bfell asleep\b/gi, '睡着了'],
    [/\bfalling asleep\b/gi, '快睡着了'],
    [/\bgo to sleep\b/gi, '去睡觉'],
    [/\btime to sleep\b/gi, '该睡觉了'],
    [/\bgo to bed\b/gi, '去睡觉'],
    // Good night 残留
    [/\bGood night\b/gi, '晚安'],
    [/\bgood night\b/gi, '晚安'],
    [/\bGoodnight\b/gi, '晚安'],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

