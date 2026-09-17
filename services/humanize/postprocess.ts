/**
 * Humanizer Postprocess — 非 LLM 后处理引擎
 *
 * 灵感来源：StealthHumanizer lib/postprocess.ts
 * 适配：前端纯 JS，同步执行；中英文双语
 *
 * 流程：
 *  1. 同义词替换（context-safe）
 *  2. AI 短语替换
 *  3. em-dash 替换
 *  4. 长句拆分
 *  5. Burstiness 注入
 *  6. 句首多样性
 *  7. 缩写注入（英文）
 *  8. 口语化短语注入
 *  9. 段落结构随机化
 *
 * 重要原则（来自 StealthHumanizer 经验）：
 *  - 永不创造"孤立"的句子（避免断裂感）
 *  - 永远保留专有名词 / 缩写 / 全大写
 *  - 同义词替换必须保持原意
 *  - 替换时保持首字母大小写
 */

import { SYNONYMS_EN, SYNONYMS_EN_NEVER_REPLACE } from './data/synonyms.en';
import { SYNONYMS_ZH, SYNONYMS_ZH_NEVER_REPLACE } from './data/synonyms.zh';
import {
  AI_PHRASES_EN,
  AI_PHRASES_ZH,
  TRANSITION_WORDS_EN,
  TRANSITION_WORDS_ZH,
} from './data/aiPhrases';
import {
  CONTRACTIONS_EN,
  EXPANSIONS_EN_TO_CONTRACTION,
  CONTRACTIONS_EN_PREFERRED,
} from './data/contractions.en';
import { CASUAL_INSERTS_EN, CASUAL_INSERTS_ZH } from './data/casualInserts';
import { detectLang } from './detector';

export type Lang = 'zh' | 'en' | 'auto';

export type RewriteLevel = 'light' | 'medium' | 'aggressive' | 'ninja';

export type WritingStyle =
  | 'natural'
  | 'academic'
  | 'professional'
  | 'casual'
  | 'creative'
  | 'technical';

export interface PostprocessOptions {
  level?: RewriteLevel;
  style?: WritingStyle;
  lang?: Lang;
  /** 保留词（不可替换/删除） */
  freezeWords?: string[];
  /** 同义词替换概率（0-100，默认按 level 自动） */
  synonymIntensity?: number;
  /** 是否注入缩写（英文） */
  injectContractions?: boolean;
  /** 是否注入口语短语 */
  injectCasual?: boolean;
  /** 随机种子（默认 Math.random） */
  random?: () => number;
}

interface PostprocessConfig {
  synonymChance: number;
  doAiPhraseReplace: boolean;
  doEmDashReplace: boolean;
  doLongSplit: boolean;
  doBurstiness: boolean;
  doStartDiversity: boolean;
  doContractionInject: boolean;
  doCasualInject: boolean;
  doParagraphRandom: boolean;
  /** 罕见词提频：扫描重复 ≥3 次的内容词并替换为同义词典里的替代词 */
  doRareWordBoost: boolean;
}

function pickConfig(level: RewriteLevel, opts: PostprocessOptions): PostprocessConfig {
  const base: PostprocessConfig = {
    synonymChance: 0,
    doAiPhraseReplace: false,
    doEmDashReplace: false,
    doLongSplit: false,
    doBurstiness: false,
    doStartDiversity: false,
    doContractionInject: false,
    doCasualInject: false,
    doParagraphRandom: false,
    doRareWordBoost: false,
  };
  switch (level) {
    case 'light':
      return {
        ...base,
        synonymChance: 0.20,
        doAiPhraseReplace: false,
        doEmDashReplace: true,
      };
    case 'medium':
      return {
        ...base,
        synonymChance: 0.35,
        doAiPhraseReplace: true,
        doEmDashReplace: true,
        doStartDiversity: true,
        doRareWordBoost: false,
      };
    case 'aggressive':
      return {
        ...base,
        // 提高同义词替换强度：原 0.35 → 0.55，确保强力改写真的能提升词汇多样性
        synonymChance: 0.55,
        doAiPhraseReplace: true,
        doEmDashReplace: true,
        doLongSplit: true,
        doBurstiness: true,
        doStartDiversity: true,
        doContractionInject: true,
        doCasualInject: false,
        doParagraphRandom: true,
        doRareWordBoost: true,
      };
    case 'ninja':
      return {
        ...base,
        synonymChance: 0.65,
        doAiPhraseReplace: true,
        doEmDashReplace: true,
        doLongSplit: true,
        doBurstiness: true,
        doStartDiversity: true,
        doContractionInject: true,
        doCasualInject: true,
        doParagraphRandom: true,
        doRareWordBoost: true,
      };
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────

const rng = (opts?: PostprocessOptions): (() => number) => opts?.random ?? Math.random;
const chance = (p: number, r: () => number): boolean => r() < p;
const pick = <T>(arr: T[], r: () => number): T => arr[Math.floor(r() * arr.length)];

function isInsideQuotes(text: string, index: number): boolean {
  let inQuote = false;
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "'" && (i === 0 || text[i - 1] !== 's') && (i === text.length - 1 || text[i + 1] !== 's')) {
      inQuote = !inQuote;
    }
  }
  return inQuote;
}

