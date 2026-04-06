import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发环境：绕过外链图片 CORS（如 Cloudflare R2），供 RunningHub 上传前拉取图片字节
 * 生产静态部署无此中间件，需自行配置反向代理或 CDN CORS
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

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
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
      plugins: [react(), imageProxyDevPlugin()],
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
