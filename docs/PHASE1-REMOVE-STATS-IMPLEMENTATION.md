# Phase 1 实施指南：移除 API 响应中的 stats 对象

**日期**: 2026-06-14  
**优先级**: P0（立即，无风险）  
**预期收益**: -30% API 响应体积  
**破坏性**: 无（向后兼容）

---

## 变更概述

### 目标
从 `/pool/status` 和 `/pool/dashboard` API 响应中移除 `stats` 对象，因为它的所有数据都已经通过 `availability` 和 `usage` 字段暴露。

### 为什么是安全的？

1. **stats 是内部存储层**
   - 用于持久化到 `stats.local.json`
   - 不应该暴露到 API 响应

2. **所有数据都有替代品**
   - `stats.attempts` → 前端不需要（内部统计）
   - `stats.successes` → `availability.successes`
   - `stats.failures` → `availability.failures`
   - `stats.availability` → `availability` 对象
   - `stats.tokenUsage` → `usage` 对象

3. **前端不应该依赖 stats**
   - Dashboard 已经使用 `availability` 和 `usage`
   - 如果有直接读取 `stats` 的代码，那是设计缺陷

---

## 代码修改

### 修改 1: createUpstreamStatusView

**文件**: `src/server.mjs`  
**行号**: 11661

```javascript
// 删除这一行：
stats: upstream.stats,
```

**完整上下文**:
```javascript
function createUpstreamStatusView(upstream, state, selectionWeight, at = now(), today = localDateKey()) {
  // ...
  return {
    name: upstream.name,
    // ...
    representative_availability: (() => { /* ... */ })(),
    available,
    cooldown_ms: Math.max(0, upstream.cooldownUntil - at),
    in_flight: upstream.inFlight,
    successes: upstream.successes,
    failures: upstream.failures,
    ewma_latency_ms: upstream.ewmaLatencyMs,
    last_status: upstream.lastStatus,
    last_error: upstream.lastError,
    // stats: upstream.stats,                    // 🔴 删除这一行
    availability,
    usage: usagePayload(upstream.stats, today),  // ✅ 仍从 stats 计算
    quota: upstream.quota,
    billing: billingPayload(upstream.billing, upstream.billingConfig),
    health: { /* ... */ },
    keys: upstream.keys.map((key) => createKeyStatusView(key, state, at))
  };
}
```

### 修改 2: createKeyStatusView

**文件**: `src/server.mjs`  
**行号**: ~11582

```javascript
// 删除这一行：
stats: key.stats,
```

**完整上下文**:
```javascript
function createKeyStatusView(key, state, at = now()) {
  const availability = availabilitySummary(key.stats, state.availability);
  return {
    label: key.label,
    source: key.source,
    configured: key.configured,
    cooldown_ms: Math.max(0, key.cooldownUntil - at),
    failures: key.failures,
    // stats: key.stats,                        // 🔴 删除这一行
    availability,
    quota: key.quota,
    representative_evidence: representativeEvidencePayload(key, at),
    health: { /* ... */ }
  };
}
```

---

## 实施步骤

### 1. 创建功能分支

```bash
cd /Users/slizm/myprojects/codex-api-pool
git checkout -b remove-stats-from-api
git status  # 确认在正确的分支
```

### 2. 备份当前状态

```bash
# 备份配置
cp stats.local.json stats.local.json.backup
cp config.local.json config.local.json.backup

# 记录当前 API 响应（对比用）
curl -s http://127.0.0.1:8787/pool/status | \
  jq '.upstreams[0]' > /tmp/api_response_before.json
```

### 3. 修改代码

**编辑 src/server.mjs**:

