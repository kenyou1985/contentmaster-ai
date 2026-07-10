/**
 * 宏观预警选题服务 v5.0
 *
 * v5.0 改动：
 * - 缓存改为按 UTC 日期 + 小时桶分片，跨日/跨小时自动失效，确保当天每次生成都拿到最新数据
 * - 新增微博热搜/抖音热搜 JSON API 作为国内热点数据源（不再仅依赖网易/凤凰等 RSS 频道）
 * - RSS digest 输出中保留 `pubDate`（日期），让 LLM 知道事件实际发生时间，以便在选题中标注
 * - 备选（FALLBACK）数据动态化：按 UTC 当前日期滚动生成示例热点，包含天气/民生等时效元素
 * - 缓存清理函数暴露 `forceRefresh` 选项，允许手动强制刷新
 */

export type MacroNewsHeadline = {
  title: string;
  source: string;
  pubDate?: string;
  /** 来源分类标签，用于子选题匹配 */
  tag?: 'geopolitics' | 'finance' | 'taiwan' | 'indo_pacific' | 'mideast' | 'tech' | 'us_china' | 'energy' | 'domestic_hot' | 'social_hot' | 'disaster';
};

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7天时效窗口（优先最近48小时）
const FRESH_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48小时以内视为"新鲜"
const FETCH_TIMEOUT_MS = 6000;
const MAX_RETRIES = 1;
// v5.0: 缓存 TTL 缩短到 5 分钟，避免一天内多次生成拿到同一份 stale 数据
// 同时配合按 UTC 日期+小时桶分片，跨小时强制重新抓取
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟缓存

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
// v5.0+：多源 + RSSHub 镜像兜底（用户国内浏览器访问 RSSHub 实例通常比直接访问 CORS 代理更稳）
// 重点：优先选择「有具体事件、热点争议」的源（如澎湃新闻、知乎热议、36氪热议等）
const CN_DOMESTIC_FEEDS: { url: string; label: string; tag?: MacroNewsHeadline['tag'] }[] = [
  // ============ 网易新闻/国内（原始 RSS，国内浏览器可直连） ============
  { url: 'https://news.163.com/special/00011K6L/rss_newstop.xml', label: '网易要闻', tag: 'domestic_hot' },
  { url: 'https://news.163.com/special/00011K6L/rss_guonei.xml', label: '网易国内社会', tag: 'domestic_hot' },
  { url: 'https://news.163.com/special/00011K6L/rss_whole.xml', label: '网易国内', tag: 'domestic_hot' },
  { url: 'https://news.163.com/special/00011K6L/rss_world.xml', label: '网易国际', tag: 'geopolitics' },
  // ============ 凤凰资讯/国内（原始 RSS） ============
  { url: 'https://news.ifeng.com/rss/mainland.xml', label: '凤凰国内', tag: 'domestic_hot' },
  { url: 'https://news.ifeng.com/rss/social.xml', label: '凤凰社会', tag: 'domestic_hot' },
  // ============ 央视新闻/财经/民生类（官方源） ============
  { url: 'https://news.cctv.com/society/xwlb/rss/videorxs.xml', label: '央视新闻联播', tag: 'domestic_hot' },
  // ============ 新浪/澎湃（重磅调查/深度报道） ============
  { url: 'https://feed.mix.sina.com.cn/api/wiki/list/get/?format=rss', label: '新浪热点', tag: 'domestic_hot' },
  { url: 'https://www.thepaper.cn/rss_news_index.jsp', label: '澎湃新闻', tag: 'social_hot' },
  { url: 'https://www.thepaper.cn/feed', label: '澎湃热点', tag: 'social_hot' },
  // ============ RSSHub 多镜像（多实例兜底，总有一个能用） ============
  // 这些实例是公开的，可能随时挂掉，作为多源备选
  { url: 'https://rsshub.app/tophub/today', label: '今日热榜聚合-rsshub.app', tag: 'social_hot' },
  { url: 'https://rsshub.app/weibo/search/hot', label: '微博热搜-rsshub.app', tag: 'social_hot' },
  { url: 'https://rsshub.app/zhihu/hotlist', label: '知乎热榜-rsshub.app', tag: 'social_hot' },
  { url: 'https://rsshub.app/douyin/hot', label: '抖音热榜-rsshub.app', tag: 'social_hot' },
  { url: 'https://rsshub.app/baidu/top', label: '百度热搜-rsshub.app', tag: 'social_hot' },
  { url: 'https://rsshub.app/bilibili/hot-search', label: 'B站热搜-rsshub.app', tag: 'social_hot' },
  { url: 'https://rsshub.app/36kr/hot-list', label: '36氪热榜-rsshub.app', tag: 'social_hot' },
  { url: 'https://rsshub.app/huxiu/channel', label: '虎嗅热点-rsshub.app', tag: 'social_hot' },
  { url: 'https://rsshub.app/ithome/ranking', label: 'IT之家热榜-rsshub.app', tag: 'tech' },
  // 额外 RSSHub 镜像（互为兜底）
  { url: 'https://rsshub.rssforever.com/tophub/today', label: '今日热榜-rssforever', tag: 'social_hot' },
  { url: 'https://rsshub.rssforever.com/weibo/search/hot', label: '微博热搜-rssforever', tag: 'social_hot' },
  { url: 'https://rsshub.rssforever.com/zhihu/hotlist', label: '知乎热榜-rssforever', tag: 'social_hot' },
  { url: 'https://rsshub.rssforever.com/douyin/hot', label: '抖音热榜-rssforever', tag: 'social_hot' },
  { url: 'https://rsshub.rssforever.com/baidu/top', label: '百度热搜-rssforever', tag: 'social_hot' },
  // 第二个公共镜像实例
  { url: 'https://hub.slarker.com/tophub/today', label: '今日热榜-slarker', tag: 'social_hot' },
  { url: 'https://hub.slarker.com/weibo/search/hot', label: '微博热搜-slarker', tag: 'social_hot' },
  { url: 'https://hub.slarker.com/zhihu/hotlist', label: '知乎热榜-slarker', tag: 'social_hot' },

  // ============ v9.1 新增：军事/政策/社会深度/国家发展（用户偏好） ============
  // 军事/时政
  { url: 'https://rsshub.app/mil/news', label: '米尔军情网-rsshub', tag: 'military' },
  { url: 'https://rsshub.rssforever.com/mil/news', label: '米尔军情网-rssforever', tag: 'military' },
  { url: 'https://rsshub.app/guancha', label: '观察者网-要闻', tag: 'politics' },
  { url: 'https://rsshub.rssforever.com/guancha', label: '观察者网-要闻-fb', tag: 'politics' },
  { url: 'https://rsshub.app/guancha/zhuanlan', label: '观察者网专栏', tag: 'politics' },
  // 政策/财经/基建
  { url: 'https://rsshub.app/caixin/latest', label: '财新网最新', tag: 'finance' },
  { url: 'https://rsshub.rssforever.com/caixin/latest', label: '财新网-fb', tag: 'finance' },
  { url: 'https://rsshub.app/jjckb/news', label: '经济参考报', tag: 'finance' },
  { url: 'https://rsshub.app/people/politics', label: '人民日报-时政', tag: 'politics' },
  { url: 'https://rsshub.rssforever.com/people/politics', label: '人民日报-fb', tag: 'politics' },
  { url: 'https://rsshub.app/xinhuanet/finance', label: '新华财经', tag: 'finance' },
  // 社会民生/基建/灾害
  { url: 'https://rsshub.app/thepaper/forwardFeed', label: '澎湃新闻-热追问', tag: 'social_hot' },
  { url: 'https://rsshub.app/toutiao/hot', label: '今日头条热榜', tag: 'social_hot' },
  { url: 'https://rsshub.rssforever.com/toutiao/hot', label: '今日头条-fb', tag: 'social_hot' },
  // 军事观察/解局（深度军事评论）
  { url: 'https://rsshub.app/cls/telegraph', label: '财联社电报', tag: 'finance' },
  { url: 'https://rsshub.rssforever.com/cls/telegraph', label: '财联社电报-fb', tag: 'finance' },
];

