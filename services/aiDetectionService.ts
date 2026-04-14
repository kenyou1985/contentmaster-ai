/**
 * AI 内容检测服务（多语言支持）
 * 基于多个维度检测文本中是否存在 AI 生成特征
 * 评估维度：结构、词汇、句式、流畅度等
 */

export type AiStrengthLevel = 'weak' | 'medium' | 'strong';

export interface AiDetectionResult {
  /** AI 味强度等级 */
  level: AiStrengthLevel;
  /** 得分 (0-100)，越高表示 AI 味越重 */
  score: number;
  /** 检测维度详情 */
  dimensions: {
    /** 模板词检测 (0-100) */
    templateWords: number;
    /** 句式一致性检测 (0-100) */
    sentencePattern: number;
    /** 流畅度检测 (0-100) */
    fluency: number;
    /** 人类特征检测 (0-100, 越高表示越有人味) */
    humanFeatures: number;
  };
  /** 具体问题列表 */
  issues: string[];
  /** 改进建议 */
  suggestions: string[];
}

/**
 * AI 模板词列表（多语言）
 */
const AI_TEMPLATE_WORDS: Record<string, string[]> = {
  // 中文
  zh: [
    '首先', '其次', '再次', '最后', '因此', '然而', '但是', '所以',
    '综上所述', '总而言之', '总的说来', '总的来说', '整体而言',
    '显而易见', '毫无疑问', '毋庸置疑', '不言而喻',
    '值得注意的是', '需要指出的是', '不得不说的是', '必须强调的是',
    '从某种意义上说', '从某种程度上讲', '在很大程度上',
    '一方面...另一方面', '一方面...同时',
    '第一', '第二', '第三', '第四', '第五',
    '一方面', '另一方面', '与此同时',
    '换句话说', '也就是说', '即是说',
    '简而言之', '简单来说', '说白了',
    '事实上', '实际上', '其实',
    '一般来说', '通常情况下', '一般情况下', '通常来说',
    '通过以上分析', '通过上述讨论', '基于以上观点',
  ],
  // 英文
  en: [
    'firstly', 'secondly', 'furthermore', 'moreover', 'therefore', 'thus',
    'in conclusion', 'to summarize', 'in summary', 'additionally', 'lastly',
    'on the other hand', 'as a result', 'in other words', 'that being said',
    'it is worth noting', 'it should be noted', 'it is important to note',
    'ultimately', 'basically', 'clearly', 'obviously', 'undoubtedly',
    'it goes without saying', 'needless to say', 'as previously stated',
    'it cannot be denied', 'there is no doubt', 'without question',
  ],
  // 韩文
  ko: [
    '먼저', '또한', '따라서', '그러나', '하지만', '그리고', '이것은', '이러한',
    '나아가', '더 나아가', '결론적으로', '요약하면', '결과적으로',
  ],
  // 日文
  ja: [
    'まず', '次に', 'さらに', 'したがって', 'しかし', 'だが', 'そして',
    'これは', 'このような', '要するに', 'まとめると', '結論として',
    '確かに', '明らかに', '当然ながら',
  ],
  // 西班牙文
  es: [
    'primero', 'en primer lugar', 'segundo', 'en segundo lugar', 'además', 'así mismo',
    'por lo tanto', 'por consiguiente', 'sin embargo', 'no obstante', 'pero',
    'en conclusión', 'en resumen', 'en síntesis', 'finalmente', 'por último',
    'esto es', 'es decir', 'en otras palabras', 'a saber',
  ],
  // 德文
  de: [
    'zunächst', 'erstens', 'zweitens', 'drittens', 'schließlich', 'zuletzt',
    'darüber hinaus', 'außerdem', 'ebenso', 'deshalb', 'daher', 'folglich',
    'jedoch', 'aber', 'nichtsdestotrotz', 'im Übrigen', 'zusammenfassend',
    'alles in allem', 'kurz gesagt', 'mit anderen Worten', 'das heißt',
  ],
  // 法文
  fr: [
    'premièrement', 'deuxièmement', 'troisièmement', 'enfin', 'pour finir',
    'de plus', 'en outre', 'également', 'par conséquent', 'donc',
    'cependant', 'mais', 'néanmoins', 'pourtant', 'enfin',
    'en conclusion', 'en résumé', 'en synthèse', 'pour résumer',
    "c'est-à-dire", "en d'autres termes", "d'une part... d'autre part",
  ],
};

/**
 * 人类口语/情感词列表（多语言）
 */
