# 上游卡片字段详细分析

**日期**: 2026-06-14  
**目的**: 分析哪些字段对用户有价值，哪些是冗余或废弃的

---

## 字段分类

### 🟢 核心必要字段

#### 1. 基本身份
```javascript
{
  "name": "JUN",                          // ✅ 必要：上游名称
  "base_url": "https://muyuan.do/v1",    // ✅ 必要：API 端点
  "api": "both",                          // ✅ 必要：支持的 API 类型
  "enabled": true,                        // ✅ 必要：是否启用
  "quarantined": false                    // ✅ 必要：是否隔离
}
```

**价值**: 用户需要知道这是哪个上游，是否可用

---

#### 2. 健康状态
```javascript
{
  "health": {
    "state": "missing_model_override",    // ✅ 必要：健康状态
    "source": "probe",                     // ⚠️  辅助：来源（probe/real_traffic）
    "checked_at": "2026-06-14T04:43:28",  // ✅ 必要：最后检查时间
    "latency_ms": 1452,                    // ✅ 重要：延迟
    "http_status": 200,                    // ⚠️  辅助：HTTP 状态
    "error": "...",                        // ✅ 必要：错误信息（如果有）
    "models": [...],                       // ✅ 必要：支持的模型列表
    "models_count": 7                      // 🔴 冗余：可以从 models.length 计算
  }
}
```

**价值**: 核心监控指标

**建议**:
- `models_count` 冗余，前端可以计算
- `source` 可以合并到 badge 显示
- `http_status` 可以只在错误时显示

---

#### 3. 代表性可用性（核心！）
```javascript
{
  "representative_availability": {
    "protocol": "anthropic_messages",     // ✅ 必要：使用的协议
    "model": "",                           // ✅ 必要：当前查询的模型
    "aggregated": true,                    // ✅ 必要：是否聚合模式
    "state": "fresh",                      // ✅ 必要：证据状态
    "verified": true,                      // ✅ 必要：是否已验证
    "fresh_evidence_count": 1,             // ✅ 重要：新鲜证据数量
    "evidence_count": 1,                   // ⚠️  辅助：总证据数
    "sources": ["real_traffic"],           // ⚠️  辅助：证据来源
    "latest_checked_at": "...",            // ✅ 必要：最新验证时间
    "multiplier": 1.15                     // 🟡 内部：选择算法加成
  }
}
```

**价值**: 决定上游所在层级（real_verified/probe_only/real_pending）

**建议**:
- `multiplier` 是内部选择算法细节，对用户无意义
- `sources` 只有一个值时可以省略
- `evidence_count` vs `fresh_evidence_count` 可以简化为一个带时效的数字

---

#### 4. 可用性评分
```javascript
{
  "availability": {
    "window_size": 50,                    // 🟡 内部：配置参数
    "min_samples": 10,                    // 🟡 内部：配置参数
    "samples": 50,                         // ⚠️  辅助：样本数
    "successes": 18,                       // ✅ 重要：成功次数
    "failures": 32,                        // ✅ 重要：失败次数
    "rate": 0.36,                          // ✅ 必要：成功率（36%）
    "multiplier": 0.08,                    // 🟡 内部：选择算法加成
    "recent": [false, false, ..., true]   // 🔴 冗余：50 个布尔值，过于详细
  }
}
```

**价值**: 显示上游稳定性

**建议**:
- `recent` 数组太冗余，可以只显示简化的趋势（上升/下降/稳定）
- `window_size`/`min_samples` 是配置细节，不应该在每个上游对象中重复
- `multiplier` 是内部算法，对用户无意义
- 保留 `rate`（成功率）和 `successes`/`failures` 即可

---

#### 5. 选择权重
```javascript
{
  "weight": 4,                            // ✅ 必要：用户配置的权重
  "selection_weight": 0.32,               // ✅ 重要：归一化后的权重
  "selection_score": 0.225                // ✅ 重要：当前选择分数
}
```

