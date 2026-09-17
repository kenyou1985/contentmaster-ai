/**
 * Humanizer Detector — AI 检测器（12 项指标）
 *
 * 灵感来源：StealthHumanizer lib/detector.ts
 * 适配：前端纯 JS，无外部依赖；中英文双语支持
 *
 * 指标列表：
 *  1. Perplexity          词汇多样性
 *  2. Burstiness          句子长度方差
 *  3. Vocabulary Diversity 词汇丰富度
 *  4. Sentence Variation  句长变化
 *  5. Transition Frequency 转换词频率
 *  6. Passive Voice Ratio 被动语态比率
 *  7. AI Phrase Density   AI 短语密度
 *  8. Sentence Start Diversity 句首多样性
 *  9. Pronoun Usage       代词使用
 * 10. Hedging Frequency   模糊语频率
 * 11. Quantifier Overuse  量词过度使用
 * 12. Em-dash Density     em-dash 密度
 */

import {
  AI_PHRASES_EN,
  AI_PHRASES_ZH,
  AI_SENTENCE_STARTERS_EN,
  AI_SENTENCE_STARTERS_ZH,
  TRANSITION_WORDS_EN,
  TRANSITION_WORDS_ZH,
  HEDGING_PHRASES_EN,
} from './data/aiPhrases';
import { SYNONYMS_EN, SYNONYMS_ZH } from './data/synonyms';

export type Lang = 'zh' | 'en' | 'auto';

export interface DetectorSentence {
  text: string;
  score: number; // 0..100（越高越"人"）
  classification: 'human' | 'maybe' | 'ai';
  issues: string[];
}

export interface DetectorReport {
  score: number; // 0..100（总体）
  confidenceInterval: { lower: number; upper: number };
  verdict: 'human' | 'ai' | 'mixed';
  language: 'zh' | 'en';
  sentences: DetectorSentence[];
  analysis: {
    perplexity: number;
    burstiness: number;
    vocabularyDiversity: number;
    sentenceLengthVariation: number;
    transitionFrequency: number;
    passiveVoiceRatio: number;
    aiPhraseDensity: number;
    sentenceStartDiversity: number;
    pronounUsage: number;
    hedgingFrequency: number;
    quantifierOveruse: number;
    emDashDensity: number;
  };
  /**
   * 每个维度对总分的加权贡献度（百分比 0..100）。
   * key 对应 analysis 字段，value 为该维度原始得分 × 权重 / 100，
   * 即这一维度对最终 overallScore 的实际"占比贡献"。
   */
  weightedContributions: Record<keyof DetectorReport['analysis'], number>;
  /** 各维度的权重配置（百分比 0..100） */
  weights: DetectorWeights;
  topAiSentences: Array<{ text: string; score: number; issues: string[] }>;
  topHumanSentences: Array<{ text: string; score: number; issues: string[] }>;
  foundAiPhrases: string[];
  recommendations: string[];
}

/**
 * 检测器权重配置（合计 100%）。
 *
 * 调整思路（相对原版）：
 *  - 提升正向指标（句级均分、句长突发性、句首多样性、词汇多样性）的权重；
 *  - 降低过度负向指标（hedging / quantifier / emDash / passive）的权重，
 *    避免对真实人类写作的"小习惯"过度惩罚；
 *  - AI 短语保留较高权重（仍是强 AI 信号），但降低单句扣分幅度。
 */
export interface DetectorWeights {
  sentenceAvg: number;
  perplexity: number;
  burstiness: number;
  vocabulary: number;
  sentenceVariation: number;
  transitions: number;
  passive: number;
  aiPhrases: number;
  sentenceStart: number;
  pronoun: number;
  hedging: number;
  quantifier: number;
  emDash: number;
}

export const DETECTOR_WEIGHTS: DetectorWeights = {
  sentenceAvg: 0.30,      // 句子级均分（原 0.25，+0.05）
  perplexity: 0.12,       // 词汇多样性（原 0.13，-0.01）
  burstiness: 0.15,       // 突发性（原 0.13，+0.02）
  vocabulary: 0.08,       // 词汇丰富度（原 0.06，+0.02）
  sentenceVariation: 0.07,// 句长变化（原 0.07）
  transitions: 0.05,      // 转换词（原 0.06，-0.01）
  passive: 0.03,          // 被动（原 0.04，-0.01）
  aiPhrases: 0.08,        // AI 短语（原 0.10，-0.02）
  sentenceStart: 0.06,    // 句首多样性（原 0.05，+0.01）
  pronoun: 0.03,          // 代词（原 0.03）
  hedging: 0.01,          // 模糊语（原 0.03，-0.02，过度惩罚）
  quantifier: 0.01,       // 量词过度（原 0.02，-0.01）
  emDash: 0.01,           // em-dash（原 0.03，-0.02，过度惩罚）
};

