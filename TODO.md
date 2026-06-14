# 架构优化待办事项

**创建日期**: 2026-06-14  
**最后更新**: 2026-06-14  
**状态**: 进行中

---

## 📋 任务清单

### ✅ 任务 0：修复 Smoke Test（已完成）

**状态**: ✅ 完成  
**时间**: ~1 小时  
**Commit**: `e38def7`

**内容**:
- 修复过时的 API 字段路径
- `.stats.attempts` → `.attempts`
- `.usage.today_tokens` → `.usage.daily[today]`
- 所有 smoke tests 通过

---

### ✅ 任务 1：提取路由决策树模块（已完成）

**状态**: ✅ 完成  
**时间**: ~3 小时  
**Commit**: `290008c`

**交付**:
- `src/request-routing-rules.mjs` (200 行)
- `test/request-routing-rules.test.mjs` (120 行)
- 7 个单元测试（全部通过）

**价值**:
- 6+ 分散函数 → 1 个深模块
- 完整测试覆盖
- 清晰的职责边界

**未完成部分**:
- ⏸️ 集成到 server.mjs（延迟到最终集成阶段）
- ⏸️ 删除旧函数（保持向后兼容）

---

### ⏳ 任务 2：Probe Orchestrator 集成（待完成）

**状态**: ⏸️ 暂停（复杂度高于预期）  
**预计时间**: 10-12 小时（原估计 3-4h）  
**优先级**: 中  
**难度**: ⭐⭐⭐⭐⭐ 高

#### 目标

简化探测协调逻辑，从 130 行嵌套代码 → ~30 行 orchestrator 调用。

#### 当前状态

**已有基础**:
- ✅ `src/protocol-probe-orchestrator.mjs` 基础实现
- ✅ `ProbeExecutor` 接口定义
- ✅ `HttpProbeExecutor` 包装类

**需要完成**:
1. **扩展 Orchestrator**（4-5h）
   - 添加重检策略支持 (`shouldRecheckProtocolCapability`)
   - 实现完整的 fallback 逻辑
   - 处理 `requestMode` / `resolvedRequestMode`
   - 集成 `openAiProbeDecision` 逻辑

2. **状态管理分离**（2-3h）
   - 提取状态更新逻辑
   - 处理配额和记录 (`applyQuota`, `recordProtocolCapabilityProbe`)
   - 管理 cooldown 重置

3. **测试覆盖**（2-3h）
   - 单元测试所有路径
   - 集成测试
   - 边界情况测试

4. **集成和验证**（1-2h）
   - 在 `probeOneUpstream` 中使用 orchestrator
   - 删除旧的嵌套逻辑（lines 8380-8510）
   - Smoke test 验证
   - 手动测试

#### 复杂度因素

**位置**: `src/server.mjs` lines 8380-8510 (~130 lines)

**难点**:
1. 协议选择逻辑（api: openai/anthropic/both）
2. 重检策略（每个协议独立）
3. Fallback 决策树（responses → chat → compare）
4. 状态管理（resolvedMode, cooldown, quota）
5. 特殊情况（Codex OAuth, 模型发现）

#### 详细文档

📄 `docs/TASK2-COMPLEXITY-ASSESSMENT.md` - 完整分析

#### 策略选项

**选项 A**: 完整重构（推荐）
- 时间: 10-12h
- 价值: 高 - 彻底简化
- 分阶段实现

**选项 B**: 增量改进
- 时间: 2-3h
- 价值: 中 - 局部改进
- 只提取协议选择

**选项 C**: 延迟处理
- 保留现状
- 优先完成其他任务

---

### ⏳ 任务 3：合并 Probe Result Applicator（待完成）

**状态**: ⏸️ 待开始  
**预计时间**: 1-2 小时  
**优先级**: 高（快速胜利）  
**难度**: ⭐⭐⭐ 中等

#### 目标

消除浅模块，将 `probe-result-applicator.mjs` 的功能合并到 `protocol-capability-manager.mjs`。

#### 当前状态

**问题**:
- `probe-result-applicator.mjs` 是浅模块
- 接口复杂度 ≈ 实现复杂度
- 功能与 `ProtocolCapabilityManager` 重叠

**解决方案**:
1. 将 applicator 逻辑合并到 manager
2. 统一职责边界
3. 删除独立的 applicator 文件

#### 工作步骤

1. **分析当前代码**（15min）
   - 查看 `probe-result-applicator.mjs`
   - 查看 `protocol-capability-manager.mjs`
   - 识别重叠和差异

2. **合并逻辑**（30-45min）
   - 将 applicator 方法移到 manager
   - 调整方法签名
   - 保持向后兼容

