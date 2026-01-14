@echo off
chcp 65001 >nul
echo ========================================
echo   正在启动 ContentMaster AI 服务器
echo ========================================
echo.
echo 服务器启动中，请稍候...
echo 启动成功后会自动打开浏览器
echo.
echo 按 Ctrl+C 可以停止服务器
echo.
call npm run dev
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 启动失败！请检查错误信息。
    pause
)
