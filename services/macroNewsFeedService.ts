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
const FETCH_TIMEOUT_MS = 5000;
const MAX_RETRIES = 1;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟缓存

// 中文 RSS Feed 列表（用于中文模式）
const ZH_FEEDS: { url: string; label: string }[] = [
  { url: 'https://www.cna.com.tw/rss/latest_news_module.xml', label: '中央社' },
  { url: 'https://feeds.bbc.com/zhongwen/simp/rss.xml', label: 'BBC中文网' },
  { url: 'https://rss.dw.com/rdf/rss-zh-cn', label: 'DW中文网' },
  { url: 'https://www.channelnewsasia.com/rss.xml', label: 'CNA' },
];

// CORS 代理列表（按可靠性排序）
const CORS_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u: string) => `https://yacdn.org/proxy/${encodeURIComponent(u)}`,
];

// RSS Feed 列表（精简为最可靠的来源，避免被代理封锁）
const FEEDS: { url: string; label: string }[] = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', label: 'BBC World' },
  { url: 'https://rss.dw.com/rdf/rss-en-world', label: 'DW World' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', label: 'Al Jazeera' },
  { url: 'https://www.france24.com/en/rss', label: 'France 24' },
  { url: 'https://feeds.reuters.com/reuters/worldNews', label: 'Reuters' },
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

// 中文模式备选新闻（当 RSS 全部失败时使用，优先台湾/两岸/印太内容）
const ZH_FALLBACK_HEADLINES: MacroNewsHeadline[] = [
  { title: '台海局势持续受关注，美方批准新一轮对台军售', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '赖清德发表言论，两岸关系再引热议', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '解放军台海演习常态化，军事震慑意图明显', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '中美在台海议题上持续博弈，外交交锋频繁', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '郑丽文等政治人物就两岸政策展开激辩', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '印太战略持续推进，台海成为大国博弈焦点', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '台湾半导体产业受全球关注，地缘经济风险上升', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '解放军舰机频繁巡航台海，区域安全形势趋紧', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '美日韩军事合作深化，印太联盟体系持续巩固', source: 'Fallback', pubDate: new Date().toISOString() },
  { title: '两岸经贸数据波动，供应链重构加速推进', source: 'Fallback', pubDate: new Date().toISOString() },
];

// 内存缓存
let cachedDigest: { lang: string; content: string; timestamp: number } | null = null;

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

  console.debug(`[MacroNewsFeed] Attempt ${attempt + 1} for ${url} via proxy`);
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
 * - 10 分钟内存缓存（按语言分开缓存）
 * - 多代理重试
 * - RSS 全部失败时自动降级到内置备选
 * @param maxLines 最大新闻条数
 * @param lang 语言：'en' | 'zh'，默认为 'en'
 */
export async function fetchMacroNewsDigestForPrompt(maxLines = 32, lang: 'en' | 'zh' = 'en'): Promise<string> {
  const cacheKey = `digest_${lang}`;

  // 检查缓存
  if (cachedDigest && cachedDigest.lang === cacheKey && Date.now() - cachedDigest.timestamp < CACHE_TTL_MS) {
    return cachedDigest.content;
  }

  const perFeed = 4;
  const results: MacroNewsHeadline[][] = [];
  let successCount = 0;

  // 根据语言选择 feed 列表
  const feedsToFetch = lang === 'zh' ? [...FEEDS, ...ZH_FEEDS] : FEEDS;

  // 并发抓取所有 feed
  const fetchPromises = feedsToFetch.map(async ({ url, label }) => {
    try {
      const xml = await fetchWithRetry(url);
      if (!xml) return [] as MacroNewsHeadline[];
      const headlines = parseFeedXml(xml, label, perFeed);
      if (headlines.length > 0) {
        successCount++;
      }
      return headlines;
    } catch (err) {
      return [] as MacroNewsHeadline[];
    }
  });

  try {
    const allResults = await Promise.allSettled(fetchPromises);
    allResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      }
    });
  } catch (err) {
    // 静默处理
  }

  const flat = results.flat();
  let merged = dedupeHeadlines(flat, maxLines);

  // 如果没有获取到任何新闻，使用备选
  if (merged.length === 0) {
    merged = (lang === 'zh' ? ZH_FALLBACK_HEADLINES : FALLBACK_HEADLINES).slice(0, maxLines);
  }

  const iso = new Date().toISOString();
  const successInfo = successCount > 0
    ? `（成功抓取 ${successCount}/${feedsToFetch.length} 个 RSS 源）`
    : lang === 'zh' ? '（RSS 全部失败，使用内置中文备选）' : '（RSS 全部失败，使用内置备选）';

  const header =
    lang === 'zh'
      ? `# 【国际要闻投喂】系统自动抓取\n- 来源：CNA、BBC中文网、DW中文网、CNA等${successInfo}\n- 抓取时间（ISO）：${iso}\n- 时效：优先保留近 7 日内条目\n- 用途：你必须据此写选题标题，禁止整组输出与新闻无关的套话\n\n`
      : `# 【International Intelligence Feed】Auto-fetched\n- Sources: BBC World, DW, Al Jazeera, France 24, Sky News, CNBC, Reuters, Guardian等${successInfo}\n- Fetch time (ISO): ${iso}\n- You MUST anchor every topic title to at least one item in the feed above. Do NOT generate generic topics disconnected from this intelligence.\n\n`;

  const body = merged.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join('\n');
  const digest = header + body;

  // 更新缓存
  cachedDigest = {
    lang: cacheKey,
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
}
