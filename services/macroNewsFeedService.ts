/**
 * 宏观预警选题：聚合国际主流媒体 RSS（经浏览器可访问的 CORS 代理），
 * 供每次「一键生成爆款选题」注入提示词，避免模型反复输出同一批静态热点。
 */

export type MacroNewsHeadline = {
  title: string;
  source: string;
  pubDate?: string;
};

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

const FEEDS: { url: string; label: string }[] = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', label: 'BBC World' },
  { url: 'https://rss.dw.com/rdf/rss-en-world', label: 'DW World' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', label: 'Al Jazeera' },
  { url: 'https://www.france24.com/en/rss', label: 'France 24' },
  { url: 'https://feeds.skynews.com/feeds/rss/world.xml', label: 'Sky News World' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', label: 'CNBC Top News' },
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

async function fetchXmlThroughProxy(url: string): Promise<string | null> {
  const proxies = [
    (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ];

  for (const build of proxies) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(build(url), { signal: controller.signal, headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } });
      clearTimeout(timer);
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.length > 400) return text;
    } catch {
      /* try next proxy */
    }
  }
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
 */
export async function fetchMacroNewsDigestForPrompt(maxLines = 32): Promise<string> {
  const perFeed = 12;
  const results = await Promise.all(
    FEEDS.map(async ({ url, label }) => {
      const xml = await fetchXmlThroughProxy(url);
      if (!xml) return [] as MacroNewsHeadline[];
      return parseFeedXml(xml, label, perFeed);
    })
  );

  const flat = results.flat();
  const merged = dedupeHeadlines(flat, maxLines);

  const iso = new Date().toISOString();
  const header =
    `# 【国际要闻投喂】系统自动抓取\n` +
    `- 来源：BBC World、DW、Al Jazeera、France 24、Sky World、CNBC 等公开 RSS（经代理拉取）\n` +
    `- 抓取时间（ISO）：${iso}\n` +
    `- 时效：优先保留 RSS 中标注为近 7 日内的条目；无日期条目亦保留以免漏报突发\n` +
    `- 用途：你必须据此写选题标题，禁止无视本列表整组输出与新闻无关的套话\n\n`;

  if (merged.length === 0) {
    return (
      header +
      `（本次未能拉取到有效 RSS 条目，可能为网络或代理限制。）\n` +
      `请根据当前 UTC 日期，自行检索心智中的**近一周**国际地缘、能源、利率、股市、供应链要闻，输出差异化标题；禁止重复使用同一批陈旧示例措辞。`
    );
  }

  const body = merged.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join('\n');
  return header + body;
}
