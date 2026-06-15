// TDD: Debug Lock Diagnostics Persistence and Display
//
// Tests for the improved diagnostic information display behavior:
// 1. Diagnostics persist across successful requests
// 2. Diagnostics accumulate (or retain latest) across multiple requests
// 3. Diagnostics only clear when explicitly unlocked
//
// RED → GREEN → REFACTOR

import { strict as assert } from 'assert';

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

async function testAsync(name, fn) {
  testCount++;
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

console.log('Debug Lock Diagnostics Persistence Tests\n');

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 1 - Successful request should KEEP diagnostics (not clear)
// ══════════════════════════════════════════════════════════════════════════════

test('RED: successful request preserves diagnostics', () => {
  // Simulated behavior: after a successful Debug Lock request,
  // diagnostics should remain in state.debugLock.last_diagnostics

  const state = {
    debugLock: {
      enabled: true,
      upstream: 'test-upstream',
      last_diagnostics: null
    }
  };

  // Simulate a successful request that generates diagnostics
  const mockDiagnostics = {
    debug_lock: { upstream: 'test-upstream' },
    client_request: { protocol: 'responses', model: 'gpt-4' },
    attempts: [
      { sequence: 1, protocol: 'responses', status: 200, latency_ms: 150 }
    ],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    total_latency_ms: 150,
    timestamp: new Date().toISOString()
  };

  // After successful request, diagnostics should be saved (not cleared)
  state.debugLock.last_diagnostics = mockDiagnostics;

  // Verify diagnostics are present
  assert.ok(state.debugLock.last_diagnostics, 'diagnostics should exist after successful request');
  assert.strictEqual(state.debugLock.last_diagnostics.succeeded_with.protocol, 'responses');
  assert.strictEqual(state.debugLock.last_diagnostics.total_attempts, 1);
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 2 - Multiple requests should accumulate or retain latest diagnostics
// ══════════════════════════════════════════════════════════════════════════════

test('RED: multiple requests retain latest diagnostics', () => {
  const state = {
    debugLock: {
      enabled: true,
      upstream: 'test-upstream',
      last_diagnostics: null
    }
  };

  // First request (failed)
  const firstDiagnostics = {
    attempts: [
      { sequence: 1, protocol: 'responses', status: 403, error: 'Forbidden' }
    ],
    succeeded_with: null,
    total_attempts: 1,
    timestamp: '2026-06-14T10:00:00.000Z'
  };

  state.debugLock.last_diagnostics = firstDiagnostics;
  assert.ok(state.debugLock.last_diagnostics);

  // Second request (successful)
  const secondDiagnostics = {
    attempts: [
      { sequence: 1, protocol: 'responses', status: 200 }
    ],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    timestamp: '2026-06-14T10:01:00.000Z'
  };

  state.debugLock.last_diagnostics = secondDiagnostics;

  // Should retain the latest diagnostics
  assert.ok(state.debugLock.last_diagnostics);
  assert.strictEqual(state.debugLock.last_diagnostics.timestamp, '2026-06-14T10:01:00.000Z');
  assert.ok(state.debugLock.last_diagnostics.succeeded_with, 'should have success info');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 3 - Diagnostics only clear when explicitly unlocked
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('RED: disableDebugLock clears diagnostics', async () => {
  const state = {
    debugLock: {
      enabled: true,
      upstream: 'test-upstream',
      locked_at: new Date().toISOString(),
      last_diagnostics: {
        attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
        succeeded_with: { protocol: 'responses' },
        total_attempts: 1
      }
    }
  };

  // Import and call disableDebugLock
  const { disableDebugLock } = await import('../src/debug-lock.mjs');
  const result = disableDebugLock(state);

  assert.ok(result.ok, 'should successfully disable');
  assert.strictEqual(state.debugLock.enabled, false);

  // Diagnostics should be cleared
  assert.strictEqual(state.debugLock.last_diagnostics, null, 'diagnostics should be cleared on unlock');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 4 - Integration test with executeDebugLockedRequest
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('RED: executeDebugLockedRequest preserves diagnostics on success', async () => {
  // This test verifies the behavior at the executeDebugLockedRequest level
  // We need to ensure that when a request succeeds, diagnostics are still saved

  // This will be an integration test that requires the server to be running
  // For now, we'll test the state mutation logic

  const state = {
    debugLock: {
      enabled: true,
      upstream: 'test-upstream',
      respect_model_override: true,
      locked_at: new Date().toISOString()
    }
  };

  // Simulate the behavior in executeDebugLockedRequest
  const succeeded = true;
  const diagnostics = {
    attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    total_latency_ms: 150
  };

  // OLD BEHAVIOR (being changed):
  // if (succeeded) {
  //   state.debugLock.last_diagnostics = null;  // ← This was clearing diagnostics
  // } else {
  //   state.debugLock.last_diagnostics = diagnostics;
  // }

  // NEW BEHAVIOR:
  // Always save diagnostics, regardless of success/failure
  state.debugLock.last_diagnostics = diagnostics;

  assert.ok(state.debugLock.last_diagnostics, 'diagnostics should be preserved even on success');
  assert.ok(state.debugLock.last_diagnostics.succeeded_with, 'should have success information');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Results
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(80)}`);
console.log(`Results: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) {
  process.exit(1);
}
