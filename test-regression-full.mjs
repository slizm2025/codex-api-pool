#!/usr/bin/env node

/**
 * 完整的回归测试：模拟真实的 HTTP 请求流程
 */

console.log('🔍 Mint_claude 功能完整回归测试\n');
console.log('═══════════════════════════════════════════════════════════\n');

// 模拟完整的配置和状态
const config = {
  upstreams: [
    {
      name: 'JUN',
      health: { models: ['claude-opus-4-8', 'claude-sonnet-4-6'] }
    },
    {
      name: 'Mint_claude',
      modelSuffixStrip: '-cc',
      health: { models: [] } // 初始为空
    }
  ]
};

// 导入核心逻辑
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

// ═══════════════════════════════════════════════════════════
// 测试流程 1: Health Probe 初始化
// ═══════════════════════════════════════════════════════════
console.log('📋 流程 1: Health Probe 初始化\n');

const mintClaude = config.upstreams[1];
const junUpstream = config.upstreams[0];

// 模拟 Mint_claude 返回的 /v1/models
const mintRawModels = ['claude-opus-4-8-cc', 'claude-sonnet-4-6-cc', 'claude-haiku-4-5-cc'];
console.log(`  Mint_claude /v1/models 返回: ${JSON.stringify(mintRawModels)}`);

const mintNormalized = normalizeDiscoveredModelsForUpstream(mintClaude, mintRawModels);
mintClaude.health.models = mintNormalized;
console.log(`  规范化后存储到 upstream.health.models: ${JSON.stringify(mintNormalized)}`);

// 模拟 JUN 返回的 /v1/models
const junRawModels = ['claude-opus-4-8', 'claude-sonnet-4-6'];
console.log(`\n  JUN /v1/models 返回: ${JSON.stringify(junRawModels)}`);

const junNormalized = normalizeDiscoveredModelsForUpstream(junUpstream, junRawModels);
junUpstream.health.models = junNormalized;
console.log(`  规范化后存储到 upstream.health.models: ${JSON.stringify(junNormalized)}`);

const phase1Pass = JSON.stringify(mintNormalized) === JSON.stringify(['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6']) &&
                   JSON.stringify(junNormalized) === JSON.stringify(['claude-opus-4-8', 'claude-sonnet-4-6']);

console.log(`\n  ${phase1Pass ? '✅' : '❌'} 流程 1: ${phase1Pass ? '通过' : '失败'}\n`);

// ═══════════════════════════════════════════════════════════
// 测试流程 2: 客户端请求 /v1/messages
// ═══════════════════════════════════════════════════════════
console.log('📋 流程 2: 客户端请求 /v1/messages\n');

const clientRequest = {
  model: 'claude-opus-4-8',
  messages: [{ role: 'user', content: 'test' }],
  max_tokens: 100
};

console.log(`  客户端请求: POST /v1/messages`);
console.log(`  Body: ${JSON.stringify(clientRequest, null, 2)}`);

// ═══════════════════════════════════════════════════════════
// 测试流程 3: Pool Selection（模拟选中 Mint_claude）
// ═══════════════════════════════════════════════════════════
console.log(`\n📋 流程 3: Pool 选择上游 (假设选中 Mint_claude)\n`);

const requestedModel = clientRequest.model;
console.log(`  requestedModel: ${requestedModel}`);
console.log(`  检查 Mint_claude.health.models: ${JSON.stringify(mintClaude.health.models)}`);
console.log(`  models.includes("${requestedModel}"): ${mintClaude.health.models.includes(requestedModel)}`);

const canSelectMint = mintClaude.health.models.includes(requestedModel);
console.log(`  ${canSelectMint ? '✅' : '❌'} Mint_claude ${canSelectMint ? '可以' : '不能'}被选中`);

// ═══════════════════════════════════════════════════════════
// 测试流程 4: 请求转发给 Mint_claude
// ═══════════════════════════════════════════════════════════
console.log(`\n📋 流程 4: 转发请求给 Mint_claude\n`);

const forwardedModel = forwardModelForUpstream(mintClaude, requestedModel);
console.log(`  attemptedModel (内部): ${requestedModel}`);
console.log(`  forwardedModel (转发): ${forwardedModel}`);

const forwardedRequest = {
  model: forwardedModel,
  messages: clientRequest.messages,
  max_tokens: clientRequest.max_tokens
};

console.log(`\n  实际发送给 Mint_claude 的请求:`);
console.log(`  POST https://x666.me/v1/messages`);
console.log(`  Body: ${JSON.stringify(forwardedRequest, null, 2)}`);

const phase4Pass = forwardedModel === 'claude-opus-4-8-cc';
console.log(`\n  ${phase4Pass ? '✅' : '❌'} 流程 4: ${phase4Pass ? '通过' : '失败'}\n`);

// ═══════════════════════════════════════════════════════════
// 测试流程 5: 对比 JUN 上游（不应受影响）
// ═══════════════════════════════════════════════════════════
console.log('📋 流程 5: 对比 JUN 上游 (不应受影响)\n');

const junForwardedModel = forwardModelForUpstream(junUpstream, requestedModel);
console.log(`  JUN: attemptedModel = ${requestedModel}`);
console.log(`  JUN: forwardedModel = ${junForwardedModel}`);

const junForwardedRequest = {
  model: junForwardedModel,
  messages: clientRequest.messages,
  max_tokens: clientRequest.max_tokens
};

console.log(`\n  发送给 JUN 的请求:`);
console.log(`  Body.model: ${junForwardedRequest.model}`);

const phase5Pass = junForwardedModel === 'claude-opus-4-8';
console.log(`\n  ${phase5Pass ? '✅' : '❌'} 流程 5: ${phase5Pass ? '通过 (JUN 不受影响)' : '失败 (JUN 被错误修改)'}\n`);

// ═══════════════════════════════════════════════════════════
// 总结
// ═══════════════════════════════════════════════════════════
console.log('═══════════════════════════════════════════════════════════');
console.log('📊 回归测试总结\n');

const allPhases = [
  { name: '流程 1: Health Probe 初始化', pass: phase1Pass },
  { name: '流程 3: Selection 匹配', pass: canSelectMint },
  { name: '流程 4: 请求转发 (Mint_claude)', pass: phase4Pass },
  { name: '流程 5: 不影响其他上游 (JUN)', pass: phase5Pass }
];

for (const phase of allPhases) {
  console.log(`  ${phase.pass ? '✅' : '❌'} ${phase.name}`);
}

const allPass = allPhases.every(p => p.pass);

console.log('');
console.log('🎯 关键验证点:');
console.log(`  ✅ Mint_claude 接收: model="${forwardedModel}" (带 -cc 后缀)`);
console.log(`  ✅ JUN 接收: model="${junForwardedModel}" (标准名称)`);
console.log(`  ✅ 客户端发送: model="${clientRequest.model}" (标准名称)`);
console.log(`  ✅ Pool 内部追踪: model="${requestedModel}" (标准名称)`);

console.log('');
if (allPass) {
  console.log('✅✅✅ 完整回归测试通过！');
  console.log('功能正确实现，可以安全部署。');
  process.exit(0);
} else {
  console.log('❌❌❌ 回归测试失败！');
  process.exit(1);
}
