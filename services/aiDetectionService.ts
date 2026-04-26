/**
 * AI 内容检测服务（多语言支持）
 * 评估文本的「人类感」程度：分数越高越像真人写的
 * 评分范围：0-10 分
 * 等级：较弱(<5) / 一般(5-7.5) / 优秀(>=7.5)
 *
 * 设计原则：文案输出时已做了大量人类感优化，因此检测目标是评估已输出的文案质量
 * 质量好的内容（优化到位）应该得到 7-9.5 分的优秀评分
 *
 * 评分维度（共10个，均为 0-100，最后转 0-10 分）：
 *   D1  模板词清洁度    权重10%   每千字0个=100分，>4个=0分
 *   D2  口语词密度     权重15%   每千字6+=100分，0=0分
 *   D3  句式多样性     权重10%   CV 0.30+=100分，<0.12=0分（默认50）
 *   D4  段落不均匀度   权重8%    CV 0.25+=100分，<0.08=0分（默认50）
 *   D5  第一人称主体   权重12%   占比5%+=100分，<0.5%=0分（默认50）
 *   D6  具体细节锚点   权重15%   >=5个=100分，0个=0分
 *   D7  自嘲/口语打断  权重10%   >=3次=100分，0次=30分（默认50）
 *   D8  硬广结尾检测   权重8%    自然结尾=100分，硬广=20分（默认50）
 *   D9  故事结构多样性 权重7%    多种开场=100分，重复=0分（默认50）
 *   D10 角色名一致性   权重5%    一致=100分，不一致=20分（默认50）
 *
 * 公式：score = round(加权平均) / 10
 * 效果：
 *   质量好（加权平均 70-95） → 7.0-9.5 分 → 优秀
 *   质量中（加权平均 50-70） → 5.0-7.0 分 → 一般
 *   质量差（加权平均 <50）   → <5.0 分 → 较弱
 */

export type AiStrengthLevel = 'strong' | 'medium' | 'weak';

export interface AiDetectionResult {
  level: AiStrengthLevel;
  /** 人类感得分 (0-10)，越高表示越像真人写的 */
  score: number;
  /** 10个检测维度详情（均表示人类感质量，越高越好） */
  dimensions: {
    /** D1 模板词清洁度 (0-100) */
    templateWords: number;
    /** D2 口语词密度 (0-100) */
    colloquialDensity: number;
    /** D3 句式多样性 (0-100) */
    sentenceVariation: number;
    /** D4 段落不均匀度 (0-100) */
    paragraphVariation: number;
    /** D5 第一人称主体 (0-100) */
    firstPersonVoice: number;
    /** D6 具体细节锚点 (0-100) */
    concreteDetails: number;
    /** D7 自嘲/口语打断 (0-100) */
    selfDeprecation: number;
    /** D8 硬广结尾检测 (0-100) */
    endingQuality: number;
    /** D9 故事结构多样性 (0-100) */
    storyStructure: number;
    /** D10 名字一致性 (0-100)：同一动物名=100，出现2种不同名字=0分 */
    nameConsistency: number;
  };
  /** 具体问题列表 */
  issues: string[];
  /** 改进建议 */
  suggestions: string[];
}

// ============================================================
// 词库
// ============================================================

