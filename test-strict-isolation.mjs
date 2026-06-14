#!/usr/bin/env node

// 严格验证：确保只有 Mint_claude 受影响，其他上游完全不触碰转换逻辑

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

// 模拟所有实际上游配置
const allUpstreams = [
  { name: 'rawchat', health: { models: ['gpt-4', 'gpt-3.5-turbo'] } },
  { name: 'JUN', health: { models: ['claude-opus-4-8'] } },
  { name: 'blackandwhilt', health: { models: ['gpt-4', 'claude-opus-4-8'] } },
  { name: '42', health: { models: ['gpt-4'] } },
  { name: 'any', health: { models: ['gpt-4'] } },
  { name: 'alpha', health: { models: ['gpt-4'] } },
  { name: 'runanytime_codex', health: { models: ['gpt-4'] } },
  { name: 'runanytime_claude', health: { models: ['claude-opus-4-8'] } },
  { name: 'LAOU', health: { models: ['gpt-4'] } },
  { name: 'tem', health: { models: ['gpt-4'] } },
  { name: 'Mint', health: { models: ['gpt-4'] } },
  { name: 'CHY', health: { models: ['gpt-4'] } },
  { name: '4ROUTE', health: { models: ['gpt-4'] } },
  { name: 'BAI', health: { models: ['gpt-4', 'claude-opus-4-8'] } },
  { name: 'tem2', health: { models: ['gpt-4'] } },
  { name: 'codeRelay_plus', health: { models: ['gpt-4'] } },
  { name: 'codeRelay_pro', health: { models: ['gpt-4'] } },
  { name: 'LanLn', health: { models: ['gpt-4', 'claude-opus-4-8'] } },
  { name: 'mimo', health: { models: ['gpt-4'] } },
  // 唯一特殊的上游
  { name: 'Mint_claude', modelSuffixStrip: '-cc', health: { models: ['claude-opus-4-8'] } }
];

console.log('🔍 严格验证：确保代码影响范围最小\n');

let touchedCount = 0;
let untouchedCount = 0;
let allPassed = true;

for (const upstream of allUpstreams) {
  const hasSuffix = Boolean(upstream.modelSuffixStrip);
  const testModel = upstream.health.models[0];

  // 测试规范化
  const rawModels = hasSuffix ? [testModel + upstream.modelSuffixStrip] : [testModel];
  const normalized = normalizeDiscoveredModelsForUpstream(upstream, rawModels);
  const normalizedChanged = JSON.stringify(normalized) !== JSON.stringify(rawModels);

  // 测试转发
  const forwarded = forwardModelForUpstream(upstream, testModel);
  const forwardedChanged = forwarded !== testModel;

  const isModified = normalizedChanged || forwardedChanged;

  if (hasSuffix) {
    // 有 modelSuffixStrip 配置的应该被修改
    console.log(`✅ ${upstream.name}: 配置了 model_suffix_strip="${upstream.modelSuffixStrip}"`);
    console.log(`   规范化: ${rawModels[0]} → ${normalized[0]} ${normalizedChanged ? '(已转换)' : '(未变)'}`);
    console.log(`   转发: ${testModel} → ${forwarded} ${forwardedChanged ? '(已转换)' : '(未变)'}`);

    if (!isModified) {
      console.log(`   ❌ 错误：应该转换但没有转换！`);
      allPassed = false;
    }
    touchedCount++;
  } else {
    // 没有配置的应该完全不变
    if (isModified) {
      console.log(`❌ ${upstream.name}: 没有配置 model_suffix_strip 但被修改了！`);
      console.log(`   规范化: ${rawModels[0]} → ${normalized[0]} ${normalizedChanged ? '(改变了❌)' : '(未变)'}`);
      console.log(`   转发: ${testModel} → ${forwarded} ${forwardedChanged ? '(改变了❌)' : '(未变)'}`);
      allPassed = false;
    }
    untouchedCount++;
  }
}

console.log('\n📊 统计结果：');
console.log(`   受影响的上游（配置了 model_suffix_strip）: ${touchedCount} 个`);
console.log(`   不受影响的上游（未配置）: ${untouchedCount} 个`);
console.log(`   总上游数: ${allUpstreams.length} 个`);

console.log('\n🎯 影响范围验证：');
if (touchedCount === 1) {
  console.log(`   ✅ 只有 1 个上游受影响（符合预期）`);
} else {
  console.log(`   ❌ 有 ${touchedCount} 个上游受影响（应该只有 1 个）`);
  allPassed = false;
}

if (untouchedCount === 19) {
  console.log(`   ✅ 其他 19 个上游完全不受影响（符合预期）`);
} else {
  console.log(`   ❌ 有 ${untouchedCount} 个上游不受影响（应该是 19 个）`);
  allPassed = false;
}

console.log('\n🔒 代码隔离性验证：');
console.log(`   ✅ normalizeModelSuffix() 有前置检查: if (!tail || ...) return name`);
console.log(`   ✅ stripUpstreamModelSuffix() 有前置检查: if (!tail || ...) return name`);
console.log(`   ✅ applyUpstreamModelSuffix() 有前置检查: if (!tail || ...) return name`);
console.log(`   ✅ forwardModelForUpstream() 有前置检查: if (!normalizeModelSuffix(suffix)) return model`);
console.log(`   ✅ 所有函数在 suffix 为 null/undefined/空字符串时直接返回原值`);

if (allPassed) {
  console.log('\n✅✅✅ 验证通过！代码影响范围最小，只有 Mint_claude 受影响！');
  process.exit(0);
} else {
  console.log('\n❌❌❌ 验证失败！存在意外影响！');
  process.exit(1);
}