function protectFreezeWords(text: string, freezeWords: string[]): { text: string; restore: (s: string) => string } {
  if (!freezeWords.length) {
    return { text, restore: s => s };
  }
  const map = new Map<string, string>();
  let i = 0;
  const out = text;
  // 用零宽字符占位
  const protectedText = freezeWords.reduce((acc, word) => {
    if (!word.trim()) return acc;
    const placeholder = `\u0001FREEZE${i++}\u0002`;
    map.set(placeholder, word);
    return acc.split(word).join(placeholder);
  }, out);
  return {
    text: protectedText,
    restore: (s: string) => {
      let r = s;
      map.forEach((word, ph) => {
        r = r.split(ph).join(word);
      });
      return r;
    },
  };
}

// ── 1. 同义词替换 ────────────────────────────────────────────────────────

function swapSynonyms(text: string, lang: 'zh' | 'en', intensity: number, r: () => number, freeze: string[]): string {
  const dict = lang === 'zh' ? SYNONYMS_ZH : SYNONYMS_EN;
  const never = lang === 'zh' ? SYNONYMS_ZH_NEVER_REPLACE : SYNONYMS_EN_NEVER_REPLACE;
  const freezeSet = new Set(freeze.map(w => w.toLowerCase()));

  // 按 key 长度倒序排，避免短 key 抢先匹配
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);

  let result = text;
  for (const key of keys) {
    if (freezeSet.has(key.toLowerCase())) continue;

    const alts = dict[key];
    if (!alts || !alts.length) continue;

    // 中英不同匹配方式
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = lang === 'en'
      ? new RegExp(`\\b${escapedKey}\\b`, 'gi')
      : new RegExp(escapedKey, 'g');

    result = result.replace(regex, (match, ...args) => {
      // 检查偏移是否在引号内
      const offset = args[args.length - 2] as number;
      if (typeof offset === 'number' && isInsideQuotes(text, offset)) return match;
      if (never.has(match)) return match;
      if (!chance(intensity, r)) return match;

      const alt = pick(alts, r);
      // 保持首字母大小写
      if (/^[A-Z]/.test(match) && /^[a-z]/.test(alt)) {
        return alt.charAt(0).toUpperCase() + alt.slice(1);
      }
      return alt;
    });
  }
  return result;
}

// ── 2. AI 短语替换 ──────────────────────────────────────────────────────

function replaceAiPhrases(text: string, lang: 'zh' | 'en', r: () => number): string {
  const list = lang === 'zh' ? AI_PHRASES_ZH : AI_PHRASES_EN;
  const synDict = lang === 'zh' ? SYNONYMS_ZH : SYNONYMS_EN;

  let result = text;
  for (const phrase of list) {
    // 优先使用同义词表里有映射的替换
    const alts = synDict[phrase];
    if (alts && alts.length) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = lang === 'en'
        ? new RegExp(`\\b${escaped}\\b`, 'gi')
        : new RegExp(escaped, 'g');
      result = result.replace(regex, match => {
        if (!chance(0.8, r)) return match;
        const alt = pick(alts, r);
        if (/^[A-Z]/.test(match) && /^[a-z]/.test(alt)) {
          return alt.charAt(0).toUpperCase() + alt.slice(1);
        }
        return alt;
      });
    }
  }
  return result;
}

