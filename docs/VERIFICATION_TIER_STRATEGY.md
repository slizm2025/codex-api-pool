# 上游验证分层策略文档

## 概述

Codex API Pool 使用 4 层验证等级来展示上游的可用性和验证状态。本文档详细说明分层逻辑、触发条件和实现细节。

---

## 分层等级

### 1. 真实请求验证 (real_verified)

**定义**: 上游已通过真实流量验证，有新鲜的代表性证据。

**触发条件**:
- `upstream.available = true` (上游可用)
- `upstream.representative_availability.verified = true` (有新鲜证据)

**证据来源**:
- 实际请求成功完成并生成响应
- 证据记录在 `key.representativeEvidence[protocol][model]`
- 新鲜度窗口: 30 分钟内的证据

**示例场景**:
- 用户设置 model override 为 `gpt-5.5`
- 向 GPT 上游发送请求成功
- GPT 上游出现在"真实请求验证"层级

---

### 2. 一层检测通过 (probe_only)

**定义**: 上游通过了健康检测，但尚未有真实流量验证证据。

**触发条件**:
- `upstream.available = true`
- `upstream.representative_availability.verified = false`
- `upstream.health.state = 'ok'`

**证据来源**:
- Health Probe 成功返回 200 OK
- 模型列表成功获取
- 未有实际请求验证（或证据已过期）

**示例场景**:
- 新添加的上游
- 运行 Health Probe 成功
- 但用户尚未通过此上游发送请求

---

### 3. 可选待真实验证 (real_pending)

**定义**: 上游可用但健康状态不明确，等待真实请求验证。

**触发条件**:
- `upstream.available = true`
- `upstream.representative_availability.verified = false`
- `upstream.health.state != 'ok'` (例如: `unknown`, `inconclusive`, `missing_model_override`)

**证据来源**:
- 上游基本配置正常（enabled, has keys, not in cooldown）
- Health Probe 未运行或状态不明确
- 允许参与选择但优先级低

**示例场景**:
- 刚启动的池，Health Probe 尚未运行
- Model override 变化后健康状态变为 `stale_model_override`
- Anthropic 上游状态为 `inconclusive`

---

### 4. 不可用 (unavailable)

**定义**: 上游当前无法参与选择。

**触发条件**:
- `upstream.available = false`

**不可用原因** (任一条件):
- `upstream.enabled = false` (用户禁用)
- `upstream.quarantined = true` (隔离状态)
- `upstream.baseUrl` 为空
- `healthAllowsSelection() = false` (健康状态阻止选择，如 `auth_error`, `rate_limited`)
- `cooldownUntil > now()` (冷却期)
- 没有可用的 upstream key

**示例场景**:
- 上游被禁用
- 上游因认证失败进入冷却期
- 配置缺少必要参数

---

## 代表性可用性 (Representative Availability)

### 什么是代表性证据？

代表性证据记录了特定 **协议** + **模型** 组合的真实请求成功记录。

**结构**:
```javascript
key.representativeEvidence = {
  responses: {
    'claude-opus-4-8': {
      checked_at: '2026-06-14T03:00:00.000Z',
      source: 'real_traffic'
    },
    'gpt-5.5': {
      checked_at: '2026-06-14T02:55:00.000Z',
      source: 'real_traffic'
    }
  },
  chat_completions: { ... },
  anthropic_messages: { ... }
}
```

### 聚合模式 vs. 特定模型模式

#### 特定模型模式 (Model Override 已设置)

**触发**: `state.modelOverride` 有值，例如 `'gpt-5.5'`

**行为**:
- 只收集该特定模型的证据
- `representativeAvailability.verified` 只看该模型是否有新鲜证据
- Claude 上游没有 `gpt-5.5` 证据 → `verified = false`

**示例**:
```javascript
// Model Override: gpt-5.5
representativeAvailability(claudeUpstream, { model: 'gpt-5.5' })
// => { verified: false, evidence_count: 0 }

representativeAvailability(gptUpstream, { model: 'gpt-5.5' })
// => { verified: true, evidence_count: 1 }
```

