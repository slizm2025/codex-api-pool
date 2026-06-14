# 协议能力检测机制优化文档

## 优化日期
2026-06-13

## 优化目标
确保探测明确失败（HTTP 404/405/501）时能够覆盖用户声明，并实现自动恢复检测机制。

---

## 🎯 核心问题

### 优化前的问题

**问题 1：用户声明 vs 实际能力不符**
```json
{
  "name": "broken_upstream",
  "api": "openai",  // 用户声明支持 OpenAI
  "capabilities": {
    "responses": { "status": "assumed", "source": "user_declared" }
  }
}
```

当上游实际返回 HTTP 404（端点不存在）时：
- ❌ 探测失败不会覆盖用户声明
- ❌ 请求仍然会被路由到该上游
- ❌ 只有真实流量失败后才会进入冷却

**问题 2：无自动恢复机制**
- 上游临时不支持某协议（如维护期间禁用 /v1/responses）
- 被标记为 `unsupported` 后永久排除
- 恢复后无法自动检测并重新启用

---

## ✅ 优化方案

### 1. 明确失败检测与覆盖

#### 核心逻辑
```javascript
// src/server.mjs:7029+
function recordProtocolCapabilityProbe(upstream, protocol, result, classified, options) {
  const statusCode = Number(result?.statusCode || 0);
  
  // ✅ 明确失败检测：404/405/501 表示端点明确不支持
  const isClearEndpointUnsupported = NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS.has(statusCode);
  
  // ✅ 保护机制 1: 用户声明优先（除非明确失败）
  if (state !== 'ok' && !isClearEndpointUnsupported && userDeclared) {
    // 保留用户声明，但记录探测失败信息
    upstream.capabilities[protocol] = {
      ...existing,
      checked_at: checkedAt,
      http_status: statusCode,
      probe_failure_reason: reason,
      probe_failure_at: checkedAt
    };
    return;
  }
  
  // ✅ 保护机制 2: 真实流量验证优先（除非明确失败）
  if (state !== 'ok' && !isClearEndpointUnsupported && realTrafficVerified) {
    // 保留真实流量证据，但记录探测失败
    return;
  }
  
  // ✅ 明确失败时：覆盖用户声明和探测结果
  upstream.capabilities[protocol] = {
    status: 'unsupported',  // 或 'failed'
    source: 'probe',
    endpoint_unsupported: isClearEndpointUnsupported,  // ⚠️ 标记为可重检
    last_probe_state: state,
    checked_at: checkedAt,
    http_status: statusCode,
    reason: protocolCapabilityReason(classified, result, protocol)
  };
}
```

#### 状态码分类
```javascript
const NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS = new Set([404, 405, 501]);

404 Not Found       → 端点不存在，明确不支持
405 Method Not Allowed → 方法不允许，明确不支持
501 Not Implemented → 未实现，明确不支持
```

---

### 2. 自动恢复检测机制

#### shouldRecheckProtocolCapability 函数
```javascript
// src/server.mjs:1698+
function shouldRecheckProtocolCapability(upstream, protocol) {
  const capability = normalizeProtocolCapabilities(upstream?.capabilities)[protocol];
  if (!capability) return false;

  // ✅ 如果是明确的端点不支持或探测失败，应该定期重检
  if (capability.endpoint_unsupported === true || 
      capability.status === 'unsupported' || 
      capability.status === 'failed') {
    const lastCheckedAt = timestampMs(capability.checked_at);
    const at = now();
    
    // ⏰ 每 30 分钟重检一次端点是否恢复
    const recheckIntervalMs = 30 * 60 * 1000;
    return at - lastCheckedAt >= recheckIntervalMs;
  }

  return false;
}
```

#### 健康探测集成
```javascript
// src/server.mjs:8431+
async function probeOneUpstream(state, upstream, config, options) {
  // ...
  
  if (isOpenAi) {
    const shouldRecheckResponses = shouldRecheckProtocolCapability(upstream, 'responses');
    const shouldRecheckChat = shouldRecheckProtocolCapability(upstream, 'chat_completions');

    // ✅ 如果到了重检时间，即使之前标记为 unsupported 也会重新探测
    if (shouldRecheckResponses || upstream.capabilities?.responses?.status !== 'unsupported') {
      const responsesResult = await probeResponsesUpstream(upstream, key, config, probeModel);
      const responsesClassification = classifyModelProbe(responsesResult, 'responses');
      recordProtocolCapabilityProbe(upstream, 'responses', responsesResult, responsesClassification, ...);
      
      if (responsesClassification.state === 'ok') {
        // ✅ 端点恢复！自动更新为 verified
        stateName = 'ok';
        resolvedMode = 'responses';
      }
    }
  }
  
  // ...
}
```

---

## 📊 优化效果

### 场景 1：明确失败覆盖用户声明

#### 初始状态
```json
{
  "name": "upstream_a",
  "api": "openai",
  "capabilities": {
    "responses": { 
      "status": "assumed", 
      "source": "user_declared",
      "reason": "user declared protocol support"
    }
  }
}
```

