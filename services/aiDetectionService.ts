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
 *   D1  模板词清洁度    权重10%   每千字0个=100分，>4个=0分（倪海厦赛道：>8个=0分）
 *   D2  口语词密度     权重15%   每千字6+=100分，0=0分
 *   D3  句式多样性     权重10%   CV 0.30+=100分，<0.12=0分（默认50）
 *   D4  段落不均匀度   权重8%    CV 0.25+=100分，<0.08=0分（默认50）
 *   D5  第一人称主体   权重12%   占比5%+=100分，<0.5%=0分（默认50）
 *   D6  具体细节锚点   权重15%   >=5个=100分，0个=0分
 *   D7  自嘲/口语打断  权重10%   >=3次=100分，0次=30分（默认50）
 *   D8  硬广结尾检测   权重8%    自然结尾=100分，硬广=20分（默认50）
 *   D9  故事结构多样性 权重7%    多种开场=100分，重复=0分（默认80，宽容处理）
 *   D10 角色名一致性   权重5%    一致=100分，不一致=20分（默认80，宽容处理）
 *
 * 赛道权重调整：
 *   新闻热点/小美赛道：D5权重降至5%，D6权重降至8%，D7权重降至5%，D2权重提至18%
 *   治愈心理学赛道：D10权重提至10%（宠物名一致性更重要）
 *   大国博弈/Bo Yi赛道：D5权重3%，D6权重5%，D7权重8%，D9权重35%；D1/D3/D4默认50分，D6/D7/D9/D10默认80分
 *   金融投资/芒格赛道：D2/D9/D10默认80分（分析型内容宽容处理）；D1/D3/D4默认50分
 *
 * 公式：score = round(加权平均) / 10
 * 效果：
 *   质量好（加权平均 70-95） → 7.0-9.5 分 → 优秀
 *   质量中（加权平均 50-70） → 5.0-7.0 分 → 一般
 *   质量差（加权平均 <50）   → <5.0 分 → 较弱
 */

export type AiStrengthLevel = 'strong' | 'medium' | 'weak';

/** 赛道类型，用于评分权重调整（共10个赛道） */
export type NicheTypeForScoring = 
  | 'tcm_metaphysics'    // 中医玄学/倪海厦
  | 'finance_crypto'     // 金融投资/芒格
  | 'psychology'         // 心理学/Awake Mentor
  | 'philosophy_wisdom'   // 哲学智慧/禅意
  | 'emotion_taboo'      // 情感禁忌/Taboo Love
  | 'story_revenge'      // 复仇故事/Storytelling
  | 'news'               // 新闻热点/小美
  | 'yi_jing'            // 易经命理/曾仕强
  | 'rich_mindset'       // 富人思维/马云
  | 'mindful_psychology'  // 治愈心理学/Mindful Paws
  | 'great_power_game'    // 大国博弈/Bo Yi
  | 'general'            // 通用赛道（默认）

