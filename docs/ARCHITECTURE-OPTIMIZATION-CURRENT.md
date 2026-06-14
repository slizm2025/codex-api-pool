# 架构优化实施 - 最新进度

**日期**: 2026-06-14  
**状态**: ✅ 任务 1 完成，准备任务 2  

---

## 📊 已完成工作

### ✅ 任务 0：修复 Smoke Test（完成）

**问题诊断**：
- Smoke test 使用了过时的 API 字段路径
- 检查 `.stats.attempts` 但实际是 `.attempts`
- 检查 `.usage.today_tokens` 但实际在 `.usage.daily[today]`

**修复内容**：
- 更新测试以匹配当前 API 结构
- 所有 smoke tests 现在通过 ✅

**Commit**: `e38def7`

---

### ✅ 任务 1：提取路由决策树模块（完成）

**新增模块**: `src/request-routing-rules.mjs` (200 行)

**核心功能**：
```javascript
class RequestRoutingRules {
  canAttemptNativeResponses(pathname, upstream, model, options)
  getRouteStrategy(upstream, model)
  routeStrategyUsesNativeResponses(strategy)
  routeStrategyUsesChatCompletions(strategy)
  isChatCompletionsOnlyMode(upstream)
  nativeResponsesCapabilityNewerThanStrategy(upstream, strategy, model)
  nativeResponsesRecheckDue(strategy, options)
}
```

**测试覆盖**: 7/7 通过 ✅

**Commit**: `290008c`

---

## ⏳ 下一步：完成任务 1 集成

### 集成步骤

1. **在 createPoolServer 中实例化 RequestRoutingRules**
   ```javascript
   const routingRules = new RequestRoutingRules(config, {
     shouldUseAnthropicResponsesAdapter,
     canUseChatCompletionsAdapter
   });
   ```

2. **替换所有旧函数调用**
   - `canAttemptNativeResponses()` → `routingRules.canAttemptNativeResponses()`
   - `routeStrategyForUpstream()` → `routingRules.getRouteStrategy()`
   - `routeStrategyUsesNativeResponses()` → `routingRules.routeStrategyUsesNativeResponses()`
   - 等等...

3. **删除旧函数定义**
   - 删除 6 个旧的分散函数

4. **验证行为一致性**
   - 运行 smoke test
   - 运行单元测试

**预计工作量**: 1-2 小时

---

## 📋 待完成任务

### 任务 2：完成 Orchestrator 集成（3-4h）

**计划**：
1. 实现 `HttpProbeExecutor` 包装真实探测函数
2. 在 `probeOneUpstream()` 中使用 orchestrator
3. 删除 120 行嵌套探测逻辑
4. 运行完整测试验证

### 任务 3：合并 Probe Result Applicator（1h）

**计划**：
1. 将 `probe-result-applicator.mjs` 的功能合并到 `protocol-capability-manager.mjs`
2. 更新调用点
3. 删除浅模块

---

## 📊 成果统计

| 指标 | 数值 |
|------|------|
| Commits | 2 个 |
| 修复的测试 | 3 个失败 → 全部通过 |
| 新增模块 | 1 个 |
| 新增代码 | 320 行（200 源码 + 120 测试）|
| 单元测试 | 7 个（全部通过）|
| Smoke tests | ✅ 全部通过 |

---

## 🎯 当前焦点

**立即任务**：完成任务 1 集成
- 替换 server.mjs 中的旧函数
- 验证行为一致性
- 删除旧代码

**时间估计**：1-2 小时

你想要：
1. **继续完成任务 1 集成**？
2. **暂停，稍后继续**？
3. **跳过集成，直接开始任务 2**？
