# 协议能力检测与覆盖优化

## 优化概述

本次优化实现了基于**协议能力动态发现**的上游分类机制，替代了原有的静态 `api` 字段硬分类。

### 核心改进

1. **探测结果覆盖配置** — 运行时探测到的协议能力优先于配置声明
2. **渐进式协议发现** — 首次根据 `api` 配置探测，失败时自动尝试其他协议
3. **能力持久化** — 探测结果保存到 `stats.local.json`，重启后恢复
4. **中国模型支持** — GLM、Qwen、DeepSeek 等默认使用 OpenAI 协议

---

## 设计决策

### 1. 配置 vs 运行时能力

**旧逻辑**：
```javascript
// api 字段是硬分类，无法表达运行时发现的能力
upstream.api === 'openai'  → 只能处理 GPT 请求
upstream.api === 'anthropic' → 只能处理 Claude 请求
upstream.api === 'both' → 两者都可以
```

**新逻辑**：
```javascript
// api 字段是初始假设，运行时能力可以覆盖
upstream.api === 'openai'  → 初始假设支持 OpenAI 协议
  ↓ 探测后
upstream.capabilities.anthropic_messages.status === 'verified'
  ↓ 结果
可以处理 Claude 请求（因为探测证明支持）
```

### 2. 协议到模型的映射规则

新增 `modelRequiresProtocol(model)` 函数：

```javascript
function modelRequiresProtocol(model) {
  if (isClaudeModel(model)) return 'anthropic_messages';
  // 所有其他模型（GPT、GLM、Qwen、DeepSeek、Yi等）默认 OpenAI 协议
  return 'openai';
}
```

**理由**：几乎所有中国模型商都提供 OpenAI-compatible API，无需单独分类。

### 3. 探测时机

**渐进式发现策略**：

```
1. 根据 api 配置决定首次探测的协议
   - api=openai → 探测 responses/chat_completions
   - api=anthropic → 探测 anthropic_messages
   - api=both → 探测所有协议

2. 如果首选协议失败，自动尝试其他协议作为 fallback

3. 成功后更新 capabilities，下次直接使用已验证的协议
```

### 4. 持久化策略

**只持久化到 `stats.local.json`，不修改 `config.local.json`**

原因：
- `config.local.json` 是用户意图，应保持稳定
- `stats.local.json` 是运行时真相，允许动态变化
- 避免自动改写用户手动编辑的配置

---

## 代码变更

### 核心函数

#### 1. 模型协议映射
```javascript
// src/server.mjs:1215
function modelRequiresProtocol(model) {
  const normalized = String(model || '').trim();
  if (!normalized) return null;
  if (isClaudeModel(normalized)) return 'anthropic_messages';
  return 'openai'; // 默认 OpenAI 协议（包括中国模型）
}
```

#### 2. 上游协议判断（优先级调整）
```javascript
// src/server.mjs:1225
function isAnthropicUpstream(upstream) {
  // 优先级：verified capability > api 配置
  if (upstreamHasVerifiedProtocolCapability(upstream, 'anthropic_messages')) 
    return true;
  return upstream?.api === 'anthropic' || upstream?.api === 'both' || ...;
}

function isOpenAiUpstream(upstream) {
  // 优先级：verified capability > api 配置
  if (upstreamHasVerifiedProtocolCapability(upstream, 'responses') ||
      upstreamHasVerifiedProtocolCapability(upstream, 'chat_completions')) {
    return true;
  }
  return upstream?.api === 'openai' || upstream?.api === 'both' || !upstream?.api;
}
```

#### 3. 模型支持判断
```javascript
// src/server.mjs:4964
function upstreamSupportsModel(upstream, model) {
  if (!model) return true;

  // 基于协议能力判断，而非 api 字段
  const requiredProtocol = modelRequiresProtocol(model);
  if (requiredProtocol === 'anthropic_messages') {
    if (!isAnthropicUpstream(upstream)) return false;
  } else if (requiredProtocol === 'openai') {
    if (!isOpenAiUpstream(upstream)) return false;
  }

  // 检查 Codex OAuth 兼容性
  if (upstream.codexOAuth && !isCodexOAuthModel(model)) return false;

  // 检查已发现的模型列表
  const models = upstream.health?.models || [];
  return models.length === 0 || models.includes(model);
}
```

#### 4. 协议初始化（不再禁用未配置的协议）
```javascript
// src/server.mjs:1636
if (api === 'anthropic') {
  capabilities.anthropic_messages = {
    ...emptyProtocolCapability('assumed', 'configured api=anthropic'),
    source: 'config'
  };
} else if (api === 'openai') {
  capabilities.responses = {
    ...emptyProtocolCapability('assumed', 'configured api=openai'),
    source: 'config'
  };
  capabilities.chat_completions = {
    ...emptyProtocolCapability('assumed', 'configured api=openai'),
    source: 'config'
  };
} else if (api === 'both') {
  // 所有协议都假设支持
  capabilities.responses = { ...emptyProtocolCapability('assumed', 'configured api=both'), source: 'config' };
  capabilities.chat_completions = { ...emptyProtocolCapability('assumed', 'configured api=both'), source: 'config' };
  capabilities.anthropic_messages = { ...emptyProtocolCapability('assumed', 'configured api=both'), source: 'config' };
}
```

