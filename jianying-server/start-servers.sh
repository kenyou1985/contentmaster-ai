#!/bin/bash
# ContentMaster AI - 启动所有本地服务
# 使用方式: ./start-servers.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo " ContentMaster AI - 本地服务启动器"
echo "============================================"

# 启动 jianying-server (端口 18091)
echo ""
echo "[1/2] 启动剪映导出服务 (端口 18091)..."
cd "$SCRIPT_DIR"
node server.mjs &
JIANYING_PID=$!
echo "   PID: $JIANYING_PID"

# 启动 image-cache-server (端口 18092)
echo ""
echo "[2/2] 启动图片缓存服务 (端口 18092)..."
cd "$SCRIPT_DIR"
node imageCacheServer.mjs &
CACHE_PID=$!
echo "   PID: $CACHE_PID"

echo ""
echo "============================================"
echo " 所有服务已启动:"
echo "   - 剪映导出: http://127.0.0.1:18091"
echo "   - 图片缓存: http://127.0.0.1:18092"
echo "   - 主应用:   http://127.0.0.1:3000"
echo "============================================"
echo ""
echo "按 Ctrl+C 停止所有服务"
echo ""

# 等待任意进程退出
trap "echo '正在停止服务...'; kill $JIANYING_PID $CACHE_PID 2>/dev/null; exit 0" SIGINT SIGTERM

wait