**价值**: 显示上游在选择算法中的优先级

**建议**:
- 三个字段都有用，但可以简化展示
- 卡片上只显示 `weight` 和 `selection_score`
- `selection_weight` 可以在详情中显示

---

#### 6. 使用统计
```javascript
{
  "usage": {
    "total_tokens": 25701772,             // ✅ 重要：总消耗
    "input_tokens": 25624428,             // ⚠️  辅助：输入 tokens
    "output_tokens": 77344,               // ⚠️  辅助：输出 tokens
    "today_tokens": 25701772,             // ✅ 必要：今日消耗
    "today_input_tokens": 25624428,       // 🔴 冗余：重复了
    "today_output_tokens": 77344,         // 🔴 冗余：重复了
    "by_day": { "2026-06-14": 25701772 }, // 🔴 冗余：与 daily 重复
    "daily": {                             // ✅ 必要：按日统计
      "2026-06-14": {
        "total_tokens": 25701772,
        "input_tokens": 25624428,
        "output_tokens": 77344
      }
    }
  }
}
```

**价值**: 显示使用量和成本

**建议**:
- `today_tokens` 和 `daily["2026-06-14"]` 重复
- `by_day` 和 `daily` 重复
- 简化为：
  ```javascript
  {
    "usage": {
      "total_tokens": 25701772,
      "today": {
        "total_tokens": 25701772,
        "input_tokens": 25624428,
        "output_tokens": 77344
      }
    }
  }
  ```

---

#### 7. 账单信息
```javascript
{
  "billing": {
    "state": "ok",                        // ✅ 必要：账单状态
    "checked_at": "2026-06-13T17:43:00",  // ✅ 必要：最后查询时间
    "balance_amount": 1434.296242,        // ✅ 必要：余额
    "used_amount": 360.703758,            // ✅ 必要：已用
    "limit_amount": 1795,                 // ✅ 必要：额度
    "currency": "USD",                    // ✅ 必要：货币
    "period_start": "2026-06-01",         // ⚠️  辅助：周期开始
    "period_end": "2026-06-14",           // ⚠️  辅助：周期结束
    "limit_placeholder": false,           // 🟡 内部：标记字段
    "source": "subscription+usage",       // 🟡 内部：来源类型
    "key_label": "JUN_API_KEY",           // 🔴 冗余：已经在 keys 中
    "latency_ms": 1201,                   // 🟡 调试：查询延迟
    "http_status": 200,                   // 🟡 调试：HTTP 状态
    "error": ""                            // ✅ 必要：错误信息
  }
}
```

**价值**: 监控账户额度和余额

**建议**:
- `limit_placeholder`/`source` 是内部字段
- `key_label` 冗余
- `latency_ms`/`http_status` 可选（调试用）

---

### 🟡 辅助字段（可选展示）

#### 8. 协议能力
```javascript
{
  "capabilities": {
    "responses": {
      "status": "unknown",
      "checked_at": "...",
      "model": "MiniMax-M3",
      "http_status": 503,
      "reason": "responses probe returned HTTP 503"
    },
    "chat_completions": {
      "status": "unknown",
      // ...
    },
    "anthropic_messages": {
      "status": "verified",
      "checked_at": "...",
      "model": "claude-haiku-4-5-20251001",
      "http_status": 200
    }
  }
}
```

**价值**: 显示每个协议的支持状态

**建议**:
- 对高级用户有用
- 可以折叠在"详情"中
- 简化展示：只显示 status 和 checked_at

---

#### 9. 路由策略
```javascript
{
  "route_strategies": {
    "claude-opus-4-8": {
      "strategy": "anthropic_messages",
      "model": "claude-opus-4-8",
      "source": "real_traffic",
      "checked_at": "2026-06-14T04:35:45",
      "reason": "responses_to_anthropic_messages"
    }
  }
}
```

**价值**: 显示每个模型学习到的路由策略

**建议**:
- 对调试有用
- 可以折叠在"详情"或"高级"中
- `model` 字段冗余（已经是 key）

