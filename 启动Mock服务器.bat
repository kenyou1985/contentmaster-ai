@echo off
chcp 65001 >nul
echo ============================================================
echo 启动Mock服务器（连接即梦服务8080端口）
echo ============================================================
echo.

REM 设置环境变量
set JIMENG_API_BASE_URL=http://localhost:8080
echo [配置] 即梦API地址: %JIMENG_API_BASE_URL%

echo.
echo [检查] 验证即梦服务连接...
python -c "import requests; r = requests.get('http://localhost:8080/health', timeout=5); print('即梦服务状态: OK' if r.status_code == 200 else '即梦服务未运行')" 2>nul
if %errorlevel% neq 0 (
    echo [警告] 无法连接到即梦服务，请确保服务在8080端口运行
    echo [提示] 如果即梦服务未运行，请先运行: python jimeng_api_mock_8080.py
    echo.
    pause
)

echo.
echo [启动] Mock服务器...
echo [说明] Mock服务器将运行在5100端口
echo [说明] 网站配置: 即梦 API 地址 = http://localhost:5100
echo.
echo 按 Ctrl+C 可以停止服务器
echo.

python jm_mock_server.py