// ── 语言检测 ──────────────────────────────────────────────────────────────

export function detectLang(text: string): 'zh' | 'en' {
  if (!text) return 'en';
  const sample = text.slice(0, Math.min(500, text.length));
  const zh = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (sample.match(/[A-Za-z]/g) || []).length;
  return zh > en ? 'zh' : 'en';
}

// ── 分句（中英文）─────────────────────────────────────────────────────────

function splitSentences(text: string, lang: 'zh' | 'en'): string[] {
  if (!text) return [];
  if (lang === 'zh') {
    // 中文句号 / 问号 / 感叹号 / 省略号 + 换行/段落
    return text
      .replace(/\r/g, '')
      .split(/(?<=[。！？…])|\n+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  // 英文：保留缩写 + 数字小数点
  const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'cf', 'approx', 'inc', 'ltd', 'co', 'corp', 'no', 'u.s', 'u.k', 'a.m', 'p.m']);
  const protectedText = text.replace(/([A-Za-z0-9])\.(?=[A-Za-z0-9])/g, '$1\u0001');
  const parts = protectedText.split(/(?<=[.!?])\s+/);
  return parts
    .map(s => s.replace(/\u0001/g, '.').trim())
    .filter(s => {
      if (!s) return false;
      const lastWord = s.split(/\s+/).pop()?.toLowerCase().replace(/[.!?]+$/, '') || '';
      return !ABBR.has(lastWord);
    });
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}