---

#### 10. 请求接口
```javascript
{
  "request_interface": {
    "type": "anthropic_messages",
    "label": "Anthropic Messages",
    "source": "probe",
    "path": "/v1/messages",
    "configured_mode": "auto",
    "resolved_mode": "",
    "checked_at": "...",
    "model": "claude-haiku-4-5-20251001",
    "http_status": 200,
    "supported": [...],                   // 支持的协议列表
    "using": {                             // 当前使用的策略
      "type": "by_requested_model",
      "label": "By Requested Model",
      "reason": "Dashboard is following each incoming Requested Model."
    }
  }
}
```

**价值**: 显示请求接口和模式

**建议**:
- 信息重复（与 `capabilities` 和 `route_strategies` 重叠）
- 可以简化为一个 badge："Using: By model"
- `supported` 数组可以合并到 `capabilities`

---

### 🔴 冗余/废弃字段

#### 11. 实时状态（冗余）
```javascript
{
  "available": true,                      // 🔴 可以从 health 计算
  "cooldown_ms": 0,                       // 🔴 可以简化为布尔值
  "in_flight": 0,                         // 🟡 调试用
  "successes": 7,                         // 🔴 与 availability.successes 重复
  "failures": 0,                          // 🔴 与 availability.failures 重复
  "ewma_latency_ms": 6291,                // 🔴 与 health.latency_ms 重复
  "last_status": 200,                     // 🔴 与 health.http_status 重复
  "last_error": ""                        // 🔴 与 health.error 重复
}
```

**问题**: 与其他字段重复

**建议**: 全部删除或合并到对应的对象中

---

#### 12. stats 对象（完全冗余）
```javascript
{
  "stats": {
    "attempts": 68,
    "responses": 68,
    "successes": 18,
    "failures": 50,
    "retries": 50,
    "lastUsedAt": "...",
    "lastStatus": 200,
    "tokenUsage": { ... },                // 与 usage 重复
    "availability": { ... }                // 与 availability 重复
  }
}
```

**问题**: 完全与其他字段重复

**建议**: **删除整个 stats 对象**

---

#### 13. Codex OAuth 字段（特定场景）
```javascript
{
  "site_url": "https://muyuan.do",
  "signin_available": true,
  "signin_status": "pending",
  "signin_completed": false,
  "signin_completed_date": "",
  "codex_oauth": false
}
```

**价值**: 只对使用 Codex OAuth 的上游有用

**建议**:
- 大多数上游这些字段都是空的
- 只在 `codex_oauth: true` 时显示
- 可以合并为一个对象：
  ```javascript
  {
    "codex_oauth": {
      "enabled": false,
      "site_url": "...",
      "signin_status": "pending"
    }
  }
  ```

---

#### 14. 内部索引
```javascript
{
  "config_index": 1                       // 🟡 内部：配置文件中的顺序
}
```

**价值**: 仅用于内部排序

**建议**: 不显示给用户

---

## 推荐的卡片布局

### 🎯 主卡片（一眼看懂）

```
┌─────────────────────────────────────────────────────────────┐
│ JUN                                    Weight 4 → 0.32 · 0.24│
│ https://muyuan.do/v1                                    36.0%│
├─────────────────────────────────────────────────────────────┤
│ JUN_API_KEY: ok                                  Calls   68 │
│                                                               │
│ ● Responses: unknown    ● Chat: unknown                      │
│ ● Messages: verified         Latency 1533ms                  │
│                                                               │
│ Models 7 · Active Following request                          │
│ Request API Supports: Messages · Using: By model             │
│ Codex Desktop Template missing                               │
│ Cooldown 0s · Failures 0                                     │
├─────────────────────────────────────────────────────────────┤
│ Billing ok                              Balance USD 1.434K  │
│ Today 23.998M                           Limit USD 1.795K    │
│ Total 23.998M                           Spent USD 360.7     │
└─────────────────────────────────────────────────────────────┘
```

