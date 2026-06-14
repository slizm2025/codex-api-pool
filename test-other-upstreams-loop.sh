#!/bin/bash
# 反馈循环：测试其他上游是否能正常使用 claude-opus-4-8

POOL_URL="http://127.0.0.1:8787"
API_KEY="${CODEX_POOL_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "❌ 错误：未设置 CODEX_POOL_API_KEY 环境变量"
  exit 1
fi

echo "🧪 测试其他上游对 claude-opus-4-8 的支持"
echo "================================================"
echo ""

# 测试请求
echo "发送测试请求到 /v1/messages..."
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
echo "HTTP Status: $http_code"
echo "Response Body:"
echo "$body" | jq '.' 2>/dev/null || echo "$body"

# 检查是否成功
if [ "$http_code" = "200" ]; then
  echo ""
  echo "✅ 测试通过：请求成功"
  exit 0
else
  echo ""
  echo "❌ 测试失败：请求返回错误"

  # 提取错误信息
  error_type=$(echo "$body" | jq -r '.error.type // .type // "unknown"' 2>/dev/null)
  error_message=$(echo "$body" | jq -r '.error.message // .message // "unknown"' 2>/dev/null)

  echo ""
  echo "错误类型: $error_type"
  echo "错误信息: $error_message"

  exit 1
fi
