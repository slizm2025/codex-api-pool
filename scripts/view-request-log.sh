#!/bin/bash

# 查看原始请求调试日志
# 使用方法：
#   ./scripts/view-request-log.sh              # 查看最近10条
#   ./scripts/view-request-log.sh 20           # 查看最近20条
#   ./scripts/view-request-log.sh all          # 查看全部
#   ./scripts/view-request-log.sh follow       # 实时跟踪

LOG_FILE="requests.debug.log"
COUNT="${1:-10}"

if [ ! -f "$LOG_FILE" ]; then
  echo "调试日志文件不存在: $LOG_FILE"
  echo "请确保："
  echo "  1. config.local.json 中设置了 debug.capture_request_headers: true"
  echo "  2. config.local.json 中设置了 debug.request_log_path: \"requests.debug.log\""
  echo "  3. 池服务正在运行并已处理请求"
  exit 1
fi

case "$COUNT" in
  follow|tail|-f)
    echo "实时跟踪请求日志 (Ctrl+C 退出)..."
    echo ""
    tail -f "$LOG_FILE" | while read -r line; do
      echo "$line" | jq -C '.'
    done
    ;;
  all)
    echo "显示所有请求记录："
    echo ""
    cat "$LOG_FILE" | jq -C '.'
    ;;
  *)
    if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
      echo "错误：参数必须是数字、'all' 或 'follow'"
      exit 1
    fi
    echo "显示最近 $COUNT 条请求："
    echo ""
    tail -n "$COUNT" "$LOG_FILE" | jq -C '.'
    ;;
esac