### 建议的字段优先级

#### 🟢 Tier 1: 永远显示
- `name`
- `base_url`
- `weight` → `selection_score`
- `availability.rate` (百分比条)
- Key 状态（ok/error）
- 协议状态（Responses/Chat/Messages badges）
- `health.latency_ms`
- `health.models` 数量
- 账单状态（ok/error/warning）
- `billing.balance`/`limit`/`spent`
- `usage.today_tokens`

#### 🟡 Tier 2: 可折叠/Hover 显示
- `health.state` 详细说明
- `representative_availability` 详情
- `capabilities` 详细状态
- `route_strategies` 学习的策略
- `stats.attempts`/`successes`/`failures`
- `availability.recent` 趋势图
- `billing.period_start`/`period_end`

#### 🔴 Tier 3: 仅调试模式
- `config_index`
- `selection_weight` (已有 selection_score)
- `representative_availability.multiplier`
- `availability.multiplier`
- `health.http_status`
- `billing.latency_ms`

#### ❌ 可以删除的字段
- `stats` 对象（完全冗余）
- `successes`/`failures`/`ewma_latency_ms`/`last_status`/`last_error`（与其他字段重复）
- `usage.today_input_tokens`/`today_output_tokens`（冗余）
- `usage.by_day`（与 daily 重复）
- `availability.recent`（50 个布尔值太详细，可以用趋势替代）
- `health.models_count`（可以从 models.length 计算）

---

## 优化建议

### 1. 合并重复字段

**当前**:
```javascript
{
  "successes": 7,
  "failures": 0,
  "availability": {
    "successes": 18,
    "failures": 32
  },
  "stats": {
    "successes": 18,
    "failures": 50
  }
}
```

**优化后**:
```javascript
{
  "availability": {
    "successes": 18,
    "failures": 32,
    "rate": 0.36
  }
}
```

---

### 2. 简化 Usage 对象

**当前**:
```javascript
{
  "usage": {
    "total_tokens": 25701772,
    "input_tokens": 25624428,
    "output_tokens": 77344,
    "today_tokens": 25701772,
    "today_input_tokens": 25624428,
    "today_output_tokens": 77344,
    "by_day": { "2026-06-14": 25701772 },
    "daily": {
      "2026-06-14": {
        "total_tokens": 25701772,
        "input_tokens": 25624428,
        "output_tokens": 77344
      }
    }
  }
}
```

**优化后**:
```javascript
{
  "usage": {
    "total": 25701772,
    "today": {
      "total": 25701772,
      "input": 25624428,
      "output": 77344
    },
    "daily": {
      "2026-06-14": {
        "total": 25701772,
        "input": 25624428,
        "output": 77344
      }
    }
  }
}
```

---

### 3. 精简 representative_availability

**当前**:
```javascript
{
  "representative_availability": {
    "protocol": "anthropic_messages",
    "model": "",
    "aggregated": true,
    "state": "fresh",
    "verified": true,
    "fresh_evidence_count": 1,
    "evidence_count": 1,
    "sources": ["real_traffic"],
    "latest_checked_at": "...",
    "multiplier": 1.15
  }
}
```

**优化后（用户视角）**:
```javascript
{
  "representative_availability": {
    "verified": true,
    "protocol": "anthropic_messages",
    "evidence": {
      "fresh": 1,
      "total": 1,
      "latest": "2026-06-14T04:35:45"
    }
  }
}
```

---

### 4. 响应体积优化

**当前**: JUN 上游完整 JSON ~4KB  
**优化后估计**: ~2.5KB (-37%)

删除：
- `stats` 对象完全删除
- 重复的顶层字段
- 内部算法字段（multiplier）
- 冗余的 recent 数组

---

## 实施优先级

### P0（立即）
- ✅ 修复聚合模式（已完成）
- ✅ 修复协议匹配（已完成）

