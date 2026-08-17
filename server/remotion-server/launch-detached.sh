#!/bin/bash
# ContentMaster AI · Remotion 服务守护启动器（脱离当前 shell）
# 用法：./launch-detached.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-18093}"
LOG="/tmp/remotion-server.log"
PID_FILE="/tmp/remotion-server.pid"

# 如果已运行则先停止
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[stop] 已有实例 PID $(cat "$PID_FILE")，先停止..."
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  sleep 1
fi

# 端口占用检查
if lsof -i :"$PORT" -P -n 2>/dev/null | grep -q LISTEN; then
  echo "[error] 端口 $PORT 仍被占用，请手动 lsof -ti :$PORT | xargs kill -9"
  exit 1
fi

echo "[start] 启动 Remotion 服务（端口 $PORT）..."
echo "[start] 日志：$LOG"

# 用 nohup + & 启动，< /dev/null 切断 stdin
# 注意：macOS 没有 setsid，靠 nohup + 重定向 stdin/stdout 让 init 接管
nohup env PORT="$PORT" \
  REMOTION_PROJECT_ROOT="$SCRIPT_DIR/../../remotion" \
  REMOTION_OUTPUT_DIR="${REMOTION_OUTPUT_DIR:-/tmp/remotion-out}" \
  node server.mjs >> "$LOG" 2>&1 < /dev/null &
NEW_PID=$!
disown
echo "$NEW_PID" > "$PID_FILE"

sleep 3
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "[ok] 服务已启动 PID $NEW_PID"
  echo "[ok] 健康检查：http://127.0.0.1:$PORT/health"
else
  echo "[fail] 进程已退出，查看日志："
  tail -20 "$LOG"
  exit 1
fi