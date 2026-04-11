# YouTube 频道监控：Railway（MeTube）+ Vercel 配置说明

## 重要区分

| 服务 | 作用 | 与前端的关系 |
|------|------|----------------|
| **MeTube**（Railway） | 下载队列：`POST /add` | 通过 Vercel **`METUBE_URL`** + `/api/metube/add` 代理调用 |
| **YouTube Data API v3** | 元数据：搜索/频道/视频信息 | 通过 **`VITE_YOUTUBE_API_KEY`** 直连 Google |

**必须配置 YouTube Data API Key 才能使用频道监控功能**。无 Key 时无法获取视频元数据。

---

## 架构（当前实现）

```
浏览器
  ├─ 有 VITE_YOUTUBE_API_KEY → 直连 Google YouTube Data API v3
  └─ 无 Key → 无法获取元数据（需配置 Key）

下载队列
  └─ POST /api/metube/add → Vercel 转发到 METUBE_URL/add（Railway MeTube）
```

---

## 1. Railway：部署 MeTube

1. 使用模板部署：[MeTube on Railway](https://railway.app/deploy/metube-1)
2. 建议挂载 Volume 到 `/downloads`（持久化下载文件）
3. 记录公网根地址，例如：`https://alexta69metubelatest-production-8283.up.railway.app`
   （MeTube 默认监听容器内端口，Railway 会映射到 443，**无需**在前端写 8081）

---

## 2. Vercel：环境变量

在项目 **Environment Variables** 中配置（**不要**加 `VITE_` 前缀）：

```bash
# 必填（下载队列）：你的 Railway MeTube 根地址，无末尾斜杠
METUBE_URL=https://alexta69metubelatest-production-8283.up.railway.app
```

必填（频道监控元数据）：

```bash
# 必填（YouTube 元数据）：在 Google Cloud Console 申请 YouTube Data API v3 Key
VITE_YOUTUBE_API_KEY=你的_YouTube_Data_API_Key
```

部署后重新 **Redeploy**，Serverless 才能读到 `METUBE_URL`。

---

## 3. 本地开发

在项目根目录 `.env`（不要提交）中同样配置：

```bash
VITE_YOUTUBE_API_KEY=你的_YouTube_Data_API_Key
METUBE_URL=https://你的-metube.up.railway.app
```

---

## 4. MeTube HTTP API 参考

向本站代理发送：

`POST /api/metube/add`，`Content-Type: application/json`，body 示例：

```json
{
  "url": "https://www.youtube.com/watch?v=xxxxxxxxxxx",
  "quality": "best",
  "format": "any",
  "auto_start": true
}
```

Vercel 会转发到 `METUBE_URL/add`。

---

## 相关链接

- [MeTube](https://github.com/alexta69/metube)
- [YouTube Data API v3](https://developers.google.com/youtube/v3)
- [Google Cloud Console](https://console.cloud.google.com/)
