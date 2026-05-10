/**
 * AI 内容去味服务
 * 目的：给 AI 生成的内容加"人类噪点"，打破完美感，注入真实结构
 * 让 YouTube 等平台检测判定为「人主导、AI 辅助」的内容
 */

import { streamContentGeneration, type StreamModelArgs } from './geminiService';
import { CANDIDATE_NAMES as KNOWN_PET_NAMES } from './normalizePetNames';

/** 常见非宠物名中文词（用于排除误检测） */
const NON_PET_PATTERNS = new Set([
  '什么', '这个', '那个', '自己', '我们', '他们', '这么', '那么',
  '时候', '地方', '感觉', '知道', '觉得', '就是', '不是', '还是',
  '真的', '应该', '可以', '没有', '一样', '一定',
  '可能', '所以', '因为', '但是', '而且', '或者', '如果',
  '而且', '而且是', '或者', '甚至', '是不', '不是',
]);

export interface AntiAiPolishingOptions {
  /** API Key（可选，函数内部使用全局 initializeGemini 设置） */
  apiKey?: string;
  /** 日志回调 */
  onLog?: (message: string) => void;
  /** 流式输出回调 */
  onChunk?: (text: string) => void;
  /** 输出语言，可选 */
  outputLanguage?: string;
  /** 宠物名约束：合并后已统一的规范名，AI 改写时禁止替换成其他名字 */
  petNameConstraint?: {
    canonicalName: string;
  };
  /** 赛道类型（用于调整评估宽容度） */
  nicheType?: string;
}

/**
 * AI 模板词列表（多语言支持）
 */
const AI_TEMPLATE_WORDS: Record<string, string[]> = {
  // 中文
  zh: [
    '首先', '其次', '再次', '然后', '接下来', '此外', '另外', '总之', '总而言之',
    '综上所述', '因此', '所以', '由于', '然而', '但是', '不过', '值得注意的是',
    '显而易见', '毫无疑问', '毋庸置疑', '换句话说', '也就是说', '一方面',
    '另一方面', '第一', '第二', '第三', '第四', '第五', '总的来说', '说白了',
    '实际上', '一般来说', '通常情况下', '需要指出的是', '必须强调的是',
    '从某种意义上说', '说到底', '归根结底', '值得注意的是',
  ],
  // 英文
  en: [
    'firstly', 'secondly', 'furthermore', 'moreover', 'therefore', 'however',
    'in conclusion', 'to summarize', 'in summary', 'additionally', 'lastly',
    'on the other hand', 'as a result', 'in other words', 'that being said',
    'it is worth noting', 'it should be noted', 'it is important to note',
    'ultimately', 'basically', 'clearly', 'obviously', 'undoubtedly',
  ],
  // 韩语
  ko: [
    '먼저', '또한', '따라서', '그러나', '하지만', '그리고', '이것은', '이러한',
    '나아가', '더 나아가', '결론적으로', '요약하면', '결과적으로',
  ],
  // 日语
  ja: [
    'まず', '次に', 'さらに', 'したがって', 'しかし', 'だが', 'そして',
    'これは', 'このような', '要するに', 'まとめると', '結論として',
    '確かに', '明らかに', '当然ながら',
  ],
  // 西班牙语
  es: [
    'primero', 'en primer lugar', 'segundo', 'en segundo lugar', 'además', 'así mismo',
    'por lo tanto', 'por consiguiente', 'sin embargo', 'no obstante', 'pero',
    'en conclusión', 'en resumen', 'en síntese', 'finalmente', 'por último',
    'esto es', 'es decir', 'en otras palabras', 'a saber',
  ],
  // 德语
  de: [
    'zunächst', 'erstens', 'zweitens', 'drittens', 'schließlich', 'zuletzt',
    'darüber hinaus', 'außerdem', 'ebenso', 'deshalb', 'daher', 'folglich',
    'jedoch', 'aber', 'nichtsdestotrotz', 'im Übrigen', 'zusammenfassend',
    'alles in allem', 'kurz gesagt', 'mit anderen Worten', 'das heißt',
  ],
  // 法语
  fr: [
    'premièrement', 'deuxièmement', 'troisièmement', 'enfin', 'pour finir',
    'de plus', 'en outre', 'également', 'par conséquent', 'donc',
    'cependant', 'mais', 'néanmoins', 'pourtant', 'enfin',
    'en conclusion', 'en résumé', 'en síntesis', 'pour résumer',
    "c'est-à-dire", "en d'autres termes", "d'une part... d'autre part",
  ],
  // 印地语
  hi: [
    'पहले', 'प्रथम', 'दूसरे', 'तीसरे', 'अंत में', 'आखिरकार',
    'इसके अलावा', '� além', 'इसके अतिरिक्त', 'इसीलिए', 'अतः', 'इसलिए',
    'लेकिन', 'परंतु', 'किंतु', 'फिर भी', 'तथापि',
    'सार में', 'संक्षेप में', 'निष्कर्ष में', 'दूसरे शब्दों में',
  ],
  // 泰语
  th: [
    'ประการแรก', 'ประการที่สอง', 'ประการที่สาม', 'ในที่สุด', 'สุดท้าย',
    'นอกจากนี้', 'ยิ่งไปกว่านั้น', 'ดังนั้น', 'เพราะฉะนั้น', 'จึง',
    'แต่', 'อย่างไรก็ตาม', 'ทว่า', 'อย่างไรก็ดี',
    'โดยสรุป', 'สรุปแล้ว', 'กล่าวคือ', 'กล่าวอีกนัยหนึ่ง',
  ],
  // 葡萄牙语
  pt: [
    'primeiro', 'em primeiro lugar', 'segundo', 'em segundo lugar', 'terceiro',
    'por fim', 'finalmente', 'último',
    'além disso', 'ademais', 'também', 'portanto', 'assim',
    'entretanto', 'porém', 'mas', 'contudo', 'todavia',
    'em conclusão', 'em resumo', 'em síntese', 'por outras palavras',
  ],
  // 印尼语
  id: [
    'pertama', 'kedua', 'ketiga', 'terakhir', 'akhirnya',
    'selain itu', 'di samping itu', 'selain itu juga', 'oleh karena itu', 'jadi',
    'tetapi', 'namun', 'akan tetapi', 'meskipun', 'walaupun',
    'kesimpulannya', 'ringkasnya', 'dengan kata lain', 'dalam ringkasan',
  ],
};

/**
 * 人类口语特征词列表（多语言支持）
 */
