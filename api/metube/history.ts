import type { VercelRequest, VercelResponse } from '@vercel/node';

/** 轮询 MeTube 下载历史，用于前端确认下载状态。 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const base = process.env.METUBE_URL?.trim().replace(/\/$/, '');
  if (!base) return res.status(503).json({ error: 'METUBE_URL not configured' });

  try {
    const r = await fetch(`${base}/history`);
    const text = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