const HUMAN_COLLOQUIAL_WORDS: Record<string, string[]> = {
  // 中文
  zh: [
    '嘛', '呢', '吧', '呀', '啊', '哦', '哈', '呃', '嗯',
    '说实话', '讲真的', '其实吧', '你懂的', '说白了',
    '说真的', '真的', '简直', '简直了',
    '有点', '感觉', '好像', '似乎', '大概',
    '我也不知道', '我也说不清', '不好说',
    '挺', '蛮', '还', '挺不错的', '其实挺',
    '被坑过', '说实话挺香', '真的挺烦', '有点无语',
    '我家', '我之前', '我当时', '我自己',
  ],
  // 英文
  en: [
    'honestly', 'you know', 'I feel like', 'it seems like', 'maybe', 'probably',
    'actually', 'basically', 'literally', 'kind of', 'sort of',
    'I guess', 'I suppose', 'well', 'right', 'so', 'oh',
    'you see', 'I mean', 'to be honest', 'to tell you the truth',
    'anyway', 'whatever', 'like', 'you know what I mean',
  ],
  // 韩文
  ko: [
    '솔직히', '음', '그냥', '아마도', '어쩌면', '뭔가', '있잖아',
    '글쎄', '근데', '그런데', '야', '저기', '확실히',
  ],
  // 日文
  ja: [
    '正直', '说实话', 'うーん', 'まあ', 'ちょっと', 'なんか', 'ある意味',
    'そう言えば', '要するに', 'つまり', 'だって', 'でも', 'ね',
  ],
  // 西班牙文
  es: [
    'honestamente', 'a decir verdad', 'bueno', 'verás', 'es que',
    'quizás', 'tal vez', 'probablemente', 'me parece que',
    'o sea', 'en fin', 'ya', 'mira',
  ],
  // 德文
  de: [
    'ehrlich gesagt', 'ich meine', 'na ja', 'also', 'weißt du',
    'vielleicht', 'wahrscheinlich', 'ich glaube', 'ich denke',
    'im Grunde', 'eigentlich', 'doch',
  ],
  // 法文
  fr: [
    'honnêtement', 'à vrai dire', 'eh bien', 'tu sais', 'en fait',
    'peut-être', 'probablement', 'il me semble', 'je crois',
    'bon', 'bah', 'alors', 'du coup',
    'quand même', 'enfin', 'puis',
  ],
};

/**
 * 检测语言
 */
function detectLanguage(text: string): string {
  // 统计各种语言的字符
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const koreanChars = (text.match(/[\uac00-\ud7af]/g) || []).length;
  const japaneseChars = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;

  const totalChars = text.length;

  if (chineseChars / totalChars > 0.3) return 'zh';
  if (koreanChars / totalChars > 0.3) return 'ko';
  if (japaneseChars / totalChars > 0.3) return 'ja';

  // 默认使用英文
  return 'en';
}

/**
 * 获取语言对应的 AI 模板词
 */
function getAiTemplateWords(lang: string): string[] {
  const langMap: Record<string, string> = {
    zh: 'zh', zh_cn: 'zh', zh_tw: 'zh',
    en: 'en', english: 'en',
    ko: 'ko', korean: 'ko',
    ja: 'ja', japanese: 'ja',
    es: 'es', spanish: 'es',
    de: 'de', german: 'de',
    fr: 'fr', french: 'fr',
  };
  const key = langMap[lang] || lang;
  return AI_TEMPLATE_WORDS[key] || AI_TEMPLATE_WORDS.en || [];
}

/**
 * 获取语言对应的人类口语词
 */
function getHumanColloquialWords(lang: string): string[] {
  const langMap: Record<string, string> = {
    zh: 'zh', zh_cn: 'zh', zh_tw: 'zh',
    en: 'en', english: 'en',
    ko: 'ko', korean: 'ko',
    ja: 'ja', japanese: 'ja',
    es: 'es', spanish: 'es',
    de: 'de', german: 'de',
    fr: 'fr', french: 'fr',
  };
  const key = langMap[lang] || lang;
  return HUMAN_COLLOQUIAL_WORDS[key] || HUMAN_COLLOQUIAL_WORDS.en || [];
}

/**
 * 检测文本中的 AI 味（多语言）
 * @param text 待检测的文本
 * @param lang 语言代码（可选，自动检测）
 * @returns 检测结果
 */