// ── 3. em-dash 替换 ─────────────────────────────────────────────────────

function stripEmDashes(text: string, lang: 'zh' | 'en'): string {
  // 数字范围保护：2020-2025 → 2020–2025
  const RANGE_PLACEHOLDER = '\u0001RANGE\u0001';
  let result = text.replace(/(\d)\s*[–—]\s*(\d)/g, `$1${RANGE_PLACEHOLDER}$2`);

  // em-dash 后紧跟标点 → 删除 em-dash
  result = result.replace(/\s*[–—]\s*(?=[.!?,;:)\]"'…])/g, '');
  // 句首 em-dash → 删除
  result = result.replace(/(^|[\n.!?]["')\]]?\s+)[–—]\s*/gm, '$1');
  // 其余 em-dash → 逗号
  result = result.replace(/\s*[–—]\s*/g, lang === 'zh' ? '，' : ', ');

  // 中文 em-dash 通常是「，」或句号，转为逗号
  if (lang === 'zh') {
    result = result.replace(/，\s*，/g, '，');
  }
  return result.replace(new RegExp(RANGE_PLACEHOLDER, 'g'), '–');
}

// ── 4. 长句拆分 ─────────────────────────────────────────────────────────

function splitLongSentences(text: string, lang: 'zh' | 'en', r: () => number): string {
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const result: string[] = [];
  const MIN_WORDS_ZH = 35; // 中文 35 字符以上认为长句
  const MIN_WORDS_EN = 28;

  for (const sentence of sentences) {
    const len = lang === 'zh' ? sentence.length : sentence.split(/\s+/).length;
    const tooLong = lang === 'zh' ? len > MIN_WORDS_ZH : len > MIN_WORDS_EN;

    if (tooLong && chance(0.35, r)) {
      const split = trySplitSentence(sentence, lang, r);
      if (split) {
        result.push(split);
        continue;
      }
    }
    result.push(sentence);
  }
  return result.join(lang === 'zh' ? '' : ' ');
}

function trySplitSentence(sentence: string, lang: 'zh' | 'en', r: () => number): string | null {
  if (lang === 'zh') {
    // 找中部逗号作为拆点
    const commas = [...sentence.matchAll(/[，]/g)].filter(m => {
      if (m.index === undefined) return false;
      const ratio = m.index / sentence.length;
      return ratio > 0.3 && ratio < 0.7;
    });
    if (!commas.length) return null;
    const pickIdx = pick(commas, r);
    if (!pickIdx.index) return null;
    const first = sentence.slice(0, pickIdx.index).replace(/[，,]$/, '');
    const second = sentence.slice(pickIdx.index + 1).trim();
    if (second.length < 4) return null;
    return `${first}。${second}`;
  }
  // 英文：找中部连接词 "and/but/or/which/that/however"
  const breakPatterns = [
    /,\s+(?:and|but|or|while)\s+/gi,
    /,\s+(?:which|that|where|when)\s+/gi,
    /,\s+(?:however|therefore|moreover|furthermore)\s+/gi,
  ];
  const candidates: Array<{ index: number; length: number }> = [];
  for (const pattern of breakPatterns) {
    for (const m of sentence.matchAll(pattern)) {
      if (m.index === undefined) continue;
      const ratio = m.index / sentence.length;
      if (ratio > 0.3 && ratio < 0.75) {
        candidates.push({ index: m.index, length: m[0].length });
      }
    }
  }
  if (!candidates.length) {
    // 退化：找中部逗号
    const commas = [...sentence.matchAll(/,\s+/g)].filter(m => {
      if (m.index === undefined) return false;
      const ratio = m.index / sentence.length;
      return ratio > 0.3 && ratio < 0.7;
    });
    if (!commas.length) return null;
    const c = pick(commas, r);
    if (!c.index) return null;
    const first = sentence.slice(0, c.index).replace(/[,.]$/, '');
    const second = sentence.slice(c.index + c[0].length);
    const secondCap = second.charAt(0).toUpperCase() + second.slice(1);
    return `${first}. ${secondCap}`;
  }
  const picked = pick(candidates, r);
  const first = sentence.slice(0, picked.index).replace(/[,.]$/, '');
  const second = sentence.slice(picked.index + picked.length).trim();
  if (second.length < 4) return null;
  const secondCap = second.charAt(0).toUpperCase() + second.slice(1);
  return `${first}. ${secondCap}`;
}

// ── 5. Burstiness 注入（短句合并制造方差） ──────────────────────────────

function injectBurstiness(text: string, lang: 'zh' | 'en', r: () => number): string {
  const paragraphs = text.split(/\n\s*\n+/);
  const out: string[] = [];

  for (const para of paragraphs) {
    if (!para.trim()) {
      out.push(para);
      continue;
    }
    const sentences = para.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
    if (sentences.length < 3) {
      out.push(para);
      continue;
    }
    const lengths = sentences.map(s => (lang === 'zh' ? s.length : s.split(/\s+/).length));

    // 检测是否过于均匀
    let isUniform = true;
    for (let i = 0; i < lengths.length - 1; i++) {
      if (Math.abs(lengths[i] - lengths[i + 1]) > 8) {
        isUniform = false;
        break;
      }
    }

    if (isUniform && chance(0.7, r)) {
      // 合并两个相邻的短句制造方差
      for (let i = 0; i < sentences.length - 1; i++) {
        const len1 = lang === 'zh' ? sentences[i].length : sentences[i].split(/\s+/).length;
        const len2 = lang === 'zh' ? sentences[i + 1].length : sentences[i + 1].split(/\s+/).length;
        if (len1 < 20 && len2 < 20) {
          if (lang === 'zh') {
            // 中文：用句号合并（保留两句话，但插入停顿）
            const first = sentences[i].replace(/[。！？.!?]+$/, '');
            const second = sentences[i + 1].charAt(0);
            sentences.splice(i, 2, `${first}。${second}${sentences[i + 1].slice(1)}`);
          } else {
            const first = sentences[i].replace(/[.!?]+$/, '');
            const second = sentences[i + 1].charAt(0).toLowerCase() + sentences[i + 1].slice(1);
            sentences.splice(i, 2, `${first}; ${second}`);
          }
          break;
        }
      }
    }
    out.push(sentences.join(lang === 'zh' ? '' : ' '));
  }
  return out.join('\n\n');
}

// ── 6. 句首多样性（避免连续两句同句首） ─────────────────────────────────

function diversifySentenceStarts(text: string, lang: 'zh' | 'en', r: () => number): string {
  const paragraphs = text.split(/\n\s*\n+/);
  const out: string[] = [];

  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
    if (sentences.length < 2) {
      out.push(para);
      continue;
    }
    const starts = sentences.map(s =>
      lang === 'zh' ? s.trim().slice(0, 2) : s.trim().split(/\s+/).slice(0, 1).join(' ').toLowerCase()
    );
    // 检测连续重复
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] === starts[i - 1] && chance(0.5, r)) {
        // 给第 i 句加一个口语化短语开头（保持原意，不引入新句）
        const insert = lang === 'zh' ? pick(CASUAL_INSERTS_ZH, r) : pick(CASUAL_INSERTS_EN, r);
        if (insert) {
          // 只插入到句首，逗号分隔
          if (lang === 'zh') {
            sentences[i] = `${insert}，${sentences[i]}`;
          } else {
            sentences[i] = `${insert}, ${sentences[i].charAt(0).toLowerCase() + sentences[i].slice(1)}`;
          }
        }
        starts[i] = sentences[i].slice(0, 4); // 重新计算
      }
    }
    out.push(sentences.join(lang === 'zh' ? '' : ' '));
  }
  return out.join('\n\n');
}

