# 架构优化 - 任务 2 复杂度评估

**日期**: 2026-06-14  
**任务**: Probe Orchestrator 集成  
**状态**: ⚠️ 需要重新评估范围

---

## 🔍 发现的复杂性

### 现有探测逻辑分析

**位置**: `src/server.mjs` lines 8380-8510 (~130 lines)

**复杂度因素**:

1. **协议选择逻辑**
   - `api` 配置（openai/anthropic/both）
   - `requestMode` 覆盖（auto/responses/chat_completions）
   - `resolvedRequestMode` 状态管理

2. **重检策略**
   - `shouldRecheckProtocolCapability()` 检查
   - 每个协议的独立重检逻辑
   - 时间窗口管理

3. **Fallback 决策树**
   ```
   if anthropic + claude_model:
     probe anthropic_messages
   
   if openai + non_claude_model:
     if requestMode === 'chat_completions':
       probe chat only
     else:
       probe responses
       if fails:
         probe chat as fallback
         compare results (openAiProbeDecision)
   ```

4. **状态管理**
   - `upstream.resolvedRequestMode` 更新
   - `upstream.cooldownUntil` / `key.cooldownUntil` 重置
   - `recordProtocolCapabilityProbe()` 记录
   - `applyQuota()` 配额处理

5. **特殊情况**
   - Codex OAuth 单独处理
   - 模型发现和选择
   - 健康状态优先级
   - Warning vs Error 区分

---

## 📊 当前 Orchestrator 状态

**已实现**:
- ✅ 基本接口定义
- ✅ `HttpProbeExecutor` 包装
- ✅ 简单的 `planProbes()` 和 `executeProbes()`

**缺失**:
- ❌ 重检策略集成
- ❌ `requestMode` / `resolvedRequestMode` 处理
- ❌ 复杂的 fallback 决策
- ❌ `openAiProbeDecision` 逻辑
- ❌ 状态更新和记录逻辑
- ❌ 特殊情况处理

---

## ⏱️ 工作量重新评估

### 原始估计
- **估计**: 3-4 小时
- **基于**: 简单的逻辑提取假设

### 实际评估
- **实际**: 8-12 小时
- **原因**: 
  - 130 行高度耦合的代码
  - 多个边界情况
  - 状态管理分散
  - 需要完整的测试覆盖

### 工作细分
1. **扩展 Orchestrator**（4-5h）
   - 添加重检策略支持
   - 实现完整的 fallback 逻辑
   - 处理 requestMode/resolvedRequestMode
   - 集成 openAiProbeDecision

2. **状态管理分离**（2-3h）
   - 提取状态更新逻辑
   - 处理配额和记录
   - 管理 cooldown 重置

3. **测试覆盖**（2-3h）
   - 单元测试所有路径
   - 集成测试
   - 边界情况测试

4. **集成和验证**（1-2h）
   - 替换旧代码
   - Smoke test 验证
   - 手动测试

**总计**: 9-13 小时

---

## 💡 策略建议

### 选项 1：完整重构（推荐）

**时间**: 10-12 小时  
**价值**: 高 - 彻底简化架构

**计划**:
1. 分阶段实现（2-3 个 commits）
2. 保持旧代码直到完全验证
3. 完整测试覆盖

### 选项 2：增量改进（替代）

**时间**: 2-3 小时  
**价值**: 中 - 局部改进

**计划**:
1. 只提取协议选择逻辑
2. 保留 fallback 在原地
3. 渐进式迁移

### 选项 3：延迟任务 2（务实）

**时间**: 0 小时（现在）  
**价值**: 保持动力 - 完成其他任务

**理由**:
- 任务 1 已完成并有价值
- 任务 2 比预期复杂得多
- 可以先完成任务 3（更简单）
- 或者结束当前优化周期

---

## 🎯 建议行动

### 立即行动

**提交当前进度**:
- ✅ 任务 1 完成
- ✅ Smoke test 修复
- ✅ 完整文档

**创建 Issue/TODO**:
- 记录任务 2 的复杂性
- 留待未来处理
- 保留 orchestrator 代码供参考

### 下一步选择

**A. 继续任务 3**（推荐）
- 更简单（预计 1-2h）
- 快速获得价值
- 保持动力

**B. 完整任务 2**
- 需要完整的 10-12 小时投入
- 分多个 session 完成
- 需要新的详细计划

**C. 结束优化周期**
- 当前成果已有价值
- 稍后继续任务 2 和 3

---

## 📝 经验总结

### 学到的教训

1. **评估要看实际代码**
   - 不要只看函数名
   - 要看完整实现

2. **耦合代码难以提取**
   - 130 行嵌套逻辑
   - 多个副作用
   - 状态管理分散

3. **增量迁移更安全**
   - 先提取简单部分
   - 逐步迁移复杂逻辑
   - 保持向后兼容

---

你想要：
1. **继续任务 3**（Probe Result Applicator 合并，~1-2h）？
2. **投入任务 2 完整重构**（~10-12h，分多个 session）？
3. **结束当前优化周期，提交成果**？