#### 聚合模式 (无 Model Override - "筛选所有模型")

**触发**: `state.modelOverride` 为空字符串

**行为**:
- 收集 **所有模型** 的证据
- 只要有任何模型的新鲜证据，`verified = true`
- `representativeAvailability.aggregated = true`

**示例**:
```javascript
// Model Override: (空)
representativeAvailability(claudeUpstream, { model: '' })
// => { verified: true, aggregated: true, evidence_count: 2 }
// 聚合了 claude-opus-4-8 和 claude-sonnet-4-6 的证据

representativeAvailability(gptUpstream, { model: '' })
// => { verified: true, aggregated: true, evidence_count: 1 }
```

---

## 分层算法实现

### verificationTier() 函数

位置: `server.mjs:10334-10339`

```javascript
function verificationTier(upstream) {
  if (upstream.available && upstream.representative_availability?.verified === true) 
    return 'real_verified';
  
  if (upstream.available && upstream.health?.state === 'ok') 
    return 'probe_only';
  
  if (upstream.available) 
    return 'real_pending';
  
  return 'unavailable';
}
```

**逻辑优先级**:
1. 先检查 `available` (快速路径：不可用直接返回)
2. 再检查 `representative_availability.verified` (真实验证优先)
3. 降级到 `health.state` (只有探测证据)
4. 最后是通用的 `available` (等待验证)

### upstreamAvailable() 函数

位置: `server.mjs:4827-4835`

```javascript
function upstreamAvailable(upstream, at, expectedModel = undefined) {
  return upstream.enabled
    && !upstream.quarantined
    && upstream.baseUrl
    && healthAllowsSelection(upstream, expectedModel)
    && !codexOAuthExpired(upstream, at)
    && upstream.cooldownUntil <= at
    && upstream.keys.some((key) => keyAvailable(key, at));
}
```

**注意**: 
- `upstreamAvailable()` **不** 检查模型兼容性
- 模型过滤发生在选择层 (`chooseCandidate`)
- `available` 字段反映上游的 **基础可用性**，不是模型匹配状态

### representativeAvailability() 函数

位置: `server.mjs:1167-1206`

**核心逻辑**:

```javascript
if (normalizedModel) {
  // 特定模型模式
  const item = byModel[normalizedModel];
  if (item) {
    evidence.push(...);
  }
} else {
  // 聚合模式 (修复后)
  for (const [modelName, item] of Object.entries(byModel)) {
    evidence.push({
      modelName: modelName,
      ...
    });
  }
}
```

**新鲜度判断**:
- 证据的 `checked_at` 在 30 分钟内 → `fresh = true`
- `freshEvidence.length > 0` → `verified = true`

---

## 常见问题与场景

### Q1: 为什么 Claude 上游有时不显示在"真实请求验证"？

**原因**: 

在修复前，当 Model Override 为空时，`representativeAvailability()` 不会收集任何证据。

**修复**: 

现在当 Model Override 为空时，函数会聚合所有模型的证据，确保 Claude 上游只要有任何模型的新鲜证据就显示为已验证。

### Q2: Model Override 如何影响分层？

**直接影响**: `representativeAvailability.verified` 的计算
- 有 Model Override → 只看该模型的证据
- 无 Model Override → 聚合所有模型的证据

**间接影响**: `upstreamAvailable()` 通过 `healthAllowsSelection(upstream, expectedModel)` 检查健康状态
- 如果健康探测使用的模型与当前 Model Override 不匹配 → `health.state = 'stale_model_override'`
- 但 `stale_model_override` 仍允许选择

### Q3: 为什么上游 `available = true` 但不参与选择？

**可能原因**:

1. **模型不兼容**: 
   - GPT 上游不支持 Claude 模型
   - 检查点: `upstreamSupportsModel(upstream, model)`

