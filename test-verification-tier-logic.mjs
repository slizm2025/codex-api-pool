#!/usr/bin/env node
// Test verification tier logic for dashboard upstream cards

/**
 * Dashboard verificationTier function (from server.mjs:10664):
 *
 * function verificationTier(upstream) {
 *   if (upstream.available && upstream.representative_availability?.verified === true) return 'real_verified';
 *   if (upstream.available && upstream.health?.state === 'ok') return 'probe_only';
 *   if (upstream.available) return 'real_pending';
 *   return 'unavailable';
 * }
 *
 * Labels:
 * - real_verified: "真实请求验证"
 * - probe_only: "一层检测通过"
 * - real_pending: "可选待真实验证"
 * - unavailable: "不可用"
 */

const now = Date.now();
const REPRESENTATIVE_EVIDENCE_TTL_MS = 30 * 60 * 1000;

function representativeEvidenceFresh(item, at = now) {
  const expiresAt = Date.parse(item?.expires_at || '');
  return Number.isFinite(expiresAt) && expiresAt > at;
}

function representativeAvailability(upstream, { model = '', protocol = 'responses', at = now } = {}) {
  const normalizedModel = String(model || '').trim();
  const evidence = [];

  for (const key of upstream?.keys || []) {
    const byModel = key?.representativeEvidence?.[protocol] || {};

    if (normalizedModel) {
      const item = byModel[normalizedModel];
      if (!item) continue;
      const checkedAtMs = Date.parse(item.checked_at || '');
      evidence.push({
        keyLabel: key.label || '',
        source: String(item.source || ''),
        checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
        fresh: representativeEvidenceFresh(item, at)
      });
    } else {
      for (const [modelName, item] of Object.entries(byModel)) {
        if (!item) continue;
        const checkedAtMs = Date.parse(item.checked_at || '');
        evidence.push({
          keyLabel: key.label || '',
          modelName: modelName,
          source: String(item.source || ''),
          checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
          fresh: representativeEvidenceFresh(item, at)
        });
      }
    }
  }

  const freshEvidence = evidence.filter((item) => item.fresh);
  const latest = evidence.slice().sort((a, b) => b.checkedAtMs - a.checkedAtMs)[0];
  const state = freshEvidence.length > 0 ? 'fresh' : evidence.length > 0 ? 'stale' : 'missing';

  return {
    protocol,
    model: normalizedModel,
    aggregated: !normalizedModel,
    state,
    verified: freshEvidence.length > 0,
    fresh_evidence_count: freshEvidence.length,
    evidence_count: evidence.length,
    sources: [...new Set(freshEvidence.map((item) => item.source).filter(Boolean))].sort(),
    latest_checked_at: latest?.checkedAtMs ? new Date(latest.checkedAtMs).toISOString() : '',
    multiplier: state === 'fresh' ? 1.15 : 1
  };
}

function verificationTier(upstream) {
  if (upstream.available && upstream.representative_availability?.verified === true) return 'real_verified';
  if (upstream.available && upstream.health?.state === 'ok') return 'probe_only';
  if (upstream.available) return 'real_pending';
  return 'unavailable';
}

const TIER_LABELS = {
  real_verified: '真实请求验证',
  probe_only: '一层检测通过',
  real_pending: '可选待真实验证',
  unavailable: '不可用'
};

