# Phase 2: 简化 usage 对象 - 分析报告

**日期**: 2026-06-14  
**状态**: 准备实施  

---

## 当前 usage 对象结构

```json
{
  "total_tokens": 54175958,
  "input_tokens": 53960561,
  "output_tokens": 215397,
  
  "today_tokens": 4647504,          // 🔴 与 daily["2026-06-14"].total_tokens 重复
  "today_input_tokens": 4621557,    // 🔴 与 daily["2026-06-14"].input_tokens 重复
  "today_output_tokens": 25947,     // 🔴 与 daily["2026-06-14"].output_tokens 重复
  
  "by_day": {                        // 🔴 与 daily 重复（只有 total）
    "2026-06-11": 22950675,
    "2026-06-12": 17047195,
    "2026-06-13": 9530584,
    "2026-06-14": 4647504
  },
  
  "daily": {                         // ✅ 最完整的数据
    "2026-06-11": {
      "total_tokens": 22950675,
      "input_tokens": 22891187,
      "output_tokens": 59488
    },
    "2026-06-12": {
      "total_tokens": 17047195,
      "input_tokens": 16972114,
      "output_tokens": 75081
    },
    "2026-06-13": {
      "total_tokens": 9530584,
      "input_tokens": 9475703,
      "output_tokens": 54881
    },
    "2026-06-14": {
      "total_tokens": 4647504,
      "input_tokens": 4621557,
      "output_tokens": 25947
    }
  }
}
```

---

## 冗余分析

### 🔴 today_* 字段（3 个）

```javascript
"today_tokens": 4647504,
"today_input_tokens": 4621557,
"today_output_tokens": 25947,
```

**等价于**:
```javascript
daily["2026-06-14"].total_tokens    // 4647504
daily["2026-06-14"].input_tokens    // 4621557
daily["2026-06-14"].output_tokens   // 25947
```

**冗余**: 100%  
**原因**: 完全重复，只是从 daily 中提取今天的数据

---

### 🔴 by_day 字段（对象）

```javascript
"by_day": {
  "2026-06-11": 22950675,
  "2026-06-12": 17047195,
  "2026-06-13": 9530584,
  "2026-06-14": 4647504
}
```

**等价于**:
```javascript
// 从 daily 提取
Object.fromEntries(
  Object.entries(daily).map(([day, entry]) => [day, entry.total_tokens])
)
```

**冗余**: 100%  
**原因**: 只是 daily 的简化版本（只有 total，没有 input/output）

---

## 简化方案

### 目标结构

```json
{
  "total_tokens": 54175958,
  "input_tokens": 53960561,
  "output_tokens": 215397,
  "daily": {
    "2026-06-11": {
      "total_tokens": 22950675,
      "input_tokens": 22891187,
      "output_tokens": 59488
    },
    "2026-06-14": {
      "total_tokens": 4647504,
      "input_tokens": 4621557,
      "output_tokens": 25947
    }
  }
}
```

**删除**:
- `today_tokens`
- `today_input_tokens`
- `today_output_tokens`
- `by_day`

**保留**:
- `total_tokens`（累积总数）
- `input_tokens`（累积输入）
- `output_tokens`（累积输出）
- `daily`（完整的每日数据）

---

## 前端迁移指南

### 获取今日数据

**旧代码**:
```javascript
const todayTokens = upstream.usage.today_tokens;
const todayInput = upstream.usage.today_input_tokens;
const todayOutput = upstream.usage.today_output_tokens;
```

**新代码**:
```javascript
const today = new Date().toISOString().split('T')[0];
const todayData = upstream.usage.daily[today] || {
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0
};
const todayTokens = todayData.total_tokens;
const todayInput = todayData.input_tokens;
const todayOutput = todayData.output_tokens;
```

或者使用辅助函数：
```javascript
function getTodayUsage(usage) {
  const today = new Date().toISOString().split('T')[0];
  return usage.daily[today] || { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
}

const todayTokens = getTodayUsage(upstream.usage).total_tokens;
```

---

### 获取每日总数列表

**旧代码**:
```javascript
const byDay = upstream.usage.by_day;
// { "2026-06-11": 22950675, ... }
```

**新代码**:
```javascript
const byDay = Object.fromEntries(
  Object.entries(upstream.usage.daily).map(([day, entry]) => [day, entry.total_tokens])
);
// { "2026-06-11": 22950675, ... }
```

