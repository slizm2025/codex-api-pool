# 请求日志调试功能完整说明

## 快速参考

**一行配置**：`"debug": { "capture_request_headers": true, "request_log_path": "requests.debug.log" }`

```bash
./scripts/view-request-log.sh              # 查看最近请求
./scripts/view-request-log.sh follow        # 实时跟踪
./scripts/analyze-request-log.sh            # 统计分析
./scripts/extract-request.sh --last-error   # 查看最后失败
curl -s http://127.0.0.1:8787/pool/status | jq '.recent_requests[0]'   # API 查询
```

**常用分析**：
```bash
jq -r '.upstream // "null"' requests.debug.log | sort | uniq -c | sort -rn   # 按上游统计
jq -r 'select(.durationMs) | "\(.durationMs) \(.upstream) \(.path)"' requests.debug.log | sort -rn | head -10   # 最慢请求
jq -r 'select(.outcome == "error") | "\(.at) \(.reason)"' requests.debug.log   # 失败原因
```

⚠️ 日志包含敏感信息（API Keys、Cookies），已加入 `.gitignore`；分享前脱敏：`jq 'del(.incomingHeaders.authorization)' requests.debug.log`

---

## 功能概述

Codex API Pool 现在支持完整的请求捕获和日志记录功能，用于调试和分析客户端请求。

### 关键特性

✅ **捕获真实客户端请求**
- 记录的是客户端发来的**原始请求**，不是转发给上游后的请求
- 在任何协议转换、适配器处理之前就已捕获

✅ **完整信息保存**
- 所有请求头（包括敏感头如 Authorization、Cookie）
- 完整请求体（JSON payload）
- 路由决策和协议转换信息
- 响应状态和性能指标

✅ **三层存储**
1. 内存：最近 30 条，实时查询
2. stats.local.json：持久化，重启恢复
3. requests.debug.log：可选，JSONL 格式，方便分析

## 配置

编辑 `config.local.json`：

```json
{
  "debug": {
    "capture_request_headers": true,
    "request_log_path": "requests.debug.log"
  }
}
```

**配置项说明：**
- `capture_request_headers`: 必须为 `true` 才会捕获完整信息
- `request_log_path`: 可选，设置后会写入日志文件（每行一条 JSON）

## 存储位置详解

### 1. 内存 (state.recentRequests)

- **容量**：最近 30 条
- **持久性**：进程重启时丢失（但会从 stats.local.json 恢复）
- **访问方式**：`/pool/status` API 或 Dashboard

### 2. stats.local.json

- **位置**：项目根目录
- **内容**：包含 `recentRequests` 数组
- **更新**：每次请求后延迟写入（防止频繁 I/O）
- **恢复**：服务启动时自动加载

### 3. requests.debug.log

- **格式**：JSONL（每行一个完整 JSON 对象）
- **追加模式**：不会覆盖，只追加新记录
- **大小**：需要手动清理（未实现自动轮转）
- **优点**：方便用 `jq`、`grep`、`awk` 等工具分析

## 查看方式

### 方法 1: Dashboard（推荐）

```bash
open http://127.0.0.1:8787/pool/dashboard
```

Dashboard 会显示最近的请求，可以直观查看：
- 请求时间、路径、方法
- 使用的上游和状态码
- 耗时和 Token 消耗

### 方法 2: API 查询

```bash
# 获取所有最近请求
curl -s http://127.0.0.1:8787/pool/status | jq '.recent_requests'

# 查看最后一个请求的完整信息
curl -s http://127.0.0.1:8787/pool/status | jq '.recent_requests[0]'

# 提取请求头
curl -s http://127.0.0.1:8787/pool/status | jq '.recent_requests[0].incomingHeaders'

# 提取请求体
curl -s http://127.0.0.1:8787/pool/status | jq '.recent_requests[0].incomingBody'

# 只看失败的请求
curl -s http://127.0.0.1:8787/pool/status | \
  jq '.recent_requests[] | select(.outcome == "error" or .succeeded == false)'
```

