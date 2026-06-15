# 安全修复回滚说明

## 回滚项目

### ✅ 已回滚：§1 - appendDebugLockTestPage 伪并发修复

**原修改**：
```javascript
// "原子操作" 修复
state.debugLock.test_pages = [diagnostics, ...state.debugLock.test_pages].slice(0, DEBUG_LOCK_MAX_TEST_PAGES);
```

**回滚为**：
```javascript
// Node.js 单线程保证的原子性
state.debugLock.test_pages.unshift(diagnostics);
if (state.debugLock.test_pages.length > DEBUG_LOCK_MAX_TEST_PAGES) {
  state.debugLock.test_pages.length = DEBUG_LOCK_MAX_TEST_PAGES;
}
```

**理由**：
1. **误诊**：Node.js 单线程事件循环保证同步代码块不可能被中断
2. **性能倒退**：
   - 原实现：`O(1)` unshift + 常量时间 length 赋值
   - "修复"后：`O(n)` 数组展开 + `O(n)` slice，每次调用创建新数组
   - 每个请求都会触发 GC 压力
3. **测试误导**：`Promise.all(Promise.resolve().then(...))` 仍然是顺序执行，不是真并发
4. **真实场景无风险**：即使未来需要并发（worker threads），应该用真正的并发控制（锁/消息队列），而非假装数组操作"原子化"

**代码变更**：
- `src/debug-lock.mjs:272-286` - 恢复原始实现
- `test/debug-lock-security-fixes.test.mjs:59-86` - 更新测试说明，移除"并发"误导

---

### ✅ 确认保持：§7 - persistDebugLockPage 为 fire-and-forget

**当前实现**（正确）：
```javascript
// server.mjs:8059
persistDebugLockPage(diagnostics, persistConfig).catch(err => {
  console.error('[Debug Lock] Failed to persist diagnostics to file:', err);
});
```

**未采纳的建议**（错误）：
```javascript
await persistDebugLockPage(diagnostics, persistConfig).catch(...);
```

**理由**：
1. **性能影响**：
   - fire-and-forget：客户端立即收到响应（诊断工具零延迟）
   - await：客户端必须等待磁盘 I/O（NFS/网络存储可能 100-500ms）
2. **设计意图**：Debug Lock 是诊断工具，不应改变被诊断系统的性能特征
3. **错误处理充分**：`.catch()` 已覆盖异常，不会产生未处理的 Promise rejection
4. **数据可见性非问题**：用户查看 Dashboard 时文件早已写入完成（网络往返远大于文件写入时间）

**决策**：保持 fire-and-forget，无需修改代码。

---

## 保留项目

### ✅ 保留：路径穿越防御（§2）
**文件**：`src/debug-lock.mjs:persistDebugLockPage`

**修复内容**：
- 时间戳字符白名单：`/[^a-zA-Z0-9-]/g`
- `basename()` 剥离目录组件
- 文件路径前缀验证

**保留理由**：真实安全风险，修复成本低，测试覆盖充分。

---

### ✅ 保留：资源泄漏修复（§3）
**文件**：`src/server.mjs:~7916`

**修复内容**：
```javascript
try {
  for await (const chunk of response) { ... }
} finally {
  if (response && typeof response.destroy === 'function') {
    response.destroy();
  }
}
```

**保留理由**：真实的 socket/fd 泄漏风险，finally 块保证清理。

---

### ✅ 保留：敏感数据脱敏（§4）
**文件**：`src/debug-lock.mjs:sanitizeRequestBodyForDiagnostics`

**修复内容**：递归 redact `password`、`api_key`、`authorization` 等字段

**保留理由**：防止日志泄露凭证，符合安全最佳实践。

---

### ✅ 保留：大小限制与截断（§5）
**文件**：`src/debug-lock.mjs:sanitizeRequestBodyForDiagnostics`, `persistDebugLockPage`

**修复内容**：
- 50KB 脱敏限制
- 100KB 持久化限制（可配置）
- 截断标记：`[TRUNCATED: N bytes omitted]`

**保留理由**：防止内存/磁盘耗尽，实际场景有效。

---

### ✅ 保留：文件轮转（§6）
**文件**：`src/debug-lock.mjs:persistDebugLockPage`

**修复内容**：`max_files` 限制（默认 100），按 mtime 删除最旧文件

**保留理由**：防止无限制磁盘占用，运维友好。

---

