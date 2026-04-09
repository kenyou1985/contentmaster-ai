# YouTube 频道监控：Railway（MeTube）+ Vercel 配置说明

## 重要区分

| 服务 | 作用 | 与前端的关系 |
|------|------|----------------|
| **MeTube**（Railway） | 下载队列：`POST /add` | 通过 Vercel **`METUBE_URL`** + 本站 **`/api/metube/add`** 代理调用 |
| **Invidious**（公共或自建） | 元数据：`/api/v1/search`、`/api/v1/videos/...` | 通过 Vercel **`INVIDIOUS_UPSTREAM_URL`** + 本站 **`/api/invidious`** 代理调用 |

**MeTube 不提供 Invidious 的 `/api/v1` 接口**，不能把 MeTube 域名当作 Invidious 上游，否则搜索/解析会失败。

---

## 架构（当前实现）

```
浏览器
  ├─ 有 VITE_YOUTUBE_API_KEY → 直连 Google YouTube Data API v3
  └─ 无 Key → GET 同源 /api/invidious?path=... → Vercel 转发到 INVIDIOUS_UPSTREAM_URL

下载队列
  └─ POST 同源 /api/metube/add → Vercel 转发到 METUBE_URL/add（Railway MeTube）
```

浏览器**不能**直连大多数公共 Invidious（CORS），因此无官方 Key 时必须依赖 **Vercel Serverless 代理**。

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

# 选填（无 YouTube Key 时的元数据上游；勿填 MeTube）
INVIDIOUS_UPSTREAM_URL=https://invidious.projectsegfau.lt
```

可选（全站默认官方 Key）：

```bash
VITE_YOUTUBE_API_KEY=你的_YouTube_Data_API_Key
```

部署后重新 **Redeploy**，Serverless 才能读到 `METUBE_URL` / `INVIDIOUS_UPSTREAM_URL`。

**请删除** 旧的错误变量（若曾设置）：

- `VITE_INVIDIOUS_BASE_URL` 指向 MeTube — 已废弃且逻辑错误。

---

## 3. 本地开发

在项目根目录 `.env`（不要提交）中同样配置：

```bash
INVIDIOUS_UPSTREAM_URL=https://invidious.projectsegfau.lt
METUBE_URL=https://你的-metube.up.railway.app
```

`npm run dev` 时，Vite 会提供与生产类似的 `/api/invidious` 与 `/api/metube/add` 代理。

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

## 5. 可选：自建 Invidious 在 Railway

若公共 Invidious 不稳定，可单独部署 Invidious，将 `INVIDIOUS_UPSTREAM_URL` 改为你的 Invidious 根地址（仍**不要**与 MeTube 混用）。

---

## 相关链接

- [MeTube](https://github.com/alexta69/metube)
- [Invidious](https://github.com/iv-org/invidious)
- [YouTube Data API v3](https://developers.google.com/youtube/v3)