#### 探测返回 404
```http
POST https://upstream_a.com/v1/responses
→ HTTP 404 Not Found
```

#### ✅ 优化后结果
```json
{
  "capabilities": {
    "responses": { 
      "status": "unsupported",           // ✅ 覆盖用户声明
      "source": "probe",
      "endpoint_unsupported": true,       // ✅ 标记为端点不支持
      "checked_at": "2026-06-13T10:30:00Z",
      "http_status": 404,
      "reason": "responses probe returned HTTP 404"
    }
  }
}
```

---

### 场景 2：自动恢复检测

#### T0 - 上游维护期间
```json
{
  "capabilities": {
    "responses": { 
      "status": "unsupported",
      "endpoint_unsupported": true,
      "checked_at": "2026-06-13T10:00:00Z"
    }
  }
}
```

请求不会路由到该上游的 /v1/responses。

#### T30min - 健康探测重检
```javascript
// 30 分钟后自动触发重检
shouldRecheckProtocolCapability(upstream, 'responses') === true

// 探测：
POST https://upstream_a.com/v1/responses
→ HTTP 200 OK (端点已恢复)
```

#### ✅ 自动恢复
```json
{
  "capabilities": {
    "responses": { 
      "status": "verified",              // ✅ 自动恢复为 verified
      "source": "probe",
      "endpoint_unsupported": false,      // ✅ 清除不支持标记
      "checked_at": "2026-06-13T10:30:00Z",
      "http_status": 200,
      "reason": ""
    }
  }
}
```

后续请求可以正常路由到该上游的 /v1/responses。

---

### 场景 3：保护真实流量证据

#### 初始状态（真实流量已验证）
```json
{
  "capabilities": {
    "responses": { 
      "status": "verified",
      "source": "real_traffic",
      "representative": true,
      "model": "gpt-5.5"
    }
  }
}
```

#### 健康探测返回 404（临时故障）
```http
POST https://upstream_a.com/v1/responses
→ HTTP 404 Not Found
```

#### ✅ 保护机制生效
```json
{
  "capabilities": {
    "responses": { 
      "status": "verified",                   // ✅ 保持 verified
      "source": "real_traffic",               // ✅ 保持真实流量来源
      "representative": true,
      "model": "gpt-5.5",
      "probe_failure_reason": "responses probe returned HTTP 404",  // 记录探测失败
      "probe_failure_at": "2026-06-13T10:30:00Z"
    }
  }
}
```

**原因：** 真实流量成功是最强证据，探测失败可能是临时网络问题。

**注意：** 如果探测明确返回 404/405/501，仍然会覆盖真实流量证据（端点不存在是确定性的）。

---

## 🔄 完整流程图

```text
┌─────────────────────────────────────────────────────────────────┐
│                    健康探测触发                                    │
│  - 启动时探测                                                      │
│  - 定时探测（每 60s）                                              │
│  - 手动触发（Dashboard）                                          │
│  - 添加上游时                                                      │
└─────────────────┬───────────────────────────────────────────────┘
                  ↓
      ┌───────────────────────┐
      │  检查是否需要重检      │
      │  shouldRecheckProtocol│
      │  Capability()         │
      └───────┬───────────────┘
              ↓
      ╔═══════════════════════════╗
      ║ 是否到达重检时间？          ║
      ║ - unsupported 30min 后    ║
      ║ - failed 30min 后         ║
      ║ - endpoint_unsupported    ║
      ╚═══════┬═══════════════════╝
              ↓ Yes
   ┌──────────────────────────┐
   │  发送探测请求             │
   │  probe{Protocol}Upstream()│
   └──────────┬───────────────┘
              ↓
   ┌──────────────────────────┐
   │  分类探测结果             │
   │  classifyModelProbe()    │
   └──────────┬───────────────┘
              ↓
   ╔═══════════════════════════╗
   ║  HTTP 状态码判断           ║
   ╚═══════┬═══════════════════╝
           ├─ 200 → state='ok'
           ├─ 401/403 → state='auth_error'
           ├─ 404/405/501 → state='models_unsupported'
           ├─ 429 → state='rate_limited'
           └─ 5xx → state='server_error'
              ↓
   ┌──────────────────────────┐
   │  记录协议能力             │
   │  recordProtocolCapability│
   │  Probe()                 │
   └──────────┬───────────────┘
              ↓
   ╔═══════════════════════════╗
   ║  是否明确端点不支持？      ║
   ║  404/405/501?            ║
   ╚═══════┬═══════════════════╝
           │
           ├─ Yes → ✅ 覆盖所有现有状态
           │         status='unsupported'
           │         endpoint_unsupported=true
           │
           ├─ No + 用户声明 → ✅ 保留用户声明
           │                   记录探测失败
           │
           └─ No + 真实流量 → ✅ 保留真实流量证据
                               记录探测失败
              ↓
   ┌──────────────────────────┐
   │  更新 capabilities        │
   │  upstream.capabilities    │
   │  [protocol] = {...}       │
   └──────────┬───────────────┘
              ↓
   ┌──────────────────────────┐
   │  持久化到 stats.local.json│
   └──────────────────────────┘
```

