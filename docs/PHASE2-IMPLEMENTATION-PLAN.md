# Phase 2 实施计划：Dashboard 迁移清单

**日期**: 2026-06-14  
**破坏性**: ⚠️ 是（需要修改 Dashboard 代码）

---

## 需要修改的位置（11 处）

### 1. usagePayload 函数 (Line 6216-6230)

**当前**:
```javascript
function usagePayload(stats, today = localDateKey()) {
  const usage = ensureTokenUsage(stats);
  const todayEntry = tokenDailyEntry(usage, today);
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    today_tokens: todayEntry.total_tokens,        // 🔴 Line 6226
    today_input_tokens: todayEntry.input_tokens,  // 🔴 Line 6227
    today_output_tokens: todayEntry.output_tokens,// 🔴 Line 6228
    by_day: { ...usage.byDay },                    // 🔴 Line 6229
    daily: tokenDailyPayload(usage)
  };
}
```

**修改**: 删除 Line 6226-6229

---

### 2. aggregateUsage 函数 (Line 6262-6266)

**位置**: Line ~6231-6280  
**问题**: 这个函数也返回 today_* 和 by_day

需要检查并修改。

---

### 3. Dashboard 总览统计 (Line 10226, 10232, 10235)

**Line 10226**:
```javascript
total: Number(usage.by_day?.[day] || 0),
```

**修改为**:
```javascript
total: Number(usage.daily?.[day]?.total_tokens || 0),
```

**Line 10232**:
```javascript
const days = new Set(Object.keys(data.usage?.daily || {}).concat(Object.keys(data.usage?.by_day || {})));
```

**修改为**:
```javascript
const days = new Set(Object.keys(data.usage?.daily || {}));
```

**Line 10235**:
```javascript
Object.keys(upstream.usage?.by_day || {}).forEach((day) => days.add(day));
```

**修改为**:
```javascript
Object.keys(upstream.usage?.daily || {}).forEach((day) => days.add(day));
```

---

### 4. Dashboard HTML 卡片数据属性 (Line 10560, 10564)

**Line 10560**:
```javascript
u.usage?.today_tokens || 0,
```

**修改为**:
```javascript
u.usage?.daily?.['${today}']?.total_tokens || 0,
```

**Line 10564**:
```javascript
JSON.stringify(u.usage?.by_day || {}),
```

**修改为**:
```javascript
JSON.stringify(Object.fromEntries(Object.entries(u.usage?.daily || {}).map(([d,e]) => [d, e.total_tokens]))),
```

---

### 5. Dashboard 图表渲染 (Line 10606)

**Line 10606**:
```javascript
const entries = Object.entries(upstream.usage?.by_day || {})
```

**修改为**:
```javascript
const entries = Object.entries(upstream.usage?.daily || {}).map(([day, entry]) => [day, entry.total_tokens])
```

---

### 6. Dashboard 动态更新 (Line 10695, 10697-10698)

**Line 10695**:
```javascript
setText(card, '[data-field="today_tokens"]', fmtToken(upstream.usage?.today_tokens));
```

**修改为**:
```javascript
const today = localDateKey();
const todayUsage = upstream.usage?.daily?.[today];
setText(card, '[data-field="today_tokens"]', fmtToken(todayUsage?.total_tokens || 0));
```

**Line 10697-10698**:
```javascript
const todayTokenNode = card.querySelector('[data-field="today_tokens"]');
if (todayTokenNode) todayTokenNode.title = tokenTitle('Today', upstream.usage?.today_tokens);
```

**修改为**:
```javascript
const todayTokenNode = card.querySelector('[data-field="today_tokens"]');
if (todayTokenNode) todayTokenNode.title = tokenTitle('Today', todayUsage?.total_tokens || 0);
```

---

### 7. Dashboard HTML 模板 (Line 10829)

**Line 10829**:
```javascript
<div class="mini-line">Today <strong data-field="today_tokens" title="\${esc(tokenTitle('Today', u.usage?.today_tokens))}">\${fmtToken(u.usage?.today_tokens)}</strong></div>
```

