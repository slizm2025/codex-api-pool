// Unit and integration tests for Debug Lock Mode
//
// Tests the diagnostic feature that forces all requests to a specific upstream,
// bypassing selection logic and testing protocol adaptation paths.

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

function assertDeepEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 1 - Core State Management
// ══════════════════════════════════════════════════════════════════════════════

// Import functions that don't exist yet
import {
  enableDebugLock,
  disableDebugLock,
  isDebugLockActive,
  getDebugLockState
} from '../src/debug-lock.mjs';

test('enableDebugLock: creates debug lock state', () => {
  const state = {};
  const result = enableDebugLock(state, 'mysite', { respect_model_override: true });

  assert(result.ok, 'should return ok: true');
  assertEquals(result.debug_lock.enabled, true);
  assertEquals(result.debug_lock.upstream, 'mysite');
  assertEquals(result.debug_lock.respect_model_override, true);
  assert(result.debug_lock.locked_at, 'should have locked_at timestamp');

  // Verify state was mutated
  assert(state.debugLock, 'state.debugLock should exist');
  assertEquals(state.debugLock.enabled, true);
  assertEquals(state.debugLock.upstream, 'mysite');
});

test('enableDebugLock: defaults respect_model_override to true', () => {
  const state = {};
  const result = enableDebugLock(state, 'mysite');

  assertEquals(result.debug_lock.respect_model_override, true);
  assertEquals(state.debugLock.respect_model_override, true);
});

test('isDebugLockActive: returns true when locked', () => {
  const state = {
    debugLock: { enabled: true, upstream: 'mysite' }
  };

  assertEquals(isDebugLockActive(state), true);
});

test('isDebugLockActive: returns false when not locked', () => {
  const state = {};
  assertEquals(isDebugLockActive(state), false);
});

test('isDebugLockActive: returns false when disabled', () => {
  const state = {
    debugLock: { enabled: false, upstream: 'mysite' }
  };
  assertEquals(isDebugLockActive(state), false);
});

test('getDebugLockState: returns lock info when active', () => {
  const state = {
    debugLock: {
      enabled: true,
      upstream: 'mysite',
      respect_model_override: false,
      locked_at: '2026-06-14T10:30:00Z'
    }
  };

  const result = getDebugLockState(state);
  assertEquals(result.enabled, true);
  assertEquals(result.upstream, 'mysite');
  assertEquals(result.respect_model_override, false);
  assert(result.locked_duration_seconds >= 0, 'should calculate duration');
});

test('getDebugLockState: returns disabled state when inactive', () => {
  const state = {};
  const result = getDebugLockState(state);

  assertEquals(result.enabled, false);
  assertEquals(result.upstream, undefined);
});

test('disableDebugLock: clears lock state', () => {
  const state = {
    debugLock: {
      enabled: true,
      upstream: 'mysite',
      locked_at: new Date(Date.now() - 3600000).toISOString() // 1 hour ago
    }
  };

  const result = disableDebugLock(state);

  assertEquals(result.ok, true);
  assertEquals(result.debug_lock.enabled, false);
  assertEquals(result.debug_lock.was_locked_to, 'mysite');
  assert(result.debug_lock.locked_duration_seconds > 3500, 'duration should be ~3600');

  // Verify state was cleared
  assert(!state.debugLock || state.debugLock.enabled === false, 'state.debugLock should be cleared or disabled');
});

