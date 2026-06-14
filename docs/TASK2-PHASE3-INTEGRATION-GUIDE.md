# 任务 2 阶段 3 集成指南

**状态**: ⏸️ 待开始  
**预计时间**: 2-3 小时  
**前置条件**: 阶段 1+2 已完成并测试通过

---

## 📋 集成目标

将 `ProtocolProbeOrchestrator` 集成到 `src/server.mjs` 的 `probeOneUpstream` 函数中，替换 lines 8380-8511 的 130 行嵌套逻辑。

---

## ✅ 已完成准备工作

1. **✅ Orchestrator 完全实现**
   - `planProbes()` - 协议选择策略
   - `executeProbes()` - 执行 + 分类
   - `determineHealthStatus()` - 健康决策
   - `probeUpstream()` - 端到端编排
   - 20/20 单元测试通过

2. **✅ 导入已存在**
   - `ProtocolProbeOrchestrator` (line 56)
   - `HttpProbeExecutor` (line 57)

3. **✅ 依赖模块就绪**
   - `ProtocolCapabilityManager` - 能力管理
   - `classifyModelProbe` - 分类器
   - 探测函数 - `probeResponsesUpstream`, `probeChatCompletionsUpstream`, `probeAnthropicUpstream`

---

## 🔧 集成步骤

### 步骤 1：创建 HttpProbeExecutor 实例（30分钟）

**位置**: `probeOneUpstream` 函数，line ~8370

**实现**:
```javascript
// Create probe executor with real probe functions
const httpProbeExecutor = new HttpProbeExecutor({
  probeResponses: async (upstream, key, config, model) => {
    return await probeResponsesUpstream(upstream, key, config, model);
  },
  probeChatCompletions: async (upstream, key, config, model) => {
    return await probeChatCompletionsUpstream(upstream, key, config, model);
  },
  probeAnthropicMessages: async (upstream, key, config, model) => {
    return await probeAnthropicUpstream(upstream, key, config, model);
  }
});
```

### 步骤 2：创建 Orchestrator 实例（15分钟）

```javascript
// Create capability manager
const capabilityManager = new ProtocolCapabilityManager(upstream, {
  now: () => Date.now(),
  timestampMs: (value) => Date.parse(String(value || '')),
  classifyModelProbe
});

// Create orchestrator
const orchestrator = new ProtocolProbeOrchestrator(
  capabilityManager,
  httpProbeExecutor,
  classifyModelProbe
);
```

### 步骤 3：调用 Orchestrator（15分钟）

**替换**: lines 8380-8511

**新代码**:
```javascript
// Use orchestrator for multi-protocol probing
const allModels = [...claudeModelsList, ...nonClaudeModelsList];
const { health, probeResults, plan } = await orchestrator.probeUpstream(
  upstream,
  key,
  config,
  allModels,
  Date.now()
);

// Extract results
const stateName = health.state;
const healthResult = health.result;
const healthError = health.error || '';
const healthWarning = health.warning || '';
const resolvedMode = health.resolvedMode || '';
```

### 步骤 4：处理状态更新（45分钟）

**需要处理**:

1. **协议能力更新** (已在 orchestrator 内部处理？需要确认):
```javascript
// Orchestrator 的 executeProbes 已分类，但未调用 recordProtocolCapabilityProbe
// 需要手动记录或集成到 orchestrator
if (persistHealth) {
  for (const [protocol, probeData] of Object.entries(probeResults)) {
    if (probeData) {
      recordProtocolCapabilityProbe(
        upstream,
        protocol,
        probeData.result,
        probeData.classified,
        { checkedAt, model: probeModel }
      );
    }
  }
}
```

2. **Quota 更新**:
```javascript
if (persistHealth) {
  // Apply quota from all probe results
  for (const probeData of Object.values(probeResults)) {
    if (probeData?.result?.headers) {
      applyQuota(upstream, key, probeData.result.headers);
    }
  }
}
```

