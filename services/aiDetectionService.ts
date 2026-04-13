/**
 * AI 内容检测服务
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
 * AI 高频模板词列表
 */
const AI_TEMPLATE_WORDS = [
  '首先', '其次', '再次', '最后', '因此', '然而', '但是', '所以',
  '综上所述', '总而言之', '总的说来', '总的来说', '整体而言',
  '显而易见', '毫无疑问', '毋庸置疑', '不言而喻',
  '值得注意的是', '需要指出的是', '不得不说的是', '必须强调的是',
  '从某种意义上说', '从某种程度上讲', '在很大程度上',
  '一方面...另一方面', '一方面...同时',
  '第一', '第二', '第三', '第四', '第五',
  '其一', '其二', '其三', '其四', '其五',
  '一方面', '另一方面', '与此同时',
  '换句话说', '也就是说', '即是说', '也就是说',
  '换言之', '简而言之', '简单来说', '说白了',
  '事实上', '实际上', '其实', '实际上',
  '一般来说', '通常情况下', '一般情况下', '通常来说',
  '正如所述', '如前所述', '如上所述', '由此可见',
  '通过以上分析', '通过上述讨论', '基于以上观点',
];

/**
 * 人类口语/情感词列表（越多表示越有人味）
 */
const HUMAN_COLLOQUIAL_WORDS = [
  '嘛', '呢', '吧', '呀', '啊', '哦', '哈', '呃', '嗯',
  '说实话', '讲真的', '其实吧', '你懂的', '说白了',
  '说实话', '说真的', '真的', '简直', '简直了',
  '有点', '感觉', '好像', '似乎', '大概',
  '我也不知道', '我也说不清', '不好说',
  '挺', '蛮', '还', '挺不错的', '其实挺',
  '被坑过', '说实话挺香', '真的挺烦', '有点无语',
  '我家', '我之前', '我当时', '我自己',
];

/**
 * AI 特征句式模式
 */
const AI_SENTENCE_PATTERNS = [
  /\b(重要的|关键的|显著的|有效的|优化|提升)\b/gi,
  /\b(赋能|抓手|闭环|布局|矩阵|生态)\b/gi,
  /^(首先|其次|再次|最后|第一|第二|第三)[,，]/gm,
  /[,，](首先|其次|再次|最后)[,，]/g,
  /\b(总而言之|综上所述|总的说来)/g,
  /\b(从某种意义上|从某种程度上)/g,
  /\b(一方面[，。,].{0,20}另一方面)/g,
  /\b(换句话说|也就是说)/g,
];

/**
 * 检测文本中的 AI 味
 * @param text 待检测的文本
 * @returns 检测结果
 */
export function detectAiFeatures(text: string): AiDetectionResult {
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

  const issues: string[] = [];
  const suggestions: string[] = [];

  // 1. 检测模板词
  let templateWordCount = 0;
  const foundTemplateWords: string[] = [];
  for (const word of AI_TEMPLATE_WORDS) {
    const regex = new RegExp(word, 'gi');
    const matches = text.match(regex);
    if (matches) {
      templateWordCount += matches.length;
      foundTemplateWords.push(word);
    }
  }
  // 归一化：每1000字超过5个模板词为高
  const textLength = text.replace(/\s/g, '').length;
  const templateWordDensity = (templateWordCount / Math.max(textLength / 1000, 1));
  const templateWordsScore = Math.min(100, Math.round(templateWordDensity * 200));

  if (templateWordDensity > 5) {
    issues.push(`模板词过多（${templateWordCount}个），包括：${foundTemplateWords.slice(0, 5).join('、')}...`);
    suggestions.push('删除"首先""其次""总而言之"等模板词，改用自然过渡');
  }

  // 2. 检测 AI 句式模式
  let aiPatternCount = 0;
  for (const pattern of AI_SENTENCE_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      aiPatternCount += matches.length;
    }
  }
  const aiPatternScore = Math.min(100, Math.round((aiPatternCount / Math.max(textLength / 500, 1)) * 150));

  if (aiPatternCount > 3) {
    issues.push(`AI 句式模式过多（${aiPatternCount}处）`);
    suggestions.push('避免使用"重要的""关键的""赋能"等 AI 高频词');
  }

  // 3. 检测流畅度（连续相同长度句子比例）
  const sentences = text.split(/[。！？；\n]/).filter(s => s.trim().length > 5);
  if (sentences.length > 5) {
    const sentenceLengths = sentences.map(s => s.replace(/\s/g, '').length);
    const avgLength = sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length;
    const variance = sentenceLengths.reduce((sum, len) => sum + Math.pow(len - avgLength, 2), 0) / sentenceLengths.length;
    const stdDev = Math.sqrt(variance);

    // 标准差越小，说明句子长度越一致，AI 可能性越高
    const variationCoefficient = avgLength > 0 ? stdDev / avgLength : 1;
    const fluencyScore = Math.max(0, Math.round((1 - variationCoefficient) * 100));

    if (variationCoefficient < 0.3 && sentences.length > 10) {
      issues.push(`句式过于统一（变异系数${variationCoefficient.toFixed(2)}），缺乏自然变化`);
      suggestions.push('增加长短句交替，打破规律性');
    }
  }

  // 4. 检测人类特征词
  let humanWordCount = 0;
  const foundHumanWords: string[] = [];
  for (const word of HUMAN_COLLOQUIAL_WORDS) {
    const regex = new RegExp(word, 'gi');
    const matches = text.match(regex);
    if (matches) {
      humanWordCount += matches.length;
      foundHumanWords.push(word);
    }
  }
  const humanWordDensity = (humanWordCount / Math.max(textLength / 1000, 1));
  // 人类特征词越多越好，反向计算（100 - 人类特征 = AI 味）
  const humanFeaturesScore = Math.min(100, Math.round((1 - Math.min(humanWordDensity / 3, 1)) * 100));

  if (humanWordDensity < 1) {
    issues.push('缺乏人类口语特征（无"嘛""其实""说实话"等）');
    suggestions.push('添加口语词、个人视角、小情绪等人类特征');
  }

  // 5. 检测段落结构（是否过于均匀）
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20);
  if (paragraphs.length > 2) {
    const paraLengths = paragraphs.map(p => p.replace(/\s/g, '').length);
    const avgParaLen = paraLengths.reduce((a, b) => a + b, 0) / paraLengths.length;
    const paraVariance = paraLengths.reduce((sum, len) => sum + Math.pow(len - avgParaLen, 2), 0) / paraLengths.length;
    const paraStdDev = Math.sqrt(paraVariance);
    const paraVariation = avgParaLen > 0 ? paraStdDev / avgParaLen : 1;

    if (paraVariation < 0.15 && paragraphs.length > 3) {
      issues.push('段落长度过于均匀，缺乏自然变化');
      suggestions.push('打破均匀段落，长短段落交替');
    }
  }

  // 6. 计算综合得分 (0-100，越高 AI 味越重)
  const templateWeight = 0.3;
  const patternWeight = 0.25;
  const humanWeight = 0.35;
  const structureWeight = 0.1;

  const finalScore = Math.round(
    templateWordsScore * templateWeight +
    aiPatternScore * patternWeight +
    humanFeaturesScore * humanWeight +
    (100 - Math.round(paraVariation * 100)) * structureWeight
  );

  // 确定等级
  let level: AiStrengthLevel;
  if (finalScore < 30) {
    level = 'weak';
  } else if (finalScore < 60) {
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