或者直接使用 daily：
```javascript
Object.entries(upstream.usage.daily).forEach(([day, entry]) => {
  console.log(day, entry.total_tokens);
});
```

---

### 渲染每日图表

**旧代码**:
```javascript
const dates = Object.keys(upstream.usage.by_day);
const values = Object.values(upstream.usage.by_day);
drawChart(dates, values);
```

**新代码**:
```javascript
const dates = Object.keys(upstream.usage.daily);
const values = Object.values(upstream.usage.daily).map(entry => entry.total_tokens);
drawChart(dates, values);
```

---

## Dashboard 代码检查

让我检查 Dashboard 中对 usage 字段的所有引用：

```bash
grep -n "\.usage\." src/server.mjs | grep -E "today_tokens|today_input|today_output|by_day"
```

需要更新的位置：
- Dashboard HTML 模板
- Dashboard 动态更新代码

---

## 实施步骤

### 1. 修改 usagePayload 函数

**位置**: Line 6216

**当前**:
```javascript
function usagePayload(stats, today = localDateKey()) {
  const usage = ensureTokenUsage(stats);
  const todayEntry = tokenDailyEntry(usage, today);
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    today_tokens: todayEntry.total_tokens,        // 🔴 删除
    today_input_tokens: todayEntry.input_tokens,  // 🔴 删除
    today_output_tokens: todayEntry.output_tokens,// 🔴 删除
    by_day: { ...usage.byDay },                    // 🔴 删除
    daily: tokenDailyPayload(usage)
  };
}
```

**修改后**:
```javascript
function usagePayload(stats, today = localDateKey()) {
  const usage = ensureTokenUsage(stats);
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    daily: tokenDailyPayload(usage)
  };
}
```

---

### 2. 检查 Dashboard 引用

搜索所有对这些字段的引用：
```bash
grep -n "today_tokens\|today_input_tokens\|today_output_tokens\|by_day" src/server.mjs
```

---

### 3. 更新 Dashboard 代码

所有使用 `usage.today_tokens` 的地方改为：
```javascript
// 获取今日数据的辅助函数（添加到 Dashboard HTML 中）
function getTodayUsage(usage) {
  const today = new Date().toISOString().split('T')[0];
  return usage.daily[today] || { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
}

// 使用
const todayData = getTodayUsage(upstream.usage);
setText(card, '[data-field="today_tokens"]', fmtToken(todayData.total_tokens));
```

---

### 4. 验证

- [ ] API 响应体积减少
- [ ] Dashboard 显示正常
- [ ] 所有图表正常渲染
- [ ] Smoke test 通过

---

## 预期收益

### 响应体积减少

**当前 usage 对象**: ~800 bytes（假设 30 天数据）
```
- total/input/output: 3 个数字 (60 bytes)
- today_*: 3 个数字 (60 bytes) 🔴 删除
- by_day: 30 个键值对 (300 bytes) 🔴 删除
- daily: 30 个对象 (400 bytes) ✅ 保留
```

**简化后**: ~460 bytes
```
- total/input/output: 3 个数字 (60 bytes)
- daily: 30 个对象 (400 bytes)
```

**减少**: ~340 bytes per upstream (~43%)

对于 20 个 upstreams: **减少 6.8KB**

---

## 破坏性评估

### ⚠️ 破坏性变更

**影响范围**:
- 前端直接访问 `usage.today_tokens` 的代码
- 前端直接访问 `usage.by_day` 的代码

**迁移成本**: 低
- 简单的字段访问替换
- 不影响数据语义
- 迁移代码简单（见上面的迁移指南）

**向后兼容方案**: 无（Phase 2 是破坏性变更）

---

## 决策点

**问题**: 是否立即实施 Phase 2？

**考虑因素**:
1. ✅ 收益明确：减少 43% usage 对象体积
2. ⚠️ 需要前端配合修改
3. ⚠️ 破坏性变更（不向后兼容）
4. ✅ 迁移成本低（简单的字段替换）

**建议**: 
- 如果有前端代码，先检查所有引用
- 准备好迁移代码后再实施
- 或者先在分支中实施，测试后再合并

---

## 下一步

1. **检查 Dashboard 引用** - 找到所有 today_* 和 by_day 的使用
2. **准备迁移代码** - 更新 Dashboard 中的所有引用
3. **修改 usagePayload** - 删除冗余字段
4. **测试验证** - 确保所有功能正常
5. **提交代码** - Phase 2 完成

---

**准备好继续吗？**
