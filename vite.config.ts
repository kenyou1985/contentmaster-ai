import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import compression from 'vite-plugin-compression';
import { buildMetubeCookiesMultipart } from './api/metube/_multipartCookies';

/**
 * 开发环境：绕过外链图片 CORS（如 Cloudflare R2），供 RunningHub 上传前拉取图片字节
 * 生产静态部署无此中间件，需自行配置反向代理或 CDN CORS，或设置 IMAGE_PROXY_URL 使用外部代理服务
 */
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

function metubeProxyDevPlugin(opts: {
  metubeUrl: string;
  metubeYtdlOverridesJson?: string;
}): Plugin {
  const { metubeUrl, metubeYtdlOverridesJson } = opts;

  return {
    name: 'contentmaster-metube-proxy',
    configureServer(server) {
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
            const dt = String(body.download_type || 'video');
            const urlStr = body.url as string;
            let payload: Record<string, unknown>;

            if (dt === 'audio') {
              payload = {
                url: urlStr,
                download_type: 'audio',
                format: typeof body.format === 'string' ? body.format : 'm4a',
                quality: typeof body.quality === 'string' ? body.quality : 'best',
                auto_start: body.auto_start !== false,
              };
            } else if (dt === 'video') {
              const allowedFmt = ['any', 'ios', 'mp4'] as const;
              const fmt =
                typeof body.format === 'string' && (allowedFmt as readonly string[]).includes(body.format)
                  ? body.format
                  : 'any';
              payload = {
                url: urlStr,
                download_type: 'video',
                quality: typeof body.quality === 'string' ? body.quality : 'best',
                format: fmt,
                auto_start: body.auto_start !== false,
                playlist_strict_mode: false,
              };
            } else {
              payload = {
                url: urlStr,
                download_type: dt,
                auto_start: body.auto_start !== false,
              };
              if (typeof body.format === 'string') payload.format = body.format;
              if (typeof body.quality === 'string') payload.quality = body.quality;
              if (typeof body.codec === 'string') payload.codec = body.codec;
              if (typeof body.subtitle_mode === 'string') payload.subtitle_mode = body.subtitle_mode;
              if (typeof body.subtitle_language === 'string') payload.subtitle_language = body.subtitle_language;
              if (body.playlist_strict_mode === true) payload.playlist_strict_mode = true;
            }
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

      server.middlewares.use('/api/metube/history', async (req, res) => {
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
          const r = await fetch(`${metube}/history`);
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

/**
 * v10.6 链接提取文案 proxy 插件：
 *   - /api/douyin-proxy?url=<iesdouyin share URL>  → 抓页面 HTML（解决 CORS）
 *   - /api/toutiao-proxy?url=<m.toutiao URL>      → 抓页面 HTML（解决 CORS）
 *   - /api/video-proxy?url=<aweme.snssdk.com URL> → 转发二进制视频/音频（解决防盗链）
 * 与 metube proxy 不同：proxyUrl 在 URL 查询参数里，target 在函数外配置。
 */
function scriptExtractorProxyDevPlugin(opts: {
  jianyingApiBase: string;
}): Plugin {
  const { jianyingApiBase } = opts;

  return {
    name: 'contentmaster-script-extractor-proxy',
    configureServer(server) {
      // 统一 CORS helper
      const setCors = (res: import('http').ServerResponse) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      };

      // 通用 GET 转发器：?url=<absolute URL>
      const makeForwarder = (kindLabel: string, upstream?: string) =>
        async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
          setCors(res);
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          const url = new URL(req.url || '/', 'http://localhost');
          const target = url.searchParams.get('url');
          if (!target) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'missing ?url parameter' }));
            return;
          }
          try {
            const r = await fetch(target, {
              redirect: 'follow',
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
                  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              },
            });
            const buf = Buffer.from(await r.arrayBuffer());
            const ct = r.headers.get('content-type') || 'application/octet-stream';
            res.statusCode = r.status;
            res.setHeader('Content-Type', ct);
            res.end(buf);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[script-extractor-proxy] ${kindLabel} fetch failed:`, msg);
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: msg }));
          }
        };

      // 本地 dev：直接转发（HTML 端 CORS 通常 OK）
      server.middlewares.use('/api/douyin-proxy', makeForwarder('douyin'));
      server.middlewares.use('/api/toutiao-proxy', makeForwarder('toutiao'));
      server.middlewares.use('/api/video-proxy', makeForwarder('video'));

      // 在控制台打印 jianyingApiBase，方便调试（仅 dev）
      if (jianyingApiBase) {
        console.log(`[script-extractor-proxy] jianyingApiBase = ${jianyingApiBase}`);
      }
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
        strictPort: false,
        proxy: {
          '/api/jianying': {
            target: 'http://127.0.0.1:18091',
            changeOrigin: true,
            rewrite: (path) => path,
          },
          '/api/image-cache': {
            target: 'http://127.0.0.1:18092',
            changeOrigin: true,
            rewrite: (path) => path,
          },
          '/api/remotion': {
            target: 'http://127.0.0.1:18093',
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api\/remotion/, ''),
          },
        },
      },
      optimizeDeps: {
        exclude: [
          '@ffmpeg/ffmpeg',
          '@ffmpeg/util',
          '@ffmpeg/core',
        ],
      },
      worker: {
        format: 'es',
      },
      plugins: [
        react(),
        compression({ algorithm: 'gzip', threshold: 1024 }),
        compression({ algorithm: 'brotliCompress', threshold: 1024 }),
        imageProxyDevPlugin(),
        metubeProxyDevPlugin({
          metubeUrl,
          metubeYtdlOverridesJson,
        }),
        scriptExtractorProxyDevPlugin({
          jianyingApiBase: env.VITE_JIANYING_API_BASE || '',
        }),
      ],
      build: {
        rollupOptions: {
          output: {
manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-lucide': ['lucide-react'],
          'vendor-utils': ['jszip'],
          'vendor-opencc': ['opencc-js'],
        },
          },
        },
        chunkSizeWarningLimit: 600,
      },
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.IMAGE_PROXY_URL': JSON.stringify(env.VITE_IMAGE_PROXY_URL || ''),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