---

## 📝 配置示例

### 用户声明 + 自动验证
```json
{
  "upstreams": [
    {
      "name": "my_upstream",
      "api": "openai",  // 用户声明支持 OpenAI
      "base_url": "https://api.example.com/v1",
      "keys": [{"env": "MY_API_KEY"}]
    }
  ]
}
```

**运行时演变：**
1. **启动时：** `capabilities.responses.status = "assumed"`
2. **首次探测成功：** `status = "verified", source = "probe"`
3. **真实流量成功：** `source = "real_traffic"` (最强证据)
4. **探测返回 404：** `status = "unsupported", endpoint_unsupported = true`
5. **30分钟后重检成功：** `status = "verified"` (自动恢复)

---

## 🧪 测试验证

### 烟测通过
```bash
npm run smoke
```

**输出：**
```
smoke ok: auth guard, fallback, upstream enable toggle, token usage accounting, 
chat completions fallback, availability scoring, automatic probe recovery, 
billing accounting, billing main-path isolation, billing huge-limit guard, 
billing blocked detection, runtime add, config-preserving edit, JSON import, 
Codex OAuth import/forwarding, Codex curl debugger, model discovery, 
anthropic model probe, model override, stream-error cooldown, 400/522 site fallback, 
recent requests, and immediate health probe all passed
```

**关键测试覆盖：**
- ✅ automatic probe recovery (自动探测恢复)
- ✅ chat completions fallback (协议降级)
- ✅ model discovery (模型发现)
- ✅ anthropic model probe (Anthropic 探测)

---

## 🔧 配置参数

### 重检间隔
```javascript
// src/server.mjs:1706
const recheckIntervalMs = 30 * 60 * 1000;  // 30 分钟
```

**可调整为：**
- 测试环境：5 分钟 (`5 * 60 * 1000`)
- 生产环境：30 分钟（默认）
- 频繁变化上游：10 分钟

### 明确失败状态码
```javascript
const NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS = new Set([404, 405, 501]);
```

**可扩展为：**
```javascript
const NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS = new Set([
  404,  // Not Found
  405,  // Method Not Allowed
  501,  // Not Implemented
  410   // Gone (永久移除)
]);
```

---

## 📌 注意事项

### 1. 用户声明仍然有意义
优化后，用户声明的作用：
- **快速启动**：初始状态为 `assumed`，无需等待探测
- **指导探测**：决定探测哪些协议
- **临时覆盖**：非明确失败时仍然保护用户声明

### 2. 真实流量优先级最高
```text
证据强度：真实流量 > 明确失败（404/405/501） > 用户声明 > 探测失败
```

只有明确的端点不存在才会覆盖真实流量证据。

### 3. 重检间隔平衡
- **太短**：频繁探测浪费资源
- **太长**：恢复检测延迟高
- **建议**：30 分钟（与 Native Responses Recheck 一致）

### 4. Dashboard 可见性
优化后的字段在 Dashboard 中可见：
- `endpoint_unsupported`: 是否明确不支持
- `probe_failure_reason`: 探测失败原因
- `probe_failure_at`: 探测失败时间
- `last_probe_state`: 最后探测状态

---

## 🎯 优化总结

### ✅ 已解决
1. **明确失败覆盖用户声明** - 404/405/501 强制更新状态
2. **自动恢复检测** - 30 分钟重检机制
3. **保护真实流量证据** - 非明确失败时保留
4. **探测失败记录** - 透明记录所有失败信息

### 🚀 优势
- **自适应** - 自动适应上游能力变化
- **容错** - 区分明确失败和临时故障
- **高效** - 避免无意义的探测
- **透明** - 完整的诊断信息

### 📈 影响
- **减少误判** - 明确识别端点不支持
- **提高可用性** - 自动恢复已修复的上游
- **降低维护** - 无需手动干预恢复

---

## 📚 相关文件

- `src/server.mjs` (核心实现)
  - `recordProtocolCapabilityProbe()` - 协议能力记录
  - `shouldRecheckProtocolCapability()` - 重检判断
  - `probeOneUpstream()` - 健康探测主流程
- `test/smoke-test.mjs` - 烟测验证
- `CONTEXT.md` - 领域词汇
- `CLAUDE.md` - 项目指南

---

## 🔗 相关机制

- **Native Responses Recheck** - 降级后的原生路由重试（30 分钟）
- **Cooldown** - 失败后的临时排除（30 秒 ~ 60 秒）
- **Availability** - 滚动窗口成功率（50 次，最少 10 样本）
- **Health Probe** - 定时健康检查（60 秒）

协议能力检测与这些机制协同工作，形成完整的上游健康管理体系。
