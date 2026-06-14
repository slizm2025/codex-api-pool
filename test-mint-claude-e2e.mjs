#!/usr/bin/env node

/**
 * 端到端测试：验证 Mint_claude 模型名称后缀转换的完整流程
 */

// 模拟实现
function normalizeModelSuffix(value) {
  return String(value || '').trim();
}

function stripUpstreamModelSuffix(model, suffix) {
  const name = String(model || '');
  const tail = normalizeModelSuffix(suffix);
  if (!tail || !name.endsWith(tail)) return name;
  return name.slice(0, name.length - tail.length);
}

function applyUpstreamModelSuffix(model, suffix) {
  const name = String(model || '');
  const tail = normalizeModelSuffix(suffix);
  if (!tail || !name || name.endsWith(tail)) return name;
  return `${name}${tail}`;
}

function normalizeDiscoveredModelsForUpstream(upstream, models) {
  const suffix = upstream?.modelSuffixStrip;
  return [...new Set((Array.isArray(models) ? models : [])
    .map((model) => stripUpstreamModelSuffix(model, suffix))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function forwardModelForUpstream(upstream, model) {
  const suffix = upstream?.modelSuffixStrip;
  if (!normalizeModelSuffix(suffix)) return String(model || '');
  const models = upstream?.health?.models || [];
  if (models.length > 0 && models.includes(model)) {
    return applyUpstreamModelSuffix(model, suffix);
  }
  if (normalizeModelSuffix(suffix)) {
    return applyUpstreamModelSuffix(model, suffix);
  }
  return String(model || '');
}

function upstreamSupportsModel(upstream, model) {
  if (!model) return true;
  const models = upstream.health?.models || [];
  return models.length === 0 || models.includes(model);
}

console.log('🧪 Mint_claude 端到端测试\n');

// ============================================================
// 场景 1: Health Probe 模型发现
// ============================================================
console.log('📋 场景 1: Health Probe 从 Mint_claude 获取模型列表\n');

const mintClaude = {
  name: 'Mint_claude',
  modelSuffixStrip: '-cc',
  health: { models: [] } // 初始为空
};

// 模拟 Mint_claude 的 /v1/models 响应
const rawModelsFromApi = ['claude-opus-4-8-cc', 'claude-sonnet-4-6-cc', 'claude-haiku-4-5-cc'];
console.log(`  Mint_claude API 返回: ${JSON.stringify(rawModelsFromApi)}`);

// 执行规范化
const normalizedModels = normalizeDiscoveredModelsForUpstream(mintClaude, rawModelsFromApi);
mintClaude.health.models = normalizedModels;

console.log(`  规范化后存储: ${JSON.stringify(normalizedModels)}`);

const expectedNormalized = ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6'];
const normalizeOk = JSON.stringify(normalizedModels) === JSON.stringify(expectedNormalized);
console.log(`  ✅ 规范化: ${normalizeOk ? '通过' : '失败'}\n`);

// ============================================================
// 场景 2: Selection 阶段（上游选择）
// ============================================================
console.log('📋 场景 2: 客户端请求 claude-opus-4-8，Selection 检查 Mint_claude\n');

const clientRequestModel = 'claude-opus-4-8';
console.log(`  客户端请求模型: ${clientRequestModel}`);

const supportsModel = upstreamSupportsModel(mintClaude, clientRequestModel);
console.log(`  upstreamSupportsModel(Mint_claude, "${clientRequestModel}"): ${supportsModel}`);
console.log(`  检查逻辑: upstream.health.models.includes("${clientRequestModel}") = ${mintClaude.health.models.includes(clientRequestModel)}`);
console.log(`  ✅ Selection: ${supportsModel ? '通过（可以选中 Mint_claude）' : '失败（无法选中）'}\n`);

// ============================================================
// 场景 3: 请求转发（反向转换）
// ============================================================
console.log('📋 场景 3: Pool 转发请求给 Mint_claude\n');

const attemptedModel = clientRequestModel;
const forwardedModel = forwardModelForUpstream(mintClaude, attemptedModel);

console.log(`  attemptedModel (内部标准名): ${attemptedModel}`);
console.log(`  forwardedModel (发送给上游): ${forwardedModel}`);

const expectedForwarded = 'claude-opus-4-8-cc';
const forwardOk = forwardedModel === expectedForwarded;
console.log(`  ✅ 转发: ${forwardOk ? '通过' : '失败'}\n`);

// ============================================================
// 场景 4: Health Probe 请求（也需要转换）
// ============================================================
console.log('📋 场景 4: Health Probe 发送测试请求给 Mint_claude\n');

const probeModel = 'claude-opus-4-8'; // 来自 model_override
const forwardedProbeModel = forwardModelForUpstream(mintClaude, probeModel);

console.log(`  probeModel (Pool 配置): ${probeModel}`);
console.log(`  forwardedProbeModel (发送给上游): ${forwardedProbeModel}`);

const probeForwardOk = forwardedProbeModel === expectedForwarded;
console.log(`  ✅ Health Probe: ${probeForwardOk ? '通过' : '失败'}\n`);

// ============================================================
// 场景 5: 未运行 Health Probe 时的 Fallback
// ============================================================
console.log('📋 场景 5: Health Probe 未运行（models 为空）的情况\n');

const mintClaudeNoProbe = {
  name: 'Mint_claude',
  modelSuffixStrip: '-cc',
  health: { models: [] } // 空数组
};

const fallbackForwarded = forwardModelForUpstream(mintClaudeNoProbe, clientRequestModel);
console.log(`  upstream.health.models: ${JSON.stringify(mintClaudeNoProbe.health.models)} (空)`);
console.log(`  forwardedModel: ${fallbackForwarded}`);

const fallbackOk = fallbackForwarded === expectedForwarded;
console.log(`  ✅ Fallback: ${fallbackOk ? '通过' : '失败'}\n`);

// ============================================================
// 场景 6: 对比其他正常上游
// ============================================================
console.log('📋 场景 6: 对比正常上游（JUN）\n');

const junUpstream = {
  name: 'JUN',
  // 没有 modelSuffixStrip
  health: { models: ['claude-opus-4-8', 'claude-sonnet-4-6'] }
};

const junRawModels = ['claude-opus-4-8', 'claude-sonnet-4-6'];
const junNormalized = normalizeDiscoveredModelsForUpstream(junUpstream, junRawModels);
const junForwarded = forwardModelForUpstream(junUpstream, clientRequestModel);

console.log(`  JUN API 返回: ${JSON.stringify(junRawModels)}`);
console.log(`  规范化后: ${JSON.stringify(junNormalized)}`);
console.log(`  转发模型: ${junForwarded}`);

const junUnchanged = JSON.stringify(junNormalized.sort()) === JSON.stringify(junRawModels.sort()) &&
                     junForwarded === clientRequestModel;
console.log(`  ✅ JUN 不受影响: ${junUnchanged ? '通过' : '失败'}\n`);

// ============================================================
// 总结
// ============================================================
console.log('═══════════════════════════════════════════════════════════');
console.log('📊 测试总结\n');

const allTests = [
  { name: '场景 1: 模型发现规范化', pass: normalizeOk },
  { name: '场景 2: Selection 匹配', pass: supportsModel },
  { name: '场景 3: 请求转发', pass: forwardOk },
  { name: '场景 4: Health Probe', pass: probeForwardOk },
  { name: '场景 5: Fallback 逻辑', pass: fallbackOk },
  { name: '场景 6: 其他上游不受影响', pass: junUnchanged }
];

const allPassed = allTests.every(t => t.pass);

for (const test of allTests) {
  console.log(`  ${test.pass ? '✅' : '❌'} ${test.name}`);
}

console.log('');
if (allPassed) {
  console.log('✅✅✅ 所有场景测试通过！');
  process.exit(0);
} else {
  console.log('❌❌❌ 存在失败场景！');
  process.exit(1);
}
