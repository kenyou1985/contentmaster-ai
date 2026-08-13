#!/bin/bash
# ContentMaster AI - Remotion 渲染服务启动脚本（本地开发）
# 端口：18093

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$SCRIPT_DIR"

# 检查 node_modules
if [ ! -d "node_modules" ]; then
  echo "[setup] node_modules 不存在，开始安装依赖..."
  npm install --no-audit --no-fund --legacy-peer-deps
fi

# 检查端口占用
PORT=${PORT:-18093}
if lsof -i :"$PORT" -P -n 2>/dev/null | grep -q LISTEN; then
  echo "[error] 端口 $PORT 已被占用，请先停止占用该端口的进程"
  exit 1
fi

echo "[start] 启动 Remotion 渲染服务 (端口 $PORT)..."
echo "[start] 项目根目录: $PROJECT_ROOT"
echo "[start] Remotion 项目: $PROJECT_ROOT/remotion"

PORT="$PORT" REMOTION_OUTPUT_DIR="${REMOTION_OUTPUT_DIR:-/tmp/remotion-out}" \
  node server.mjs