test('disableDebugLock: returns error when not locked', () => {
  const state = {};
  const result = disableDebugLock(state);

  assertEquals(result.ok, false);
  assert(result.error, 'should have error message');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 2 - Protocol Attempt Logic
// ══════════════════════════════════════════════════════════════════════════════

import {
  buildProtocolAttemptSequence,
  shouldFallbackToNextProtocol
} from '../src/debug-lock.mjs';

test('buildProtocolAttemptSequence: Responses request sequence', () => {
  const sequence = buildProtocolAttemptSequence('responses');

  assertDeepEquals(sequence, [
    { protocol: 'responses', adapter: false },
    { protocol: 'chat_completions', adapter: true },
    { protocol: 'anthropic_messages', adapter: true }
  ]);
});

test('buildProtocolAttemptSequence: Messages request sequence', () => {
  const sequence = buildProtocolAttemptSequence('anthropic_messages');

  assertDeepEquals(sequence, [
    { protocol: 'anthropic_messages', adapter: false }
  ]);
});

test('shouldFallbackToNextProtocol: 404 triggers fallback', () => {
  const result = shouldFallbackToNextProtocol(404, '');

  assertEquals(result.fallback, true);
  assertEquals(result.reason, 'endpoint_not_found');
});

test('shouldFallbackToNextProtocol: 405 triggers fallback', () => {
  const result = shouldFallbackToNextProtocol(405, '');

  assertEquals(result.fallback, true);
  assertEquals(result.reason, 'endpoint_not_found');
});

test('shouldFallbackToNextProtocol: 501 triggers fallback', () => {
  const result = shouldFallbackToNextProtocol(501, '');

  assertEquals(result.fallback, true);
  assertEquals(result.reason, 'endpoint_not_found');
});

test('shouldFallbackToNextProtocol: 400 with unsupported endpoint triggers fallback', () => {
  const result = shouldFallbackToNextProtocol(400, JSON.stringify({
    error: { message: 'unsupported endpoint' }
  }));

  assertEquals(result.fallback, true);
  assertEquals(result.reason, 'endpoint_explicitly_unsupported');
});

test('shouldFallbackToNextProtocol: 400 with route not found triggers fallback', () => {
  const result = shouldFallbackToNextProtocol(400, 'route not found');

  assertEquals(result.fallback, true);
  assertEquals(result.reason, 'endpoint_explicitly_unsupported');
});

test('shouldFallbackToNextProtocol: 400 without endpoint language does not fallback', () => {
  const result = shouldFallbackToNextProtocol(400, JSON.stringify({
    error: { message: 'invalid parameter' }
  }));

  assertEquals(result.fallback, false);
  assertEquals(result.reason, 'bad_request');
});

test('shouldFallbackToNextProtocol: 401 does not fallback', () => {
  const result = shouldFallbackToNextProtocol(401, '');

  assertEquals(result.fallback, false);
  assertEquals(result.reason, 'auth_error');
});

test('shouldFallbackToNextProtocol: 403 does not fallback', () => {
  const result = shouldFallbackToNextProtocol(403, '');

  assertEquals(result.fallback, false);
  assertEquals(result.reason, 'auth_error');
});

test('shouldFallbackToNextProtocol: 429 does not fallback', () => {
  const result = shouldFallbackToNextProtocol(429, '');

  assertEquals(result.fallback, false);
  assertEquals(result.reason, 'rate_limited');
});

test('shouldFallbackToNextProtocol: 500 does not fallback', () => {
  const result = shouldFallbackToNextProtocol(500, '');

  assertEquals(result.fallback, false);
  assertEquals(result.reason, 'server_error');
});

test('shouldFallbackToNextProtocol: 502 does not fallback', () => {
  const result = shouldFallbackToNextProtocol(502, '');

  assertEquals(result.fallback, false);
  assertEquals(result.reason, 'server_error');
});

test('shouldFallbackToNextProtocol: 503 does not fallback', () => {
  const result = shouldFallbackToNextProtocol(503, '');

  assertEquals(result.fallback, false);
  assertEquals(result.reason, 'server_error');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 3 - Diagnostics Generation
// ══════════════════════════════════════════════════════════════════════════════

import {
  buildDebugAttemptDiagnostics
} from '../src/debug-lock.mjs';

test('buildDebugAttemptDiagnostics: generates complete diagnostics', () => {
  const attempts = [
    {
      sequence: 1,
      protocol: 'responses',
      endpoint: '/v1/responses',
      adapter: false,
      url: 'https://api.example.com/v1/responses',
      status: 404,
      error: 'Not Found',
      error_body: '{"error": {"message": "Endpoint not found"}}',
      latency_ms: 123,
      fallback_reason: 'endpoint_not_found'
    },
    {
      sequence: 2,
      protocol: 'chat_completions',
      endpoint: '/v1/chat/completions',
      adapter: true,
      adapter_conversions: ['input_text->messages'],
      adapter_stripped: [],
      production_disabled: false,
      url: 'https://api.example.com/v1/chat/completions',
      status: 200,
      latency_ms: 456,
      tokens: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      },
      streaming: true
    }
  ];

  const debugLockState = {
    upstream: 'mysite',
    locked_at: '2026-06-14T10:30:00Z',
    respect_model_override: true
  };

  const clientRequest = {
    protocol: 'responses',
    model: 'gpt-5.5',
    model_sent: 'gpt-5.5'
  };

  const diagnostics = buildDebugAttemptDiagnostics(attempts, debugLockState, clientRequest);

  assert(diagnostics.debug_lock, 'should have debug_lock section');
  assertEquals(diagnostics.debug_lock.upstream, 'mysite');
  assertEquals(diagnostics.debug_lock.respect_model_override, true);

  assert(diagnostics.client_request, 'should have client_request section');
  assertEquals(diagnostics.client_request.protocol, 'responses');
  assertEquals(diagnostics.client_request.model, 'gpt-5.5');

  assert(Array.isArray(diagnostics.attempts), 'should have attempts array');
  assertEquals(diagnostics.attempts.length, 2);
  assertEquals(diagnostics.attempts[0].sequence, 1);
  assertEquals(diagnostics.attempts[0].protocol, 'responses');
  assertEquals(diagnostics.attempts[1].sequence, 2);
  assertEquals(diagnostics.attempts[1].protocol, 'chat_completions');

  assert(diagnostics.succeeded_with, 'should have succeeded_with');
  assertEquals(diagnostics.succeeded_with.protocol, 'chat_completions');
  assertEquals(diagnostics.succeeded_with.adapter, true);
  assertEquals(diagnostics.succeeded_with.sequence, 2);

  assertEquals(diagnostics.total_attempts, 2);
  assert(diagnostics.total_latency_ms > 0);
  assert(diagnostics.timestamp, 'should have timestamp');
});

test('buildDebugAttemptDiagnostics: handles all-failed case', () => {
  const attempts = [
    {
      sequence: 1,
      protocol: 'responses',
      status: 404,
      fallback_reason: 'endpoint_not_found'
    },
    {
      sequence: 2,
      protocol: 'chat_completions',
      status: 401,
      fallback_reason: 'auth_error'
    }
  ];

  const diagnostics = buildDebugAttemptDiagnostics(attempts, {upstream: 'test'}, {protocol: 'responses'});

  assertEquals(diagnostics.succeeded_with, null);
  assertEquals(diagnostics.total_attempts, 2);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Runner
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n='.repeat(80));
console.log('Debug Lock Mode Test Suite');
console.log('='.repeat(80));
console.log(`\nTests: ${testCount}, Passed: ${passCount}, Failed: ${failCount}\n`);

if (failCount > 0) {
  process.exit(1);
}
