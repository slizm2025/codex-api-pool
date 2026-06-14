#!/bin/bash
# 反馈循环：测试特定上游是否能正常使用 claude-opus-4-8

POOL_URL="http://127.0.0.1:8787"
API_KEY="${CODEX_POOL_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "❌ 错误：未设置 CODEX_POOL_API_KEY 环境变量"
  exit 1
fi

echo "🧪 测试循环：强制使用非 Mint_claude 上游"
echo "================================================"
echo ""

# 先禁用 Mint_claude，强制选择其他上游
echo "1. 禁用 Mint_claude..."
disable_response=$(curl -s -X POST "$POOL_URL/pool/upstreams/Mint_claude/disable" \
  -H "Authorization: Bearer $API_KEY")
echo "   响应: $(echo "$disable_response" | jq -c '.' 2>/dev/null || echo "$disable_response")"

echo ""
echo "2. 发送测试请求（应该路由到 JUN 或其他上游）..."
response=$(curl -s -w "\n%{http_code}" "$POOL_URL/v1/messages" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-8",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 5
  }')

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

echo ""
echo "   HTTP Status: $http_code"
echo "   Response:"
echo "$body" | jq '.' 2>/dev/null || echo "$body"

# 获取实际使用的上游
echo ""
echo "3. 检查实际使用的上游..."
recent=$(curl -s "$POOL_URL/pool/status" | jq '.recent_requests[0] | {upstream, model, forwarded_model, status}')
echo "   $recent"

# 重新启用 Mint_claude
echo ""
echo "4. 恢复 Mint_claude..."
enable_response=$(curl -s -X POST "$POOL_URL/pool/upstreams/Mint_claude/enable" \
  -H "Authorization: Bearer $API_KEY")

# 检查结果
echo ""
if [ "$http_code" = "200" ]; then
  echo "✅ 测试通过：其他上游可以正常使用 claude-opus-4-8"
  exit 0
else
  echo "❌ 测试失败：其他上游无法使用 claude-opus-4-8"
  echo ""
  echo "错误详情:"
  echo "$body" | jq '.error // {type: "unknown", message: .}' 2>/dev/null || echo "$body"
  exit 1
fi
