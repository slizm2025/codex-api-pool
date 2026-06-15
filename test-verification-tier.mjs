#!/usr/bin/env node

/**
 * Test script to diagnose verification tier display issues
 *
 * Scenario: Claude models are available and verified but not showing
 * in the correct tier (real_verified or probe_only)
 */

// Mock upstream states for testing verification tier logic
const testUpstreams = [
  {
    name: 'claude-upstream-1',
    enabled: true,
    quarantined: false,
    available: true,
    health: {
      state: 'ok',
      models: ['claude-opus-4-8', 'claude-sonnet-4-6']
    },
    representative_availability: {
      verified: true
    }
  },
  {
    name: 'claude-upstream-2',
    enabled: true,
    quarantined: false,
    available: true,
    health: {
      state: 'ok',
      models: ['claude-opus-4-8']
    },
    representative_availability: {
      verified: false
    }
  },
  {
    name: 'gpt-upstream',
    enabled: true,
    quarantined: false,
    available: true,
    health: {
      state: 'ok',
      models: ['gpt-5.5']
    },
    representative_availability: {
      verified: true
    }
  },
  {
    name: 'pending-upstream',
    enabled: true,
    quarantined: false,
    available: true,
    health: {
      state: 'unknown'
    },
    representative_availability: {
      verified: false
    }
  },
  {
    name: 'unavailable-upstream',
    enabled: true,
    quarantined: false,
    available: false,
    health: {
      state: 'rate_limited'
    }
  }
];

// Replicate the verificationTier logic from server.mjs:10334
function verificationTier(upstream) {
  if (upstream.available && upstream.representative_availability?.verified === true) return 'real_verified';
  if (upstream.available && upstream.health?.state === 'ok') return 'probe_only';
  if (upstream.available) return 'real_pending';
  return 'unavailable';
}

console.log('=== Verification Tier Test ===\n');

testUpstreams.forEach(upstream => {
  const tier = verificationTier(upstream);
  console.log(`${upstream.name}:`);
  console.log(`  available: ${upstream.available}`);
  console.log(`  health.state: ${upstream.health?.state || 'N/A'}`);
  console.log(`  representative_availability.verified: ${upstream.representative_availability?.verified ?? 'N/A'}`);
  console.log(`  => tier: ${tier}`);
  console.log('');
});

console.log('\n=== Analysis ===');
console.log('Expected behavior:');
console.log('- claude-upstream-1: real_verified (available + verified)');
console.log('- claude-upstream-2: probe_only (available + health ok, but not verified)');
console.log('- gpt-upstream: real_verified (available + verified)');
console.log('- pending-upstream: real_pending (available but health unknown)');
console.log('- unavailable-upstream: unavailable (not available)');
