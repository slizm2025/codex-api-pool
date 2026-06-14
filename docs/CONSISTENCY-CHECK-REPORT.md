# 全面一致性检查报告 - Phase 1 & Phase 2

**日期**: 2026-06-14  
**检查范围**: 所有 20 个上游  
**状态**: ✅ 完全一致

---

## 检查摘要

对所有上游进行了全面的一致性检查，验证 Phase 1 和 Phase 2 的修改是否在所有上游中统一实施。

---

## 检查结果

### ✅ Phase 1: stats 字段移除

**检查项**: 所有上游是否都删除了 `stats` 对象

```json
{
  "total_upstreams": 20,
  "upstreams_without_stats": 20,        ✅ 100%
  "upstreams_with_attempts": 20,        ✅ 100%
  "upstreams_with_availability": 20     ✅ 100%
}
```

**结论**: ✅ 所有 20 个上游都已正确删除 `stats` 对象

---

### ✅ Phase 2: usage 字段简化

**检查项**: 所有上游的 usage 对象是否都删除了冗余字段

```json
{
  "total_upstreams": 20,
  "upstreams_without_today_tokens": 20,  ✅ 100%
  "upstreams_without_by_day": 20,        ✅ 100%
  "upstreams_with_daily": 20             ✅ 100%
}
```

**结论**: ✅ 所有 20 个上游的 usage 对象都已简化

---

### ✅ 字段结构一致性

#### Upstream 顶层字段（37-38 个）

**标准字段集** (37 个):
```
api, attempts, availability, available, base_url, billing,
capabilities, codex_oauth, config_index, cooldown_ms, enabled,
ewma_latency_ms, failures, health, health_path, in_flight,
keys, last_error, last_status, name, probe_auth, quarantined,
quota, representative_availability, request_interface, request_mode,
route_strategies, selection_score, selection_weight, signin_available,
signin_completed, signin_completed_date, signin_status, site_url,
successes, usage, weight
```

**字段数量分布**:
- 37 个字段: 19 个上游 ✅
- 38 个字段: 1 个上游 (Mint_claude，有额外的 `model_suffix_strip` 配置) ✅

**结论**: ✅ 字段数量差异是合理的配置差异

---

#### Usage 字段（4 个）

**所有上游的 usage 字段**:
```json
{
  "total_tokens": 54175958,
  "input_tokens": 53960561,
  "output_tokens": 215397,
  "daily": { ... }
}
```

**字段数量**: 4 个字段，所有 20 个上游 ✅

**结论**: ✅ 所有上游的 usage 结构完全一致

---

#### Availability 字段（8 个）

**所有上游的 availability 字段**:
```json
{
  "failures": 6,
  "min_samples": 10,
  "multiplier": 1.0,
  "rate": 0.88,
  "recent": [false, false, ..., true],
  "samples": 50,
  "successes": 44,
  "window_size": 50
}
```

**字段数量**: 8 个字段，所有 20 个上游 ✅

**结论**: ✅ 所有上游的 availability 结构完全一致

---

### ✅ Key 对象一致性

**检查项**: 上游的 keys 是否都删除了 `stats` 对象

```json
{
  "has_stats": false,           ✅
  "has_availability": true,     ✅
  "availability_fields": [
    "failures",
    "min_samples",
    "multiplier",
    "rate",
    "recent",
    "samples",
    "successes",
    "window_size"
  ]
}
```

**结论**: ✅ 所有 key 对象都已正确删除 `stats`

---

## 详细验证

### 1. 所有上游的 usage 结构分组

**结果**:
```json
{
  "structure": {
    "has_total": true,
    "has_daily": true,
    "has_today_tokens": false,
    "has_by_day": false
  },
  "count": 20,
  "upstreams": [所有 20 个上游]
}
```

**结论**: ✅ 所有上游属于同一个结构组，完全一致

---

### 2. 所有上游的 attempts/stats 字段

**结果**:
```json
{
  "pattern": {
    "has_attempts": true,
    "has_stats": false
  },
  "count": 20,
  "upstreams": [所有 20 个上游]
}
```

**结论**: ✅ 所有上游都有 `attempts`，都没有 `stats`

---

### 3. 所有上游的 availability 字段

**结果**:
```json
{
  "pattern": {
    "has_availability": true,
    "has_availability_rate": true
  },
  "count": 20
}
```

**结论**: ✅ 所有上游都有完整的 availability 对象

---

## 实现一致性验证

### ✅ 单一代码路径

**验证**: 所有上游都通过同一个函数创建视图

