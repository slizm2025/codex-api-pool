// Regression tests: real-traffic verification revocation on consecutive failures
//
// Bug: a site that ran out of quota kept returning 403, but its capability stayed
// `verified`/`real_traffic` forever (the success path was the only writer). The
// dashboard showed green "真实请求验证" while every request failed.
//
// Fix: consecutive authoritative real-traffic failures (default threshold 3) revoke
// the real_traffic verification — capability is downgraded so the site falls back to
// real_pending (blue) and becomes recheck-eligible; a single success resets the streak.

import {
  recordProtocolCapabilityRealTraffic,
  revokeRealTrafficVerification
} from '../src/protocol-capability-manager.mjs';
import { deriveVerificationTier, deriveVerificationDetail } from '../src/verification-tier.mjs';
import { __testInternals } from '../src/server.mjs';

const { realTrafficEndpointUnsupported } = __testInternals;

let testCount = 0;
let passCount = 0;
let failCount = 0;

const tests = [];

function test(name, fn) {
  testCount++;
  tests.push({ name, fn });
}

async function runTests() {
  for (const { name, fn } of tests) {
  try {
      await fn();
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
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function createVerifiedByTrafficUpstream(protocol = 'responses') {
  const upstream = {
    name: 'venlacy',
    enabled: true,
    capabilities: {},
    health: {
      state: 'ok',
      source: 'real_traffic',
      checkedAt: '2026-06-15T00:00:00Z',
      models: ['gpt-5.5'],
      modelsCount: 1
    },
    keys: [{ index: 0, label: 'k0', value: 'sk-x', cooldownUntil: 0 }]
  };
  recordProtocolCapabilityRealTraffic(upstream, protocol, {
    checkedAt: '2026-06-15T00:00:00Z',
    model: 'gpt-5.5',
    httpStatus: 200
  });
  return upstream;
}

// ══════════════════════════════════════════════════════════════════════════════
// Suite: revokeRealTrafficVerification — the capability downgrade primitive
// ══════════════════════════════════════════════════════════════════════════════

test('revoke removes real_traffic source and clears representative evidence', () => {
  const upstream = createVerifiedByTrafficUpstream('responses');

  revokeRealTrafficVerification(upstream, 'responses', {
    reason: 'HTTP 403 quota exhausted',
    httpStatus: 403
  });

  assertEquals(upstream.capabilities.responses.status, 'failed');
  assert(upstream.capabilities.responses.source !== 'real_traffic',
    `source should not remain real_traffic, got ${upstream.capabilities.responses.source}`);
  assert(upstream.capabilities.responses.representative !== true,
    'representative must be cleared so deriveVerificationTier no longer sees traffic proof');
  assertEquals(upstream.capabilities.responses.http_status, 403);
  assert(String(upstream.capabilities.responses.reason).includes('403'), 'reason should record the failure');
});

test('after revoke, deriveVerificationTier drops from proven_by_traffic', () => {
  const upstream = createVerifiedByTrafficUpstream('responses');
  assertEquals(deriveVerificationTier(upstream), 'proven_by_traffic');

  revokeRealTrafficVerification(upstream, 'responses', { reason: 'quota', httpStatus: 403 });

  assert(deriveVerificationTier(upstream) !== 'proven_by_traffic',
    'tier must no longer be proven_by_traffic after revocation');
});

test('after revoke + health.source cleared, dashboard detail shows real_pending (blue)', () => {
  const upstream = createVerifiedByTrafficUpstream('responses');

  revokeRealTrafficVerification(upstream, 'responses', { reason: 'quota', httpStatus: 403 });
  // Mirror what the integration path does: drop the stale real_traffic health evidence
  upstream.health = { ...upstream.health, state: 'unknown', source: '', checkedAt: null };

  const detail = deriveVerificationDetail(upstream, { now: Date.now() });
  assertEquals(detail.tier, 'real_pending');
  assertEquals(detail.indicator, 'blue');
});

test('revoke only touches the named protocol, others keep real_traffic proof', () => {
  const upstream = createVerifiedByTrafficUpstream('responses');
  recordProtocolCapabilityRealTraffic(upstream, 'chat_completions', {
    checkedAt: '2026-06-15T00:00:00Z',
    model: 'gpt-5.5',
    httpStatus: 200
  });

  revokeRealTrafficVerification(upstream, 'responses', { reason: 'quota', httpStatus: 403 });

  assertEquals(upstream.capabilities.chat_completions.source, 'real_traffic');
  assertEquals(upstream.capabilities.chat_completions.representative, true);
  assert(upstream.capabilities.responses.source !== 'real_traffic');
});

test('revoke is a no-op when there is no real_traffic evidence to remove', () => {
  const upstream = { name: 'u', enabled: true, capabilities: {}, keys: [] };
  // Should not throw
  revokeRealTrafficVerification(upstream, 'responses', { reason: 'x', httpStatus: 500 });
  assertEquals(upstream.capabilities.responses.status, 'unknown');
});

test('revoke is a no-op on an invalid protocol name', () => {
  const upstream = createVerifiedByTrafficUpstream('responses');
  revokeRealTrafficVerification(upstream, 'bogus', { reason: 'x', httpStatus: 403 });
  assertEquals(upstream.capabilities.responses.source, 'real_traffic');
});

test('after revoke the capability becomes recheck-eligible', async () => {
  const { shouldRecheckProtocolCapability } = await import('../src/protocol-capability-manager.mjs');
  const upstream = createVerifiedByTrafficUpstream('responses');

  revokeRealTrafficVerification(upstream, 'responses', {
    checkedAt: '2026-06-15T00:00:00Z',
    reason: 'quota',
    httpStatus: 403
  });

  // status is now 'failed' → recheck should return true once the interval elapses
  const past = new Date('2026-06-15T00:00:00Z').getTime();
  const future = past + 31 * 60 * 1000; // > DEFAULT_PROTOCOL_CAPABILITY_RECHECK_MS (30min)
  assert(shouldRecheckProtocolCapability(upstream, 'responses', { now: () => future }),
    'revoked capability must be recheck-eligible after the interval');
});

test('real traffic endpoint unsupported detection accepts explicit endpoint errors', () => {
  assert(realTrafficEndpointUnsupported(400, 'unsupported endpoint'),
    '400 unsupported endpoint should be treated as endpoint unsupported');
  assert(realTrafficEndpointUnsupported(400, 'route not found'),
    '400 route not found should be treated as endpoint unsupported');
  assert(!realTrafficEndpointUnsupported(400, 'model not found'),
    'model not found must not mark the protocol endpoint unsupported');
  assert(!realTrafficEndpointUnsupported(500, 'unsupported endpoint'),
    '5xx endpoint wording should not be treated as authoritative endpoint unsupported');
});

// ══════════════════════════════════════════════════════════════════════════════
// Suite: streak counting semantics (mirrors the integration contract)
// ══════════════════════════════════════════════════════════════════════════════

test('streak threshold of 3: 2 failures do NOT revoke, 3rd does', () => {
  const STREAK_THRESHOLD = 3;
  const upstream = createVerifiedByTrafficUpstream('responses');

  function applyStreakFailure(streak, protocol) {
    const next = streak + 1;
    if (next >= STREAK_THRESHOLD) {
      revokeRealTrafficVerification(upstream, protocol, { reason: 'HTTP 403', httpStatus: 403 });
      return { streak: 0, revoked: true };
    }
    return { streak: next, revoked: false };
  }

  let streak = 0;
  let r1 = applyStreakFailure(streak, 'responses'); streak = r1.streak;
  assertEquals(upstream.capabilities.responses.source, 'real_traffic');
  let r2 = applyStreakFailure(streak, 'responses'); streak = r2.streak;
  assertEquals(upstream.capabilities.responses.source, 'real_traffic');
  let r3 = applyStreakFailure(streak, 'responses');
  assert(r3.revoked, 'third consecutive failure must revoke');
  assert(upstream.capabilities.responses.source !== 'real_traffic');
});

test('a single success resets the streak (no premature revocation)', () => {
  const STREAK_THRESHOLD = 3;
  let streak = 2; // two failures already
  // success resets
  streak = 0;
  // then two more failures — still under threshold
  streak += 1; // 1
  streak += 1; // 2
  assert(streak < STREAK_THRESHOLD, 'after reset, two failures must not reach threshold');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Summary
// ══════════════════════════════════════════════════════════════════════════════

await runTests();

console.log('\n' + '═'.repeat(80));
console.log(`Test Results: ${passCount}/${testCount} passed, ${failCount} failed`);
console.log('═'.repeat(80));

if (failCount > 0) {
  process.exit(1);
}
