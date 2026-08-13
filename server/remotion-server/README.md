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