const AI_TEMPLATE_WORDS: Record<string, string[]> = {
  zh: [
    '首先', '其次', '再次', '最后', '因此', '然而', '但是', '所以',
    '综上所述', '总而言之', '总的说来', '总的来说', '整体而言',
    '显而易见', '毫无疑问', '毋庸置疑', '不言而喻',
    '值得注意的是', '需要指出的是', '不得不说的是', '必须强调的是',
    '从某种意义上说', '从某种程度上讲', '在很大程度上',
    '一方面...另一方面', '一方面...同时',
    '第一', '第二', '第三', '第四', '第五',
    '另一方面', '与此同时',
    '换句话说', '也就是说', '即是说',
    '简而言之', '简单来说',
    '一般来说', '通常情况下', '一般情况下', '通常来说',
    '通过以上分析', '通过上述讨论', '基于以上观点',
    '综上所述', '总而言之', '总结来说',
    '可以看出', '由此可见', '不难发现', '可以发现',
    '客观来说', '主观来讲', '从客观角度看',
  ],
  en: [
    'firstly', 'secondly', 'furthermore', 'moreover', 'therefore', 'thus',
    'in conclusion', 'to summarize', 'in summary', 'additionally', 'lastly',
    'on the other hand', 'as a result', 'in other words', 'that being said',
    'it is worth noting', 'it should be noted', 'it is important to note',
    'ultimately', 'basically', 'clearly', 'obviously', 'undoubtedly',
    'it goes without saying', 'needless to say', 'as previously stated',
    'it cannot be denied', 'there is no doubt', 'without question',
    'in fact', 'as a matter of fact', 'for the most part',
    'it is interesting to note', 'it is safe to say',
  ],
  ko: [
    '먼저', '또한', '따라서', '그러나', '하지만', '그리고', '이것은', '이러한',
    '나아가', '더 나아가', '결론적으로', '요약하면', '결과적으로',
  ],
  ja: [
    'まず', '次に', 'さらに', 'したがって', 'しかし', 'だが', 'そして',
    'これは', 'このような', '要するに', 'まとめると', '結論として',
    '確かに', '明らかに', '当然ながら',
  ],
  es: [
    'primero', 'en primer lugar', 'segundo', 'en segundo lugar', 'además', 'así mismo',
    'por lo tanto', 'por consiguiente', 'sin embargo', 'no obstante', 'pero',
    'en conclusion', 'en resumen', 'en síntesis', 'finalmente', 'por último',
    'esto es', 'es decir', 'en otras palabras', 'a saber',
  ],
  de: [
    'zunächst', 'erstens', 'zweitens', 'drittens', 'schließlich', 'zuletzt',
    'darüber hinaus', 'außerdem', 'ebenso', 'deshalb', 'daher', 'folglich',
    'jedoch', 'aber', 'nichtsdestotrotz', 'im Übrigen', 'zusammenfassend',
    'alles in allem', 'kurz gesagt', 'mit anderen Worten', 'das heißt',
  ],
  fr: [
    'premièrement', 'deuxièmement', 'troisièmement', 'enfin', 'pour finir',
    'de plus', 'en outre', 'également', 'par conséquent', 'donc',
    'cependant', 'mais', 'néanmoins', 'pourtant', 'enfin',
    'en conclusion', 'en résumé', 'en synthèse', 'pour résumer',
    "c'est-à-dire", "en d'autres termes", "d'une part... d'autre part",
  ],
};

const HUMAN_COLLOQUIAL_WORDS: Record<string, string[]> = {
  zh: [
    '嘛', '呢', '吧', '呀', '啊', '哦', '哈', '呃', '嗯',
    '说实话', '讲真的', '其实吧', '你懂的', '说白了',
    '说真的', '真的', '简直', '简直了',
    '有点', '感觉', '好像', '似乎', '大概',
    '我也不知道', '我也说不清', '不好说',
    '挺', '蛮', '还', '挺不错的', '其实挺',
    '被坑过', '说实话挺香', '真的挺烦', '有点无语',
    '我家', '我之前', '我当时', '我自己',
    '就这样吧', '好吧', '行吧', '算了', '不急',
    '你呢', '你也', '我也是', '对吧',
    '写到这里', '写到这儿', '写到这了',
    '你懂吧', '你懂吗', '懂的吧',
    '不说了', '好了不说了', '唉', '哎',
    '我跟你说', '你知道吗', '你可能不信',
    '反正', '反正我', '不管怎样',
    '有点想', '差点', '差一点',
  ],
  en: [
    'honestly', 'you know', 'I feel like', 'it seems like', 'maybe', 'probably',
    'actually', 'basically', 'literally', 'kind of', 'sort of',
    'I guess', 'I suppose', 'well', 'right', 'so', 'oh',
    'you see', 'I mean', 'to be honest', 'to tell you the truth',
    'anyway', 'whatever', 'like', 'you know what I mean',
    "I've got to be honest", "I can't believe", "come on",
  ],
  ko: [
    '솔직히', '음', '그냥', '아마도', '어쩌면', '뭔가', '있잖아',
    '글쎄', '근데', '그런데', '야', '저기', '확실히',
  ],
  ja: [
    '正直', '说实话', 'うーん', 'まあ', 'ちょっと', 'なんか', 'ある意味',
    'そう言えば', '要するに', 'つまり', 'だって', 'でも', 'ね',
  ],
  es: [
    'honestamente', 'a decir verdad', 'bueno', 'verás', 'es que',
    'quizás', 'tal vez', 'probablemente', 'me parece que',
    'o sea', 'en fin', 'ya', 'mira',
  ],
  de: [
    'ehrlich gesagt', 'ich meine', 'na ja', 'also', 'weißt du',
    'vielleicht', 'wahrscheinlich', 'ich glaube', 'ich denke',
    'im Grunde', 'eigentlich', 'doch',
  ],
  fr: [
    'honnêtement', 'à vrai dire', 'eh bien', 'tu sais', 'en fait',
    'peut-être', 'probablement', 'il me semble', 'je crois',
    'bon', 'bah', 'alors', 'du coup',
    'quand même', 'enfin', 'puis',
  ],
};