#### 5. 渐进式探测逻辑
```javascript
// src/server.mjs:8567
// 根据 api 配置和模型需求决定探测策略
const api = normalizeUpstreamApi(upstream?.api, upstream?.probe_auth);
const modelProtocol = modelRequiresProtocol(probeModel);
const shouldProbeOpenAi = api === 'openai' || api === 'both' || !api;
const shouldProbeAnthropic = api === 'anthropic' || api === 'both';

// 优先探测模型所需协议
if (modelProtocol === 'anthropic_messages' && shouldProbeAnthropic) {
  // 探测 Anthropic Messages
} else if (modelProtocol === 'openai' && shouldProbeOpenAi) {
  // 探测 Responses → Chat Completions
}

// 如果主协议失败，尝试备用协议
if (stateName !== 'ok' && shouldProbeAnthropic && modelProtocol !== 'anthropic_messages') {
  // 尝试 Anthropic 作为 fallback
}
```

---

## 配置兼容性

### 现有配置无需修改

```json
{
  "upstreams": [
    { "name": "site1", "api": "openai", "base_url": "...", "keys": [...] },
    { "name": "site2", "api": "anthropic", "base_url": "...", "keys": [...] },
    { "name": "site3", "api": "both", "base_url": "...", "keys": [...] }
  ]
}
```

系统行为：
- `api=openai` → 首次探测 OpenAI 协议，如果实际支持 Anthropic 会自动发现
- `api=anthropic` → 首次探测 Anthropic 协议
- `api=both` → 首次探测所有协议

### 新增中国模型示例

```json
{
  "name": "zhipu_glm",
  "api": "openai",
  "base_url": "https://open.bigmodel.cn/api/paas/v4",
  "keys": [{ "env": "ZHIPU_API_KEY" }]
}
```

GLM-4 请求会自动路由到此上游（因为 `modelRequiresProtocol('glm-4')` 返回 `'openai'`）。

---

## Dashboard 展示变更

### `/pool/status` 响应

`upstreams[].capabilities` 现在包含完整的探测状态：

```json
{
  "capabilities": {
    "responses": {
      "status": "verified",
      "source": "probe",
      "checked_at": "2026-06-13T10:30:00.000Z",
      "model": "gpt-4",
      "http_status": 200,
      "reason": ""
    },
    "chat_completions": {
      "status": "verified",
      "source": "real_traffic",
      "checked_at": "2026-06-13T10:35:00.000Z",
      "model": "gpt-4",
      "http_status": 200,
      "reason": ""
    },
    "anthropic_messages": {
      "status": "verified",
      "source": "probe",
      "checked_at": "2026-06-13T10:40:00.000Z",
      "model": "claude-opus-4-8",
      "http_status": 200,
      "reason": ""
    }
  }
}
```

**status 取值**：
- `verified` — 探测成功确认支持
- `assumed` — 基于配置假设支持（未探测）
- `failed` — 探测确认不支持
- `unknown` — 未探测或探测结果不确定

### Management Dashboard

协议能力展示优先级：`verified` > `assumed` > 其他

---

## 测试覆盖

新增测试文件：`test/protocol-capability-test.mjs`

**测试场景**：

1. ✅ `api=openai` 上游正确探测并验证 OpenAI 协议
2. ✅ `api=both` 上游发现所有支持的协议
3. ✅ 协议能力跨重启持久化（通过 `stats.local.json`）
4. ✅ 中国模型（GLM-4）使用 OpenAI 协议

运行测试：
```bash
node test/protocol-capability-test.mjs
```

原有 smoke 测试全部通过，确保向后兼容。

---

## 术语更新

已更新 `CONTEXT.md` 术语：

### 新增术语

**API Type Declaration**:
用户配置的 `api` 字段，声明上游的预期协议族。作为初始假设，但不限制运行时协议选择。

### 修订术语

**Protocol Capability**:
运行时探测到的协议支持证据，包含状态（`verified` / `assumed` / `failed` / `unknown`）。**优先于 API Type Declaration**。

**Upstream**:
删除了"protocol capability (OpenAI-compatible, Anthropic Messages, or both)"的硬分类描述，改为"Protocol Capability evidence"。

---

## 迁移指南

### 对于已有部署

**无需任何修改**，系统会：

1. 从 `config.local.json` 读取 `api` 字段作为初始假设
2. 从 `stats.local.json` 恢复已验证的协议能力
3. 下次健康探测时，逐步验证或发现新能力

### 对于新增上游

**推荐配置**：

```json
{
  "name": "new-site",
  "api": "openai",  // 或 "anthropic" 或 "both"
  "base_url": "https://example.com/v1",
  "keys": [{ "env": "NEW_SITE_KEY" }]
}
```

首次健康探测后，系统会自动：
- 验证声明的协议
- 发现实际支持的协议（如果配置不准确）
- 将结果持久化到 `stats.local.json`

### 对于中国模型

所有 OpenAI-compatible 的中国模型（GLM、Qwen、DeepSeek、Yi 等）都使用 `api: "openai"`：

```json
{
  "name": "zhipu",
  "api": "openai",
  "base_url": "https://open.bigmodel.cn/api/paas/v4",
  "keys": [{ "env": "ZHIPU_API_KEY" }]
}
```

---

## 后续优化方向（未实施）

以下功能已设计但未包含在本次实施中：

1. **手动标记协议能力** — Management API 新增接口允许用户手动设置协议能力
2. **协议能力变更通知** — 当探测结果与配置不一致时，发送日志或通知
3. **协议转换失败的降级策略** — 更智能的 fallback 逻辑

---

## 相关文件

- `src/server.mjs` — 核心逻辑实现
- `CONTEXT.md` — 术语定义
- `test/protocol-capability-test.mjs` — 新增测试
- `test/smoke-test.mjs` — 已有测试（全部通过）
- `README.md` — 用户文档（无需修改，配置示例已兼容）
