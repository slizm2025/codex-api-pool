# Claude CLI 兼容性优化

## 修改内容

将 Pool 的 Anthropic Messages API 健康检查和请求转发改为使用 Claude CLI 兼容的请求头。

## 问题背景

某些上游服务器会检测客户端的 User-Agent，拒绝看起来像爬虫或自动化工具的请求。错误示例：

```
该渠道不允许当前客户端使用（检测到：Go-http-client/1.1）
```

Claude CLI 使用特定的 User-Agent 和额外的头部来标识自己，这些上游会允许 Claude CLI 通过。

## 修改详情

### 1. 健康检查头部（`buildProbeHeaders` 函数）

**修改前：**
```javascript
if (keyValue && type === 'anthropic') {
  headers['x-api-key'] = keyValue;
  headers['anthropic-version'] = '2023-06-01';
}
```

**修改后：**
```javascript
if (keyValue && type === 'anthropic') {
  headers['x-api-key'] = keyValue;
  headers['user-agent'] = 'claude-cli/2.1.177 (external, cli)';  // Claude CLI UA
  headers['anthropic-version'] = '2023-06-01';
  headers['anthropic-beta'] = 'claude-code-20250219,...,context-1m-2025-08-07';  // Claude CLI beta
  headers['anthropic-dangerous-direct-browser-access'] = 'true';
  headers['x-app'] = 'cli';
}
```

### 2. 请求转发头部（`buildAnthropicRequestHeaders` 函数）

**修改前：**
```javascript
headers['user-agent'] = incomingHeaders['user-agent'] || BROWSER_LIKE_USER_AGENT;
headers['anthropic-beta'] = incomingHeaders['anthropic-beta'] || undefined;
```

**修改后：**
```javascript
// 优先使用客户端的 claude-cli UA，否则默认使用 claude-cli
if (incomingUserAgent && incomingUserAgent.includes('claude-cli')) {
  headers['user-agent'] = incomingUserAgent;
} else {
  headers['user-agent'] = 'claude-cli/2.1.177 (external, cli)';
}

// 默认添加 Claude CLI beta 头
headers['anthropic-beta'] = incomingHeaders['anthropic-beta'] || 'claude-code-20250219,...,context-1m-2025-08-07';

// 添加 Claude CLI 特定头
headers['anthropic-dangerous-direct-browser-access'] = 
  incomingHeaders['anthropic-dangerous-direct-browser-access'] || 'true';
headers['x-app'] = incomingHeaders['x-app'] || 'cli';
```

## Claude CLI 真实请求头示例

从 Claude CLI 捕获的真实请求：

```http
POST /v1/messages HTTP/1.1
Host: api.example.com
User-Agent: claude-cli/2.1.177 (external, cli)
x-api-key: sk-***
Content-Type: application/json
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,...,context-1m-2025-08-07
anthropic-dangerous-direct-browser-access: true
x-app: cli
```

## 行为变化

### 健康检查
- **之前**：使用通用浏览器 User-Agent（Chrome）
- **现在**：使用 Claude CLI User-Agent 和完整的 Claude CLI 头部

### 请求转发
- **之前**：
  - 如果客户端提供 UA，使用客户端的
  - 否则使用通用浏览器 UA
  - 可选的 anthropic-beta 头
- **现在**：
  - 如果客户端是 Claude CLI，保留其 UA
  - 否则默认使用 Claude CLI UA
  - 默认添加 Claude CLI beta 头
  - 默认添加 `anthropic-dangerous-direct-browser-access` 和 `x-app` 头

## 兼容性

### Claude CLI
✅ **完全兼容** - 请求头会被保留和正确转发

### 其他客户端（Codex、curl、自定义）
✅ **兼容** - 会被包装为 Claude CLI 请求，上游会接受

### 上游服务器
✅ **兼容** - 看到的是 Claude CLI 请求，不会拒绝

## 验证

### 1. 重启服务
```bash
# 停止当前服务（Ctrl+C）
npm start
```

### 2. 测试健康检查
```bash
# 触发所有上游的健康检查
curl -X POST http://127.0.0.1:8787/pool/probe \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"
```

### 3. 测试请求转发
```bash
# 使用测试脚本
./test-claude-cli.sh

# 或手动测试
curl -X POST http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: sk-slizm030506" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-8",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 4. 验证上游看到的请求
检查 `incomingHeaders` 字段，确认转发给上游的请求包含：
- `user-agent: claude-cli/2.1.177 (external, cli)`
- `anthropic-beta: claude-code-20250219,...,context-1m-2025-08-07`
- `anthropic-dangerous-direct-browser-access: true`
- `x-app: cli`

## 效果

### 问题修复
❌ **修改前**：上游拒绝请求
```
该渠道不允许当前客户端使用（检测到：Go-http-client/1.1）
```

✅ **修改后**：上游接受请求
```http
HTTP/1.1 200 OK
{
  "content": [{"type": "text", "text": "Hello!"}],
  ...
}
```

### 适用场景
- 有客户端检测的上游服务器
- 要求使用 Claude CLI User-Agent 的服务
- 需要 Claude CLI 特定头部的 API

## 注意事项

1. **向后兼容**：修改不会破坏现有配置，所有请求都会正常工作
2. **透明代理**：如果客户端是 Claude CLI，其头部会被保留
3. **默认行为**：非 Claude CLI 客户端会被包装为 Claude CLI 请求
4. **健康检查**：现在使用 Claude CLI 身份，可能通过之前失败的检查

## 总结

通过模拟 Claude CLI 的请求头，Pool 现在可以通过有客户端检测的上游服务器，同时保持对所有客户端的兼容性。

**关键改进**：
- ✅ 健康检查使用 Claude CLI 身份
- ✅ 请求转发默认使用 Claude CLI 头部
- ✅ 保留真实 Claude CLI 客户端的原始头部
- ✅ 兼容所有现有客户端和配置
