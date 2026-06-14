// Unit tests for RequestRoutingRules
//
// Tests the routing decision logic that determines whether to attempt
// native /v1/responses or fall back to /v1/chat/completions.

let RequestRoutingRules = null;
try {
  const module = await import('../src/request-routing-rules.mjs');
  RequestRoutingRules = module.RequestRoutingRules;
} catch (error) {
  console.log('⚠️  RequestRoutingRules not implemented yet - tests will fail');
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
    ...overrides
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: canAttemptNativeResponses - basic cases
// ══════════════════════════════════════════════════════════════════════════════

test('canAttemptNativeResponses: non-responses pathname should always return true', () => {
  // RED: RequestRoutingRules doesn't exist yet
  if (!RequestRoutingRules) {
    throw new Error('RequestRoutingRules not implemented yet');
  }

  const rules = new RequestRoutingRules({});
  const upstream = createMockUpstream();

  // For non-/v1/responses paths, always return true (no routing decision needed)
  assertEquals(rules.canAttemptNativeResponses('/v1/chat/completions', upstream, 'gpt-5.5'), true);
  assertEquals(rules.canAttemptNativeResponses('/v1/messages', upstream, 'claude-opus-4-8'), true);
  assertEquals(rules.canAttemptNativeResponses('/v1/models', upstream, 'gpt-5.5'), true);
});

test('canAttemptNativeResponses: explicit requestMode=chat_completions should return false', () => {
  if (!RequestRoutingRules) {
    throw new Error('RequestRoutingRules not implemented yet');
  }

  const rules = new RequestRoutingRules({});
  const upstream = createMockUpstream({ requestMode: 'chat_completions' });

  // Explicit chat_completions mode means don't try responses
  assertEquals(rules.canAttemptNativeResponses('/v1/responses', upstream, 'gpt-5.5'), false);
});

test('canAttemptNativeResponses: explicit requestMode=responses should return true', () => {
  if (!RequestRoutingRules) {
    throw new Error('RequestRoutingRules not implemented yet');
  }

  const rules = new RequestRoutingRules({});
  const upstream = createMockUpstream({ requestMode: 'responses' });

  // Explicit responses mode means always try
  assertEquals(rules.canAttemptNativeResponses('/v1/responses', upstream, 'gpt-5.5'), true);
});

test('canAttemptNativeResponses: learned strategy responses should return true', () => {
  if (!RequestRoutingRules) {
    throw new Error('RequestRoutingRules not implemented yet');
  }

  const rules = new RequestRoutingRules({});
  const upstream = createMockUpstream({
    routeStrategies: {
      'gpt-5.5': {
        strategy: 'responses',
        model: 'gpt-5.5',
        source: 'real_traffic',
        checked_at: '2026-01-01T00:00:00Z'
      }
    }
  });

  // Learned strategy says use responses
  assertEquals(rules.canAttemptNativeResponses('/v1/responses', upstream, 'gpt-5.5'), true);
});

test('getRouteStrategy: should return strategy for specific model', () => {
  if (!RequestRoutingRules) {
    throw new Error('RequestRoutingRules not implemented yet');
  }

  const rules = new RequestRoutingRules({});
  const upstream = createMockUpstream({
    routeStrategies: {
      'gpt-5.5': {
        strategy: 'responses',
        model: 'gpt-5.5',
        source: 'real_traffic',
        checked_at: '2026-01-01T00:00:00Z'
      }
    }
  });

  const strategy = rules.getRouteStrategy(upstream, 'gpt-5.5');
  assert(strategy, 'Should have strategy');
  assertEquals(strategy.strategy, 'responses');
  assertEquals(strategy.model, 'gpt-5.5');
});

test('routeStrategyUsesNativeResponses: should detect responses strategy', () => {
  if (!RequestRoutingRules) {
    throw new Error('RequestRoutingRules not implemented yet');
  }

  const rules = new RequestRoutingRules({});

  // String format
  assertEquals(rules.routeStrategyUsesNativeResponses('responses'), true);
  assertEquals(rules.routeStrategyUsesNativeResponses('codex_oauth_responses'), true);
  assertEquals(rules.routeStrategyUsesNativeResponses('chat_completions'), false);

  // Object format
  assertEquals(rules.routeStrategyUsesNativeResponses({ strategy: 'responses' }), true);
  assertEquals(rules.routeStrategyUsesNativeResponses({ strategy: 'chat_completions' }), false);
});

test('routeStrategyUsesChatCompletions: should detect chat strategy', () => {
  if (!RequestRoutingRules) {
    throw new Error('RequestRoutingRules not implemented yet');
  }

  const rules = new RequestRoutingRules({});

  // String format
  assertEquals(rules.routeStrategyUsesChatCompletions('chat_completions'), true);
  assertEquals(rules.routeStrategyUsesChatCompletions('chat_completions_compatibility'), true);
  assertEquals(rules.routeStrategyUsesChatCompletions('responses'), false);

  // Object format
  assertEquals(rules.routeStrategyUsesChatCompletions({ strategy: 'chat_completions' }), true);
  assertEquals(rules.routeStrategyUsesChatCompletions({ strategy: 'responses' }), false);
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
