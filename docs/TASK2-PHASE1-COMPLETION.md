# 任务 2 阶段 1 完成报告：增强 Orchestrator 计划能力

**完成日期**: 2026-06-14  
**用时**: ~1 小时  
**方法**: TDD (Test-Driven Development)

---

## 📋 阶段 1 目标

增强 `ProtocolProbeOrchestrator` 的计划能力，添加：
1. ✅ 重检策略集成
2. ✅ requestMode/resolvedRequestMode 处理
3. ✅ 分类器集成

---

## 🔧 实施内容

### 1. 重检策略集成

**问题**: 原有 `planProbes` 不考虑协议能力状态和重检时机

**解决方案**: 集成 `ProtocolCapabilityManager.shouldRecheck()`

**新增逻辑**:
- 检查协议是否为 `unsupported` 状态
- 使用 `shouldRecheck()` 判断是否需要重新探测
- 跳过不需要重检的 unsupported 协议
- 标记重检原因为 `'recheck'`

**测试覆盖**:
- ✅ 跳过 unsupported 协议（无重检需要）
- ✅ 包含 unsupported 协议（重检时机到达）

### 2. resolvedRequestMode 处理

**问题**: 已确定使用 chat_completions 后仍然探测 responses

**解决方案**: 检查 `upstream.resolvedRequestMode`

**新增逻辑**:
- 当 `resolvedRequestMode === 'chat_completions'` 时
- 跳过 responses 探测（除非需要重检）
- 直接探测 chat_completions

**测试覆盖**:
- ✅ resolvedRequestMode=chat_completions 时跳过 responses

### 3. 分类器集成

**问题**: 使用硬编码的简单分类逻辑（200 → ok, 其他 → server_error）

**解决方案**: 支持可选的分类器函数注入

**新增功能**:
- 构造函数接受可选的 `classifier` 参数
- `executeProbes` 使用 classifier 分类探测结果
- 提供默认简单分类器作为后备

**测试覆盖**:
- ✅ 使用自定义分类器正确分类 401 为 auth_error

---

## 📊 代码变更

### src/protocol-probe-orchestrator.mjs

**构造函数**:
```javascript
constructor(capabilityManager, probeExecutor, classifier = null) {
  this._capabilityManager = capabilityManager;
  this._probeExecutor = probeExecutor;
  this._classifier = classifier; // 新增
}
```

**planProbes 方法** (~95 行):
- 新增 `needsRecheck()` 辅助函数
- 新增 `shouldSkipProtocol()` 辅助函数
- 读取 `resolvedRequestMode`
- 集成重检策略决策树
- 处理 unsupported 协议跳过逻辑

**executeProbes 方法** (~85 行):
- 新增 `classify()` 辅助函数
- 使用注入的分类器或默认分类器
- 为每个探测结果调用分类器

---

## ✅ 测试结果

### 新增测试（3 个）

1. **planProbes should skip unsupported protocol when no recheck needed**
   - 验证跳过 unsupported + 无需重检的协议

2. **planProbes should include unsupported protocol when recheck is due**
   - 验证包含需要重检的 unsupported 协议
   - 验证 reason 为 'recheck'

3. **planProbes with resolvedRequestMode=chat_completions should skip responses unless recheck**
   - 验证 resolvedRequestMode 优化逻辑

4. **executeProbes should use classifier when provided**
   - 验证自定义分类器集成

### 测试统计

| 测试套件 | 结果 | 说明 |
|---------|------|------|
| protocol-probe-orchestrator.test.mjs | 14/14 ✓ | +4 新测试 |
| smoke-test.mjs | 全部通过 ✓ | 端到端验证 |

---

## 🎯 架构改进

### 之前
```javascript
planProbes(upstream, models, now) {
  // 简单的协议选择
  // 不考虑能力状态
  // 不考虑重检时机
  // 不考虑 resolvedRequestMode
}

executeProbes(...) {
  // 硬编码分类逻辑
  // 200 → ok, 其他 → server_error
}
```

### 之后
```javascript
planProbes(upstream, models, now) {
  // ✅ 检查协议能力状态
  // ✅ 集成重检策略
  // ✅ 处理 resolvedRequestMode
  // ✅ 智能跳过逻辑
}

executeProbes(...) {
  // ✅ 可注入分类器
  // ✅ 精确分类（auth_error, network_error, etc.）
  // ✅ 默认分类器后备
}
```

---

## 🚀 下一步：阶段 2

### 目标

集成状态管理和健康决策逻辑：
1. 集成 `applyProbeResult` 更新健康状态
2. 集成 `openAiProbeDecision` 健康优先级逻辑
3. 处理 resolvedMode 确定
4. 集成 cooldown 和 quota 管理

### 预计工作量

**时间**: 2-3 小时  
**方法**: TDD 继续增量构建

### 推荐策略

**选项 A**: 继续阶段 2（本次会话）
- 继续构建
- 完成更多功能

**选项 B**: 提交阶段 1，稍后继续
- 保存进展
- 分批提交
- 降低风险

**选项 C**: 跳过阶段 2-3，直接集成当前进展
- 使用现有增强的 orchestrator
- 部分替换旧代码
- 渐进式迁移

---

## 📚 关键收获

### TDD 的持续价值

1. **快速反馈**: RED → GREEN 循环保证每个功能正确
2. **回归保护**: 14 个测试持续验证
3. **信心**: 敢于重构，有安全网

### 渐进式增强

1. **向后兼容**: 分类器是可选的，默认行为不变
2. **增量添加**: 一次一个功能，逐步构建
3. **测试驱动**: 先写测试，明确行为

### 深模块演进

`ProtocolProbeOrchestrator` 正在变成一个深模块：
- **接口稳定**: `planProbes` 和 `executeProbes` 签名未变
- **实现增强**: 内部逻辑更智能、更完整
- **职责清晰**: 计划 + 执行 + 分类

---

## 📝 Git 状态

**变更文件**:
- `src/protocol-probe-orchestrator.mjs` (修改 ~180 行)
- `test/protocol-probe-orchestrator.test.mjs` (新增 ~120 行测试)

**测试状态**:
- ✅ 所有单元测试通过
- ✅ Smoke test 通过
- ✅ 向后兼容保持

**推荐**: 可以提交阶段 1 成果

---

**创建者**: Claude Opus 4.8  
**状态**: 阶段 1 完成，待提交或继续阶段 2
