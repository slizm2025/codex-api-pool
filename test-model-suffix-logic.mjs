#!/usr/bin/env node

// 测试模型后缀逻辑不影响正常上游

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

// 测试用例
const testCases = [
  {
    name: '正常上游（无 modelSuffixStrip）',
    upstream: {
      name: 'normal_upstream',
      health: { models: ['claude-opus-4-8', 'claude-sonnet-4-6'] }
    },
    rawModels: ['claude-opus-4-8', 'claude-sonnet-4-6'],
    requestModel: 'claude-opus-4-8',
    expectedNormalized: ['claude-opus-4-8', 'claude-sonnet-4-6'],
    expectedForwarded: 'claude-opus-4-8'
  },
  {
    name: 'Mint_claude（有 modelSuffixStrip: "-cc"）',
    upstream: {
      name: 'Mint_claude',
      modelSuffixStrip: '-cc',
      health: { models: ['claude-opus-4-8', 'claude-sonnet-4-6'] } // 已规范化
    },
    rawModels: ['claude-opus-4-8-cc', 'claude-sonnet-4-6-cc'],
    requestModel: 'claude-opus-4-8',
    expectedNormalized: ['claude-opus-4-8', 'claude-sonnet-4-6'],
    expectedForwarded: 'claude-opus-4-8-cc'
  },
  {
    name: '正常上游（空 modelSuffixStrip）',
    upstream: {
      name: 'another_upstream',
      modelSuffixStrip: '',
      health: { models: ['gpt-4', 'gpt-3.5-turbo'] }
    },
    rawModels: ['gpt-4', 'gpt-3.5-turbo'],
    requestModel: 'gpt-4',
    expectedNormalized: ['gpt-3.5-turbo', 'gpt-4'],
    expectedForwarded: 'gpt-4'
  },
  {
    name: 'Mint_claude（health.models 为空，未运行 Health Probe）',
    upstream: {
      name: 'Mint_claude',
      modelSuffixStrip: '-cc',
      health: { models: [] }
    },
    rawModels: [],
    requestModel: 'claude-opus-4-8',
    expectedNormalized: [],
    expectedForwarded: 'claude-opus-4-8-cc' // Fallback 逻辑应用后缀
  }
];

console.log('🧪 测试模型后缀逻辑\n');

let allPassed = true;

for (const tc of testCases) {
  console.log(`📋 测试：${tc.name}`);

  // 测试规范化
  const normalized = normalizeDiscoveredModelsForUpstream(tc.upstream, tc.rawModels);
  const normalizedOk = JSON.stringify(normalized) === JSON.stringify(tc.expectedNormalized);
  console.log(`  规范化：${normalizedOk ? '✅' : '❌'}`);
  console.log(`    输入：${JSON.stringify(tc.rawModels)}`);
  console.log(`    期望：${JSON.stringify(tc.expectedNormalized)}`);
  console.log(`    实际：${JSON.stringify(normalized)}`);

  // 测试请求转发
  const forwarded = forwardModelForUpstream(tc.upstream, tc.requestModel);
  const forwardedOk = forwarded === tc.expectedForwarded;
  console.log(`  转发：${forwardedOk ? '✅' : '❌'}`);
  console.log(`    请求模型：${tc.requestModel}`);
  console.log(`    期望转发：${tc.expectedForwarded}`);
  console.log(`    实际转发：${forwarded}`);

  if (!normalizedOk || !forwardedOk) {
    allPassed = false;
  }

  console.log('');
}

if (allPassed) {
  console.log('✅ 所有测试通过！修改不影响正常上游。');
  process.exit(0);
} else {
  console.log('❌ 部分测试失败！');
  process.exit(1);
}