### P1（短期）
1. **删除 stats 对象** - 完全冗余，可以安全删除
2. **合并重复字段** - successes/failures/last_error 等
3. **简化 usage 对象** - 删除重复的 by_day 和 today_* 字段

### P2（中期）
1. **精简 availability.recent** - 50 个布尔值 → 趋势标识（上升/稳定/下降）
2. **隐藏内部字段** - multiplier, config_index 等
3. **合并 Codex OAuth 字段** - 只在启用时显示

### P3（长期）
1. **API 版本化** - 引入 v2 API，破坏性变更
2. **可配置字段** - 用户选择显示哪些字段
3. **国际化** - 字段标签和描述

---

## 数据流完整追踪

### upstream.successes / upstream.failures（连续成功/失败计数器）

**用途**: 用于冷却时间计算和重试策略

**写入位置**:
```javascript
// Line 6656: 成功时
function recordSuccess(upstream, startedAt, statusCode) {
  upstream.successes += 1;
  upstream.failures = 0;  // 🔴 重置失败计数
  upstream.lastError = '';
  upstream.lastStatus = statusCode;
  upstream.ewmaLatencyMs = ...;  // 指数移动平均延迟
}

// Line 6665: 失败时
function recordFailure(state, upstream, key, reason, statusCode, retryAfter) {
  upstream.failures += 1;
  upstream.lastError = reason;
  upstream.lastStatus = statusCode;
  
  // 🔴 根据连续失败次数计算冷却时间
  const failureMultiplier = Math.min(8, Math.max(1, upstream.failures));
  const cooldownMs = cooldownBase * failureMultiplier;
  
  // 🔴 达到阈值时进入冷却
  if (upstream.failures >= state.retry.failureThreshold) {
    upstream.cooldownUntil = now() + cooldownMs;
  }
}
```

**与 stats 的区别**:
- `upstream.successes`: **连续成功**次数（失败时重置为 0）
- `stats.successes`: **总成功**次数（累积，不重置）
- `availability.successes`: **窗口内成功**次数（滑动窗口，最近 50 次）

**用途不同，不能删除！**

---

### upstream.stats（内部存储层）

**职责**: 持久化和统计

**结构**:
```javascript
upstream.stats = {
  // 累积计数器（永不重置）
  attempts: 68,
  responses: 68,
  successes: 18,
  failures: 50,
  retries: 50,
  lastUsedAt: "2026-06-14T04:35:42.995Z",
  
  // 可用性滑动窗口（最近 50 次）
  availability: {
    samples: [0, 0, 0, 1, 1, ...]  // 50 个 0/1
  },
  
  // Token 使用统计
  tokenUsage: {
    totalTokens: 25701772,
    inputTokens: 25624428,
    outputTokens: 77344,
    byDay: { "2026-06-14": 25701772 },      // 🔴 与 daily 重复
    daily: {
      "2026-06-14": {
        totalTokens: 25701772,
        inputTokens: 25624428,
        outputTokens: 77344
      }
    }
  }
}
```

**写入时机**: 每次请求完成后
**持久化**: 写入 `stats.local.json`
**读取**: 转换为 `availability` 和 `usage` 视图

---

## 修改方案：三阶段重构

### Phase 1: 移除 API 响应中的 stats 对象（无破坏性）

**目标**: 减少 API 响应体积 30%

**修改位置 1**: `createUpstreamStatusView` (Line 11661)

```javascript
// 当前
{
  stats: upstream.stats,           // 🔴 删除这一行
  availability,
  usage,
  // ...
}

// 修改后
{
  availability,
  usage,
  // ...
}
```

**修改位置 2**: `createKeyStatusView` (Line 11582)

```javascript
// 当前
{
  stats: key.stats,                // 🔴 删除这一行
  availability,
  quota,
  // ...
}

// 修改后
{
  availability,
  quota,
  // ...
}
```