```javascript
// 所有上游都通过这个函数
createUpstreamStatusView(upstream, config, state, at, today)
  ↓
返回统一格式的对象
  {
    attempts: upstream.stats.attempts,
    availability: availabilitySummary(upstream.stats, ...),
    usage: usagePayload(upstream.stats, today),
    // 没有 stats
  }
```

**结论**: ✅ 单一实现路径保证了所有上游的一致性

---

### ✅ 单一数据源

**验证**: 所有上游的数据都来自内部 `stats` 对象

```javascript
// 内部存储（所有上游共享）
upstream.stats = {
  attempts: 614,
  availability: { samples: [...] },
  tokenUsage: { ... }
}

// API 输出（所有上游一致）
{
  attempts: upstream.stats.attempts,      // 提取
  availability: availabilitySummary(...),  // 计算
  usage: usagePayload(...)                 // 转换
}
```

**结论**: ✅ 数据源一致保证了输出一致

---

## 异常情况检查

### ✅ 没有遗漏的上游

**检查**: 是否所有上游都经过了修改

```bash
# 检查是否有上游仍然有 stats
jq '[.upstreams[] | select(has("stats"))] | length' < status.json
# 结果: 0  ✅

# 检查是否有上游仍然有 today_tokens
jq '[.upstreams[] | select(.usage | has("today_tokens"))] | length' < status.json
# 结果: 0  ✅
```

**结论**: ✅ 没有遗漏的上游

---

### ✅ 没有部分实施的上游

**检查**: 是否所有修改都完整实施

```bash
# Phase 1 检查：删除 stats + 添加 attempts
jq '[.upstreams[] | {has_stats: has("stats"), has_attempts: has("attempts")}] 
    | group_by(.) | length' < status.json
# 结果: 1 组（所有上游都是 {stats: false, attempts: true}）✅

# Phase 2 检查：删除 today_* + 删除 by_day
jq '[.upstreams[] | .usage | {
      has_today: has("today_tokens"), 
      has_by_day: has("by_day")
    }] | group_by(.) | length' < status.json
# 结果: 1 组（所有上游都是 {today: false, by_day: false}）✅
```

**结论**: ✅ 没有部分实施的上游

---

## 配置差异分析

### ⚠️ 合理的差异

**Mint_claude 的额外字段**:
```json
{
  "name": "Mint_claude",
  "model_suffix_strip": true
}
```

**分析**:
- 这是配置项差异，不是实现差异
- 不影响 Phase 1 和 Phase 2 的修改
- 其他核心字段（attempts, availability, usage）完全一致

**结论**: ✅ 合理的配置差异，不是问题

---

## 最终结论

### ✅ 完全一致

**所有 20 个上游**:
- ✅ 都删除了 `stats` 对象
- ✅ 都添加了 `attempts` 字段
- ✅ 都保留了 `availability` 字段
- ✅ 都简化了 `usage` 对象（删除 today_*, by_day）
- ✅ 都通过同一个代码路径创建视图
- ✅ 都使用同一个数据源（stats）

**字段结构**:
- ✅ Upstream 顶层: 37-38 个字段（差异是配置项）
- ✅ Usage: 4 个字段（完全一致）
- ✅ Availability: 8 个字段（完全一致）
- ✅ Keys: 删除 stats，保留 availability（完全一致）

**实现质量**:
- ✅ 单一实现路径（createUpstreamStatusView）
- ✅ 单一数据源（upstream.stats）
- ✅ 无遗漏的上游
- ✅ 无部分实施的上游

---

## 持续保证一致性的机制

### 代码层面

1. **单一函数**: `createUpstreamStatusView` 是唯一的上游视图创建函数
2. **单一调用**: `createStatusPayload` 是唯一的调用点
3. **类型化结构**: 所有上游都返回相同的对象结构

### 测试层面

1. **结构验证**: Smoke test 验证 API 响应结构
2. **字段检查**: 检查 stats 不存在，attempts 存在
3. **Dashboard 测试**: 验证所有上游在 Dashboard 中正常显示

---

## 建议

### ✅ 当前状态良好

所有上游完全一致，无需额外修改。

### 📝 未来改进

如果将来需要修改上游结构：
1. ✅ 继续使用单一函数创建视图
2. ✅ 在修改后运行全面的一致性检查
3. ✅ 验证所有上游的字段数量和结构
4. ✅ 检查是否有遗漏或部分实施

---

**报告生成时间**: 2026-06-14 14:35  
**检查覆盖**: 100% (20/20 上游)  
**一致性状态**: ✅ 完全一致
