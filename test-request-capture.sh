#!/bin/bash

# 测试请求捕获功能
# 确保 debug.capture_request_headers 已设置为 true

set -e

POOL_URL="https://api.anthropic.com/v1/messages"
API_KEY="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"

if [ -z "$API_KEY" ]; then
  echo "错误：请设置 CODEX_POOL_API_KEY 环境变量"
  exit 1
fi

echo "测试 1: 发送 Responses API 请求..."
curl -s "$POOL_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Test-Header: test-value-123" \
  -d '{
    "model": "claude-opus-4-8",
    "input": [
      {"type": "text", "text": "Hello, this is a test request"}
    ],
    "stream": false
  }' > /dev/null

echo "✓ 请求已发送"

echo ""
echo "测试 2: 查看最近的请求记录..."
sleep 1

curl -s "$POOL_URL/pool/status" \
  -H "Authorization: Bearer $API_KEY" | \
  jq '.recent_requests[0] | {
    at,
    method,
    path,
    entry_protocol,
    upstream,
    status,
    durationMs,
    has_headers: (.incomingHeaders != null),
    has_body: (.incomingBody != null),
    headers_sample: (.incomingHeaders | if . then {
      authorization: .authorization,
      content_type: ."content-type",
      x_test_header: ."x-test-header"
    } else null end),
    body_model: (.incomingBody.model // null),
    body_input_count: (.incomingBody.input | length // null)
  }'

echo ""
echo "测试完成！"
echo ""
echo "如果看到 has_headers: true 和 has_body: true，说明捕获功能正常工作。"
echo "如果看到 authorization 字段，说明敏感头也被捕获了（符合预期）。"
