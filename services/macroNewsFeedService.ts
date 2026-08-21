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

// 台湾本地新闻 RSS（台海局势子赛道专用）
// v6.0 多领域覆盖：政治+财经+社会+生活+国际，避免 RSS 投喂单一导致选题雷同（全部预算军购）
const TAIWAN_FEEDS: { url: string; label: string; tag: MacroNewsHeadline['tag'] }[] = [
  // ── 政治 ──
  { url: 'https://udn.com/rss/realtime?ch=tw_legislative', label: '联合报-立法院', tag: 'taiwan' },
  { url: 'https://udn.com/rss/realtime?ch=tw_election', label: '联合报-选举', tag: 'taiwan' },
  { url: 'https://www.setn.com/rss/realtime.aspx?CategoryName=Politics', label: '三立新闻-政治', tag: 'taiwan' },
  { url: 'https://www.ltn.com.tw/rss/politics.xml', label: '自由时报-政治', tag: 'taiwan' },
  { url: 'https://www.chinatimes.com/rss/politics.xml', label: '中时新闻-政治', tag: 'taiwan' },
  { url: 'https://news.tvbs.com.tw/rss/politics.xml', label: 'TVBS新闻-政治', tag: 'taiwan' },
  { url: 'https://www.cna.com.tw/rss/focus.xml', label: '中央社-焦点', tag: 'taiwan' },
  // ── 财经/产业 ──
  { url: 'https://udn.com/rss/realtime?ch=tw_finance', label: '联合报-财经', tag: 'taiwan_finance' },
  { url: 'https://www.chinatimes.com/rss/finance.xml', label: '中时新闻-财经', tag: 'taiwan_finance' },
  { url: 'https://www.setn.com/rss/realtime.aspx?CategoryName=Finance', label: '三立新闻-财经', tag: 'taiwan_finance' },
  { url: 'https://www.ltn.com.tw/rss/business.xml', label: '自由时报-财经', tag: 'taiwan_finance' },
  { url: 'https://news.tvbs.com.tw/rss/finance.xml', label: 'TVBS新闻-财经', tag: 'taiwan_finance' },
  // ── 社会/生活/食安/治安/司法 ──
  { url: 'https://udn.com/rss/realtime?ch=tw_society', label: '联合报-社会', tag: 'taiwan_society' },
  { url: 'https://www.setn.com/rss/realtime.aspx?CategoryName=Society', label: '三立新闻-社会', tag: 'taiwan_society' },
  { url: 'https://www.ltn.com.tw/rss/society.xml', label: '自由时报-社会', tag: 'taiwan_society' },
  { url: 'https://www.chinatimes.com/rss/society.xml', label: '中时新闻-社会', tag: 'taiwan_society' },
  { url: 'https://news.tvbs.com.tw/rss/society.xml', label: 'TVBS新闻-社会', tag: 'taiwan_society' },
  // ── 生活/健康/教育/旅游/文化 ──
  { url: 'https://udn.com/rss/realtime?ch=tw_life', label: '联合报-生活', tag: 'taiwan_life' },
  { url: 'https://www.setn.com/rss/realtime.aspx?CategoryName=Life', label: '三立新闻-生活', tag: 'taiwan_life' },
  { url: 'https://www.ltn.com.tw/rss/life.xml', label: '自由时报-生活', tag: 'taiwan_life' },
  { url: 'https://www.chinatimes.com/rss/life.xml', label: '中时新闻-生活', tag: 'taiwan_life' },
  // ── 国际/两岸 ──
  { url: 'https://udn.com/rss/realtime?ch=tw_world', label: '联合报-国际', tag: 'taiwan_world' },
  { url: 'https://www.cna.com.tw/rss/aall.aspx', label: '中央社-全部', tag: 'taiwan_world' },
  { url: 'https://www.chinatimes.com/rss/world.xml', label: '中时新闻-国际', tag: 'taiwan_world' },
  { url: 'https://www.ltn.com.tw/rss/world.xml', label: '自由时报-国际', tag: 'taiwan_world' },
  // ── 科技/产业/环境/地方 ──
  { url: 'https://udn.com/rss/realtime?ch=tw_science', label: '联合报-科技', tag: 'taiwan_tech' },
  { url: 'https://www.chinatimes.com/rss/technology.xml', label: '中时新闻-科技', tag: 'taiwan_tech' },
  { url: 'https://www.setn.com/rss/realtime.aspx?CategoryName=Tech', label: '三立新闻-科技', tag: 'taiwan_tech' },
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
// v11.0：补充用户指定的中国权威中文媒体（报道国际新闻，事实核查方便） +
//      全球主流通讯社原始电讯稿（Reuters/AP/AFP/Bloomberg/RIA Novosti）
//      + 国际知名媒体英文原版（BBC/Guardian/Al Jazeera/CNN/WSJ）
//      由于国内浏览器/Cursor IDE 直连海外 RSS 经常被墙，统一走 RSSHub 镜像 + 兜底镜像
const EN_FEEDS: { url: string; label: string; tag?: MacroNewsHeadline['tag'] }[] = [
  // ─── 直接可访问的官方 RSS ───
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', label: 'BBC World', tag: 'geopolitics' },
  { url: 'https://rss.dw.com/rdf/rss-en-world', label: 'DW World', tag: 'geopolitics' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', label: 'Al Jazeera', tag: 'mideast' },
  { url: 'https://feeds.reuters.com/reuters/worldNews', label: 'Reuters World', tag: 'geopolitics' },
  { url: 'https://feeds.reuters.com/reuters/businessNews', label: 'Reuters Business', tag: 'finance' },
  { url: 'https://feeds.reuters.com/reuters/technologyNews', label: 'Reuters Tech', tag: 'tech' },
  { url: 'https://www.theguardian.com/world/rss', label: 'Guardian World', tag: 'geopolitics' },
  { url: 'https://www.spiegel.de/international/index.rss', label: 'Spiegel Intl', tag: 'geopolitics' },

  // ─── 国内权威中文媒体（国际新闻事实核查友好）— 走 RSSHub 镜像 + 兜底 ───
  { url: 'https://rsshub.app/xinhuanet/world', label: '新华网国际', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/xinhuanet/world', label: '新华网国际-rsfb', tag: 'geopolitics' },
  { url: 'https://hub.slarker.com/xinhuanet/world', label: '新华网国际-slk', tag: 'geopolitics' },
  { url: 'https://rsshub.app/cctv/world', label: '央视网国际', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/cctv/world', label: '央视网国际-rsfb', tag: 'geopolitics' },
  { url: 'https://hub.slarker.com/cctv/world', label: '央视网国际-slk', tag: 'geopolitics' },
  { url: 'https://rsshub.app/chinanews/world', label: '中新网国际', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/chinanews/world', label: '中新网国际-rsfb', tag: 'geopolitics' },
  { url: 'https://hub.slarker.com/chinanews/world', label: '中新网国际-slk', tag: 'geopolitics' },
  { url: 'https://rsshub.app/huanqiu', label: '环球网', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/huanqiu', label: '环球网-rsfb', tag: 'geopolitics' },
  { url: 'https://hub.slarker.com/huanqiu', label: '环球网-slk', tag: 'geopolitics' },
  { url: 'https://rsshub.app/zaobao/news/world', label: '联合早报国际', tag: 'indo_pacific' },
  { url: 'https://rsshub.rssforever.com/zaobao/news/world', label: '联合早报国际-rsfb', tag: 'indo_pacific' },
  { url: 'https://hub.slarker.com/zaobao/news/world', label: '联合早报国际-slk', tag: 'indo_pacific' },

  // ─── 全球主流通讯社（原始电讯稿）— 走 RSSHub 镜像 ───
  // 路透社 Reuters
  { url: 'https://rsshub.app/reuters/world', label: 'Reuters World-rsshub', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/reuters/world', label: 'Reuters World-rsfb', tag: 'geopolitics' },
  // 法新社 AFP
  { url: 'https://rsshub.app/afp/world', label: 'AFP World-rsshub', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/afp/world', label: 'AFP World-rsfb', tag: 'geopolitics' },
  // 美联社 AP
  { url: 'https://rsshub.app/apnews/topics/world-news', label: 'AP World News-rsshub', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/apnews/topics/world-news', label: 'AP World News-rsfb', tag: 'geopolitics' },
  // 彭博 Bloomberg（侧重财经 + 国际政治）
  { url: 'https://rsshub.app/bloomberg/news', label: 'Bloomberg-rsshub', tag: 'finance' },
  { url: 'https://rsshub.rssforever.com/bloomberg/news', label: 'Bloomberg-rsfb', tag: 'finance' },
  { url: 'https://rsshub.app/bloomberg/markets', label: 'Bloomberg Markets-rsshub', tag: 'finance' },
  { url: 'https://rsshub.rssforever.com/bloomberg/markets', label: 'Bloomberg Markets-rsfb', tag: 'finance' },
  // 俄新社 RIA Novosti
  { url: 'https://rsshub.app/ria/world', label: 'RIA Novosti-rsshub', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/ria/world', label: 'RIA Novosti-rsfb', tag: 'geopolitics' },

  // ─── 国际知名媒体英文原版 — 走 RSSHub 镜像 ───
  // BBC News（已有直接源 + RSSHub 镜像兜底）
  { url: 'https://rsshub.app/bbc/world', label: 'BBC World-rsshub', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/bbc/world', label: 'BBC World-rsfb', tag: 'geopolitics' },
  // 卫报 The Guardian（已有直接源）
  { url: 'https://rsshub.app/guardian/world', label: 'Guardian World-rsshub', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/guardian/world', label: 'Guardian World-rsfb', tag: 'geopolitics' },
  // 半岛电视台 Al Jazeera（已有直接源）
  { url: 'https://rsshub.app/aljazeera/news', label: 'Al Jazeera-rsshub', tag: 'mideast' },
  { url: 'https://rsshub.rssforever.com/aljazeera/news', label: 'Al Jazeera-rsfb', tag: 'mideast' },
  // CNN（美国有线电视新闻网）
  { url: 'https://rsshub.app/cnn/world', label: 'CNN World-rsshub', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/cnn/world', label: 'CNN World-rsfb', tag: 'geopolitics' },
  // 华尔街日报 WSJ（全球财经 + 国际政治）
  { url: 'https://rsshub.app/wsj/world', label: 'WSJ World-rsshub', tag: 'geopolitics' },
  { url: 'https://rsshub.rssforever.com/wsj/world', label: 'WSJ World-rsfb', tag: 'geopolitics' },
];

// ============ 子赛道 → RSS tag 映射（v10.0）============
// 用途：每个 NEWS_SUB_MODE 关联一个或多个 RSS tag，生成选题时只取匹配 tag 的新闻
// 保证中东冲突只取中东相关新闻、金融货币战只取金融相关新闻，等等
const SUB_MODE_TAG_MAP: Record<string, MacroNewsHeadline['tag'][]> = {
  // 地缘冲突（中东/俄乌/欧洲战场合并）
  GEO_POLITICS: ['mideast', 'geopolitics'],
  // 印太战略：Quad/AUKUS/南海/日韩印澳
  INDO_PACIFIC: ['indo_pacific', 'geopolitics'],
  // 中东冲突：加沙/伊朗/以色列/胡塞/OPEC
  MIDEAST_CONFLICT: ['mideast', 'energy'],
  // 金融货币战：美联储/美元/汇率/金砖/债务
  FINANCE_CURRENCY: ['finance'],
  // 科技封锁：芯片/AI/稀土/TikTok
  TECH_BLOCKADE: ['tech', 'us_china'],
  // 欧美产业围堵：关税/供应链/碳关税
  WESTERN_SIEGE: ['finance', 'geopolitics'],
  // 大国政治角力：G20/外交/联合国/峰会
  GREAT_POWER_GAME: ['geopolitics', 'us_china'],
};

function getSubModeTags(subMode?: string): MacroNewsHeadline['tag'][] | undefined {
  if (!subMode) return undefined;
  return SUB_MODE_TAG_MAP[subMode];
}

/**
 * 按 tag 过滤 feeds。RSS feed 没有 tag 时（fallback/通用源）始终保留，避免拿不到任何数据
 */
function filterFeedsByTags(
  feeds: { url: string; label: string; tag?: MacroNewsHeadline['tag'] }[],
  tags: MacroNewsHeadline['tag'][]
): typeof feeds {
  // 至少保留一个没有 tag 的通用源作 fallback（Al Jazeera 等综合性源）
  const untagged = feeds.filter((f) => !f.tag);
  const taggedMatching = feeds.filter((f) => f.tag && tags.includes(f.tag));
  // 合并去重（URL 相同只保留一份）
  const seen = new Set<string>();
  const out: typeof feeds = [];
  for (const f of [...taggedMatching, ...untagged]) {
    if (!seen.has(f.url)) {
      seen.add(f.url);
      out.push(f);
    }
  }
  return out.length > 0 ? out : feeds;
}

/** 把 subMode id 翻译成人类可读的中文赛道名（用于 prompt 头部提示） */
export function subModeName(subMode?: string): string {
  switch (subMode) {
    case 'GEO_POLITICS': return '地缘冲突';
    case 'TAIWAN_STRAIT': return '台海局势';
    case 'INDO_PACIFIC': return '印太战略';
    case 'MIDEAST_CONFLICT': return '中东冲突与能源博弈';
    case 'FINANCE_CURRENCY': return '金融货币战与经济博弈';
    case 'TECH_BLOCKADE': return '科技封锁与反制';
    case 'WESTERN_SIEGE': return '欧美产业围堵与供应链重构';
    case 'GREAT_POWER_GAME': return '大国政治角力与权力重组';
    case 'DOUYIN_HOT': return '国内民生/抖音热点';
    default: return '国际新闻（通用）';
  }
}

/** 给 LLM 的子赛道具体覆盖范围提示，避免模型跨赛道选题 */
function subModeCoverageLine(subMode?: string): string {
  switch (subMode) {
    case 'GEO_POLITICS':
      return '||- 本赛道覆盖（中东战火/俄乌/南海/红海/伊朗以色列对峙等），按以下优先级排序：\n' +
        '||- **第一圈·超级大国（必含 ≥4 条）**：美国/特朗普政府（对俄乌/中东政策、北约/欧盟关系、对伊制裁、对中关税战、对台军售）；中国/中俄关系（上合/金砖/G20 博弈、对美反制、台海军售回应）\n' +
        '||- **第二圈·主战场热战（必含 ≥3 条）**：俄罗斯-乌克兰战争（俄乌拉锯/黑海航运/无人机互袭）；美-以色列-伊朗大规模冲突（2026-02-28 爆发·霍尔木兹封锁/红海外溢/真主党/胡塞联动）；以色列-黎巴嫩/真主党边境；加沙/巴以；也门胡塞武装红海袭扰\n' +
        '||- **第三圈·大国博弈延伸（可选 ≤3 条）**：朝鲜半岛（朝鲜 vs 美韩）；中国-菲律宾南海博弈；印巴克什米尔对峙；阿塞拜疆-亚美尼亚南高加索；北极博弈；拉美（美后院）\n' +
        '||- **🚫 禁止冷门国家（不作为选题）**：阿富汗/塔利班、乍得、苏丹内战、刚果（金）、索马里、萨赫勒、布基纳法索、马里、尼日尔、海地、缅甸若开邦等小国独立新闻\n' +
        '||- **🚫 禁止冷门议题**：非洲小国政变、中亚小规模边境冲突、武器参数科普\n' +
        '||- **硬约束**：10 条中 ≥3 条与"美国/特朗普"相关，≥2 条与"中国"相关，至少 3 种冲突类型';
    case 'INDO_PACIFIC':
      return '||- 本赛道覆盖：美日印澳四方安全对话（Quad）、AUKUS 核潜艇协议、南海军事化、菲律宾/越南海洋争端、美韩同盟强化、日本防卫预算、印度边境对峙、中美海上博弈';
    case 'MIDEAST_CONFLICT':
      return '||- 本赛道**仅**覆盖：加沙战争最新进展、伊朗核协议僵局、胡塞武装封锁红海、以色列与黎巴嫩边境冲突、沙特与伊朗和解、叙利亚/伊拉克乱局、OPEC+ 能源政策\n||- **禁止输出**：俄乌战争、欧洲政治、台海、印太、美元汇率、AI 芯片等非中东议题';
    case 'FINANCE_CURRENCY':
      return '||- 本赛道**仅**覆盖：美联储利率决策、美元霸权动摇、人民币汇率波动、SWIFT 制裁、金砖国家本币结算、加密货币监管、全球债务危机、黄金价格、美元美债收益率异动\n||- **禁止输出**：军事冲突、台海、印太、加沙、芯片、AI 等非金融议题';
    case 'TECH_BLOCKADE':
      return '||- 本赛道**仅**覆盖：美国芯片出口管制升级、荷兰 ASML 光刻机断供、中国半导体自主突围、华为最新动态、AI 芯片竞争、量子计算竞赛、稀土出口管制、TikTok 算法之争、科技冷战\n||- **禁止输出**：中东战火、俄乌、台海、汇率、关税等非科技议题';
    case 'WESTERN_SIEGE':
      return '||- 本赛道**仅**覆盖：美国《通胀削减法案》引发的贸易摩擦、欧盟碳关税、供应链友岸外包、电动汽车关税战、锂电池产业链、稀土供应链联盟、去全球化、关税壁垒\n||- **禁止输出**：军事冲突、中东、汇率、芯片 AI 等非产业议题';
    case 'GREAT_POWER_GAME':
      return '||- 本赛道**仅**覆盖：中美高层外交博弈、G20/APEC 峰会、俄乌战争幕后谈判、联合国投票博弈、中东代理人战争、朝鲜半岛博弈、金砖扩员、全球治理重塑\n||- **禁止输出**：单点科技/单点金融/单点军事新闻（应聚焦大国关系、外交博弈）';
    default:
      return '';
  }
}

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
// v7.0: 所有选题必须锚定2026年最新事件，禁止使用泛化选题

const FALLBACK_HEADLINES: MacroNewsHeadline[] = [
  // 地缘冲突 / 中东（必须锚定2026年最新事件）
  { title: 'Feb 28, 2026: US-Israel-Iran conflict erupts, Strait of Hormuz tensions surge', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: 'March 2026: Iran nuclear activities trigger emergency IAEA response after Feb 28 conflict', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: 'Feb 2026: Houthi forces launch new Red Sea attacks, US carrier group enters combat position', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: 'March 2026: Iran-Russia deepen energy cooperation amid escalating US sanctions', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: 'Feb 2026: Israel-Lebanon border clashes intensify, Trump ceasefire deal faces critical test', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  // 俄乌
  { title: 'March 2026: Russian forces launch major assault on Donetsk, Zelensky urges NATO long-range missiles', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'geopolitics' },
  { title: 'Feb 2026: Putin-Xi meeting coordinates voting positions in UN Security Council', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'geopolitics' },
  // 印太
  { title: 'Feb 2026: China-Philippines clash near Scarborough Shoal, US Indo-Pacific Command issues warning', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  { title: 'March 2026: Kim Jong Un unveils new ICBM, US-South Korea joint drills reach record scale', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  // 金融货币战
  { title: 'March 2026: Federal Reserve announces latest rate decision, dollar index shocks emerging markets', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'finance' },
  { title: 'Feb 2026: Yuan breaks key support level, trade war tariffs continue to weigh on outlook', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'finance' },
  // 科技封锁
  { title: 'March 2026: US Commerce Department adds multiple Chinese tech firms to entity list, chip war escalates', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'tech' },
  { title: 'Feb 2026: Netherlands tightens ASML export licenses, new tech war dynamics emerge', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'tech' },
  // 大国博弈
  { title: 'March 2026: Top US-China officials hold secret talks in third country, Taiwan and trade in focus', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'us_china' },
  { title: '2026 G7 Summit approaches, member nations show rare divisions on Russia sanctions', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'us_china' },
  // 台海局势
  { title: 'Feb 2026: PLA launches new military exercises around Taiwan Strait, sends strong signal', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  { title: 'March 2026: US Congress approves new Taiwan arms package, Pentagon releases detailed list', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  // 印太战略
  { title: 'March 2026: Quad nations hold summit, Indo-Pacific joint exercises reach record scale', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  { title: 'Feb 2026: Japan-Philippines sign new defense agreement, strengthen first island chain deployment', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  // 能源
  { title: 'March 2026: OPEC+ announces latest production cuts, international oil prices jump', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
  { title: '2026 Middle East tensions push shipping insurance premiums higher, Hormuz tanker costs surge', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
];

const ZH_FALLBACK_HEADLINES: MacroNewsHeadline[] = [
  // 地缘冲突 / 中东（v7.0：必须锚定2026年最新事件，禁止使用泛化选题）
  // ⚠️ 核心约束：以下每条选题必须关联2026年2月28日之后的事件
  // 禁止出现"酝酿""考虑""或将"等模糊时态，必须是已发生的具体事件
  { title: '2026年2月28日美以伊爆发大规模军事冲突，霍尔木兹海峡局势骤然升温', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: '2026年2月美以伊冲突升级后，伊朗核活动引发国际原子能机构紧急关注', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: '2026年3月伊朗与俄罗斯深化能源合作，中俄伊三角关系出现新动向', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: '2026年2月胡塞武装在红海发动新一轮袭击，美军航母战斗群进入战位', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: '2026年2月以色列与黎巴嫩边境冲突加剧，特朗普斡旋停火协议面临考验', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'mideast' },
  { title: '2026年3月俄军猛攻顿涅茨克，泽连斯基紧急呼吁北约提供远程导弹', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'geopolitics' },
  { title: '2026年2月中菲在黄岩岛再次对峙，美军印太司令部发布航行警告', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  { title: '2026年3月金正恩展示新型洲际导弹，美韩联合军演规模创历史新高', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  { title: '2026年2月普京与习近平举行会谈，中俄在联合国安理会投票立场协调', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'geopolitics' },
  // 金融货币战（锚定近期具体事件）
  { title: '2026年3月美联储宣布最新利率决定，美元指数走势震动新兴市场', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'finance' },
  { title: '2026年2月人民币汇率跌破重要关口，贸易战关税影响持续发酵', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'finance' },
  // 科技封锁与反制
  { title: '2026年3月美国商务部将多家中国科技企业列入实体清单，芯片战升级', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'tech' },
  { title: '2026年2月荷兰政府收紧光刻机出口许可，ASML对华供货引发新博弈', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'tech' },
  // 大国政治角力
  { title: '2026年3月中美高层在第三国举行秘密会谈，台海与贸易问题成焦点', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'us_china' },
  { title: '2026年G7峰会召开在即，成员国在制裁俄罗斯问题上出现罕见分歧', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'us_china' },
  // 台海局势（锚定近期具体事件）
  { title: '2026年2月解放军在台海周边展开新一轮军事演习，释放强烈信号', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  { title: '2026年3月美国国会通过新一轮对台军售案，五角大楼公布军售清单', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan' },
  // 台湾本地（财经/社会/民生）
  { title: '2026年台积电法说会释出最新展望，AI芯片需求推动资本支出大幅上调', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan_finance' },
  { title: '2026年台湾健保费率调整方案出炉，工商团体与医界反弹激烈', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan_society' },
  { title: '2026年台风季节来临，气象局发布首个台风警报，全台戒备', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'taiwan_life' },
  // 印太战略
  { title: '2026年3月四方安全对话举行峰会，印太联合军演规模创纪录', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  { title: '2026年2月日本与菲律宾签署新版防卫协议，强化第一岛链战略部署', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'indo_pacific' },
  // 能源产业
  { title: '2026年3月欧佩克+宣布最新减产决定，国际油价应声上涨', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
  { title: '2026年中东局势紧张推高航运保险费，霍尔木兹海峡油轮通行成本飙升', source: 'Fallback', pubDate: new Date().toISOString(), tag: 'energy' },
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

  // 静默返回，不打印日志
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
  lang: 'en' | 'zh' | 'cn-domestic' | 'taiwan' = 'en',
  forceRefresh: boolean = false,
  subMode?: string
): Promise<string> {
  const cacheKey = `digest_${lang}_${subMode || 'all'}`;
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
  let feedsToFetch: { url: string; label: string; tag?: MacroNewsHeadline['tag'] }[];
  if (lang === 'cn-domestic') {
    // 国内民生/抖音热点/微博/知乎：仅抓取国内源
    feedsToFetch = CN_DOMESTIC_FEEDS;
  } else if (lang === 'zh') {
    feedsToFetch = [...EN_FEEDS, ...ZH_FEEDS];
  } else if (lang === 'taiwan') {
    // 台海局势子赛道：抓取台湾本地新闻源
    feedsToFetch = TAIWAN_FEEDS;
  } else {
    feedsToFetch = EN_FEEDS;
  }

  // v10.0: 按子赛道 tag 过滤——保证选题严格匹配赛道
  const subModeTags = getSubModeTags(subMode);
  if (subModeTags && (lang === 'en' || lang === 'zh')) {
    feedsToFetch = filterFeedsByTags(feedsToFetch, subModeTags);
    console.debug(`[MacroNewsFeed] subMode=${subMode} 过滤 feeds → ${feedsToFetch.length} 个`);
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
  const _now = new Date();
  const _currentYear = _now.getUTCFullYear();
  const _currentMonth = _now.getUTCMonth() + 1;
  const _currentDay = _now.getUTCDate();

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

# 🔴⚠️ 标题格式铁律（最高优先级 - 违反视为不合格）
**【本规则的优先级高于一切其他铁律，必须 100% 严格遵守】**

每条标题 EXACT 格式：

【事件发生日期·地点】标题正文

约束：
- 事件发生日期：X月X日（事件实际发生日期，禁止全 10 条同一天）
- 地点：城市或国家名（2-8 字）
- ✅ 正确示例：
  - 【8月20日·北京】国务院发布房地产新政
  - 【8月19日·成都】暴雨突袭：地铁站变水帘洞
  - 【8月17日·晋江】鞋厂大火 12 人遇难，国务院挂牌督办
- ❌ 错误示例：
  - 没有【】包围的标题
  - 全 10 条都用同一个日期

**禁止事项（简要）**：
- 禁止选择过去 12 个月内反复出现、热度早已消退的旧议题
- 禁止复读之前已输出过的选题
- 优先从下方【参考新闻列表】中提取事件，禁止凭空编造

# 🔴 热搜词改写铁律
百度新闻/微博给的是热搜短词（如「习近平对晋江一鞋厂火灾作重要指示」「台风巴威最新路径」），你必须做新闻姐视角的改写和扩展：
- **不要**直接照搬热搜词原句作为标题
- **必须**给每条加上：悬念/反问/数字冲击/反差/情绪词中至少 2 个
- **必须**在每条标题前加【X月X日·地点】标注（参照上方时间地点铁律）
- 改写示例：
  - 热搜词「成都暴雨」→ 标题「【8月19日·成都】暴雨突袭：地铁站变水帘洞，市民拍下震撼画面」
  - 热搜词「台风巴威」→ 标题「【8月18日·浙江】超强台风巴威登陆倒计时！这些地区停课停工，3 万人紧急撤离」
  - 热搜词「晋江一鞋厂火灾」→ 标题「【8月17日·晋江】鞋厂大火 12 人遇难，国务院紧急挂牌督办！真相何在？」
- 每条标题 15-35 字，必须覆盖：人物 + 事件 + 情绪/悬念/数字中至少 2 个
- ✅ 每条标题前必须有【事件发生日期·地点】标注（如【8月19日·成都】），与上方时间地点铁律一致

# 🔴 占位词铁律
绝对禁止「某顶流/某地/某主播/某某/某品牌」等占位词。热搜词里的具体人名/地名/品牌**必须直接用**。

# 时效规则
- 严格优先最近 48 小时（${time48hAgo} 之后）热点
- 10 条标题必须覆盖：军事/政策 ≥3 条 + 社会/民生 ≥3 条 + 国家发展/基建 ≥2 条 + 其他 ≤2 条
- 军事/政策类事件如果 48 小时内没有，至少引用 7 天内持续发酵的（如：芯片法案、多边安全演习等）
${rssInfo}${hotInfo}
`
      : lang === 'zh'
        ? `# 【国际要闻投喂 v11.0】${new Date().getUTCFullYear()} 年·UTC小时桶·每次生成强制刷新
||- 来源：Reuters / BBC / Al Jazeera / Guardian / DW / 新华网 / 央视网 / 中新网 / 环球网 / 联合早报 / Bloomberg / AP / AFP / RIA / CNA / 中央社 等${rssInfo}
||- 抓取时间（UTC ISO）：${iso}
||- 时间桶（UTC）：${utcBucket}（跨小时自动失效重新抓取）
||- 当前是 **${new Date().getUTCFullYear()} 年** —— 严格禁止选任何 ${new Date().getUTCFullYear() - 1} 年及更早的事件

---

## 🎯 三类万能标题模板（机器随机匹配 — 10 条须覆盖至少 3 类）

**T1. 【突发】+ 国家主体 + 重大动作 + 带来什么影响**
> 示例：\`【2026年8月20日·华盛顿】突发：特朗普签署对华芯片新禁令，全球半导体供应链一夜动荡\`

**T2. 局势突变！XX出手了，这一次和以往完全不同**
> 示例：\`【2026年8月19日·莫斯科】局势突变！俄罗斯突然从赫尔松撤军，这一次和以往完全不同\`

**T3. 时隔X年！国际大局再次重演，普通人要看懂**
> 示例：\`【2026年8月18日·东京】时隔35年！日本再次启动核电机组，普通人要看懂能源大变局\`

---

## ✅ 5 条硬性过滤规则（符合即输出成文）

**【必选·优先输出】**
1. **大国动态**：美国 / 俄罗斯 / 中国 / 中东 / 朝鲜半岛 / 东亚 / 俄乌战争 / 美伊战争
2. **制裁、冲突、谈判、翻脸、结盟**（有输赢、有剧情）
3. **能源、油价、粮食、全球经济波动**（贴近生活）
4. **历史呼应事件**：和过去几十年局势能对照的内容
5. **反转、突发、最新宣判、最新声明**（时效性强）

**【❌ 直接过滤·不做】**
- 🚫 **【硬红线·最高优先级】所有香港/澳门/西藏/新疆/台湾 任何政治议题、历史事件、当代政策、人物、机构、事件**（如：香港国安法、支联会、苹果日报、黎智英、雨伞革命、占中、反修例、维园、铜锣湾、831、721、林郑、李家超、澳门博彩、台湾半导体、台海军演等）—— 即使新闻列表中出现也**必须忽略**，绝不输出
- 小众国家琐碎新闻、科技细枝末节、娱乐圈国际新闻
- 纯学术、纯数据、无故事性内容
- 过于偏激、敏感、纯负面煽动内容

**【🚨 地点不在已知列表·则兜底为「国际」】** 严禁在没有识别出具体国家/城市时输出空地点「【年月日·】」（系统会在年份后自动写入「国际」兜底），生成时必须从以下国家/国际组织中找到匹配：美/俄/中/英/法/德/日/韩/朝/印/巴/以/伊/沙特/阿联酋/土耳其/乌克/叙/埃及/南非/巴西/阿根廷/联合国/北约/G7/G20/金砖/上合。

---

## ⚠️ 输出格式铁律（违反视为不合格）

| 规则 | 要求 |
|------|------|
| 数量 | 严格 10 条，不多不少 |
| 格式 | \`【2026年X月X日·地点】标题正文\` —— **必须有4位年份 + 完整日期 + 地点** |
| 句式 | 10 条标题使用**至少 3 种模板**（T1/T2/T3），禁止 10 条都用同一模板 |
| 地点 | 必须是具体国家/城市（如「华盛顿」「莫斯科」「东京」），禁用「待补」「某地」 |
| 钩子 | 每条须含：**具体人物/数字/对比/悬念**至少其一 |
| 长度 | 22–45 字 |
| 多样性 | 10 条**至少覆盖 5 种不同事件**（事件主线/话题维度/地区维度均不同），禁止同一条新闻用 3 个不同钩子写 3 条 |
| 同事件多视角 | 同一事件可以**用不同角度**输出 1-2 条标题（如「俄副外长称愿与美谈」+「美俄谈判桌摆上筹码」），但不能 3 条以上都围绕同一事件换皮 |
| 禁止 | 任何前言/结语/分析/分小标题/解释/道歉/对话/列表符号 |
| 禁止 | 编造时间地点不明的"网络传言" |
| 禁止 | 复读已输出选题、两条标题指同一事件 |
| 禁止 | 选任何 ${new Date().getUTCFullYear() - 1} 年及更早事件（即使 LLM 知识库中存有强烈记忆） |

**❌ 错误示例**：所有标题都写"2026年8月21日"、地点都是"待补"、10 条都用同一句式
**✅ 正确示例**：见上方 T1/T2/T3 模板

当前子赛道：**${subModeName(subMode)}**（已按赛道标签过滤）
${subModeCoverageLine(subMode)}
`
        : `# 【International Intelligence Feed v5.0】Auto-fetched · UTC hour bucket · Force refresh every generation
|- Sources: Reuters, BBC World, Al Jazeera, Guardian, DW World, CNA 等${rssInfo}
|- Fetch time (UTC ISO): ${iso}
|- Time bucket (UTC): ${utcBucket} (auto-invalidate every hour, ensures freshest data per generation)
|- Freshness rule: **Prioritize last 48 hours** (after ${time48hAgo}); also retain events trending within 7 days (after ${time7dAgo})
|- Current sub-track: **${subModeName(subMode)}** (already filtered by track tag) — all topic titles MUST focus on this sub-track. Strictly forbid any off-topic international news.\n${subModeCoverageLine(subMode)}
|- You MUST anchor every topic title to at least one item in the feed above. Prioritize sustained-trending, rising-heat events over stable background noise.

`;

  // v7.0：每条新闻保留 pubDate 标注，让 LLM 知道事件发生时间
  // v9.2：cn-domestic 始终使用带时间地点标注的选题指令，不管 feeds 是否成功
  let body: string;
  if (lang === 'cn-domestic') {
    const now = new Date();
    const nowUtcIso = now.toISOString();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const currentDay = now.getUTCDate();

    // 如果有成功抓取的新闻，追加到提示中
    const newsContext = merged.length > 0
      ? `\n\n## 参考新闻（已按时效性过滤，可结合这些事件生成选题）：\n${merged.map((h, i) => `${i + 1}. [${h.source}] ${h.title}${h.pubDate ? `（${formatPubDate(h.pubDate)}）` : ''}`).join('\n')}`
      : '';

    body = `【⚠️ 强制时间锚点 - 最高优先级】当前UTC时间：${nowUtcIso}。今天是 ${currentYear} 年 ${currentMonth} 月 ${currentDay} 日。

现要求你结合【下方参考新闻列表】+ 自身知识库，写出 **10 条抖音爆款选题**，**严禁**使用"某顶流"、"某地"、"某主播"、"某某"等占位词。${newsContext}

**🔴 必填格式：每条标题必须有【事件发生日期·地点】标注**
（必须是事件本身的实际发生日期，不是今天。10 条日期必须分布不同日期）

格式：【X月X日·地点】标题正文

✅ 示例：
- 【8月20日·北京】国务院发布房地产新政
- 【8月19日·东京】台风"格美"登陆日本，千人紧急疏散
- 【8月17日·晋江】鞋厂大火 12 人遇难，国务院挂牌督办

❌ 错误示例：
- 没有【】包围的标题
- 所有标题都写同一个日期

**🔴 禁止事项**：
- 禁止选择过去 12 个月已多次反复出现的旧议题、多年周期反复发酵的陈年话题
- 禁止复读之前已输出的选题，禁止两条标题指向同一事件

格式: 每行一个【事件发生日期·地点】+ 标题，不要任何前缀、说明、思考过程。
要点:
- 必须从下方【参考新闻列表】中提取事件，每条事件对应独立标题
- 每条必须含具体人名/地名/品牌/数字
- 优先选：突发事件/自然灾害/明星塌房/直播翻车/政策争议/网络热梗/社会民生焦点
- 严禁占位词（某顶流/某地/某主播/某某/某品牌/某公司）
**10 条全部必须真实具体，带【事件发生日期·地点】标注，10 条必须是不重复的真实事件，不许拒绝、不许说不知道、不许空缺**`;
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