3. **更新调用点**（15-30min）
   - 替换 applicator 调用
   - 使用 manager 方法

4. **测试验证**（15-30min）
   - 运行 smoke tests
   - 手动测试探测功能

5. **清理**（5min）
   - 删除 `probe-result-applicator.mjs`
   - 更新 imports

#### 推荐理由

- ✅ 时间短（1-2h）
- ✅ 快速胜利
- ✅ 立即价值
- ✅ 保持动力

---

### ⏳ 最终集成：清理和整合（待完成）

**状态**: ⏸️ 等待任务 1-3 完成  
**预计时间**: 2-3 小时  
**优先级**: 最后  
**难度**: ⭐⭐⭐ 中等

#### 目标

替换所有旧函数，删除冗余代码，完成架构迁移。

#### 工作内容

1. **任务 1 集成**（1h）
   - 在 `createPoolServer` 中实例化 `RequestRoutingRules`
   - 替换所有旧函数调用
   - 删除旧函数定义
   - 验证行为一致性

2. **任务 2 集成**（30min-1h）
   - 已在任务 2 中完成
   - 可能需要额外清理

3. **任务 3 集成**（30min）
   - 已在任务 3 中完成
   - 可能需要额外清理

4. **完整验证**（30min-1h）
   - 运行所有 smoke tests
   - 运行所有单元测试
   - 手动测试关键路径
   - 性能回归检查

#### 预期结果

- 代码减少 ~500 行
- 架构清晰度提升 50%
- 测试覆盖增加 20+
- 维护成本降低 40%

---

## 📊 进度总览

```
任务 0: ████████████████████ 100% ✅
任务 1: ████████████████████ 100% ✅
任务 2: ░░░░░░░░░░░░░░░░░░░░   0% ⏸️ (评估完成)
任务 3: ░░░░░░░░░░░░░░░░░░░░   0% ⏸️
最终集成: ░░░░░░░░░░░░░░░░░░░░   0% ⏸️

总体进度: ████░░░░░░░░░░░░░░░░  20%
```

---

## ⏱️ 时间估算

| 项目 | 已用 | 待用 | 总计 |
|------|------|------|------|
| 任务 0 | 1h | - | 1h |
| 任务 1 | 3h | - | 3h |
| 任务 2 | - | 10-12h | 10-12h |
| 任务 3 | - | 1-2h | 1-2h |
| 最终集成 | - | 2-3h | 2-3h |
| **总计** | **4h** | **13-17h** | **17-21h** |

---

## 🎯 推荐路径

### 下次会话

**推荐顺序 A**（快速胜利优先）:
1. 任务 3（1-2h）← 推荐先做
2. 任务 2（10-12h）
3. 最终集成（2-3h）

**推荐顺序 B**（彻底重构）:
1. 任务 2（10-12h，分 2-3 个 session）
2. 任务 3（1-2h）
3. 最终集成（2-3h）

### 启动命令

```bash
# 查看此文件
cat TODO.md

# 开始任务 3
cat docs/TASK2-COMPLEXITY-ASSESSMENT.md  # 先了解背景
# 然后说："开始任务 3：合并 Probe Result Applicator"

# 开始任务 2
cat docs/TASK2-COMPLEXITY-ASSESSMENT.md  # 详细阅读
# 然后说："开始任务 2：Probe Orchestrator 集成"
```

---

## 📚 相关文档

| 文档 | 内容 |
|------|------|
| `SESSION-FINAL-SUMMARY.md` | 本次会话完整总结 |
| `docs/ARCHITECTURE-OPTIMIZATION-STATUS.md` | 策略和决策 |
| `docs/TASK2-COMPLEXITY-ASSESSMENT.md` | 任务 2 详细分析 |
| `docs/ARCHITECTURE-OPTIMIZATION-FINAL.md` | 完整实施计划 |
| `docs/SESSION-SUMMARY-2026-06-14.md` | 技术细节 |

---

## 🏆 价值评估

| 任务 | ROI | 优先级 | 说明 |
|------|-----|--------|------|
| 任务 0 | ⭐⭐⭐⭐⭐ | 最高 | 解除阻塞 ✅ |
| 任务 1 | ⭐⭐⭐⭐ | 高 | 深模块实践 ✅ |
| 任务 3 | ⭐⭐⭐⭐ | 高 | 快速胜利 ⏸️ |
| 任务 2 | ⭐⭐⭐ | 中 | 高投入/高回报 ⏸️ |
| 最终集成 | ⭐⭐⭐⭐⭐ | 最后 | 完成循环 ⏸️ |

---

**创建者**: Claude Opus 4.8  
**维护**: 每次会话后更新  
**下次更新**: 任务 2 或 3 完成后
