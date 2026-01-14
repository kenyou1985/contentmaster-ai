@echo off
chcp 65001 >nul
echo ========================================
echo   ContentMaster AI - 启动开发服务器
echo ========================================
echo.
echo 正在启动开发服务器...
echo 服务器将在 http://localhost:3000 启动
echo.
echo 按 Ctrl+C 可以停止服务器
echo.
npm run dev
