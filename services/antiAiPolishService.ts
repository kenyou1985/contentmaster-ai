/**
 * AI 内容去味服务
 * 目的：给 AI 生成的内容加"人类噪点"，打破完美感，注入真实结构
 * 让 YouTube 等平台检测判定为「人主导、AI 辅助」的内容
 */

import { streamContentGeneration, type StreamModelArgs } from './geminiService';

export interface AntiAiPolishingOptions {
  /** API Key（可选，函数内部使用全局 initializeGemini 设置） */
  apiKey?: string;
  /** 日志回调 */
  onLog?: (message: string) => void;
  /** 流式输出回调 */
  onChunk?: (text: string) => void;
  /** 输出语言，可选 */
  outputLanguage?: string;
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
  lang: string
): PolishingEvaluation {
  const reasons: string[] = [];

  // 1. 模板词替换
  const templateResult = calculateTemplateReplaceRatio(original, polished, lang);
  const templateReplaceRatio = templateResult.replaceRatio;

  // 2. 人类口语词添加
  const humanResult = calculateHumanWordAddition(original, polished, lang);
  const humanWordsAdded = humanResult.addedCount;
  // 目标：每1000字添加约4处口语词
  const humanWordsTarget = Math.ceil(originalLen / 1000) * 4;

  // 3. 句式变化
  const sentenceResult = calculateSentenceVariation(original, polished);
  const sentenceVariationRatio = sentenceResult.variationRatio;

  // 4. 长度变化
  const lengthChangeRatio = originalLen > 0 ? Math.abs(polishedLen - originalLen) / originalLen : 0;

  // 综合评估
  let isEffective = true;

  // 如果有模板词，检查替换比例（目标30%）
  if (templateResult.totalInOriginal > 0) {
    if (templateReplaceRatio < 0.3) {
      reasons.push(`模板词替换不足: ${(templateReplaceRatio * 100).toFixed(1)}% (目标30%)`);
    } else {
      reasons.push(`✅ 模板词替换达标: ${(templateReplaceRatio * 100).toFixed(1)}%`);
    }
  } else {
    reasons.push(`✅ 无模板词需替换`);
  }

  // 检查人类口语词添加（阈值：目标30%，最少3处）
  const humanThreshold = Math.max(3, Math.floor(humanWordsTarget * 0.3));
  if (humanWordsAdded >= humanThreshold) {
    reasons.push(`✅ 口语词添加达标: ${humanWordsAdded}/${humanWordsTarget}`);
  } else if (humanWordsAdded > 0) {
    reasons.push(`口语词添加较少: ${humanWordsAdded}/${humanWordsTarget}`);
  } else {
    reasons.push(`⚠️ 无新增口语词`);
  }

  // 检查句式变化（至少10%）
  if (sentenceVariationRatio >= 0.1) {
    reasons.push(`✅ 句式有变化: ${(sentenceVariationRatio * 100).toFixed(1)}%`);
  } else {
    reasons.push(`⚠️ 句式变化不足: ${(sentenceVariationRatio * 100).toFixed(1)}%`);
  }

  // 检查长度异常（长度变化超过30%视为无效）
  let lengthValid = true;
  if (lengthChangeRatio > 0.3) {
    reasons.push(`⚠️ 长度变化过大: ${(lengthChangeRatio * 100).toFixed(1)}%`);
    lengthValid = false;
  }

  // 综合判定：
  // 关键：口语词为0时必须失败（口语化特征缺失是AI味的核心问题）
  // 但对于英文内容，口语词检测可能不准确，适度放宽
  // 长度变化过大也必须失败
  const isEnglish = lang === 'en';
  if (humanWordsAdded === 0 && !isEnglish) {
    // 中文内容：口语词0个，无论如何都判定为无效
    reasons.push(`⚠️ 核心问题：无口语化特征`);
    isEffective = false;
  } else if (humanWordsAdded === 0 && isEnglish) {
    // 英文内容：口语词检测可能不准确，只要有句式变化就接受
    if (sentenceVariationRatio >= 0.1 && lengthValid) {
      reasons.push(`✅ 英文内容句式有变化: ${(sentenceVariationRatio * 100).toFixed(1)}%（口语词检测跳过）`);
      isEffective = true;
    } else {
      reasons.push(`⚠️ 英文内容句式变化不足: ${(sentenceVariationRatio * 100).toFixed(1)}%`);
      isEffective = false;
    }
  } else if (!lengthValid) {
    // 长度变化过大，判定为无效
    reasons.push(`⚠️ 长度变化超标，AI可能过度发挥`);
    isEffective = false;
  } else if (humanWordsAdded >= humanThreshold && sentenceVariationRatio >= 0.05) {
    // 口语词达标且有句式变化
    isEffective = true;
  } else if (humanWordsAdded >= 1 && sentenceVariationRatio >= 0.2) {
    // 有一定口语词添加且句式变化足够
    isEffective = true;
  } else {
    // 口语词少且句式变化也不够
    isEffective = false;
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
  zh: `你是专业的内容改写编辑。你必须对下面的文案进行实质性改写，让它看起来像真实人类写的，而不是 AI 生成的。

## ⚠️ 核心任务

### 1. 强制替换 AI 模板词
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

### 2. 强制添加人类口语词（必须执行！）
在全文中**至少添加 15 处**以下口语词/短语，分散在各个段落中：
- 语气词：其实、说实话、可能、大概、感觉、好像、你懂的、嘛、呢、吧、呀、哈、哦、嗯
- 个人视角：我自己、当时、之前、有一次、我发现、我有个朋友
- 情感表达：说实话挺、真的有点、被坑过、挺无奈的、无语了

**具体要求**：
- 每个段落至少添加 2-3 处口语词
- 不要集中在同一段落
- 可以替换部分词也可以直接添加
- 这些词要自然融入句子，不能生硬

### 3. 调整句式
- 长短句交替，避免整齐划一
- 相邻句子开头词不要相同

## 禁止
- ❌ 原样输出原文（必须改写！）
- ❌ 删除原文内容
- ❌ 修改末尾 CTA
- ❌ 扩写或添加新内容（只改写，不增加字数！）
- ❌ 将一句扩写成多句

## 输出要求
- **长度误差 ±10%（非常重要！）**
- 只改写不扩写，保持原文长度
- 必须有实质性修改
- 口语词要分散自然，不能堆砌

待改写文案：

`,

  // 英文
  en: `You are a professional content editor. **You MUST make substantial changes to the text below.** Make it sound like a real human wrote it, not AI-generated.

## ⚠️ CRITICAL REQUIREMENT
**DO NOT output the original text unchanged! You MUST make substantial modifications and additions!**

### 1. Replace AI Template Words
Replace these with natural expressions:
- "firstly" / "first of all" → "honestly" / "actually" / "well"
- "secondly" → "next" / "then"
- "furthermore" / "moreover" → "also" / "plus"
- "therefore" / "thus" → "so" / "that's why"
- "however" → "but" / "though"
- "in conclusion" → "to finish" / "finally"

### 2. Add Human Colloquial Features (3-5 per 500 words)
- Honestly, you know, I feel like, it seems like, maybe, probably
- Actually, basically, kind of, sort of
- Well, right, so, oh, I guess

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
const ANTI_AI_POLISH_PROMPT_AGGRESSIVE_TEMPLATE = `你是专业的内容改写编辑。这是一次深度改写任务。

## ⚠️ 必须更彻底的改写

### 1. 模板词全部替换（如有）
中文：所有"首先/其次/最后/因此/所以"等全部替换
英文：所有 firstly/secondly/furthermore/therefore 等全部替换
日韩德法西等其他语言：对应的模板词全部替换

### 2. 大量添加人类口语词（重点！）
**必须添加至少 {{target}} 处口语词：**
- 分布到全文各处
- 不要集中在某一段
- 自然融入，不要生硬

### 3. 句式变化
- 改变句子开头词
- 长短句交替
- 不要所有句子都用相同结构

## 禁止
- ❌ 删除原文内容
- ❌ 拆分句子
- ❌ 修改 CTA

待改写文案：

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
 * 执行 AI 内容去味清洗（深度模式）
 * 多语言支持：根据 outputLanguage 选择对应的模板词和 Prompt
 */
export async function polishTextForAntiAi(
  text: string,
  options: AntiAiPolishingOptions,
  ...modelArgs: StreamModelArgs
): Promise<AntiAiPolishingResult> {
  const { onLog, onChunk, apiKey, outputLanguage } = options;

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

    try {
      let polished = '';

      // 构造 prompt
      let currentPrompt: string;
      if (attempt === 1) {
        currentPrompt = `${langPrompt}\n\n${text}`;
      } else {
        // 重试时使用更宽松的目标
        const targetForRetry = Math.max(10, Math.floor(humanWordsTarget * 0.5));
        const aggressivePrompt = ANTI_AI_POLISH_PROMPT_AGGRESSIVE_TEMPLATE.replace(
          /\{\{target\}\}/g,
          targetForRetry.toString()
        );
        currentPrompt = `${aggressivePrompt}\n\n${text}`;
      }

      onLog?.(`[去AI味] 第${attempt}次改写中...`);

      const systemInstruction = attempt === 1
        ? 'You are a content de-AI editor. Deeply rewrite the text, replace template words, add human colloquial features, do not delete original content.'
        : 'You are a deep rewrite editor. Must thoroughly rewrite the text, add more colloquial words.';

      await streamContentGeneration(
        currentPrompt,
        systemInstruction,
        (chunk) => {
          polished += chunk;
          onChunk?.(polished);
        },
        ...modelArgs
      );

      const result = (polished || '').trim();

      if (!result) {
        onLog?.(`[去AI味] 第${attempt}次返回空`);
        continue;
      }

      const polishedLen = result.replace(/\s+/g, '').length;

      // 评估效果（使用对应语言）
      const evaluation = evaluatePolishingEffectiveness(text, result, originalLen, polishedLen, lang);

      onLog?.(`[去AI味] 第${attempt}次完成:`);
      onLog?.(`  - 模板词替换: ${(evaluation.templateReplaceRatio * 100).toFixed(1)}%`);
      onLog?.(`  - 口语词添加: ${evaluation.humanWordsAdded}/${evaluation.humanWordsTarget}`);
      onLog?.(`  - 句式变化: ${(evaluation.sentenceVariationRatio * 100).toFixed(1)}%`);
      onLog?.(`  - 长度变化: ${(evaluation.lengthChangeRatio * 100).toFixed(1)}%`);

      // 保存最佳结果
      if (!bestResult || evaluation.isEffective) {
        bestResult = result;
        bestEvaluation = evaluation;
      }

      // 如果效果达标，接受结果
      if (evaluation.isEffective) {
        onLog?.(`[去AI味] ✅ 第${attempt}次改写达标`);
        return {
          success: true,
          polishedText: result,
          isEffective: true,
          humanWordsAdded: evaluation.humanWordsAdded,
          humanWordsTarget: evaluation.humanWordsTarget
        };
      }

      // 如果是最后一次，接受最佳结果
      if (attempt >= MAX_RETRY) {
        if (bestResult) {
          onLog?.(`[去AI味] 已达最大重试次数，使用最佳结果`);
          return {
            success: true,
            polishedText: bestResult,
            isEffective: false,
            humanWordsAdded: bestEvaluation?.humanWordsAdded ?? 0,
            humanWordsTarget: bestEvaluation?.humanWordsTarget ?? 0
          };
        }
        break;
      }

    } catch (error: any) {
      onLog?.(`[去AI味] 第${attempt}次失败: ${error.message || error}`);
      if (attempt >= MAX_RETRY) break;
    }
  }

  // 所有尝试都失败
  if (bestResult) {
    return {
      success: true,
      polishedText: bestResult,
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

  // 1. 删除常见 AI 模板词
  const templateWords = [
    '首先', '其次', '另外', '此外', '因此', '总而言之', '综上所述', '由此可见',
    '总的来看', '整体而言', '显而易见', '毫无疑问', '毋庸置疑',
    '值得注意的是', '需要指出的是', '不言而喻', '换句话说', '也就是说',
  ];
  templateWords.forEach(word => {
    result = result.replace(new RegExp(word, 'g'), '');
  });

  // 2. 删除序号列表格式
  result = result.replace(/^\d+[.、:：]\s*/gm, '');
  result = result.replace(/^[一二三四五六七八九十]+[.、:：]\s*/gm, '');

  // 3. 删除多余空行
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}
