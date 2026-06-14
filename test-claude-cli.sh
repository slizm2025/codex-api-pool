#!/bin/bash

# 测试 Claude CLI 兼容性

echo "========================================="
echo "Claude CLI 兼容性测试"
echo "========================================="
echo ""

# 1. 检查 Pool 是否运行
echo "1. 检查 Pool 状态..."
if curl -s http://127.0.0.1:8787/health > /dev/null 2>&1; then
  echo "   ✅ Pool 正在运行"
else
  echo "   ❌ Pool 未运行"
  exit 1
fi

echo ""

# 2. 测试模拟 Claude CLI 的请求
echo "2. 发送模拟 Claude CLI 请求..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: sk-slizm030506" \
  -H "Content-Type: application/json" \
  -H "User-Agent: claude-cli/2.1.177 (external, cli)" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: claude-code-20250219" \
  -H "anthropic-dangerous-direct-browser-access: true" \
  -H "x-app: cli" \
  -d '{
    "model": "claude-opus-4-8",
    "max_tokens": 50,
    "messages": [{"role": "user", "content": "Say hello"}]
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n -1)

echo "   HTTP 状态码: $HTTP_CODE"

if [ "$HTTP_CODE" = "200" ]; then
  echo "   ✅ 请求成功"
  echo ""
  echo "   响应内容:"
  echo "$BODY" | jq -C '.' 2>/dev/null || echo "$BODY"
elif [ "$HTTP_CODE" = "503" ]; then
  echo "   ⚠️  503 - 无可用上游"
  echo ""
  echo "   错误详情:"
  echo "$BODY" | jq -C '.' 2>/dev/null || echo "$BODY"
  echo ""
  echo "   可能原因:"
  echo "   - runanytime_claude 被禁用"
  echo "   - runanytime_claude 在冷却中"
  echo "   - runanytime_claude 健康检查失败"
else
  echo "   ❌ 请求失败"
  echo ""
  echo "   响应:"
  echo "$BODY" | jq -C '.' 2>/dev/null || echo "$BODY"
fi

echo ""
echo ""

# 3. 检查可用的 Anthropic 上游
echo "3. 检查支持 Anthropic Messages API 的上游..."
curl -s http://127.0.0.1:8787/pool/status | jq -r '
  .upstreams
  | map(select(.api == "anthropic" or .api == "both"))
  | map({
      name,
      enabled,
      health: .health.state,
      cooldown: (if .health.cooldownUntil then "冷却中" else "正常" end)
    })
  | .[]
' 2>/dev/null || echo "   无法获取状态"

echo ""
echo ""

# 4. 查看最近的请求
echo "4. 查看最近的请求日志..."
curl -s http://127.0.0.1:8787/pool/status | jq -C '
  .recent_requests[0]
  | {
      at,
      path,
      upstream,
      status,
      succeeded,
      reason
    }
' 2>/dev/null || echo "   无法获取请求日志"

echo ""
echo ""

# 5. 建议
echo "========================================="
echo "诊断建议"
echo "========================================="
echo ""
echo "如果看到 503 错误："
echo "1. 检查 Dashboard: open http://127.0.0.1:8787/pool/dashboard"
echo "2. 手动触发健康检查:"
echo "   curl -X POST http://127.0.0.1:8787/pool/probe -H 'Authorization: Bearer \$CODEX_POOL_API_KEY'"
echo "3. 查看 runanytime_claude 详细状态:"
echo "   curl -s http://127.0.0.1:8787/pool/status | jq '.upstreams[] | select(.name == \"runanytime_claude\")'"
echo "4. 如果上游在冷却中，等待冷却结束或手动清除:"
echo "   curl -X POST http://127.0.0.1:8787/pool/upstreams/runanytime_claude/enable -H 'Authorization: Bearer \$CODEX_POOL_API_KEY'"
echo ""
