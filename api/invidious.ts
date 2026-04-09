import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  INVIDIOUS_FETCH_HEADERS,
  listInvidiousUpstreamBases,
  shouldTryNextInvidiousUpstream,
} from './_invidiousUpstream';

/**
 * 浏览器直连 Invidious 会被 CORS 拦截；通过本站同源代理转发到上游 Invidious。
 * 上游：INVIDIOUS_UPSTREAM_URL（主）+ 可选 INVIDIOUS_UPSTREAM_FALLBACKS（逗号分隔），
 * 或单独使用 INVIDIOUS_UPSTREAM_URLS（逗号分隔完整列表）。勿填 MeTube 域名。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  for (let i = 0; i < candidates.length; i++) {
    const upstream = candidates[i];
    const target = `${upstream}/api/v1/${sub}${qs ? `?${qs}` : ''}`;
    try {
      const r = await fetch(target, {
        method: req.method,
        headers: INVIDIOUS_FETCH_HEADERS,
        redirect: 'follow',
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || '';
      const prefix = buf.slice(0, 256).toString('utf8');
      const hasMore = i < candidates.length - 1;

      if (
        shouldTryNextInvidiousUpstream(r.status, ct, prefix, hasMore)
      ) {
        continue;
      }

      res.setHeader('Content-Type', ct || 'application/octet-stream');
      if (req.method === 'HEAD') {
        return res.status(r.status).end();
      }
      return res.status(r.status).send(buf);
    } catch {
      if (i < candidates.length - 1) continue;
      return res.status(502).json({ error: 'Invidious fetch failed for all upstreams' });
    }
  }

  return res.status(502).json({
    error: 'Invidious upstream unavailable',
    detail: 'All configured Invidious instances failed or returned non-JSON. Set INVIDIOUS_UPSTREAM_FALLBACKS or use YouTube Data API key.',
  });
}
