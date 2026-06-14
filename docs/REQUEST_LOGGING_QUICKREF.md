# 请求日志快速参考

## 一行配置

```json
"debug": {"capture_request_headers": true, "request_log_path": "requests.debug.log"}
```

## 常用命令

```bash
# 查看最近请求
./scripts/view-request-log.sh

# 实时跟踪
./scripts/view-request-log.sh follow

# 统计分析
./scripts/analyze-request-log.sh

# 查看最后失败
./scripts/extract-request.sh --last-error

# API 查询
curl -s http://127.0.0.1:8787/pool/status | jq '.recent_requests[0]'
```

## 保存位置

1. **内存** → 最近 30 条，实时查询
2. **stats.local.json** → 持久化，重启恢复
3. **requests.debug.log** → 完整历史，JSONL 格式

## 记录内容

✅ 客户端原始请求头（包括敏感信息）  
✅ 客户端原始请求体（完整 JSON）  
✅ 路由决策和协议转换  
✅ 响应状态和性能指标

**重要**：记录的是真实客户端请求，不是转发后的内容

## 安全提示

⚠️ 日志包含敏感信息（API Keys、Cookies）  
⚠️ 已加入 .gitignore，不会提交  
⚠️ 分享前务必脱敏：`jq 'del(.incomingHeaders.authorization)' requests.debug.log`

## 清理

```bash
# 删除日志
rm requests.debug.log

# 只保留最近 1000 条
tail -n 1000 requests.debug.log > requests.debug.log.tmp && mv requests.debug.log.tmp requests.debug.log
```

## 分析示例

```bash
# 按上游统计
jq -r '.upstream // "null"' requests.debug.log | sort | uniq -c | sort -rn

# 最慢的 10 个请求
jq -r 'select(.durationMs) | "\(.durationMs) \(.upstream) \(.path)"' requests.debug.log | sort -rn | head -10

# 失败原因
jq -r 'select(.outcome == "error") | "\(.at) \(.reason)"' requests.debug.log

# Token 统计
jq -s 'map(select(.tokens)) | group_by(.upstream) | map({upstream: .[0].upstream, total: map(.tokens) | add})' requests.debug.log
```

详细文档：`docs/REQUEST_LOGGING.md`
