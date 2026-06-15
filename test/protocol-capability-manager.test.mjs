// Unit tests for ProtocolCapabilityManager
//
// Tests the core Protocol Capability state machine in isolation without HTTP calls.
// Verifies priority rules, state transitions, recheck logic, and edge cases.

import {
  ProtocolCapabilityManager,
  emptyProtocolCapability,
  normalizeProtocolCapabilities,
  initialProtocolCapabilities,
  recordProtocolCapabilityProbe,
  recordProtocolCapabilityRealTraffic,
  recordProtocolCapabilityUnsupported,
  shouldRecheckProtocolCapability,
  upstreamHasVerifiedProtocolCapability,
  upstreamHasUserDeclaredProtocolCapability
} from '../src/protocol-capability-manager.mjs';
import { deriveVerificationTier } from '../src/verification-tier.mjs';

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
    ...overrides
  };
}

function createMockProbeResult(statusCode, body = '', ok = false) {
  return {
    statusCode,
    body,
    ok,
    latencyMs: 100,
    headers: {}
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
// Test Suite: Data Helpers
// ══════════════════════════════════════════════════════════════════════════════

test('emptyProtocolCapability creates correct structure', () => {
  const cap = emptyProtocolCapability('verified', 'test reason');
  assertEquals(cap.status, 'verified');
  assertEquals(cap.reason, 'test reason');
  assertEquals(cap.source, '');
  assertEquals(cap.probe_type, '');
  assertEquals(cap.representative, null);
  assertEquals(cap.checked_at, null);
  assertEquals(cap.model, '');
  assertEquals(cap.http_status, 0);
});

test('normalizeProtocolCapabilities handles empty input', () => {
  const caps = normalizeProtocolCapabilities();
  assert(caps.responses, 'should have responses');
  assert(caps.chat_completions, 'should have chat_completions');
  assert(caps.anthropic_messages, 'should have anthropic_messages');
  assertEquals(caps.responses.status, 'unknown');
});

test('normalizeProtocolCapabilities preserves existing data', () => {
  const input = {
    responses: {
      status: 'verified',
      source: 'probe',
      checked_at: '2026-01-01T00:00:00Z',
      model: 'gpt-5.5',
      http_status: 200
    }
  };
  const caps = normalizeProtocolCapabilities(input);
  assertEquals(caps.responses.status, 'verified');
  assertEquals(caps.responses.source, 'probe');
  assertEquals(caps.responses.model, 'gpt-5.5');
  assertEquals(caps.responses.http_status, 200);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Initialization
// ══════════════════════════════════════════════════════════════════════════════

test('initialProtocolCapabilities with api=openai', () => {
  const descriptor = { enabled: true, api: 'openai' };
  const caps = initialProtocolCapabilities(descriptor);

  assertEquals(caps.responses.status, 'assumed');
  assertEquals(caps.responses.source, 'config');
  assertEquals(caps.chat_completions.status, 'assumed');
  assertEquals(caps.chat_completions.source, 'config');
  assertEquals(caps.anthropic_messages.status, 'unknown');
});

test('initialProtocolCapabilities with api=anthropic', () => {
  const descriptor = { enabled: true, api: 'anthropic' };
  const caps = initialProtocolCapabilities(descriptor);

  assertEquals(caps.anthropic_messages.status, 'assumed');
  assertEquals(caps.anthropic_messages.source, 'config');
  assertEquals(caps.responses.status, 'unknown');
  assertEquals(caps.chat_completions.status, 'unknown');
});

test('initialProtocolCapabilities with api=both', () => {
  const descriptor = { enabled: true, api: 'both' };
  const caps = initialProtocolCapabilities(descriptor);

  assertEquals(caps.responses.status, 'assumed');
  assertEquals(caps.chat_completions.status, 'assumed');
  assertEquals(caps.anthropic_messages.status, 'assumed');
  assert(caps.responses.reason.includes('api=both'));
});

test('initialProtocolCapabilities with request_mode=chat_completions', () => {
  const descriptor = {
    enabled: true,
    api: 'openai',  // Need to set api since it takes precedence
    requestMode: 'chat_completions'
  };
  const caps = initialProtocolCapabilities(descriptor);

  // request_mode is checked first, but api=openai overrides it
  // The implementation applies api settings after request_mode
  // So we get assumed for both due to api=openai
  assertEquals(caps.responses.status, 'assumed');
  assertEquals(caps.chat_completions.status, 'assumed');
});

test('initialProtocolCapabilities with disabled upstream', () => {
  const descriptor = { enabled: false };
  const caps = initialProtocolCapabilities(descriptor);

  assertEquals(caps.responses.status, 'disabled');
  assertEquals(caps.chat_completions.status, 'disabled');
  assertEquals(caps.anthropic_messages.status, 'disabled');
  assert(caps.responses.reason.includes('upstream disabled'));
});

test('initialProtocolCapabilities with user declarations', () => {
  // initialProtocolCapabilities expects a descriptor with declared field
  const descriptor = {
    enabled: true,
    api: 'openai',
    declared: {  // protocol_capabilities should be passed as declared
      responses: true,
      chat_completions: false,
      anthropic_messages: true
    }
  };
  const caps = initialProtocolCapabilities(descriptor);

  // User declarations overlay on top of api config
  assertEquals(caps.responses.status, 'assumed');
  assertEquals(caps.responses.source, 'user_declared');
  assertEquals(caps.chat_completions.status, 'disabled');
  assertEquals(caps.chat_completions.source, 'user_declared');
  assertEquals(caps.anthropic_messages.status, 'assumed');
  assertEquals(caps.anthropic_messages.source, 'user_declared');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Priority Rules
// ══════════════════════════════════════════════════════════════════════════════

test('Priority Rule 1: Endpoint 404 overrides user declaration', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'assumed',
        source: 'user_declared',
        reason: 'user declared protocol support'
      }
    }
  });

  const result = createMockProbeResult(404, 'Not Found');
  const classified = createMockClassified('unexpected_status', 'endpoint not found');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  assertEquals(upstream.capabilities.responses.status, 'unsupported');
  assertEquals(upstream.capabilities.responses.http_status, 404);
  assert(upstream.capabilities.responses.endpoint_unsupported === true);
});

test('Priority Rule 2: User declaration survives non-endpoint probe failure', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'assumed',
        source: 'user_declared',
        reason: 'user declared protocol support'
      }
    }
  });

  const result = createMockProbeResult(500, 'Internal Server Error');
  const classified = createMockClassified('server_error', 'server error');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // User declaration preserved
  assertEquals(upstream.capabilities.responses.status, 'assumed');
  assertEquals(upstream.capabilities.responses.source, 'user_declared');
  // But diagnostic info updated
  assertEquals(upstream.capabilities.responses.checked_at, '2026-01-01T00:00:00Z');
  assert(upstream.capabilities.responses.probe_failure_reason);
});

