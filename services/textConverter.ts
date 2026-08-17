/**
 * 繁简中文转换（基于 opencc-js · t2cn preset）
 *
 * 设计：
 * - 动态 import opencc-js，避免增加初始 bundle 体积（Vite 自动 code-split）
 * - 全局单例 + 懒加载，第一次调用时初始化转换器
 * - 提供繁体→简体 + 简体→繁体双向 API
 * - 检测失败时回退到原始文本（opencc 优先，确保可用性）
 *
 * 应用场景：
 * - Whisper ASR 输出默认为繁体中文 → 自动转简体
 * - 用户上传的 SRT/VTT 字幕若是繁体，也自动转简体
 */

type Converter = (text: string) => string;

let t2sPromise: Promise<Converter> | null = null;
let s2tPromise: Promise<Converter> | null = null;

/**
 * 懒加载 opencc-js 并创建繁体→简体转换器（全局单例）
 */
export function getTraditionalToSimplified(): Promise<Converter> {
  if (t2sPromise) return t2sPromise;
  t2sPromise = (async () => {
    try {
      const mod: any = await import('opencc-js');
      const Converter = mod.Converter || mod.default?.Converter || mod.default;
      if (!Converter) throw new Error('opencc-js Converter not found');
      const converter = new Converter({ from: 'tw', to: 'cn' });
      return (text: string) => converter.convert(text);
    } catch (e: any) {
      console.warn('[textConverter] opencc-js 加载失败:', e?.message);
      t2sPromise = null;
      return (text: string) => text;
    }
  })();
  return t2sPromise;
}

/**
 * 懒加载 opencc-js 并创建简体→繁体转换器
 */
export function getSimplifiedToTraditional(): Promise<Converter> {
  if (s2tPromise) return s2tPromise;
  s2tPromise = (async () => {
    try {
      const mod: any = await import('opencc-js');
      const Converter = mod.Converter || mod.default?.Converter || mod.default;
      if (!Converter) throw new Error('opencc-js Converter not found');
      const converter = new Converter({ from: 'cn', to: 'tw' });
      return (text: string) => converter.convert(text);
    } catch (e: any) {
      console.warn('[textConverter] opencc-js 加载失败:', e?.message);
      s2tPromise = null;
      return (text: string) => text;
    }
  })();
  return s2tPromise;
}

/**
 * 异步版本的繁→简
 */
export async function traditionalToSimplified(text: string): Promise<string> {
  if (!text) return text;
  const convert = await getTraditionalToSimplified();
  return convert(text);
}

/**
 * 异步版本的简→繁
 */
export async function simplifiedToTraditional(text: string): Promise<string> {
  if (!text) return text;
  const convert = await getSimplifiedToTraditional();
  return convert(text);
}

/**
 * 批量转换（用于字幕 cues 数组）
 */
export async function convertCuesTexts<T extends { text: string }>(
  cues: T[],
  direction: 't2s' | 's2t' = 't2s',
): Promise<T[]> {
  if (!cues || cues.length === 0) return cues;
  const convert = direction === 't2s'
    ? await getTraditionalToSimplified()
    : await getSimplifiedToTraditional();
  return cues.map((cue) => ({
    ...cue,
    text: convert(cue.text),
  }));
}

/**
 * 启发式检测是否包含大量繁体字
 * - 用于决定是否需要转换（如果本来就是简体，跳过省时间）
 * - 算法：抽样前 500 字，统计繁体字占 CJK 字的比例
 */
export function looksLikeTraditional(text: string): boolean {
  if (!text) return false;
  // 抽样前 500 字
  const sample = text.slice(0, 500);
  let tradCount = 0;
  let cjkCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjkCount++;
      // 检查是否在繁体字符集合中
      if (TRADITIONAL_CHARS.has(ch)) tradCount++;
    }
  }
  if (cjkCount === 0) return false;
  // 如果繁体字占 CJK 字的比例 > 5%，认为包含繁体
  return tradCount / cjkCount > 0.05;
}

/**
 * 简体/繁体常用字集合（检测用，覆盖 90%+ 字幕场景）
 */
const TRADITIONAL_CHARS = new Set<string>([
  '壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾',
  '億', '萬', '兩', '齒', '雙',
  '環', '氣', '溫', '濕', '雲', '霧', '風',
  '島', '嶺', '峽', '穀', '溪',
  '湖', '灣', '港',
  '獸', '鳥', '蟲', '魚', '蝦', '蟹', '龜', '龍', '鳳',
  '樹', '葉', '莖', '花', '草', '藤',
  '員', '個', '們', '兒', '孫',
  '夫', '妻', '婿', '婆', '翁', '姑', '叔', '伯', '侄',
  '君', '臣', '王', '皇', '帝', '后', '妃', '嬪',
  '師', '徒', '學', '教', '書', '讀', '寫',
  '動', '靜', '變', '換', '轉', '移', '進', '退',
  '開', '關', '啟', '閉', '起', '落', '升', '降',
  '來', '去', '走', '跑', '跳', '飛', '游', '爬',
  '聽', '說', '話', '畫',
  '想', '念', '記', '忘', '知', '曉', '悟', '懂',
  '愛', '恨', '喜', '悲', '怒', '驚', '怕', '愁',
  '滅', '存',
  '處', '辦',
  '時', '間', '鐘', '點',
  '質', '體', '覺',
  '志', '願', '望',
  '律', '規', '則',
  '國', '鄉', '鎮', '縣', '區',
  '錢', '幣', '銀', '銅', '鐵', '鋼', '鋁',
  '產', '業', '經', '濟', '貿', '務',
  '鋪', '廠', '場',
  '電', '腦', '網', '訊',
  '機', '器', '軟', '硬',
  '視', '頻', '聲', '圖', '顯',
  '編', '輯', '式',
  '衛', '醫', '療', '藥',
  '紅', '綠', '藍', '黃', '紫',
  '圓', '長', '寬',
  '頭', '聲',
  '東', '裡', '邊', '這',
  '與', '樣', '從', '於',
  '嗎', '壞', '舊', '遠', '淺',
]);