3. **ResolvedMode 更新**:
```javascript
if (persistHealth && resolvedMode) {
  upstream.resolvedRequestMode = resolvedMode;
}
```

4. **Cooldown 重置**:
```javascript
if (persistHealth && stateName === 'ok') {
  upstream.cooldownUntil = 0;
  upstream.failures = 0;
  key.cooldownUntil = 0;
  key.failures = 0;
}
```

### 步骤 5：构建 Health 对象（15分钟）

**保持现有结构**:
```javascript
const health = {
  state: stateName,
  source: 'probe',
  checkedAt,
  latencyMs: healthResult.latencyMs || 0,
  httpStatus: healthResult.statusCode || 0,
  error: stateName === 'ok' ? '' : healthError,
  warning: healthWarning,
  models,
  modelsCount: models.length,
  keyLabel: key.label,
  probeModel
};

const keyHealth = {
  state: stateName,
  source: 'probe',
  checkedAt,
  latencyMs: healthResult.latencyMs || 0,
  httpStatus: healthResult.statusCode || 0,
  error: stateName === 'ok' ? '' : healthError,
  warning: healthWarning,
  probeModel
};

if (persistHealth) {
  upstream.health = health;
  key.health = keyHealth;
}
```

### 步骤 6：删除旧代码（15分钟）

**删除**: lines 8380-8511 的旧探测逻辑

**保留**: lines 8513-8576 的状态处理逻辑

### 步骤 7：验证（30分钟）

1. **运行单元测试**:
```bash
node test/protocol-probe-orchestrator.test.mjs
```

2. **运行 Smoke Test**:
```bash
npm run smoke
```

3. **手动测试**:
   - 触发健康探测
   - 验证 responses 成功
   - 验证 fallback 到 chat
   - 验证 anthropic 探测

---

## ⚠️ 注意事项

### 潜在问题

1. **协议能力记录**:
   - Orchestrator 的 `executeProbes` 只执行和分类
   - 不调用 `recordProtocolCapabilityProbe`
   - 需要在集成点手动调用

2. **ProtocolCapabilityManager 集成**:
   - Orchestrator 构造时接受 ProtocolCapabilityManager
   - 但 `planProbes` 使用它的 `shouldRecheck` 方法
   - `executeProbes` 不更新状态
   - 需要在外部手动更新

3. **applyProbeResult 未使用**:
   - 任务 3 创建的 `applyProbeResult` 方法尚未集成
   - 可以在这里使用来简化状态更新

### 改进机会

**使用 applyProbeResult**:
```javascript
// 在处理每个协议的结果时
for (const [protocol, probeData] of Object.entries(probeResults)) {
  if (probeData && persistHealth) {
    const capManager = new ProtocolCapabilityManager(upstream);
    const { shouldCooldown, cooldownReason } = capManager.applyProbeResult(
      key,
      protocol,
      probeData.result,
      probeData.classified,
      { checkedAt, model: probeModel }
    );
    
    // Handle cooldown...
  }
}
```

---

## 📊 预期结果

### 代码减少
- **删除**: ~130 行嵌套逻辑
- **新增**: ~50 行 orchestrator 调用
- **净减少**: ~80 行

### 架构改进
- ✅ 逻辑分层清晰
- ✅ 完全测试覆盖
- ✅ 易于维护
- ✅ 易于扩展

---

## 🚀 下次会话启动命令

```bash
# 1. 查看当前状态
git status

# 2. 查看集成点
cat src/server.mjs | sed -n '8370,8520p'

# 3. 阅读此文档
cat docs/TASK2-PHASE3-INTEGRATION-GUIDE.md

# 4. 开始集成
# 然后说："开始任务 2 阶段 3：集成 orchestrator 到 server.mjs"
```

---

**创建者**: Claude Opus 4.8  
**创建日期**: 2026-06-14  
**状态**: 待实施
