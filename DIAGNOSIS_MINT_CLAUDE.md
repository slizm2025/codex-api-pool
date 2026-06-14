# Mint_claude 模型名称后缀转换功能 - 诊断报告

## 审查时间
2026-06-14

## 功能概述
为 Mint_claude 上游实现模型名称后缀转换：
- 模型发现时：`claude-opus-4-8-cc` → `claude-opus-4-8` (规范化)
- 请求转发时：`claude-opus-4-8` → `claude-opus-4-8-cc` (反向转换)

## 代码修改点

### ✅ 已实施的修改

| 位置 | 函数 | 修改内容 | 状态 |
|------|------|---------|------|
| 8905行 | `probeModelsForProtocol()` | 调用 `normalizeDiscoveredModelsForUpstream()` | ✅ 已修改 |
| 1240-1256行 | `forwardModelForUpstream()` | 修复逻辑，正确处理规范化后的模型列表 | ✅ 已修改 |
| 8097行 | `probeAnthropicUpstream()` | 调用 `forwardModelForUpstream()` 转换模型名 | ✅ 已修改 |
| 7983行 | `probeChatCompletionsUpstream()` | 调用 `forwardModelForUpstream()` 转换模型名 | ✅ 已修改 |
| 8042行 | `probeResponsesUpstream()` | 调用 `forwardModelForUpstream()` 转换模型名 | ✅ 已修改 |
| 13598行 | 主请求转发路径 | 使用 `forwardModelForUpstream()` | ✅ 已存在 |
| config:349行 | Mint_claude 配置 | 添加 `"model_suffix_strip": "-cc"` | ✅ 已添加 |

### 🔍 调用路径验证

#### 1. Health Probe 模型发现路径
```
probeModelsForProtocol()
  └─> extractModels(result.body)  // 获取原始列表
  └─> normalizeDiscoveredModelsForUpstream(upstream, rawModels)  ✅
      └─> stripUpstreamModelSuffix()  // 剥离后缀
  └─> return { models: normalizedModels }
```

#### 2. Health Probe 请求发送路径
```
probeAnthropicUpstream(upstream, key, config, model)
  └─> forwardedModel = forwardModelForUpstream(upstream, model)  ✅
  └─> body = JSON.stringify({ model: forwardedModel })
```

```
probeChatCompletionsUpstream(upstream, key, config, model)
  └─> forwardedModel = forwardModelForUpstream(upstream, model)  ✅
  └─> body = buildChatCompletionsPayload({ model: forwardedModel })
```

```
probeResponsesUpstream(upstream, key, config, model)
  └─> forwardedModel = forwardModelForUpstream(upstream, model)  ✅
  └─> body = JSON.stringify(codexResponsesProbePayload(forwardedModel))
```

#### 3. 实际请求转发路径
```
主请求处理器 (13598行)
  └─> forwardedModel = forwardModelForUpstream(upstream, attemptedModel)  ✅
  └─> body = rewriteModelInBody(req, activeBody, forwardedModel)
```

#### 4. fetchSupplementalModels 路径 (8493行)
```
fetchSupplementalModels()
  └─> extractModels(modelsResult.body)
  └─> normalizeDiscoveredModelsForUpstream(upstream, extracted)  ✅
```

## 测试结果

### ✅ 单元测试
- `test-model-suffix-logic.mjs`: 全部通过
- `test-normal-upstreams.mjs`: 全部通过
- `test-strict-isolation.mjs`: 全部通过
- `test-mint-claude-e2e.mjs`: 全部通过

### ✅ 覆盖的场景
1. ✅ 模型发现规范化（Health Probe）
2. ✅ Selection 阶段匹配
3. ✅ 实际请求转发
4. ✅ Health Probe 请求转发（Anthropic/Chat/Responses）
5. ✅ Fallback 逻辑（Health Probe 未运行）
6. ✅ 其他上游不受影响

### ✅ 影响范围
- 受影响上游：1 个（Mint_claude）
- 不受影响上游：19 个
- 影响比例：5%

## 代码质量检查

### ✅ 防护机制
所有转换函数都有前置检查，确保未配置 `model_suffix_strip` 的上游直接返回原值：

```javascript
// forwardModelForUpstream()
if (!normalizeModelSuffix(suffix)) return String(model || '');

// stripUpstreamModelSuffix()
if (!tail || !name.endsWith(tail)) return name;

// applyUpstreamModelSuffix()
if (!tail || !name || name.endsWith(tail)) return name;
```

### ✅ 幂等性
`applyUpstreamModelSuffix()` 检查后缀是否已存在，避免重复添加：
```javascript
if (name.endsWith(tail)) return name;
```

### ✅ 诊断支持
`attachForwardedModelTrace()` 在转换发生时记录 `forwarded_model` 字段，便于排查。

## 潜在问题审查

### 🔍 检查点 1: 是否所有调用路径都已覆盖？

**forwardModelForUpstream() 的调用点：**
- ✅ 7983行: `probeChatCompletionsUpstream()`
- ✅ 8042行: `probeResponsesUpstream()`
- ✅ 8097行: `probeAnthropicUpstream()`
- ✅ 13212行: 某处请求处理
- ✅ 13598行: 主请求转发

让我检查 13212行是什么...
