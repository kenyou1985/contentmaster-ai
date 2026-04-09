import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildMetubeCookiesMultipart } from './api/metube/_multipartCookies';

// ─── Invidious 代理内部函数（与 api/invidious.ts 保持同步）────────────────────

const INVIDIOUS_FETCH_HEADERS_DEV: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};
const FETCH_TIMEOUT_MS = 2200;
const MAX_UPSTREAMS = 4;

function listInvidiousUpstreamBases(env: Record<string, string>): string[] {
  const urlsEnv = (env.INVIDIOUS_UPSTREAM_URLS || '').trim();
  if (urlsEnv) {
    return urlsEnv.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean).slice(0, MAX_UPSTREAMS);
  }
  const primary = (env.INVIDIOUS_UPSTREAM_URL || 'https://invidious.projectsegfau.lt').replace(/\/$/, '');
  const extra = (env.INVIDIOUS_UPSTREAM_FALLBACKS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return [...new Set([primary, ...extra])].slice(0, MAX_UPSTREAMS);
}

function looksLikeJsonBody(ct: string, prefix: string): boolean {
  if (ct.toLowerCase().includes('json')) return true;
  const p = prefix.trimStart();
  return p.startsWith('{') || p.startsWith('[');
}

function shouldTryNext(status: number, ct: string, prefix: string, hasMore: boolean): boolean {
  if (!hasMore) return false;
  if (status >= 500) return true;
  if ([401, 403, 404, 429, 502, 503, 504].includes(status)) return true;
  if (status >= 200 && status < 300 && !looksLikeJsonBody(ct, prefix)) return true;
  return false;
}

/**
 * 开发环境：绕过外链图片 CORS（如 Cloudflare R2），供 RunningHub 上传前拉取图片字节
 * 生产静态部署无此中间件，需自行配置反向代理或 CDN CORS
 */
/** 开发环境：同源代理 Invidious / MeTube（与生产 Vercel api/* 行为一致） */
function invidiousProxyDevPlugin(opts: {
  invidiousEnv: Record<string, string>;
  metubeUrl: string;
  metubeYtdlOverridesJson?: string;
}): Plugin {
  const { invidiousEnv, metubeUrl, metubeYtdlOverridesJson } = opts;
  return {
    name: 'contentmaster-invidious-proxy',
    configureServer(server) {
      server.middlewares.use('/api/invidious', async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        try {
          const rawUrl = req.url || '';
          const parsed = new URL(rawUrl, 'http://localhost');
          const pathParam = parsed.searchParams.get('path');
          if (!pathParam || pathParam.includes('..')) {
            res.statusCode = 400;
            res.end('invalid path');
            return;
          }
          const candidates = listInvidiousUpstreamBases(invidiousEnv);
          const params = new URLSearchParams(parsed.search);
          params.delete('path');
          const qs = params.toString();
          const sub = pathParam.replace(/^\/+/, '');
          let lastStatus = 502;
          let lastBuf = Buffer.alloc(0);
          let lastCt = 'application/json';

          for (let i = 0; i < candidates.length; i++) {
            const upstream = candidates[i];
            const target = `${upstream}/api/v1/${sub}${qs ? `?${qs}` : ''}`;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
            let r: Response;
            try {
              r = await fetch(target, {
                method: req.method,
                signal: ctrl.signal,
                headers: INVIDIOUS_FETCH_HEADERS_DEV,
                redirect: 'follow',
              });
            } catch {
              clearTimeout(timer);
              if (i < candidates.length - 1) continue;
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Invidious fetch failed' }));
              return;
            }
            clearTimeout(timer);
            const buf = Buffer.from(await r.arrayBuffer());
            const ct = r.headers.get('content-type') || '';
            const prefix = buf.slice(0, 256).toString('utf8');
            const hasMore = i < candidates.length - 1;
            if (shouldTryNext(r.status, ct, prefix, hasMore)) {
              lastStatus = r.status;
              lastBuf = buf;
              lastCt = ct;
              continue;
            }
            res.setHeader('Content-Type', ct || 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (req.method === 'HEAD') {
              res.statusCode = r.status;
              res.end();
              return;
            }
            res.statusCode = r.status;
            res.end(buf);
            return;
          }
          res.statusCode = lastStatus;
          res.setHeader('Content-Type', lastCt);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(lastBuf);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: msg }));
        }
      });

      server.middlewares.use('/api/metube/add', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        const metube = metubeUrl.trim().replace(/\/$/, '');
        if (!metube) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Set METUBE_URL in .env for local MeTube proxy' }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: Record<string, unknown>;
            try {
              body = JSON.parse(raw || '{}') as Record<string, unknown>;
            } catch {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'invalid json' }));
              return;
            }
            if (!body.url || typeof body.url !== 'string') {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'missing url' }));
              return;
            }
            const downloadType = body.download_type;
            const payload: Record<string, unknown> =
              downloadType === 'audio'
                ? {
                    url: body.url,
                    download_type: 'audio',
                    format: typeof body.format === 'string' ? body.format : 'm4a',
                    quality: typeof body.quality === 'string' ? body.quality : 'best',
                    auto_start: body.auto_start !== false,
                  }
                : {
                    url: body.url,
                    quality: typeof body.quality === 'string' ? body.quality : 'best',
                    format: typeof body.format === 'string' ? body.format : 'any',
                    auto_start: body.auto_start !== false,
                    playlist_strict_mode: false,
                  };
            const overridesRaw = metubeYtdlOverridesJson?.trim();
            if (overridesRaw) {
              try {
                const o = JSON.parse(overridesRaw) as Record<string, unknown>;
                if (o && typeof o === 'object') payload.ytdl_options_overrides = o;
              } catch {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'METUBE_YTDL_OVERRIDES_JSON is invalid JSON' }));
                return;
              }
            }
            const r = await fetch(`${metube}/add`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'ContentMaster-MeTube-Proxy/1.0',
              },
              body: JSON.stringify(payload),
            });
            const text = await r.text();
            res.statusCode = r.status;
            res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
            res.end(text);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: msg }));
          }
        });
        req.on('error', () => {
          res.statusCode = 400;
          res.end();
        });
      });

      server.middlewares.use('/api/metube/upload-cookies', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        const metube = metubeUrl.trim().replace(/\/$/, '');
        if (!metube) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Set METUBE_URL in .env for local MeTube proxy' }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: Record<string, unknown>;
            try {
              body = JSON.parse(raw || '{}') as Record<string, unknown>;
            } catch {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'invalid json' }));
              return;
            }
            const cookiesText = body.cookiesText;
            if (!cookiesText || typeof cookiesText !== 'string' || !cookiesText.trim()) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'missing cookiesText' }));
              return;
            }
            const { body: multipartBody, contentType } = buildMetubeCookiesMultipart(cookiesText);
            const r = await fetch(`${metube}/upload-cookies`, {
              method: 'POST',
              headers: {
                'Content-Type': contentType,
                'User-Agent': 'ContentMaster-MeTube-Proxy/1.0',
              },
              body: multipartBody,
            });
            const text = await r.text();
            res.statusCode = r.status;
            res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
            res.end(text);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: msg }));
          }
        });
      });

      server.middlewares.use('/api/metube/cookie-status', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        const metube = metubeUrl.trim().replace(/\/$/, '');
        if (!metube) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Set METUBE_URL in .env for local MeTube proxy' }));
          return;
        }
        try {
          const r = await fetch(`${metube}/cookie-status`);
          const text = await r.text();
          res.statusCode = r.status;
          res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
          res.end(text);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: msg }));
        }
      });
    },
  };
}

