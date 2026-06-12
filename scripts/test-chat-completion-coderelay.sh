#!/usr/bin/env bash
set -euo pipefail

BASE_URL="https://llmhub.qzz.io/v1"
API_KEY="sk-4a83c1cf22efc3fd647b3d7b9c8640ccfcd6dbf26cf60ce1b507ca289d9b4b04"
MODEL="gpt-5.5"

echo "=== Chat Completions API 明文测试脚本 ==="
echo "目标端点: ${BASE_URL%/}/chat/completions"
echo "测试模型: ${MODEL}"
echo "-----------------------------------"

curl -sS "${BASE_URL%/}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [
      {
        \"role\": \"system\",
        \"content\": \"你是一个简洁的 API 连通性测试助手。\"
      },
      {
        \"role\": \"user\",
        \"content\": \"请回复 pong，并用一句话说明接口可用。\"
      }
    ],
    \"temperature\": 0.2,
    \"max_tokens\": 128
  }"

echo -e "\n-----------------------------------"
echo "请求完成。"
