import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发环境：绕过外链图片 CORS（如 Cloudflare R2），供 RunningHub 上传前拉取图片字节
 * 生产静态部署无此中间件，需自行配置反向代理或 CDN CORS
 */
/** 开发环境：同源代理 Invidious / MeTube（与生产 Vercel api/* 行为一致） */
function invidiousProxyDevPlugin(opts: { invidiousUpstream: string; metubeUrl: string }): Plugin {
  const { invidiousUpstream, metubeUrl } = opts;
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
          const upstream = invidiousUpstream.replace(/\/$/, '');
          const params = new URLSearchParams(parsed.search);
          params.delete('path');
          const qs = params.toString();
          const target = `${upstream}/api/v1/${pathParam.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60_000);
          const r = await fetch(target, {
            method: req.method,
            signal: ctrl.signal,
            headers: { 'User-Agent': 'ContentMaster-Invidious-Proxy/1.0' },
            redirect: 'follow',
          });
          clearTimeout(timer);
          const ct = r.headers.get('content-type') || 'application/json';
          res.setHeader('Content-Type', ct);
          res.setHeader('Access-Control-Allow-Origin', '*');
          if (req.method === 'HEAD') {
            res.statusCode = r.status;
            res.end();
            return;
          }
          const buf = Buffer.from(await r.arrayBuffer());
          res.statusCode = r.status;
          res.end(buf);
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
            const payload = {
              url: body.url,
              quality: typeof body.quality === 'string' ? body.quality : 'best',
              format: typeof body.format === 'string' ? body.format : 'any',
              auto_start: body.auto_start !== false,
              playlist_strict_mode: false,
            };
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
    const invidiousUpstream =
      env.INVIDIOUS_UPSTREAM_URL || 'https://invidious.projectsegfau.lt';
    const metubeUrl = env.METUBE_URL || '';
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
        invidiousProxyDevPlugin({ invidiousUpstream, metubeUrl }),
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