test('Priority Rule 3: Real traffic for same model survives probe failure', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'real_traffic',
        representative: true,
        model: 'gpt-5.5',
        checked_at: '2026-01-01T00:00:00Z'
      }
    }
  });

  const result = createMockProbeResult(500, 'Internal Server Error');
  const classified = createMockClassified('server_error', 'server error');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T01:00:00Z',
    model: 'gpt-5.5'  // Same model
  });

  // Real traffic evidence preserved
  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.source, 'real_traffic');
  // But diagnostic info updated
  assert(upstream.capabilities.responses.probe_failure_reason);
});

test('Priority Rule 4: Probe for different model overwrites real traffic', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        source: 'real_traffic',
        representative: true,
        model: 'gpt-5.5',
        checked_at: '2026-01-01T00:00:00Z'
      }
    }
  });

  const result = createMockProbeResult(500, 'Internal Server Error');
  const classified = createMockClassified('server_error', 'server error');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T01:00:00Z',
    model: 'gpt-5.4'  // Different model
  });

  // Real traffic evidence replaced, server_error → unknown
  assertEquals(upstream.capabilities.responses.status, 'unknown');
  assertEquals(upstream.capabilities.responses.source, 'probe');
  assertEquals(upstream.capabilities.responses.model, 'gpt-5.4');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: State Transitions
// ══════════════════════════════════════════════════════════════════════════════

test('Probe state "ok" → capability status "verified"', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(200, 'OK', true);
  const classified = createMockClassified('ok');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.source, 'probe');
});

