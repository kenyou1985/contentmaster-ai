import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildMetubeCookiesMultipart } from './_multipartCookies';

/**
 * 将浏览器导出的 Netscape cookies.txt 转发到 MeTube /upload-cookies。
 * 请求体 JSON：{ "cookiesText": "# Netscape..." }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const base = process.env.METUBE_URL?.trim().replace(/\/$/, '');
  if (!base) return res.status(503).json({ error: 'METUBE_URL not configured' });

  let body: Record<string, unknown> = req.body as Record<string, unknown>;
  if (typeof req.body === 'string') {
    try {
      body = JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }
  }
  const cookiesText = body?.cookiesText;
  if (!cookiesText || typeof cookiesText !== 'string' || !cookiesText.trim()) {
    return res.status(400).json({ error: 'missing cookiesText' });
  }
  if (cookiesText.length > 900_000) {
    return res.status(400).json({ error: 'cookiesText too large (max ~900KB)' });
  }

  const { body: multipartBody, contentType } = buildMetubeCookiesMultipart(cookiesText);

  try {
    const r = await fetch(`${base}/upload-cookies`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'User-Agent': 'ContentMaster-MeTube-Proxy/1.0',
      },
      body: multipartBody,
    });
    const text = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