### 方法 3: 日志文件脚本

项目提供了三个便捷脚本：

#### 3.1 查看日志 (view-request-log.sh)

```bash
# 查看最近 10 条（默认）
./scripts/view-request-log.sh

# 查看最近 20 条
./scripts/view-request-log.sh 20

# 查看所有
./scripts/view-request-log.sh all

# 实时跟踪（类似 tail -f）
./scripts/view-request-log.sh follow
```

#### 3.2 统计分析 (analyze-request-log.sh)

```bash
./scripts/analyze-request-log.sh
```

输出示例：
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
请求日志统计
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

总请求数: 156

按协议分组：
    145 responses
     11 messages

按上游分组：
     98 rawchat
     45 JUN
     13 any

按状态码分组：
    142 200
     12 429
      2 500

按结果分组：
    142 ok
     12 error
      2 failed

响应时间统计：
  平均: 1245 ms
  最小: 234 ms
  最大: 5678 ms
```

#### 3.3 提取特定请求 (extract-request.sh)

```bash
# 最后一个请求
./scripts/extract-request.sh --last

# 最后一个失败请求
./scripts/extract-request.sh --last-error

# 特定上游的最后一个请求
./scripts/extract-request.sh --upstream rawchat

# 特定模型的最后一个请求
./scripts/extract-request.sh --model claude-opus-4-8

# 通过 ID 查找
./scripts/extract-request.sh 1718123456789-a1b2c3d4
```

## 日志记录内容

每条请求记录包含以下字段：

```json
{
  "id": "1718123456789-a1b2c3d4",
  "at": "2026-06-13T10:30:45.123Z",
  "method": "POST",
  "path": "/v1/responses",
  "entry_protocol": "responses",
  "incomingHeaders": {
    "authorization": "Bearer sk-xxx...",
    "content-type": "application/json",
    "user-agent": "codex_cli/1.2.3",
    "x-custom-header": "value"
  },
  "incomingBody": {
    "model": "claude-opus-4-8",
    "input": [
      {"type": "text", "text": "Hello, world!"}
    ],
    "stream": true
  },
  "upstream": "rawchat",
  "key": "rawchat-key-1",
  "originalModel": "claude-opus-4-8",
  "actualModel": "claude-opus-4-8",
  "status": 200,
  "durationMs": 1234,
  "retried": false,
  "outcome": "ok",
  "reason": "",
  "route": {
    "input_api": "responses",
    "upstream_api": "anthropic_messages",
    "adapter": "responses_to_anthropic_messages",
    "native_required": false
  },
  "compatibility": {
    "converted": ["input[0].text"],
    "downgraded": [],
    "stripped": []
  },
  "tokens": 156,
  "inputTokens": 12,
  "outputTokens": 144
}
```

## 高级分析示例

### 1. 按小时统计请求量

```bash
jq -r '.at | split("T")[1] | split(":")[0]' requests.debug.log | \
  sort | uniq -c | sort -rn
```

### 2. 找出最慢的 10 个请求

```bash
jq -r 'select(.durationMs != null) | "\(.durationMs) \(.at) \(.path) -> \(.upstream)"' \
  requests.debug.log | sort -rn | head -10
```

### 3. 统计每个上游的平均响应时间

```bash
jq -r 'select(.durationMs != null) | "\(.upstream) \(.durationMs)"' \
  requests.debug.log | \
  awk '{sum[$1]+=$2; count[$1]++} END {for(u in sum) print u, int(sum[u]/count[u]) "ms"}' | \
  sort -k2 -rn
```

### 4. 提取所有失败请求的原因

```bash
jq -r 'select(.outcome == "error" or .succeeded == false) | 
  "[\(.at)] \(.upstream // "null") - \(.reason)"' requests.debug.log
