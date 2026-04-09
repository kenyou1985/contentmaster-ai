import type { VercelRequest, VercelResponse } from '@vercel/node';

const VALID_DOWNLOAD_TYPES = new Set(['video', 'audio', 'captions', 'thumbnail']);

/**
 * MeTube 的 POST /add 通常不带浏览器 CORS；通过本站代理转发到 Railway 上的 MeTube。
 * 请求体与 MeTube parse_download_options 对齐：download_type、quality、format、codec 等。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const base = process.env.METUBE_URL?.trim().replace(/\/$/, '');
  if (!base) {
    return res.status(503).json({ error: 'METUBE_URL is not configured on the server' });
  }

  let body: Record<string, unknown> = req.body as Record<string, unknown>;
  if (typeof req.body === 'string') {
    try {
      body = JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      return res.status(400).json({ error: 'invalid json body' });
    }
  }

  const url = body?.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'missing url string in body' });
  }

  let downloadType =
    typeof body.download_type === 'string' ? body.download_type.trim().toLowerCase() : 'video';
  if (!VALID_DOWNLOAD_TYPES.has(downloadType)) {
    downloadType = 'video';
  }

  const payload: Record<string, unknown> = {
    url: url.trim(),
    download_type: downloadType,
    auto_start: body.auto_start !== false,
    playlist_strict_mode: false,
  };

  const str = (k: string, fallback: string) =>
    typeof body[k] === 'string' ? (body[k] as string).trim() : fallback;

  if (downloadType === 'video') {
    payload.quality = str('quality', 'best');
    payload.format = str('format', 'any');
    payload.codec = str('codec', 'auto');
  } else if (downloadType === 'audio') {
    payload.quality = str('quality', 'best');
    payload.format = str('format', 'm4a');
    payload.codec = 'auto';
  } else if (downloadType === 'captions') {
    payload.quality = 'best';
    payload.format = str('format', 'srt');
    payload.codec = 'auto';
    if (typeof body.subtitle_language === 'string') payload.subtitle_language = body.subtitle_language;
    if (typeof body.subtitle_mode === 'string') payload.subtitle_mode = body.subtitle_mode;
  } else if (downloadType === 'thumbnail') {
    payload.quality = 'best';
    payload.format = str('format', 'jpg');
    payload.codec = 'auto';
  }

  const overridesRaw = process.env.METUBE_YTDL_OVERRIDES_JSON?.trim();
  if (overridesRaw) {
    try {
      const o = JSON.parse(overridesRaw) as Record<string, unknown>;
      if (o && typeof o === 'object') {
        payload.ytdl_options_overrides = o;
      }
    } catch {
      return res.status(500).json({ error: 'METUBE_YTDL_OVERRIDES_JSON is invalid JSON' });
    }
  }

  try {
    const r = await fetch(`${base}/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ContentMaster-MeTube-Proxy/1.0',
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    const ct = r.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', ct);
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