const HUMAN_COLLOQUIAL_WORDS: Record<string, string[]> = {
  // 中文
  zh: [
    '其实', '说真的', '讲真', '说实话', '你懂的', '嘛', '呢', '吧', '呀', '哈', '哦', '嗯', '诶',
    '可能', '或许', '大概', '感觉', '好像', '不太确定',
    '我自己', '当时', '之前', '有一次', '我发现', '我有个朋友',
    '说实话挺', '真的有点', '被坑过', '挺无奈的', '无语了',
  ],
  // 英文
  en: [
    'honestly', 'you know', 'I feel like', 'it seems like', 'maybe', 'probably',
    'actually', 'basically', 'literally', 'kind of', 'sort of',
    'I guess', 'I suppose', 'well', 'right', 'so', 'oh',
    'you see', 'I mean', 'to be honest', 'to tell you the truth',
  ],
  // 韩语
  ko: [
    '솔직히', '음', '그냥', '아마도', '어쩌면', '뭔가', '있잖아',
    '글쎄', '근데', '그런데', '야', '저기', '확실히',
    '나도', '나도 그래', '그치', '맞지', '내 말은',
  ],
  // 日语
  ja: [
    '正直', '说实话', 'うーん', 'まあ', 'ちょっと', 'なんか', 'ある意味',
    'そう言えば', '要するに', 'つまり', 'だって', 'でも', 'ね',
    'じゃない', 'かな', 'でしょ', 'だと思う', 'かもね',
  ],
  // 西班牙语
  es: [
    'honestamente', 'a decir verdad', 'bueno', 'verás', 'es que',
      'quizás', 'tal vez', 'probablemente', 'me parece que',
      'o sea', 'en fin', 'bueno', 'ya', 'mira', '¿sabes?',
      'la verdad', 'la verdad es que', 'básicamente',
  ],
  // 德语
  de: [
    'ehrlich gesagt', 'ich meine', 'na ja', 'also', 'weißt du',
    'vielleicht', 'wahrscheinlich', 'ich glaube', 'ich denke',
    'im Grunde', 'eigentlich', 'doch', 'na ja', 'ach so',
  ],
  // 法语
  fr: [
    'honnêtement', 'à vrai dire', 'eh bien', 'tu sais', 'en fait',
    'peut-être', 'probablement', 'il me semble', 'je crois',
    'bon', 'bah', 'alors', 'du coup', 'du coup',
    'quand même', 'enfin', 'puis',
  ],
  // 印地语
  hi: [
    'इमानदारी से', 'वास्तव में', 'खैर', 'तो', 'जानते हो',
    'शायद', 'हो सकता है', 'मुझे लगता है', 'मेरा मतलब है',
    'अच्छा', 'वो', 'यार', 'ना',
  ],
  // 泰语
  th: [
    'ตอบHONEST', 'จริงๆ แล้ว', 'ก็', 'เออ', 'รู้สึกว่า', 'อาจจะ',
    'ก็ได้', 'นะ', 'ใช่ไหม', 'เกี่ยวกับ', 'อะ', 'เหรอ',
    'เข้าใจนะ', 'ไม่แน่ใจ', 'ก็อาจจะ',
  ],
  // 葡萄牙语
  pt: [
    'honestamente', 'na verdade', 'bom', 'sabe', 'tipo',
    'talvez', 'provavelmente', 'me parece que', 'acho que',
    'né', 'então', 'assim', 'bem', 'você sabe',
  ],
  // 印尼语
  id: [
    'jujur', 'sejujurnya', 'memang', 'sih', 'kok', 'lho', 'nah',
    'mungkin', 'kayaknya', 'tuh', 'deh', 'gitu',
    'gue', 'gue rasa', 'kira-kira',
  ],
};

/**
 * 语言代码到模板词列表的映射
 */
const LANGUAGE_TO_TEMPLATES: Record<string, string> = {
  zh: 'zh', zh_cn: 'zh', zh_tw: 'zh',
  en: 'en', english: 'en',
  ko: 'ko', korean: 'ko',
  ja: 'ja', japanese: 'ja',
  es: 'es', spanish: 'es',
  de: 'de', german: 'de',
  fr: 'fr', french: 'fr',
  hi: 'hi', hindi: 'hi',
  th: 'th', thai: 'th',
  pt: 'pt', portuguese: 'pt',
  id: 'id', indonesian: 'id', bahasa: 'id',
};

function getLanguageKey(lang: string): string {
  return LANGUAGE_TO_TEMPLATES[lang.toLowerCase()] || 'en';
}

/**
 * 计算指定语言的 AI 模板词数量
 */