function wordsZh(text: string): string[] {
  // 中文按字符分词（粗粒度，避免依赖 jieba）
  return text.replace(/[\u4e00-\u9fff]/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function wordsEn(text: string): string[] {
  return text.replace(/[^A-Za-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
}

// ── 12 项指标 ─────────────────────────────────────────────────────────────

/**
 * 英文功能词 / 高频停用词（用于剥离后再算"内容词多样性"）
 *
 * 为什么需要这个？
 * 原版公式：`uniformity = maxFreq / avgFreq`，对英文文本会把 "the / and / of / a / to" 这种
 * 每段都出现的功能词也算进 maxFreq，导致 uniformity 经常 30+，进而
 * (100 - uniformity*15) 变成 -300+，最终 score 被 clamp 到 0。
 *
 * 解决：把功能词剥离后再算 maxFreq / uniformity。
 */
const STOP_WORDS_EN = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'doing',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can',
  'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'what', 'which', 'who', 'whom', 'whose',
  'as', 'if', 'than', 'then', 'so', 'not', 'no', 'yes',
  'from', 'into', 'onto', 'upon', 'about',
  'also', 'just', 'only', 'even', 'still', 'very', 'much', 'more', 'most', 'less', 'least',
  'when', 'where', 'why', 'how',
]);

const STOP_CHARS_ZH = new Set([
  '的', '了', '是', '在', '和', '与', '或', '但', '而', '也', '都', '就', '还',
  '我', '你', '他', '她', '它', '们', '我们', '你们', '他们', '她们', '它们',
  '这', '那', '这个', '那个', '这些', '那些',
  '有', '没', '没有', '不', '很', '非常', '比较',
  '对', '从', '到', '为', '为了', '因为', '所以', '因此', '如果', '虽然',
  '一', '个', '一些', '这个', '那个', '每', '所有',
  '上', '下', '里', '外', '中', '内',
  '说', '讲', '表示', '告诉', '问', '答',
]);

function contentWordsEn(words: string[]): string[] {
  return words.filter(w => !STOP_WORDS_EN.has(w));
}

function contentWordsZh(words: string[]): string[] {
  return words.filter(w => !STOP_CHARS_ZH.has(w));
}

function calcPerplexity(text: string, lang: 'zh' | 'en'): number {
  // 重写公式：剥离功能词后再算多样性，避免 "the" 把分数拉成 0
  const allWords = (lang === 'zh' ? wordsZh(text) : wordsEn(text)).map(w => w.toLowerCase());
  if (allWords.length < 10) return 50;

  const contentWords = (lang === 'zh' ? contentWordsZh(allWords) : contentWordsEn(allWords));
  if (contentWords.length < 5) return 50;

  // 1) 内容词 TTR（type-token ratio）
  const uniqueContent = new Set(contentWords);
  const ttr = uniqueContent.size / contentWords.length;
  // 自然英文文本内容词 TTR 通常 0.5-0.8；AI 文本偏低 0.3-0.5
  const ttrScore = clamp(ttr * 100, 0, 100);

  // 2) 内容词 bigram 多样性
  const bigrams: string[] = [];
  for (let i = 0; i < contentWords.length - 1; i++) {
    bigrams.push(contentWords[i] + ' ' + contentWords[i + 1]);
  }
  const bigramFreq: Record<string, number> = {};
  bigrams.forEach(b => (bigramFreq[b] = (bigramFreq[b] || 0) + 1));
  const uniqueBigrams = Object.keys(bigramFreq).length;
  const bigramDiversity = uniqueBigrams / Math.max(bigrams.length, 1);
  // 自然文本 0.85-0.98；AI 文本 0.6-0.8
  const bigramScore = clamp(bigramDiversity * 100, 0, 100);

  // 3) 内容词最大词频比（剥离功能词后，"the" 不再污染）
  const unigramFreq: Record<string, number> = {};
  contentWords.forEach(w => (unigramFreq[w] = (unigramFreq[w] || 0) + 1));
  const maxFreq = Math.max(...Object.values(unigramFreq));
  const maxFreqRatio = maxFreq / contentWords.length;
  // 内容词最大占比超过 8% 才扣分；自然文本极少有内容词 >5%
  const repetitionScore = clamp(100 - Math.max(0, maxFreqRatio - 0.05) * 600, 0, 100);

  // 综合：TTR 50% + bigram 多样性 30% + 内容词多样性 20%
  const score = ttrScore * 0.5 + bigramScore * 0.3 + repetitionScore * 0.2;
  return clamp(score, 0, 100);
}

function calcBurstiness(sentences: string[], lang: 'zh' | 'en'): number {
  if (sentences.length < 3) return 50;
  const lengths = sentences.map(s => (lang === 'zh' ? s.length : s.split(/\s+/).length));
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((s, len) => s + Math.pow(len - avg, 2), 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  const burstiness = (stdDev / Math.max(avg, 1)) * 100;
  return clamp(burstiness * 2.5, 0, 100);
}

function calcVocabDiversity(text: string, lang: 'zh' | 'en'): number {
  const words = (lang === 'zh' ? wordsZh(text) : wordsEn(text)).map(w => w.toLowerCase());
  if (words.length < 10) return 50;
  return clamp((new Set(words).size / words.length) * 100, 0, 100);
}

function calcSentenceVariation(sentences: string[], lang: 'zh' | 'en'): number {
  if (sentences.length < 3) return 50;
  const lengths = sentences.map(s => (lang === 'zh' ? s.length : s.split(/\s+/).length));
  const max = Math.max(...lengths);
  const min = Math.min(...lengths);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  return clamp(((max - min) / Math.max(avg, 1)) * 60, 0, 100);
}

function calcTransitionFrequency(text: string, lang: 'zh' | 'en'): number {
  const lower = text.toLowerCase();
  const list = lang === 'zh' ? TRANSITION_WORDS_ZH : TRANSITION_WORDS_EN;
  const words = (lang === 'zh' ? wordsZh(text) : wordsEn(text)).length || 1;
  let count = 0;
  list.forEach(w => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = lower.match(new RegExp(escaped, 'gi'));
    if (matches) count += matches.length;
  });
  // 比例（每 1000 字），AI 偏高 = 不利（返回越低越好）
  return clamp((count / words) * 1000, 0, 100);
}

function calcPassiveVoiceRatio(text: string, lang: 'zh' | 'en'): number {
  // 简单规则：英文 is/are/was/were + 过去分词（粗略）；中文按"被"字句
  const sentences = splitSentences(text, lang);
  if (sentences.length < 2) return 50;
  if (lang === 'en') {
    let passiveCount = 0;
    const pattern = /\b(is|are|was|were|been|being)\s+\w+(?:ed|en)\b/gi;
    sentences.forEach(s => {
      const m = s.match(pattern);
      if (m) passiveCount += m.length;
    });
    return clamp((passiveCount / sentences.length) * 100, 0, 100);
  }
  let passiveCount = 0;
  sentences.forEach(s => {
    if (/[\u4e00-\u9fff]/.test(s) && /被[一-龥]{1,5}(?:了|着|过)?/.test(s)) passiveCount++;
  });
  return clamp((passiveCount / sentences.length) * 100, 0, 100);
}

function calcAiPhraseDensity(text: string, lang: 'zh' | 'en'): { density: number; found: string[] } {
  const lower = text.toLowerCase();
  const list = lang === 'zh' ? AI_PHRASES_ZH : AI_PHRASES_EN;
  const found: string[] = [];
  list.forEach(phrase => {
    const haystack = lang === 'zh' ? text : lower;
    if (haystack.includes(lang === 'zh' ? phrase : phrase)) found.push(phrase);
  });
  // 中文短语通常 4-6 字，每句算一次
  const sentences = splitSentences(text, lang);
  const density = (found.length / Math.max(sentences.length, 1)) * 20;
  return { density: clamp(density, 0, 100), found };
}

function calcSentenceStartDiversity(sentences: string[], lang: 'zh' | 'en'): number {
  if (sentences.length < 4) return 50;
  const starts = sentences.map(s => {
    if (lang === 'zh') return s.trim().slice(0, 1); // 中文取首字
    return s.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  });
  const uniqueStarts = new Set(starts);
  return clamp((uniqueStarts.size / starts.length) * 100, 0, 100);
}

function calcPronounUsage(text: string, lang: 'zh' | 'en'): number {
  // 适度使用代词 = 人类，过多/过少都异常
  if (lang === 'en') {
    const pronouns = ['I', 'me', 'my', 'we', 'us', 'our', 'you', 'your'];
    const words = text.split(/\s+/);
    let count = 0;
    words.forEach(w => {
      if (pronouns.includes(w)) count++;
    });
    return clamp((count / Math.max(words.length, 1)) * 500, 0, 100);
  }
  // 中文第一人称：我/我们/你/你们/咱们
  const pronouns = ['我', '我们', '你', '你们', '咱们'];
  let count = 0;
  pronouns.forEach(p => {
    const matches = text.match(new RegExp(p, 'g'));
    if (matches) count += matches.length;
  });
  const totalChars = text.replace(/\s/g, '').length || 1;
  return clamp((count / totalChars) * 500, 0, 100);
}

function calcHedgingFrequency(text: string, lang: 'zh' | 'en'): number {
  if (lang === 'en') {
    const lower = text.toLowerCase();
    let count = 0;
    HEDGING_PHRASES_EN.forEach(p => {
      if (lower.includes(p)) count++;
    });
    return clamp(count * 15, 0, 100);
  }
  // 中文 hedge：可能/或许/也许/大概/似乎/看起来/一般而言
  const hedges = ['可能', '或许', '也许', '大概', '似乎', '看起来', '一般而言'];
  let count = 0;
  hedges.forEach(h => {
    const matches = text.match(new RegExp(h, 'g'));
    if (matches) count += matches.length;
  });
  return clamp(count * 10, 0, 100);
}

function calcQuantifierOveruse(text: string, lang: 'zh' | 'en'): number {
  if (lang === 'en') {
    const QUANT = ['numerous', 'various', 'multiple', 'several', 'a variety of', 'a multitude of', 'a range of', 'a number of', 'countless', 'a vast array of', 'a wide range of', 'a significant number of'];
    const lower = text.toLowerCase();
    let count = 0;
    QUANT.forEach(q => {
      const matches = lower.match(new RegExp(`\\b${q}\\b`, 'gi'));
      if (matches) count += matches.length;
    });
    return clamp(count * 10, 0, 100);
  }
  const QUANT = ['许多', '诸多', '大量', '不少', '很多', '种种', '众多'];
  let count = 0;
  QUANT.forEach(q => {
    const matches = text.match(new RegExp(q, 'g'));
    if (matches) count += matches.length;
  });
  return clamp(count * 8, 0, 100);
}

function calcEmDashDensity(text: string, lang: 'zh' | 'en'): number {
  // em-dash（— 或 --）密度过高 = AI 强信号
  const emDashes = (text.match(/[—–]|--/g) || []).length;
  const sentences = splitSentences(text, lang).length || 1;
  return clamp((emDashes / sentences) * 30, 0, 100);
}

// ── 句子级分析 ──────────────────────────────────────────────────────────

function analyzeSentence(sentence: string, lang: 'zh' | 'en'): DetectorSentence {
  let score = 55; // 起点提升（原 50 → 55），配合更宽松的人类信号加分
  const issues: string[] = [];
  const lower = sentence.toLowerCase();
  const haystack = lang === 'zh' ? sentence : lower;

  // AI 短语（每个 -6，原 -10）
  const phraseList = lang === 'zh' ? AI_PHRASES_ZH : AI_PHRASES_EN;
  let aiPhraseCount = 0;
  phraseList.forEach(phrase => {
    if (haystack.includes(lang === 'zh' ? phrase : phrase)) {
      aiPhraseCount++;
      if (aiPhraseCount <= 2) issues.push(`AI 短语："${phrase}"`);
    }
  });
  score -= aiPhraseCount * 6;

  // AI 句首（-4，原 -7）
  const startList = lang === 'zh' ? AI_SENTENCE_STARTERS_ZH : AI_SENTENCE_STARTERS_EN;
  for (const starter of startList) {
    if (haystack.startsWith(lang === 'zh' ? starter : starter.toLowerCase())) {
      score -= 4;
      issues.push('AI 典型句首');
      break;
    }
  }

  // 句长（中文按字符，英文按词）
  const wc = lang === 'zh' ? sentence.length : sentence.split(/\s+/).length;
  if (lang === 'en' && wc > 45) {
    issues.push('超长句（AI 倾向）');
    score -= 5; // 原 -8
  } else if (lang === 'en' && wc <= 10 && wc >= 2) {
    score += 6; // 短句 = 人类（原 +4）
  } else if (lang === 'en' && wc <= 6) {
    score += 8; // 极短句 = 强烈人类信号
  }

  // em-dash（-3，原 -6）
  if (/[—–]|--/.test(sentence)) {
    issues.push('em-dash 偏 AI 特征');
    score -= 3;
  }

  // 人类信号（奖励提高）
  if (lang === 'en') {
    // 缩写
    const contractions = sentence.match(/[a-zA-Z]{1,15}'(?:t|s|re|ve|ll|d|m)\b/gi);
    if (contractions) score += contractions.length * 4; // 原 +3
    // 第一人称
    if (/\b(I|me|my|we|us|our)\b/i.test(sentence)) score += 5; // 原 +3
    // 第二人称（更口语化）
    if (/\b(you|your|you're|you've|you'll)\b/i.test(sentence)) score += 3;
    // 问号
    if (sentence.trim().endsWith('?')) score += 5; // 原 +4
    // 感叹号
    if (sentence.trim().endsWith('!')) score += 4; // 原 +3
    // 句首疑问词（Who/What/Why/How/When）= 人类好奇表达
    if (/^(Who|What|Why|How|When|Where)\b/i.test(sentence.trim())) score += 3;
  } else {
    // 中文缩写
    const hasCasualInsert = /说实话|其实|说白了|讲真|怎么说呢|想想看|坦白说|说真的/.test(sentence);
    if (hasCasualInsert) score += 6; // 原 +4
    // 问号
    if (sentence.includes('？')) score += 4; // 原 +3
    // 感叹号
    if (sentence.includes('！')) score += 3; // 原 +2
    // 反问
    if (/^难道|怎么|为什么|凭什么/.test(sentence.trim())) score += 5; // 原 +4
    // 中文第一人称
    if (/我|我们/.test(sentence)) score += 3;
    // 中文第二人称
    if (/你|你们/.test(sentence)) score += 2;
  }

  score = clamp(score, 0, 100);

  // 分类
  let classification: 'human' | 'maybe' | 'ai';
  if (score >= 60) classification = 'human';        // 原 55 → 60（更严格分类以保留差异化）
  else if (score >= 40) classification = 'maybe';
  else classification = 'ai';

  return { text: sentence, score, classification, issues };
}

// ── 主入口 ──────────────────────────────────────────────────────────────

export interface DetectOptions {
  /** 强制指定语言（默认 auto） */
  lang?: Lang;
}

export function detectAI(text: string, options: DetectOptions = {}): DetectorReport {
  const lang = options.lang && options.lang !== 'auto' ? options.lang : detectLang(text);
  const sentences = splitSentences(text, lang);
  const sentenceResults = sentences.map(s => analyzeSentence(s, lang));

  const aiPhrasesResult = calcAiPhraseDensity(text, lang);

  const analysis = {
    perplexity: Math.round(calcPerplexity(text, lang)),
    burstiness: Math.round(calcBurstiness(sentences, lang)),
    vocabularyDiversity: Math.round(calcVocabDiversity(text, lang)),
    sentenceLengthVariation: Math.round(calcSentenceVariation(sentences, lang)),
    transitionFrequency: Math.round(calcTransitionFrequency(text, lang)),
    passiveVoiceRatio: Math.round(calcPassiveVoiceRatio(text, lang)),
    aiPhraseDensity: Math.round(aiPhrasesResult.density),
    sentenceStartDiversity: Math.round(calcSentenceStartDiversity(sentences, lang)),
    pronounUsage: Math.round(calcPronounUsage(text, lang)),
    hedgingFrequency: Math.round(calcHedgingFrequency(text, lang)),
    quantifierOveruse: Math.round(calcQuantifierOveruse(text, lang)),
    emDashDensity: Math.round(calcEmDashDensity(text, lang)),
  };

  // 加权综合（转换词/被动/AI短语/em-dash 等是负向指标，按 100-x 取反）
  const weights: DetectorWeights = DETECTOR_WEIGHTS;

  const sentenceAvg = sentenceResults.length > 0
    ? sentenceResults.reduce((s, r) => s + r.score, 0) / sentenceResults.length
    : 50;

  // 每个维度对总分的实际贡献（带符号：正向越高越人，负向指标已经取反）
  const contributions: Record<keyof DetectorReport['analysis'], number> = {
    perplexity: analysis.perplexity * weights.perplexity,
    burstiness: analysis.burstiness * weights.burstiness,
    vocabularyDiversity: analysis.vocabularyDiversity * weights.vocabulary,
    sentenceLengthVariation: analysis.sentenceLengthVariation * weights.sentenceVariation,
    transitionFrequency: (100 - analysis.transitionFrequency) * weights.transitions,
    passiveVoiceRatio: (100 - analysis.passiveVoiceRatio) * weights.passive,
    aiPhraseDensity: (100 - analysis.aiPhraseDensity) * weights.aiPhrases,
    sentenceStartDiversity: analysis.sentenceStartDiversity * weights.sentenceStart,
    pronounUsage: analysis.pronounUsage * weights.pronoun,
    hedgingFrequency: (100 - analysis.hedgingFrequency) * weights.hedging,
    quantifierOveruse: (100 - analysis.quantifierOveruse) * weights.quantifier,
    emDashDensity: (100 - analysis.emDashDensity) * weights.emDash,
  };

  // sentenceAvg 的贡献单独算（它来自 sentences 数组而非 analysis）
  const sentenceAvgContribution = sentenceAvg * weights.sentenceAvg;

  const overallScore = sentenceAvgContribution +
    contributions.perplexity +
    contributions.burstiness +
    contributions.vocabularyDiversity +
    contributions.sentenceLengthVariation +
    contributions.transitionFrequency +
    contributions.passiveVoiceRatio +
    contributions.aiPhraseDensity +
    contributions.sentenceStartDiversity +
    contributions.pronounUsage +
    contributions.hedgingFrequency +
    contributions.quantifierOveruse +
    contributions.emDashDensity;

  const score = Math.round(overallScore);

  // 判定阈值放宽：>=58 视为人类（原 65 → 58），配合权重调整让好改写更容易拿到 70+
  let verdict: 'human' | 'ai' | 'mixed';
  if (score >= 58) verdict = 'human';
  else if (score >= 38) verdict = 'mixed';
  else verdict = 'ai';

  // 置信区间（句子数少 / 方差大 → 区间宽）
  const sentenceVar = sentenceResults.length > 1
    ? sentenceResults.reduce((s, r) => s + Math.pow(r.score - score, 2), 0) / sentenceResults.length
    : 400;
  const margin = Math.min(15, Math.round(Math.sqrt(sentenceVar) * 0.6 + (sentenceResults.length < 5 ? 6 : 2)));
  const confidenceInterval = {
    lower: Math.max(0, score - margin),
    upper: Math.min(100, score + margin),
  };

  // Top AI / Top Human
  const sortedAsc = [...sentenceResults].sort((a, b) => a.score - b.score);
  const topAiSentences = sortedAsc.slice(0, 5).map(s => ({
    text: s.text.length > 120 ? s.text.slice(0, 117) + '…' : s.text,
    score: s.score,
    issues: s.issues,
  }));
  const sortedDesc = [...sentenceResults].sort((a, b) => b.score - a.score);
  const topHumanSentences = sortedDesc.slice(0, 5).map(s => ({
    text: s.text.length > 120 ? s.text.slice(0, 117) + '…' : s.text,
    score: s.score,
    issues: s.issues,
  }));

  // 建议
  const recommendations: string[] = [];
  if (analysis.aiPhraseDensity > 18) recommendations.push('删除 AI 典型短语："furthermore / moreover / it is important to note / 此外 / 总之"');
  if (analysis.burstiness < 35) recommendations.push('长短句交替：插入 1-2 个超短句打破节奏');
  if (analysis.perplexity < 50) recommendations.push('替换高频词，使用更多样的词汇');
  if (analysis.sentenceStartDiversity < 55) recommendations.push('变化句首：避免每句都以 "The / This / 此外" 开头');
  if (analysis.passiveVoiceRatio > 30) recommendations.push('将被动语态改为主动');
  if (analysis.transitionFrequency > 14) recommendations.push('减少转换词（however / moreover / 因此）密度');
  if (analysis.hedgingFrequency > 25) recommendations.push('减少模糊语（it could be argued / 可能 / 或许）');
  if (analysis.emDashDensity > 22) recommendations.push('替换 em-dash（— / --）为逗号或句号');
  if (topAiSentences.length > 0 && topAiSentences[0].score < 35) {
    recommendations.push(`优先重写最 AI 的句子："${topAiSentences[0].text}"`);
  }
  if (verdict === 'human' && recommendations.length === 0) {
    recommendations.push('文本自然，未发现明显 AI 特征');
  }

  // 构造返回值（包含 weightedContributions 与 weights 供 UI 展示）
  const report: DetectorReport = {
    score,
    confidenceInterval,
    verdict,
    language: lang,
    sentences: sentenceResults,
    analysis,
    weightedContributions: {
      perplexity: round1(contributions.perplexity),
      burstiness: round1(contributions.burstiness),
      vocabularyDiversity: round1(contributions.vocabularyDiversity),
      sentenceLengthVariation: round1(contributions.sentenceLengthVariation),
      transitionFrequency: round1(contributions.transitionFrequency),
      passiveVoiceRatio: round1(contributions.passiveVoiceRatio),
      aiPhraseDensity: round1(contributions.aiPhraseDensity),
      sentenceStartDiversity: round1(contributions.sentenceStartDiversity),
      pronounUsage: round1(contributions.pronounUsage),
      hedgingFrequency: round1(contributions.hedgingFrequency),
      quantifierOveruse: round1(contributions.quantifierOveruse),
      emDashDensity: round1(contributions.emDashDensity),
    },
    weights,
    topAiSentences,
    topHumanSentences,
    foundAiPhrases: aiPhrasesResult.found,
    recommendations,
  };

  // sentenceAvg 的贡献额外暴露（不放在 weightedContributions 里，因为它来自 sentences）
  (report as any).sentenceAvgContribution = round1(sentenceAvgContribution);

  return report;
}

// ── 工具函数 ────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ── UI 辅助 ─────────────────────────────────────────────────────────────

export function getScoreColor(score: number): string {
  if (score >= 65) return 'text-emerald-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-rose-400';
}

export function getScoreBgColor(score: number): string {
  if (score >= 65) return 'bg-emerald-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-rose-500';
}

export function getClassificationColor(c: 'human' | 'maybe' | 'ai'): string {
  switch (c) {
    case 'human':
      return 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300';
    case 'maybe':
      return 'bg-amber-500/15 border-amber-500/40 text-amber-300';
    case 'ai':
      return 'bg-rose-500/15 border-rose-500/40 text-rose-300';
  }
}

export function getVerdictLabel(v: 'human' | 'ai' | 'mixed'): string {
  return v === 'human' ? '人类' : v === 'ai' ? 'AI 生成' : '混合';
}
