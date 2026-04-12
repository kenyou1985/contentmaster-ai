/**
 * 治愈心理学选题：聚合热门社区 RSS + 心理健康内容源，
 * 供「治愈心理学」赛道「一键生成爆款选题」注入提示词，
 * 避免模型反复输出同一批静态选题。
 *
 * 增强版特性：
 * - 多个 CORS 代理轮询 + 重试
 * - 多类型来源：微博、知乎、小红书、心理健康网站等
 * - 宠物相关内容（猫/狗/人宠关系）占比高
 * - 10 分钟内存缓存
 */

export type PsychologyTopicEntry = {
  title: string;
  source: string;
  category: 'pet' | 'human' | 'relationship' | 'mental_health';
  pubDate?: string;
};

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7天内的内容
const FETCH_TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟缓存

// CORS 代理列表
const CORS_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u: string) => `https://yacdn.org/proxy/${encodeURIComponent(u)}`,
];

// RSS Feed 列表 - 治愈心理学/宠物/情感相关
const FEEDS: { url: string; label: string; category: PsychologyTopicEntry['category'] }[] = [
  // 宠物相关
  { url: 'https://rsshub.app/weibo/user/1195230310', label: '微博宠物博主', category: 'pet' }, // 回忆专用小马甲
  { url: 'https://rsshub.app/weibo/user/1794997701', label: '微博萌宠', category: 'pet' }, // 宠物类博主
  { url: 'https://rsshub.app/zhihu/daily', label: '知乎日报', category: 'human' },
  { url: 'https://rsshub.app/zhihu/topstory/hot-list', label: '知乎热榜', category: 'human' },
  { url: 'https://rsshub.app/xiaohongshu/user/5664de0300000001200ab0f9', label: '小红书宠物', category: 'pet' },
  { url: 'https://rsshub.app/douyin/user/MS4wLjABAAAAY6eDn1qRYq', label: '抖音宠物', category: 'pet' },
];

