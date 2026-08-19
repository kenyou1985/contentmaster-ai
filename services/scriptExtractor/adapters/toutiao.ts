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

    // 策略 1：尝试从 __INITIAL_STATE__ 解析
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

    // 策略 2：从 SSR HTML 抓 article-content
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