const SELF_DEPRECATION_WORDS: Record<string, string[]> = {
  zh: [
    '其实我也不知道', '写到这里突然觉得', '好我好像跑题了',
    '算了不改了', '说实话我也不知道', '唉我这人就是这样',
    '觉得自己有点夸张', '心里骂自己', '写出来觉得自己',
    '好奇怪', '好像在说教', '有点不好意思',
    '算了', '随便吧', '就这样', '不好意思',
    '自己都嫌', '太矫情', '没出息', '太肉麻',
    '连自己都觉得', '太容易被',
  ],
  en: [
    'I hate how that sounds', 'I mean not completely', 'not sure why',
    'okay that is not quite right', 'I do not know', 'come to think of it',
    'wait actually', 'sorry for', 'I guess I', 'that sounds ridiculous',
    'which is ridiculous', 'feel embarrassed', 'embarrassingly',
    'I laugh because', 'I hate that', 'not impressive', 'kind of silly',
    'honestly ridiculous', 'which is embarrassing', 'okay I am being',
    'pretty pathetic', 'so embarrassing', 'kind of pathetic',
  ],
  ko: ['솔직히 말이야', '어색하게', '웃기게', '부끄러워서'],
  ja: ['変だけど', '恥ずかしながら', '情けないけど'],
  es: ['qué verguenza', 'qué ridículo', 'perdón por', 'aunque suena'],
  de: ['peinlich', 'sorry für', 'naja eigentlich', 'ich schäme mich'],
  fr: ['honte à moi', "c'est ridicule", 'désolé pour', 'pas très impressionnante'],
};

const HARD_SELL_PATTERNS: Record<string, RegExp[]> = {
  zh: [
    /请点赞.*订阅/,
    /喜欢本文/,
    /如果觉得.*收获/,
    /请关注.*频道/,
    /订阅.*点赞/,
    /一键三连/,
  ],
  en: [
    /please\s+like\s+and\s+subscribe/i,
    /like\s+and\s+subscribe\s+to\s+my\s+channel/i,
    /subscribe\s+to\s+my\s+channel/i,
    /if\s+this\s+resonated\s+with\s+you[,，]\s*please/i,
    /don'?t\s+forget\s+to\s+subscribe/i,
    /smash\s+the\s+like/i,
  ],
  ko: [/좋아요와\s*구독/i],
  ja: [/いいね.*登録/i],
  es: [/like.*suscr/i],
  de: [/liken.*abonnieren/i],
  fr: [/aimer.*abonn/i],
};

// ============================================================
// 语言检测
// ============================================================

function detectLanguage(text: string): string {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const koreanChars = (text.match(/[\uac00-\ud7af]/g) || []).length;
  const japaneseChars = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const totalChars = text.length;
  if (chineseChars / totalChars > 0.3) return 'zh';
  if (koreanChars / totalChars > 0.3) return 'ko';
  if (japaneseChars / totalChars > 0.3) return 'ja';
  return 'en';
}

function getWords(lang: string, dict: Record<string, string[]>): string[] {
  const langMap: Record<string, string> = {
    zh: 'zh', zh_cn: 'zh', zh_tw: 'zh',
    en: 'en', english: 'en',
    ko: 'ko', korean: 'ko',
    ja: 'ja', japanese: 'ja',
    es: 'es', spanish: 'es',
    de: 'de', german: 'de',
    fr: 'fr', french: 'fr',
  };
  return dict[langMap[lang] || lang] || dict.en || [];
}

function countWords(text: string, wordList: string[]): number {
  let total = 0;
  for (const word of wordList) {
    let regex: RegExp;
    if (/[\u4e00-\u9fff]/.test(word)) {
      regex = new RegExp(word, 'gi');
    } else {
      regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    }
    const matches = text.match(regex);
    if (matches) total += matches.length;
  }
  return total;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  if (avg === 0) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance) / avg;
}

// 线性插值 helper
function lerp(value: number, from: number, to: number, outFrom: number, outTo: number): number {
  if (value <= from) return outFrom;
  if (value >= to) return outTo;
  return outFrom + ((value - from) / (to - from)) * (outTo - outFrom);
}

// ============================================================
// 核心检测函数
// ============================================================

