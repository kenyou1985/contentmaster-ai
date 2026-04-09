# YouTube 频道监控 - Railway 部署指南

本指南说明如何在 Railway 上部署 YouTube 监控后端服务（MeTube）。

## 方案说明

### 架构
```
┌─────────────────┐     ┌──────────────────┐
│  Vercel 前端    │────▶│  Railway 后端    │
│  (用户浏览器)   │     │  (MeTube/Invidious)│
└─────────────────┘     └──────────────────┘
        │                        │
        │                        │
   YouTube Data              YouTube
   API v3 (官方)            (无Key)
```

### API 优先级
1. **优先使用官方 API**（`VITE_YOUTUBE_API_KEY`）
2. **无官方 Key 时使用 Railway 后端**（Invidious/MeTube）

---

## 部署步骤

### 1. 部署 MeTube 到 Railway

MeTube 是开箱即用的 YouTube 下载/监控服务，支持 Invidious API。

**一键部署：**

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/deploy/metube-1)

**或者手动部署：**

1. 访问 [railway.app](https://railway.app)
2. 创建新项目，选择 "Deploy from GitHub repo"
3. 填入仓库: `alexta69/metube`
4. Railway 会自动检测 Dockerfile 并部署

### 2. 配置持久化存储

MeTube 需要持久化存储来保存下载的视频：

1. 在 Railway 项目中，点击部署的服务
2. 进入 "Storage" 标签
3. 添加 Volume，挂载路径: `/downloads`
4. 重新部署

### 3. 获取 API 地址

部署完成后，Railway 会提供公共域名：

```
https://metube-xxxxx.up.railway.app
```

### 4. 更新 Vercel 环境变量

在 Vercel 项目设置中添加：

```bash
VITE_INVIDIOUS_BASE_URL=https://metube-xxxxx.up.railway.app
```

### 5. 更新前端代码（可选）

如果使用 Railway 后端而非公共 Invidious 实例，修改 `YouTubeMonitor.tsx` 中的 `INVIDIOUS_INSTANCES` 数组：

```typescript
const INVIDIOUS_INSTANCES = [
  'https://metube-xxxxx.up.railway.app',  // 你的 Railway 地址
];
```

---

## Railway 免费额度

| 资源 | 免费额度 |
|------|----------|
| 每月运行时间 | 500 小时 |
| 磁盘存储 | 1 GB |
| 带宽 | 100 GB/月 |

**注意**：免费账户每月 500 小时，约合 20 天不停运行。超出后服务会休眠，但重新唤醒后配置和数据会保留。

---

## MeTube 主要 API 端点

部署后可通过以下端点访问：

### Invidious API

```
# 搜索
GET /api/v1/search?q=关键词&type=channel

# 频道视频
GET /api/v1/channels/{channelId}/videos

# 视频详情
GET /api/v1/videos/{videoId}
```

### MeTube Web UI

```
# Web 界面
GET /

# 下载视频
POST /download
```

---

## 常见问题

### Q: Railway 部署后服务休眠了？
A: 免费账户在闲置后会休眠。访问 URL 会自动唤醒，通常 10-30 秒恢复。

### Q: 如何提高服务可用性？
A: 可以使用 UptimeRobot 等免费监控服务定期 ping 你的 Railway URL，防止休眠。

### Q: 支持哪些视频网站？
A: MeTube 基于 yt-dlp，支持 1000+ 网站，包括 YouTube、Bilibili、TikTok 等。

### Q: 如何更新 MeTube 版本？
A: 在 Railway 中触发重新部署，会自动拉取最新版本。

---

## 替代方案：使用公共 Invidious 实例

如果不想自建 Railway 服务，可以使用公共 Invidious 实例（无需部署）：

```typescript
const INVIDIOUS_INSTANCES = [
  'https://invidious.privacyredirect.com',
  'https://yewtu.be',
  'https://invidious.projectsegfau.lt',
];
```

**注意**：公共实例可能不稳定，建议自建 Railway 服务。

---

## 相关链接

- [MeTube GitHub](https://github.com/alexta69/metube)
- [Railway 官网](https://railway.app)
- [Invidious 官方实例列表](https://docs.invidious.io/instances/)
- [yt-dlp 支持网站列表](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
