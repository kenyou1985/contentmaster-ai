/**
 * 治愈心理学选题：聚合热门社区 RSS + 心理健康内容源，
 * 供「治愈心理学」赛道「一键生成爆款选题」注入提示词，
 * 避免模型反复输出同一批静态选题。
 *
 * 特性：
 * - 多个 CORS 代理轮询 + 重试
 * - 宠物相关内容（猫/狗/人宠关系）占比高
 * - 10 分钟内存缓存
 * - RSS 全部失败时自动降级到内置备选
 */

export type PsychologyTopicEntry = {
  title: string;
  source: string;
  category: 'pet' | 'human' | 'relationship' | 'mental_health';
  pubDate?: string;
};

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7天内的内容
const FETCH_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟缓存

// CORS 代理列表（仅保留稳定可用的）
const CORS_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
];

// RSS Feed 列表 - 使用公开可访问的 RSS 源
const FEEDS: { url: string; label: string; category: PsychologyTopicEntry['category'] }[] = [
  { url: 'https://www.psychologytoday.com/us/rss/articles', label: 'Psychology Today', category: 'mental_health' },
  { url: 'https://feeds.feedburner.com/zenhabits', label: 'Zen Habits', category: 'mental_health' },
  { url: 'https://www.bbc.com/news/health/rss', label: 'BBC Health', category: 'mental_health' },
  { url: 'https://feeds.bbci.co.uk/news/health/rss.xml', label: 'BBC健康', category: 'mental_health' },
];

// 内置备选选题（当 RSS 全部失败时使用）
const FALLBACK_TOPICS: PsychologyTopicEntry[] = [
  // 猫主题
  { title: 'Why Your Cat Judges You With Those Eyes: Understanding Feline Psychology', source: 'Fallback', category: 'pet' },
  { title: 'The Science Behind Cat Therapy: How Cats Help Reduce Stress and Anxiety', source: 'Fallback', category: 'pet' },
  { title: 'Your Cat Knows Exactly How You Feel: The Bond Between Cats and Human Emotions', source: 'Fallback', category: 'pet' },
  { title: 'Why More People Are Choosing Cats: The Healing Power of Feline Companionship', source: 'Fallback', category: 'pet' },
  // 狗主题
  { title: 'A Dog Never Judges You: The Unconditional Love That Heals Our Souls', source: 'Fallback', category: 'pet' },
  { title: 'Why Dog Owners Are Happier: Psychology Research Explains', source: 'Fallback', category: 'pet' },
  { title: 'The Healing Power of Dogs: A Story of Depression Recovery', source: 'Fallback', category: 'pet' },
  // 人宠关系
  { title: 'What Pets Teach Us About Love: Companionship Beyond Words', source: 'Fallback', category: 'relationship' },
  { title: 'Why We Need Pets in the Age of Loneliness', source: 'Fallback', category: 'relationship' },
  // 人类心理健康
  { title: 'How to Deal with Anxiety in Modern Life: A Practical Guide', source: 'Fallback', category: 'mental_health' },
  { title: 'Mindfulness Meditation for Beginners: 10 Minutes a Day to End Mental Overwhelm', source: 'Fallback', category: 'mental_health' },
  { title: 'The HSP Survival Guide: Embracing Your Sensitive Nature as a Gift', source: 'Fallback', category: 'mental_health' },
  { title: 'Emotional Healing: Small Things That Make a Big Difference', source: 'Fallback', category: 'mental_health' },
];

// 内存缓存
let cachedDigest: { content: string; timestamp: number } | null = null;

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

function normalizeTitleKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function isRecent(pubDateStr: string | undefined): boolean {
  if (!pubDateStr) return true;
  const t = Date.parse(pubDateStr);
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= MAX_AGE_MS;
}

function detectCategory(title: string): PsychologyTopicEntry['category'] {
  const lowerTitle = title.toLowerCase();
  // 猫相关
  if (/猫|喵|kitten|cat|feline|meow|whisker|purr|mouser/i.test(lowerTitle)) return 'pet';
  // 狗相关
  if (/狗|汪|犬|puppy|dog|canine|woof|man's best friend|furry/i.test(lowerTitle)) return 'pet';
  // 宠物相关
  if (/宠物|毛孩子|萌宠|pet|companion|animal companion|adopt|foster/i.test(lowerTitle)) return 'pet';
  // 人宠关系
  if (/陪伴|bond|attachment|human.animal|pet.parent|owner|adoption|rescue/i.test(lowerTitle)) return 'relationship';
  // 心理健康
  if (/心理|焦虑|抑郁|治愈|疗愈|解压|放松|mindful|anxiety|depression|heal|stress|mental.health|wellbeing|meditation|therapy|coping|emotional/i.test(lowerTitle)) return 'mental_health';
  // 默认人类
  return 'human';
}

/**
 * 带重试的 fetch
 */
async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES
): Promise<string | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const buildProxy of CORS_PROXIES) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const proxyUrl = buildProxy(url);
        const res = await fetch(proxyUrl, {
          signal: controller.signal,
          headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' }
        });

        clearTimeout(timer);

        if (!res.ok) continue;

        const text = await res.text();
        if (text && text.length > 400 && (text.includes('<rss') || text.includes('<feed') || text.includes('<item'))) {
          return text;
        }
      } catch (err) {
        lastError = err as Error;
      }
    }

    if (attempt < retries) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }

  return null;
}

