# Phase 3 完成报告：验证分层显示问题修复

**日期**: 2026-06-14  
**诊断工具**: Claude Code (Opus 4.8) - /diagnose skill  
**问题来源**: 用户反馈

---

## 问题描述

当用户点击"筛选所有模型"时，Claude 模型的上游虽然可用且已通过真实请求验证，但没有显示在"真实请求验证"（real_verified）层级中，而是出现在"一层检测通过"（probe_only）或更低的层级。

---

## 诊断过程

### Phase 1: 构建反馈循环

创建了三个测试脚本：
1. `test-verification-tier.mjs` - 验证分层逻辑基本正确性
2. `test-availability-logic.mjs` - 诊断 available 字段计算
3. `test-fix-verification.mjs` - 验证修复方案

### Phase 2: 问题复现

通过测试脚本和实际 API 调用确认：
- 设置 model override 为 `gpt-5.5` 时，GPT 上游显示为 real_verified ✓
- 清除 model override 后，所有上游都降级到 probe_only ✗
- 实际查询显示 `representative_availability.verified = false`

### Phase 3: 根因分析

定位到 `server.mjs:1176`:

```javascript
const item = normalizedModel ? byModel[normalizedModel] : null;
if (!item) continue;
```

**根本原因**:
- 当 `normalizedModel` 为空字符串时（无 model override）
- `item` 被赋值为 `null`
- 循环 `continue`，不收集任何证据
- `evidence` 数组保持为空
- `verified` 被设置为 `false`

### Phase 4: 设计修复方案

**选择方案**: 聚合模式
- 当 model override 为空时，聚合所有模型的证据
- 只要有任何模型的新鲜证据，就设置 `verified = true`
- 添加 `aggregated` 标志以区分模式

**拒绝方案**:
- 使用最近模型证据：信息丢失
- 添加独立字段：增加复杂度
- 总是要求 model override：破坏用户体验

---

## 实施的修复

### 代码变更

**文件**: `src/server.mjs`  
**函数**: `representativeAvailability()` (lines 1167-1206)

**修改内容**:

```javascript
// 修改前
const item = normalizedModel ? byModel[normalizedModel] : null;
if (!item) continue;

// 修改后
if (normalizedModel) {
  // 特定模型模式
  const item = byModel[normalizedModel];
  if (!item) continue;
  // ... 收集特定模型的证据
} else {
  // 聚合模式：收集所有模型的证据
  for (const [modelName, item] of Object.entries(byModel)) {
    if (!item) continue;
    evidence.push({
      keyLabel: key.label || '',
      modelName: modelName,  // 新增：跟踪模型名称
      source: String(item.source || ''),
      checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
      fresh: representativeEvidenceFresh(item, at)
    });
  }
}
```

**返回值变更**:
- 新增 `aggregated: boolean` 字段，指示是否为聚合模式
- 证据项新增 `modelName` 字段（仅聚合模式）

---

## 测试结果

### 单元测试 (test-fix-verification.mjs)

✅ **Scenario 1: Model Override = gpt-5.5**
- Claude upstream: probe_only (正确，无该模型证据)
- GPT upstream: real_verified (正确，有该模型证据)

✅ **Scenario 2: No Model Override (聚合)**
- Claude upstream: real_verified (✅ 修复成功)
- GPT upstream: real_verified (✅ 修复成功)
- Mixed upstream: real_verified (✅ 聚合新鲜证据)

✅ **Scenario 3: Model Override = claude-opus-4-8**
- Claude upstream: real_verified (正确，有该模型证据)
- GPT upstream: probe_only (正确，无该模型证据)

### 回归测试 (npm run smoke)

✅ **所有测试通过**:
- auth guard, fallback, upstream enable toggle
- token usage accounting, availability scoring
- JSON import, model discovery, model override
- per-protocol representative model selection
- **无回归**

---

## 行为变化对比

| 场景 | Model Override | 修复前 | 修复后 |
|------|---------------|--------|--------|
| 1 | `gpt-5.5` | GPT: real_verified<br>Claude: probe_only | ✅ 无变化 |
| 2 | `(空)` | 所有: probe_only ❌ | GPT: real_verified<br>Claude: real_verified ✅ |
| 3 | `claude-opus-4-8` | Claude: real_verified<br>GPT: probe_only | ✅ 无变化 |

---

## 用户体验改进

### 修复前
1. 用户配置多个上游（Claude + GPT）
2. 设置 model override 并发送请求
3. 两类上游都成功服务真实流量
4. 点击"筛选所有模型"
5. ❌ 真实请求验证层级为空
6. ❌ 无法看到哪些上游已验证

### 修复后
1. 用户配置多个上游（Claude + GPT）
2. 设置 model override 并发送请求
3. 两类上游都成功服务真实流量
4. 点击"筛选所有模型"
5. ✅ 真实请求验证层级显示所有已验证上游
6. ✅ 一目了然的全局验证状态

---

## 技术设计亮点

1. **最小侵入性**: 仅修改一个函数的内部逻辑
2. **向后兼容**: API 扩展而非修改，现有字段保持不变
3. **语义清晰**: `aggregated` 字段明确标识模式
4. **性能友好**: 只在需要时迭代模型
5. **可调试性**: 聚合证据保留 `modelName` 便于追踪

---

## 文档产出

1. **DIAGNOSIS_REPORT.md** - 问题诊断完整报告
2. **FINAL_ANALYSIS.md** - 最终分析和修复说明
3. **docs/VERIFICATION_TIER_STRATEGY.md** - 分层策略详细文档
4. **docs/PHASE3-COMPLETION-REPORT.md** - 本报告

---

## 遗留文件（可删除）

- `test-verification-tier.mjs` - 测试脚本
- `test-availability-logic.mjs` - 测试脚本
- `test-fix-verification.mjs` - 测试脚本
- `DIAGNOSIS_STATUS_VOCABULARY_OLD.md` - 旧备份
- `FINAL_ANALYSIS_OLD.md` - 旧备份

---

## 下一步建议

### 短期
1. ✅ 修复已完成并测试通过
2. 建议部署并观察生产环境表现
3. 监控用户反馈

### 中期
1. 考虑在 UI 中显示聚合状态提示
   - Tooltip: "已验证 3 个模型：claude-opus-4-8, gpt-5.5, ..."
2. 添加每个模型的详细验证时间

### 长期
1. 考虑可配置的证据新鲜度窗口
2. 为不同协议设置不同的新鲜度阈值
3. 探索更细粒度的验证状态展示

---

## 总结

通过系统的诊断流程（/diagnose skill），成功定位并修复了验证分层显示问题。修复方案：

- ✅ 解决了根本原因
- ✅ 保持了现有行为的兼容性
- ✅ 通过了所有测试
- ✅ 符合用户预期
- ✅ 代码清晰且可维护

问题修复完成，可以合并到主分支。

---

**诊断者**: Claude Code (Opus 4.8)  
**完成时间**: 2026-06-14
