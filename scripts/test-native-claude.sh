#!/usr/bin/env bash
# 测试 Codex API Pool 的原生 Claude 入口 (/v1/messages, Anthropic Messages 协议)
# 用法: 在宿主机上运行  bash scripts/test-native-claude.sh  [model]
# 需要环境变量 CODEX_POOL_API_KEY (与启动 pool 时一致)
set -euo pipefail

POOL_URL="${POOL_URL:-http://127.0.0.1:8787}"
MODEL="${1:-claude-sonnet-4-5-20250929}"
TOKEN="${CODEX_POOL_API_KEY:?请先 export CODEX_POOL_API_KEY=<你的 pool token>}"

echo "== 1) Health =="
curl -s -m 5 "$POOL_URL/health" && echo || echo "(health 无响应)"

echo
echo "== 2) 原生 Claude 非流式请求 ($MODEL) =="
curl -sS -m 60 "$POOL_URL/v1/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 64,
    \"messages\": [{\"role\": \"user\", \"content\": \"用一句话回答：你现在能正常工作吗？\"}]
  }" | { command -v jq >/dev/null && jq . || cat; }

echo
echo "== 3) 原生 Claude 流式请求 ($MODEL) =="
curl -sS -N -m 60 "$POOL_URL/v1/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 64,
    \"stream\": true,
    \"messages\": [{\"role\": \"user\", \"content\": \"数到三\"}]
  }" | head -40

echo
echo "== 完成 =="
