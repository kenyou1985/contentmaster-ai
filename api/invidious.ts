import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * 浏览器直连 Invidious 会被 CORS 拦截；通过本站同源代理转发到上游 Invidious。
 * 上游：INVIDIOUS_UPSTREAM_URL（主）+ 可选 INVIDIOUS_UPSTREAM_FALLBACKS（逗号分隔），
 * 或单独使用 INVIDIOUS_UPSTREAM_URLS（逗号分隔完整列表）。勿填 MeTube 域名。
 */

// ─── 内联共享常量（避免 Vercel 边车构建遗漏辅助模块）─────────────────────────

const INVIDIOUS_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** 单次上游请求超时（毫秒）。Hobby 函数约 10s 上限，串行多实例时总时长须低于该限制 */
const FETCH_TIMEOUT_MS = 2200;

/** 最多尝试的上游数量（主站 + 备用），避免总等待超过 Serverless 时限 */
const MAX_UPSTREAMS = 4;

type EnvLike = Record<string, string | undefined>;

function listInvidiousUpstreamBases(env: EnvLike): string[] {
  const urlsEnv = env.INVIDIOUS_UPSTREAM_URLS?.trim();
  if (urlsEnv) {
    return urlsEnv
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean)
      .slice(0, MAX_UPSTREAMS);
  }
  const primary = (env.INVIDIOUS_UPSTREAM_URL || 'https://invidious.projectsegfau.lt').replace(/\/$/, '');
  const extra =
    env.INVIDIOUS_UPSTREAM_FALLBACKS?.split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean) ?? [];
  const merged = [...new Set([primary, ...extra])];
  return merged.slice(0, MAX_UPSTREAMS);
}

function looksLikeJsonBody(contentType: string, bodyUtf8Prefix: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('application/json') || ct.includes('json')) return true;
  const p = bodyUtf8Prefix.trimStart();
  return p.startsWith('{') || p.startsWith('[');
}

function shouldTryNextInvidiousUpstream(
  status: number,
  contentType: string,
  bodyUtf8Prefix: string,
  hasMore: boolean
): boolean {
  if (!hasMore) return false;
  if (status >= 500) return true;
  if ([401, 403, 404, 429, 502, 503, 504].includes(status)) return true;
  if (status >= 200 && status < 300 && !looksLikeJsonBody(contentType, bodyUtf8Prefix)) return true;
  return false;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const pathParam = typeof req.query.path === 'string' ? req.query.path : '';
    if (!pathParam || pathParam.includes('..')) {
      return res.status(400).json({ error: 'invalid or missing path' });
    }

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k === 'path') continue;
      if (typeof v === 'string') params.set(k, v);
      else if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
    }
    const qs = params.toString();
    const sub = pathParam.replace(/^\/+/, '');

    const candidates = listInvidiousUpstreamBases(process.env);
    if (candidates.length === 0) {
      return res.status(503).json({ error: 'No Invidious upstream configured' });
    }

    for (let i = 0; i < candidates.length; i++) {
      const upstream = candidates[i];
      const target = `${upstream}/api/v1/${sub}${qs ? `?${qs}` : ''}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let r: Response;
      try {
        r = await fetch(target, {
          method: req.method,
          headers: INVIDIOUS_FETCH_HEADERS,
          redirect: 'follow',
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const aborted = e instanceof Error && e.name === 'AbortError';
        const hasMore = i < candidates.length - 1;
        if (hasMore && (aborted || e instanceof TypeError)) {
          continue;
        }
        return res.status(502).json({
          error: aborted ? 'Invidious upstream timeout' : e instanceof Error ? e.message : String(e),
        });
      }
      clearTimeout(timer);

      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || '';
      const prefix = buf.slice(0, 256).toString('utf8');
      const hasMore = i < candidates.length - 1;

      if (shouldTryNextInvidiousUpstream(r.status, ct, prefix, hasMore)) {
        continue;
      }

      res.setHeader('Content-Type', ct || 'application/octet-stream');
      if (req.method === 'HEAD') {
        return res.status(r.status).end();
      }
      return res.status(r.status).send(buf);
    }

    return res.status(502).json({
      error: 'Invidious upstream unavailable',
      detail:
        'All configured instances failed or timed out. Shorten INVIDIOUS_UPSTREAM_FALLBACKS or use YouTube Data API key.',
    });
  } catch (e) {
    console.error('[api/invidious]', e);
    return res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