**修改为**:
```javascript
<div class="mini-line">Today <strong data-field="today_tokens" title="\${esc(tokenTitle('Today', u.usage?.daily?.['${today}']?.total_tokens || 0))}">\${fmtToken(u.usage?.daily?.['${today}']?.total_tokens || 0)}</strong></div>
```

但需要 `today` 变量，所以需要在模板渲染前计算。

---

## 辅助函数

在 Dashboard HTML 中添加辅助函数：

```javascript
function getTodayUsage(usage) {
  const today = new Date().toISOString().split('T')[0];
  return usage?.daily?.[today] || { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
}

function dailyToByDay(usage) {
  return Object.fromEntries(
    Object.entries(usage?.daily || {}).map(([day, entry]) => [day, entry.total_tokens])
  );
}
```

---

## 修改优先级

### P0 - 必须修改（否则 Dashboard 报错）

1. **usagePayload** (Line 6226-6229) - API 输出函数
2. **aggregateUsage** (Line 6262-6266) - 聚合函数
3. **Dashboard 动态更新** (Line 10695, 10697-10698) - 运行时更新

### P1 - 应该修改（否则功能异常）

4. **Dashboard HTML 模板** (Line 10829) - 初始渲染
5. **Dashboard 图表** (Line 10606) - 图表渲染
6. **Dashboard 总览** (Line 10226, 10232, 10235) - 统计汇总

### P2 - 可选修改（性能优化）

7. **Dashboard 数据属性** (Line 10560, 10564) - 数据缓存

---

## 实施策略

### 选项 A: 一次性迁移（推荐）

**步骤**:
1. 修改 usagePayload 和 aggregateUsage
2. 在 Dashboard HTML 中添加辅助函数
3. 更新所有 Dashboard 引用
4. 重启服务
5. 测试所有功能

**优点**: 一次性完成，彻底清理
**缺点**: 修改点多，需要仔细测试

---

### 选项 B: 向后兼容过渡

**步骤**:
1. usagePayload 同时返回新旧字段
2. Dashboard 优先使用新字段，fallback 到旧字段
3. 运行一段时间后删除旧字段

**优点**: 更安全，可以逐步迁移
**缺点**: 过渡期仍有冗余

**示例**:
```javascript
function usagePayload(stats, today = localDateKey()) {
  const usage = ensureTokenUsage(stats);
  const todayEntry = tokenDailyEntry(usage, today);
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    // 新字段
    daily: tokenDailyPayload(usage),
    // 旧字段（标记为 deprecated）
    today_tokens: todayEntry.total_tokens,
    today_input_tokens: todayEntry.input_tokens,
    today_output_tokens: todayEntry.output_tokens,
    by_day: { ...usage.byDay }
  };
}
```

然后 Dashboard 使用：
```javascript
const todayData = upstream.usage?.daily?.[today] || {
  total_tokens: upstream.usage?.today_tokens || 0  // fallback
};
```

---

## 决策

**问题**: 选择哪个策略？

**建议**: **选项 A（一次性迁移）**

**理由**:
1. 这是内部项目，没有外部 API 用户
2. Dashboard 是唯一的前端
3. 一次性迁移更干净
4. 过渡期的冗余违背了 Phase 2 的初衷

---

## 风险评估

### 高风险
- ❌ 无（这是内部项目）

### 中风险
- ⚠️ Dashboard 显示错误（可以快速修复）
- ⚠️ 图表不显示（可以快速修复）

### 低风险
- ✅ API 响应格式变化（预期内）
- ✅ 持久化不受影响（stats.tokenUsage 不变）

---

## 回滚方案

如果出现问题：

```bash
# 方案 1: Git 回滚
git log --oneline -5
git revert <commit-hash>
pkill -f "node.*server.mjs"

# 方案 2: 恢复备份
git checkout HEAD~1 src/server.mjs
pkill -f "node.*server.mjs"
```

---

## 准备好了吗？

**问题清单**:
- [x] 了解所有需要修改的位置（11 处）
- [x] 选择实施策略（选项 A）
- [x] 准备好回滚方案
- [ ] 开始实施

**下一步**: 开始修改代码