test('Probe state "auth_error" → capability status "unknown"', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(401, 'Unauthorized');
  const classified = createMockClassified('auth_error', 'Invalid API key');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // auth_error maps to unknown (per implementation)
  assertEquals(upstream.capabilities.responses.status, 'unknown');
  assertEquals(upstream.capabilities.responses.http_status, 401);
});

test('Probe state "network_error" → capability status "unknown"', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(0, '');
  const classified = createMockClassified('network_error', 'ECONNREFUSED');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  assertEquals(upstream.capabilities.responses.status, 'unknown');
});

test('Probe state "timeout" → capability status "unknown"', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(0, '');
  const classified = createMockClassified('timeout', 'Request timeout');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  assertEquals(upstream.capabilities.responses.status, 'unknown');
});

test('Probe state "inconclusive" → capability status "unknown"', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(400, 'Bad Request');
  const classified = createMockClassified('inconclusive', 'Ambiguous response');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  assertEquals(upstream.capabilities.responses.status, 'unknown');
});

test('non-representative probe classification is preserved in capability evidence', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(503, JSON.stringify({
    error: {
      message: 'Service Unavailable',
      type: 'error'
    },
    type: 'error'
  }));
  const classified = {
    state: 'inconclusive',
    error: 'responses probe HTTP 503 is not authoritative for Codex Desktop availability',
    outcome: 'inconclusive',
    authoritative: false,
    representative: false
  };

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  assertEquals(upstream.capabilities.responses.status, 'unknown');
  assertEquals(upstream.capabilities.responses.representative, false);
  assertEquals(upstream.capabilities.responses.last_probe_state, 'inconclusive');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Real Traffic Recording
// ══════════════════════════════════════════════════════════════════════════════

test('recordProtocolCapabilityRealTraffic marks as verified', () => {
  const upstream = createMockUpstream();

  recordProtocolCapabilityRealTraffic(upstream, 'responses', {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5',
    httpStatus: 200,
    reason: 'successful real traffic'
  });

  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.source, 'real_traffic');
  assertEquals(upstream.capabilities.responses.representative, true);
  assertEquals(upstream.capabilities.responses.model, 'gpt-5.5');
  assertEquals(upstream.capabilities.responses.http_status, 200);
});

test('Real traffic overwrites probe evidence', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'failed',
        source: 'probe',
        model: 'gpt-5.5',
        http_status: 500
      }
    }
  });

  recordProtocolCapabilityRealTraffic(upstream, 'responses', {
    checkedAt: '2026-01-01T01:00:00Z',
    model: 'gpt-5.5',
    httpStatus: 200
  });

  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.source, 'real_traffic');
});

test('recordProtocolCapabilityUnsupported marks endpoint failures as unsupported', () => {
  const upstream = createMockUpstream();

  const recorded = recordProtocolCapabilityUnsupported(upstream, 'responses', {
    checkedAt: '2026-01-01T02:00:00Z',
    model: 'gpt-5.5',
    httpStatus: 404,
    reason: 'HTTP 404'
  });

  assertEquals(recorded, true);
  assertEquals(upstream.capabilities.responses.status, 'unsupported');
  assertEquals(upstream.capabilities.responses.source, 'real_traffic_failure');
  assertEquals(upstream.capabilities.responses.endpoint_unsupported, true);
  assertEquals(upstream.capabilities.responses.http_status, 404);
});

test('recordProtocolCapabilityUnsupported ignores non-endpoint failures', () => {
  const upstream = createMockUpstream();

  const recorded = recordProtocolCapabilityUnsupported(upstream, 'responses', {
    httpStatus: 500,
    reason: 'HTTP 500'
  });

  assertEquals(recorded, false);
  assertEquals(normalizeProtocolCapabilities(upstream.capabilities).responses.status, 'unknown');
});

