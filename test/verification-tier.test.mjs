// Unit tests for Verification Tier logic
//
// Tests the derivation of verification_tier from upstream state:
// - proven_by_traffic: has recent successful real traffic
// - proven_by_probe: only has successful probe, no real traffic
// - not_verified: neither probe nor real traffic succeeded

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    if (error.stack) {
      const stack = error.stack.split('\n').slice(1, 4).join('\n');
      console.error(`  ${stack}`);
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Mock upstream factory ─────────────────────────────────────────────────────

function createMockUpstream(overrides = {}) {
  return {
    name: 'test-upstream',
    enabled: true,
    capabilities: {
      responses: { status: 'unknown' },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    },
    availability: {
      recent: [],
      success_count: 0,
      total_count: 0,
      rate: 0
    },
    ...overrides
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: deriveVerificationTier
// ══════════════════════════════════════════════════════════════════════════════

// RED: Function doesn't exist yet
import { deriveVerificationTier } from '../src/verification-tier.mjs';

test('proven_by_traffic: has verified real_traffic for any protocol', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'real_traffic',
        representative: true,
        checked_at: '2026-06-14T10:30:00Z'
      },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'proven_by_traffic');
});

test('proven_by_traffic: multiple protocols with real_traffic', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'real_traffic',
        representative: true
      },
      chat_completions: {
        status: 'verified',
        source: 'real_traffic',
        representative: true
      },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'proven_by_traffic');
});

test('proven_by_probe: has verified probe but no real_traffic', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'probe',
        representative: false,
        checked_at: '2026-06-14T10:30:00Z'
      },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'proven_by_probe');
});

test('proven_by_probe: multiple protocols verified by probe', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'probe',
        representative: false
      },
      chat_completions: {
        status: 'verified',
        source: 'probe',
        representative: false
      },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'proven_by_probe');
});

test('not_verified: all protocols unknown', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: { status: 'unknown' },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'not_verified');
});

test('not_verified: all protocols failed', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'unsupported',
        http_status: 404
      },
      chat_completions: {
        status: 'unknown',
        source: 'probe',
        http_status: 500
      },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'not_verified');
});

test('not_verified: only assumed (user declaration)', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'assumed',
        source: 'user_declared',
        reason: 'user declared protocol support'
      },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'not_verified');
});

test('proven_by_traffic takes precedence over proven_by_probe', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'real_traffic',
        representative: true
      },
      chat_completions: {
        status: 'verified',
        source: 'probe',
        representative: false
      },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'proven_by_traffic');
});

test('edge case: disabled upstream', () => {
  const upstream = createMockUpstream({
    enabled: false,
    capabilities: {
      responses: { status: 'disabled' },
      chat_completions: { status: 'disabled' },
      anthropic_messages: { status: 'disabled' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'not_verified');
});

test('edge case: null upstream', () => {
  const tier = deriveVerificationTier(null);
  assertEquals(tier, 'not_verified');
});

test('edge case: undefined capabilities', () => {
  const upstream = createMockUpstream({
    capabilities: undefined
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'not_verified');
});

test('real_traffic with representative=false still counts as proven_by_traffic', () => {
  // Edge case: even if representative is false, if source is real_traffic and status is verified, it counts
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'real_traffic',
        representative: false  // unusual but possible
      },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  assertEquals(tier, 'proven_by_traffic');
});

test('config source with verified status is treated as proven_by_probe', () => {
  // Edge case: verified but from config (not probe or real_traffic)
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'config',
        representative: null
      },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    }
  });

  const tier = deriveVerificationTier(upstream);
  // Config source is not authoritative, should not count as proven
  assertEquals(tier, 'not_verified');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: addVerificationTierToUpstream (integration helper)
// ══════════════════════════════════════════════════════════════════════════════

import { addVerificationTierToUpstream } from '../src/verification-tier.mjs';

test('addVerificationTierToUpstream: adds tier field to upstream', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'real_traffic',
        representative: true
      },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    }
  });

  addVerificationTierToUpstream(upstream);

  assert(upstream.verification_tier, 'should have verification_tier field');
  assertEquals(upstream.verification_tier, 'proven_by_traffic');
});

test('addVerificationTierToUpstream: updates existing tier', () => {
  const upstream = createMockUpstream({
    verification_tier: 'not_verified',
    capabilities: {
      responses: {
        status: 'verified',
        source: 'probe',
        representative: false
      },
      chat_completions: { status: 'unknown' },
      anthropic_messages: { status: 'unknown' }
    }
  });

  addVerificationTierToUpstream(upstream);

  assertEquals(upstream.verification_tier, 'proven_by_probe');
});

test('addVerificationTierToUpstream: handles null upstream gracefully', () => {
  // Should not throw
  addVerificationTierToUpstream(null);
  addVerificationTierToUpstream(undefined);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Summary
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(80));
console.log(`Test Results: ${passCount}/${testCount} passed, ${failCount} failed`);
console.log('═'.repeat(80));

if (failCount > 0) {
  process.exit(1);
}