2. **模型未在探测列表中**:
   - `upstream.health.models` 不包含请求的模型
   - 会降级到 `allowUnknownModelFallback`

3. **协议能力不匹配**:
   - 请求需要 native Responses，但上游只支持 Chat Completions
   - 检查点: `canAttemptNativeResponses()`

### Q4: 证据何时记录？

**记录时机**: 成功完成请求后

**代码路径**:
1. 请求通过上游成功返回
2. 响应状态码 200
3. 流式传输完成
4. 调用 `recordRepresentativeEvidence(key, protocol, model, at, source)`

**不记录的情况**:
- 请求失败（4xx, 5xx）
- 连接超时或中断
- 协议适配失败

### Q5: 如何手动刷新分层状态？

**方法 1: 运行 Health Probe**
```bash
curl -X POST http://127.0.0.1:8787/pool/probe \
  -H "Authorization: Bearer $CODEX_POOL_ADMIN_KEY"
```

**方法 2: 发送真实请求**
- 通过池发送请求
- 成功后会自动记录代表性证据
- 30 分钟内刷新 Dashboard 即可看到更新

**方法 3: 清除 Model Override 查看聚合状态**
```bash
curl -X POST http://127.0.0.1:8787/pool/model \
  -H "Authorization: Bearer $CODEX_POOL_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": ""}'
```

---

## 调试技巧

### 检查特定上游的验证状态

```bash
curl -s http://127.0.0.1:8787/pool/status | \
  jq '.upstreams[] | select(.name == "my-upstream") | {
    name,
    available,
    health_state: .health.state,
    rep_verified: .representative_availability.verified,
    rep_aggregated: .representative_availability.aggregated,
    rep_fresh_count: .representative_availability.fresh_evidence_count,
    rep_total_count: .representative_availability.evidence_count
  }'
```

### 查看代表性证据详情

```bash
curl -s http://127.0.0.1:8787/pool/status | \
  jq '.upstreams[] | select(.name == "my-upstream") | 
    .keys[0].representative_evidence'
```

### 诊断为什么上游不在预期分层

1. **检查 `available`**: 应该是 `true`
2. **检查 `representative_availability.verified`**: 
   - 如果为 `false`，检查 `fresh_evidence_count`
   - 如果为 0，检查 `evidence_count` (可能证据过期)
3. **检查 `health.state`**: 
   - 如果不是 `ok`，上游最多只能到 `real_pending`
4. **检查 Model Override**:
   - 如果设置了特定模型，确保证据中有该模型

---

## 最佳实践

### 运维建议

1. **定期运行 Health Probe** (推荐: 每 5 分钟)
   - 保持健康状态新鲜
   - 及时发现不可用上游

2. **监控代表性证据新鲜度**
   - 证据超过 30 分钟会过期
   - 高流量环境自动刷新，低流量环境需要手动测试

3. **使用"筛选所有模型"查看全局状态**
   - 不受 Model Override 影响
   - 显示聚合验证状态

### 配置建议

1. **为不同模型家族配置独立上游**
   - Claude 上游: `api: "anthropic"`
   - GPT 上游: `api: "openai"`
   - 混合上游: `api: "both"` (需要上游支持)

2. **设置合理的权重**
   - 已验证上游: 高权重
   - 仅探测通过: 中权重
   - 待验证上游: 低权重

3. **利用隔离功能测试**
   - 新上游先设置 `quarantined: true`
   - 手动测试通过后再激活

---

## 总结

分层策略的核心是 **渐进式验证**:

1. **基础层** (unavailable): 配置/状态阻止使用
2. **待验证层** (real_pending): 可用但未探测
3. **探测层** (probe_only): 探测通过，待真实验证
4. **验证层** (real_verified): 真实流量验证成功

修复后的聚合模式确保"筛选所有模型"时，所有有验证证据的上游都能正确显示在对应层级，提供更准确的全局视图。