test('recordProtocolCapabilityUnsupported accepts explicit endpoint unsupported signal', () => {
  const upstream = createMockUpstream();

  const recorded = recordProtocolCapabilityUnsupported(upstream, 'responses', {
    httpStatus: 400,
    reason: 'unsupported endpoint',
    endpointUnsupported: true
  });

  assertEquals(recorded, true);
  assertEquals(upstream.capabilities.responses.status, 'unsupported');
  assertEquals(upstream.capabilities.responses.http_status, 400);
  assertEquals(upstream.capabilities.responses.endpoint_unsupported, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Recheck Logic
// ══════════════════════════════════════════════════════════════════════════════

test('shouldRecheckProtocolCapability returns false for verified', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'verified',
        checked_at: '2026-01-01T00:00:00Z'
      }
    }
  });

  const should = shouldRecheckProtocolCapability(upstream, 'responses', {
    now: () => new Date('2026-01-01T01:00:00Z').getTime()
  });

  assertEquals(should, false);
});

test('shouldRecheckProtocolCapability returns true for failed after 30min', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'failed',
        checked_at: '2026-01-01T00:00:00Z'
      }
    }
  });

  const should = shouldRecheckProtocolCapability(upstream, 'responses', {
    now: () => new Date('2026-01-01T00:31:00Z').getTime()
  });

  assertEquals(should, true);
});

test('shouldRecheckProtocolCapability returns false for failed before 30min', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'failed',
        checked_at: '2026-01-01T00:00:00Z'
      }
    }
  });

  const should = shouldRecheckProtocolCapability(upstream, 'responses', {
    now: () => new Date('2026-01-01T00:20:00Z').getTime()
  });

  assertEquals(should, false);
});

test('shouldRecheckProtocolCapability returns true for endpoint_unsupported after 30min', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'unsupported',
        endpoint_unsupported: true,
        checked_at: '2026-01-01T00:00:00Z'
      }
    }
  });

  const should = shouldRecheckProtocolCapability(upstream, 'responses', {
    now: () => new Date('2026-01-01T00:31:00Z').getTime()
  });

  assertEquals(should, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Query Functions
// ══════════════════════════════════════════════════════════════════════════════

test('upstreamHasVerifiedProtocolCapability returns true for verified', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: { status: 'verified' }
    }
  });

  const has = upstreamHasVerifiedProtocolCapability(upstream, 'responses');
  assertEquals(has, true);
});

test('upstreamHasVerifiedProtocolCapability returns false for failed', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: { status: 'failed' }
    }
  });

  const has = upstreamHasVerifiedProtocolCapability(upstream, 'responses');
  assertEquals(has, false);
});

test('upstreamHasUserDeclaredProtocolCapability detects user declarations', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: {
        status: 'assumed',
        source: 'user_declared'
      }
    }
  });

  const has = upstreamHasUserDeclaredProtocolCapability(upstream, 'responses', 'assumed');
  assertEquals(has, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Edge Cases
// ══════════════════════════════════════════════════════════════════════════════

test('null upstream handles gracefully', () => {
  const caps = normalizeProtocolCapabilities(null?.capabilities);
  assert(caps.responses);
  assertEquals(caps.responses.status, 'unknown');
});

test('missing protocol returns unknown', () => {
  const upstream = createMockUpstream();
  const has = upstreamHasVerifiedProtocolCapability(upstream, 'invalid_protocol');
  assertEquals(has, false);
});

test('probe with null classified uses default classification', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(200, 'OK', true);

  recordProtocolCapabilityProbe(upstream, 'responses', result, null, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should still work with default classification
  assert(upstream.capabilities.responses);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: ProtocolCapabilityManager Class (OO Interface)
// ══════════════════════════════════════════════════════════════════════════════

test('ProtocolCapabilityManager constructor initializes correctly', () => {
  const upstream = createMockUpstream();
  const manager = new ProtocolCapabilityManager(upstream);

  assert(manager);
  const caps = manager.toJSON();
  assert(caps.responses);
});

test('ProtocolCapabilityManager.getStatus returns correct status', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: { status: 'verified' }
    }
  });
  const manager = new ProtocolCapabilityManager(upstream);

  assertEquals(manager.getStatus('responses'), 'verified');
  assertEquals(manager.getStatus('chat_completions'), 'unknown');
});

