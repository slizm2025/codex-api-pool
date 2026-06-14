# Phase 3 分析：精简 availability.recent 字段

**日期**: 2026-06-14  
**状态**: 分析中

---

## 当前 availability 结构

```json
{
  "window_size": 50,
  "min_samples": 10,
  "samples": 50,
  "successes": 41,
  "failures": 9,
  "rate": 0.82,
  "multiplier": 0.65,
  "recent": [
    true, true, true, true, true, true, true, true, true, true,
    true, true, true, true, true, true, true, true, true, true,
    true, true, true, true, true, true, true, true, true, true,
    true, true, true, true, true, true, true, true, true, true,
    true, false, false, false, false, false, false, false, false
  ]
}
```

---

## 问题分析

### 体积占用

**recent 数组**:
- 50 个布尔值
- JSON 序列化: `[true, false, ...]`
- 估算: ~250-300 bytes

**占 availability 对象的比例**: 约 60-70%

---

## 优化方案

### 方案 1: 删除 recent 字段 ❌

**优点**: 
- 最大化减少体积（~250 bytes per upstream）

**缺点**:
- Dashboard 可能使用 recent 显示历史趋势
- 丢失详细的请求历史信息

**风险**: 高（需要检查 Dashboard 是否使用）

---

### 方案 2: 压缩为位串 ✅

**方案**: `[true, false, true, ...] → "10110..."`

```json
{
  "recent": "11111111111111111111111111111111111111110000000000"
}
```

**优点**:
- 保留完整信息
- 减少约 40% 体积（300 → 180 bytes）

**缺点**:
- 前端需要解析位串

---

### 方案 3: 趋势标识 ⚠️

**方案**: 只保留趋势信息，不保留完整历史

```json
{
  "trend": "up",              // up/down/stable
  "recent_successes": 8,      // 最近 10 次成功数
  "recent_failures": 2        // 最近 10 次失败数
}
```

**优点**:
- 极大减少体积（300 → 50 bytes）

**缺点**:
- 丢失详细历史
- Dashboard 无法显示完整曲线

**风险**: 中等

---

## Dashboard 使用检查

让我检查 Dashboard 中是否使用了 `recent` 字段：

```bash
grep -n "\.recent" src/server.mjs | grep -v "recent_requests"
```

---

## 预期收益

### 方案 1: 删除 recent

```
单个上游: -250 bytes
20 个上游: -5,000 bytes (-5 KB)
占总响应: -2.8%
```

### 方案 2: 压缩为位串

```
单个上游: -120 bytes
20 个上游: -2,400 bytes (-2.4 KB)
占总响应: -1.3%
```

### 方案 3: 趋势标识

```
单个上游: -250 bytes
20 个上游: -5,000 bytes (-5 KB)
占总响应: -2.8%
```

---

## 决策点

**问题**: 
1. Dashboard 是否使用 `recent` 字段？
2. 如果使用，如何显示？
3. 用户是否需要详细的历史趋势？

**下一步**: 检查 Dashboard 代码

---

## 检查 Dashboard 使用情况

```bash
grep -n "availability.*recent\|recent.*availability" src/server.mjs
```

需要找到：
1. 是否有代码访问 `availability.recent`
2. 如何使用这个数据（图表？趋势？）
3. 是否可以用其他方式替代

---

**状态**: 等待 Dashboard 使用情况分析
