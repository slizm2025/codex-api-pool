# 客户端原始请求捕获验证文档

## 核心确认

✅ **保存的是真实客户端的原始请求，不是转发后的请求**

## 验证要点

### 1. 捕获时机

#### Responses API (第13329-13330行)
```javascript
const originalBody = await readBody(req, maxBodyBytes);
const incomingHeaderSample = captureIncomingRequestHeaders(config, req.headers);
```
**时机**：在任何处理之前，直接从 `req` 读取
- `req` 是 Node.js HTTP 请求对象，来自客户端
- `originalBody` 是**客户端发来的原始字节**
- `incomingHeaderSample` 是**客户端发来的原始请求头**

#### Messages API (第12915-12916行)
```javascript
const originalBody = await readBody(req, maxBodyBytes);
const incomingHeaderSample = captureIncomingRequestHeaders(config, req.headers);
```
**时机**：同样在任何处理之前

### 2. 保存内容确认

#### 请求头
```javascript
function captureIncomingRequestHeaders(config, headers = {}) {
  if (config.debug?.capture_request_headers !== true) return undefined;
  // Capture ALL headers without filtering when debug mode is enabled
  const captured = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    captured[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return captured;
}
```
**确认**：
- ✅ 直接从客户端的 `req.headers` 捕获
- ✅ 所有头都被保存，无过滤
- ✅ 包括敏感头（authorization, cookie 等）

#### 请求体
```javascript
function requestDebugFields(incomingHeaders, incomingBody) {
  const fields = {};
  if (incomingHeaders) fields.incomingHeaders = incomingHeaders;
  if (incomingBody !== undefined) {
    try {
      fields.incomingBody = typeof incomingBody === 'string'
        ? JSON.parse(incomingBody)
        : incomingBody;
    } catch {
      fields.incomingBody = incomingBody;
    }
  }
  return fields;
}
```
**确认**：
- ✅ `originalBody` 是客户端发来的原始请求体
- ✅ 完整保存，无任何修改或过滤
- ✅ 尝试解析为 JSON（便于阅读），失败则保存原始字符串

### 3. 转发时机对比

#### 客户端请求捕获（第13329-13330行）
```javascript
const originalBody = await readBody(req, maxBodyBytes);  // ← 客户端原始请求
const incomingHeaderSample = captureIncomingRequestHeaders(config, req.headers);  // ← 客户端原始头
```

#### 转发给上游（第13400+行，在选择上游之后）
```javascript
// 这些发生在 originalBody 捕获之后几百行
const candidate = chooseCandidate(state, tried, {...});  // 选择上游
// ... 协议转换 ...
const requestBody = rewriteModelInBody(...);  // ← 转换后的请求体（发给上游）
const requestHeaders = sanitizeRequestHeaders(...);  // ← 转换后的请求头（发给上游）
```

**时间线**：
```
客户端 → Pool 接收 → 立即捕获原始请求 (originalBody)
                      ↓
                   选择上游
                      ↓
                   协议转换
                      ↓
                   转发给上游 (requestBody - 这是转换后的)
```

### 4. 具体保存位置

#### 位置 1: 内存 (state.recentRequests)
```javascript
function rememberRequest(state, event) {
  state.recentRequests.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    ...event  // ← 包含 incomingHeaders 和 incomingBody
  });
  state.recentRequests.splice(30);
  
  // Write to debug log file if enabled
  if (state.config?.debug?.capture_request_headers === true && 
      state.config?.debug?.request_log_path) {
    writeRequestDebugLog(state.config.debug.request_log_path, {
      id: state.recentRequests[0].id,
      at: state.recentRequests[0].at,
      ...event  // ← 包含 incomingHeaders 和 incomingBody
    });
  }
}
```
**路径**：内存中的 `state.recentRequests` 数组
**容量**：最近 30 条
**内容**：完整的客户端原始请求

#### 位置 2: stats.local.json
```javascript
function writeStatsNow(state, statsPath) {
  if (!statsPath) return;
  try {
    writeFileSync(statsPath, `${JSON.stringify(statsSnapshot(state), null, 2)}\n`);
  } catch (error) {
    console.warn?.(`[stats] failed to persist ${statsPath}: ${error.message}`);
  }
}

function statsSnapshot(state) {
  return {
    updatedAt: new Date().toISOString(),
    recentRequests: state.config?.debug?.capture_request_headers === true
      ? state.recentRequests  // ← 完整信息，包括 incomingHeaders 和 incomingBody
      : stripRequestDebugFields(state.recentRequests),  // ← 移除调试字段
    upstreams: ...
  };
}
```
**路径**：项目根目录的 `stats.local.json`
**格式**：JSON 文件
**内容**：
- 如果 `capture_request_headers: true`：包含完整的 `incomingHeaders` 和 `incomingBody`
- 如果 `capture_request_headers: false`：移除这两个字段

#### 位置 3: requests.debug.log
```javascript
function writeRequestDebugLog(logPath, request) {
  try {
    const logEntry = JSON.stringify(request) + '\n';  // ← 包含完整请求
    writeFileSync(logPath, logEntry, { flag: 'a' });  // 追加模式
  } catch (error) {
    console.warn?.(`[debug] failed to write request log to ${logPath}: ${error.message}`);
  }
}
```
**路径**：`requests.debug.log`（可配置）
**格式**：JSONL（每行一个 JSON 对象）
**内容**：每个请求一行，包含完整的 `incomingHeaders` 和 `incomingBody`

