# Remotion 视频合成导出

> ContentMaster AI · M1 骨架搭建完成 ✅

## 概述

在「成片」页面提供 **MP4 视频合成导出** 能力，与现有「导出剪映草稿」并列。

- **后端**: 自建 Node 服务 + `@remotion/renderer`
- **前端**: React + 复用现有 Shot 数据模型
- **支持**: 10 分钟以上长视频、可选 BGM/字幕样式、M4 阶段支持云存储上传

## 启动

### 1. 安装依赖（已完成）

```bash
# 根目录依赖（Remotion）
npm install

# 服务端依赖
cd server/remotion-server
npm install --legacy-peer-deps
```

### 2. 启动 Remotion 渲染服务

```bash
# 方式 1：脚本启动（推荐）
bash server/remotion-server/start.sh

# 方式 2：手动启动
cd server/remotion-server
node server.mjs
# 输出: [remotion-server] 监听端口 18093
```

### 3. 启动前端

```bash
# 另开终端
npm run dev
```

### 4. 测试

打开 ContentMaster AI → 进入「成片」页面 → 生成镜头 → 点击 **「导出视频」** 按钮。

## 端口分配

| 端口 | 服务 |
|---|---|
| 3000 | Vite 前端 |
| 18091 | 剪映导出服务（jianying-server） |
| **18093** | **Remotion 渲染服务（新增）** |

## 路由

`POST /api/remotion/render/start` — 提交渲染任务
`GET  /api/remotion/render/status/:id` — 轮询状态
`GET  /api/remotion/render/result/:id` — 获取结果
`GET  /api/remotion/render/sse/:id` — SSE 实时进度
`GET  /api/remotion/health` — 健康检查
`GET  /api/remotion/download/:id.mp4` — 下载渲染好的视频

## 文件结构

```
remotion/                                # Remotion 项目
├── src/
│   ├── index.tsx                       # registerRoot 入口
│   ├── Root.tsx                        # 备用根组件
│   ├── types.ts                        # 类型定义
│   └── compositions/
│       ├── MyVideo.tsx                 # 主合成（按 Shot 列表渲染）
│       ├── ShotLayer.tsx               # 单镜头（图片/视频 + Ken Burns）
│       └── Subtitle.tsx                # 字幕层（默认/描边/卡拉OK）
├── package.json
└── tsconfig.json

server/remotion-server/                  # Node 服务
├── server.mjs                          # Express HTTP API
├── render-worker.mjs                   # 调用 @remotion/renderer 渲染子进程
├── start.sh                            # 启动脚本
└── package.json

services/
├── remotionExportService.ts            # 前端调用层（与剪映同款）
└── remotionRenderTypes.ts              # 共享类型

components/
└── RemotionPreview.tsx                 # 浏览器内预览（@remotion/player）
```

## M1 已实现 ✅

- [x] Remotion 项目骨架（Root + MyVideo + ShotLayer + Subtitle）
- [x] Node 渲染服务（端口 18093）
- [x] 异步提交 + 轮询 + 健康检查
- [x] 进度推送（SSE 占位，待 M2 完整）
- [x] 前端按钮 + 高级设置面板（模板/分辨率/帧率/编码/BGM/字幕/输出位置）
- [x] 浏览器缓存 + IndexedDB
- [x] 直接下载
- [x] 验证：本地 720P / 24fps / 4 秒视频 → MP4（205KB）

## M2 计划

- [ ] 完善 SSE 实时进度
- [ ] 错误重试与超时处理
- [ ] 长视频分批（>30 分钟）
- [ ] 服务端日志面板

## M3 计划

- [ ] 背景音乐上传 + URL + 音量 + 淡入淡出
- [ ] 字幕样式：默认 / 描边 / 卡拉OK
- [ ] 浏览器内预览组件（RemotionPreview）

## M4 计划

- [ ] 阿里云 OSS 上传
- [ ] 腾讯云 COS 上传
- [ ] 浏览器缓存策略优化
- [ ] 序列号 / 命名 / 过期清理

## 已知限制

- 视频时长 > 5 分钟时，Chrome 内存占用 2-4GB
- 默认仅 `h264` 编码（`h265` 可选）
- 当前仅本地服务（18093）+ Railway 自建 Node，**未接入 Vercel Sandbox / Lambda**

