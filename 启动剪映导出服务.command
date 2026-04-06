#!/bin/bash
# ========================================
#   ContentMaster AI - 启动剪映导出服务 (macOS 双击版)
# ========================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

osascript -e 'tell app "Terminal" to activate' 2>/dev/null || true

echo "📁 当前目录: $(pwd)"
echo "🚀 启动剪映导出 HTTP 服务..."
echo ""
echo "服务地址: http://127.0.0.1:18091"
echo "API 列表:"
echo "  GET  /api/jianying/list    → 列出所有草稿"
echo "  POST /api/jianying/export  → 导出草稿"
echo "  GET  /api/jianying/health → 健康检查"
echo ""
echo "⚠️  请确保先运行 npm run dev 启动主应用"
echo "按 Ctrl+C 停止服务"
echo ""

node server/server.mjs

# 保持终端打开
echo ""
echo "服务已停止，按任意键退出..."
read -n1
