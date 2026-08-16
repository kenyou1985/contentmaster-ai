# 旧的根目录 railway.toml / railway.json（已废弃，v1.10 移除）

> ⚠️ **这两个文件已于 2026-08-17 v1.10 删除**。历史内容保留在此仅供查阅。
>
> **删除原因**：根目录的 `railway.toml` / `railway.json` 会被 jianying-save 服务
> （设置 Root Directory = `jianying-server/` 但 Railway 仍读根目录配置）误读，
> 导致 jianying-save 自动 fallback 到 `Dockerfile.remotion` 构建 → 报
> `failed to calculate checksum of ref ... server/remotion-server/server.mjs`。
>
> **替代方案**：
> - jianying-save 用 `jianying-server/railway.json`（已存在）
> - Remotion 用 `railway.remotion.json`（根目录，带 `.remotion` 后缀不被自动检测）

---

## 原 railway.toml（根目录）内容

```toml
# ContentMaster AI · Remotion 渲染服务 Railway 部署配置
# 单独一个服务（不要和 MeTube / Vercel 前端混用一个 Service）
# 路径：Railway Dashboard → New Project → Deploy from GitHub Repo → 选此 repo
#      → Variables 配置下方环境变量即可

[build]
# Railway 会自动检测 Dockerfile.remotion
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile.remotion"

[deploy]
# 启动命令（Dockerfile 里已设 CMD，此处仅作 fallback）
startCommand = "node server.mjs"
# 健康检查命中 /health，失败 5 次才重启
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3

# 资源（按需要调整，Remotion 渲染吃内存）
# 1 vCPU / 4GB 起步，标准 1080p 30fps 视频大约 1.5GB 内存占用
# 推荐 2 vCPU / 8GB

# 环境变量（仅可由 Railway 看到的，服务端安全）
# VITE_REMITION_API_BASE 属于前端，需在 Vercel 端配置（不要带 VITE_ 前缀的服务端变量混用）
```

---

## 原 railway.json（根目录）内容

```json
{
  "$schema": "https://railway.app railway-schema.json",
  "environments": {
    "production": {
      "deployment": {
        "branch": "main",
        "rootDirectory": "."
      },
      "start": {
        "command": "sh -c 'cd /app/remotion && node ../server/server.mjs'"
      }
    }
  }
}
```

**注意**：`railway.json` 的 `start.command` 路径错位（`../server/server.mjs` 应为 `../server/remotion-server/server.mjs`），从未生效；删掉避免误导。