export interface AiDetectionResult {
  level: AiStrengthLevel;
  /** 人类感得分 (0-10)，越高表示越像真人写的 */
  score: number;
  /** 使用的赛道类型（用于权重调整） */
  nicheType: NicheTypeForScoring;
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

// 中医玄学倪海厦赛道：排除的特征词汇列表（不计入模板词扣分）
// 这些是倪师风格独有的招呼语/口语词，不应被视为AI模板
const TCM_METAPHYSICS_EXCLUDED: string[] = [
  // ===== 倪师风格特征招呼语/套话（不应计入AI模板词）=====
  '诸位乡亲', '各位老友', '老朋友们', '各位乡亲', '各位观众',
  '好了，我们开始上课', '好了开始上课', '好了，开始上课',
  '下课', '下课！',
  '信不信由你', '信不信随你', '信不信由你，我话',
  '好了，讲了这么多，你自己去悟', '好了，今天就讲到这儿',
  '好了，我话讲完了',
  // ===== 铁齿系列 =====
  '铁齿', '你铁齿', '别铁齿', '还在那里铁齿', '还在那边铁齿',
  '你还在那里铁齿', '你还在那边铁齿',
  // ===== 你们不要笑系列 =====
  '你们不要笑', '你不要笑', '不要笑', '你们别笑',
  '这种事情我见太多了', '这种事我见太多了',
  '有时候我自己回想起来也觉得',
  '真的，说不下去了', '真的说不下去了',
  // ===== 诊所系列 =====
  '我跟你讲', '你听我说', '我跟你说',
  '有时候我自己在诊所里也', '唉算了，不说这个了', '算了，不说这个了',
  // ===== 讲到这里系列 =====
  '我讲到这里', '我话说到这里',
  '不对，等等', '等等，我说的是',
  // ===== 巧合/自找麻烦 =====
  '不是巧合', '你以为是巧合', '你说这是不是自找麻烦',
  '不是你自己在作死', '你这是在作死',
  // ===== 身体信号系列 =====
  '身体已经给你脸色看', '身体很老实', '身体不会陪你演戏',
  '气不会骗人', '脸会骗人',
  // ===== 我今天系列 =====
  '我今天非得', '我今天先', '我今天把话',
  '我今天要', '我今天骂',
  // ===== 说真的系列 =====
  '说真的', '说实在的', '讲真的',
  '我这话难听', '我这话不好听',
  '但是不骗你', '可我没骗你', '但不骗你',
  // ===== 你说/你以为系列 =====
  '你说你不信', '你说你', '你说这是',
  '你以为只是', '你以为这', '你以为',
  // ===== 我在临床上系列 =====
  '我在临床上看太多', '在临床上看太多', '我在诊所里也',
  '从那以后我才知道', '我才知道',
  '你说你自己掂量', '你自己掂量',
  // ===== 结尾系列 =====
  '好了', '所以啊', '就是这样',
  // ===== 其他倪师风格常见词 =====
  '人不是铁打的', '你自己把自己搞乱',
  '不是在讲时髦', '不是在吓人', '不是在开玩笑',
  '诸位', '乡亲们',
];

// 曾仕强易经命理赛道：排除的特征词汇列表（不计入模板词扣分）
// 曾仕强风格以"各位朋友""我常常讲""老祖宗说""易经告诉我们""这就是智慧""大错特错"等为标志性口头禅
const YI_JING_EXCLUDED: string[] = [
  // ===== 曾仕强标志性口头禅（不应计入AI模板词）=====
  '各位朋友', '各位观众', '各位同仁',
  '我常常讲', '我告诉', '我话讲完',
  '老祖宗说', '老祖宗告诉我们', '老祖宗讲',
  '易经告诉我们', '易经说', '易经有言',
  '这就是智慧', '这就是道理', '这就是命',
  '大错特错', '错了', '错了错了',
  '不要瞎折腾', '不要乱来', '不要急',
  '你自己去悟', '你自己悟', '你自己去体会',
  '你细细去看', '你仔细去看', '你去看',
  '我话说到这里', '我讲到这里',
  '记住老祖宗的话', '记住了',
  '信不信由你', '你自己掂量',
  '好了啊', '好了', '就这样',
  '你们不要笑', '你不要笑',
  '说真的', '讲真的', '说实话',
  '我跟你说', '你听我说', '我跟你讲',
  '柔能克刚', '刚柔相济',
  '这就是命', '这就是因果',
];

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
    // 曾仕强/易经命理赛道
    '各位朋友', '各位观众', '各位同仁',
    '我常常讲', '我告诉', '我跟你讲',
    '老祖宗说', '老祖宗告诉我们',
    '易经告诉我们', '易经说',
    '这就是智慧', '这就是道理', '这就是命',
    '大错特错', '错了错了',
    '不要瞎折腾', '不要乱来',
    '你细细去看', '你仔细去看',
    '你自己去悟', '你自己去体会',
    '柔能克刚', '刚柔相济',
    '各家有各家的', '各家不一样',
    // 查理·芒格/金融投资赛道
    '芒格', '查理', '巴菲特', '波克夏',
    '逆向思维', '反过来想', '凡事反过来想',
    '我年轻的时候', '我当时就发现', '我在诊所里', '我在临床上',
    '各位', '各位朋友', '各位观众', '你懂的',
    '华尔街那帮人', '华尔街的', '那些分析师', '那些基金经理',
    '这就是人性的弱点', '人性就是这样', '人性就是这样',
    '说白了', '说句不好听的', '不好听的话',
    '你可能不信', '你也许不信', '你大概不信',
    '你听听就好', '信不信随你', '你掂量掂量',
    '愚蠢', '荒谬', '可笑', '荒唐',
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
    // 倪海厦风格
    '你们不要笑，这种事情我见太多了',
    '有时候我自己回想起来也觉得',
    '说真的，我这话难听，但是不骗你',
    '我跟你讲，有时候我自己在诊所里也',
    '你说你不信？行，你继续不信',
    '我年轻时候也铁齿',
    // 曾仕强风格
    '我说这么多，你自己去悟',
    '你不要觉得我啰嗦', '你不要嫌我啰嗦',
    '好，说了这么多',
    '话讲完了', '我话讲完', '我话说到这里',
    '各家有各家的说法', '各家不一样',
    '我说的不一定对', '也不一定全对',
    // 新闻辣评小美风格
    '你们听好了', '我告诉你们', '我看得很清楚', '说白了',
    '各位', '各位观众', '说实话', '我看这事',
    '这帮人', '我们把这件事', '我告诉你们这事',
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
// 赛道识别函数
// ============================================================

/**
 * 根据文本内容自动识别赛道类型
 * 用于调整评分权重
 */
export function detectNicheType(text: string): NicheTypeForScoring {
  const lowerText = text.toLowerCase();
  
  // 中医玄学/倪海厦赛道特征
  const tcmKeywords = [
    '倪海厦', '倪师', '中医', '经方', '黄帝内经', '伤寒论', '金匮',
    '风水', '易经', '八字', '算命', '命理', '阳宅', '阴宅',
    '针灸', '药方', '经方', '虚汗', '寒症', '热症',
    '好了我们开始上课', '下课', '各位老友',
  ];
  
  // 金融投资/芒格赛道特征
  const financeKeywords = [
    '芒格', '巴菲特', '价值投资', '护城河', '复利', '华尔街',
    '伯克希尔', '聪明钱', '逆向思维', '普世智慧',
    '查理', '股票', '估值', '财报', '市盈率',
    '投资组合', '风险管理', '人性', '贪婪', '恐惧',
  ];
  
  // 心理学/Awake Mentor赛道特征
  const awakePsychologyKeywords = [
    'NPD', '自恋型', '人格障碍', '依恋类型', '讨好型', '边界感',
    '人间清醒', '一针见血', '犀利', '原生家庭', '亲密关系',
    '自我成长', '能量场', '吸能', '打压',
  ];
  
  // 哲学智慧/禅意赛道特征
  const philosophyKeywords = [
    '禅', '道家', '佛学', '老子', '庄子', '金刚经', '心经',
    '开悟', '觉醒', '放下', '执念', '无常', '空',
    '因果', '缘分', '修行', '悟', '通透',
  ];
  
  // 情感禁忌/Taboo Love赛道特征
  const emotionKeywords = [
    '禁忌', '越界', '出轨', '背叛', '婚外情', '姐弟恋',
    '暧昧', '心动', '克制', '窒息', '拉扯',
    '婚姻', '爱情', '欲望', '道德',
  ];
  
  // 复仇故事/Storytelling赛道特征
  const revengeKeywords = [
    '复仇', 'revenge', 'reddit', '故事', '逆转', '翻盘',
    '算计', '反杀', '以牙还牙', '以其人之道',
    '结局反转', '真相大白', '洗白', '反转',
  ];
  
  // 新闻热点/小美赛道特征
  const newsKeywords = [
    '乌克兰', '以色列', '特朗普', '俄罗斯', '美国', '欧盟', '制裁',
    '欧洲', '中东', '北约', '台海', '地缘', '粮食', '能源',
    '国际', '外交', '战场', '绞肉机', '遮羞布', '回旋镖',
    '各位观众', '我跟你们说', '咱们下期', '小美',
    '谁在得利', '谁在受害', '谁在演',
  ];
  
  // 易经命理/曾仕强赛道特征
  const yiJingKeywords = [
    '易经', '阴阳', '刚柔', '乾坤', '卦象', '爻辞',
    '乾卦', '坤卦', '五行', '太极', '道', '德', '仁义',
    '曾仕强', '曾教授',
    '我常常说', '我常常讲', '我告诉你', '你细细去瞧',
    '你仔细去看', '各位朋友', '各位观众', '各位同仁',
    '老祖宗说', '老祖宗讲', '老祖宗告诉我们',
    '大错特错', '这就是智慧', '这就是道理',
    '柔能克刚', '刚柔相济', '阴阳要平衡',
    '家和万事兴', '你自己去悟', '你自己去体会',
  ];
  
  // 富人思维/马云赛道特征
  const richMindsetKeywords = [
    '马云', '阿里巴巴', '创业', '商业', '财富', '成功',
    '思维', '格局', '眼光', '执行力', '商战',
    '普通人', '逆袭', '赚钱', '机遇', '风口',
    '各位朋友', '深夜', '我告诉你',
  ];
  
  // 治愈心理学/Mindful Paws赛道特征
  const mindfulPsychologyKeywords = [
    ' Bean', 'Mochi', 'Junie', ' Muffin', ' Charlie',
    '治愈', '疗愈', '减压', '抗焦虑', '宠物', '猫', '狗',
    '心理健康', '情绪', '陪伴', '温暖', '放松',
  ];

  // 大国博弈/Bo Yi赛道特征（中英文通用）
  const greatPowerGameKeywords = [
    // 英文核心特征词
    'Bo Yi', '博弈', 'airspace', 'air defense', 'missile', 'strike',
    'strategic', 'military', 'deterrence', 'geopolitical', 'intelligence',
    'classified', 'operational', 'the documents', 'what the records show',
    'the arithmetic', 'escalation', 'de-escalation',
    'force deployment', 'interdiction', 'vulnerability',
    'regime', 'fragile', 'managed friction', 'tacit',
    'coalition', 'allies', 'partner', 'overflight', 'corridor',
    'air order', 'the game never stops', 'the game continues',
    'This changes everything', 'Let me be very plain',
    'what nobody is telling you', 'I have seen the data',
    'Insider', 'whistleblower', 'operational data',
    'surgical strike', 'proxy', 'sanctions', 'retaliation',
    // 中文核心特征词
    '博弈', '内幕', '文件曝光', '数据说话', '实际交火',
    '兵力部署', '防空系统', '情报评估', '政治意志',
    '真实立场', '大国博弈', '台海', '南海', '俄乌',
    '中东', '伊朗', '以色列', '乌克兰', '北约',
    '拦截', '禁飞区', '战略纵深', '核威慑', '军事基地',
    '情报圈', '外交系统', '军方', '内部评估',
    '博奕', '内幕爆料', '爆料人',
    // Bo Yi 标志性句式（中英文）
    'the game never stops', 'the game continues', 'air defense gap',
    'this is what the data shows', 'here is what they buried',
    'the arithmetic', 'operational data',
    '这就是数据揭示', '文件说了什么', '内幕', '博弈',
  ];

  // 计算各赛道匹配度
  const scores: Record<string, number> = {
    tcm: 0, finance: 0, awake: 0, philosophy: 0, emotion: 0,
    revenge: 0, news: 0, yiJing: 0, rich: 0, mindful: 0, greatPower: 0,
  };

  const keywordSets = [
    { keywords: tcmKeywords, key: 'tcm' },
    { keywords: financeKeywords, key: 'finance' },
    { keywords: awakePsychologyKeywords, key: 'awake' },
    { keywords: philosophyKeywords, key: 'philosophy' },
    { keywords: emotionKeywords, key: 'emotion' },
    { keywords: revengeKeywords, key: 'revenge' },
    { keywords: newsKeywords, key: 'news' },
    { keywords: yiJingKeywords, key: 'yiJing' },
    { keywords: richMindsetKeywords, key: 'rich' },
    { keywords: mindfulPsychologyKeywords, key: 'mindful' },
    { keywords: greatPowerGameKeywords, key: 'greatPower' },
  ];
  
  for (const { keywords, key } of keywordSets) {
    for (const kw of keywords) {
      if (lowerText.includes(kw.toLowerCase())) scores[key]++;
    }
  }
  
  // 根据匹配度判断赛道（使用不同的阈值）
  if (scores.tcm >= 3) return 'tcm_metaphysics';
  if (scores.finance >= 4) return 'finance_crypto';
  if (scores.awake >= 3) return 'psychology';
  if (scores.philosophy >= 3) return 'philosophy_wisdom';
  if (scores.emotion >= 3) return 'emotion_taboo';
  if (scores.revenge >= 2) return 'story_revenge';
  if (scores.news >= 4) return 'news';
  // 易经赛道：扩大关键词后阈值降至2（原来3），因为新增了大量阴阳类词汇
  if (scores.yiJing >= 2) return 'yi_jing';
  if (scores.rich >= 3) return 'rich_mindset';
  if (scores.mindful >= 3) return 'mindful_psychology';
  if (scores.greatPower >= 4) return 'great_power_game';
  
  return 'general';
}

/**
 * 获取赛道特定的评分权重
 * 权重总和必须为 1.0
 * 
 * 维度说明：
 * D1: 模板词清洁度 - 避免AI腔
 * D2: 口语词密度 - 语言自然度
 * D3: 句式多样性 - 句子结构变化
 * D4: 段落不均匀度 - 长短段落交替
 * D5: 第一人称主体 - 个人视角
 * D6: 具体细节锚点 - 具体人名/地名/事件
 * D7: 自嘲/口语打断 - 口语化表达
 * D8: 结尾质量 - 自然收尾
 * D9: 故事结构多样性 - 叙事多样性
 * D10: 名字一致性 - 角色名一致
 */
function getNicheWeights(nicheType: NicheTypeForScoring): number[] {
  // 默认权重：[D1, D2, D3, D4, D5, D6, D7, D8, D9, D10]
  const defaultWeights = [0.10, 0.15, 0.10, 0.08, 0.12, 0.15, 0.10, 0.08, 0.07, 0.05];
  
  switch (nicheType) {
    case 'tcm_metaphysics':
      // 中医玄学/倪海厦：降低D1模板词权重，提高D7口语打断和D6细节
      // 倪师风格：直接、不客气、案例丰富、自嘲式打断
      // D1宽容（阈值放宽+排除列表），降低权重避免误伤
      // D5默认50分，降低权重避免"我"占比过高导致评分过低
      return [0.05, 0.12, 0.10, 0.10, 0.05, 0.15, 0.18, 0.10, 0.08, 0.07];
    
    case 'finance_crypto':
      // 金融投资/芒格：强调口语词（D2）、句式多样性（D3）、自嘲（D7）
      // 芒格风格：尖酸刻薄、反讽、普世智慧、案例丰富
      return [0.10, 0.15, 0.12, 0.08, 0.08, 0.10, 0.12, 0.10, 0.10, 0.05];
    
    case 'psychology':
      // 心理学/Awake Mentor：强调口语密度（D2）、自嘲（D7）、结尾犀利（D8）
      // 心理学风格：犀利专业、一针见血、不熬鸡汤
      return [0.10, 0.15, 0.10, 0.08, 0.10, 0.12, 0.12, 0.10, 0.08, 0.05];
    
    case 'philosophy_wisdom':
      // 哲学智慧/禅意：强调句式多样性（D3）、段落变化（D4）、故事结构（D9）
      // 哲学风格：通透、慢节奏、东方智慧、留白感
      return [0.10, 0.10, 0.12, 0.12, 0.08, 0.08, 0.08, 0.10, 0.12, 0.10];
    
    case 'emotion_taboo':
      // 情感禁忌：强调具体细节（D6）、句式变化（D3）、情感深度（D9）
      // 情感风格：细腻克制、心理描写、微小瞬间、窒息感
      return [0.08, 0.12, 0.12, 0.10, 0.10, 0.15, 0.08, 0.08, 0.12, 0.05];
    
    case 'story_revenge':
      // 复仇故事：强调故事结构（D9）、细节锚点（D6）、具体情节（D6）
      // 故事风格：叙事张力、情节反转、细节丰富
      return [0.08, 0.10, 0.10, 0.08, 0.08, 0.15, 0.08, 0.10, 0.15, 0.08];
    
    case 'news':
      // 新闻热点/小美：降低D5、D6、D7权重，提高D2、D9权重
      // 新闻风格：口语流畅、叙事有力、观点鲜明
      return [0.10, 0.18, 0.12, 0.09, 0.05, 0.08, 0.05, 0.10, 0.13, 0.10];
    
    case 'yi_jing':
      // 易经命理/曾仕强：强调口语打断（D7）、具体案例（D6）、结尾自然（D8）
      // 曾仕强风格：自然收束、东方智慧、以案例代说教
      // D6权重提高（曾仕强善用案例说理，虽然少用具体人名但有丰富行为/场景描述）
      return [0.06, 0.12, 0.10, 0.10, 0.10, 0.14, 0.14, 0.12, 0.07, 0.05];
    
    case 'rich_mindset':
      // 富人思维/马云：强调口语词（D2）、句式变化（D3）、第一人称（D5）
      // 马云风格：直击痛点、商业智慧、深夜语录感
      return [0.08, 0.15, 0.12, 0.08, 0.12, 0.10, 0.10, 0.10, 0.10, 0.05];
    
    case 'mindful_psychology':
      // 治愈心理学：强调口语密度（D2）、结尾治愈（D8）、宠物名一致（D10）
      // 治愈风格：温暖口语、自然疗愈、宠物共鸣
      return [0.10, 0.15, 0.10, 0.08, 0.08, 0.10, 0.10, 0.10, 0.09, 0.10];

    case 'great_power_game':
      // 大国博弈/Bo Yi：强调叙事结构（D9）、权威语气（D2）
      // Bo Yi风格：冰冷爆料、数据说话、文件曝光、多层次递进叙事
      // 极度宽容：降低D2/D5/D6/D10权重，提高D9权重；默认宽容（50分）
      return [0.08, 0.08, 0.10, 0.10, 0.03, 0.05, 0.08, 0.08, 0.35, 0.05];

    default:
      return defaultWeights;
  }
}

// ============================================================
// 核心检测函数
// ============================================================

export function detectAiFeatures(text: string, lang?: string, nicheType?: NicheTypeForScoring): AiDetectionResult {
  const issues: string[] = [];
  const suggestions: string[] = [];
  const textLength = text.replace(/\s/g, '').length;

  if (!text || !text.trim() || textLength < 20) {
    return {
      level: 'strong',
      score: 0,
      nicheType: nicheType || 'general',
      dimensions: {
        templateWords: 0, colloquialDensity: 0, sentenceVariation: 0,
        paragraphVariation: 0, firstPersonVoice: 0, concreteDetails: 0,
        selfDeprecation: 0, endingQuality: 0, storyStructure: 0, nameConsistency: 50,
      },
      issues: ['文本为空或过短，无法评估'],
      suggestions: ['请输入足够长的文本内容进行检测'],
    };
  }

  // 自动检测赛道类型（如果未指定）
  const detectedNiche = nicheType || detectNicheType(text);
  const weights = getNicheWeights(detectedNiche);
  const lang_ = lang || detectLanguage(text);
  const templateWords = getWords(lang_, AI_TEMPLATE_WORDS);
  const humanWords = getWords(lang_, HUMAN_COLLOQUIAL_WORDS);
  const selfDepWords = getWords(lang_, SELF_DEPRECATION_WORDS);
  const hardSellPatterns = HARD_SELL_PATTERNS[lang_] || HARD_SELL_PATTERNS.en || [];

  // ============================================================
  // D1: 模板词清洁度 (权重 10%)
  // 每千字超过4个=0分，0个=100分
  // 中医玄学倪海厦赛道：放宽至每千字8个=0分，特征词不计入扣分
  // ============================================================
  let templateCount = countWords(text, templateWords);

  // 中医玄学赛道：排除倪师风格特征词后再统计
  if (detectedNiche === 'tcm_metaphysics') {
    const excludedLower = TCM_METAPHYSICS_EXCLUDED.map(w => w.toLowerCase());
    const textLower = text.toLowerCase();
    for (const word of excludedLower) {
      const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      templateCount -= (textLower.match(regex) || []).length;
    }
    templateCount = Math.max(0, templateCount);
  }

  // 曾仕强易经赛道：排除其标志性口头禅后再统计
  if (detectedNiche === 'yi_jing') {
    const excludedLower = YI_JING_EXCLUDED.map(w => w.toLowerCase());
    const textLower = text.toLowerCase();
    for (const word of excludedLower) {
      const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      templateCount -= (textLower.match(regex) || []).length;
    }
    templateCount = Math.max(0, templateCount);
  }

  // 大国博弈/Bo Yi赛道：排除其标志性表达后再统计（博弈术语不等于模板词）
  if (detectedNiche === 'great_power_game') {
    const gpExcluded = ['大国博弈', '博弈论', '地缘政治', '战略博弈', '博弈逻辑', '博弈格局', '台海', '南海', '俄乌', '中美', '博弈从未停止', '博弈仍在继续', '战略竞争', '战略博弈', '权力博弈', '博弈内幕', '博弈真相'];
    const textLower = text.toLowerCase();
    for (const word of gpExcluded) {
      const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      templateCount -= (textLower.match(regex) || []).length;
    }
    templateCount = Math.max(0, templateCount);
  }

  const templateDensity = templateCount / Math.max(textLength / 1000, 1);

  let D1: number;
  // 大国博弈/Bo Yi：极度宽容——默认50分，8个/千字=0分
  if (detectedNiche === 'great_power_game') {
    // lerp(8, 0, 8, 100, 0) = 0，所以 clamp(0, 50, 100) = 50 → 不对
    // 用 clamp(50, 100) 会让满分=50。需要分段：
    if (templateDensity >= 8) {
      D1 = 0; // 超过阈值才扣分
    } else if (templateDensity >= 4) {
      D1 = Math.round(lerp(templateDensity, 4, 8, 50, 0)); // 4→50, 8→0
    } else {
      D1 = Math.round(lerp(templateDensity, 0, 4, 100, 50)); // 0→100, 4→50
    }
  } else if (detectedNiche === 'tcm_metaphysics') {
    // 中医玄学倪海厦赛道使用放宽阈值：8个/千字=0分
    // 0个=100分, 8个=0分; 宽容区间更大
    D1 = Math.min(100, Math.max(0, Math.round(lerp(templateDensity, 0, 8, 100, 0))));
  } else if (detectedNiche === 'yi_jing') {
    // 曾仕强赛道：6个/千字=0分（口头禅多，需要宽容一些）
    D1 = Math.min(100, Math.max(0, Math.round(lerp(templateDensity, 0, 6, 100, 0))));
  } else {
    D1 = Math.min(100, Math.max(0, Math.round(lerp(templateDensity, 0, 4, 100, 0))));
  }

  if (detectedNiche !== 'great_power_game' && templateDensity > 2) {
    issues.push(`模板词偏多（每千字${templateDensity.toFixed(1)}个）`);
    suggestions.push('删除"首先""其次""总而言之"等模板词，改用自然过渡');
  }

  // ============================================================
  // D2: 口语词密度 (权重 15%)
  // 每千字6个以上=100分，低于1个=0分
  // 大国博弈英文：Bo Yi 风格以权威爆料句式为主，使用专属短语检测
  // 金融投资：极度宽容，0个/千字=50分，15个/千字=100分
  // ============================================================
  let D2: number;
  const humanCount = countWords(text, humanWords);
  const humanDensity = humanCount / Math.max(textLength / 1000, 1);
  if (detectedNiche === 'great_power_game' && lang_ === 'en') {
    // 大国博弈英文：Bo Yi 风格以权威爆料语气为主，口语特征是固定的爆料句式（多词短语）
    // 逐条检测 Bo Yi 标志性句式（用 substring 匹配，不用 \b 限制）
    const lowerText = text.toLowerCase();
    const boYiPhrases = [
      'let me be very clear', 'let me be plain',
      'here is what', 'this is what the', 'what nobody is telling',
      'here is what nobody', 'that is the part', 'that is exactly why',
      'the mainstream', 'the public conversation', 'the official line',
      'the numbers do not', 'the arithmetic', 'what most people',
      'most people think', 'almost everyone gets', 'no one likes to say',
      'that is not a theory', 'that is not chaos', 'that is designed',
      'that is where', 'and that is', 'it begins on command',
      'it ends only when',
      'that is the hidden', 'that is the real', 'that is the central',
      'that is the key', 'that is the critical', 'that is the unforgiving',
      'there is no clean', 'there is only', 'there is a narrow',
      'what begins as', 'what continues as', 'that is why the',
      'the real issue is not', 'the real question is',
    ];
    const boYiHitCount = boYiPhrases.filter(p => lowerText.includes(p)).length;
    // Bo Yi 短语密度：0个=60分（宽容底线），10个=90分，20个+=100分
    D2 = Math.min(100, Math.max(60, Math.round(lerp(boYiHitCount, 0, 20, 60, 100))));
  } else if (detectedNiche === 'finance_crypto') {
    // 金融投资/芒格：极度宽容——0个=50分，15个=100分
    D2 = Math.min(100, Math.max(50, Math.round(lerp(humanDensity, 0, 15, 50, 100))));
  } else if (detectedNiche === 'great_power_game') {
    // 大国博弈（所有语言）：使用 Bo Yi 风格专属短语检测（英文爆料语气是核心特征）
    const lowerText = text.toLowerCase();
    const boYiPhrases = [
      'let me be very clear', 'let me be plain',
      'here is what', 'this is what the', 'what nobody is telling',
      'here is what nobody', 'that is the part', 'that is exactly why',
      'the mainstream', 'the public conversation', 'the official line',
      'the numbers do not', 'the arithmetic', 'what most people',
      'most people think', 'almost everyone gets', 'no one likes to say',
      'that is not a theory', 'that is not chaos', 'that is designed',
      'that is where', 'and that is', 'it begins on command',
      'it ends only when',
      'that is the hidden', 'that is the real', 'that is the central',
      'that is the key', 'that is the critical', 'that is the unforgiving',
      'there is no clean', 'there is only', 'there is a narrow',
      'what begins as', 'what continues as', 'that is why the',
      'the real issue is not', 'the real question is',
    ];
    const boYiHitCount = boYiPhrases.filter(p => lowerText.includes(p)).length;
    // Bo Yi 短语密度：0个=60分（宽容底线），10个=90分，20个+=100分
    D2 = Math.min(100, Math.max(60, Math.round(lerp(boYiHitCount, 0, 20, 60, 100))));
  } else {
    D2 = Math.min(100, Math.round(lerp(humanDensity, 1, 6, 0, 100)));
    if (humanDensity < 3) {
      issues.push(`口语特征词不足（每千字${humanDensity.toFixed(1)}个）`);
      suggestions.push('添加口语词、个人视角、小情绪等人类特征');
    }
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
    // 大国博弈：Bo Yi 文风偏正式，句长变化较小；宽容处理，默认50分
    if (detectedNiche === 'great_power_game') {
      D3 = Math.min(100, Math.max(50, Math.round(lerp(cv, 0.05, 0.35, 50, 100))));
    } else {
      D3 = Math.min(100, Math.max(0, Math.round(lerp(cv, 0.12, 0.35, 0, 100))));
      if (cv < 0.18 && sentences.length > 10) {
        issues.push('句式过于工整统一，缺乏自然变化');
        suggestions.push('增加长短句交替，打破规律性');
      }
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
    // 大国博弈：Bo Yi 文风段落结构稳定；宽容处理，默认50分
    if (detectedNiche === 'great_power_game') {
      D4 = Math.min(100, Math.max(50, Math.round(lerp(cv, 0.05, 0.25, 50, 100))));
    } else {
      D4 = Math.min(100, Math.max(0, Math.round(lerp(cv, 0.1, 0.25, 0, 100))));
      if (cv < 0.15 && paragraphs.length > 4) {
        issues.push('段落长度过于均匀，像工整模板');
      }
    }
  }

  // ============================================================
  // D5: 第一人称主体 (权重 12%)
  // 占比 <1%=0分，>8%=100分
  // 倪海厦赛道：降低阈值，默认50分，避免"我"过多导致评分过低
  // ============================================================
  let D5 = 50; // 默认中等（避免零分惩罚）
  let firstPersonCount = 0;
  if (lang_ === 'en') {
    firstPersonCount = (text.match(/\bI\b/g) || []).length;
    const totalWords = text.split(/\s+/).length;
    const fpRatio = firstPersonCount / Math.max(totalWords, 1);
    if (detectedNiche === 'great_power_game') {
      // 大国博弈：极度宽容——0%=50分，15%+=100分
      D5 = Math.min(100, Math.max(50, Math.round(lerp(fpRatio, 0.001, 0.15, 50, 100))));
    } else {
      D5 = Math.min(100, Math.round(lerp(fpRatio, 0.005, 0.05, 0, 100)));
    }
  } else {
    firstPersonCount = (text.match(/\u6211/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    const fpRatio = firstPersonCount / Math.max(totalChars, 1);
    if (detectedNiche === 'tcm_metaphysics') {
      // 倪海厦风格"我"占比3%-25%都是合理的
      // 低于3%给50分，3%-25%给60-100分
      D5 = Math.min(100, Math.max(50, Math.round(lerp(fpRatio, 0.03, 0.20, 60, 100))));
    } else if (detectedNiche === 'great_power_game') {
      // 大国博弈：极度宽容——0%=50分，15%+=100分
      D5 = Math.min(100, Math.max(50, Math.round(lerp(fpRatio, 0.001, 0.15, 50, 100))));
    } else {
      D5 = Math.min(100, Math.max(50, Math.round(lerp(fpRatio, 0.005, 0.05, 0, 100))));
    }
  }
  // 倪海厦赛道：降低第一人称问题阈值，避免过度提示
  // 大国博弈：Bo Yi风格以第一人称分析视角为主，不应视为说教
  if (D5 < 30 && detectedNiche !== 'tcm_metaphysics' && detectedNiche !== 'yi_jing' && detectedNiche !== 'great_power_game') {
    issues.push('第一人称主体性不足，文章更像在说教而非分享');
    suggestions.push('多使用"我"的视角，分享自己的真实经历');
  } else if (D5 < 30 && detectedNiche === 'tcm_metaphysics') {
    suggestions.push('适当增加第一人称叙述，提升代入感');
  } else if (D5 < 30 && detectedNiche === 'yi_jing') {
    // 曾仕强赛道：即使"我"少也不报问题，因为他以劝导者身份说话
    suggestions.push('适当增加第一人称叙述，如"我常常看到"或"我告诉你一个例子"');
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

  // 曾仕强赛道综合评分（独立计算，覆盖通用表格结果）
  let D6: number;
  if (detectedNiche === 'yi_jing') {
    // 曾仕强风格核心特征：
    //   1. 大量真实感人物名（独立统计）：王太太、李姐、张姐、陈老师、林太太、陈先生 等
    //   2. 具体行为描述：皱着眉、说话总像、先怀疑、紧绷绷、先笑、不发火、忍一忍 等
    //   3. 年龄/身份标记：五十来岁、年轻时有、后来她吃了很多苦
    //   4. 转变过程：后来她才明白、她开始学、她慢慢学会

    const zhText = text;

    // --- 人物名检测：匹配所有独立名字，统计独立人物数 ---
    const allYiJingNames = zhText.match(
      /王太太|李姐|张姐|陈老师|林太太|陈先生|刘太太|赵姐|孙姨|周老师|吴太太|郑姐/g
    ) || [];
    const uniqueYiJingNames = [...new Set(allYiJingNames)];
    const uniquePersonCount = uniqueYiJingNames.length;

    // --- 具体行为描述检测 ---
    // 表情/神态
    const behavior1 = /皱着眉|眉心紧锁|脸一沉|脸一拉|脸一板|脸色沉|嘴一撇|眼一瞪|眼神飘|眼神柔|眼神定|劈头盖脸|脸一沉|脸色难看|脸色紧绑/.test(zhText);
    // 语气/说话方式
    const behavior2 = /说话总像|说话特别冲|一开口就|说话飞快|话一出口|话一急|嘴硬|口气冲|语气柔|先把话说|声音低|大吼|嗓门大|数落|顶回去|追着问|翻旧账|劈头盖脸|顶三句|不饶人/.test(zhText);
    // 态度/情绪
    const behavior3 = /先怀疑|先否定|紧绷绷|急躁|不急不躁|先笑|不发火|忍一忍|委屈|凡事|每次|天天|紧绑绑|憋着|冷战|抱怨|发泄|让步|什么都答应|一哭就|一闹就/.test(zhText);
    // 家庭/关系行为（扩展：端茶、插一手、收拾自己、照顾老人等）
    const behavior4 = /跟丈|跟孩子|当场顶|当面翻|背后嘀|当众吵|摔东西|把话说明白|慢慢讲道理|把场面稳住|先听别人把话讲完|替别人做主|插一手|守位置|立规矩|抢着表现|端一杯水|倒一杯热茶|先泡杯茶|会收拾自己|照顾老人|教孩子规矩|倒茶|端水|洗衣|做饭|买菜/.test(zhText);
    // 转变/成长过程
    const behavior5 = /后来她|慢慢学|开始学|才明白|才懂得|开始改|慢慢改|半年之后|一段时间后|日子久了|时间长了|三个月以后|后来她才|几年下来|后来才懊悔|后来自己也|慢慢就明白|后来才明白/.test(zhText);

    const behaviorCount = [behavior1, behavior2, behavior3, behavior4, behavior5].filter(Boolean).length;

    // --- 背景细节检测 ---
    const hasAge = /来?岁|年轻时有|三十多|四十来|五十来|六十多|二十来|年龄/.test(zhText);
    const hasOccupation = /开着|做义工|当会计|在单位|在公司|做生意|打工|当老师|退休|上班/.test(zhText);
    const hasFamily = /丈夫|老公|丈大|孩子|儿子|女儿|婆婆|公公|婆家|娘家|家里|一家人/.test(zhText);

    // --- 综合评分（宽松策略：曾仕强内容天然有大量人物和行为）---
    let yiJingD6 = 0;
    // 基础分：独立人物数
    if (uniquePersonCount >= 1) yiJingD6 += 15;
    if (uniquePersonCount >= 2) yiJingD6 += 15;
    if (uniquePersonCount >= 3) yiJingD6 += 10; // 3+人物额外奖励
    // 行为描述加分
    if (behaviorCount >= 4) yiJingD6 += 35;
    else if (behaviorCount >= 3) yiJingD6 += 30;
    else if (behaviorCount >= 2) yiJingD6 += 20;
    else if (behaviorCount >= 1) yiJingD6 += 10;
    // 组合加成：3+人物 + 3+行为 = 优秀案例
    if (uniquePersonCount >= 3 && behaviorCount >= 3) yiJingD6 = Math.min(100, yiJingD6 + 15);
    // 背景细节加成
    if (hasAge || hasOccupation || hasFamily) yiJingD6 = Math.min(100, yiJingD6 + 10);
    // 转变过程加成
    if (behavior5) yiJingD6 = Math.min(100, yiJingD6 + 5);

    D6 = Math.max(25, Math.min(100, yiJingD6));
  } else if (detectedNiche === 'great_power_game') {
    // 大国博弈/Bo Yi：细节宽容，默认80分
    // Bo Yi风格以战略分析为主，不需要传统"具体细节"
    const gpDetailTable: Record<number, number> = { 0: 80, 1: 85, 2: 90, 3: 95, 4: 100 };
    D6 = gpDetailTable[detailsFound.length] ?? (detailsFound.length >= 5 ? 100 : 80);
    // 不报任何问题——Bo Yi风格以宏观战略分析为主，细节检测不适用
  } else {
    // 其他赛道：使用通用表格（0个细节时默认50分而非0分，避免零分惩罚）
    const detailTable: Record<number, number> = { 0: 50, 1: 50, 2: 60, 3: 70, 4: 85 };
    D6 = (detailTable[detailsFound.length] ?? (detailsFound.length >= 5 ? 100 : 50));
    if (detailsFound.length < 2) {
      issues.push(`具体细节不足（仅检测到${detailsFound.length}个锚点）`);
      suggestions.push('加入具体时间（上周三凌晨两点）、具体名字（我家狗叫XX）、具体地点和对话');
    }
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
      // 曾仕强赛道特有口语打断
      /你说她靠什么/, /你说这样行不行/, /你看[,，]/,
      /你不要小看/, /我告诉你[,，]/,
      /这就是智慧/, /这就是道理/, /厉害在哪儿/, /好在哪里/,
      /她常说一句话/, /她以为/, /我以为[,，]/,
      /结果怎么样/, /结果呢/,
    ];
    for (const p of interruptPatterns) {
      if (p.test(text)) selfInterruptCount++;
    }
  }
  const depTable: Record<number, number> = { 0: 30, 1: 50, 2: 70, 3: 100 };
  // 曾仕强赛道：口语打断更宽容（曾仕强以温暖劝导为主，有大量"你说""你不要小看"类互动语）
  const depTableYiJing: Record<number, number> = { 0: 55, 1: 70, 2: 85, 3: 100 };
  // 新闻辣评小美赛道：强调互动引导语（"你们听好了""我告诉你们""各位"），宽容度最高
  const depTableNews: Record<number, number> = { 0: 60, 1: 75, 2: 90, 3: 100 };
  // 大国博弈/Bo Yi：极度宽容，默认50分（内幕爆料风格以权威陈述为主，自嘲口语打断极罕见）
  const depTableGreatPower: Record<number, number> = { 0: 50, 1: 60, 2: 75, 3: 100 };
  const activeDepTable = detectedNiche === 'yi_jing' ? depTableYiJing : detectedNiche === 'news' ? depTableNews : detectedNiche === 'great_power_game' ? depTableGreatPower : depTable;
  const D7 = activeDepTable[Math.min(selfInterruptCount, 3)] ?? 100;
  if (D7 < 50 && detectedNiche !== 'great_power_game') {
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
    if (detectedNiche !== 'great_power_game') {
      issues.push('结尾使用硬广CTA（"请点赞订阅"等）');
      suggestions.push('结尾改为随意自然的收尾，如"Good night"或"睡了"');
    }
  } else {
    let hasGoodClosing = false;
    if (lang_ === 'en') {
      if (/good\s*night|anyway[,，]?\s*(my|the)|time\s+to\s+(sleep|go)|I\s+should\s+go/i.test(lastText)) hasGoodClosing = true;
      if (detectedNiche === 'great_power_game' && /The game (?:never stops|continues)\.?$/i.test(text.trim())) hasGoodClosing = true;
    } else {
      if (/晚安|睡了|就这样吧|不急|写完了|打呼噜|关灯了|去睡了/i.test(lastText)) hasGoodClosing = true;
      if (detectedNiche === 'great_power_game' && /博弈(?:从未停止|还在继续)\。$/i.test(text.trim())) hasGoodClosing = true;
    }
    // 大国博弈英文：检测截断收尾（内容可能在句子中间被截断）
    if (detectedNiche === 'great_power_game' && lang_ === 'en' && !hasGoodClosing) {
      const trimmed = text.trim();
      const lastChar = trimmed[trimmed.length - 1];
      const lastWord = (trimmed.split(/\s+/).pop() || '').replace(/[.,;]$/, '');
      const isTruncated = (
        /[,;—–:]$/.test(lastChar) ||                       // 标点截断：逗号/分号/破折号结尾
        /-\s*$/.test(lastText) ||                           // 单词在句子中被截断
        (lastWord.length > 0 && !lastSentences.some(s => s.includes(lastWord))) // 最后词不在完整句子中
      );
      D8 = isTruncated ? 40 : 50; // 截断 → 40分，无自然收尾 → 50分
    } else {
      D8 = hasGoodClosing ? 100 : 50;
    }
  }

  // ============================================================
  // D9: 故事结构多样性 (权重 10%)
  // 大国博弈/金融投资：分析型内容不以传统故事开场，宽容处理默认80分
  // ====================================
  let D9 = 80; // 默认80分（宽容处理）
  if (lang_ === 'en') {
    const storyOpeners = text.match(
      /(I\s+remember\s+[^.!?]{0,80}[.!?]|There\s+was\s+[^.!?]{0,80}[.!?]|One\s+time\s+[^.!?]{0,80}[.!?]|I\s+had\s+[^.!?]{0,80}[.!?]|After\s+[^.!?]{0,80}[.!?])/gi
    ) || [];
    const uniqueOpeners = new Set(storyOpeners.map(o => o.split(/\s+/).slice(0, 4).join(' ')));
    const variety = uniqueOpeners.size / Math.max(storyOpeners.length, 1);
    if (detectedNiche === 'great_power_game') {
      // 大国博弈/Bo Yi 英文：分析型内容不需要故事开场
      if (storyOpeners.length < 3) {
        D9 = 80; // Bo Yi 分析不以故事开场，默认80分
      } else {
        D9 = Math.min(100, Math.max(50, Math.round(lerp(variety, 0.05, 0.8, 50, 100))));
      }
    } else if (storyOpeners.length >= 3) {
      D9 = Math.min(100, Math.max(0, Math.round(lerp(variety, 0.1, 0.8, 0, 100))));
      if (variety < 0.2 && storyOpeners.length > 4) {
        issues.push(`故事开场方式重复度高（${storyOpeners.length}个故事仅${uniqueOpeners.size}种开场）`);
      }
    }
  } else {
    // 新闻辣评小美赛道：新闻评论不依赖「我记得/有一次」类故事开场，
    // 宽容处理：开场数少时给高分（默认75），多样性要求放低
    if (detectedNiche === 'news') {
      const storyOpeners = text.match(
        /(我记得[^.!?]{0,60}[.!?]|有一次[^.!?]{0,60}[.!?]|那天[^.!?]{0,60}[.!?]|后来[^.!?]{0,60}[.!?]|那之后[^.!?]{0,60}[.!?])/gi
      ) || [];
      if (storyOpeners.length < 3) {
        D9 = 100; // 新闻评论不依赖故事开场，无开场不等于缺陷，给满分
      } else {
        const uniqueOpeners = new Set(storyOpeners.map(o => o.slice(0, 8)));
        const variety = uniqueOpeners.size / Math.max(storyOpeners.length, 1);
        D9 = Math.min(100, Math.max(0, Math.round(lerp(variety, 0.05, 0.8, 40, 100))));
      }
    } else if (detectedNiche === 'great_power_game') {
      // 大国博弈/Bo Yi：分析型内容，不需要传统故事开场
      // Bo Yi 的结构是：内幕数据 → 多方博弈 → 战略结论
      // 宽容处理：默认80分，多样性要求放低
      const storyOpeners = text.match(
        /(我记得[^.!?]{0,60}[.!?]|有一次[^.!?]{0,60}[.!?]|那天[^.!?]{0,60}[.!?]|后来[^.!?]{0,60}[.!?]|那之后[^.!?]{0,60}[.!?])/gi
      ) || [];
      if (storyOpeners.length < 3) {
        D9 = 80; // Bo Yi 分析内容不以故事开场，默认80分
      } else {
        const uniqueOpeners = new Set(storyOpeners.map(o => o.slice(0, 8)));
        const variety = uniqueOpeners.size / Math.max(storyOpeners.length, 1);
        D9 = Math.min(100, Math.max(50, Math.round(lerp(variety, 0.05, 0.8, 50, 100))));
      }
    } else if (detectedNiche === 'finance_crypto') {
      // 金融投资/芒格：分析型内容，结构多样性不以传统故事开场衡量
      // 芒格风格以毒舌分析、跨学科案例、反讽为主，不依赖"我记得/有一次"类故事
      // 宽容处理：默认80分，故事开场少时得高分
      const storyOpeners = text.match(
        /(我记得[^.!?]{0,60}[.!?]|有一次[^.!?]{0,60}[.!?]|那天[^.!?]{0,60}[.!?]|后来[^.!?]{0,60}[.!?]|那之后[^.!?]{0,60}[.!?])/gi
      ) || [];
      if (storyOpeners.length < 3) {
        D9 = 80; // 芒格风格不以故事开场为主，默认80分
      } else {
        const uniqueOpeners = new Set(storyOpeners.map(o => o.slice(0, 8)));
        const variety = uniqueOpeners.size / Math.max(storyOpeners.length, 1);
        D9 = Math.min(100, Math.max(50, Math.round(lerp(variety, 0.05, 0.8, 50, 100))));
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
  }

  // ============================================================
  // D10: 名字一致性 (权重 5%) —— 默认80分宽容处理
  // 同一动物名全文贯穿=100分，出现2种不同名字=0分
  // ============================================================
  let D10 = 80;
  if (detectedNiche === 'great_power_game') {
    // 大国博弈/Bo Yi：内容天然涉及多国/多机构名，不适用角色一致性检测
    D10 = 100;
  } else if (detectedNiche === 'finance_crypto') {
    // 金融投资/芒格：内容以人名和机构名为主，宽容处理
    D10 = 80;
  } else if (lang_ === 'en') {
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
      'sometimes', 'somehow', 'someone', 'something',
      'on', 'in', 'at', 'by', 'with', 'without', 'about', 'after', 'before',
      'not', 'never', 'none', 'nothing', 'nowhere',
      'just', 'only', 'even', 'still', 'already', 'yet',
      'it', 'its', 'then', 'than', 'them', 'too', 'though',
      'whatever', 'whenever', 'wherever', 'however', 'whoever',
      'during', 'until', 'upon', 'within', 'without',
      'instead', 'else', 'twice', 'hence', 'thus',
      'anyway', 'anyhow', 'besides', 'whereas',
      'brushing', 'bedtime', 'lamp',
    ]);
    const properNouns = text.match(/\b[A-Z][a-z]+\b/g) || [];
    const nameCounts: Record<string, number> = {};
    for (const name of properNouns) {
      const lower = name.toLowerCase();
      if (!ENGLISH_STOPWORDS.has(lower)) {
        nameCounts[lower] = (nameCounts[lower] || 0) + 1;
      }
    }
    const sorted = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 3 && sorted[0][1] >= 3) {
      const othersWithMultiple = sorted.slice(1).filter(([, c]) => c >= 3);
      if (othersWithMultiple.length >= 2) {
        D10 = 20;
        issues.push(`角色名不一致：主角${sorted[0][0]}被多次称呼，但同时出现${othersWithMultiple.map(([n]) => n).join('、')}等多个不同名`);
      } else {
        D10 = 100;
      }
    } else if (sorted.length >= 1 && sorted[0][1] >= 1) {
      D10 = 100;
    }
    // sorted.length === 0：检测不到名字时不扣分，保持 D10=80（默认宽容分）
  } else {
    // 中文赛道：通用宠物名检测
    if (detectedNiche === 'news') {
      D10 = 100;
      const NON_PET_STOPWORDS = new Set([
        '说实话', '我也', '其实', '真的', '好像', '可能', '感觉',
        '就是', '不是', '还是', '这个', '那个', '什么', '自己',
        '知道', '觉得', '这么', '那么', '怎么', '应该',
        '可以', '没有', '一样', '一定', '所以', '因为', '但是', '而且', '或者', '如果',
        '像是', '像在', '像只', '像条', '煤球',
        '我坐正', '我坐就', '坐正好', '坐就是', '最后这', '只是这',
        '最后', '只是', '只有', '坐正', '坐就', '坐好',
      ]);
      const CANDIDATE_PET_NAMES = new Set([
        '小满', '年糕', '团子', '咪咪', '煤球', '肉包', '橘子', '阿橘',
        '布丁', '果冻', '奶糖', '花花', '小白', '小灰', '小黑', '黑豆',
        '豆豆', '阿黄', '来福', '旺财', '球球', '阿福', '大黄', '笨笨', '毛毛', '乐乐', '欢欢',
        '糯米',
      ]);
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
      const STRICT_2CHAR_PET_NAMES = new Set([
        '小满', '年糕', '团子', '咪咪', '煤球', '肉包', '橘子', '阿橘',
        '布丁', '果冻', '奶糖', '花花', '豆豆', '阿黄', '来福', '旺财',
        '球球', '阿福', '大黄', '笨笨', '毛毛', '乐乐', '欢欢', '糯米', '梁子',
      ]);
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
            CANDIDATE_PET_NAMES.has(name) ||
            STRICT_2CHAR_PET_NAMES.has(name) ||
            (name.length === 2 && STRICT_PET_NAME_STARTERS.has(name[0]))
          ) {
            dogNameBehaviorMatches.push(name);
          }
        }
      }
      const allDogNames = [...dogNameCandidateMatches, ...dogNameBehaviorMatches].filter(n => !NON_PET_STOPWORDS.has(n));
      const uniqueDogNames = [...new Set(allDogNames)];
      if (uniqueDogNames.length >= 2) {
        D10 = 0;
        issues.push(`宠物名前后不一致：出现了${uniqueDogNames.length}个不同的名字（${uniqueDogNames.join('、')}）`);
        suggestions.push('全文统一使用同一个宠物名，不要中途换名字');
      } else if (uniqueDogNames.length === 1) {
        D10 = 100;
      }
    }
    // 其他中文赛道：D10 保持默认 80
  }

  // ===== 综合得分：使用赛道特定权重计算加权平均 =====
  // 质量好的内容（优化到位）加权平均约 70-95 → 7.0-9.5 分（优秀）
  // 质量中的内容 → 5.0-7.0 分（一般）
  // 质量差的内容 → <5.0 分（较弱）
  const dims = [D1, D2, D3, D4, D5, D6, D7, D8, D9, D10];
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
    nicheType: detectedNiche,
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
