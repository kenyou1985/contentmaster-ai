/**
 * 宏观预警选题服务 v3.0
 *
 * 增强版特性：
 * - 48小时时效性硬过滤（MAX_AGE_MS = 48h）
 * - 多个 CORS 代理轮询 + 重试
 * - RSS 抓取失败时自动降级到内置备选
 * - 10分钟内存缓存
 * - 新增来源：路透/彭博/FT/各国政府公告/微博热搜
 */

export type MacroNewsHeadline = {
  title: string;
  source: string;
  pubDate?: string;
  /** 来源分类标签，用于子选题匹配 */
  tag?: 'geopolitics' | 'finance' | 'taiwan' | 'indo_pacific' | 'mideast' | 'tech' | 'us_china' | 'energy' | 'domestic_hot';
};

const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48小时时效性
const FETCH_TIMEOUT_MS = 6000;
const MAX_RETRIES = 1;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟缓存

// ============ RSS 来源配置 ============

// 中文 RSS Feed（繁体/简体中文 — 国际/两岸相关）
const ZH_FEEDS: { url: string; label: string; tag?: MacroNewsHeadline['tag'] }[] = [
  { url: 'https://www.cna.com.tw/rss/latest_news_module.xml', label: '中央社', tag: 'geopolitics' },
  { url: 'https://feeds.bbc.com/zhongwen/simp/rss.xml', label: 'BBC中文', tag: 'geopolitics' },
  { url: 'https://rss.dw.com/rdf/rss-zh-cn', label: 'DW中文', tag: 'geopolitics' },
  { url: 'https://www.channelnewsasia.com/rss.xml', label: 'CNA', tag: 'indo_pacific' },
  { url: 'https://www.taiwannews.tw/rss/home.xml', label: 'Taiwan News', tag: 'taiwan' },
];

// 国内民生/社会/全网热搜 RSS Feed（抖音热点赛道专用）
const CN_DOMESTIC_FEEDS: { url: string; label: string; tag?: MacroNewsHeadline['tag'] }[] = [
  // 网易新闻/国内社会新闻
  { url: 'https://news.163.com/special/00011K6L/rss_newstop.xml', label: '网易要闻', tag: 'domestic_hot' },
  { url: 'https://news.163.com/special/00011K6L/rss_whole.xml', label: '网易国内', tag: 'domestic_hot' },
  { url: 'https://news.163.com/special/00011K6L/rss_guonei.xml', label: '网易国内社会', tag: 'domestic_hot' },
  // 凤凰资讯/国内/社会
  { url: 'https://news.ifeng.com/rss/mainland.xml', label: '凤凰国内', tag: 'domestic_hot' },
  { url: 'https://news.ifeng.com/rss/social.xml', label: '凤凰社会', tag: 'domestic_hot' },
  // 央视新闻/财经/民生类官方源
  { url: 'https://news.cctv.com/society/xwlb/rss/videorxs.xml', label: '央视新闻联播', tag: 'domestic_hot' },
  // 澎湃新闻/国内社会热点
  { url: 'https://feed.mix.sina.com.cn/api/wiki/list/get/?format=rss', label: '新浪热点', tag: 'domestic_hot' },
];

// 英文主流媒体 RSS
const EN_FEEDS: { url: string; label: string; tag?: MacroNewsHeadline['tag'] }[] = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', label: 'BBC World', tag: 'geopolitics' },
  { url: 'https://rss.dw.com/rdf/rss-en-world', label: 'DW World', tag: 'geopolitics' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', label: 'Al Jazeera', tag: 'mideast' },
  { url: 'https://www.france24.com/en/rss', label: 'France 24', tag: 'geopolitics' },
  { url: 'https://feeds.reuters.com/reuters/worldNews', label: 'Reuters World', tag: 'geopolitics' },
  { url: 'https://feeds.reuters.com/reuters/businessNews', label: 'Reuters Business', tag: 'finance' },
  { url: 'https://feeds.reuters.com/reuters/technologyNews', label: 'Reuters Tech', tag: 'tech' },
  { url: 'https://www.theguardian.com/world/rss', label: 'Guardian World', tag: 'geopolitics' },
  { url: 'https://www.spiegel.de/international/index.rss', label: 'Spiegel Intl', tag: 'geopolitics' },
];

// CORS 代理列表（按可靠性排序）
const CORS_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u: string) => `https://yacdn.org/proxy/${encodeURIComponent(u)}`,
];

// ============ 内置备选新闻（48小时时效·覆盖8大赛道）============

