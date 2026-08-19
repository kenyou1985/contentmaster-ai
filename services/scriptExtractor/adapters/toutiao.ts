/**
 * v10.6 今日头条文案提取适配器
 *
 * 头条主要是图文（文章页），视频较少。
 *
 * 策略：
 *   1) 嗅探 URL 类型：
 *      - 移动端：m.toutiao.com/i{articleId}/ 或 m.365jilin.com 转发链接
 *      - PC 端：www.toutiao.com/w/{id}/ 或 www.toutiao.com/article/{id}/
 *   2) 通过现有 dev proxy `/api/toutiao-proxy?url=...` 抓 m.toutiao.com 页面 HTML
 *      （头条 PC 端有 a_bogus 签名，移动端相对开放，优先 m.）
 *   3) 从 SSR HTML 中解析：
 *      - 优先尝试 __INITIAL_STATE__ JSON 拿 articleInfo.content
 *      - 兜底从页面 <article> 或 article-content 区域抓 <p> 文本
 *
 * CORS：m.toutiao.com 浏览器 fetch 大概率触发 CORS，必须走后端 proxy
 */

import type {
  ExtractOptions,
  ExtractResult,
  IScriptExtractor,
} from '../types';
import { ExtractError } from '../types';

const PROXY_BASE_DEFAULT = '/api';

function sniffToutiaoUrl(input: string): { articleId: string; mobileUrl: string } | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  // 形式 1：m.toutiao.com/i{articleId}/
  let m = raw.match(/m\.toutiao\.com\/i(\d+)/);
  if (m) return { articleId: m[1], mobileUrl: raw };

  // 形式 2：www.toutiao.com/w{wwid}/
  m = raw.match(/(?:www\.)?toutiao\.com\/w(\d+)/);
  if (m) return { articleId: m[1], mobileUrl: `https://m.toutiao.com/i${m[1]}/` };

  // 形式 3：www.toutiao.com/article/{id}/
  m = raw.match(/(?:www\.)?toutiao\.com\/article\/(\d+)/);
  if (m) return { articleId: m[1], mobileUrl: `https://m.toutiao.com/i${m[1]}/` };

  // 形式 4：移动端短链 m.toutiao.com/s/{id}
  m = raw.match(/m\.toutiao\.com\/s\/([A-Za-z0-9_-]+)/);
  if (m) return { articleId: m[1], mobileUrl: raw };

  return null;
}