// ── 7. 缩写注入（英文） ─────────────────────────────────────────────────

function injectContractions(text: string, r: () => number): string {
  let result = text;
  let injected = 0;
  // 最多注入 5 个，避免过度
  for (const expanded of CONTRACTIONS_EN.map(c => c[1])) {
    if (injected >= 5) break;
    if (!chance(0.4, r)) continue;
    const regex = new RegExp(`\\b${expanded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(result)) {
      // 优先使用 PREFERRED 列表
      let shortForm = '';
      for (const p of CONTRACTIONS_EN_PREFERRED) {
        if (EXPANSIONS_EN_TO_CONTRACTION.get(p.toLowerCase()) === expanded.toLowerCase()) {
          shortForm = p;
          break;
        }
      }
      if (!shortForm) {
        for (const [s, e] of CONTRACTIONS_EN) {
          if (e.toLowerCase() === expanded.toLowerCase()) {
            shortForm = s;
            break;
          }
        }
      }
      if (shortForm) {
        result = result.replace(regex, shortForm);
        injected++;
      }
    }
  }
  return result;
}

// ── 8. 罕见词提频（强力/忍者档专用） ────────────────────────────────────

/**
 * 解决"强力改写后词汇多样性反而下降"的问题：
 * LLM 输出的英文文本常常反复使用相同的"安全"用词（think, important, thing, really, very），
 * 导致 TTR（type-token ratio）和 contentWordFreq 偏低 → perplexity 低。
 *
 * 本步骤扫描文本里重复出现 ≥3 次的"非功能词"，并把它们中的 30-50% 替换为
 * 同义词典中的替代词，确保 TTR 提升。
 */
function rareWordBoost(text: string, lang: 'zh' | 'en', r: () => number, freeze: string[]): string {
  const dict = lang === 'zh' ? SYNONYMS_ZH : SYNONYMS_EN;
  const never = lang === 'zh' ? SYNONYMS_ZH_NEVER_REPLACE : SYNONYMS_EN_NEVER_REPLACE;
  const freezeSet = new Set(freeze.map(w => w.toLowerCase()));

  // 英文按词统计，中文按字统计
  let words: string[];
  if (lang === 'en') {
    words = text.replace(/[^A-Za-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
  } else {
    words = text.replace(/[^\u4e00-\u9fff]/g, '').split('').filter(Boolean);
  }
  if (words.length < 20) return text;

  // 频次统计
  const freq: Record<string, number> = {};
  words.forEach(w => (freq[w] = (freq[w] || 0) + 1));

  // 找出 ≥3 次的词（且不在功能词表/冻结词表）
  const STOP = lang === 'en'
    ? new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'what', 'which', 'who', 'as', 'if', 'than', 'then', 'so', 'not', 'no', 'from', 'into', 'onto', 'upon', 'about', 'also', 'just', 'only', 'even', 'still', 'very', 'much', 'more', 'most', 'when', 'where', 'why', 'how'])
    : new Set(['的', '了', '是', '在', '和', '与', '或', '但', '而', '也', '都', '就', '还', '我', '你', '他', '她', '它', '们', '这', '那', '有', '没', '不', '很', '对', '从', '到', '为', '上', '下', '里', '外', '中', '说', '讲']);

  const repeatedWords = Object.entries(freq)
    .filter(([w, c]) => c >= 3 && !STOP.has(w) && !freezeSet.has(w) && dict[w] && dict[w].length > 0 && !never.has(w))
    .sort((a, b) => b[1] - a[1]); // 高频优先

  if (!repeatedWords.length) return text;

  // 只对前 8 个最高频词做提频替换（避免过度）
  const targets = repeatedWords.slice(0, 8);
  let result = text;

  for (const [word] of targets) {
    if (!chance(0.5, r)) continue; // 50% 概率真替换
    const alts = dict[word];
    if (!alts || !alts.length) continue;
    const alt = pick(alts, r);

    if (lang === 'en') {
      // 英文：第 2 次及之后的出现换成同义词（保留首次，避免句法怪异）
      const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      let hit = 0;
      result = result.replace(regex, (match) => {
        hit++;
        if (hit === 1) return match; // 首次保留
        // 大小写匹配
        if (/^[A-Z]/.test(match)) return alt.charAt(0).toUpperCase() + alt.slice(1);
        return alt;
      });
    } else {
      // 中文：第 2 次及之后的字换成同义字（首次保留）
      let hit = 0;
      result = result.split('').map(ch => {
        if (ch === word) {
          hit++;
          return hit === 1 ? ch : alt;
        }
        return ch;
      }).join('');
    }
  }
  return result;
}

// ── 9. 段落随机化（少量） ──────────────────────────────────────────────

function randomizeParagraphs(text: string, lang: 'zh' | 'en', r: () => number): string {
  const paragraphs = text.split(/\n\s*\n+/);
  if (paragraphs.length <= 1) return text;
  const out: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const sentences = p.split(/(?<=[.!?。！？])\s+/).filter(Boolean);

    // 20% 概率：拆段（如果段落 ≥4 句）
    if (sentences.length >= 4 && chance(0.20, r)) {
      const splitPoint = 1 + Math.floor(r() * (sentences.length - 2));
      out.push(sentences.slice(0, splitPoint).join(lang === 'zh' ? '' : ' '));
      out.push(sentences.slice(splitPoint).join(lang === 'zh' ? '' : ' '));
      continue;
    }
    out.push(p);
  }
  return out.join('\n\n');
}

// ── 9. 大小写规范化 ─────────────────────────────────────────────────────

function normalizeCapitalization(text: string, lang: 'zh' | 'en'): string {
  if (lang === 'zh') return text; // 中文无大小写
  // 句首大写：检测到 ". word" → ". Word"
  // 跳过缩写 e.g. i.e. U.S.
  const ABBREV_TAIL = /(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|cf|approx|Inc|Ltd|Co|Corp|No|U\.S|U\.K)\.$/;
  return text.replace(
    /(^|[.!?]["')\]]?\s+|\n\s*)([a-z])/g,
    (match, prefix: string, ch: string, offset: number) => {
      const before = text.slice(0, offset + prefix.length);
      if (ABBREV_TAIL.test(before)) return match;
      // 检查前一个词是否是常见缩写
      const lastWordMatch = before.match(/\b([A-Za-z]+)\.\s*$/);
      if (lastWordMatch) {
        const w = lastWordMatch[1];
        if (w.length <= 3 && w.toUpperCase() === w) return match; // 缩写
      }
      return prefix + ch.toUpperCase();
    }
  );
}

// ── 主入口 ──────────────────────────────────────────────────────────────

export function postprocess(text: string, options: PostprocessOptions = {}): string {
  if (!text || !text.trim()) return text;

  const lang: 'zh' | 'en' = options.lang && options.lang !== 'auto' ? options.lang : detectLang(text);
  const level = options.level ?? 'medium';
  const config = pickConfig(level, options);
  const freeze = options.freezeWords ?? [];
  const r = rng(options);

  // 保护保留词
  const protected1 = protectFreezeWords(text, freeze);
  let result = protected1.text;

  // 1. 同义词替换（按语言）
  if (config.synonymChance > 0) {
    result = swapSynonyms(result, lang, options.synonymIntensity ?? config.synonymChance, r, freeze);
  }

  // 2. AI 短语替换
  if (config.doAiPhraseReplace) {
    result = replaceAiPhrases(result, lang, r);
  }

  // 3. em-dash 替换
  if (config.doEmDashReplace) {
    result = stripEmDashes(result, lang);
  }

  // 4. 长句拆分
  if (config.doLongSplit) {
    result = splitLongSentences(result, lang, r);
  }

  // 5. Burstiness 注入
  if (config.doBurstiness) {
    result = injectBurstiness(result, lang, r);
  }

  // 6. 句首多样性
  if (config.doStartDiversity) {
    result = diversifySentenceStarts(result, lang, r);
  }

  // 7. 缩写注入（英文）
  if (config.doContractionInject && lang === 'en') {
    result = injectContractions(result, r);
  }

  // 7.5 罕见词提频（强力/忍者档专用，解决 LLM 输出词汇多样性偏低的问题）
  if (config.doRareWordBoost) {
    result = rareWordBoost(result, lang, r, freeze);
  }

  // 8. 段落随机化
  if (config.doParagraphRandom) {
    result = randomizeParagraphs(result, lang, r);
  }

  // 9. 大小写规范化
  result = normalizeCapitalization(result, lang);

  // 恢复保留词
  return protected1.restore(result);
}
