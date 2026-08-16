# Railway 部署说明（双服务）

> ⚠️ **历史遗留 bug 已修复（v1.10）**：根目录 `railway.toml` + `railway.json` 已删除
> 避免 jianying-save 服务在 push 时误拾 `Dockerfile.remotion` 触发 build 错乱。

---

## Railway 服务清单

| Service Name | Root Directory | Dockerfile Path | 配置文件 | Builder |
|---|---|---|---|---|
| **jianying-save** | `jianying-server/` | `./Dockerfile` | `jianying-server/railway.json` | NIXPACKS（自动检测 jianying-server/Dockerfile） |
| **contentmaster-remotion** | `.`（根） | `./Dockerfile.remotion` | `railway.remotion.json` | DOCKERFILE |

> **jianying-save 服务在 Railway Dashboard 必须显式设置**：
> - **Settings → Source → Root Directory** = `jianying-server`
> - **Settings → Build → Dockerfile Path** = `./Dockerfile`
> - 不需要 railway.json：jianying-server 子目录有自己的 `jianying-server/railway.json`

> **Remotion 服务必须显式设置**：
> - **Settings → Build → Dockerfile Path** = `./Dockerfile.remotion`
> - **Dockerfile 自动检测不靠谱**：根目录如果同时有 `Dockerfile` 和 `Dockerfile.remotion`，平台优先选 `Dockerfile`

---

## 为什么不保留根目录 `railway.toml` / `railway.json`

**2026-08-17 bug 复现**：

1. 用户 push `feat(copy-based)` commit 到 `origin/main`
2. jianying-save 服务自动触发部署 → Settings 显示 **Dockerfile Path = `./Dockerfile`**
3. 但根目录**没有** `Dockerfile` → Railway 自动 fallback 到根目录能找到的**任何 Dockerfile**
4. 找到根目录的 `Dockerfile.remotion` → 走 Remotion 构建流程
5. `Dockerfile.remotion:26` 的 `COPY server/remotion-server/server.mjs ./remotion-server/` → **build context 是 `./`（根目录）** → 该路径存在
6. 但 jianying-save 服务的 build context 在某些情况下被限定到 `jianying-server/` → 找不到 `server/remotion-server/server.mjs` → 报 `failed to calculate checksum`
7. **结果**：jianying-save 服务构建失败 / 错位

**修复方案**：
- 删除根目录的 `railway.toml` 和 `railway.json`（这两个文件**只服务 Remotion**，但放在根目录会被 jianying-save 误读）
- 改名后的 `railway.remotion.json` 留在根目录（专门给 Remotion 服务引用，文件名带 `.remotion` 后缀不会被自动检测）
- jianying-save 服务改用 `jianying-server/railway.json`（已存在，未改）
- Dockerfile 仍按服务名分开：`Dockerfile.remotion`（根）/ `Dockerfile`（jianying-server 子目录）

---

## 手动校验（避免再次错乱）

每次新增服务 / 重命名 Dockerfile 时，在本地跑：

```bash
# 列出所有 Dockerfile
find . -name 'Dockerfile*' -not -path '*/node_modules/*'

# 列出所有 Railway 配置文件
find . -name 'railway.*' -not -path '*/node_modules/*'
```

**期望输出**（v1.10+）：

```
./Dockerfile.remotion                              # Remotion 服务专用
./jianying-server/Dockerfile                       # jianying-save 服务专用
./jianying-server/railway.json                     # jianying-save 配置
./railway.remotion.json                            # Remotion 服务配置（备用）
```

**禁止**：
- ❌ 根目录新增 `Dockerfile`（会让两个服务冲突）
- ❌ 根目录保留 `railway.toml`（平台优先读，会被 jianying-save 误用）
- ❌ 根目录保留 `railway.json`（同上）

---

## Railway Dashboard 设置清单

### jianying-save 服务

| Setting | Value |
|---|---|
| Source → Root Directory | `jianying-server` |
| Build → Dockerfile Path | `./Dockerfile` |
| Build → Builder | NIXPACKS（自动） |
| Deploy → Start Command | 留空（Dockerfile CMD） |
| Deploy → Health Check Path | `/health` |
| Volume → Mount Path | `/data` |

### contentmaster-remotion 服务

| Setting | Value |
|---|---|
| Source → Root Directory | `.`（留空或留 `.`） |
| Build → Dockerfile Path | `./Dockerfile.remotion` |
| Build → Builder | DOCKERFILE |
| Deploy → Start Command | 留空（Dockerfile CMD） |
| Deploy → Health Check Path | `/health` |
| Variables | 见 `railway.remotion.json` |

---

## 故障排查

### 症状：jianying-save 报 `failed to calculate checksum of ref ...`

**原因**：jianying-save 服务 build 用了 `Dockerfile.remotion`，但找不到 `server/remotion-server/server.mjs`
**修复**：
1. Railway Dashboard → jianying-save → Settings → Build → **Dockerfile Path = `./jianying-server/Dockerfile`**
2. 确认根目录**没有** `railway.toml` / `railway.json`（git pull 验证）

### 症状：Remotion 服务报 `Cannot find module @remotion/renderer`

**原因**：Dockerfile.remotion 的 `npm install` 没装 `@remotion/renderer`
**修复**：
1. 确认 `Dockerfile.remotion:36-42` 的 dependencies 列表包含 `@remotion/renderer`
2. Railway Dashboard → Remotion → Deployments → Redeploy

### 症状：两个服务都构建成功，但 jianying-save 容器里跑的是 Remotion 代码

**原因**：Dockerfile Path 配置串了
**修复**：
1. jianying-save → Dockerfile Path = `./jianying-server/Dockerfile`
2. Remotion → Dockerfile Path = `./Dockerfile.remotion`
3. 两个服务的 Root Directory 必须独立设置