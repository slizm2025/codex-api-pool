#!/bin/bash

# 提取特定请求的完整信息
# 使用方法：
#   ./scripts/extract-request.sh <request_id>          # 通过ID查找
#   ./scripts/extract-request.sh --last                # 最后一个请求
#   ./scripts/extract-request.sh --last-error          # 最后一个错误请求
#   ./scripts/extract-request.sh --upstream rawchat    # 最后一个使用指定上游的请求

LOG_FILE="requests.debug.log"

if [ ! -f "$LOG_FILE" ]; then
  echo "调试日志文件不存在: $LOG_FILE"
  exit 1
fi

case "$1" in
  --last)
    echo "最后一个请求的完整信息："
    echo ""
    tail -n 1 "$LOG_FILE" | jq -C '.'
    ;;
  --last-error)
    echo "最后一个失败请求的完整信息："
    echo ""
    jq -c 'select(.outcome == "error" or .outcome == "failed" or .succeeded == false)' "$LOG_FILE" | tail -n 1 | jq -C '.'
    ;;
  --upstream)
    if [ -z "$2" ]; then
      echo "错误：请指定上游名称"
      echo "使用方法: $0 --upstream <upstream_name>"
      exit 1
    fi
    echo "最后一个使用上游 '$2' 的请求："
    echo ""
    jq -c "select(.upstream == \"$2\")" "$LOG_FILE" | tail -n 1 | jq -C '.'
    ;;
  --model)
    if [ -z "$2" ]; then
      echo "错误：请指定模型名称"
      echo "使用方法: $0 --model <model_name>"
      exit 1
    fi
    echo "最后一个使用模型 '$2' 的请求："
    echo ""
    jq -c "select(.originalModel == \"$2\" or .model == \"$2\")" "$LOG_FILE" | tail -n 1 | jq -C '.'
    ;;
  --help|-h)
    echo "使用方法："
    echo "  $0 <request_id>                 # 通过ID查找特定请求"
    echo "  $0 --last                       # 显示最后一个请求"
    echo "  $0 --last-error                 # 显示最后一个失败请求"
    echo "  $0 --upstream <name>            # 显示最后一个使用指定上游的请求"
    echo "  $0 --model <model>              # 显示最后一个使用指定模型的请求"
    echo ""
    echo "提取的信息包括："
    echo "  - 请求时间、ID、方法、路径"
    echo "  - 完整的客户端请求头 (incomingHeaders)"
    echo "  - 完整的客户端请求体 (incomingBody)"
    echo "  - 使用的上游、密钥、模型"
    echo "  - 响应状态码、耗时"
    echo "  - 路由策略、兼容性转换信息"
    ;;
  "")
    echo "错误：请提供请求ID或选项"
    echo "使用 $0 --help 查看帮助"
    exit 1
    ;;
  *)
    # 通过ID查找
    echo "查找请求 ID: $1"
    echo ""
    FOUND=$(jq -c "select(.id == \"$1\")" "$LOG_FILE")
    if [ -z "$FOUND" ]; then
      echo "未找到请求 ID: $1"
      exit 1
    fi
    echo "$FOUND" | jq -C '.'
    ;;
esac
