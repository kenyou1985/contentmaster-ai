# ContentMaster AI - 剪映草稿导出服务 (Render.com)

部署到 Render.com Free Tier，让 Vercel 上托管的前端能够使用剪映导出功能。

## 快速开始

### 方式一：Render.com 一键部署（推荐）

点击下方按钮自动部署到 Render.com：

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kenyou1985/contentmaster-ai&branch=main&rootDir=jianying-server)

> **提示**：首次部署时 Render 会要求你登录 GitHub 授权仓库权限。

### 方式二：手动部署

```bash
# 1. 克隆仓库
git clone https://github.com/kenyou1985/contentmaster-ai.git
cd contentmaster-ai/jianying-server

# 2. 安装依赖
npm install

# 3. 启动服务
npm start
# 服务运行在 http://localhost:10000
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | Render 存活探针 |
| `GET` | `/api/jianying/health` | Python 脚本健康检查 |
| `POST` | `/api/jianying/export` | 导出剪映草稿 |
| `GET` | `/api/jianying/list` | 列出所有草稿（macOS） |

### 导出接口示例

```bash
curl -X POST https://your-render-url.onrender.com/api/jianying/export \
  -H "Content-Type: application/json" \
  -d '{
    "draftName": "测试视频",
    "shots": [
      {
        "imageUrl": "https://example.com/image.jpg",
        "audioUrl": "https://example.com/audio.mp3",
        "caption": "这是一段测试字幕"
      }
    ],
    "resolution": "1920x1080",
    "fps": 30
  }'
```

## 前端配置

服务部署后，将前端 `vite.config.ts` 中的代理配置改为指向你的 Render 服务 URL：

```typescript
// vite.config.ts
proxy: {
  '/api/jianying': {
    // 开发环境：本地服务
    target: 'http://127.0.0.1:18091',
    // 生产环境（Vercel）：改为你的 Render 服务地址
    // target: 'https://jianying-export.onrender.com',
    changeOrigin: true,
    rewrite: (path) => path,
  },
},
```

## 重要说明

1. **跨域限制**：此服务已配置允许 Vercel 前端调用（生产环境）。
2. **媒体下载**：Python 脚本会从 URL 下载图片/音频，请确保服务器能够访问外部网络。
3. **草稿输出**：在 Render 环境中无本地剪映，草稿 JSON 会保存到服务容器的临时目录。
4. **免费版限制**：Render Free Tier 有 512MB 内存、0.5 CPU CPU 限制，适合轻量使用。

## 本地开发

```bash
# 启动剪映导出服务
cd jianying-server
npm install
npm start

# 启动前端（另一个终端）
cd ..
npm run dev
```

前端会自动代理 `/api/jianying/*` 到本地服务。