test('ProtocolCapabilityManager.hasVerified works correctly', () => {
  const upstream = createMockUpstream({
    capabilities: {
      responses: { status: 'verified' }
    }
  });
  const manager = new ProtocolCapabilityManager(upstream);

  assertEquals(manager.hasVerified('responses'), true);
  assertEquals(manager.hasVerified('chat_completions'), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: applyProbeResult - Integrated Health and Capability Management
// ══════════════════════════════════════════════════════════════════════════════

function createMockKey(overrides = {}) {
  return {
    value: 'test-key',
    label: 'test-key-label',
    health: {},
    ...overrides
  };
}

test('ProtocolCapabilityManager.applyProbeResult: ok probe updates both Health and Capability', () => {
  // RED: applyProbeResult method doesn't exist yet
  const upstream = createMockUpstream();
  const key = createMockKey();
  const manager = new ProtocolCapabilityManager(upstream);

  const probeResult = createMockProbeResult(200, '{"id":"test"}', true);
  const classified = createMockClassified('ok');

  const action = manager.applyProbeResult(key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Protocol Capability to verified
  assertEquals(manager.getStatus('responses'), 'verified');
  assertEquals(upstream.capabilities.responses.source, 'probe');

  // Should update Health State to ok
  assertEquals(upstream.health.state, 'ok');
  assertEquals(upstream.health.httpStatus, 200);
  assertEquals(upstream.health.probeModel, 'gpt-5.5');

  // Should update Key Health
  assertEquals(key.health.state, 'ok');

  // Should not trigger cooldown
  assertEquals(action.shouldCooldown, false);
});

test('ProtocolCapabilityManager.applyProbeResult: auth_error probe triggers cooldown', () => {
  const upstream = createMockUpstream();
  const key = createMockKey();
  const manager = new ProtocolCapabilityManager(upstream);

  const probeResult = createMockProbeResult(401, 'Unauthorized', false);
  const classified = createMockClassified('auth_error', 'Invalid API key');

  const action = manager.applyProbeResult(key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Protocol Capability to unknown (auth_error maps to unknown)
  assertEquals(manager.getStatus('responses'), 'unknown');

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

test('ProtocolCapabilityManager.applyProbeResult: network_error probe triggers cooldown', () => {
  const upstream = createMockUpstream();
  const key = createMockKey();
  const manager = new ProtocolCapabilityManager(upstream);

  const probeResult = createMockProbeResult(0, '', false);
  const classified = createMockClassified('network_error', 'ECONNREFUSED');

  const action = manager.applyProbeResult(key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Protocol Capability to unknown
  assertEquals(manager.getStatus('responses'), 'unknown');

  // Should update Health State to network_error
  assertEquals(upstream.health.state, 'network_error');
  assertEquals(upstream.health.error, 'ECONNREFUSED');

  // Should trigger cooldown
  assertEquals(action.shouldCooldown, true);
});

test('ProtocolCapabilityManager.applyProbeResult: server_error probe triggers cooldown', () => {
  const upstream = createMockUpstream();
  const key = createMockKey();
  const manager = new ProtocolCapabilityManager(upstream);

  const probeResult = createMockProbeResult(500, 'Internal Server Error', false);
  const classified = createMockClassified('server_error', 'Server error');

  const action = manager.applyProbeResult(key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Protocol Capability to unknown
  assertEquals(manager.getStatus('responses'), 'unknown');

  // Should update Health State to server_error
  assertEquals(upstream.health.state, 'server_error');
  assertEquals(upstream.health.httpStatus, 500);

  // Should trigger cooldown
  assertEquals(action.shouldCooldown, true);
});

test('ProtocolCapabilityManager.applyProbeResult: inconclusive probe does NOT trigger cooldown', () => {
  const upstream = createMockUpstream();
  const key = createMockKey();
  const manager = new ProtocolCapabilityManager(upstream);

  const probeResult = createMockProbeResult(400, 'Bad Request', false);
  const classified = createMockClassified('inconclusive', 'Ambiguous response');

  const action = manager.applyProbeResult(key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Should update Health State to inconclusive
  assertEquals(upstream.health.state, 'inconclusive');

  // Should NOT trigger cooldown (inconclusive is not in cooldown list)
  assertEquals(action.shouldCooldown, false);
});

test('ProtocolCapabilityManager.applyProbeResult: synchronizes timestamps and models', () => {
  const upstream = createMockUpstream();
  const key = createMockKey();
  const manager = new ProtocolCapabilityManager(upstream);

  const probeResult = createMockProbeResult(200, '{"id":"test"}', true);
  const classified = createMockClassified('ok');

  manager.applyProbeResult(key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Both Capability and Health should have same timestamp
  assertEquals(upstream.capabilities.responses.checked_at, '2026-01-01T00:00:00Z');
  assertEquals(upstream.health.checkedAt, '2026-01-01T00:00:00Z');

  // Both should reference same model
  assertEquals(upstream.capabilities.responses.model, 'gpt-5.5');
  assertEquals(upstream.health.probeModel, 'gpt-5.5');
});

test('ProtocolCapabilityManager.applyProbeResult: updates key health and references key label', () => {
  const upstream = createMockUpstream();
  const key = createMockKey({ label: 'my-key-label' });
  const manager = new ProtocolCapabilityManager(upstream);

  const probeResult = createMockProbeResult(200, '{"id":"test"}', true);
  const classified = createMockClassified('ok');

  manager.applyProbeResult(key, 'responses', probeResult, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5'
  });

  // Key health should be updated
  assertEquals(key.health.state, 'ok');
  assertEquals(key.health.probeModel, 'gpt-5.5');

  // Upstream health should reference key label
  assertEquals(upstream.health.keyLabel, 'my-key-label');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: real_traffic evidence vs periodic probes (regression)
// ══════════════════════════════════════════════════════════════════════════════

test('regression: successful periodic probe must NOT downgrade real_traffic evidence', () => {
  // JUN was verified by a real Codex request. The 60s periodic Health Probe then
  // runs and succeeds (state 'ok'). The capability must stay real_traffic, and
  // the verification tier must stay proven_by_traffic.
  const upstream = createMockUpstream();

  recordProtocolCapabilityRealTraffic(upstream, 'responses', {
    checkedAt: '2026-06-14T10:00:00Z',
    model: 'gpt-5-codex',
    httpStatus: 200
  });

  const result = createMockProbeResult(200, '{"id":"x"}', true);
  const classified = createMockClassified('ok');
  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-06-14T10:01:00Z',
    model: 'gpt-5-codex'
  });

  assertEquals(upstream.capabilities.responses.source, 'real_traffic');
  assertEquals(deriveVerificationTier(upstream), 'proven_by_traffic');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: matches_current_override flag (Phase 2)
// ══════════════════════════════════════════════════════════════════════════════

test('recordProtocolCapabilityProbe: matches_current_override when models match', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(200, 'OK', true);
  const classified = createMockClassified('ok');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5',
    currentModelOverride: 'gpt-5.5'  // Same as probe model
  });

  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.model, 'gpt-5.5');
  assertEquals(upstream.capabilities.responses.matches_current_override, true);
});

test('recordProtocolCapabilityProbe: matches_current_override=false when models differ', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(200, 'OK', true);
  const classified = createMockClassified('ok');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'claude-opus-4-8',
    currentModelOverride: 'gpt-5.5'  // Different
  });

  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.model, 'claude-opus-4-8');
  assertEquals(upstream.capabilities.responses.matches_current_override, false);
});

test('recordProtocolCapabilityProbe: matches_current_override=null when no override', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(200, 'OK', true);
  const classified = createMockClassified('ok');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5',
    currentModelOverride: null  // No override set
  });

  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.matches_current_override, null);
});

test('recordProtocolCapabilityProbe: matches_current_override=null when override is empty string', () => {
  const upstream = createMockUpstream();
  const result = createMockProbeResult(200, 'OK', true);
  const classified = createMockClassified('ok');

  recordProtocolCapabilityProbe(upstream, 'responses', result, classified, {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5',
    currentModelOverride: ''  // Empty string
  });

  assertEquals(upstream.capabilities.responses.matches_current_override, null);
});

test('recordProtocolCapabilityRealTraffic: also tracks matches_current_override', () => {
  const upstream = createMockUpstream();

  recordProtocolCapabilityRealTraffic(upstream, 'responses', {
    checkedAt: '2026-01-01T00:00:00Z',
    model: 'gpt-5.5',
    httpStatus: 200,
    currentModelOverride: 'gpt-5.5'
  });

  assertEquals(upstream.capabilities.responses.status, 'verified');
  assertEquals(upstream.capabilities.responses.source, 'real_traffic');
  assertEquals(upstream.capabilities.responses.matches_current_override, true);
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
