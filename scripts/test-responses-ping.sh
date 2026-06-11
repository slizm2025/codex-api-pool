#!/usr/bin/env bash
set -euo pipefail

echo "=== Responses API 终端测试工具 ==="

# 1. 交互输入 BASE_URL (按回车直接使用默认值)
read -p "请输入 BASE_URL [默认: https://academicedu.me/v1]: " INPUT_BASE_URL
RESPONSES_BASE_URL="${INPUT_BASE_URL:-https://academicedu.me/v1}"

# 2. 交互输入 API_KEY (静默模式，输入不回显)
read -s -p "请输入 API_KEY (输入内容将隐藏): " RESPONSES_API_KEY
echo "" # 补充换行符

# 校验 API_KEY
if [[ -z "${RESPONSES_API_KEY}" ]]; then
  echo "❌ 错误: API_KEY 不能为空！脚本已终止。"
  exit 1
fi

# 3. 设定默认模型
RESPONSES_MODEL="gpt-5.5"

echo "-----------------------------------"
echo "🚀 准备发送请求..."
echo "🔗 目标端点: ${RESPONSES_BASE_URL%/}/responses"
echo "🤖 选用模型: ${RESPONSES_MODEL}"
echo "-----------------------------------"

# 4. 执行请求
curl -s "${RESPONSES_BASE_URL%/}/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${RESPONSES_API_KEY}" \
  -d "{
    \"model\": \"${RESPONSES_MODEL}\",
    \"input\": [
      {
        \"role\": \"developer\",
        \"content\": \"你是一个资深的后端专家，请用简练的语言回答。\"
      },
      {
        \"role\": \"user\",
        \"content\": \"ping\"
      }
    ]
  }"

echo -e "\n\n✅ 请求完成。"