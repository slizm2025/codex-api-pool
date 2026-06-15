#!/usr/bin/env node

/**
 * Test script to verify the fix for verification tier display issue
 */

// Mock representativeEvidenceFresh function
function representativeEvidenceFresh(item, at) {
  const checkedAtMs = Date.parse(item.checked_at || '');
  if (!Number.isFinite(checkedAtMs)) return false;
  const ageMs = at - checkedAtMs;
  const maxAgeMs = 30 * 60 * 1000; // 30 minutes
  return ageMs < maxAgeMs;
}

const FRESH_REPRESENTATIVE_EVIDENCE_MULTIPLIER = 1.2;

function now() {
  return Date.now();
}

// FIXED version of representativeAvailability
function representativeAvailability(upstream, {
  model = '',
  protocol = 'responses',
  at = now()
} = {}) {
  const normalizedModel = String(model || '').trim();
  const evidence = [];
  for (const key of upstream?.keys || []) {
    const byModel = key?.representativeEvidence?.[protocol] || {};

    if (normalizedModel) {
      // Specific model: collect evidence for that model only
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
      // No model specified: aggregate evidence across ALL models
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
  const latest = evidence
    .slice()
    .sort((a, b) => b.checkedAtMs - a.checkedAtMs)[0];
  const state = freshEvidence.length > 0
    ? 'fresh'
    : evidence.length > 0
      ? 'stale'
      : 'missing';
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
    multiplier: state === 'fresh' ? FRESH_REPRESENTATIVE_EVIDENCE_MULTIPLIER : 1
  };
}

function verificationTier(upstream) {
  if (upstream.available && upstream.representative_availability?.verified === true) return 'real_verified';
  if (upstream.available && upstream.health?.state === 'ok') return 'probe_only';
  if (upstream.available) return 'real_pending';
  return 'unavailable';
}

// Test data
const testAt = Date.now();
const recentTimestamp = new Date(testAt - 5 * 60 * 1000).toISOString(); // 5 minutes ago
const oldTimestamp = new Date(testAt - 60 * 60 * 1000).toISOString(); // 60 minutes ago

const testUpstreams = [
  {
    name: 'claude-upstream-verified',
    available: true,
    enabled: true,
    quarantined: false,
    health: { state: 'ok' },
    keys: [
      {
        label: 'key-1',
        representativeEvidence: {
          responses: {
            'claude-opus-4-8': {
              checked_at: recentTimestamp,
              source: 'real_traffic'
            },
            'claude-sonnet-4-6': {
              checked_at: recentTimestamp,
              source: 'real_traffic'
            }
          }
        }
      }
    ]
  },
  {
    name: 'gpt-upstream-verified',
    available: true,
    enabled: true,
    quarantined: false,
    health: { state: 'ok' },
    keys: [
      {
        label: 'key-1',
        representativeEvidence: {
          responses: {
            'gpt-5.5': {
              checked_at: recentTimestamp,
              source: 'real_traffic'
            }
          }
        }
      }
    ]
  },
  {
    name: 'mixed-upstream',
    available: true,
    enabled: true,
    quarantined: false,
    health: { state: 'ok' },
    keys: [
      {
        label: 'key-1',
        representativeEvidence: {
          responses: {
            'claude-opus-4-8': {
              checked_at: recentTimestamp,
              source: 'real_traffic'
            },
            'gpt-4o': {
              checked_at: oldTimestamp, // stale
              source: 'real_traffic'
            }
          }
        }
      }
    ]
  },
  {
    name: 'no-evidence-upstream',
    available: true,
    enabled: true,
    quarantined: false,
    health: { state: 'ok' },
    keys: [
      {
        label: 'key-1',
        representativeEvidence: {
          responses: {}
        }
      }
    ]
  }
];

console.log('=== Verification Tier Fix Test ===\n');

const scenarios = [
  { name: 'Scenario 1: With model override (gpt-5.5)', model: 'gpt-5.5' },
  { name: 'Scenario 2: No model override (filter all)', model: '' },
  { name: 'Scenario 3: With model override (claude-opus-4-8)', model: 'claude-opus-4-8' }
];

scenarios.forEach(scenario => {
  console.log(`\n${scenario.name}`);
  console.log('='.repeat(60));

  testUpstreams.forEach(upstream => {
    const repAvail = representativeAvailability(upstream, {
      model: scenario.model,
      protocol: 'responses',
      at: testAt
    });

    upstream.representative_availability = repAvail;
    const tier = verificationTier(upstream);

    console.log(`\n${upstream.name}:`);
    console.log(`  Model filter: ${scenario.model || '(none - aggregate)'}`);
    console.log(`  Aggregated: ${repAvail.aggregated}`);
    console.log(`  State: ${repAvail.state}`);
    console.log(`  Verified: ${repAvail.verified}`);
    console.log(`  Fresh evidence: ${repAvail.fresh_evidence_count}`);
    console.log(`  Total evidence: ${repAvail.evidence_count}`);
    console.log(`  Sources: [${repAvail.sources.join(', ')}]`);
    console.log(`  => Verification Tier: ${tier}`);

    // Validate expectations
    if (scenario.model === '') {
      // When no model override, Claude upstream should be verified if it has ANY fresh evidence
      if (upstream.name === 'claude-upstream-verified') {
        if (tier !== 'real_verified') {
          console.log(`  ❌ FAIL: Expected real_verified, got ${tier}`);
        } else {
          console.log(`  ✅ PASS: Correctly shows as real_verified`);
        }
      }
    } else if (scenario.model === 'gpt-5.5') {
      // With gpt-5.5 override, only gpt-upstream should be verified
      if (upstream.name === 'gpt-upstream-verified') {
        if (tier !== 'real_verified') {
          console.log(`  ❌ FAIL: Expected real_verified, got ${tier}`);
        } else {
          console.log(`  ✅ PASS: Correctly shows as real_verified`);
        }
      } else if (upstream.name === 'claude-upstream-verified') {
        if (repAvail.verified) {
          console.log(`  ❌ FAIL: Claude upstream should not be verified for GPT model`);
        } else {
          console.log(`  ✅ PASS: Correctly not verified for GPT model`);
        }
      }
    } else if (scenario.model === 'claude-opus-4-8') {
      // With claude-opus-4-8 override, claude upstreams should be verified
      if (upstream.name === 'claude-upstream-verified' || upstream.name === 'mixed-upstream') {
        if (tier !== 'real_verified') {
          console.log(`  ❌ FAIL: Expected real_verified, got ${tier}`);
        } else {
          console.log(`  ✅ PASS: Correctly shows as real_verified`);
        }
      }
    }
  });
});

console.log('\n\n=== Summary ===');
console.log('The fix ensures that when no model override is set (filter all):');
console.log('- representativeAvailability aggregates evidence across ALL models');
console.log('- Claude upstreams with fresh evidence show as verified=true');
console.log('- Verification tier correctly shows real_verified for those upstreams');
console.log('\nWhen a specific model override is active:');
console.log('- Only evidence for that specific model is considered');
console.log('- Behavior remains unchanged from before');
