import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * 浏览器直连 Invidious 会被 CORS 拦截；通过本站同源代理转发到上游 Invidious。
 * 上游地址在 Vercel 环境变量 INVIDIOUS_UPSTREAM_URL 配置（勿用 MeTube，二者 API 不兼容）。
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

  const upstream = (process.env.INVIDIOUS_UPSTREAM_URL || 'https://invidious.projectsegfau.lt').replace(
    /\/$/,
    ''
  );
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'path') continue;
    if (typeof v === 'string') params.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
  }
  const qs = params.toString();
  const sub = pathParam.replace(/^\/+/, '');
  const target = `${upstream}/api/v1/${sub}${qs ? `?${qs}` : ''}`;

  try {
    const r = await fetch(target, {
      method: req.method,
      headers: { 'User-Agent': 'ContentMaster-Invidious-Proxy/1.0' },
      redirect: 'follow',
    });
    const ct = r.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', ct);
    if (req.method === 'HEAD') {
      return res.status(r.status).end();
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(r.status).send(buf);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
