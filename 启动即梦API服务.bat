@echo off
chcp 65001 >nul
echo ============================================================
echo 启动即梦API服务（3030端口）
echo ============================================================
echo.

cd /d "%~dp0jimeng-api"

echo [步骤1] 停止占用3030端口的服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3030" ^| findstr "LISTENING"') do (
    echo [停止] 进程ID: %%a
    taskkill /F /PID %%a >nul 2>&1
    if %errorlevel% equ 0 (
        echo [✓] 进程已停止
    )
)

timeout /t 2 /nobreak >nul

echo.
echo [步骤2] 验证3030端口...
netstat -an | findstr ":3030" | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo [警告] 3030端口仍被占用
    echo [提示] 请手动关闭占用该端口的程序
    pause
    exit /b 1
) else (
    echo [✓] 3030端口已释放
)
echo.

echo [步骤3] 配置SESSION_ID...
set J_TOKEN=6eac93ccd72cf4372558f38ee2a3161a
echo [✓] SESSION_ID已设置
echo.

echo [步骤4] 启动即梦API服务...
echo [端口] 3030
echo [地址] http://localhost:3030
echo [提示] 按 Ctrl+C 停止服务
echo.
echo [前端配置]
echo   即梦 API 地址: http://localhost:3030
echo   即梦 SESSION_ID: 6eac93ccd72cf4372558f38ee2a3161a
echo.
echo ============================================================
echo.

npm start

pause
