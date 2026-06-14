# Phase 3 实施计划：压缩 availability.recent 为位串

**日期**: 2026-06-14  
**方案**: 压缩为位串（方案 2）  
**状态**: 准备实施

---

## Dashboard 使用情况

### 使用场景 1: 显示历史点图（Line 10448-10459）

```javascript
const history = Array.isArray(availability.recent) ? availability.recent.slice(-windowSize) : [];
const dots = [
  ...history.map((ok) => `<span class="availability-dot ${ok ? 'is-success' : 'is-failure'}"></span>`),
  ...Array.from({ length: emptyCount }, () => '<span class="availability-dot is-empty"></span>')
].join('');
```

**用途**: 渲染 50 个可用性指示点（绿点/红点）

---

### 使用场景 2: 数据属性（Line 10580）

```javascript
(u.availability?.recent || []).map((value) => value ? '1' : '0').join('')
```

**用途**: 转换为位串存储在 data 属性中

**发现**: 数据属性已经在使用位串格式了！

---

## 实施方案

### API 层修改

**当前输出**:
```json
{
  "recent": [true, false, true, ..., false]  // 50 个布尔值
}
```

**修改后**:
```json
{
  "recent": "110111...000"  // 50 个字符的位串
}
```

---

### Dashboard 层修改

#### 1. 历史点图渲染（Line 10448-10453）

**当前**:
```javascript
const history = Array.isArray(availability.recent) ? availability.recent.slice(-windowSize) : [];
const dots = [
  ...history.map((ok) => `<span class="availability-dot ${ok ? 'is-success' : 'is-failure'}"></span>`),
  ...Array.from({ length: emptyCount }, () => '<span class="availability-dot is-empty"></span>')
].join('');
```

**修改为**:
```javascript
const history = typeof availability.recent === 'string' 
  ? availability.recent.slice(-windowSize).split('').map(c => c === '1')
  : (Array.isArray(availability.recent) ? availability.recent.slice(-windowSize) : []);
const dots = [
  ...history.map((ok) => `<span class="availability-dot ${ok ? 'is-success' : 'is-failure'}"></span>`),
  ...Array.from({ length: emptyCount }, () => '<span class="availability-dot is-empty"></span>')
].join('');
```

---

#### 2. 数据属性（Line 10580）

**当前**:
```javascript
(u.availability?.recent || []).map((value) => value ? '1' : '0').join('')
```

**修改为**:
```javascript
typeof u.availability?.recent === 'string' 
  ? u.availability.recent 
  : ((u.availability?.recent || []).map((value) => value ? '1' : '0').join(''))
```

或者更简单（因为 API 已经是位串）:
```javascript
u.availability?.recent || ''
```

---

## 实施步骤

### 1. 修改 availabilitySummary 函数

**位置**: 需要找到生成 availability 对象的函数

```bash
grep -n "function.*availability\|const.*availability.*=" src/server.mjs | grep -i summary
```

---

### 2. 修改输出格式

**当前**:
```javascript
return {
  // ...
  recent: samples.slice(-windowSize)  // 数组
};
```

**修改为**:
```javascript
return {
  // ...
  recent: samples.slice(-windowSize).map(s => s ? '1' : '0').join('')  // 位串
};
```

---

### 3. 更新 Dashboard 解析

如上所述，添加兼容逻辑。

---

## 预期收益

### 响应体积

**当前**:
```json
"recent": [true, false, true, ..., false]
// 估算: ~250 bytes (50 个布尔值 + JSON 格式)
```

**修改后**:
```json
"recent": "1101...0"
// 估算: ~55 bytes (50 个字符 + 引号)
```

**单个上游减少**: ~195 bytes (~78%)

**20 个上游减少**: ~3,900 bytes (~3.9 KB)

**占总响应**: ~2.2%

---

### 总体效果（Phase 1 + 2 + 3）

```
原始:    11,946 bytes  (100%)
Phase 1: 9,279 bytes   (77.7%) -2,667 bytes (-22.3%)
Phase 2: 9,043 bytes   (75.7%) -  236 bytes (- 2.0%)
Phase 3: 8,848 bytes*  (74.1%) -  195 bytes (- 2.2%)
─────────────────────────────────────────────────────
总减少:  3,098 bytes            (-25.9%)

* 预估值
```

---

## 破坏性评估

### ⚠️ 破坏性变更

**影响范围**:
- 前端直接访问 `availability.recent` 并期望数组的代码

**本项目影响**: 低
- Dashboard 有两处使用（已知，可修复）
- 数据属性已经在使用位串

**外部影响**: 低
- 外部脚本需要解析位串而非数组
- 迁移简单: `.split('').map(c => c === '1')`

---

## 向后兼容方案

**Dashboard 代码支持两种格式**:
```javascript
const history = typeof availability.recent === 'string' 
  ? availability.recent.slice(-windowSize).split('').map(c => c === '1')
  : (Array.isArray(availability.recent) ? availability.recent.slice(-windowSize) : []);
```

**优点**:
- 兼容新旧两种格式
- 平滑过渡

---

## 测试清单

- [ ] API 响应格式正确（位串）
- [ ] Dashboard 历史点图显示正常
- [ ] 数据属性正常
- [ ] 所有 20 个上游一致
- [ ] 响应体积减少验证

---

## 决策

**问题**: 是否立即实施 Phase 3？

**建议**: ✅ 立即实施

**理由**:
1. ✅ 收益明确（~2.2% 额外减少）
2. ✅ 实施简单（只修改几行代码）
3. ✅ 风险低（Dashboard 只有 2 处使用）
4. ✅ 向后兼容（支持两种格式）

---

**下一步**: 找到 availabilitySummary 函数并修改
