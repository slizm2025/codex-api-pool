// Unit tests for ProbeResultApplicator
//
// Tests the relationship between probe results, Health State, and Protocol Capability.
// Verifies that a single probe result deterministically updates both state machines.

import { ProtocolCapabilityManager } from '../src/protocol-capability-manager.mjs';

// Try to import ProbeResultApplicator
let applyProbeResult = null;
try {
  const module = await import('../src/probe-result-applicator.mjs');
  applyProbeResult = module.applyProbeResult;
} catch (error) {
  console.log('⚠️  ProbeResultApplicator not implemented yet - tests will fail');
}

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockUpstream(overrides = {}) {
  return {
    name: 'test-upstream',
    enabled: true,
    api: 'openai',
    capabilities: {},
    health: {},
    ...overrides
  };
}

function createMockKey(overrides = {}) {
  return {
    value: 'test-key',
    label: 'test-key-label',
    health: {},
    ...overrides
  };
}

function createMockProbeResult(statusCode, ok = false, body = '') {
  return {
    statusCode,
    ok,
    body,
    latencyMs: 100,
    headers: {},
    error: ok ? '' : 'Error message'
  };
}

function createMockClassified(state, error = '') {
  return {
    state,
    error,
    outcome: state === 'ok' ? 'ok' : 'authoritative_failure',
    authoritative: true,
    representative: true
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Dual State Update - OK probe
// ══════════════════════════════════════════════════════════════════════════════

test('applyProbeResult: ok probe should update both Health and Capability to success states', () => {
  // RED: applyProbeResult doesn't exist yet
  if (!applyProbeResult) {
    throw new Error('applyProbeResult not implemented yet');
  }

  const upstream = createMockUpstream();
  const key = createMockKey();
  const probeResult = createMockProbeResult(200, true, '{"id":"test"}');
  const classified = createMockClassified('ok');

  const action = applyProbeResult(upstream, key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Protocol Capability to verified
  assert(upstream.capabilities.responses, 'Should have responses capability');
  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.source, 'probe');

  // Should update Health State to ok
  assert(upstream.health, 'Should have health');
  assertEquals(upstream.health.state, 'ok');
  assertEquals(upstream.health.httpStatus, 200);

  // Should update Key Health
  assert(key.health, 'Should have key health');
  assertEquals(key.health.state, 'ok');

  // Should not trigger cooldown
  assertEquals(action.shouldCooldown, false);
});

test('applyProbeResult: auth_error probe should update Health to auth_error and trigger cooldown', () => {
  // RED: Test auth_error mapping
  if (!applyProbeResult) {
    throw new Error('applyProbeResult not implemented yet');
  }

  const upstream = createMockUpstream();
  const key = createMockKey();
  const probeResult = createMockProbeResult(401, false, 'Unauthorized');
  const classified = createMockClassified('auth_error', 'Invalid API key');

  const action = applyProbeResult(upstream, key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Protocol Capability (auth_error maps to unknown per existing logic)
  assertEquals(upstream.capabilities.responses.status, 'unknown');

  // Should update Health State to auth_error
  assertEquals(upstream.health.state, 'auth_error');
  assertEquals(upstream.health.httpStatus, 401);
  assertEquals(upstream.health.error, 'Invalid API key');

  // Should update Key Health
  assertEquals(key.health.state, 'auth_error');

  // Should trigger cooldown
  assertEquals(action.shouldCooldown, true);
  assert(action.cooldownReason, 'Should have cooldown reason');
});

test('applyProbeResult: network_error probe should update Health to network_error and trigger cooldown', () => {
  if (!applyProbeResult) {
    throw new Error('applyProbeResult not implemented yet');
  }

  const upstream = createMockUpstream();
  const key = createMockKey();
  const probeResult = createMockProbeResult(0, false, '');
  const classified = createMockClassified('network_error', 'ECONNREFUSED');

  const action = applyProbeResult(upstream, key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Protocol Capability to unknown
  assertEquals(upstream.capabilities.responses.status, 'unknown');

  // Should update Health State to network_error
  assertEquals(upstream.health.state, 'network_error');
  assertEquals(upstream.health.error, 'ECONNREFUSED');

  // Should trigger cooldown
  assertEquals(action.shouldCooldown, true);
});

test('applyProbeResult: server_error probe should update Health to server_error and trigger cooldown', () => {
  if (!applyProbeResult) {
    throw new Error('applyProbeResult not implemented yet');
  }

  const upstream = createMockUpstream();
  const key = createMockKey();
  const probeResult = createMockProbeResult(500, false, 'Internal Server Error');
  const classified = createMockClassified('server_error', 'Server error');

  const action = applyProbeResult(upstream, key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Protocol Capability to unknown
  assertEquals(upstream.capabilities.responses.status, 'unknown');

  // Should update Health State to server_error
  assertEquals(upstream.health.state, 'server_error');
  assertEquals(upstream.health.httpStatus, 500);

  // Should trigger cooldown
  assertEquals(action.shouldCooldown, true);
});

test('applyProbeResult: inconclusive probe should not trigger cooldown', () => {
  if (!applyProbeResult) {
    throw new Error('applyProbeResult not implemented yet');
  }

  const upstream = createMockUpstream();
  const key = createMockKey();
  const probeResult = createMockProbeResult(400, false, 'Bad Request');
  const classified = createMockClassified('inconclusive', 'Ambiguous response');

  const action = applyProbeResult(upstream, key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Health State to inconclusive
  assertEquals(upstream.health.state, 'inconclusive');

  // Should NOT trigger cooldown (inconclusive is not in cooldown list)
  assertEquals(action.shouldCooldown, false);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Verify synchronization between Health and Capability
// ══════════════════════════════════════════════════════════════════════════════

test('applyProbeResult: both Health and Capability should be updated in single call', () => {
  if (!applyProbeResult) {
    throw new Error('applyProbeResult not implemented yet');
  }

  const upstream = createMockUpstream();
  const key = createMockKey();
  const probeResult = createMockProbeResult(200, true);
  const classified = createMockClassified('ok');

  // Before: no capability or health
  assert(!upstream.capabilities.responses, 'Should not have capability before');
  assert(!upstream.health.state, 'Should not have health state before');

  applyProbeResult(upstream, key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // After: both should be updated
  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.health.state, 'ok');

  // Both should have same timestamp
  assertEquals(upstream.capabilities.responses.checked_at, '2026-01-01T00:00:00Z');
  assertEquals(upstream.health.checkedAt, '2026-01-01T00:00:00Z');

  // Both should reference same model
  assertEquals(upstream.capabilities.responses.model, 'gpt-5.5');
  assertEquals(upstream.health.probeModel, 'gpt-5.5');
});

test('applyProbeResult: key health should also be updated', () => {
  if (!applyProbeResult) {
    throw new Error('applyProbeResult not implemented yet');
  }

  const upstream = createMockUpstream();
  const key = createMockKey({ label: 'my-key' });
  const probeResult = createMockProbeResult(200, true);
  const classified = createMockClassified('ok');

  applyProbeResult(upstream, key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Key health should be updated
  assertEquals(key.health.state, 'ok');
  assertEquals(key.health.probeModel, 'gpt-5.5');

  // Upstream health should reference key label
  assertEquals(upstream.health.keyLabel, 'my-key');
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
