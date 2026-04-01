/**
 * 宏观预警选题：聚合国际主流媒体 RSS（经浏览器可访问的 CORS 代理），
 * 供每次「一键生成爆款选题」注入提示词，避免模型反复输出同一批静态热点。
 *
 * 增强版特性：
 * - 多个 CORS 代理轮询 + 重试
 * - 单个 feed 多代理尝试
 * - RSS 抓取失败时自动降级到内置备选
 * - 7 天内存缓存
 */

export type MacroNewsHeadline = {
  title: string;
  source: string;
  pubDate?: string;
};

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟缓存

// CORS 代理列表（按可靠性排序）
const CORS_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u: string) => `https://yacdn.org/proxy/${encodeURIComponent(u)}`,
];

// RSS Feed 列表
const FEEDS: { url: string; label: string }[] = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', label: 'BBC World' },
  { url: 'https://rss.dw.com/rdf/rss-en-world', label: 'DW World' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', label: 'Al Jazeera' },
  { url: 'https://www.france24.com/en/rss', label: 'France 24' },
  { url: 'https://feeds.skynews.com/feeds/rss/world.xml', label: 'Sky News' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', label: 'CNBC' },
  { url: 'https://feeds.reuters.com/reuters/worldNews', label: 'Reuters' },
  { url: 'https://www.theguardian.com/world/rss', label: 'Guardian' },
];

// 内置备选新闻（当 RSS 全部失败时使用）
const FALLBACK_HEADLINES: MacroNewsHeadline[] = [
  { title: '中东局势持续紧张，以色列与伊朗对峙升级', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '美联储维持高利率政策，全球金融市场承压', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '霍尔木兹海峡航运风险加剧，能源价格波动', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '新兴市场债务危机蔓延，阿根廷土耳其汇率暴跌', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '美中科技战升级，半导体供应链重构加速', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '全球通胀居高不下，消费者购买力持续下降', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '欧盟能源危机预警，天然气价格再度飙升', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '地缘政治冲突推高黄金价格，创历史新高', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '供应链瓶颈持续，全球贸易增速放缓', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '美国国债收益率曲线倒挂，经济衰退风险上升', source: 'Fallback', pubDate: new Date().toISOString() },
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

/**
 * 带重试的 fetch
 */
async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES
): Promise<string | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 尝试所有代理
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
        // 检查是否返回了有效的 XML 内容
        if (text && text.length > 400 && (text.includes('<rss') || text.includes('<feed') || text.includes('<item'))) {
          return text;
        }
      } catch (err) {
        lastError = err as Error;
        // 继续尝试下一个代理
      }
    }

    // 所有代理都失败了，如果是最后一次尝试就不再等待
    if (attempt < retries) {
      // 指数退避：500ms, 1000ms, 2000ms
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }

  console.warn(`[MacroNewsFeed] All proxies failed for ${url}:`, lastError?.message);
  return null;
}

/** 简易正则兜底（部分 RDF / 畸形 XML） */
function parseItemsRegex(xml: string, source: string, cap: number): MacroNewsHeadline[] {
  const out: MacroNewsHeadline[] = [];
  const re = /<item[\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < cap) {
    const block = m[0];
    const tm = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const dm = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    if (!tm) continue;
    let title = stripCdata(tm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, '').trim());
    if (!title || title.length < 12) continue;
    const pubDate = dm ? stripCdata(dm[1].trim()) : undefined;
    if (!isRecent(pubDate)) continue;
    out.push({ title, source, pubDate });
  }
  return out;
}

function parseFeedXml(xml: string, source: string, cap: number): MacroNewsHeadline[] {
  const fromDom: MacroNewsHeadline[] = [];
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
        if (title.length < 12) return;
        const pubDate =
          el.querySelector('pubDate')?.textContent?.trim() ||
          el.querySelector('dc\\:date, date')?.textContent?.trim();
        if (!isRecent(pubDate)) return;
        fromDom.push({ title, source, pubDate });
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
        if (title.length < 12) return;
        const pubDate =
          el.querySelector('updated')?.textContent?.trim() ||
          el.querySelector('published')?.textContent?.trim();
        if (!isRecent(pubDate)) return;
        fromDom.push({ title, source, pubDate });
      });
    }
  } catch {
    return parseItemsRegex(xml, source, cap);
  }

  return fromDom.length ? fromDom : parseItemsRegex(xml, source, cap);
}

function dedupeHeadlines(items: MacroNewsHeadline[], max: number): MacroNewsHeadline[] {
  const seen = new Set<string>();
  const out: MacroNewsHeadline[] = [];
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
 * 特性：
 * - 10 分钟内存缓存
 * - 多代理重试
 * - RSS 全部失败时自动降级到内置备选
 */
export async function fetchMacroNewsDigestForPrompt(maxLines = 32): Promise<string> {
  // 检查缓存
  if (cachedDigest && Date.now() - cachedDigest.timestamp < CACHE_TTL_MS) {
    console.log('[MacroNewsFeed] Using cached digest');
    return cachedDigest.content;
  }

  const perFeed = 8;
  const results: MacroNewsHeadline[][] = [];
  let successCount = 0;

  // 并发抓取所有 feed
  const fetchPromises = FEEDS.map(async ({ url, label }) => {
    try {
      const xml = await fetchWithRetry(url);
      if (!xml) return [] as MacroNewsHeadline[];
      const headlines = parseFeedXml(xml, label, perFeed);
      if (headlines.length > 0) {
        successCount++;
        console.log(`[MacroNewsFeed] ${label}: got ${headlines.length} headlines`);
      }
      return headlines;
    } catch (err) {
      console.warn(`[MacroNewsFeed] Failed to fetch ${label}:`, err);
      return [] as MacroNewsHeadline[];
    }
  });

  try {
    const allResults = await Promise.allSettled(fetchPromises);
    allResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        console.warn(`[MacroNewsFeed] Promise rejected for ${FEEDS[i]?.label}:`, result.reason);
      }
    });
  } catch (err) {
    console.error('[MacroNewsFeed] All fetches failed:', err);
  }

  const flat = results.flat();
  let merged = dedupeHeadlines(flat, maxLines);

  // 如果没有获取到任何新闻，使用备选
  if (merged.length === 0) {
    console.log('[MacroNewsFeed] No RSS fetched, using fallback headlines');
    merged = FALLBACK_HEADLINES.slice(0, maxLines);
  }

  const iso = new Date().toISOString();
  const successInfo = successCount > 0 ? `（成功抓取 ${successCount}/${FEEDS.length} 个 RSS 源）` : '（RSS 全部失败，使用内置备选）';

  const header =
    `# 【国际要闻投喂】系统自动抓取\n` +
    `- 来源：BBC World、DW、Al Jazeera、France 24、Sky News、CNBC、Reuters、Guardian 等${successInfo}\n` +
    `- 抓取时间（ISO）：${iso}\n` +
    `- 时效：优先保留近 7 日内条目\n` +
    `- 用途：你必须据此写选题标题，禁止整组输出与新闻无关的套话\n\n`;

  const body = merged.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join('\n');
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
export function clearMacroNewsCache(): void {
  cachedDigest = null;
  console.log('[MacroNewsFeed] Cache cleared');
}
