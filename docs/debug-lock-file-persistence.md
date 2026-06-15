# Debug Lock 文件持久化

## 功能说明

在 Debug Lock 模式下，可以将每次请求的完整诊断信息持久化到文件，便于分析不同请求产生的不同结果。

每个文件包含：
- **客户端原生请求体** - 客户端发送的完整请求
- **Pool 修改后的请求体** - 经过协议适配后发送给 upstream 的请求
- **完整响应体** - upstream 返回的响应
- **协议尝试序列** - 每个协议的尝试结果（成功/失败/fallback 原因）
- **时间和延迟信息** - 每次尝试的耗时

## 配置

在 `config.local.json` 中添加 `debug_lock_persistence` 配置节：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "upstreams": [
    // ... your upstreams
  ],
  "debug_lock_persistence": {
    "enabled": true,
    "directory": "./debug-lock-logs",
    "format": "json"
  }
}
```

### 配置选项

- **`enabled`** (boolean, 默认: `false`)
  - 是否启用文件持久化
  - 设置为 `true` 后，每个 Debug Lock 请求都会生成一个文件

- **`directory`** (string, 默认: `"./debug-lock-logs"`)
  - 文件存储目录
  - 目录不存在时会自动创建
  - 支持相对路径和绝对路径

- **`format`** (string, 默认: `"json"`)
  - 文件格式，目前仅支持 `"json"`

## 使用流程

### 1. 启用持久化配置

编辑 `config.local.json`：

```json
{
  "debug_lock_persistence": {
    "enabled": true,
    "directory": "./debug-lock-logs"
  }
}
```

### 2. 启动 Pool

```bash
npm start
```

### 3. 启用 Debug Lock

```bash
curl -X POST http://127.0.0.1:8787/pool/upstreams/mysite/debug-lock \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"respect_model_override": true}'
```

### 4. 发送测试请求

```bash
curl -X POST http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "Hello"
  }'
```

### 5. 查看生成的文件

每次请求会在 `debug-lock-logs/` 目录下生成一个 JSON 文件：

```bash
ls -lh debug-lock-logs/
# debug-lock-2026-06-15T10-00-00-123Z.json
# debug-lock-2026-06-15T10-00-05-456Z.json
```

## 文件格式示例

```json
{
  "debug_lock": {
    "upstream": "mysite",
    "locked_at": "2026-06-15T10:00:00Z",
    "respect_model_override": true
  },
  "client_request": {
    "protocol": "responses",
    "model": "gpt-5.5",
    "model_sent": "gpt-5.5",
    "original_body": "{\"model\":\"gpt-5.5\",\"input\":\"Hello\"}"
  },
  "attempts": [
    {
      "sequence": 1,
      "protocol": "responses",
      "endpoint": "/v1/responses",
      "adapter": false,
      "url": "https://api.example.com/v1/responses",
      "status": 404,
      "error": "Not Found",
      "error_body": "{\"error\": {\"message\": \"Endpoint not found\"}}",
      "request_body": "{\"model\":\"gpt-5.5\",\"input\":\"Hello\"}",
      "response_body": "{\"error\": {\"message\": \"Endpoint not found\"}}",
      "latency_ms": 123,
      "fallback_reason": "endpoint_not_found"
    },
    {
      "sequence": 2,
      "protocol": "chat_completions",
      "endpoint": "/v1/chat/completions",
      "adapter": true,
      "adapter_conversions": ["input_text->messages"],
      "adapter_stripped": [],
      "url": "https://api.example.com/v1/chat/completions",
      "status": 200,
      "request_body": "{\"model\":\"gpt-5.5\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}",
      "response_body": "{\"id\":\"chatcmpl-1\",\"choices\":[{\"message\":{\"content\":\"Hi there!\"}}]}",
      "latency_ms": 456,
      "streaming": true
    }
  ],
  "succeeded_with": {
    "protocol": "chat_completions",
    "adapter": true,
    "sequence": 2
  },
  "total_attempts": 2,
  "total_latency_ms": 579,
  "timestamp": "2026-06-15T10:00:01Z"
}
```

## 文件命名规则

文件名格式：`debug-lock-{timestamp}.json`

- `{timestamp}` 是请求的 ISO 时间戳，冒号和点号替换为横杠
- 示例：`debug-lock-2026-06-15T10-00-00-123Z.json`
- 不同时间戳的请求会生成不同文件，不会覆盖

## 分析示例

### 比较不同请求的协议适配

```bash
# 查看第一个请求使用的协议
jq '.succeeded_with.protocol' debug-lock-logs/debug-lock-2026-06-15T10-00-00-123Z.json
# "chat_completions"

# 查看第二个请求使用的协议
jq '.succeeded_with.protocol' debug-lock-logs/debug-lock-2026-06-15T10-00-05-456Z.json
# "responses"
```

### 提取所有请求体对比

```bash
# 提取客户端请求体
jq -r '.client_request.original_body' debug-lock-logs/*.json

# 提取成功的 upstream 请求体
jq -r '.attempts[] | select(.status == 200) | .request_body' debug-lock-logs/*.json

# 提取成功的响应体
jq -r '.attempts[] | select(.status == 200) | .response_body' debug-lock-logs/*.json
```

### 统计协议成功率

```bash
# 统计各协议的尝试次数
jq -r '.attempts[] | .protocol' debug-lock-logs/*.json | sort | uniq -c
```

## 注意事项

1. **文件大小**：每个文件包含完整的请求和响应体，如果请求/响应很大，文件也会很大
2. **磁盘空间**：文件不会自动清理，需要手动管理
3. **敏感信息**：文件包含完整的请求和响应，可能包含敏感信息，请注意安全
4. **性能影响**：文件写入是异步的，不会阻塞请求，失败时仅记录错误日志
5. **并发写入**：多个请求会生成不同的文件，不会冲突

## 禁用持久化

在 `config.local.json` 中设置 `enabled: false` 或完全移除 `debug_lock_persistence` 配置节：

```json
{
  "debug_lock_persistence": {
    "enabled": false
  }
}
```

或者直接删除该配置节，默认即为禁用状态。

## 清理历史文件

手动清理：

```bash
# 删除所有历史文件
rm -rf debug-lock-logs/

# 删除 7 天前的文件
find debug-lock-logs/ -name "debug-lock-*.json" -mtime +7 -delete

# 只保留最新的 100 个文件
ls -t debug-lock-logs/debug-lock-*.json | tail -n +101 | xargs rm -f
```
