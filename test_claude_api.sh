#!/bin/bash

# Claude API 测试脚本
# 可以直接在终端运行

BASE_URL="https://x666.me"
API_KEY="sk-p7ektFUET77hVoU1bU8bHVvHQzTpMVakIAbt0TrAPd7vkLwm"

echo "============================================================"
echo "Claude API 连接测试"
echo "============================================================"
echo "Base URL: $BASE_URL"
echo "API Key: ${API_KEY:0:20}..."
echo ""

# 测试 1: 基本请求
echo "【测试 1】发送基本请求..."
echo "------------------------------------------------------------"

response=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6-cc",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "你好！请用一句话介绍你自己。"
      }
    ]
  }')

# 分离响应体和状态码
http_code=$(echo "$response" | tail -n 1)
response_body=$(echo "$response" | sed '$d')

echo "HTTP 状态码: $http_code"
echo ""

if [ "$http_code" = "200" ]; then
    echo "✓ 连接成功！"
    echo ""
    echo "响应内容:"
    echo "$response_body" | python3 -m json.tool 2>/dev/null || echo "$response_body"
else
    echo "✗ 请求失败"
    echo ""
    echo "错误详情:"
    echo "$response_body" | python3 -m json.tool 2>/dev/null || echo "$response_body"
fi

echo ""
echo "============================================================"
echo ""

# 测试 2: 流式请求
echo "【测试 2】测试流式响应..."
echo "------------------------------------------------------------"
echo "发送流式请求..."
echo ""
echo "流式响应内容:"
echo "------------------------------------------------------------"

curl -s -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "请数到5，每个数字占一行。"
      }
    ]
  }' | while IFS= read -r line; do
    if [[ $line == data:* ]]; then
        json_data="${line#data: }"
        if [[ $json_data != "[DONE]" ]]; then
            echo "$json_data" | python3 -c "
import sys, json
try:
    data = json.loads(sys.stdin.read())
    if data.get('type') == 'content_block_delta':
        text = data.get('delta', {}).get('text', '')
        print(text, end='', flush=True)
except: pass
" 2>/dev/null
        fi
    fi
done

echo ""
echo "------------------------------------------------------------"
echo ""
echo "============================================================"
echo "测试完成"
echo "============================================================"
