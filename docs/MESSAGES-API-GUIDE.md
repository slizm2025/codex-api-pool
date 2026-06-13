# Messages API 配置指南

## 概述

API Pool 现在支持 Anthropic Messages API，可以让 Claude Desktop 通过本地 Pool 复用多上游配置。

## 快速开始

### 1. 基本配置（仅 Anthropic 上游）

```yaml
server:
  host: 127.0.0.1
  port: 8787
  auth_token_env: POOL_TOKEN

upstreams:
  - name: anthropic-main
    base_url: https://api.anthropic.com
    api: anthropic
    keys:
      - env: ANTHROPIC_KEY
```

### 2. 混合上游配置（推荐）

```yaml
server:
  host: 127.0.0.1
  port: 8787
  auth_token_env: POOL_TOKEN

compatibility:
  adapter_mode:
    strip_messages_only_features: true
    adapters:
      chat_completions: true

upstreams:
  - name: anthropic-main
    base_url: https://api.anthropic.com
    api: anthropic
    keys:
      - env: ANTHROPIC_KEY
  
  - name: openai-fallback
    base_url: https://api.openai.com
    api: openai
    keys:
      - env: OPENAI_KEY
```

## 配置说明

### `api` 字段

- `anthropic`: 支持 Messages API
- `openai`: 支持 Chat Completions API
- `both`: 同时支持两种格式（如 one-api）

### `compatibility.adapter_mode`

#### `strip_messages_only_features`
- 启用后剥离 Anthropic 专有特性：
  - `thinking` 内容块
  - Computer Use 工具（`computer_20241022`, `bash_20241022`, `text_editor_20241022`）
- **推荐**: 当有 OpenAI 上游时启用

#### `adapters.chat_completions`
- 启用 Messages → Chat Completions 转换
- 当没有 Anthropic 上游时自动使用
- **推荐**: 当有 OpenAI 上游时启用

## 路由逻辑

### 原生转发（优先）
当存在 Anthropic 上游时：
```
Claude Desktop → Pool /v1/messages → Anthropic /v1/messages
```

### 适配器回退
当只有 OpenAI 上游且启用适配器时：
```
Claude Desktop → Pool /v1/messages → [转换] → OpenAI /v1/chat/completions → [转换] → Messages 响应
```

### 特性阻止
当有 Messages-only 特性但无法处理时：
```
Claude Desktop → Pool /v1/messages → 422 错误（列出不兼容特性）
```

## Claude Desktop 配置

### macOS/Linux
编辑 `~/.config/claude/config.json`:
```json
{
  "api": {
    "baseUrl": "http://127.0.0.1:8787/v1"
  }
}
```

### 环境变量
```bash
export ANTHROPIC_API_KEY="your-pool-token"
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787/v1"
```

## 可观测性

### Dashboard 查看

访问 `http://127.0.0.1:8787/pool/dashboard` 查看：

- **Recent Requests**: 显示 `entry_protocol` 列
  - `messages`: 来自 Claude Desktop
  - `responses`: 来自 Codex Desktop
  
- **Routing Strategy**: 显示路由决策
  - `native_messages`: 原生转发
  - `messages_to_chat_completions`: 适配器转换

### API 查询

```bash
curl http://127.0.0.1:8787/pool/status | jq '.recent_requests[] | {
  path, 
  entry_protocol, 
  routing_strategy, 
  status
}'
```

## 特性兼容性

### Anthropic 专有特性（Messages-only）

| 特性 | 原生转发 | Chat 适配器 | 行为 |
|-----|---------|------------|------|
| `cache_control` | ✅ | ❌ | 剥离或 422 |
| `thinking` 块 | ✅ | ❌ | 剥离或 422 |
| Computer Use 工具 | ✅ | ❌ | 剥离或 422 |
| 标准 `tools` | ✅ | ✅ | 完整支持 |
| `system` 消息 | ✅ | ✅ | 完整支持 |
| 流式响应 | ✅ | ✅ | 完整支持 |

### 启用剥离 vs 阻止

#### 剥离模式（推荐）
```yaml
compatibility:
  adapter_mode:
    strip_messages_only_features: true
```
- 自动移除不兼容特性
- 请求继续处理
- 适合生产环境

#### 阻止模式（默认）
```yaml
compatibility:
  adapter_mode:
    strip_messages_only_features: false
```
- 返回 422 错误
- 明确告知用户特性不兼容
- 适合开发调试

## 故障排查

### 422 错误：特性不兼容

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Request contains Messages-only features that cannot be converted to available upstreams: thinking, bash_20241022. Enable adapter compatibility mode to strip these features."
  }
}
```

**解决方案**:
1. 启用 `strip_messages_only_features: true`
2. 添加 Anthropic 上游
3. 避免使用专有特性

### 503 错误：无可用上游

```json
{
  "type": "error",
  "error": {
    "type": "overloaded_error",
    "message": "no available upstreams for Messages API"
  }
}
```

**解决方案**:
1. 检查上游是否启用 (`enabled: true`)
2. 检查 API key 是否有效
3. 启用适配器模式（如有 OpenAI 上游）

### Content-Length 截断

如果看到请求体被截断（不完整的 JSON），确保使用最新版本。这是一个已修复的 bug。

## 性能说明

- **原生转发**: 零额外开销（直接代理）
- **适配器转换**: <1ms 转换时间（可忽略）
- **流式响应**: 增量转换，无缓冲延迟

## 测试验证

```bash
# 测试 Messages 端点
curl -X POST http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer $POOL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-8",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'

# 验证路由策略
curl http://127.0.0.1:8787/pool/status | \
  jq '.recent_requests[0] | {entry_protocol, routing_strategy, status}'
```

## 更多信息

- [ADR-0004](./adr/0004-claude-desktop-messages-api-support.md): 架构决策
- [实施分析](./ADR-0004-IMPLEMENTATION-ANALYSIS.md): 详细实施状态
- [完成报告](./ADR-0004-IMPLEMENTATION-COMPLETE.md): 测试和质量指标
- [CHANGELOG](../CHANGELOG.md): 变更历史