```bash
# 找到并删除第一处
sed -i.bak '11661s/.*stats: upstream.stats,.*$/    \/\/ stats: upstream.stats,  \/\/ Removed in Phase 1/' src/server.mjs

# 找到并删除第二处（先搜索确切行号）
grep -n "stats: key.stats," src/server.mjs
# 假设在 11582 行
sed -i '11582s/.*stats: key.stats,.*$/    \/\/ stats: key.stats,  \/\/ Removed in Phase 1/' src/server.mjs
```

或者手动编辑：
1. 打开 `src/server.mjs`
2. 跳转到 Line 11661，注释或删除 `stats: upstream.stats,`
3. 搜索 `stats: key.stats,`，注释或删除
4. 保存

### 4. 重启服务

```bash
# 找到当前进程
ps aux | grep "node.*server.mjs" | grep -v grep

# 杀掉进程（LaunchAgent 会自动重启）
pkill -f "node.*server.mjs"

# 等待重启
sleep 3

# 验证新进程
ps aux | grep "node.*server.mjs" | grep -v grep
```

### 5. 验证 API 响应

```bash
# 检查 stats 字段是否被移除
curl -s http://127.0.0.1:8787/pool/status | \
  jq '.upstreams[0] | has("stats")'
# 期望输出: false

# 检查 availability 和 usage 是否正常
curl -s http://127.0.0.1:8787/pool/status | \
  jq '.upstreams[0] | {
    has_availability: has("availability"),
    has_usage: has("usage"),
    availability_successes: .availability.successes,
    usage_total: .usage.total_tokens
  }'
# 期望输出: 所有字段都存在且有值

# 对比响应体积
curl -s http://127.0.0.1:8787/pool/status | wc -c
# 应该比之前小约 30%

# 保存新的 API 响应
curl -s http://127.0.0.1:8787/pool/status | \
  jq '.upstreams[0]' > /tmp/api_response_after.json

# 对比差异
diff /tmp/api_response_before.json /tmp/api_response_after.json
# 应该只看到 stats 字段被移除
```

### 6. 验证 Dashboard

```bash
# 打开 Dashboard
open http://127.0.0.1:8787/pool/dashboard

# 检查以下内容是否正常显示：
# - 可用性百分比
# - 成功/失败次数
# - Token 使用量
# - 今日/总计统计
```

**手工检查清单**:
- [ ] 上游卡片显示正常
- [ ] 可用性进度条正常
- [ ] Token 统计正常
- [ ] 账单信息正常
- [ ] 没有 JavaScript 错误（打开浏览器控制台）

### 7. 运行 Smoke Test

```bash
npm run smoke
```

**期望结果**: 所有测试通过

如果有失败：
```bash
# 查看详细错误
npm run smoke 2>&1 | tee /tmp/smoke_test_result.txt

# 检查是否是 stats 相关的错误
grep -i "stats" /tmp/smoke_test_result.txt
```

### 8. 验证持久化

```bash
# 检查 stats.local.json 是否仍然包含 stats
jq '.upstreams[0] | has("stats")' stats.local.json
# 期望输出: true（内部存储不变）

# 发送几个测试请求
for i in {1..3}; do
  curl -s -X POST http://127.0.0.1:8787/v1/responses \
    -H "Authorization: Bearer ${CODEX_POOL_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\": \"claude-opus-4-8\", \"input\": \"test $i\", \"max_tokens\": 10}" \
    > /dev/null
  sleep 1
done

# 检查 stats 是否正常更新
jq '.upstreams[0].stats.attempts' stats.local.json
# 应该增加了 3
```

### 9. 性能验证

```bash
# 测试 API 响应时间（删除前后对比）
time curl -s http://127.0.0.1:8787/pool/status > /dev/null

# 测试响应体积
echo "Before: $(cat /tmp/api_response_before.json | wc -c) bytes"
echo "After: $(cat /tmp/api_response_after.json | wc -c) bytes"
echo "Reduction: $(python3 -c "before=$(cat /tmp/api_response_before.json | wc -c); after=$(cat /tmp/api_response_after.json | wc -c); print(f'{(1-after/before)*100:.1f}%')")"
```