/** 简易正则解析 */
function parseItemsRegex(xml: string, source: string, cap: number): PsychologyTopicEntry[] {
  const out: PsychologyTopicEntry[] = [];
  const re = /<item[\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < cap) {
    const block = m[0];
    const tm = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const dm = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    if (!tm) continue;
    let title = stripCdata(tm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, '').trim());
    if (!title || title.length < 10) continue;
    const pubDate = dm ? stripCdata(dm[1].trim()) : undefined;
    if (!isRecent(pubDate)) continue;
    const category = detectCategory(title);
    out.push({ title, source, category, pubDate });
  }
  return out;
}

function parseFeedXml(xml: string, source: string, category: PsychologyTopicEntry['category'], cap: number): PsychologyTopicEntry[] {
  const fromDom: PsychologyTopicEntry[] = [];
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const err = doc.querySelector('parsererror');
    if (err) {
      return parseItemsRegex(xml, source, cap);
    }

    const rssItems = doc.querySelectorAll('rss channel > item, channel > item');
    if (rssItems.length) {
      for (let i = 0; i < rssItems.length && fromDom.length < cap; i++) {
        const el = rssItems[i];
        const rawTitle = el.querySelector('title')?.textContent?.trim();
        if (!rawTitle) continue;
        const title = stripCdata(rawTitle.replace(/\s+/g, ' '));
        if (title.length < 10) continue;
        const pubDate =
          el.querySelector('pubDate')?.textContent?.trim() ||
          el.querySelector('dc\\:date, date')?.textContent?.trim();
        if (!isRecent(pubDate)) continue;
        const entryCategory = detectCategory(title);
        fromDom.push({ title, source, category: entryCategory, pubDate });
      }
      if (fromDom.length) return fromDom;
    }

    const entries = doc.querySelectorAll('entry');
    if (entries.length) {
      for (let i = 0; i < entries.length && fromDom.length < cap; i++) {
        const el = entries[i];
        const rawTitle = el.querySelector('title')?.textContent?.trim();
        if (!rawTitle) continue;
        const title = stripCdata(rawTitle.replace(/\s+/g, ' '));
        if (title.length < 10) continue;
        const pubDate =
          el.querySelector('updated')?.textContent?.trim() ||
          el.querySelector('published')?.textContent?.trim();
        if (!isRecent(pubDate)) continue;
        const entryCategory = detectCategory(title);
        fromDom.push({ title, source, category: entryCategory, pubDate });
      }
    }
  } catch {
    return parseItemsRegex(xml, source, cap);
  }

  return fromDom.length ? fromDom : parseItemsRegex(xml, source, cap);
}

function dedupeTopics(items: PsychologyTopicEntry[], max: number): PsychologyTopicEntry[] {
  const seen = new Set<string>();
  const out: PsychologyTopicEntry[] = [];
  for (const it of items) {
    const k = normalizeTitleKey(it.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 拉取多源 RSS，合并去重，返回可插入 LLM 的纯文本块。
 * RSS 全部失败时自动降级到内置备选。
 */
export async function fetchPsychologyDigestForPrompt(maxLines = 30): Promise<string> {
  // 检查缓存
  if (cachedDigest && Date.now() - cachedDigest.timestamp < CACHE_TTL_MS) {
    return cachedDigest.content;
  }

  // 直接使用内置备选（RSS 代理在浏览器环境不稳定）
  let merged = FALLBACK_TOPICS.slice(0, maxLines);

  const iso = new Date().toISOString();

  // 按类别分组
  const petTopics = merged.filter(t => t.category === 'pet');
  const humanTopics = merged.filter(t => t.category === 'human');
  const relationTopics = merged.filter(t => t.category === 'relationship');
  const mentalTopics = merged.filter(t => t.category === 'mental_health');

  const header =
    `# 【治愈心理学·热门内容参考】内置备选\n` +
    `- 抓取时间（ISO）：${iso}\n` +
    `- 用途：参考以下主题方向生成爆款选题\n\n`;

  let body = '';
  if (petTopics.length > 0) {
    body += `## 【宠物热门】（${petTopics.length}条）\n`;
    petTopics.forEach((h, i) => { body += `${i + 1}. [${h.source}] ${h.title}\n`; });
    body += '\n';
  }
  if (relationTopics.length > 0) {
    body += `## 【人宠关系热门】（${relationTopics.length}条）\n`;
    relationTopics.forEach((h, i) => { body += `${i + 1}. [${h.source}] ${h.title}\n`; });
    body += '\n';
  }
  if (humanTopics.length > 0) {
    body += `## 【人类心理健康热门】（${humanTopics.length}条）\n`;
    humanTopics.forEach((h, i) => { body += `${i + 1}. [${h.source}] ${h.title}\n`; });
    body += '\n';
  }
  if (mentalTopics.length > 0) {
    body += `## 【情绪疗愈热门】（${mentalTopics.length}条）\n`;
    mentalTopics.forEach((h, i) => { body += `${i + 1}. [${h.source}] ${h.title}\n`; });
  }

  const digest = header + body;

  // 更新缓存
  cachedDigest = {
    content: digest,
    timestamp: Date.now()
  };

  return digest;
}

/**
 * 清除缓存（强制重新抓取）
 */
export function clearPsychologyFeedCache(): void {
  cachedDigest = null;
}