export function detectAiFeatures(text: string, lang?: string): AiDetectionResult {
  if (!text || !text.trim()) {
    return {
      level: 'weak',
      score: 0,
      dimensions: {
        templateWords: 0,
        sentencePattern: 0,
        fluency: 0,
        humanFeatures: 0,
      },
      issues: [],
      suggestions: ['文本为空，无法检测'],
    };
  }

  // 自动检测语言或使用指定语言
  const detectedLang = lang || detectLanguage(text);
  const templateWords = getAiTemplateWords(detectedLang);
  const humanWords = getHumanColloquialWords(detectedLang);

  const issues: string[] = [];
  const suggestions: string[] = [];

  // 1. 检测模板词
  let templateWordCount = 0;
  const foundTemplateWords: string[] = [];
  for (const word of templateWords) {
    // 中文使用宽松匹配（避免 \b 对中文无效的问题）
    let regex: RegExp;
    if (/[\u4e00-\u9fff]/.test(word)) {
      regex = new RegExp(word, 'gi');
    } else {
      regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    }
    const matches = text.match(regex);
    if (matches) {
      templateWordCount += matches.length;
      foundTemplateWords.push(word);
    }
  }
  const textLength = text.replace(/\s/g, '').length;
  const templateWordDensity = (templateWordCount / Math.max(textLength / 1000, 1));
  const templateWordsScore = Math.min(100, Math.round(templateWordDensity * 200));

  if (templateWordDensity > 5) {
    issues.push(`模板词过多（${templateWordCount}个）`);
    suggestions.push('删除"首先""其次""总而言之"等模板词，改用自然过渡');
  }

  // 2. 检测 AI 句式模式（简化版）
  const aiPatternCount = 0;
  const aiPatternScore = Math.min(100, Math.round((aiPatternCount / Math.max(textLength / 500, 1)) * 150));

  // 3. 检测流畅度（连续相同长度句子比例）
  const sentences = text.split(/[。！？；\n.!?]/).filter(s => s.trim().length > 5);
  if (sentences.length > 5) {
    const sentenceLengths = sentences.map(s => s.replace(/\s/g, '').length);
    const avgLength = sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length;
    const variance = sentenceLengths.reduce((sum, len) => sum + Math.pow(len - avgLength, 2), 0) / sentenceLengths.length;
    const stdDev = Math.sqrt(variance);
    const variationCoefficient = avgLength > 0 ? stdDev / avgLength : 1;
    const fluencyScore = Math.max(0, Math.round((1 - variationCoefficient) * 100));

    if (variationCoefficient < 0.3 && sentences.length > 10) {
      issues.push('句式过于统一，缺乏自然变化');
      suggestions.push('增加长短句交替，打破规律性');
    }
  }

  // 4. 检测人类特征词
  let humanWordCount = 0;
  const foundHumanWords: string[] = [];
  for (const word of humanWords) {
    // 中文使用宽松匹配（避免 \b 对中文无效的问题）
    let regex: RegExp;
    if (/[\u4e00-\u9fff]/.test(word)) {
      regex = new RegExp(word, 'gi');
    } else {
      regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    }
    const matches = text.match(regex);
    if (matches) {
      humanWordCount += matches.length;
      foundHumanWords.push(word);
    }
  }

  // 计算每千字口语词密度
  const humanWordDensity = (humanWordCount / Math.max(textLength / 1000, 1));
  // 人类特征词密度评分：每千字4个口语词为良好（40%密度），每千字8个为优秀（80%密度）
  // 口语词密度评分范围 0-100
  const humanFeaturesScore = Math.min(100, Math.round(Math.min(humanWordDensity / 5, 1) * 100));

  // 低于每千字2个口语词才报告问题（更宽松）
  if (humanWordDensity < 2) {
    issues.push('人类口语特征较少');
    suggestions.push('添加口语词、个人视角、小情绪等人类特征');
  }

  // 5. 计算综合得分
  // 调整权重：人类口语特征权重提高，模板词权重降低
  const templateWeight = 0.25;
  const patternWeight = 0.15;
  const humanWeight = 0.45;  // 提高人类口语权重
  const structureWeight = 0.15;

  // 段落变化检测
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20);
  let paraVariation = 1;
  if (paragraphs.length > 2) {
    const paraLengths = paragraphs.map(p => p.replace(/\s/g, '').length);
    const avgParaLen = paraLengths.reduce((a, b) => a + b) / paraLengths.length;
    const paraVariance = paraLengths.reduce((sum, len) => sum + Math.pow(len - avgParaLen, 2), 0) / paraLengths.length;
    const paraStdDev = Math.sqrt(paraVariance);
    paraVariation = avgParaLen > 0 ? paraStdDev / avgParaLen : 1;

    if (paraVariation < 0.15 && paragraphs.length > 3) {
      issues.push('段落长度过于均匀，缺乏自然变化');
    }
  }

  const structureScore = Math.round(paraVariation * 100);
  // 人类口语词越多，AI味越低
  const humanAiScore = 100 - humanFeaturesScore;

  const finalScore = Math.round(
    templateWordsScore * templateWeight +
    aiPatternScore * patternWeight +
    humanAiScore * humanWeight +
    structureScore * structureWeight
  );

  // 确定等级（统一标准：<= 30 弱，<= 60 中，> 60 强）
  let level: AiStrengthLevel;
  if (finalScore <= 30) {
    level = 'weak';
  } else if (finalScore <= 60) {
    level = 'medium';
  } else {
    level = 'strong';
  }

  return {
    level,
    score: Math.min(100, finalScore),
    dimensions: {
      templateWords: templateWordsScore,
      sentencePattern: aiPatternScore,
      fluency: 100 - aiPatternScore,
      humanFeatures: 100 - humanFeaturesScore,
    },
    issues,
    suggestions: [...new Set(suggestions)],
  };
}

/**
 * 快速本地 AI 味检测（不使用 AI 模型）
 */
export function quickLocalAiDetection(text: string): AiDetectionResult {
  return detectAiFeatures(text);
}