// 英文主流媒体 RSS
const EN_FEEDS: { url: string; label: string; tag?: MacroNewsHeadline['tag'] }[] = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', label: 'BBC World', tag: 'geopolitics' },
  { url: 'https://rss.dw.com/rdf/rss-en-world', label: 'DW World', tag: 'geopolitics' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', label: 'Al Jazeera', tag: 'mideast' },
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

// 微博热搜/抖音热搜/今日热榜 JSON 数据源（v5.0+ 多源容错）
// 这些 API 直接返回热搜关键词，能反映当下热度（如「广西暴雨」等）
// 多源并行抓取：主源失败时自动尝试备用源
const JSON_HOT_API_SOURCES: { url: string; label: string; tag: MacroNewsHeadline['tag']; parse: (json: any) => string[] }[] = [
  // 1. 今日热榜（聚合微博/知乎/抖音/百度等多平台热搜）
  {
    url: 'https://api-hot.imsyy.top/all',
    label: '今日热榜',
    tag: 'social_hot',
    parse: (json: any) => {
      const arr = Array.isArray(json?.data) ? json.data : [];
      return arr
        .map((item: any) => String(item?.title || item?.word || '').trim())
        .filter((t: string) => t.length >= 4 && t.length <= 60)
        .slice(0, 25);
    },
  },
  // 2. 抖音热搜榜（独立源）
  {
    url: 'https://api-hot.imsyy.top/douyin',
    label: '抖音热搜',
    tag: 'social_hot',
    parse: (json: any) => {
      const arr = Array.isArray(json?.data) ? json.data : [];
      return arr
        .map((item: any) => String(item?.title || item?.word || '').trim())
        .filter((t: string) => t.length >= 4 && t.length <= 60)
        .slice(0, 20);
    },
  },
  // 3. 微博热搜榜
  {
    url: 'https://api-hot.imsyy.top/weibo',
    label: '微博热搜',
    tag: 'social_hot',
    parse: (json: any) => {
      const arr = Array.isArray(json?.data) ? json.data : [];
      return arr
        .map((item: any) => String(item?.title || item?.word || '').trim())
        .filter((t: string) => t.length >= 4 && t.length <= 60)
        .slice(0, 20);
    },
  },
  // 4. 知乎热榜
  {
    url: 'https://api-hot.imsyy.top/zhihu',
    label: '知乎热榜',
    tag: 'social_hot',
    parse: (json: any) => {
      const arr = Array.isArray(json?.data) ? json.data : [];
      return arr
        .map((item: any) => String(item?.title || item?.word || '').trim())
        .filter((t: string) => t.length >= 4 && t.length <= 60)
        .slice(0, 20);
    },
  },
  // 5. 百度热搜
  {
    url: 'https://api-hot.imsyy.top/baidu',
    label: '百度热搜',
    tag: 'social_hot',
    parse: (json: any) => {
      const arr = Array.isArray(json?.data) ? json.data : [];
      return arr
        .map((item: any) => String(item?.title || item?.word || '').trim())
        .filter((t: string) => t.length >= 4 && t.length <= 60)
        .slice(0, 20);
    },
  },
  // 6. 备用镜像（互为兜底，单个挂掉也能用）
  {
    url: 'https://hot-api.imsyy.top/all',
    label: '今日热榜-镜像',
    tag: 'social_hot',
    parse: (json: any) => {
      const arr = Array.isArray(json?.data) ? json.data : [];
      return arr
        .map((item: any) => String(item?.title || item?.word || '').trim())
        .filter((t: string) => t.length >= 4 && t.length <= 60)
        .slice(0, 25);
    },
  },
  // 7. 今日热榜另一镜像
  {
    url: 'https://api-hot.moyu360.cn/all',
    label: '今日热榜-moyu360',
    tag: 'social_hot',
    parse: (json: any) => {
      const arr = Array.isArray(json?.data) ? json.data : [];
      return arr
        .map((item: any) => String(item?.title || item?.word || '').trim())
        .filter((t: string) => t.length >= 4 && t.length <= 60)
        .slice(0, 25);
    },
  },
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
  { title: '美方新一轮对外军售计划获批，区域安全动态引关注', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  // 印太战略
  { title: '四方安全对话深化军事合作，印太海域联合军演规模扩大', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  { title: '日本与菲律宾签署防卫协议，深化第一岛链战略部署', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  // 能源产业
  { title: '欧佩克+延长减产协议，能源市场波动加剧', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
  { title: '霍尔木兹海峡油轮保险费率飙升，航运风险溢价陡升', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
];

// 内存缓存（v5.0：按 UTC 日期+小时桶分片）
type CachedDigest = { lang: string; bucket: string; content: string; timestamp: number };
let cachedDigest: CachedDigest | null = null;

/**
 * 计算当前 UTC 时间桶（YYYY-MM-DD-HH），跨小时强制重新抓取
 * 保证每天每个时段抓取的数据都不同，避免「昨天和今天输出一样」的问题
 */
function getUtcTimeBucket(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  return `${y}-${m}-${d}-${h}`;
}

/** 把 ISO 时间格式化为「YYYY-MM-DD HH:mm」便于 LLM 标注日期 */
function formatPubDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const ho = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${ho}:${mi}`;
}

/** 根据当前 UTC 月/日动态生成时效热点关键词（用于 FALLBACK） */
function getSeasonalHotKeywords(): string[] {
  const now = new Date();
  const month = now.getUTCMonth() + 1; // 1-12
  const date = now.getUTCDate();
  const keywords: string[] = [];

  // 7 月：盛夏，暴雨/台风/防汛
  if (month === 7) {
    keywords.push('防汛抗洪', '高温橙色预警', '城市内涝', '台风路径', '用电高峰');
    if (date <= 15) keywords.push('七月上旬', '暑期安全', '学生溺水');
  } else if (month === 8) {
    keywords.push('台风登陆', '高温红色预警', '军训季', '高校开学', '暑期档票房');
  } else if (month === 1) {
    keywords.push('春运', '寒潮', '春节返乡', '冰雪灾害');
  } else if (month === 2) {
    keywords.push('春节消费', '春运返程', '情人节');
  } else if (month === 6) {
    keywords.push('高考', '中考', '梅雨季', '汛期', '端午');
  }

  return keywords;
}

// ============ 国内民生/社会/全网热搜 备选（抖音热点赛道专用）============
// v7.0 空投版：当所有 RSS/JSON 源全部失败时，不投喂占位符，
// 只在 digest 中注入「自搜指令」，让 LLM 靠自身知识写具体选题。
// 根治「某顶流/某地/某综艺」等占位词问题。
// 注意：正常情况（RSS/JSON 任意一个成功）会拉取实时热搜，不走这里。
const CN_DOMESTIC_FALLBACK_HEADLINES: MacroNewsHeadline[] = [];



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
  if (!pubDateStr) return true; // 无日期视为有效（CORS 代理可能丢失）
  const t = Date.parse(pubDateStr);
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= MAX_AGE_MS;
}

/** 获取新鲜度分数（越小越新鲜）：0=48h内，1=7天内，2=无日期/超时 */
function freshnessScore(pubDateStr: string | undefined): number {
  if (!pubDateStr) return 2;
  const t = Date.parse(pubDateStr);
  if (Number.isNaN(t)) return 2;
  const age = Date.now() - t;
  if (age <= FRESH_THRESHOLD_MS) return 0;
  if (age <= MAX_AGE_MS) return 1;
  return 3;
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
  // 第一次遍历去重并保留原始顺序
  const deduped: MacroNewsHeadline[] = [];
  for (const it of items) {
    const k = normalizeTitleKey(it.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }
  // 按新鲜度排序：0=48h内 > 1=7天内 > 2=无日期（稳定的持续发酵新闻）
  deduped.sort((a, b) => freshnessScore(a.pubDate) - freshnessScore(b.pubDate));
  return deduped.slice(0, max);
}

/**
 * 拉取 JSON 热搜 API（v5.0 新增）：微博/抖音/今日热榜
 * 通过 CORS 代理访问，返回当前热搜关键词列表
 * 这些是「此刻」的热度关键词（如「广西暴雨」等），能解决"昨天和今天输出一样"的问题
 */
async function fetchJsonHotSearches(): Promise<MacroNewsHeadline[]> {
  const out: MacroNewsHeadline[] = [];
  const nowIso = new Date().toISOString();

  await Promise.allSettled(
    JSON_HOT_API_SOURCES.map(async (src) => {
      let lastErr: unknown = null;
      for (const buildProxy of CORS_PROXIES) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          const proxyUrl = buildProxy(src.url);
          const res = await fetch(proxyUrl, {
            signal: controller.signal,
            headers: { Accept: 'application/json, text/plain, */*' },
          });
          clearTimeout(timer);
          if (!res.ok) continue;
          const text = await res.text();
          if (!text || text.length < 50) continue;
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            continue;
          }
          const titles = src.parse(json);
          for (const title of titles) {
            out.push({
              title,
              source: src.label,
              pubDate: nowIso,
              tag: src.tag,
            });
          }
          break; // 成功一个代理即跳出
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr && out.length === 0) {
        console.debug(`[MacroNewsFeed] JSON 热搜抓取失败 ${src.label}:`, lastErr);
      }
    })
  );

  return out;
}

// ==============================================================
// v8.0 新增：浏览器直抓百度热搜（no-cors 模式，无需 CORS 代理）
// baidu.com 允许 no-cors 请求，直接返回 HTML 文本，正则提取热搜标题
// 这是国内最稳定、覆盖最广的热点来源
// ==============================================================
interface BaiduHotItem {
  title: string;
  index: number;
  category: string;
}

function parseBaiduHotHtml(html: string): BaiduHotItem[] {
  const items: BaiduHotItem[] = [];

  // 方式1：匹配 <a class="index_xxx-word">标题</a> 结构
  const pattern1 = /<a[^>]*class="[^"]*word[^"]*"[^>]*>([^<]+)<\/a>/gi;
  let m;
  let idx = 1;
  while ((m = pattern1.exec(html)) !== null && items.length < 50) {
    const title = m[1].trim().replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
    if (title.length >= 4 && title.length <= 80) {
      items.push({ title, index: idx++, category: 'search' });
    }
  }

  // 方式2：匹配 data-word 属性（百度热搜新版结构）
  if (items.length < 5) {
    const pattern2 = /data-word="([^"]+)"/g;
    while ((m = pattern2.exec(html)) !== null && items.length < 50) {
      const title = m[1].trim().replace(/\u003c/g, '<').replace(/\u003e/g, '>').replace(/\u0026/g, '&');
      if (title.length >= 4 && !items.some(i => i.title === title)) {
        items.push({ title, index: items.length + 1, category: 'data-word' });
      }
    }
  }

  // 方式3：匹配 JSON 里的热搜词
  if (items.length < 5) {
    const jsonMatch = html.match(/\["hotList\]\s*=\s*(\[[\s\S]+?\]);/);
    if (jsonMatch) {
      try {
        const hotList = JSON.parse(jsonMatch[1]);
        for (const item of hotList.slice(0, 30)) {
          const title = String(item.word || item.query || item.title || '').trim();
          if (title.length >= 4 && !items.some(i => i.title === title)) {
            items.push({ title, index: items.length + 1, category: 'json' });
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 方式4：通用 title 提取（最后兜底）
  if (items.length < 5) {
    const pattern4 = /<title[^>]*>([^<]+)<\/title>/gi;
    while ((m = pattern4.exec(html)) !== null) {
      const title = m[1].replace(/ - 百度热搜$/i, '').trim();
      if (title.length >= 4 && !items.some(i => i.title === title)) {
        items.push({ title, index: items.length + 1, category: 'title' });
      }
    }
  }

  return items;
}

async function fetchBaiduHotNoCors(): Promise<MacroNewsHeadline[]> {
  const nowIso = new Date().toISOString();

  // 尝试多个百度热搜页面
  const baiduUrls = [
    'https://top.baidu.com/',
    'https://top.baidu.com/board?tab=realtime',
    'https://top.baidu.com/board?tab=home',
  ];

  for (const url of baiduUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      // no-cors 模式：浏览器直接请求，不检查 CORS 响应头
      const resp = await fetch(url, {
        mode: 'no-cors',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });

      clearTimeout(timer);
      const html: string = await resp.text();

      if (!html || html.length < 500) continue;

      const items = parseBaiduHotHtml(html);

      if (items.length >= 3) {
        return items.map(item => ({
          title: item.title,
          source: `百度热搜${item.index <= 10 ? '-TOP' : ''}`,
          pubDate: nowIso,
          tag: 'social_hot' as const,
        }));
      }
    } catch {
      // 单个失败，继续试下一个
    }
  }

  return [];
}

// ==============================================================
// v9.0 新增：浏览器直抓百度新闻【热搜新闻词 HOT WORDS】板块
// 这是真正的实时新闻热搜（与 top.baidu.com 娱乐榜完全不同）
// 数据每 5 分钟自动更新
// ==============================================================
async function fetchBaiduNewsHotNoCors(): Promise<MacroNewsHeadline[]> {
  const nowIso = new Date().toISOString();
  const urls = [
    'https://news.baidu.com/',
    'https://news.baidu.com/?tab=home',
  ];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(url, {
        mode: 'no-cors',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });

      clearTimeout(timer);
      const html: string = await resp.text();
      if (!html || html.length < 500) continue;

      const items = parseBaiduNewsHotHtml(html);
      if (items.length >= 3) {
        return items.map((item, idx) => ({
          title: item.title,
          source: idx < 5 ? `百度新闻热搜-TOP${idx + 1}` : '百度新闻热搜',
          pubDate: nowIso,
          tag: 'social_hot' as const,
        }));
      }
    } catch {
      // try next url
    }
  }
  return [];
}

function parseBaiduNewsHotHtml(html: string): { title: string; index: number }[] {
  const items: { title: string; index: number }[] = [];

  // 方式1：精准匹配【热搜新闻词】板块
  // 板块头部通常是 "热搜新闻词" 或 "HOT WORDS" 之后的内容
  const hotSectionMatch = html.match(/热搜新闻词[\s\S]{0,5000}/);
  const hotHtml = hotSectionMatch ? hotSectionMatch[0] : html;

  // 方式1a：匹配 <a> 标签里的热搜词（百度新闻通常用 <a href="/s?wd=xxx">标题</a>）
  const pattern1 = /<a[^>]*>([^<]{6,80})<\/a>/g;
  let m;
  while ((m = pattern1.exec(hotHtml)) !== null && items.length < 20) {
    const title = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    // 过滤：必须是中文为主的标题，长度 8-60 字符
    if (title.length >= 8 && title.length <= 60 && /[\u4e00-\u9fff]/.test(title)) {
      // 去重
      if (!items.some(i => i.title === title)) {
        items.push({ title, index: items.length + 1 });
      }
    }
  }

  // 方式1b：匹配 data-title 或 title 属性的热搜词
  if (items.length < 5) {
    const pattern2 = /(?:data-title|title)="([^"]{8,80})"/g;
    while ((m = pattern2.exec(hotHtml)) !== null && items.length < 20) {
      const title = m[1].trim();
      if (/[\u4e00-\u9fff]/.test(title) && !items.some(i => i.title === title)) {
        items.push({ title, index: items.length + 1 });
      }
    }
  }

  // 方式1c：兜底 - 匹配纯文本里的中文热搜短语
  if (items.length < 3) {
    // 提取板块区域所有中文连续文本
    const textOnly = hotHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    // 匹配"习..."到下一个标点的中文短语
    const pattern3 = /([\u4e00-\u9fff][\u4e00-\u9fff\sA-Za-z0-9"]{8,60}[\u4e00-\u9fff！？。…])/g;
    while ((m = pattern3.exec(textOnly)) !== null && items.length < 15) {
      const title = m[1].trim().replace(/\s+/g, ' ');
      // 过滤明显非热搜词的内容（"百度一下" "登录" "设置" 等）
      const excludeKeywords = ['百度一下', '登录', '设置', '首页', '更多', '展开', '收起', '热点要闻', '百度新闻', '相关新闻'];
      if (excludeKeywords.some(k => title.includes(k))) continue;
      if (!items.some(i => i.title === title)) {
        items.push({ title, index: items.length + 1 });
      }
    }
  }

  return items.slice(0, 15);
}

// ==============================================================
// v8.0 新增：浏览器直抓微博热搜（no-cors 模式）
// 微博 m.weibo.cn 对 no-cors 请求友好
// ==============================================================
async function fetchWeiboHotNoCors(): Promise<MacroNewsHeadline[]> {
  const nowIso = new Date().toISOString();

  const weiboUrls = [
    'https://s.weibo.com/top/summary',
    'https://weibo.com/ajax/side/hotSearch',
  ];

  for (const url of weiboUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);

      const resp = await fetch(url, {
        mode: 'no-cors',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Referer': 'https://weibo.com/',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });

      clearTimeout(timer);
      const text: string = await resp.text();

      if (!text || text.length < 200) continue;

      const items: string[] = [];

      // 从 HTML 中提取微博热搜标题
      const pattern1 = /<a[^>]*href="[^"]*weibo[^"]*"[^>]*>([^<]{4,60})<\/a>/gi;
      let m;
      while ((m = pattern1.exec(text)) !== null && items.length < 20) {
        const title = m[1].trim().replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
        if (title.length >= 4) items.push(title);
      }

      if (items.length >= 3) {
        return items.map((title, i) => ({
          title,
          source: `微博热搜${i < 10 ? '-TOP' : ''}`,
          pubDate: nowIso,
          tag: 'social_hot' as const,
        }));
      }
    } catch {
      // 继续
    }
  }

  return [];
}

/**
 * 拉取多源 RSS + JSON 热搜，合并去重，返回可插入 LLM 的纯文本块。
 * v5.0 特性：
 * - 缓存按 UTC 日期+小时桶分片，跨小时自动失效，强制重新抓取
 * - 国内赛道额外并发抓取微博/抖音/今日热榜 JSON API 作为热搜关键词源
 * - 多代理重试（RSS 和 JSON 都走 CORS 代理）
 * - RSS/JSON 全部失败时自动降级到内置备选
 * - digest 中保留每条新闻的 pubDate（UTC 时间），便于 LLM 在选题中标注事件日期
 * @param maxLines 最大新闻条数
 * @param lang 语言/数据源：'en' 国际英文 | 'zh' 国际中文（含两岸）| 'cn-domestic' 国内民生/社会/全网热搜
 * @param forceRefresh 是否强制刷新（忽略缓存）。生成选题时建议每次都传 true，确保实时性
 */
export async function fetchMacroNewsDigestForPrompt(
  maxLines = 32,
  lang: 'en' | 'zh' | 'cn-domestic' = 'en',
  forceRefresh: boolean = false
): Promise<string> {
  const cacheKey = `digest_${lang}`;
  const bucket = getUtcTimeBucket();

  // v5.0 缓存检查：仅在 forceRefresh=false 且 时间桶未变 且 TTL 内复用
  // 跨小时强制重新抓取，确保每天每次生成都拿到最新数据
  if (
    !forceRefresh &&
    cachedDigest &&
    cachedDigest.lang === cacheKey &&
    cachedDigest.bucket === bucket &&
    Date.now() - cachedDigest.timestamp < CACHE_TTL_MS
  ) {
    return cachedDigest.content;
  }

  const perFeed = 4;
  const results: MacroNewsHeadline[][] = [];

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
  let successCount = 0; // 用 let（外层词法作用域）供内部回调正确写回
  const fetchPromises = feedsToFetch.map(async ({ url, label }) => {
    try {
      const xml = await fetchWithRetry(url);
      if (!xml) return [] as MacroNewsHeadline[];
      const headlines = parseFeedXml(xml, label, perFeed);
      if (headlines.length > 0) {
        successCount++; // let 闭包正确写回
      }
      return headlines;
    } catch {
      return [] as MacroNewsHeadline[];
    }
  });

  // v9.0：国内赛道优先级
  // 优先级：百度新闻热搜（实时新闻词）> 百度热搜（娱乐） > 微博热搜 > JSON API > RSS
  // 用户反馈：top.baidu.com 是娱乐榜，会拿到几个月前的旧闻；
  // 真正实时新闻词在 news.baidu.com 的【热搜新闻词 HOT WORDS】板块
  let cnDirectCount = 0;
  let jsonHotCount = 0;
  let baiduNewsHotCount = 0;
  if (lang === 'cn-domestic') {
    // 1) 百度新闻【热搜新闻词】（最高优先级 - 真正的实时新闻）
    const baiduNewsHotPromise = (async () => {
      try {
        const items = await fetchBaiduNewsHotNoCors();
        baiduNewsHotCount = items.length;
        return items;
      } catch {
        return [] as MacroNewsHeadline[];
      }
    })();

    // 2) 百度热搜（top.baidu.com，娱乐榜作补充）
    const baiduPromise = (async () => {
      try {
        const items = await fetchBaiduHotNoCors();
        cnDirectCount += items.length;
        return items;
      } catch {
        return [] as MacroNewsHeadline[];
      }
    })();

    // 3) 微博热搜（no-cors）
    const weiboPromise = (async () => {
      try {
        const items = await fetchWeiboHotNoCors();
        cnDirectCount += items.length;
        return items;
      } catch {
        return [] as MacroNewsHeadline[];
      }
    })();

    // 3) JSON API（走 allorigins CORS 代理，作为备选）
    const jsonHotPromise = (async () => {
      try {
        const hotItems = await fetchJsonHotSearches();
        jsonHotCount = hotItems.length;
        return hotItems;
      } catch {
        return [] as MacroNewsHeadline[];
      }
    })();

    fetchPromises.push(baiduNewsHotPromise, baiduPromise, weiboPromise, jsonHotPromise);
  }

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

  // v7.0：国内赛道 RSS/JSON 全失败时，不投喂占位符，保持 merged=[] 让 body 输出自搜指令
  if (merged.length === 0) {
    if (lang === 'cn-domestic') {
      // 保持空数组，由 body 生成「自搜指令」而非占位符
      merged = [];
    } else {
      merged = (lang === 'zh' ? ZH_FALLBACK_HEADLINES : FALLBACK_HEADLINES).slice(0, maxLines);
    }
  }

  const iso = new Date().toISOString();
  const time48hAgo = new Date(Date.now() - FRESH_THRESHOLD_MS).toISOString();
  const time7dAgo = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const utcBucket = getUtcTimeBucket();

  const rssInfo =
    successCount > 0
      ? `（RSS 成功抓取 ${successCount}/${feedsToFetch.length} 个源）`
      : lang === 'cn-domestic'
        ? '（RSS 全部失败，已切换为 LLM 自主搜索模式）'
        : lang === 'zh'
          ? '（RSS 全部失败，使用内置中文备选）'
          : '（RSS 全部失败，使用内置备选）';

  const hotInfo =
    lang === 'cn-domestic' && baiduNewsHotCount > 0
      ? ` + 百度新闻热搜 ${baiduNewsHotCount} 条（实时新闻词 TOP5）`
      : lang === 'cn-domestic' && cnDirectCount > 0
        ? ` + 百度/微博热搜 ${cnDirectCount} 条`
        : lang === 'cn-domestic' && jsonHotCount > 0
          ? ` + JSON 热搜 ${jsonHotCount} 条`
          : lang === 'cn-domestic' && successCount === 0
            ? '（实时源全部失败，已切换 LLM 自主搜索模式）'
            : '';

  const header =
    lang === 'cn-domestic'
      ? `# 【国内实时新闻热搜投喂 v9.1】百度新闻热搜+军事/政策/社会深度 RSS
|- 数据源：**百度新闻热搜 + 微博热搜**（no-cors 浏览器直连）+ **观察者网/财新/人民日报/澎湃新闻/米尔军情网** RSS（多镜像兜底）
|- 抓取时间（UTC ISO）：${iso}
|- 时间桶（UTC）：${utcBucket}（跨小时自动失效）
|- 抓取条数：百度新闻热搜 10+ 条 + 微博热搜 + 30+ 条 RSS（军事/政策/社会/财经）

# 🔴 选题偏好铁律（用户明确指定，覆盖任何其他规则）
**优先选题方向**（按用户偏好权重）：
- ✅ **军事/防务动态**（新型舰艇入列、军事演练、装备进展、防务政策、军工人事）
- ✅ **政策解读**（国务院/部委新规、地方改革、房地产调控、教育/医疗改革、税收政策、医保社保）
- ✅ **社会热点评论**（民生焦点、安全事故、群体性事件、舆论争议、社会不公、教育公平）
- ✅ **国家发展/重大工程**（基建狂魔、高铁/地铁/机场、深中通道、三峡、核电、航天、C919、福建舰）
- ✅ **灾害/应急**（地震/台风/暴雨/洪涝/救援/重建 - 选题角度要"英雄/救援/重建"而非"死亡人数"）
- ⚠️ **限制类**（可以用但非优先，单条不得超过 3 条）：
  - 体育赛事（亚冠、奥运、世预赛等国家队级别可保留，国际赛事可）
  - 商业/财经重大事件（企业并购、政策性金融事件）
- ❌ **禁止类**（用户明确排斥）：
  - 演唱会/歌友会/巡演/音乐节/明星演出事故（周杰伦/张靓颖等）
  - 明星塌房/八卦/私生活/情感纠葛（除非涉及违法）
  - 网红/带货/直播翻车（董宇辉、李佳琦等商业事件）
  - 娱乐真人秀/综艺爆料/影视花絮
  - 房产/汽车品牌日常发布（除非涉及重大变革）
  - 单纯的零食小吃/美食探店/旅游打卡

# 🔴 热搜词改写铁律
百度新闻/微博给的是热搜短词（如「习近平对晋江一鞋厂火灾作重要指示」「台风巴威最新路径」），你必须做新闻姐视角的改写和扩展：
- **不要**直接照搬热搜词原句作为标题
- **必须**给每条加上：悬念/反问/数字冲击/反差/情绪词中至少 2 个
- 改写示例：
  - 热搜词「成都暴雨」→ 标题「成都暴雨突袭：地铁站变水帘洞，市民拍下震撼画面」
  - 热搜词「台风巴威」→ 标题「超强台风巴威登陆倒计时！这些地区停课停工，3 万人紧急撤离」
  - 热搜词「晋江一鞋厂火灾」→ 标题「晋江鞋厂大火 12 人遇难，国务院紧急挂牌督办！真相何在？」
- 每条标题 15-35 字，必须覆盖：人物 + 事件 + 情绪/悬念/数字中至少 2 个

# 🔴 占位词铁律
绝对禁止「某顶流/某地/某主播/某某/某品牌」等占位词。热搜词里的具体人名/地名/品牌**必须直接用**。

# 时效规则
- 严格优先最近 48 小时（${time48hAgo} 之后）热点
- 10 条标题必须覆盖：军事/政策 ≥3 条 + 社会/民生 ≥3 条 + 国家发展/基建 ≥2 条 + 其他 ≤2 条
- 军事/政策类事件如果 48 小时内没有，至少引用 7 天内持续发酵的（如：芯片法案、多边安全演习等）
${rssInfo}${hotInfo}
`
      : lang === 'zh'
        ? `# 【国际要闻投喂 v5.0】系统自动抓取·UTC小时桶·每次生成强制刷新
|- 来源：Reuters、BBC World、Al Jazeera、Guardian、DW World、BBC中文、DW中文、中央社、CNA 等${rssInfo}
|- 抓取时间（UTC ISO）：${iso}
|- 时间桶（UTC）：${utcBucket}（跨小时自动失效重新抓取）
|- 时效规则：**优先最近 48 小时热门**（${time48hAgo} 后），同时保留 7 天内持续发酵事件（${time7dAgo} 后）
|- 用途：你必须据此写选题标题。优先选择持续发酵、热度上升的热门事件，覆盖范围：地缘冲突、台海局势、印太战略、中东冲突、金融货币战、科技封锁与反制、欧美产业围堵、大国政治角力
`
        : `# 【International Intelligence Feed v5.0】Auto-fetched · UTC hour bucket · Force refresh every generation
|- Sources: Reuters, BBC World, Al Jazeera, Guardian, DW World, CNA 等${rssInfo}
|- Fetch time (UTC ISO): ${iso}
|- Time bucket (UTC): ${utcBucket} (auto-invalidate every hour, ensures freshest data per generation)
|- Freshness rule: **Prioritize last 48 hours** (after ${time48hAgo}); also retain events trending within 7 days (after ${time7dAgo})
|- Coverage: Geopolitics, Taiwan Strait, Indo-Pacific, Middle East, Finance/Currency, Tech Blockade, Western Industrial Siege, Great Power Rivalry
|- You MUST anchor every topic title to at least one item in the feed above. Prioritize sustained-trending, rising-heat events over stable background noise.

`;

  // v7.0：每条新闻保留 pubDate 标注，让 LLM 知道事件发生时间
  // cn-domestic 全失败时，body 输出「自搜指令」而非空列表
  let body: string;
  if (lang === 'cn-domestic' && merged.length === 0) {
    const now = new Date();
    const nowUtcIso = now.toISOString();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const currentDay = now.getUTCDate();
    const currentHour = now.getUTCHours();

    body = `【实时热点自搜】实时数据源抓取失败（当前UTC时间：${nowUtcIso}）。
现要求你结合自身知识库，写出 **10 条抖音爆款选题**，**严禁**使用"某顶流"、"某地"、"某主播"、"某某"等占位词。
格式：每行一条标题，不要任何前缀、说明、思考过程、非标题内容。
要点：
- 选题须是 ${currentYear} 年 ${currentMonth} 月 真实发生的热点事件
- 每条必须含具体人名/地名/品牌/数字（如：XX演唱会翻车、XX地突发XX、XX品牌致歉）
- 优先选：突发事件/自然灾害/明星塌房/直播翻车/政策争议/网络热梗/社会民生焦点
- 严禁占位词（某顶流/某地/某主播/某某/某品牌/某公司）
**10 条全部必须真实具体，不许拒绝、不许说不知道、不许空缺**`;
  } else {
    body = merged
      .map((h, i) => {
        const dateTag = h.pubDate ? `（事件 ${formatPubDate(h.pubDate)} UTC）` : '';
        return `${i + 1}. [${h.source}] ${h.title} ${dateTag}`.trim();
      })
      .join('\n');
  }
  const digest = header + body;

  // 更新缓存（写入时间桶）
  cachedDigest = {
    lang: cacheKey,
    bucket,
    content: digest,
    timestamp: Date.now(),
  };

  return digest;
}


/**
 * 清除缓存（强制重新抓取）
 */
export function clearMacroNewsCache(): void {
  cachedDigest = null;
}