/** 从 SSR HTML 解析 __INITIAL_STATE__ JSON */
function parseInitialState(html: string): any {
  // 兼容多种前缀：window.__INITIAL_STATE__ = {...} / window._ROUTER_DATA = ...
  const patterns = [
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    /__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        try {
          // eslint-disable-next-line no-new-func
          return new Function('return ' + m[1])();
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

/** 在 INITIAL_STATE 中寻找 article content */
function findArticleContent(state: any): { title?: string; content?: string } | null {
  if (!state) return null;
  const tryKeys = ['articleInfo', 'article_info', 'data', 'content', 'detail'];
  const tryWalk = (obj: any, depth = 0): any => {
    if (!obj || depth > 10) return null;
    if (Array.isArray(obj)) {
      for (const it of obj) {
        const r = tryWalk(it, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof obj !== 'object') return null;
    // 命中：包含 title + content 字段
    if (typeof obj.title === 'string' && typeof obj.content === 'string') {
      return obj;
    }
    for (const k of tryKeys) {
      if (obj[k] !== undefined) {
        const r = tryWalk(obj[k], depth + 1);
        if (r) return r;
      }
    }
    for (const k of Object.keys(obj)) {
      if (k.startsWith('_')) continue;
      const r = tryWalk(obj[k], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return tryWalk(state);
}

/** 从 SSR HTML 抓 article-content 区域的所有 <p> 文本 */
function extractArticleFromHtml(html: string): { title?: string; content?: string } | null {
  // 兼容多种容器 class
  const containerPatterns = [
    /<div[^>]*class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    /<article[^>]*>([\s\S]*?)<\/article>/,
    /<div[^>]*class="[^"]*article_content[^"]*"[^>]*>([\s\S]*?)<\/div>/,
  ];
  for (const p of containerPatterns) {
    const m = html.match(p);
    if (!m) continue;
    const block = m[1];
    // 提取所有 <p>...</p>
    const pMatches = block.match(/<p[^>]*>([\s\S]*?)<\/p>/g);
    if (pMatches && pMatches.length > 0) {
      const paragraphs = pMatches
        .map((s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim())
        .filter((s) => s.length > 0);
      if (paragraphs.length > 0) {
        return { content: paragraphs.join('\n\n') };
      }
    }
    // 兜底：直接抓整块文本
    const plain = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length > 50) {
      return { content: plain };
    }
  }
  return null;
}

/** 从 HTML <title> 拿标题 */
function extractHtmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  if (!m) return '';
  return m[1].trim().replace(/[\s\-_]?(今日头条|头条)\s*$/i, '');
}

/**
 * 从 <meta name="description" content="..."> 拿摘要（og:description 同样可用）
 * 兜底用：头条 meta description 含文章前 100 字左右的摘要
 */
function extractMetaDescription(html: string): string | null {
  for (const pattern of [
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
    /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:description["']/i,
  ]) {
    const m = html.match(pattern);
    if (m && m[1] && m[1].length >= 20) return m[1];
  }
  return null;
}

/**
 * v10.6.2：从 URL-encoded 的 articleInfo JSON 提取（头条 m.toutiao.com 真实数据形式）
 *
 * 实测：HTML 中 articleInfo 是 URL-encoded JSON 字符串（含 `%7B` `%7D` `%22` 等）。
 * 关键陷阱：articleInfo 块本身是 URL-encoded，raw HTML 上没有 `{` / `}` 字符，
 *           不能直接 `'{'.balance walk`，必须**先解码再 walk**。
 *
 * 解决（两步解码策略）：
 *   1) 找到 `%22articleInfo%22` 的位置，把后面 200KB raw 截下来
 *   2) 逐字符 + 逐 `%xx` 三字符 token 解析：每解出 1 个字符 → 同步跟踪 depth
 *      - 这相当于手工跑一遍 decodeURIComponent
 *   3) 当 depth 从 1 回到 0 → 得到 articleInfo 完整范围
 *   4) 从 decoded 字符串中取出 JSON 对象 → JSON.parse → 提取 title + content
 */
function extractFromUrlEncodedArticleInfo(html: string): { title?: string; content?: string } | null {
  try {
    const tagStart = html.indexOf('%22articleInfo%22');
    if (tagStart < 0) {
      // 备选：HTML 原始状态（不被 URL-encoded 的版本）
      const pos = html.indexOf('"articleInfo":');
      if (pos < 0) return null;
      const braceStart = html.indexOf('{', pos);
      if (braceStart < 0) return null;
      const slice = html.slice(braceStart, braceStart + 200_000);
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = 0; i < slice.length; i++) {
        const c = slice[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end < 0) return null;
      return parseArticleInfo(JSON.parse(slice.slice(0, end)));
    }

    // URL-encoded 形式
    const slice = html.slice(tagStart, tagStart + 200_000);
    if (slice.length < 30) return null;

    // v10.6.3 关键修复：
    //   之前用 String.fromCharCode(byte) 把每个 %xx 字节当 Latin-1 单字符
    //   → 中文 UTF-8 是 3 字节序列（如 "朱" = E6 9C B1），被拆成 3 个 mojibake
    //   → 正确做法：decodeURIComponent 整段 URL-decode（UTF-8-aware）
    //   → 再对 decoded JSON 做 balance walk
    let decoded: string;
    try {
      decoded = decodeURIComponent(slice);
    } catch {
      // decode 失败（HTML 里其他位置的 % 干扰）
      // 退而求其次：只 decode "%22articleInfo%22" 开始到下一个未配对 %xx token
      const lastOk = slice.lastIndexOf('%22');
      if (lastOk < 0) return null;
      try {
        decoded = decodeURIComponent(slice.slice(0, lastOk + 3));
      } catch {
        return null;
      }
    }

    // decoded 是纯 JSON 字符串（含 "articleInfo":{...}）
    // balance walk
    let depth = 0;
    let inStr = false;
    let esc = false;
    let finalEnd = -1;
    for (let i = 0; i < decoded.length; i++) {
      const c = decoded[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') {
        depth++;
      } else if (c === '}') {
        if (depth > 0) depth--;
        if (depth === 0 && decoded.indexOf('{') >= 0) {
          finalEnd = i + 1;
          break;
        }
      }
    }
    if (finalEnd < 0) return null;

    const objStart = decoded.indexOf('{');
    if (objStart < 0) return null;
    const jsonText = decoded.slice(objStart, finalEnd);
    const article = JSON.parse(jsonText);
    return parseArticleInfo(article);
  } catch {
    return null;
  }
}

function parseArticleInfo(article: any): { title?: string; content?: string } | null {
  if (!article || typeof article !== 'object') return null;
  const title = (article.title || '').trim() || undefined;
  const rawContent = (article.content || '').trim();
  if (!rawContent) return title ? { title } : null;

  const paragraphs: string[] = [];
  const pMatches = rawContent.match(/<p[^>]*>([\s\S]*?)<\/p>/g);
  if (pMatches) {
    for (const p of pMatches) {
      const text = p
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
      if (text) paragraphs.push(text);
    }
  }
  if (paragraphs.length === 0) {
    const text = rawContent
      .replace(/<[^>]+>/g, '\n')
      .replace(/\n+/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .trim();
    if (text) paragraphs.push(text);
  }
  if (paragraphs.length === 0) {
    return title ? { title } : null;
  }
  return { title, content: paragraphs.join('\n\n') };
}

export const toutiaoExtractor: IScriptExtractor = {
  platform: 'toutiao',

  detectUrl(input: string): string | null {
    const sniff = sniffToutiaoUrl(input);
    return sniff ? sniff.articleId : null;
  },

  async extractScript(input: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
    const proxyBase = opts.proxyBase || PROXY_BASE_DEFAULT;
    const sniff = sniffToutiaoUrl(input);
    if (!sniff) {
      throw new ExtractError('UNSUPPORTED_URL', '不是有效的头条链接');
    }

    // 抓 m.toutiao.com 页面 HTML
    let html: string;
    try {
      const url = `${proxyBase}/toutiao-proxy?url=${encodeURIComponent(sniff.mobileUrl)}`;
      const r = await fetch(url, { method: 'GET' });
      if (!r.ok) {
        throw new ExtractError('FETCH_FAILED', `抓取头条页面失败 HTTP ${r.status}`);
      }
      html = await r.text();
    } catch (e: any) {
      if (e instanceof ExtractError) throw e;
      throw new ExtractError('FETCH_FAILED', `网络错误：${e?.message || String(e)}`);
    }

    if (!html || html.length < 100) {
      throw new ExtractError('FETCH_FAILED', '页面 HTML 异常（可能 IP/地区被限制）');
    }

    // 策略 1：从 URL-encoded 的 articleInfo JSON 提取（头条 m.toutiao.com 真实存在形式）
    const article1 = extractFromUrlEncodedArticleInfo(html);
    if (article1?.content) {
      return {
        platform: 'toutiao',
        text: article1.title ? `${article1.title}\n\n${article1.content}` : article1.content,
        title: article1.title,
        source: 'article',
      };
    }

    // 策略 2：尝试从 __INITIAL_STATE__ 解析
    const state = parseInitialState(html);
    if (state) {
      const article = findArticleContent(state);
      if (article?.content) {
        return {
          platform: 'toutiao',
          text: article.title ? `${article.title}\n\n${article.content}` : article.content,
          title: article.title,
          source: 'article',
        };
      }
    }

    // 策略 3：从 <meta name="description"> og:description 提取（兜底，至少拿到文章摘要）
    const metaDesc = extractMetaDescription(html);
    if (metaDesc && metaDesc.length >= 40) {
      const title = extractHtmlTitle(html);
      return {
        platform: 'toutiao',
        text: title ? `${title}\n\n${metaDesc}` : metaDesc,
        title: title || undefined,
        source: 'fallback',
        suspicious: metaDesc.length < 100,
      };
    }

    // 策略 4：从 SSR HTML 抓 article-content 区域的 <p>
    const fallback = extractArticleFromHtml(html);
    if (fallback?.content && fallback.content.length >= 30) {
      const title = extractHtmlTitle(html);
      return {
        platform: 'toutiao',
        text: title ? `${title}\n\n${fallback.content}` : fallback.content,
        title: title || undefined,
        source: 'article',
      };
    }

    throw new ExtractError('NO_CONTENT', '未找到文章正文（页面可能需要登录或文章已被删除）');
  },
};