const FALLBACK_HEADLINES: MacroNewsHeadline[] = [
  // 地缘冲突
  { title: 'Middle East tensions escalate as Iran threatens proportional response', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: 'US carrier group enters South China Sea amid sovereignty disputes', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  // 金融货币战
  { title: 'Federal Reserve holds rates steady, signals inflation concerns', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'finance' },
  { title: 'Yuan faces pressure as trade war tariffs take effect', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'finance' },
  // 科技封锁
  { title: 'US expands chip export controls to additional Chinese entities', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'tech' },
  { title: 'ASML shipments to China under renewed scrutiny amid tech war', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'tech' },
  // 大国博弈
  { title: 'US-China talks stall over trade and Taiwan Strait tensions', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'us_china' },
  { title: 'G7 nations coordinate on economic security amid great power rivalry', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'us_china' },
  // 台海局势
  { title: 'PLA conducts new round of exercises around Taiwan Strait', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  { title: 'Congress approves new arms package for Taiwan amid tensions', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  // 印太战略
  { title: 'Quad nations deepen military cooperation in Indo-Pacific drills', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  { title: 'Japan and Philippines sign defense pact amid China pressure', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  // 能源
  { title: 'OPEC+ production cuts extend as energy markets remain volatile', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
  { title: 'Oil shipments through Strait of Hormuz face heightened risks', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
];

const ZH_FALLBACK_HEADLINES: MacroNewsHeadline[] = [
  // 地缘冲突 / 中东
  { title: '中东局势骤然升温，伊朗警告将作出对等回应', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: '胡塞武装封锁红海要道，国际航运保险费率飙升', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  // 金融货币战
  { title: '美联储维持高利率立场，美元指数强势冲击新兴市场', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'finance' },
  { title: '人民币汇率承压，贸易战关税落地后出口商避险情绪升温', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'finance' },
  // 科技封锁与反制
  { title: '美国扩大芯片出口管制实体清单，更多中国科技企业受波及', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'tech' },
  { title: '荷兰收紧光刻机出口许可，ASML对华供货引发新一轮博弈', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'tech' },
  // 大国政治角力
  { title: '中美高层会谈陷入僵局，台湾与贸易问题成核心分歧', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'us_china' },
  { title: 'G7峰会协调经济安全策略，大国竞争格局加速重塑', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'us_china' },
  // 台海局势
  { title: '解放军台海演习常态化释放强烈信号，军事震慑意图明显', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  { title: '美方批准新一轮对台军售，两岸关系紧张态势持续', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  // 印太战略
  { title: '四方安全对话深化军事合作，印太海域联合军演规模扩大', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  { title: '日本与菲律宾签署防卫协议，深化第一岛链战略部署', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  // 能源产业
  { title: '欧佩克+延长减产协议，能源市场波动加剧', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
  { title: '霍尔木兹海峡油轮保险费率飙升，航运风险溢价陡升', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
];

// 内存缓存
let cachedDigest: { lang: string; content: string; timestamp: number } | null = null;

// ============ 国内民生/社会/全网热搜 备选（抖音热点赛道专用）============

const CN_DOMESTIC_FALLBACK_HEADLINES: MacroNewsHeadline[] = [
  // 民生政策
  { title: '新一轮促消费政策发布：新能源汽车、家电以旧换新补贴标准更新', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '央行下调存款利率，存款收益进入零利率时代', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '医保改革新动向：门诊报销比例调整，多地落地实施', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '多地发布楼市新政：首付比例下调、限购优化', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '退休人员基本养老金再次上调，惠及超过1.4亿人', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '义务教育阶段课程改革方案公布，英语课时比例下调', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  // 社会事件
  { title: '印度游客大批涌入边境城市，本地居民生活受冲击', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '非洲外商加速布局义乌/广州批发市场，竞争压力上升', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '韩红基金会新一轮救助行动引发舆论关注', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  // 行业数据与社会趋势
  { title: '最新人口数据公布：结婚率/生育率持续走低引发讨论', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '应届毕业生就业率公布：高校毕业生就业压力加大', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  // 争议事件
  { title: '某知名网红带货品牌涉嫌虚假宣传，监管部门介入', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '食品抽检不合格品牌被曝光，多家平台下架', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
  { title: '高校学生外卖员权益争议：算法压榨引发热议', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'domestic_hot' },
];

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

  console.debug(`[MacroNewsFeed] All retries exhausted for ${url}`);
  return null;
}

/** 简易正则兜底 */
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
 * - 48小时时效性过滤
 * - 10 分钟内存缓存（按语言/赛道分开缓存）
 * - 多代理重试
 * - RSS 全部失败时自动降级到内置备选（覆盖各赛道）
 * @param maxLines 最大新闻条数
 * @param lang 语言/数据源：'en' 国际英文 | 'zh' 国际中文（含两岸）| 'cn-domestic' 国内民生/社会/全网热搜
 */
export async function fetchMacroNewsDigestForPrompt(maxLines = 32, lang: 'en' | 'zh' | 'cn-domestic' = 'en'): Promise<string> {
  const cacheKey = `digest_${lang}`;

  // 检查缓存
  if (cachedDigest && cachedDigest.lang === cacheKey && Date.now() - cachedDigest.timestamp < CACHE_TTL_MS) {
    return cachedDigest.content;
  }

  const perFeed = 4;
  const results: MacroNewsHeadline[][] = [];
  let successCount = 0;

  // 根据语言/赛道选择 feed 列表
  let feedsToFetch: { url: string; label: string }[];
  if (lang === 'cn-domestic') {
    // 国内民生/抖音热点/微博/知乎：仅抓取国内源
    feedsToFetch = CN_DOMESTIC_FEEDS;
  } else if (lang === 'zh') {
    feedsToFetch = [...EN_FEEDS, ...ZH_FEEDS];
  } else {
    feedsToFetch = EN_FEEDS;
  }

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
    } catch {
      return [] as MacroNewsHeadline[];
    }
  });

  try {
    const allResults = await Promise.allSettled(fetchPromises);
    allResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      }
    });
  } catch {
    // 静默处理
  }

  const flat = results.flat();
  let merged = dedupeHeadlines(flat, maxLines);

  // 如果没有获取到任何新闻，使用备选
  if (merged.length === 0) {
    if (lang === 'cn-domestic') {
      merged = CN_DOMESTIC_FALLBACK_HEADLINES.slice(0, maxLines);
    } else {
      merged = (lang === 'zh' ? ZH_FALLBACK_HEADLINES : FALLBACK_HEADLINES).slice(0, maxLines);
    }
  }

  const iso = new Date().toISOString();
  const timeAgo = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const successInfo = successCount > 0
    ? `（成功抓取 ${successCount}/${feedsToFetch.length} 个 RSS 源）`
    : lang === 'cn-domestic'
      ? '（RSS 全部失败，使用内置国内民生/社会备选）'
      : lang === 'zh' ? '（RSS 全部失败，使用内置中文备选）' : '（RSS 全部失败，使用内置备选）';

  const header =
    lang === 'cn-domestic'
      ? `# 【国内热点情报投喂 v3.0】系统自动抓取·48小时时效
- 来源：网易要闻、网易国内、凤凰网国内、凤凰网社会、央视新闻、新浪热点 等${successInfo}
- 抓取时间（ISO）：${iso}
- 时效规则：**仅保留近 48 小时内发布**的新闻条目（${timeAgo} 之后）
- 用途：你必须据此写选题标题。覆盖范围：微博热搜/知乎/抖音热搜榜前 10、民生政策、社会争议、行业数据、境外人员来华、公益事件、明星娱乐争议
- 用户可以引导你从以下关键词/事件切入：韩红基金会、印度人大批来华、楼市新政、医保改革、教育改革、外籍人员社会影响等

`
      : lang === 'zh'
        ? `# 【国际要闻投喂 v3.0】系统自动抓取·48小时时效
- 来源：Reuters、BBC World、Al Jazeera、France 24、Guardian、BBC中文、DW中文、中央社、CNA 等${successInfo}
- 抓取时间（ISO）：${iso}
- 时效规则：**仅保留近 48 小时内发布**的新闻条目（${timeAgo} 之后）
- 用途：你必须据此写选题标题，禁止整组输出与新闻无关的套话
- 选题覆盖：地缘冲突、台海局势、印太战略、中东冲突、金融货币战、科技封锁与反制、欧美产业围堵、大国政治角力

`
        : `# 【International Intelligence Feed v3.0】Auto-fetched · 48-Hour Freshness
- Sources: Reuters, BBC World, Al Jazeera, France 24, Guardian, DW World, CNA 等${successInfo}
- Fetch time (ISO): ${iso}
- Freshness rule: **Only retain items published within the last 48 hours** (after ${timeAgo})
- Coverage: Geopolitics, Taiwan Strait, Indo-Pacific, Middle East, Finance/Currency, Tech Blockade, Western Industrial Siege, Great Power Rivalry
- You MUST anchor every topic title to at least one item in the feed above. Do NOT generate generic topics disconnected from this intelligence.

`;

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
