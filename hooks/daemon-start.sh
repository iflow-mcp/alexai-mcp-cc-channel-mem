#!/bin/sh
# cc-channel-mem 데몬 자동 시작 훅
# SessionStart 시 데몬이 꺼져 있으면 자동으로 재시작

DAEMON_DIR="$(dirname "$(dirname "$(realpath "$0")")")"
PID_FILE="$HOME/.cc-channel-mem/daemon.pid"
LOG_FILE="$HOME/.cc-channel-mem/daemon.log"

# PID 파일이 있으면 프로세스 살아있는지 확인
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    # 데몬 정상 실행 중 — 아무것도 안 함
    exit 0
  fi
fi

# 데몬 꺼진 경우 → 백그라운드로 재시작
cd "$DAEMON_DIR" && npm start >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