---

## 🚀 Railway 部署（线上视频渲染）

> 适用场景：前端在 Vercel，Remotion 渲染服务在 Railway。两者通过 `VITE_REMITION_API_BASE` 串联。

### 1. Dockerfile 准备（仓库已就绪）

仓库根目录已包含：

- `Dockerfile.remotion` — 镜像构建（同时打包 `server/remotion-server` + `remotion`）
- `railway.toml` — Railway 部署元数据 + healthcheck
- `.dockerignore` — 减小构建上下文

### 2. Railway 服务创建

1. https://railway.app → New Project → **Deploy from GitHub Repo**
2. 选 `kenyou1985/contentmaster-ai`
3. Settings → **Build**：
   - Builder: `DOCKERFILE`
   - Dockerfile Path: `Dockerfile.remotion`
4. Settings → **Deploy** → Health Check Path: `/health`
5. Settings → **Resources**：
   - 至少 **2 vCPU / 4GB RAM**（推荐 **8GB**）
   - 如渲染 1080p+ 视频，建议升级到 16GB
6. 部署完成 → Railway 会给出 `https://<project>.up.railway.app`

### 3. 环境变量（Railway Dashboard → Variables）

| 变量 | 值 | 说明 |
|---|---|---|
| `PORT` | (自动注入) | Railway 自动注入 |
| `REMOTION_PROJECT_ROOT` | `/app/remotion` | Dockerfile 默认已设 |
| `REMOTION_OUTPUT_DIR` | `/tmp/remotion-out` | Dockerfile 默认已设 |
| `NODE_ENV` | `production` | 推荐 |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | `true` | Dockerfile 默认已设 |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Dockerfile 默认已设 |

### 4. 验证服务

```bash
curl https://<your-remotion>.up.railway.app/health
# 期望输出（含 chromium/ffmpeg 状态）：
# {
#   "status": "ok",
#   "platform": "railway",
#   "remotion": { "entryExists": true, ... },
#   "runtime": { "chromium": true, "ffmpeg": true, "cpus": 2, "freeMemMB": 6144 },
#   "env": { "RAILWAY_PUBLIC_DOMAIN": "<your-remotion>.up.railway.app" }
# }
```

### 5. 前端联调（Vercel 端）

在 Vercel 项目的 Environment Variables：

```
VITE_REMITION_API_BASE=https://<your-remotion>.up.railway.app
```

然后重新触发 Vercel 部署。

### 6. CORS 调试

`server.mjs` 已默认放行 `*.vercel.app` / `*.railway.app` 域名。前端打包后首次调用若 403，先检查 Vercel 域名是否在白名单列表（`CORS_ALLOWED` 数组）。

### 7. 📦 持久化考虑（重要）

Railway 容器重启后 **`/tmp/remotion-out` 视频会丢失**。生产建议：

- **方案 A**：把 `/tmp/remotion-out` 挂到 Railway Volume（但 Volume 只有单机实例）
- **方案 B（推荐）**：在 `server.mjs` 渲染完成后，把 MP4 自动上传到 S3 / R2 / OSS，前端从对象存储下载
- **方案 C**：加一个 `/api/remotion/upload/<taskId>` 端点，把结果推送到外部存储

### 8. ⚠️ 已知问题

- **冷启动慢**：第一次部署后第一次渲染需要 30-60s（Chromium 启动 + npm 包预热）
- **大视频超时**：默认无超时，10 分钟以上视频请手动调高 Railway Idle Timeout
- **内存分配**：4GB 是底线，1080p 60fps 建议 8GB+

### 9. 完整部署步骤（极简）

```bash
# 1. 推代码
git add . && git commit -m "feat: remotion 服务 Railway 部署" && git push

# 2. Railway 控制台
#    - New Project → Deploy from GitHub Repo
#    - 选仓库 → Dockerfile 路径填 Dockerfile.remotion
#    - 设置 /health healthcheck
#    - 升级到 2 vCPU / 4GB

# 3. Vercel 端
#    - VITE_REMITION_API_BASE = Railway 域名
#    - 重新部署

# 4. 验证
#    - 浏览器打开 Vercel 站点 → 「成片」→ 渲染
#    - 进度条从 0 → 100%，最终下载视频
```