## 实际数据示例

### 客户端发送（真实请求）
```bash
POST /v1/responses HTTP/1.1
Host: 127.0.0.1:8787
Authorization: Bearer sk-pool-token-123
Content-Type: application/json
User-Agent: codex_cli/1.2.3
X-Custom-Header: my-value

{
  "model": "claude-opus-4-8",
  "input": [
    {"type": "text", "text": "Hello from client"}
  ],
  "stream": true
}
```

### 保存的内容（originalBody 和 incomingHeaders）
```json
{
  "id": "1718123456789-a1b2c3d4",
  "at": "2026-06-13T10:30:45.123Z",
  "method": "POST",
  "path": "/v1/responses",
  "entry_protocol": "responses",
  "incomingHeaders": {
    "host": "127.0.0.1:8787",
    "authorization": "Bearer sk-pool-token-123",
    "content-type": "application/json",
    "user-agent": "codex_cli/1.2.3",
    "x-custom-header": "my-value"
  },
  "incomingBody": {
    "model": "claude-opus-4-8",
    "input": [
      {"type": "text", "text": "Hello from client"}
    ],
    "stream": true
  },
  "upstream": "rawchat",
  "status": 200,
  "durationMs": 1234
}
```

### Pool 转发给上游（这个不保存）
```bash
POST /v1/messages HTTP/1.1
Host: api.upstream.com
Authorization: Bearer sk-upstream-key-456  ← 不同的 key
Content-Type: application/json
anthropic-version: 2023-06-01  ← 新增的头

{
  "model": "claude-opus-4-8",
  "max_tokens": 4096,  ← 可能添加的字段
  "messages": [  ← 转换后的格式
    {"role": "user", "content": "Hello from client"}
  ],
  "stream": true
}
```

**关键差异**：
- 客户端请求头有 `Authorization: Bearer sk-pool-token-123`
- 上游请求头有 `Authorization: Bearer sk-upstream-key-456`
- 客户端请求体是 `{"input": [...]}`（Responses 格式）
- 上游请求体是 `{"messages": [...]}`（Messages 格式）

**我们保存的是前者（客户端原始请求），不是后者（转发的请求）**

## 验证方法

### 1. 检查捕获时机
```bash
# 查看代码中 originalBody 的位置
grep -n "const originalBody = await readBody" src/server.mjs

# 输出：
# 12915:      const originalBody = await readBody(req, maxBodyBytes);  ← Messages API
# 13329:      const originalBody = await readBody(req, maxBodyBytes);  ← Responses API
```

这两行在**任何上游选择和协议转换之前**。

### 2. 检查实际保存的数据
```bash
# 启动服务并发送请求
npm start

# 在另一个终端发送测试请求
curl -X POST http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "X-Test-Original-Header: client-value-123" \
  -d '{
    "model": "claude-opus-4-8",
    "input": [{"type": "text", "text": "Test original request"}],
    "stream": false
  }'

# 检查保存的请求头
jq '.incomingHeaders["x-test-original-header"]' requests.debug.log | tail -1
# 输出：client-value-123  ← 客户端发来的原始头

# 检查保存的请求体
jq '.incomingBody.input[0].text' requests.debug.log | tail -1
# 输出：Test original request  ← 客户端发来的原始文本
```

### 3. 对比转发的请求
转发给上游的请求会有不同的：
- Authorization 头（使用上游的 key）
- 可能的协议转换（Responses → Messages/Chat）
- 额外的头（anthropic-version 等）

**我们保存的是转换前的，不是转换后的。**

## 最终确认

### ✅ 确认清单

- [x] **捕获时机**：在收到客户端请求后立即捕获，协议转换之前
- [x] **请求头完整**：所有头都保存，包括 Authorization、Cookie 等敏感头
- [x] **请求体完整**：客户端发来的原始 JSON payload，无修改
- [x] **存储位置明确**：内存、stats.local.json、requests.debug.log
- [x] **无字段删除**：移除了所有过滤逻辑
- [x] **可验证**：提供测试脚本和验证方法

### 📍 具体文件位置

1. **内存**：运行时访问
   - 位置：`state.recentRequests` 数组
   - 访问：`curl http://127.0.0.1:8787/pool/status | jq '.recent_requests'`

2. **持久化**：重启后恢复
   - 位置：`/Users/slizm/myprojects/codex-api-pool/stats.local.json`
   - 查看：`jq '.recentRequests' stats.local.json`

3. **日志文件**：完整历史
   - 位置：`/Users/slizm/myprojects/codex-api-pool/requests.debug.log`
   - 查看：`./scripts/view-request-log.sh`

### 🎯 验证命令

```bash
# 1. 发送测试请求
./test-request-capture.sh

# 2. 查看最后一个请求的完整原始数据
./scripts/extract-request.sh --last

# 3. 确认包含客户端原始头
jq '.incomingHeaders' requests.debug.log | tail -1

# 4. 确认包含客户端原始请求体
jq '.incomingBody' requests.debug.log | tail -1
```

## 总结

**100% 确认**：实现保存的是**客户端发来的真实原始请求**，包括：
- ✅ 所有原始请求头（无过滤）
- ✅ 完整原始请求体（无修改）
- ✅ 在协议转换之前捕获
- ✅ 不是转发给上游的请求

**保存在**：
1. 内存 (`state.recentRequests`)
2. stats.local.json
3. requests.debug.log

现在可以完整查看客户端发来的每一个真实请求！
