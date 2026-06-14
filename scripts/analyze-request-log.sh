#!/bin/bash

# 分析原始请求日志
# 提取和统计各种信息

LOG_FILE="requests.debug.log"

if [ ! -f "$LOG_FILE" ]; then
  echo "调试日志文件不存在: $LOG_FILE"
  exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "请求日志统计"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 总请求数
TOTAL=$(wc -l < "$LOG_FILE")
echo "总请求数: $TOTAL"

# 按协议分组
echo ""
echo "按协议分组："
jq -r '.entry_protocol // "unknown"' "$LOG_FILE" | sort | uniq -c | sort -rn

# 按上游分组
echo ""
echo "按上游分组："
jq -r '.upstream // "null"' "$LOG_FILE" | sort | uniq -c | sort -rn

# 按状态码分组
echo ""
echo "按状态码分组："
jq -r '.status // "null"' "$LOG_FILE" | sort | uniq -c | sort -rn

# 按结果分组
echo ""
echo "按结果分组："
jq -r '.outcome // "unknown"' "$LOG_FILE" | sort | uniq -c | sort -rn

# 按模型分组
echo ""
echo "按模型分组："
jq -r '.originalModel // .model // "unknown"' "$LOG_FILE" | sort | uniq -c | sort -rn

# 平均响应时间
echo ""
echo "响应时间统计："
jq -r 'select(.durationMs != null) | .durationMs' "$LOG_FILE" | awk '{
  sum+=$1;
  count++;
  if(min==""){min=max=$1};
  if($1>max){max=$1};
  if($1<min){min=$1}
}
END {
  if(count>0) {
    print "  平均: " int(sum/count) " ms"
    print "  最小: " min " ms"
    print "  最大: " max " ms"
  } else {
    print "  无数据"
  }
}'

# 最近失败的请求
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "最近5个失败请求："
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
jq -r 'select(.outcome == "error" or .outcome == "failed" or .succeeded == false) |
  "[\(.at)] \(.method) \(.path) → \(.upstream // "null") | 状态:\(.status) | 原因:\(.reason // "unknown")"' \
  "$LOG_FILE" | tail -n 5

echo ""
