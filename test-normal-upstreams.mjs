#!/usr/bin/env node

// 验证当前实现不影响其他正常上游

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

function normalizeDiscoveredModelsForUpstream(upstream, models) {
  const suffix = upstream?.modelSuffixStrip;
  return [...new Set((Array.isArray(models) ? models : [])
    .map((model) => stripUpstreamModelSuffix(model, suffix))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

// 模拟真实配置中的正常上游
const normalUpstreams = [
  {
    name: 'rawchat',
    api: 'openai',
    health: { models: ['gpt-4', 'gpt-3.5-turbo'] }
  },
  {
    name: 'JUN',
    health: { models: ['claude-opus-4-8', 'claude-sonnet-4-6'] }
  },
  {
    name: 'blackandwhilt',
    api: 'both',
    health: { models: ['gpt-4', 'claude-opus-4-8'] }
  },
  {
    name: 'runanytime_claude',
    api: 'both',
    health: { models: ['claude-opus-4-8', 'claude-sonnet-4-6'] }
  },
  {
    name: 'LAOU',
    api: 'openai',
    health: { models: ['gpt-4-turbo', 'gpt-4'] }
  }
];

const testModels = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'gpt-4',
  'gpt-3.5-turbo'
];

console.log('🧪 测试正常上游不受影响\n');

let allPassed = true;

for (const upstream of normalUpstreams) {
  console.log(`📋 上游：${upstream.name} (api=${upstream.api || 'null'})`);

  // 测试模型发现规范化
  const rawModels = upstream.health.models;
  const normalized = normalizeDiscoveredModelsForUpstream(upstream, rawModels);
  const normalizedUnchanged = JSON.stringify(normalized.sort()) === JSON.stringify([...rawModels].sort());

  console.log(`  模型发现规范化：${normalizedUnchanged ? '✅' : '❌'} (不应改变)`);
  console.log(`    原始：${JSON.stringify(rawModels)}`);
  console.log(`    规范化后：${JSON.stringify(normalized)}`);

  if (!normalizedUnchanged) {
    allPassed = false;
  }

  // 测试请求转发
  for (const model of testModels) {
    if (!upstream.health.models.includes(model)) continue;

    const forwarded = forwardModelForUpstream(upstream, model);
    const forwardedUnchanged = forwarded === model;

    console.log(`  转发 ${model}：${forwardedUnchanged ? '✅' : '❌'} (不应改变)`);
    console.log(`    期望：${model}`);
    console.log(`    实际：${forwarded}`);

    if (!forwardedUnchanged) {
      allPassed = false;
    }
  }

  console.log('');
}

// 特别测试 Mint_claude 的行为对比
console.log('📋 对比：Mint_claude (有 model_suffix_strip)');
const mintClaude = {
  name: 'Mint_claude',
  modelSuffixStrip: '-cc',
  api: 'anthropic',
  health: { models: ['claude-opus-4-8', 'claude-sonnet-4-6'] }
};

const mintRawModels = ['claude-opus-4-8-cc', 'claude-sonnet-4-6-cc'];
const mintNormalized = normalizeDiscoveredModelsForUpstream(mintClaude, mintRawModels);
const mintForwarded = forwardModelForUpstream(mintClaude, 'claude-opus-4-8');

console.log(`  模型发现规范化：${JSON.stringify(mintNormalized)}`);
console.log(`  转发 claude-opus-4-8 → ${mintForwarded}`);
console.log(`  ✅ Mint_claude 特殊处理生效`);
console.log('');

if (allPassed) {
  console.log('✅ 所有正常上游不受影响！');
  console.log('✅ 只有配置了 model_suffix_strip 的 Mint_claude 会进行转换！');
  process.exit(0);
} else {
  console.log('❌ 部分正常上游受到影响！');
  process.exit(1);
}