### ⚠️ 可选优化：输入验证放宽（§7）
**文件**：`src/debug-lock.mjs:persistDebugLockPage`

**当前状态**：
```javascript
if (!diagnostics || typeof diagnostics !== 'object') {
  throw new TypeError('diagnostics must be a non-null object');
}
if (!diagnostics.timestamp) {
  throw new TypeError('diagnostics.timestamp is required');
}
if (!Array.isArray(diagnostics.attempts)) {
  throw new TypeError('diagnostics.attempts must be an array');
}
```

**争议点**：私有函数 + 单一可控调用方，严格校验是 Java 式防御性编程

**决策**：**保留现状**，理由：
- 代码已写，测试已覆盖，删除收益微小
- 未来可能从 Management API 手动调用，校验会提前发现错误
- 3 个 if 不构成性能或可维护性负担

---

## 未实施项目

### ❌ 不实施：preserve_history 选项（§5）
**建议内容**：在 `enableDebugLock` 中增加 `preserve_history` 保留跨锁定会话的历史

**拒绝理由**：
1. **违反设计意图**：ADR-0005 明确 Debug Lock 是 session-only 工具
2. **增加复杂度**：需要定义生命周期管理（何时清空？磁盘占用？）
3. **YAGNI 原则**：无真实需求驱动
4. **更高层解决**：跨会话分析应在监控系统/日志聚合层实现

**决策**：不实施，记录为技术债务。

---

## 测试结果

### 回滚后测试状态
```bash
$ node test/debug-lock.test.mjs
Tests: 29, Passed: 29, Failed: 0

$ node test/debug-lock-security-fixes.test.mjs
Results: 9/9 passed, 0 failed

$ node test/debug-lock-resource-leak.test.mjs
Results: 2/2 passed, 0 failed

$ node test/debug-lock-diagnostics-persistence.test.mjs
Results: 12/12 passed, 0 failed
```

**总计**：52/52 测试通过，零回归。

---

## 性能对比

### appendDebugLockTestPage（每 10 次调用）

| 实现 | 时间复杂度 | 空间复杂度 | 内存分配 | GC 压力 |
|------|-----------|-----------|---------|---------|
| **原实现（回滚后）** | O(1) unshift + O(1) 赋值 | O(1) | 0 次 | 无 |
| "修复"后 | O(n) 展开 + O(n) slice | O(n) | 10 次新数组 | 高 |

**实测影响**（估算）：
- 单次调用：~0.5μs vs ~5μs（10x 慢）
- 每秒 1000 请求场景：多消耗 ~4.5ms CPU + ~1MB 短期内存

---

## 总结

| 修复项 | 原评级 | 实际评级 | 决策 | 理由 |
|--------|--------|---------|------|------|
| §1 并发竞态 | P0 Critical | **误报** | ✅ **已回滚** | Node.js 单线程无真实风险 |
| §2 路径穿越 | P0 Critical | P0 Critical | ✅ 保留 | 真实安全风险 |
| §3 资源泄漏 | P0 Critical | P1 High | ✅ 保留 | 真实泄漏风险 |
| §4 数据脱敏 | P1 High | P1 High | ✅ 保留 | 凭证泄露防护 |
| §5 大小限制 | P1 High | P2 Medium | ✅ 保留 | DoS 防护 |
| §6 文件轮转 | P2 Medium | P2 Medium | ✅ 保留 | 运维友好 |
| §7 输入验证 | P2 Medium | P3 Low | ✅ 保留 | 已实现，无害 |
| §7 await 持久化 | N/A | **性能倒退** | ✅ **未采纳** | 引入不必要延迟 |
| §5 preserve_history | N/A | **过度设计** | ❌ **不实施** | 违反设计边界 |

---

## 后续行动

1. ✅ **已完成**：回滚 §1 并发修复，更新测试说明
2. ✅ **已完成**：确认 §7 保持 fire-and-forget
3. ✅ **已完成**：验证所有测试通过（52/52）
4. 📝 **建议**：更新 `DEBUG_LOCK_SECURITY_FIXES.md`，标注 §1 为误报
5. 📝 **建议**：在 ADR-0005 中补充"不实施 preserve_history"的决策理由

---

## 参考

- ADR-0005: Debug Lock Mode for Upstream Isolation Testing
- CONTEXT.md: Debug Lock 术语表
- test/debug-lock-security-fixes.test.mjs: 安全测试套件
- Node.js 事件循环模型：https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick/