```

### 5. 查找使用特定协议适配器的请求

```bash
jq 'select(.route.adapter == "responses_to_anthropic_messages")' requests.debug.log
```

### 6. 统计 Token 消耗

```bash
jq -r 'select(.tokens != null) | "\(.upstream) \(.tokens)"' requests.debug.log | \
  awk '{sum[$1]+=$2; count[$1]++} END {
    for(u in sum) printf "%s: %d tokens (%d requests, avg %d)\n", u, sum[u], count[u], int(sum[u]/count[u])
  }' | sort -t: -k2 -rn
```

## 日志清理

### 清空日志文件

```bash
rm requests.debug.log
```

### 只保留最近 N 条

```bash
tail -n 1000 requests.debug.log > requests.debug.log.tmp
mv requests.debug.log.tmp requests.debug.log
```

### 按日期归档

```bash
DATE=$(date +%Y%m%d)
mv requests.debug.log "requests.debug.log.$DATE"
```

## 安全注意事项

⚠️ **requests.debug.log 包含敏感信息**

- 完整的 Authorization 头（API Keys）
- Cookie 和会话令牌
- 用户的原始输入内容
- 内部系统信息

### 最佳实践

1. **不要提交到 Git**
   - 已添加到 `.gitignore`
   - 检查：`git status` 不应显示此文件

2. **分享前务必脱敏**
   ```bash
   # 移除敏感头
   jq 'del(.incomingHeaders.authorization, 
           .incomingHeaders.cookie,
           .incomingHeaders["x-api-key"])' \
     requests.debug.log > requests.debug.sanitized.log
   ```

3. **定期清理**
   - 日志文件会持续增长
   - 建议每周或每月清理一次

4. **限制访问权限**
   ```bash
   chmod 600 requests.debug.log
   ```

## 性能影响

启用请求捕获的性能影响：

- **内存**：每条记录约 2-10 KB（取决于请求体大小）
  - 30 条记录约 60-300 KB
- **I/O**：
  - stats.local.json 延迟写入（500ms debounce）
  - requests.debug.log 同步追加（每次请求 ~1ms）
- **建议**：生产环境可以只保存到内存和 stats.local.json，不启用 request_log_path

## 故障排查

### 日志文件没有生成

检查：
1. `config.local.json` 中 `debug.capture_request_headers` 是否为 `true`
2. `config.local.json` 中是否设置了 `debug.request_log_path`
3. 进程是否有写入权限
4. 是否已重启服务

### 日志中缺少请求头或请求体

检查：
1. `debug.capture_request_headers` 必须为 `true`
2. 旧的日志记录（功能启用前）不会有这些字段

### stats.local.json 中没有敏感信息

正常现象：
- `statsSnapshot` 会根据 `capture_request_headers` 配置决定是否保存
- 如果为 `true`，会保存完整信息
- 如果为 `false`，会调用 `stripRequestDebugFields` 移除敏感字段

## 测试

启用功能后，运行测试：

```bash
./test-request-capture.sh
```

预期输出：
```
测试 1: 发送 Responses API 请求...
✓ 请求已发送

测试 2: 查看最近的请求记录...
{
  "at": "2026-06-13T10:30:45.123Z",
  "method": "POST",
  "path": "/v1/responses",
  ...
  "has_headers": true,
  "has_body": true,
  ...
}

测试完成！
```

## 总结

请求日志功能提供了三种访问方式：

| 方式 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| Dashboard | 快速查看最近请求 | 可视化、直观 | 只能看最近 30 条 |
| API 查询 | 程序化访问、自动化 | 灵活、可编程 | 需要 curl/jq |
| 日志文件 | 历史分析、深度挖掘 | 完整历史、强大分析 | 需要磁盘空间 |

建议组合使用：
- 开发调试：Dashboard + API 查询
- 生产监控：只用内存 + stats.local.json
- 深度分析：启用 request_log_path + 分析脚本