function imageProxyDevPlugin(): Plugin {
  return {
    name: 'contentmaster-image-proxy',
    configureServer(server) {
      server.middlewares.use('/__image_proxy', async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        try {
          const rawUrl = req.url || '';
          const q = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
          const target = new URLSearchParams(q).get('url');
          if (!target) {
            res.statusCode = 400;
            res.end('missing url param');
            return;
          }
          let parsed: URL;
          try {
            parsed = new URL(target);
          } catch {
            res.statusCode = 400;
            res.end('invalid url');
            return;
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            res.statusCode = 400;
            res.end('only http(s) allowed');
            return;
          }
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 90_000);
          const r = await fetch(parsed.toString(), {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'ContentMaster-AI-ImageProxy/1.0' },
          });
          clearTimeout(timer);
          if (!r.ok) {
            res.statusCode = r.status;
            const text = await r.text().catch(() => '');
            res.end(text.slice(0, 4096));
            return;
          }
          const ct = r.headers.get('content-type') || 'application/octet-stream';
          res.setHeader('Content-Type', ct);
          res.setHeader('Access-Control-Allow-Origin', '*');
          const buf = Buffer.from(await r.arrayBuffer());
          res.end(buf);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          res.statusCode = 502;
          res.end(`image proxy: ${msg}`);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const metubeUrl = env.METUBE_URL || '';
    const metubeYtdlOverridesJson = env.METUBE_YTDL_OVERRIDES_JSON || '';
    return {
      server: {
        port: 3000,
        host: '127.0.0.1',
        strictPort: false, // 允许端口不可用时自动切换，避免权限错误阻塞启动
        proxy: {
          '/api/jianying': {
            target: 'http://127.0.0.1:18091',
            changeOrigin: true,
            rewrite: (path) => path,
          },
        },
      },
      plugins: [
        react(),
        imageProxyDevPlugin(),
        invidiousProxyDevPlugin({ invidiousEnv: env, metubeUrl, metubeYtdlOverridesJson }),
      ],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