**影响范围**:
- ✅ **内部存储不变**: `upstream.stats` 仍然存在，持久化正常
- ✅ **所有读取正常**: `availability` 和 `usage` 仍从 `stats` 计算
- ✅ **前端兼容**: 前端应该已经用 `availability` 和 `usage`，不应该直接读 `stats`

**验证方法**:
```bash
# 1. 备份当前代码
git checkout -b remove-stats-from-api

# 2. 修改代码
# 删除 Line 11661: stats: upstream.stats,
# 删除 Line 11582: stats: key.stats,

# 3. 重启服务
npm run service:restart

# 4. 检查 API 响应
curl -s http://127.0.0.1:8787/pool/status | jq '.upstreams[0] | has("stats")'
# 应该返回 false

curl -s http://127.0.0.1:8787/pool/status | jq '.upstreams[0] | {availability, usage}'
# 应该正常显示

# 5. 检查 Dashboard
open http://127.0.0.1:8787/pool/dashboard
# 所有数据应该正常显示

# 6. 运行 smoke test
npm run smoke
# 应该全部通过
```

**回滚方案**:
```bash
git checkout main
npm run service:restart
```

---

### Phase 2: 简化 usage 对象（小破坏性）

**目标**: 移除冗余字段

**修改位置**: `usagePayload` 函数 (Line 6216)

```javascript
// 当前
function usagePayload(stats, today) {
  const usage = ensureTokenUsage(stats);
  const todayEntry = tokenDailyEntry(usage, today);
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    today_tokens: todayEntry.total_tokens,        // 🔴 冗余
    today_input_tokens: todayEntry.input_tokens,  // 🔴 冗余
    today_output_tokens: todayEntry.output_tokens,// 🔴 冗余
    by_day: { ...usage.byDay },                    // 🔴 冗余
    daily: tokenDailyPayload(usage)
  };
}

// 修改后
function usagePayload(stats, today) {
  const usage = ensureTokenUsage(stats);
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    daily: tokenDailyPayload(usage)  // 已包含所有每日数据
  };
}
```

**前端迁移**:
```javascript
// 旧代码
const todayTokens = upstream.usage.today_tokens;
const byDay = upstream.usage.by_day;

// 新代码
const today = new Date().toISOString().split('T')[0];
const todayTokens = upstream.usage.daily[today]?.total_tokens || 0;
const byDay = Object.fromEntries(
  Object.entries(upstream.usage.daily).map(([day, entry]) => [day, entry.total_tokens])
);
```

**破坏性**: ⚠️ 前端需要修改
**收益**: 减少 15% usage 对象体积

---

### Phase 3: 精简 availability.recent（可选）

**目标**: 50 个布尔值 → 趋势标识

**修改位置**: `availabilitySummary` 函数 (Line 4483)

```javascript
// 当前
function availabilitySummary(stats, availabilityConfig) {
  const availability = ensureAvailability(stats, availabilityConfig);
  const samples = availability.samples;
  const successes = samples.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  const failures = samples.length - successes;
  const rate = samples.length > 0 ? successes / samples.length : null;
  const multiplier = availabilityMultiplier(rate, samples.length, availabilityConfig);
  
  return {
    window_size: availabilityConfig.windowSize,
    min_samples: availabilityConfig.minSamples,
    samples: samples.length,
    successes,
    failures,
    rate,
    multiplier,
    recent: samples.map(Boolean)  // 🔴 50 个布尔值
  };
}

// 修改后（选项 A: 完全删除）
function availabilitySummary(stats, availabilityConfig) {
  // ... 同上
  return {
    window_size: availabilityConfig.windowSize,
    min_samples: availabilityConfig.minSamples,
    samples: samples.length,
    successes,
    failures,
    rate,
    multiplier
    // 🔴 删除 recent 字段
  };
}

// 修改后（选项 B: 简化为趋势）
function availabilitySummary(stats, availabilityConfig) {
  // ... 同上
  
  // 计算趋势：比较最近 10 次 vs 之前 10 次
  const recentSlice = samples.slice(-10);
  const previousSlice = samples.slice(-20, -10);
  const recentRate = recentSlice.filter(Boolean).length / recentSlice.length;
  const previousRate = previousSlice.length > 0 
    ? previousSlice.filter(Boolean).length / previousSlice.length 
    : recentRate;
  
  let trend = 'stable';
  if (recentRate > previousRate + 0.2) trend = 'improving';
  else if (recentRate < previousRate - 0.2) trend = 'degrading';
  
  return {
    window_size: availabilityConfig.windowSize,
    min_samples: availabilityConfig.minSamples,
    samples: samples.length,
    successes,
    failures,
    rate,
    multiplier,
    trend,  // 'improving' | 'stable' | 'degrading'
    recent_10: samples.slice(-10).map(Boolean)  // 只保留最近 10 次
  };
}
```