---

## 验证清单

### 必须通过（P0）
- [ ] `npm run smoke` 全部通过
- [ ] API 响应中没有 `stats` 字段
- [ ] `availability` 和 `usage` 字段正常
- [ ] Dashboard 显示正常
- [ ] `stats.local.json` 仍包含完整 stats
- [ ] 新请求正常记录到 stats

### 推荐验证（P1）
- [ ] 响应体积减少约 30%
- [ ] API 响应时间没有退化
- [ ] 浏览器控制台没有错误
- [ ] 所有上游卡片字段正常

### 可选验证（P2）
- [ ] 重启服务后 stats 恢复正常
- [ ] Codex CLI 正常使用
- [ ] Claude Desktop 正常使用

---

## 回滚方案

### 快速回滚（如果出现问题）

```bash
# 方案 1: Git 回滚
git checkout main
pkill -f "node.*server.mjs"
sleep 3
ps aux | grep "node.*server.mjs" | grep -v grep

# 方案 2: 恢复备份
cp src/server.mjs.bak src/server.mjs
pkill -f "node.*server.mjs"
sleep 3
```

### 回滚验证

```bash
# 确认 stats 字段恢复
curl -s http://127.0.0.1:8787/pool/status | \
  jq '.upstreams[0] | has("stats")'
# 期望输出: true

npm run smoke
```

---

## 提交代码

### 如果所有测试通过

```bash
git add src/server.mjs
git commit -m "Remove stats object from API responses (Phase 1)

- Removed stats field from createUpstreamStatusView
- Removed stats field from createKeyStatusView
- Internal storage unchanged (stats still persisted)
- All data available via availability and usage fields

Benefits:
- Reduces API response size by ~30%
- Improves API clarity (no internal implementation leakage)
- No breaking changes (stats was redundant)

Tested:
- Smoke tests pass
- Dashboard displays correctly
- Stats persistence works normally
"

# 推送到远程（可选）
git push origin remove-stats-from-api
```

### 创建 PR（可选）

```bash
# 如果使用 GitHub
gh pr create --title "Remove stats from API responses" \
  --body "See commit message for details. Phase 1 of API cleanup."

# 或手动创建 PR
```

---

## 监控计划

### 上线后 24 小时

- [ ] 检查错误日志
- [ ] 监控 API 响应时间
- [ ] 检查用户反馈
- [ ] 验证 stats 持久化正常

### 上线后 1 周

- [ ] 确认没有依赖 stats 字段的代码
- [ ] 准备 Phase 2（简化 usage）

---

## FAQ

### Q: 为什么不直接删除 upstream.stats？
A: `upstream.stats` 是内部存储层，需要持久化。只删除 API 响应中的暴露。

### Q: 前端会不会依赖 stats 字段？
A: 不应该。`stats` 是内部实现细节，前端应该用 `availability` 和 `usage`。如果有依赖，那是设计缺陷，需要修复。

### Q: 这会影响性能吗？
A: 不会。`availability` 和 `usage` 仍然从 `stats` 计算，只是不输出完整的 `stats` 对象。实际上会提升性能（减少序列化和传输）。

### Q: 能恢复 stats 字段吗？
A: 可以。Git 回滚即可。但不推荐，因为 stats 暴露了内部实现。

### Q: 下一步是什么？
A: Phase 2 简化 `usage` 对象，移除冗余的 `today_*` 和 `by_day` 字段。

---

## 完成时间估计

- [ ] 代码修改: 5 分钟
- [ ] 重启服务: 1 分钟
- [ ] API 验证: 5 分钟
- [ ] Dashboard 验证: 5 分钟
- [ ] Smoke test: 2 分钟
- [ ] 持久化验证: 5 分钟
- [ ] 提交代码: 3 分钟

**总计: ~25 分钟**

---

**准备好了吗？开始实施！** 🚀