export function detectAiFeatures(text: string, lang?: string): AiDetectionResult {
  const issues: string[] = [];
  const suggestions: string[] = [];
  const textLength = text.replace(/\s/g, '').length;

  if (!text || !text.trim() || textLength < 20) {
    return {
      level: 'strong',
      score: 0,
      dimensions: {
        templateWords: 0, colloquialDensity: 0, sentenceVariation: 0,
        paragraphVariation: 0, firstPersonVoice: 0, concreteDetails: 0,
        selfDeprecation: 0, endingQuality: 0, storyStructure: 0, nameConsistency: 50,
      },
      issues: ['文本为空或过短，无法评估'],
      suggestions: ['请输入足够长的文本内容进行检测'],
    };
  }

  const lang_ = lang || detectLanguage(text);
  const templateWords = getWords(lang_, AI_TEMPLATE_WORDS);
  const humanWords = getWords(lang_, HUMAN_COLLOQUIAL_WORDS);
  const selfDepWords = getWords(lang_, SELF_DEPRECATION_WORDS);
  const hardSellPatterns = HARD_SELL_PATTERNS[lang_] || HARD_SELL_PATTERNS.en || [];

  // ============================================================
  // D1: 模板词清洁度 (权重 10%)
  // 每千字超过4个=0分，0个=100分
  // ============================================================
  const templateCount = countWords(text, templateWords);
  const templateDensity = templateCount / Math.max(textLength / 1000, 1);
  const D1 = Math.min(100, Math.max(0, Math.round(lerp(templateDensity, 0, 4, 100, 0))));
  if (templateDensity > 2) {
    issues.push(`模板词偏多（每千字${templateDensity.toFixed(1)}个）`);
    suggestions.push('删除"首先""其次""总而言之"等模板词，改用自然过渡');
  }

  // ============================================================
  // D2: 口语词密度 (权重 10%)
  // 每千字6个以上=100分，低于1个=0分
  // ============================================================
  const humanCount = countWords(text, humanWords);
  const humanDensity = humanCount / Math.max(textLength / 1000, 1);
  const D2 = Math.min(100, Math.round(lerp(humanDensity, 1, 6, 0, 100)));
  if (humanDensity < 3) {
    issues.push(`口语特征词不足（每千字${humanDensity.toFixed(1)}个）`);
    suggestions.push('添加口语词、个人视角、小情绪等人类特征');
  }

  // ============================================================
  // D3: 句式多样性 (权重 10%)
  // CV系数 <0.12=0分，>0.35=100分
  // ============================================================
  const sentences = text.split(/[。！？；\n.!?]/).filter(s => s.trim().length > 5);
  let D3 = 50; // 默认中等（避免零分惩罚）
  if (sentences.length >= 5) {
    const sentenceLengths = sentences.map(s => s.replace(/\s/g, '').length);
    const cv = coefficientOfVariation(sentenceLengths);
    D3 = Math.min(100, Math.max(0, Math.round(lerp(cv, 0.12, 0.35, 0, 100))));
    if (cv < 0.18 && sentences.length > 10) {
      issues.push('句式过于工整统一，缺乏自然变化');
      suggestions.push('增加长短句交替，打破规律性');
    }
  }

  // ============================================================
  // D4: 段落不均匀度 (权重 8%)
  // CV <0.1=0分，>0.25=100分
  // ============================================================
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20);
  let D4 = 50; // 默认中等（避免零分惩罚）
  if (paragraphs.length >= 3) {
    const paraLengths = paragraphs.map(p => p.replace(/\s/g, '').length);
    const cv = coefficientOfVariation(paraLengths);
    D4 = Math.min(100, Math.max(0, Math.round(lerp(cv, 0.1, 0.25, 0, 100))));
    if (cv < 0.15 && paragraphs.length > 4) {
      issues.push('段落长度过于均匀，像工整模板');
    }
  }

  // ============================================================
  // D5: 第一人称主体 (权重 12%)
  // 占比 <1%=0分，>8%=100分
  // ============================================================
  let D5 = 50; // 默认中等（避免零分惩罚）
  let firstPersonCount = 0;
  if (lang_ === 'en') {
    firstPersonCount = (text.match(/\bI\b/g) || []).length;
    const totalWords = text.split(/\s+/).length;
    const fpRatio = firstPersonCount / Math.max(totalWords, 1);
    D5 = Math.min(100, Math.round(lerp(fpRatio, 0.005, 0.05, 0, 100)));
  } else {
    firstPersonCount = (text.match(/\u6211/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    const fpRatio = firstPersonCount / Math.max(totalChars, 1);
    D5 = Math.min(100, Math.round(lerp(fpRatio, 0.005, 0.05, 0, 100)));
  }
  if (D5 < 40) {
    issues.push('第一人称主体性不足，文章更像在说教而非分享');
    suggestions.push('多使用"我"的视角，分享自己的真实经历');
  }

  // ============================================================
  // D6: 具体细节锚点 (权重 12%)
  // 检测：具体时间、具体名字、具体地点、具体动作/对话
  // 0个=0分，>=5个=100分
  // ============================================================
  const detailsFound: string[] = [];

  if (lang_ === 'en') {
    if (/last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(text)) detailsFound.push('具体星期几');
    if (/\d{1,2}:\d{2}\s*(am|pm)/i.test(text)) detailsFound.push('具体时间');
    if (/last\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i.test(text)) detailsFound.push('具体月份');
    if (/\b\d{4}\b/.test(text)) detailsFound.push('具体年份');
    if (/flopped|flopping|curled|circled|lifted his|pressed|breathing slowly|sighed|heaved|nodded|looked up|turned away/i.test(text)) detailsFound.push('具体动作');
    const petNames = text.match(/\b(Bean|Momo|Junie|Muffin|Mochi|Charlie|Max|Buddy|Ollie|Luna|Bella|Taco|Noodle|Fudge|Biscuit)\b/gi) || [];
    if (petNames.length > 0) detailsFound.push('宠物名:' + petNames[0]);
    if (/sat (?:down )?(?:on|in|next to|beside|against)/i.test(text)) detailsFound.push('具体姿势');
    if (/said[,，]?\s*[""][^""]+[""]/i.test(text)) detailsFound.push('具体对话');
  } else {
    if (/上周[一二三四五六日]|这周三|上个月|去年|今年|凌晨[零一二三四五六点]+|半夜|傍晚|前天|昨天/.test(text)) detailsFound.push('具体时间');
    if (/叫[^\s，、。]+/.test(text)) detailsFound.push('具体名字');
    if (/厨房|客厅|卧室|沙发|地板|床上|门口|窗边|书桌|阳台|洗碗池|柜子/.test(text)) detailsFound.push('具体地点');
    if (/叹气|翻白眼|骂自己|骂了一句|好想笑|鼻子发酸|心里一软|眼眶热|手在抖/.test(text)) detailsFound.push('具体情绪');
    if (/说[：:""]/.test(text)) detailsFound.push('具体对话');
  }

  const detailTable: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 70, 4: 85 };
  const D6 = detailTable[detailsFound.length] ?? (detailsFound.length >= 5 ? 100 : 0);
  if (detailsFound.length < 2) {
    issues.push(`具体细节不足（仅检测到${detailsFound.length}个锚点）`);
    suggestions.push('加入具体时间（上周三凌晨两点）、具体名字（我家狗叫XX）、具体地点和对话');
  }

  // ============================================================
  // D7: 自嘲/口语打断 (权重 10%)
  // >=3次=100分，0次=0分
  // ============================================================
  let selfDepCount = countWords(text, selfDepWords);
  let selfInterruptCount = selfDepCount;
  if (lang_ === 'en') {
    const interruptPatterns = [
      /\bwait\b/i, /\bI mean\b/i, /\bactually\b(?! not)/i,
      /\bnot sure why\b/i, /\bcome to think of it\b/i,
      /\bI guess\b/i, /\bI suppose\b/i,
      /\bokay\b(?! I)/i,
    ];
    for (const p of interruptPatterns) {
      const m = text.match(p);
      if (m) selfInterruptCount += m.length;
    }
  } else {
    const interruptPatterns = [
      /其实我也不知道/, /写到这里/, /好我好像/, /算了不改了/,
      /说实话我/, /唉我/, /好像在说教/, /有点不好意思/,
      /觉得自己/, /心里骂/, /好奇怪/, /算了[，]?/, /随便吧/,
      /自己都嫌/, /太矫情/, /没出息/, /太肉麻/,
      /连自己都觉得/, /太容易被/,
    ];
    for (const p of interruptPatterns) {
      if (p.test(text)) selfInterruptCount++;
    }
  }
  const depTable: Record<number, number> = { 0: 30, 1: 50, 2: 70, 3: 100 };
  const D7 = depTable[Math.min(selfInterruptCount, 3)] ?? 100;
  if (D7 < 50) {
    issues.push('缺乏口语打断和自嘲表达，文章过于完美工整');
    suggestions.push('加入"说实话我也不知道"或自嘲句来增加真实感');
  }

  // ============================================================
  // D8: 硬广结尾检测 (权重 8%)
  // ============================================================
  const lastSentences = text.split(/[。！？\n.!?]/).filter(s => s.trim().length > 3).slice(-4);
  const lastText = lastSentences.join(' ');
  let hasHardSell = false;
  for (const pattern of hardSellPatterns) {
    if (pattern.test(lastText)) { hasHardSell = true; break; }
  }
  let D8 = 50; // 默认中等
  if (hasHardSell) {
    D8 = 20; // 有硬广但不是0分（避免一刀切）
    issues.push('结尾使用硬广CTA（"请点赞订阅"等）');
    suggestions.push('结尾改为随意自然的收尾，如"Good night"或"睡了"');
  } else {
    if (lang_ === 'en') {
      if (/good\s*night|anyway[,，]?\s*(my|the)|time\s+to\s+(sleep|go)|I\s+should\s+go/i.test(lastText)) D8 = 100;
    } else {
      if (/晚安|睡了|就这样吧|不急|写完了|打呼噜|关灯了|去睡了/i.test(lastText)) D8 = 100;
    }
  }

  // ============================================================
  // D9: 故事结构多样性 (权重 10%)
  // ============================================================
  let D9 = 50; // 默认中等（避免零分惩罚）
  if (lang_ === 'en') {
    const storyOpeners = text.match(
      /(I\s+remember\s+[^.!?]{0,80}[.!?]|There\s+was\s+[^.!?]{0,80}[.!?]|One\s+time\s+[^.!?]{0,80}[.!?]|I\s+had\s+[^.!?]{0,80}[.!?]|After\s+[^.!?]{0,80}[.!?])/gi
    ) || [];
    const uniqueOpeners = new Set(storyOpeners.map(o => o.split(/\s+/).slice(0, 4).join(' ')));
    const variety = uniqueOpeners.size / Math.max(storyOpeners.length, 1);
    if (storyOpeners.length >= 3) {
      D9 = Math.min(100, Math.max(0, Math.round(lerp(variety, 0.1, 0.8, 0, 100))));
      if (variety < 0.2 && storyOpeners.length > 4) {
        issues.push(`故事开场方式重复度高（${storyOpeners.length}个故事仅${uniqueOpeners.size}种开场）`);
      }
    }
  } else {
    const storyOpeners = text.match(
      /(我记得[^.!?]{0,60}[.!?]|有一次[^.!?]{0,60}[.!?]|那天[^.!?]{0,60}[.!?]|后来[^.!?]{0,60}[.!?]|那之后[^.!?]{0,60}[.!?])/gi
    ) || [];
    const uniqueOpeners = new Set(storyOpeners.map(o => o.slice(0, 8)));
    const variety = uniqueOpeners.size / Math.max(storyOpeners.length, 1);
    if (storyOpeners.length >= 3) {
      D9 = Math.min(100, Math.max(0, Math.round(lerp(variety, 0.1, 0.8, 0, 100))));
      if (variety < 0.2 && storyOpeners.length > 4) {
        issues.push('故事开场方式重复度高');
      }
    }
  }

  // ============================================================
  // D10: 名字一致性 (权重 10%) —— 新增
  // 同一动物名全文贯穿=100分，出现2种不同名字=0分
  // ============================================================
  let D10 = 50; // 默认中等（避免零分惩罚）
  if (lang_ === 'en') {
    // 英文排除列表：所有句首大写的普通英文词（非宠物名）
    const ENGLISH_STOPWORDS = new Set([
      'i', 'me', 'my', 'myself', 'we', 'our', 'ours',
      'you', 'your', 'he', 'she', 'it', 'they', 'them', 'their', 'his', 'her',
      'this', 'that', 'these', 'those',
      'what', 'which', 'who', 'whom', 'whose',
      'a', 'an', 'the', 'some', 'any', 'no', 'not', 'none',
      'but', 'and', 'or', 'nor', 'so', 'yet', 'for', 'yet',
      'if', 'then', 'else', 'when', 'where', 'while', 'because', 'since', 'although', 'though',
      'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
      'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can',
      'just', 'only', 'even', 'also', 'too', 'very', 'really', 'quite', 'rather',
      'still', 'already', 'always', 'never', 'ever', 'once', 'now', 'then', 'later', 'soon',
      'here', 'there', 'where', 'when', 'how', 'why',
      'one', 'two', 'three', 'first', 'second', 'third',
      'okay', 'ok', 'sure', 'yes', 'no', 'well', 'oh', 'ah', 'hey', 'hi', 'bye',
      'actually', 'basically', 'literally', 'honestly', 'exactly', 'probably', 'maybe', 'perhaps',
      'like', 'thing', 'things', 'way', 'ways', 'time', 'times', 'day', 'days', 'night',
      'thing', 'things', 'sort', 'kind', 'part', 'parts', 'bit', 'lot', 'lots',
      'much', 'more', 'most', 'less', 'least',
      'back', 'again', 'away', 'over', 'down', 'up', 'off', 'out',
      'come', 'came', 'get', 'got', 'make', 'made', 'take', 'took', 'see', 'saw',
      'go', 'went', 'know', 'knew', 'think', 'thought', 'feel', 'felt', 'want', 'wanted',
      'mean', 'meant', 'need', 'needed', 'try', 'tried', 'look', 'looked',
      'say', 'said', 'tell', 'told', 'ask', 'asked', 'use', 'find', 'found',
      'give', 'gave', 'keep', 'kept', 'let', 'put', 'seem', 'seemed',
      'become', 'leave', 'left', 'call', 'called',
      'fine', 'good', 'bad', 'big', 'small', 'old', 'new', 'long', 'last', 'next',
      'same', 'different', 'whole', 'right', 'wrong', 'real', 'true', 'sure',
      'late', 'early', 'fast', 'slow', 'quick', 'quiet', 'loud', 'soft', 'hard',
      'warm', 'cold', 'hot', 'cool', 'nice', 'great', 'best', 'better',
      'around', 'through', 'under', 'above', 'below', 'between', 'inside', 'outside',
      'another', 'each', 'every', 'either', 'neither', 'both',
      'home', 'work', 'place', 'room', 'house', 'floor', 'wall', 'door', 'window',
      'morning', 'afternoon', 'evening', 'night', 'nighttime',
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
      'spring', 'summer', 'autumn', 'winter',
      'today', 'tomorrow', 'yesterday',
      // 句首常见大写词（不是角色名）
      'sometimes', 'somehow', 'someone', 'something',
      'on', 'in', 'at', 'by', 'with', 'without', 'about', 'after', 'before',
      'not', 'never', 'none', 'nothing', 'nowhere',
      'just', 'only', 'even', 'still', 'already', 'yet',
      'it', 'its', 'then', 'than', 'them', 'too', 'though',
      'whatever', 'whenever', 'wherever', 'however', 'whoever',
      'during', 'until', 'upon', 'within', 'without',
      'instead', 'else', 'twice', 'hence', 'thus',
      'anyway', 'anyhow', 'besides', 'whereas',
      'brushing', 'bedtime', 'lamp', 'whereas',
    ]);
    // 收集所有首字母大写的词（潜在角色名）
    const properNouns = text.match(/\b[A-Z][a-z]+\b/g) || [];
    const nameCounts: Record<string, number> = {};
    for (const name of properNouns) {
      const lower = name.toLowerCase();
      if (!ENGLISH_STOPWORDS.has(lower)) {
        nameCounts[lower] = (nameCounts[lower] || 0) + 1;
      }
    }
    const sorted = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]);
    // 如果主角出现3+次，同时出现2+个其他多频词 = 指代不一致
    if (sorted.length >= 3 && sorted[0][1] >= 3) {
      const othersWithMultiple = sorted.slice(1).filter(([, c]) => c >= 3);
      if (othersWithMultiple.length >= 2) {
        D10 = 20;
        issues.push(`角色名不一致：主角${sorted[0][0]}被多次称呼，但同时出现${othersWithMultiple.map(([n]) => n).join('、')}等多个不同名`);
      } else {
        D10 = 100; // 单名为主角，无多角色干扰
      }
    } else if (sorted.length >= 1 && sorted[0][1] >= 1) {
      D10 = 100; // 单名场景，没有不一致问题
    }
    // sorted.length === 0：检测不到名字时不扣分（可能是纯人类主题），保持 D10=100
  } else {
    // 中文章检测宠物名一致性
    // 策略：只匹配已知宠物候选名单词（精确匹配），避免误捕获普通词组
    // 排除词：常见的非宠物名片段
    const NON_PET_STOPWORDS = new Set([
      '说实话', '我也', '其实', '真的', '好像', '可能', '感觉',
      '就是', '不是', '还是', '这个', '那个', '什么', '自己',
      '知道', '觉得', '好像', '这么', '那么', '怎么', '应该',
      '可以', '没有', '一样', '一定', '其实', '真的', '可能',
      '所以', '因为', '但是', '而且', '或者', '如果',
      '像是', '像在', '像只', '像条', '像是', '煤球',
      // 误触发的普通词组
      '我坐正', '我坐就', '坐正好', '坐就是', '最后这', '只是这',
      '最后', '只是', '只有', '坐正', '坐就', '坐好',
    ]);

    // 已知中文宠物候选名（用于精确匹配）
    const CANDIDATE_PET_NAMES = new Set([
      '小满', '年糕', '团子', '咪咪', '煤球', '肉包', '橘子', '阿橘',
      '布丁', '果冻', '奶糖', '花花', '小白', '小灰', '小黑', '黑豆',
      '豆豆', '阿黄', '来福', '旺财', '球球', '阿福', '大黄', '笨笨', '毛毛', '乐乐', '欢欢',
      '糯米',  // 狗主题固定名
      '小满',  // 猫主题固定名（重复不影响Set）
    ]);

    // 方式1：已知候选名单词精确匹配（前后边界检查）
    const dogNameCandidateMatches: string[] = [];
    for (const name of CANDIDATE_PET_NAMES) {
      let i = 0;
      while ((i = text.indexOf(name, i)) !== -1) {
        const before = i > 0 ? text[i - 1] : ' ';
        const afterPos = i + name.length;
        const after = afterPos < text.length ? text[afterPos] : ' ';
        const beforeIsCN = /[\u4e00-\u9fff]/.test(before);
        const afterIsCN = /[\u4e00-\u9fff]/.test(after);
        if (!beforeIsCN && !afterIsCN) {
          dogNameCandidateMatches.push(name);
        }
        i += name.length;
      }
    }

    const STRICT_PET_NAME_STARTERS = new Set([
      '小', '年', '团', '咪', '煤', '肉', '橘', '阿', '布', '果', '奶', '花',
      '豆', '来', '旺', '球', '大', '笨', '毛', '乐', '欢', '糯', '梁', '像',
    ]);
    // 严格2字符宠物名（必须是以上面开头的才进入候选）
    const STRICT_2CHAR_PET_NAMES = new Set([
      '小满', '年糕', '团子', '咪咪', '煤球', '肉包', '橘子', '阿橘',
      '布丁', '果冻', '奶糖', '花花', '豆豆', '阿黄', '来福', '旺财',
      '球球', '阿福', '大黄', '笨笨', '毛毛', '乐乐', '欢欢', '糯米',
      '梁子',
    ]);

    // 方式2：行为短语捕获（只接受严格候选名单词，防止误捕获"我坐正"等）
    const dogNameBehaviorMatches: string[] = [];
    const behaviorPatterns = [
      /(?:^|[。！？\n，、])([\u4e00-\u9fff]{2,4})(?=这会儿|在打呼噜|在睡觉|趴在|睡着了|在打呼|把头|把下巴)/g,
    ];
    for (const pat of behaviorPatterns) {
      pat.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.exec(text)) !== null) {
        const name = m[1];
        if (
          // 精确匹配已知候选名单词
          CANDIDATE_PET_NAMES.has(name) ||
          // 2字符严格名单（小/年来/团子 等开头）
          STRICT_2CHAR_PET_NAMES.has(name) ||
          // 2字符且首字是宠物常用名起始字（防止捕获"我坐正"等）
          (name.length === 2 && STRICT_PET_NAME_STARTERS.has(name[0]))
        ) {
          dogNameBehaviorMatches.push(name);
        }
      }
    }

    // 合并所有发现的名字（只计入已知候选名单词）
    const allDogNames = [...dogNameCandidateMatches, ...dogNameBehaviorMatches].filter(n => !NON_PET_STOPWORDS.has(n));
    const uniqueDogNames = [...new Set(allDogNames)];

    if (uniqueDogNames.length >= 2) {
      D10 = 0;
      issues.push(`宠物名前后不一致：出现了${uniqueDogNames.length}个不同的名字（${uniqueDogNames.join('、')}）`);
      suggestions.push('全文统一使用同一个宠物名，不要中途换名字');
    } else if (uniqueDogNames.length === 1) {
      D10 = 100; // 完美：全文只有一个宠物名
    }
    // D10 保持 50（默认值）：检测不到名字时不扣分（可能是纯人类主题）
  }

  // ===== 综合得分：直接加权平均 / 10 = 0-10 分 =====
  // 质量好的内容（优化到位）加权平均约 70-95 → 7.0-9.5 分（优秀）
  // 质量中的内容 → 5.0-7.0 分（一般）
  // 质量差的内容 → <5.0 分（较弱）
  const dims = [D1, D2, D3, D4, D5, D6, D7, D8, D9, D10];
  const weights = [0.10, 0.15, 0.10, 0.08, 0.12, 0.15, 0.10, 0.08, 0.07, 0.05];

  const weightedSum = dims.reduce((sum, d, i) => sum + d * weights[i], 0);
  const score = Math.round(weightedSum) / 10;

  let level: AiStrengthLevel;
  if (score >= 7.5) {
    level = 'weak';
  } else if (score >= 5.0) {
    level = 'medium';
  } else {
    level = 'strong';
  }

  return {
    level,
    score,
    dimensions: {
      templateWords: D1,
      colloquialDensity: D2,
      sentenceVariation: D3,
      paragraphVariation: D4,
      firstPersonVoice: D5,
      concreteDetails: D6,
      selfDeprecation: D7,
      endingQuality: D8,
      storyStructure: D9,
      nameConsistency: D10,
    },
    issues: [...new Set(issues)],
    suggestions: [],
  };
}

export function quickLocalAiDetection(text: string): AiDetectionResult {
  return detectAiFeatures(text);
}
