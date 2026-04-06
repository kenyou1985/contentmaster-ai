#!/bin/bash
# ========================================
#   ContentMaster AI - 启动剪映导出服务
# ========================================
cd "$(dirname "$0")"
echo "📁 当前目录: $(pwd)"
echo "🚀 启动剪映导出 HTTP 服务..."
echo ""
echo "服务地址: http://127.0.0.1:18091"
echo "API 列表:"
echo "  GET  /api/jianying/list    → 列出所有草稿"
echo "  POST /api/jianying/export  → 导出草稿"
echo "  GET  /api/jianying/health  → 健康检查"
echo ""
echo "按 Ctrl+C 停止服务"
echo ""
node server/server.mjs