// Test scenarios
const scenarios = [
  {
    name: 'Scenario 1: Fresh real traffic evidence',
    upstream: {
      available: true,
      health: { state: 'ok' },
      keys: [{
        label: 'key1',
        representativeEvidence: {
          responses: {
            'gpt-5.5': {
              source: 'real_traffic',
              checked_at: new Date(now - 5 * 60 * 1000).toISOString(),
              expires_at: new Date(now + 25 * 60 * 1000).toISOString()
            }
          }
        }
      }]
    },
    expected: 'real_verified',
    reason: '有新鲜的真实请求成功证据'
  },
  {
    name: 'Scenario 2: Stale real traffic evidence',
    upstream: {
      available: true,
      health: { state: 'ok' },
      keys: [{
        label: 'key1',
        representativeEvidence: {
          responses: {
            'gpt-5.5': {
              source: 'real_traffic',
              checked_at: new Date(now - 35 * 60 * 1000).toISOString(),
              expires_at: new Date(now - 5 * 60 * 1000).toISOString()
            }
          }
        }
      }]
    },
    expected: 'probe_only',
    reason: '真实请求证据过期，降级到 probe_only（health state ok）'
  },
  {
    name: 'Scenario 3: Health probe OK, no real traffic yet',
    upstream: {
      available: true,
      health: { state: 'ok' },
      keys: [{ label: 'key1', representativeEvidence: {} }]
    },
    expected: 'probe_only',
    reason: 'Health probe 通过但没有真实请求证据'
  },
  {
    name: 'Scenario 4: Available but health not ok, no evidence',
    upstream: {
      available: true,
      health: { state: 'missing_key' },
      keys: [{ label: 'key1', representativeEvidence: {} }]
    },
    expected: 'real_pending',
    reason: 'Available 但 health 不是 ok，也没有真实请求证据'
  },
  {
    name: 'Scenario 5: Not available',
    upstream: {
      available: false,
      health: { state: 'ok' },
      keys: [{ label: 'key1', representativeEvidence: {} }]
    },
    expected: 'unavailable',
    reason: 'available=false 直接不可用'
  },
  {
    name: 'Scenario 6: Available, health rate_limited, has stale evidence',
    upstream: {
      available: true,
      health: { state: 'rate_limited' },
      keys: [{
        label: 'key1',
        representativeEvidence: {
          responses: {
            'gpt-5.5': {
              source: 'real_traffic',
              checked_at: new Date(now - 40 * 60 * 1000).toISOString(),
              expires_at: new Date(now - 10 * 60 * 1000).toISOString()
            }
          }
        }
      }]
    },
    expected: 'real_pending',
    reason: 'Health 是 rate_limited（非 ok），证据过期（verified=false），降级到 real_pending'
  },
  {
    name: 'Scenario 7: Disabled upstream (available=false by definition)',
    upstream: {
      enabled: false,
      available: false,
      health: { state: 'ok' },
      keys: [{
        label: 'key1',
        representativeEvidence: {
          responses: {
            'gpt-5.5': {
              source: 'real_traffic',
              checked_at: new Date(now - 5 * 60 * 1000).toISOString(),
              expires_at: new Date(now + 25 * 60 * 1000).toISOString()
            }
          }
        }
      }]
    },
    expected: 'unavailable',
    reason: 'Disabled upstream → available=false → unavailable'
  },
  {
    name: 'Scenario 8: Available, health ok, but no keys',
    upstream: {
      available: true,
      health: { state: 'ok' },
      keys: []
    },
    expected: 'probe_only',
    reason: 'Health ok 但没有 keys，无证据 → verified=false → probe_only'
  }
];

console.log('='.repeat(80));
console.log('Dashboard Verification Tier Logic Test');
console.log('='.repeat(80));
console.log();

let passed = 0;
let failed = 0;
const issues = [];

for (const scenario of scenarios) {
  console.log(`\n${scenario.name}`);
  console.log('-'.repeat(80));

  // Calculate representative_availability
  const repAvail = representativeAvailability(scenario.upstream, {
    model: '',
    protocol: 'responses',
    at: now
  });

  // Add to upstream for tier calculation
  scenario.upstream.representative_availability = repAvail;

  // Calculate tier
  const tier = verificationTier(scenario.upstream);
  const tierLabel = TIER_LABELS[tier];

  // Check result
  const isCorrect = tier === scenario.expected;

  console.log(`  upstream.available: ${scenario.upstream.available}`);
  console.log(`  upstream.health.state: ${scenario.upstream.health?.state}`);
  console.log(`  representative_availability.verified: ${repAvail.verified}`);
  console.log(`  representative_availability.state: ${repAvail.state}`);
  console.log(`  representative_availability.fresh_evidence_count: ${repAvail.fresh_evidence_count}`);
  console.log(`  representative_availability.evidence_count: ${repAvail.evidence_count}`);
  console.log();
  console.log(`  Expected tier: ${scenario.expected} (${TIER_LABELS[scenario.expected]})`);
  console.log(`  Actual tier:   ${tier} (${tierLabel})`);
  console.log(`  Reason: ${scenario.reason}`);
  console.log();

  if (isCorrect) {
    console.log(`  ✅ PASS`);
    passed++;
  } else {
    console.log(`  ❌ FAIL`);
    failed++;
    issues.push({
      name: scenario.name,
      expected: scenario.expected,
      actual: tier,
      reason: scenario.reason,
      repAvail
    });
  }
}

console.log();
console.log('='.repeat(80));
console.log(`Test Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(80));

if (issues.length > 0) {
  console.log();
  console.log('❌ Issues Found:');
  console.log();
  for (const issue of issues) {
    console.log(`  ${issue.name}:`);
    console.log(`    Expected: ${issue.expected} (${TIER_LABELS[issue.expected]})`);
    console.log(`    Actual:   ${issue.actual} (${TIER_LABELS[issue.actual]})`);
    console.log(`    Reason:   ${issue.reason}`);
    console.log();
  }
}

process.exit(failed > 0 ? 1 : 0);