// 内置备选选题（当 RSS 全部失败时使用）
const FALLBACK_TOPICS: PsychologyTopicEntry[] = [
  // 猫主题
  { title: '猫咪这些行为，是在偷偷爱你：读懂喵星人的无声告白', source: 'Fallback', category: 'pet' },
  { title: '为什么越来越多人选择养猫？这是我听过最治愈的答案', source: 'Fallback', category: 'pet' },
  { title: '猫咪心理学：你的猫其实比你想象的更懂你', source: 'Fallback', category: 'pet' },
  { title: '治愈系猫咪vlog：独居女孩与三只猫的温暖日常', source: 'Fallback', category: 'pet' },
  { title: '猫咪对人类的疗愈力量：科学研究证实的结果', source: 'Fallback', category: 'pet' },
  // 狗主题
  { title: '狗狗的忠诚远超你想象：它们爱你比你知道的更深', source: 'Fallback', category: 'pet' },
  { title: '为什么养狗的人更快乐？心理学研究给出答案', source: 'Fallback', category: 'pet' },
  { title: '金毛犬的治愈力量：一个抑郁症患者与狗狗的故事', source: 'Fallback', category: 'pet' },
  // 人宠关系
  { title: '宠物教会我的那些人生道理：陪伴是最长情的告白', source: 'Fallback', category: 'relationship' },
  { title: '独居时代，为什么我们需要宠物陪伴？', source: 'Fallback', category: 'relationship' },
  { title: '从心理学角度看：为什么撸猫撸狗能治愈心灵？', source: 'Fallback', category: 'relationship' },
  // 人类心理健康
  { title: '当代年轻人的情绪困境：如何与焦虑和解', source: 'Fallback', category: 'mental_health' },
  { title: '心理咨询师分享：那些治愈来访者的小事', source: 'Fallback', category: 'mental_health' },
  { title: '正念冥想入门：每天10分钟，告别精神内耗', source: 'Fallback', category: 'mental_health' },
  { title: '高敏感人群的生存指南：接纳自己的敏感天赋', source: 'Fallback', category: 'mental_health' },
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
  if (/猫|喵|kitten|cat|feline|meow/i.test(lowerTitle)) return 'pet';
  // 狗相关
  if (/狗|汪|犬|puppy|dog|canine|woof/i.test(lowerTitle)) return 'pet';
  // 宠物相关
  if (/宠物|毛孩子|萌宠|pet|companion|毛孩子|毛球/i.test(lowerTitle)) return 'pet';
  // 人宠关系
  if (/陪伴|铲屎|养宠|主人|宠主|训宠/i.test(lowerTitle)) return 'relationship';
  // 心理健康
  if (/心理|焦虑|抑郁|治愈|疗愈|解压|放松|mindful|anxiety|depression|heal/i.test(lowerTitle)) return 'mental_health';
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

  console.warn(`[PsychologyFeed] All proxies failed for ${url}:`, lastError?.message);
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
      rssItems.forEach((el, i) => {
        if (i >= cap) return;
        const rawTitle = el.querySelector('title')?.textContent?.trim();
        if (!rawTitle) return;
        const title = stripCdata(rawTitle.replace(/\s+/g, ' '));
        if (title.length < 10) return;
        const pubDate =
          el.querySelector('pubDate')?.textContent?.trim() ||
          el.querySelector('dc\\:date, date')?.textContent?.trim();
        if (!isRecent(pubDate)) continue;
        const entryCategory = detectCategory(title);
        fromDom.push({ title, source, category: entryCategory, pubDate });
      });
      if (fromDom.length) return fromDom;
    }

    const entries = doc.querySelectorAll('entry');
    if (entries.length) {
      entries.forEach((el, i) => {
        if (i >= cap) return;
        const rawTitle = el.querySelector('title')?.textContent?.trim();
        if (!rawTitle) return;
        const title = stripCdata(rawTitle.replace(/\s+/g, ' '));
        if (title.length < 10) return;
        const pubDate =
          el.querySelector('updated')?.textContent?.trim() ||
          el.querySelector('published')?.textContent?.trim();
        if (!isRecent(pubDate)) continue;
        const entryCategory = detectCategory(title);
        fromDom.push({ title, source, category: entryCategory, pubDate });
      });
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
 */
export async function fetchPsychologyDigestForPrompt(maxLines = 30): Promise<string> {
  // 检查缓存
  if (cachedDigest && Date.now() - cachedDigest.timestamp < CACHE_TTL_MS) {
    console.log('[PsychologyFeed] Using cached digest');
    return cachedDigest.content;
  }

  const perFeed = 6;
  const results: PsychologyTopicEntry[][] = [];
  let successCount = 0;

  // 并发抓取所有 feed
  const fetchPromises = FEEDS.map(async ({ url, label, category }) => {
    try {
      const xml = await fetchWithRetry(url);
      if (!xml) return [] as PsychologyTopicEntry[];
      const topics = parseFeedXml(xml, label, category, perFeed);
      if (topics.length > 0) {
        successCount++;
        console.log(`[PsychologyFeed] ${label}: got ${topics.length} topics`);
      }
      return topics;
    } catch (err) {
      console.warn(`[PsychologyFeed] Failed to fetch ${label}:`, err);
      return [] as PsychologyTopicEntry[];
    }
  });

  try {
    const allResults = await Promise.allSettled(fetchPromises);
    allResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        console.warn(`[PsychologyFeed] Promise rejected for ${FEEDS[i]?.label}:`, result.reason);
      }
    });
  } catch (err) {
    console.error('[PsychologyFeed] All fetches failed:', err);
  }

  const flat = results.flat();
  let merged = dedupeTopics(flat, maxLines);

  // 如果没有获取到任何内容，使用备选
  if (merged.length === 0) {
    console.log('[PsychologyFeed] No RSS fetched, using fallback topics');
    merged = FALLBACK_TOPICS.slice(0, maxLines);
  }

  const iso = new Date().toISOString();
  const successInfo = successCount > 0 ? `（成功抓取 ${successCount}/${FEEDS.length} 个 RSS 源）` : '（RSS 全部失败，使用内置备选）';

  // 按类别分组
  const petTopics = merged.filter(t => t.category === 'pet');
  const humanTopics = merged.filter(t => t.category === 'human');
  const relationTopics = merged.filter(t => t.category === 'relationship');
  const mentalTopics = merged.filter(t => t.category === 'mental_health');

  const header =
    `# 【治愈心理学·热门内容投喂】系统自动抓取\n` +
    `- 来源：微博、小红书、知乎、抖音等热门社区${successInfo}\n` +
    `- 抓取时间（ISO）：${iso}\n` +
    `- 时效：优先保留近 7 日内条目\n` +
    `- 用途：你必须据此写选题标题，禁止整组输出与热门内容无关的套话\n\n`;

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
  console.log('[PsychologyFeed] Cache cleared');
}
