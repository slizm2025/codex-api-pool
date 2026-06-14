# 架构优化实施报告 - 进行中

**日期**: 2026-06-14  
**状态**: 🔄 进行中  
**方法**: TDD + 架构深化

---

## 📋 执行计划

1. ✅ 提取路由决策树模块（核心完成）
2. ⏳ 完成 Orchestrator 集成（待开始）
3. ⏳ 合并 Probe Result Applicator（待开始）

---

## ✅ 任务 1：提取路由决策树模块 - 核心完成

### 实现内容

**新增模块**: `src/request-routing-rules.mjs` (200 行)

**核心功能**：
- `RequestRoutingRules` 类封装所有路由决策逻辑
- `canAttemptNativeResponses()` - 主决策点
- `getRouteStrategy()` - 获取学习的路由策略
- `routeStrategyUsesNativeResponses()` - 检查策略类型
- `routeStrategyUsesChatCompletions()` - 检查策略类型
- `isChatCompletionsOnlyMode()` - 检查模式
- `nativeResponsesCapabilityNewerThanStrategy()` - 能力比较
- `nativeResponsesRecheckDue()` - 重检时机

**测试覆盖**: 7/7 通过
- 非 responses 路径处理
- 显式 requestMode 处理
- 学习策略检查
- 策略类型检测

**集成状态**: 
- ✅ 模块创建完成
- ✅ 导入到 server.mjs
- ⚠️ 尚未替换旧函数（保持向后兼容）

### 架构改进

**之前**：
- 6+ 个分散函数
- 嵌套调用，难以追踪
- 无法独立测试
- 探测和运行时必须重复逻辑

**之后**：
- 单一 `RequestRoutingRules` 类
- 清晰的决策树
- 7 个单元测试覆盖
- 可从探测和运行时共享使用

### 下一步

需要在 server.mjs 中用新模块替换旧函数：
- `canAttemptNativeResponses()` → `routingRules.canAttemptNativeResponses()`
- `routeStrategyForUpstream()` → `routingRules.getRouteStrategy()`
- 等等...

---

## ⏳ 任务 2：完成 Orchestrator 集成 - 待开始

### 计划

1. 实现 `HttpProbeExecutor`
2. 在 `probeOneUpstream()` 中使用 orchestrator
3. 删除重复的手动协调代码
4. 验证行为一致性

**预计工作量**: 3-4 小时

---

## ⏳ 任务 3：合并 Probe Result Applicator - 待开始

### 计划

将 `probe-result-applicator.mjs` 合并到 `protocol-capability-manager.mjs`

**预计工作量**: 1 小时

---

## 🔍 发现的问题

### Smoke Test 失败

运行 smoke test 时发现一个未相关的错误：
```
expected model listing metadata request to stay out of recent requests and availability
```

这个错误与路由规则模块无关，可能是之前的代码变更引起的。需要单独调查。

---

## 📊 当前状态

### 文件统计

| 文件 | 状态 | 行数 | 测试 |
|------|------|------|------|
| src/request-routing-rules.mjs | ✅ 新增 | 200 | 7 |
| test/request-routing-rules.test.mjs | ✅ 新增 | 120 | 7 |
| src/server.mjs | 🔄 导入 | +3 | - |

### 测试统计

- ✅ request-routing-rules.test.mjs: 7/7 通过
- ⚠️ smoke-test.mjs: 失败（未相关错误）

---

## 💡 建议

### 立即行动

1. **修复 smoke test 失败**
   - 调查模型列表元数据请求问题
   - 与路由规则无关，但阻塞整体验证

2. **完成路由规则集成**
   - 替换 server.mjs 中的旧函数
   - 验证向后兼容性

### 后续行动

3. 继续任务 2 和 3

---

## 🎯 总结

任务 1 的核心实现已完成：
- ✅ 路由决策树已提取为独立模块
- ✅ 7 个单元测试验证功能正确
- ✅ 导入到 server.mjs 准备集成
- ⚠️ 需要修复 smoke test 失败才能完全验证

**下一步**: 修复 smoke test 失败，然后完成集成。