function countTemplateWordsByLang(text: string, lang: string): number {
  const key = getLanguageKey(lang);
  const words = AI_TEMPLATE_WORDS[key] || AI_TEMPLATE_WORDS.en;
  let count = 0;
  const lowerText = text.toLowerCase();

  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('\\b' + escaped + '\\b', 'gi');
    const matches = lowerText.match(regex);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

/**
 * 计算人类口语特征词数量（支持多语言）
 */
function countHumanColloquialWords(text: string, lang: string): number {
  const key = getLanguageKey(lang);
  const words = HUMAN_COLLOQUIAL_WORDS[key] || HUMAN_COLLOQUIAL_WORDS.en;
  let count = 0;
  const lowerText = text.toLowerCase();

  for (const word of words) {
    // 中文使用宽松匹配（避免 \b 对中文无效的问题）
    let regex: RegExp;
    if (/[\u4e00-\u9fff]/.test(word)) {
      // 中文词：直接匹配
      regex = new RegExp(word, 'gi');
    } else {
      // 英文词：使用词边界
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp('\\b' + escaped + '\\b', 'gi');
    }
    const matches = lowerText.match(regex);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

/**
 * 计算多语言模板词替换比例
 */
function calculateContentRetention(
  original: string,
  polished: string,
  lang: string
): { retentionRatio: number; hasDeletedContent: boolean; detail: string } {
  // 中文用中文标点分句，英文用英文标点分句
  const isEnglish = lang === 'en';
  const sentenceSplit = isEnglish
    ? /[.!?]+/
    : /[。！？\n]/;
  const origSentences = original.split(sentenceSplit).map(s => s.trim()).filter(s => s.length > (isEnglish ? 10 : 5));
  if (origSentences.length === 0) {
    return { retentionRatio: 1.0, hasDeletedContent: false, detail: '无可检测句子' };
  }
  let retainedCount = 0;
  // 口语词前缀（去掉后检测核心词）
  const spokenPrefixes = isEnglish
    ? ['actually,', 'honestly,', 'well,', 'so,', 'I mean,', 'you know,', 'basically,', 'here\'s the thing,']
    : ['其实', '说真的', '说实话', '好吧', '不过', '但是', '而且', '然后', '再说', '所以', '结果'];
  for (const sentence of origSentences) {
    let core = sentence;
    for (const prefix of spokenPrefixes) {
      core = core.replace(new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim();
    }
    core = core.slice(0, isEnglish ? 25 : 20);
    if (core.length < (isEnglish ? 12 : 8)) {
      retainedCount++;
      continue;
    }
    if (polished.includes(core)) {
      retainedCount++;
    }
  }
  const retentionRatio = retainedCount / origSentences.length;
  const hasDeletedContent = retentionRatio < 0.7;
  return { retentionRatio, hasDeletedContent, detail: `${retainedCount}/${origSentences.length}句保留` };
}

function calculateTemplateReplaceRatio(original: string, polished: string, lang: string) {
  const key = getLanguageKey(lang);
  const words = AI_TEMPLATE_WORDS[key] || AI_TEMPLATE_WORDS.en;

  let totalInOriginal = 0;
  let replacedCount = 0;
  const lowerOriginal = original.toLowerCase();
  const lowerPolished = polished.toLowerCase();

  for (const word of words) {
    // 中文使用宽松匹配（避免 \b 对中文无效的问题）
    let regex: RegExp;
    if (/[\u4e00-\u9fff]/.test(word)) {
      // 中文词：直接匹配
      regex = new RegExp(word, 'gi');
    } else {
      // 英文词：使用词边界
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp('\\b' + escaped + '\\b', 'gi');
    }
    const origMatches = (lowerOriginal.match(regex) || []).length;
    const polyMatches = (lowerPolished.match(regex) || []).length;

    if (origMatches > 0) {
      totalInOriginal += origMatches;
      if (polyMatches < origMatches) {
        replacedCount += (origMatches - polyMatches);
      }
    }
  }

  const replaceRatio = totalInOriginal > 0 ? replacedCount / totalInOriginal : 0;
  return { replacedCount, totalInOriginal, replaceRatio };
}

/**
 * 计算人类口语特征词添加数量（多语言）
 */
function calculateHumanWordAddition(original: string, polished: string, lang: string): { addedCount: number; originalCount: number; polishedCount: number } {
  const originalCount = countHumanColloquialWords(original, lang);
  const polishedCount = countHumanColloquialWords(polished, lang);
  const addedCount = Math.max(0, polishedCount - originalCount);
  return { addedCount, originalCount, polishedCount };
}

/**
 * 计算句式变化程度
 */
function calculateSentenceVariation(original: string, polished: string): { changedCount: number; totalSentences: number; variationRatio: number } {
  const origSentences = original.split(/[。！？.!?\n]/).filter(s => s.trim().length > 5);
  const polySentences = polished.split(/[。！？.!?\n]/).filter(s => s.trim().length > 5);

  const minLen = Math.min(origSentences.length, polySentences.length);
  let changedCount = 0;

  for (let i = 0; i < minLen; i++) {
    const origStart = origSentences[i].trim().slice(0, 8).toLowerCase();
    const polyStart = polySentences[i].trim().slice(0, 8).toLowerCase();
    if (origStart !== polyStart) {
      changedCount++;
    }
  }

  const totalSentences = minLen;
  const variationRatio = totalSentences > 0 ? changedCount / totalSentences : 0;
  return { changedCount, totalSentences, variationRatio };
}

/**
 * 综合评估去AI味效果（多语言）
 */
interface PolishingEvaluation {
  templateReplaceRatio: number;
  humanWordsAdded: number;
  humanWordsTarget: number;
  sentenceVariationRatio: number;
  lengthChangeRatio: number;
  isEffective: boolean;
  reasons: string[];
}

function evaluatePolishingEffectiveness(
  original: string,
  polished: string,
  originalLen: number,
  polishedLen: number,
  lang: string,
  nicheType?: string
): PolishingEvaluation {
  const reasons: string[] = [];
  const isGreatPowerGame = nicheType === 'great_power_game';
  // 新闻赛道也需要宽容（内容会被严重删减）
  const isNews = nicheType === 'news';

  // 1. 模板词替换
  const templateResult = calculateTemplateReplaceRatio(original, polished, lang);
  const templateReplaceRatio = templateResult.replaceRatio;

  // 2. 人类口语词添加
  const humanResult = calculateHumanWordAddition(original, polished, lang);
  const humanWordsAdded = humanResult.addedCount;
  // 大国博弈：Bo Yi 风格以权威陈述为主，不需要大量口语词，目标降低
  // 新闻赛道：也需要宽容
  const humanWordsTarget = isGreatPowerGame || isNews
    ? Math.ceil(originalLen / 1000) * 1  // 每1000字约1处（极低要求）
    : Math.ceil(originalLen / 1000) * 4; // 其他赛道：每1000字约4处

  // 3. 句式变化
  const sentenceResult = calculateSentenceVariation(original, polished);
  const sentenceVariationRatio = sentenceResult.variationRatio;

  // 4. 内容保留检测
  const retention = calculateContentRetention(original, polished, lang);
  // 大国博弈/新闻：宽容内容保留率阈值（允许更多变化）
  const retentionThreshold = isGreatPowerGame || isNews ? 0.5 : 0.7;
  // 大国博弈/新闻：hasDeletedContent 也用宽容阈值
  const effectiveHasDeleted = (isGreatPowerGame || isNews) ? (retention.retentionRatio < 0.5) : retention.hasDeletedContent;
  const contentValid = !effectiveHasDeleted && retention.retentionRatio >= retentionThreshold;

  // 5. 长度变化
  // 大国博弈/新闻：宽容长度变化阈值
  const lengthThreshold = isGreatPowerGame || isNews ? 0.40 : 0.15;
  const lengthChangeRatio = originalLen > 0 ? Math.abs(polishedLen - originalLen) / originalLen : 0;
  const lengthValid = lengthChangeRatio <= lengthThreshold;

  // ===== 日志记录 =====
  if (templateResult.totalInOriginal > 0) {
    if (templateReplaceRatio < 0.3) {
      reasons.push(`模板词替换不足: ${(templateReplaceRatio * 100).toFixed(1)}%`);
    } else {
      reasons.push(`✅ 模板词替换达标: ${(templateReplaceRatio * 100).toFixed(1)}%`);
    }
  } else {
    reasons.push(`✅ 无模板词需替换`);
  }

  // 大国博弈/新闻：不下发口语词不足警告——Bo Yi/小美风格不以口语词见长
  const humanThreshold = isGreatPowerGame || isNews
    ? Math.max(1, Math.floor(humanWordsTarget * 0.5))
    : Math.max(3, Math.floor(humanWordsTarget * 0.3));
  if (humanWordsAdded >= humanThreshold) {
    reasons.push(`✅ 口语词添加达标: ${humanWordsAdded}/${humanWordsTarget}`);
  } else if (humanWordsAdded > 0) {
    reasons.push(`口语词添加较少: ${humanWordsAdded}/${humanWordsTarget}`);
  } else {
    if (!isGreatPowerGame && !isNews) {
      reasons.push(`⚠️ 无新增口语词`);
    }
  }

  // 大国博弈/新闻：宽容句式变化阈值
  const sentenceThreshold = isGreatPowerGame || isNews ? 0.05 : 0.1;
  if (sentenceVariationRatio >= sentenceThreshold) {
    reasons.push(`✅ 句式有变化: ${(sentenceVariationRatio * 100).toFixed(1)}%`);
  } else {
    if (!isGreatPowerGame && !isNews) {
      reasons.push(`⚠️ 句式变化不足: ${(sentenceVariationRatio * 100).toFixed(1)}%`);
    }
  }

  if (!contentValid) {
    reasons.push(`⚠️ 内容被删除: ${retention.detail}（保留率${(retention.retentionRatio * 100).toFixed(1)}%）`);
  } else {
    reasons.push(`✅ 内容保留完整: ${retention.detail}`);
  }

  if (!lengthValid) {
    reasons.push(`⚠️ 长度变化过大: ${(lengthChangeRatio * 100).toFixed(1)}%（上限${(lengthThreshold * 100).toFixed(0)}%）`);
  }

  // 大国博弈/新闻：极度宽容——内容保留且长度变化不超过25%即为有效
  let isEffective = true;

  if (!contentValid) {
    reasons.push(`❌ 核心问题：AI 删除了原文内容！`);
    isEffective = false;
  } else if (!lengthValid) {
    // 大国博弈/新闻：长度变化不作为有效性判定标准
    if (!isGreatPowerGame && !isNews) {
      reasons.push(`⚠️ 长度变化超标，AI可能过度发挥`);
      isEffective = false;
    }
  } else if (humanWordsAdded === 0 && sentenceVariationRatio < (isGreatPowerGame || isNews ? 0.05 : 0.1)) {
    // 大国博弈/新闻不下发此警告
    if (!isGreatPowerGame && !isNews) {
      reasons.push(`⚠️ 原文有 ${humanResult.originalCount} 个口语词，改写后无新增且句式无变化`);
    }
    isEffective = false;
  } else if (templateResult.totalInOriginal > 0 && templateReplaceRatio < 0.1) {
    reasons.push(`⚠️ 原文有${templateResult.totalInOriginal}个模板词但替换率仅${(templateReplaceRatio * 100).toFixed(1)}%`);
  }

  return {
    templateReplaceRatio,
    humanWordsAdded,
    humanWordsTarget,
    sentenceVariationRatio,
    lengthChangeRatio,
    isEffective,
    reasons,
  };
}

/**
 * 深度去AI味清洗 Prompt（替换 + 添加，不删除）
 * 多语言支持：根据 outputLanguage 使用对应的模板词和口语词
 */
const ANTI_AI_POLISH_PROMPT: Record<string, string> = {
  // 中文
  zh: `你是专业的内容编辑。请对下面的文案进行去AI味处理，只做词替换。

## 核心任务：只替换词，不删不增内容

### 替换 AI 模板词
将以下 AI 模板词替换为更自然的表达：
- "首先" → "其实" / "说真的" / "一开始"
- "其次" → "然后" / "接下来" / "之后"
- "因此" → "所以" / "于是" / "结果"
- "然而" → "但是" / "不过"
- "总之" → "说白了" / "说到底" / "反正"
- "显而易见" → "其实一眼就能看出来"
- "毫无疑问" → "其实谁都看得出来"
- "此外" / "另外" → "而且" / "再说"
- "综上所述" → "说白了"
- "值得注意的是" → "其实"

### 轻微调整句式
- 长短句交替，相邻句子开头词不要相同

## 禁止
- ❌ 删除原文任何内容
- ❌ 修改末尾 CTA
- ❌ 添加新内容
- ❌ 将一句扩写成多句

## 输出要求
- **长度误差 ±5%**
- **必须保留原文所有句子，只替换词**
- 原文有哪些内容，输出就一定有这些内容

待改写文案：

`,

  // 英文
  en: `You are a content editor rewriting text to sound authentically human. Preserve ALL original content — this is non-negotiable.

## ⚠️ NON-NEGOTIABLE: PRESERVE EVERYTHING
- Every sentence from the input MUST appear in the output
- Every paragraph from the input MUST be preserved
- Do NOT delete, merge, split, or truncate any content
- Output length: ±10% of original input

## Transformation Tasks (in order of priority)

### 1. Replace AI Template Words → Natural Expressions
- "firstly" / "first of all" → "honestly" / "actually" / "well" / "so"
- "secondly" / "thirdly" → "next" / "then" / "also"
- "furthermore" / "moreover" / "additionally" → "also" / "plus" / "and"
- "therefore" / "consequently" / "thus" → "so" / "that's why" / "hence"
- "however" / "nevertheless" → "but" / "though" / "still"
- "in conclusion" / "to summarize" → "to finish" / "finally" / "all in all"
- "it is important to note" / "it should be noted" → "the thing is" / "here's the point"
- "it is evident that" / "it is clear that" → "you can see" / "basically"

### 2. Vary Sentence Structure — THIS IS REQUIRED
- Change how sentences begin (don't start consecutive sentences with the same word)
- Mix long and short sentences
- If a sentence is very long (>40 words), consider splitting it into 2 shorter sentences
- Add transitional phrases between paragraphs

### 3. Add Human Colloquial Markers (at least 3-5 per 500 words)
Natural spoken fillers: "honestly", "you know", "I mean", "actually", "well", "basically", "here's the thing", "so basically", "I guess", "like", "sort of", "kind of"

## FORBIDDEN
- ❌ Delete or remove ANY content
- ❌ Modify the ending CTA
- ❌ Combine sentences
- ❌ Split sentences into more than 2

## Output
Output the rewritten text. All original content preserved. Only word substitution, sentence restructuring, and adding spoken markers.

Text to rewrite:

`,

  // 韩文
  ko: `당신은 전문 콘텐츠 편집자입니다. 텍스트를 실제 인간이 쓴 것처럼 들리게 깊이 재작성해야 합니다.

## 핵심 작업

### 1. AI 템플릿 단어 교체
- "먼저" → "솔직히" / "음" / "그냥"
- "또한" → "그리고" / "또" / "게다가"
- "따라서" → "그래서" / "그러니까"
- "그러나" / "하지만" → "근데" / "그런데"
- "요약하면" → "어쨌든" / "결국"

### 2. 인간 구어체 특징 추가 (300자당 3-5개)
- 솔직히, 음, 그 그냥, 아마도, 어쩌면, 뭔가
- 있잖아, 글쎄, 근데, 그런데, 야, 저기

### 3. 문장 구조 다양화
- 길고 짧은 문장 섞기
- 연속된 문장의 시작 단어 다르게

## 금지
- ❌ 원본 내용 삭제
- ❌ 문장 병합 또는 분할
- ❌ 끝 CTA 수정

재작성할 텍스트:

`,

  // 日文
  ja: `あなたはプロのコンテンツ編集者です。テキストをより自然な人間らしい文章に深く書き換えてください。

## コアタスク

### 1. AIテンプレート単語の置換
- 「まず」→ 「正直に言うと」/ 「実は」/ 「うーん」
- 「次に」→ 「それから」/ 「それで」
- 「さらに」→ 「それに」/ 「加えると」
- 「したがって」→ 「だから」/ 「それで」
- 「しかし」→ 「でも」/ 「だけど」

### 2. 人間の口語特徴を追加（300文字あたり3-5か所）
- 正直、うーん、でも其实说实话Maybe
- そう言えば要するに Basically
- じゃない、かな、知って?

### 3. 文構造の変化
- 長い文と短い文を混ぜる
- 連続する文の始まりを変えます

## 禁止
- ❌ 元の内容の削除
- ❌ 文の合併または分割
- ❌ 終わりのCTAを変更

書き換えるテキスト:

`,

  // 西班牙文
  es: `Eres un editor de contenido profesional. Tu tarea es reescribir el texto para que suene como si un humano real lo hubiera escrito, no una IA.

## Tareas Principales

### 1. Reemplazar Palabras Plantilla de IA
- "primero" / "en primer lugar" → "bueno" / "verás"
- "además" / "asimismo" → "también" / "y también"
- "por lo tanto" → "así que" / "entonces"
- "sin embargo" → "pero" / "no obstante"
- "en conclusión" → "en fin" / "para terminar"

### 2. Agregar Características Coloquiales (3-5 por cada 300 palabras)
- Honestamente, o sea, bueno, ¿sabes?, quizás, probablemente
- Me parece que, a decir verdad, básicamente

### 3. Variar Estructura de Oraciones
- Mezclar oraciones largas y cortas
- No comenzar oraciones consecutivas con la misma palabra

## Prohibido
- ❌ Eliminar contenido del original
- ❌ Fusionar o dividir oraciones
- ❌ Modificar la CTA final

Texto a reescribir:

`,

  // 德文
  de: `Sie sind ein professioneller Content-Editor. Ihre Aufgabe ist es, den Text tiefgreifend umzuschreiben, damit er klingt, als hätte ihn ein echter Mensch geschrieben, nicht KI.

## Kernaufgaben

### 1. KI-Vorlagenwörter ersetzen
- "zunächst" / "erstens" → "also" / "na ja" / "ehrlich gesagt"
- "darüber hinaus" / "außerdem" → "auch" / "und dann"
- "deshalb" / "daher" → "also" / "so"
- "jedoch" / "aber" → "doch" / "aber"
- "zusammenfassend" → "kurz gesagt" / "im Grunde"

### 2. Menschliche Umgangssprachliche Merkmale hinzufügen (3-5 pro 300 Wörter)
- Ehrlich gesagt, ich meine, na ja, weißt du, vielleicht
- Wahrscheinlich, ich glaube, eigentlich, doch, ach so

### 3. Satzstruktur variieren
- Lange und kurze Sätze mischen
- Aufeinanderfolgende Sätze nicht mit demselben Wort beginnen

## Verboten
- ❌ Inhalt aus dem Original löschen
- ❌ Sätze zusammenfügen oder trennen
- ❌ Die finale CTA ändern

Text zum Umschreiben:

`,

  // 法文
  fr: `Vous êtes un éditeur de contenu professionnel. Votre tâche est de réécrire profondément le texte pour qu'il semble avoir été écrit par un humain réel, pas par l'IA.

## Tâches Principales

### 1. Remplacer les Mots Modèles IA
- "premièrement" / "d'abord" → "bon" / "eh bien"
- "de plus" / "en outre" → "aussi" / "et puis"
- "par conséquent" / "donc" → "alors" / "du coup"
- "cependant" / "mais" → "mais" / "pourtant"
- "en conclusion" → "enfin" / "pour résumer"

### 2. Ajouter des Traits Colloquiaux Humains (3-5 par 300 mots)
- Honnêtement, à vrai dire, tu sais, peut-être, probablement
- Il me semble, en fait, bon, alors, du coup

### 3. Varier la Structure des Phrases
- Mélanger phrases longues et courtes
- Ne pas commencer les phrases consécutives avec le même mot

## Interdit
- ❌ Supprimer du contenu de l'original
- ❌ Fusionner ou diviser les phrases
- ❌ Modifier le CTA final

Texte à réécrire:

`,

  // 默认（英文）
  default: `You are a professional content editor. **You MUST make substantial changes to the text below.** Make it sound like a real human wrote it, not AI-generated.

## ⚠️ CRITICAL REQUIREMENT
**DO NOT output the original text unchanged! You MUST make substantial modifications and additions!**

### 1. Replace AI Template Words
Replace formal AI patterns with natural expressions:
- Firstly, moreover, furthermore → also, then, plus
- Therefore, consequently → so, that's why, hence
- However, nevertheless → but, though, still
- In conclusion, to summarize → to finish, finally

### 2. Add Human Colloquial Features (3-5 per 500 words)
Add natural markers: Honestly, you know, I feel like, it seems like, maybe, probably, kind of

### 3. Vary Sentence Structure
- Mix long and short sentences
- Don't start consecutive sentences with the same word

## Forbidden
- ❌ **DO NOT output original text unchanged**
- ❌ Delete any content from the original
- ❌ Modify the ending CTA

## Output
- Length variation within ±10%
- Must have substantial modifications

Text to rewrite:

`,
};

/**
 * 更激进的去AI味 Prompt（用于重试）
 */
const ANTI_AI_POLISH_PROMPT_AGGRESSIVE_TEMPLATE_ZH = `你是专业的内容改写编辑。这是一次深度改写任务。

## ⚠️ 必须更彻底的改写

### 1. 模板词全部替换（如有）
中文：所有"首先/其次/最后/因此/所以"等全部替换
英文：所有 firstly/secondly/furthermore/therefore 等全部替换
日韩德法西等其他语言：对应的模板词全部替换

### 2. 句式微调
- 改变句子开头词
- 长短句交替

## 禁止
- ❌ 删除原文任何内容
- ❌ 拆分句子
- ❌ 修改 CTA
- ❌ 原样输出原文

## 输出要求
- **长度误差 ±5%**
- **必须保留原文所有句子！只替换词**

待改写文案：

`;

// 英文 aggressive 重试模板
const ANTI_AI_POLISH_PROMPT_AGGRESSIVE_TEMPLATE_EN = `You are a deep rewrite editor. This is a thorough content rewriting task.

## ⚠️ CRITICAL: Preserve ALL Original Content

### 1. Replace AI Template Words (if any)
- firstly / second / moreover → honestly / actually / also
- therefore / consequently → so / that's why
- however / nevertheless → but / though
- in conclusion / to summarize → to finish / finally

### 2. Vary Sentence Structure
- Change sentence opening words (don't start consecutive sentences the same way)
- Mix long and short sentences
- Split very long sentences into shorter ones
- Add transitional phrases between paragraphs

### 3. Add Natural Spoken Features
- Add at least 5 colloquial markers: "honestly", "you know", "I mean", "actually", "well", "so basically", "here's the thing"

## FORBIDDEN
- ❌ Delete ANY content from the original
- ❌ Split or merge sentences
- ❌ Modify the ending CTA
- ❌ Output the original text unchanged

## OUTPUT REQUIREMENTS
- **Length: MUST be ≥ original length (do NOT shorten)**
- **Every sentence from the input MUST appear in the output**
- **Preserve ALL original meaning, details, and sentence count**

Text to rewrite:

`;

export interface AntiAiPolishingResult {
  success: boolean;
  polishedText: string;
  error?: string;
  /** 清洗是否真正达标（口语词有添加且达到阈值） */
  isEffective?: boolean;
  /** 口语词添加情况 */
  humanWordsAdded?: number;
  /** 口语词目标 */
  humanWordsTarget?: number;
}

/**
 * 获取对应语言的 Prompt
 */
function getPromptForLanguage(language: string): string {
  const key = LANGUAGE_TO_TEMPLATES[language.toLowerCase()] || language;
  return ANTI_AI_POLISH_PROMPT[key] || ANTI_AI_POLISH_PROMPT['default'];
}

/**
 * 强制执行宠物名约束：在返回结果前把所有非规范名字替换为规范名
 * 这是一个绝对可靠的安全网，不依赖 AI 遵守指令
 */
function enforcePetNameConstraint(
  result: string,
  constraint: NonNullable<AntiAiPolishingOptions['petNameConstraint']>
): string {
  if (!constraint.canonicalName) return result;
  // 用预设的候选宠物名列表做精确替换（不是 allNames，避免误检测词）
  let fixed = result;
  for (const name of KNOWN_PET_NAMES) {
    if (name === constraint.canonicalName) continue;
    // 精确子串替换，前后不能是汉字（避免把嵌入词的一部分替换掉）
    let i = 0;
    while ((i = fixed.indexOf(name, i)) !== -1) {
      const before = i > 0 ? fixed[i - 1] : ' ';
      const afterPos = i + name.length;
      const after = afterPos < fixed.length ? fixed[afterPos] : ' ';
      const beforeIsCN = /[\u4e00-\u9fff]/.test(before);
      const afterIsCN = /[\u4e00-\u9fff]/.test(after);
      if (!beforeIsCN && !afterIsCN) {
        fixed = fixed.slice(0, i) + constraint.canonicalName + fixed.slice(i + name.length);
        i += constraint.canonicalName.length;
      } else {
        i += name.length;
      }
    }
  }
  return fixed;
}

/**
 * 执行 AI 内容去味清洗（深度模式）
 * 多语言支持：根据 outputLanguage 选择对应的模板词和 Prompt
 */
export async function polishTextForAntiAi(
  text: string,
  options: AntiAiPolishingOptions,
  ...modelArgs: StreamModelArgs
): Promise<AntiAiPolishingResult> {
  const { onLog, onChunk, apiKey, outputLanguage, petNameConstraint } = options;

  if (!text || !text.trim()) {
    return { success: false, polishedText: '', error: '输入文本为空' };
  }

  const lang = outputLanguage || 'en';
  const langPrompt = getPromptForLanguage(lang);

  onLog?.(`[去AI味] 开始深度去味改写... (语言: ${lang})`);

  const MAX_RETRY = 2;
  const originalLen = text.replace(/\s+/g, '').length;

  // 统计原文情况
  const originalTemplateCount = countTemplateWordsByLang(text, lang);
  const originalHumanCount = countHumanColloquialWords(text, lang);
  // 目标：每1000字添加3-5处口语词（更宽松）
  const humanWordsTarget = Math.ceil(originalLen / 1000) * 4; // 每1000字约4处

  onLog?.(`[去AI味] 原文: ${originalTemplateCount} 个模板词, ${originalHumanCount} 个口语词, 目标添加 ${humanWordsTarget} 处口语词`);

  let attempt = 0;
  let bestResult = '';
  let bestEvaluation: PolishingEvaluation | null = null;

  while (attempt < MAX_RETRY) {
    attempt++;

    let polished = '';
    try {

      // 构造 prompt
      let currentPrompt: string;
      // 宠物名约束：只在系统指令中约束，不放入用户消息（避免被 AI 当正文输出）
      const petNameSystemNote = petNameConstraint
        ? ` | 宠物名铁律：全文宠物统一叫「${petNameConstraint.canonicalName}」，禁止换成其他名字。`
        : '';
      if (attempt === 1) {
        currentPrompt = `${langPrompt}\n\n${text}`;
      } else {
        // 重试时使用语言对应的 aggressive 模板
        const isEnglish = lang === 'en';
        const isChinese = lang === 'zh';
        const aggressivePrompt = isEnglish
          ? ANTI_AI_POLISH_PROMPT_AGGRESSIVE_TEMPLATE_EN
          : (isChinese ? ANTI_AI_POLISH_PROMPT_AGGRESSIVE_TEMPLATE_ZH : ANTI_AI_POLISH_PROMPT_AGGRESSIVE_TEMPLATE_ZH);
        currentPrompt = `${aggressivePrompt}\n\n${text}`;
      }

      const isEnglish = lang === 'en';
      // 强化版指令：明确禁止删除任何内容，必须完整保留原文所有句子
      const preserveMandatory = '【强制要求】禁止删除任何句子！原文有多少句，输出必须保留多少句！禁止缩写、禁止合并、禁止省略！';
      const systemInstruction = attempt === 1
        ? (
          isEnglish
            ? `${preserveMandatory} You are a content de-AI editor. Rewrite to sound human: (1) Replace formal AI template words with natural ones. (2) Vary sentence structure — mix long and short sentences. (3) Add spoken markers: "honestly", "you know", "I mean", "actually", "well", "basically". (4) NEVER delete content. Keep ALL original sentences. Length must be ≥ original length.` + (petNameConstraint ? ` | 宠物名铁律：全文宠物统一叫「${petNameConstraint.canonicalName}」，禁止换成其他名字。` : '')
            : `${preserveMandatory} 你是内容去AI味编辑。重写文本使其更有人味：(1) 替换正式AI模板词为自然词。(2) 变化句式——混合长短句。(3) 添加口语词。(4) 禁止删除任何内容！必须保留原文所有句子！输出字数必须 ≥ 原文字数！` + (petNameConstraint ? ` | 宠物名铁律：全文宠物统一叫「${petNameConstraint.canonicalName}」，禁止换成其他名字。` : '')
        )
        : (
          isEnglish
            ? `${preserveMandatory} Deep rewrite editor: (1) Replace all formal words. (2) Vary sentence structure significantly. (3) Add at least 5 colloquial markers. (4) NEVER delete any content — EVERY sentence from the original MUST appear in the output. Output must be ≥ original length.` + (petNameConstraint ? ` | 宠物名铁律：全文宠物统一叫「${petNameConstraint.canonicalName}」，禁止换成其他名字。` : '')
            : `${preserveMandatory} 深度重写编辑：(1) 替换所有模板词。(2) 显著变化句式。(3) 添加口语词。(4) 禁止删除任何内容——原文每个句子都必须保留在输出中！输出字数必须 ≥ 原文字数！` + (petNameConstraint ? ` | 宠物名铁律：全文宠物统一叫「${petNameConstraint.canonicalName}」，禁止换成其他名字。` : '')
        );

      // 优先使用调用者传入的 maxTokens（已在 Tools.tsx 中用 calcMaxTokens 精确计算）
      // 若未传入，则使用基于输入长度的保守默认值
      const [modelNameFromArgs, existingOptions] = modelArgs as [string | undefined, { maxTokens?: number; [key: string]: unknown } | undefined];
      const callerMaxTokens = existingOptions?.maxTokens;
      const dynamicMaxTokens = Math.ceil(originalLen * 1.5) + 512;
      const effectiveMaxTokens = callerMaxTokens ?? dynamicMaxTokens;
      const mergedOptions = { ...existingOptions, maxTokens: effectiveMaxTokens };

      await streamContentGeneration(
        currentPrompt,
        systemInstruction,
        (chunk) => {
          polished += chunk;
          onChunk?.(polished);
        },
        modelNameFromArgs,
        mergedOptions
      );

      const result = (polished || '').trim();

      if (!result) {
        onLog?.(`[去AI味] 第${attempt}次返回空`);
        continue;
      }

      const polishedLen = result.replace(/\s+/g, '').length;

      // 评估效果（使用对应语言和赛道宽容度）
      const evaluation = evaluatePolishingEffectiveness(text, result, originalLen, polishedLen, lang, options.nicheType);

      onLog?.(`[去AI味] 第${attempt}次完成:`);
      onLog?.(`  - 模板词替换: ${(evaluation.templateReplaceRatio * 100).toFixed(1)}%`);
      onLog?.(`  - 口语词添加: ${evaluation.humanWordsAdded}/${evaluation.humanWordsTarget}`);
      onLog?.(`  - 句式变化: ${(evaluation.sentenceVariationRatio * 100).toFixed(1)}%`);
      onLog?.(`  - 长度变化: ${(evaluation.lengthChangeRatio * 100).toFixed(1)}%`);
      if (evaluation.reasons) {
        evaluation.reasons.forEach(r => onLog?.(`  - ${r}`));
      }

      // ===== 内容被删 = 拒绝结果，回退到原文 =====
      // 大国博弈/新闻：宽容阈值
      const isGreatPowerGame = options.nicheType === 'great_power_game';
      const isNews = options.nicheType === 'news';
      const deleteThreshold = isGreatPowerGame || isNews ? 0.5 : 0.3;
      const deleteRatioThreshold = isGreatPowerGame || isNews ? 0.6 : 0.7;
      if (evaluation.lengthChangeRatio > deleteThreshold || (polishedLen < originalLen * deleteRatioThreshold)) {
        onLog?.(`[去AI味] ❌ 内容被删除（长度变化${(evaluation.lengthChangeRatio * 100).toFixed(1)}%），回退到原文`);
        if (attempt >= MAX_RETRY) {
          // 大国博弈/新闻：回退到原文，保留原文（不要用缩短的结果）
          onLog?.(`[去AI味] ⚠️ 多次改写均删内容，保留原文，跳过去味清洗`);
          return {
            success: true,
            polishedText: text,
            isEffective: false,
            humanWordsAdded: 0,
            humanWordsTarget: evaluation.humanWordsTarget
          };
        }
        continue;
      }

      // 保存最佳结果（优先保留更完整的内容）
      // 规则：isEffective > 内容保留最多（polishedLen 越大越好）
      const shouldSaveAsBest = (() => {
        // 首次保存
        if (!bestResult) return true;
        // isEffective 的结果优先
        if (evaluation.isEffective && !bestEvaluation?.isEffective) return true;
        if (!evaluation.isEffective && bestEvaluation?.isEffective) return false;
        // 都无效时，优先保留内容最多的（polishedLen 越大越好，内容删减越少）
        // 注意：lengthChangeRatio 大意味着删减多，是坏事
        const currentKeptRatio = 1 - evaluation.lengthChangeRatio; // 保留比例，越大越好
        const bestKeptRatio = bestEvaluation ? (1 - bestEvaluation.lengthChangeRatio) : 0;
        return currentKeptRatio > bestKeptRatio;
      })();
      if (shouldSaveAsBest) {
        bestResult = result;
        bestEvaluation = evaluation;
        onLog?.(`[去AI味] 保存为候选结果: ${result.replace(/\s+/g, '').length} 字 (保留率 ${((1 - evaluation.lengthChangeRatio) * 100).toFixed(1)}%)`);
      }

      // 如果效果达标，接受结果
      if (evaluation.isEffective) {
        onLog?.(`[去AI味] ✅ 第${attempt}次改写达标`);
        return {
          success: true,
          polishedText: petNameConstraint ? enforcePetNameConstraint(result, petNameConstraint) : result,
          isEffective: true,
          humanWordsAdded: evaluation.humanWordsAdded,
          humanWordsTarget: evaluation.humanWordsTarget
        };
      }

      // 如果是最后一次，接受最佳结果
      if (attempt >= MAX_RETRY) {
        onLog?.(`[去AI味] 已达最大重试次数，当前最佳结果: ${bestResult ? bestResult.replace(/\s+/g, '').length + '字' : '无'}`);
        if (bestResult) {
          onLog?.(`[去AI味] 使用最佳结果`);
          return {
            success: true,
            polishedText: petNameConstraint ? enforcePetNameConstraint(bestResult, petNameConstraint) : bestResult,
            isEffective: false,
            humanWordsAdded: bestEvaluation?.humanWordsAdded ?? 0,
            humanWordsTarget: bestEvaluation?.humanWordsTarget ?? 0
          };
        }
        break;
      }

    } catch (error: any) {
      onLog?.(`[去AI味] 第${attempt}次失败: ${error.message || error}`);

      // 如果 API 报错但已有部分内容（503/网络错误时流式响应被截断），
      // 检查内容是否足够完整（大国博弈/新闻宽容至60%）
      const isGreatPowerGameError = options.nicheType === 'great_power_game';
      const isNewsError = options.nicheType === 'news';
      if (polished.trim()) {
        const partialLen = polished.replace(/\s+/g, '').length;
        const partialRatio = partialLen / originalLen;
        const partialThreshold = isGreatPowerGameError || isNewsError ? 0.6 : 0.7;
        onLog?.(`[去AI味] 第${attempt}次部分返回 ${partialLen}/${originalLen} 字 (${(partialRatio * 100).toFixed(1)}%)`);
        // 大国博弈/新闻宽容：内容≥60%完整即可保留为候选结果
        // 但不能覆盖已有的更好结果
        if (partialRatio >= partialThreshold) {
          const eval_ = evaluatePolishingEffectiveness(text, polished, originalLen, partialLen, lang, options.nicheType);
          // 只有当当前内容比已有结果更好时才覆盖
          const currentKeptRatio = 1 - eval_.lengthChangeRatio;
          const bestKeptRatio = bestEvaluation ? (1 - bestEvaluation.lengthChangeRatio) : 0;
          const currentBetterThanBest = !bestResult || 
            (eval_.isEffective && !bestEvaluation?.isEffective) ||
            (!eval_.isEffective && !bestEvaluation?.isEffective && currentKeptRatio > bestKeptRatio);
          if (currentBetterThanBest) {
            bestResult = polished.trim();
            bestEvaluation = eval_;
            onLog?.(`[去AI味] 第${attempt}次部分内容质量更优，保存为候选 (保留率 ${(currentKeptRatio * 100).toFixed(1)}%)`);
          }
        }
      }

      if (attempt >= MAX_RETRY) break;
    }
  }

  // 所有尝试都失败时：优先使用候选结果（部分完整的内容），否则回退到原文
  if (bestResult) {
    onLog?.(`[去AI味] 使用候选结果（${bestResult.replace(/\s+/g, '').length} 字）`);
    return {
      success: true,
      polishedText: petNameConstraint ? enforcePetNameConstraint(bestResult, petNameConstraint) : bestResult,
      isEffective: false,
      humanWordsAdded: bestEvaluation?.humanWordsAdded ?? 0,
      humanWordsTarget: bestEvaluation?.humanWordsTarget ?? 0
    };
  }

  return {
    success: false,
    polishedText: text,
    error: '去AI味清洗失败',
    isEffective: false,
    humanWordsAdded: 0,
    humanWordsTarget: 0
  };
}

/** 获取语言名称 */
function getLanguageName(lang: string): string {
  const langMap: Record<string, string> = {
    en: 'English',
    zh: '中文',
    ja: '日本語',
    ko: '한국어',
    es: 'Español',
    de: 'Deutsch',
    fr: 'Français',
    hi: 'हिन्दी',
  };
  return langMap[lang] || lang;
}

/**
 * 快速本地去AI味（不做复杂改写，只做基础清洗）
 */
export function quickLocalAntiAiPolish(text: string): string {
  let result = text;

  // 1. 替换常见 AI 模板词（不删除，只替换）
  const templateReplacements: Array<[string, string | string[]]> = [
    ['首先', '其实'],
    ['其次', '然后'],
    ['另外', '而且'],
    ['此外', '再说'],
    ['因此', '所以'],
    ['于是', '结果'],
    ['然而', '不过'],
    ['但是', '但'],
    ['总之', '说白了'],
    ['总而言之', '说到底'],
    ['综上所述', '说白了'],
    ['由此可见', '所以'],
    ['整体而言', '其实'],
    ['显而易见', '其实一眼就能看出来'],
    ['毫无疑问', '其实谁都看得出来'],
    ['毋庸置疑', '其实不用说'],
    ['值得注意的是', '其实'],
    ['需要指出的是', '其实'],
    ['不言而喻', '不用说都知道'],
    ['换句话说', '也就是说'],
    ['也就是说', '换句话说'],
    ['第一', '一个'],
    ['第二', '再一个'],
    ['第三', '还有一个'],
    ['一方面', '一方面来说'],
    ['另一方面', '另一方面来看'],
  ];

  for (const [from, to] of templateReplacements) {
    const toValue = Array.isArray(to) ? to[Math.floor(Math.random() * to.length)] : to;
    result = result.split(from).join(toValue);
  }

  // 2. 修复序号列表（去除格式前缀）
  result = result.replace(/^(\d+)[.、:：]\s*/gm, '');
  result = result.replace(/^([一二三四五六七八九十]+)[.、:：]\s*/gm, '');

  // 3. 清理多余空行
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}