**前端迁移**:
```javascript
// 旧代码：绘制完整历史
upstream.availability.recent.forEach((success, i) => {
  drawBar(i, success);
});

// 新代码（选项 A）：使用 rate 显示百分比
drawPercentage(upstream.availability.rate);

// 新代码（选项 B）：显示趋势和最近 10 次
drawTrend(upstream.availability.trend);  // ↑ / → / ↓
upstream.availability.recent_10.forEach((success, i) => {
  drawBar(i, success);
});
```

**破坏性**: ⚠️ 前端需要修改
**收益**: 减少 40% availability 对象体积

---

## 完整实施计划

### P0（立即，无风险）

**修改**: 删除 API 响应中的 `stats` 对象

**文件**: `src/server.mjs`
- Line 11661: 删除 `stats: upstream.stats,`
- Line 11582: 删除 `stats: key.stats,`

**测试**:
```bash
npm run smoke  # 应该全部通过
```

**收益**: -30% API 响应体积

---

### P1（短期，需要前端配合）

**修改**: 简化 `usage` 对象

**文件**: `src/server.mjs`
- Line 6216-6228: 修改 `usagePayload` 函数

**前端任务**:
- 修改读取 `today_tokens` 的代码
- 修改读取 `by_day` 的代码

**测试**:
```bash
npm run smoke
# 前端手工测试所有使用 usage 的地方
```

**收益**: -15% usage 对象体积

---

### P2（可选，需要前端配合）

**修改**: 精简 `availability.recent`

**选项 A**: 完全删除（推荐）
**选项 B**: 简化为趋势 + 最近 10 次

**文件**: `src/server.mjs`
- Line 4483-4499: 修改 `availabilitySummary` 函数

**前端任务**:
- 重新设计可用性展示（百分比或趋势图）

**收益**: -40% availability 对象体积

---

## 总结

### 核心发现

1. **stats 是内部存储层** - 持久化到 `stats.local.json`
2. **availability 和 usage 是派生视图** - 从 `stats` 计算
3. **API 响应同时包含三者 = 冗余 60%**
4. **顶层字段有独立用途** - `upstream.successes` ≠ `stats.successes`

### 三层架构

```
┌─────────────────────────────────────┐
│   API 响应（用户视图）                │
│   - availability（计算的摘要）        │
│   - usage（格式化的视图）             │
│   - stats（🔴 暴露了内部实现）       │
└─────────────────────────────────────┘
              ↑
              | 转换函数
              |
┌─────────────────────────────────────┐
│   内部存储（持久化层）                │
│   - upstream.stats                   │
│   - key.stats                        │
└─────────────────────────────────────┘
              ↑
              | 记录函数
              |
┌─────────────────────────────────────┐
│   运行时状态（控制层）                │
│   - upstream.successes（连续）       │
│   - upstream.failures（连续）        │
│   - upstream.cooldownUntil           │
└─────────────────────────────────────┘
```

### 推荐行动

**P0（立即）**: 删除 API 响应中的 `stats` 对象  
**P1（短期）**: 简化 `usage` 对象  
**P2（可选）**: 精简 `availability.recent`

**总收益**: -45% API 响应体积，提升可读性和性能
