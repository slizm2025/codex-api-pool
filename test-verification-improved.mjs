#!/usr/bin/env node
// Test improved verification tier logic

import { deriveVerificationTier } from './src/verification-tier.mjs';

const now = Date.now();

// Simulate improved verificationTier function
function verificationTier(upstream) {
  // Use standard verification tier module for cross-protocol comprehensive status
  if (!upstream.available) return 'unavailable';

  const tier = deriveVerificationTier(upstream);
  if (tier === 'proven_by_traffic') return 'real_verified';
  if (tier === 'proven_by_probe') return 'probe_only';

  // Fallback: if health probe passed but no protocol capability evidence yet
  if (upstream.health?.state === 'ok') return 'probe_only';

  return 'real_pending';
}

const TIER_LABELS = {
  real_verified: '真实流量验证',
  probe_only: '探测验证',
  real_pending: '未验证',
  unavailable: '不可用'
};

console.log('='.repeat(80));
console.log('Improved Verification Tier Logic Test');
console.log('='.repeat(80));
console.log();
console.log('✨ 改进：');
console.log('  1. 标签更清晰："探测验证"代替"一层检测通过"');
console.log('  2. 标签更准确："未验证"代替"可选待真实验证"');
console.log('  3. 使用 verification-tier.mjs 模块（跨 protocol 综合判断）');
console.log();

const scenarios = [
  {
    name: 'Scenario 1: Real traffic on responses protocol',
    upstream: {
      available: true,
      health: { state: 'ok' },
      capabilities: {
        responses: {
          status: 'verified',
          source: 'real_traffic'
        },
        chat_completions: {
          status: 'assumed',
          source: 'user_declared'
        }
      }
    },
    expected: 'real_verified',
    label: '真实流量验证'
  },
  {
    name: 'Scenario 2: Probe verified on multiple protocols',
    upstream: {
      available: true,
      health: { state: 'ok' },
      capabilities: {
        responses: {
          status: 'verified',
          source: 'probe'
        },
        anthropic_messages: {
          status: 'verified',
          source: 'probe'
        }
      }
    },
    expected: 'probe_only',
    label: '探测验证'
  },
  {
    name: 'Scenario 3: Mixed - real traffic on one, probe on another',
    upstream: {
      available: true,
      health: { state: 'ok' },
      capabilities: {
        responses: {
          status: 'verified',
          source: 'real_traffic'
        },
        anthropic_messages: {
          status: 'verified',
          source: 'probe'
        }
      }
    },
    expected: 'real_verified',
    label: '真实流量验证',
    note: '任一 protocol 有真实流量即升级'
  },
  {
    name: 'Scenario 4: Health ok, no protocol capability evidence yet',
    upstream: {
      available: true,
      health: { state: 'ok' },
      capabilities: {
        responses: {
          status: 'assumed',
          source: 'user_declared'
        }
      }
    },
    expected: 'probe_only',
    label: '探测验证',
    note: 'Health probe 通过作为兜底'
  },
  {
    name: 'Scenario 5: Available but health not ok, no evidence',
    upstream: {
      available: true,
      health: { state: 'rate_limited' },
      capabilities: {
        responses: {
          status: 'assumed',
          source: 'user_declared'
        }
      }
    },
    expected: 'real_pending',
    label: '未验证',
    note: '更准确的标签，去掉"可选"的误导'
  },
  {
    name: 'Scenario 6: Disabled upstream',
    upstream: {
      available: false,
      health: { state: 'ok' },
      capabilities: {
        responses: {
          status: 'verified',
          source: 'real_traffic'
        }
      }
    },
    expected: 'unavailable',
    label: '不可用'
  },
  {
    name: 'Scenario 7: api=both with different verification levels',
    upstream: {
      available: true,
      health: { state: 'ok' },
      capabilities: {
        responses: {
          status: 'verified',
          source: 'real_traffic'
        },
        chat_completions: {
          status: 'verified',
          source: 'real_traffic'
        },
        anthropic_messages: {
          status: 'verified',
          source: 'probe'
        }
      }
    },
    expected: 'real_verified',
    label: '真实流量验证',
    note: '跨 protocol 综合判断，任一有真实流量即可'
  }
];

let passed = 0;
let failed = 0;

for (const scenario of scenarios) {
  console.log(`\n${scenario.name}`);
  console.log('-'.repeat(80));

  const tier = verificationTier(scenario.upstream);
  const tierLabel = TIER_LABELS[tier];
  const isCorrect = tier === scenario.expected;

  console.log(`  Expected: ${scenario.expected} (${scenario.label})`);
  console.log(`  Actual:   ${tier} (${tierLabel})`);
  if (scenario.note) {
    console.log(`  Note:     ${scenario.note}`);
  }

  if (isCorrect) {
    console.log(`  ✅ PASS`);
    passed++;
  } else {
    console.log(`  ❌ FAIL`);
    failed++;
  }
}

console.log();
console.log('='.repeat(80));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(80));

if (failed === 0) {
  console.log();
  console.log('✅ 所有测试通过！');
  console.log();
  console.log('改进总结：');
  console.log('  1. ✅ 使用 verification-tier.mjs 标准模块');
  console.log('  2. ✅ 跨 protocol 综合判断（不再受单一 protocol 限制）');
  console.log('  3. ✅ 标签更清晰（"探测验证" vs "一层检测通过"）');
  console.log('  4. ✅ 标签更准确（"未验证" vs "可选待真实验证"）');
  console.log();
  console.log('用户体验改进：');
  console.log('  - 对于 api=both 的 upstream，显示综合验证状态');
  console.log('  - 标签不再误导（去掉"一层"和"可选"）');
  console.log('  - 真实流量验证优先级最高（任一 protocol 即可）');
}

process.exit(failed > 0 ? 1 : 0);
