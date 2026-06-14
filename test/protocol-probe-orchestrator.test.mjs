// Unit tests for ProtocolProbeOrchestrator
//
// Tests probe planning and execution logic in isolation using FakeProbeExecutor.
// Verifies protocol selection strategy, fallback logic, and capability manager integration.

import { ProtocolCapabilityManager } from '../src/protocol-capability-manager.mjs';

// Try to import ProtocolProbeOrchestrator - will fail in RED state
let ProtocolProbeOrchestrator = null;
try {
  const module = await import('../src/protocol-probe-orchestrator.mjs');
  ProtocolProbeOrchestrator = module.ProtocolProbeOrchestrator;
} catch (error) {
  // Expected in RED state - module doesn't exist yet
  console.log('⚠️  ProtocolProbeOrchestrator not implemented yet - tests will fail');
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

function assertDeepEquals(actual, expected, message) {
  const actualStr = JSON.stringify(actual, null, 2);
  const expectedStr = JSON.stringify(expected, null, 2);
  if (actualStr !== expectedStr) {
    throw new Error(message || `Expected:\n${expectedStr}\n\nGot:\n${actualStr}`);
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

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Probe Planning - api=openai
// ══════════════════════════════════════════════════════════════════════════════

test('planProbes with api=openai should plan responses with chat fallback', () => {
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({ api: 'openai' });
  const models = ['gpt-5.5', 'gpt-5.4'];
  const capabilityManager = new ProtocolCapabilityManager(upstream);
  const probeExecutor = {
    async probeResponses() { return { statusCode: 200, ok: true }; },
    async probeChatCompletions() { return { statusCode: 200, ok: true }; },
    async probeAnthropicMessages() { return { statusCode: 200, ok: true }; }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = orchestrator.planProbes(upstream, models, Date.now());

  assert(plan.responses, 'Should plan responses probe');
  assertEquals(plan.responses.model, 'gpt-5.5');
  assertEquals(plan.responses.fallbackToChat, true);
  assertEquals(plan.anthropic_messages, null);
});

test('planProbes with api=anthropic should plan only anthropic_messages', () => {
  // RED: This will fail
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({ api: 'anthropic' });
  const models = ['claude-opus-4-8', 'claude-sonnet-4-6'];
  const capabilityManager = new ProtocolCapabilityManager(upstream);
  const probeExecutor = {
    async probeResponses() { return { statusCode: 200, ok: true }; },
    async probeChatCompletions() { return { statusCode: 200, ok: true }; },
    async probeAnthropicMessages() { return { statusCode: 200, ok: true }; }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = orchestrator.planProbes(upstream, models, Date.now());

  // Should plan anthropic_messages for first Claude model
  assert(plan.anthropic_messages, 'Should plan anthropic_messages probe');
  assertEquals(plan.anthropic_messages.model, 'claude-opus-4-8');

  // Should NOT plan OpenAI protocols for api=anthropic
  assertEquals(plan.responses, null);
  assertEquals(plan.chat_completions, null);
});

test('planProbes with api=both should plan all three protocols', () => {
  // RED: Will fail - need to handle api=both
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({ api: 'both' });
  const models = ['gpt-5.5', 'claude-opus-4-8', 'gpt-5.4', 'claude-sonnet-4-6'];
  const capabilityManager = new ProtocolCapabilityManager(upstream);
  const probeExecutor = {
    async probeResponses() { return { statusCode: 200, ok: true }; },
    async probeChatCompletions() { return { statusCode: 200, ok: true }; },
    async probeAnthropicMessages() { return { statusCode: 200, ok: true }; }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = orchestrator.planProbes(upstream, models, Date.now());

  // Should plan all three protocols
  assert(plan.responses, 'Should plan responses probe');
  assertEquals(plan.responses.model, 'gpt-5.5');
  assertEquals(plan.responses.fallbackToChat, true);

  assert(plan.anthropic_messages, 'Should plan anthropic_messages probe');
  assertEquals(plan.anthropic_messages.model, 'claude-opus-4-8');
});

test('planProbes with request_mode=chat_completions should skip responses', () => {
  // RED: Need to check request_mode
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({
    api: 'openai',
    requestMode: 'chat_completions'
  });
  const models = ['gpt-5.5', 'gpt-5.4'];
  const capabilityManager = new ProtocolCapabilityManager(upstream);
  const probeExecutor = {
    async probeResponses() { return { statusCode: 200, ok: true }; },
    async probeChatCompletions() { return { statusCode: 200, ok: true }; },
    async probeAnthropicMessages() { return { statusCode: 200, ok: true }; }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = orchestrator.planProbes(upstream, models, Date.now());

  // Should plan only chat_completions, not responses
  assertEquals(plan.responses, null);
  assert(plan.chat_completions, 'Should plan chat_completions probe');
  assertEquals(plan.chat_completions.model, 'gpt-5.5');
  assertEquals(plan.chat_completions.fallbackToChat, undefined); // No fallback needed
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Fallback Execution
// ══════════════════════════════════════════════════════════════════════════════

test('executeProbes: responses success should not execute chat fallback', async () => {
  // RED: Need to implement executeProbes with fallback logic
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({ api: 'openai' });
  const capabilityManager = new ProtocolCapabilityManager(upstream);

  // Track which probes were called
  const probesCalled = [];
  const probeExecutor = {
    async probeResponses(upstream, key, config, model) {
      probesCalled.push('responses');
      return { statusCode: 200, ok: true, body: '{"id":"test"}' };
    },
    async probeChatCompletions(upstream, key, config, model) {
      probesCalled.push('chat_completions');
      return { statusCode: 200, ok: true, body: '{"id":"test"}' };
    },
    async probeAnthropicMessages() {
      probesCalled.push('anthropic_messages');
      return { statusCode: 200, ok: true };
    }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = {
    responses: {
      model: 'gpt-5.5',
      reason: 'initial',
      fallbackToChat: true
    },
    chat_completions: null,
    anthropic_messages: null
  };

  const results = await orchestrator.executeProbes(upstream, {}, {}, plan, new Date().toISOString());

  // Should have called responses probe
  assert(probesCalled.includes('responses'), 'Should call responses probe');

  // Should NOT have called chat_completions probe (responses succeeded)
  assert(!probesCalled.includes('chat_completions'), 'Should NOT call chat_completions probe when responses succeeds');

  // Should have responses result
  assert(results.responses, 'Should have responses result');
  assertEquals(results.responses.result.statusCode, 200);
});

test('executeProbes: responses failure should execute chat fallback', async () => {
  // RED: Test the fallback path
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({ api: 'openai' });
  const capabilityManager = new ProtocolCapabilityManager(upstream);

  // Track which probes were called
  const probesCalled = [];
  const probeExecutor = {
    async probeResponses(upstream, key, config, model) {
      probesCalled.push('responses');
      return { statusCode: 500, ok: false, body: 'Internal Server Error' };
    },
    async probeChatCompletions(upstream, key, config, model) {
      probesCalled.push('chat_completions');
      return { statusCode: 200, ok: true, body: '{"id":"test"}' };
    },
    async probeAnthropicMessages() {
      probesCalled.push('anthropic_messages');
      return { statusCode: 200, ok: true };
    }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = {
    responses: {
      model: 'gpt-5.5',
      reason: 'initial',
      fallbackToChat: true
    },
    chat_completions: null,
    anthropic_messages: null
  };

  const results = await orchestrator.executeProbes(upstream, {}, {}, plan, new Date().toISOString());

  // Should have called both probes
  assert(probesCalled.includes('responses'), 'Should call responses probe');
  assert(probesCalled.includes('chat_completions'), 'Should call chat_completions probe after responses fails');

  // Should have both results
  assert(results.responses, 'Should have responses result');
  assertEquals(results.responses.result.statusCode, 500);

  assert(results.chat_completions, 'Should have chat_completions result');
  assertEquals(results.chat_completions.result.statusCode, 200);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Edge Cases
// ══════════════════════════════════════════════════════════════════════════════

test('planProbes with no non-Claude models should skip OpenAI protocols', () => {
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({ api: 'openai' });
  const models = ['claude-opus-4-8', 'claude-sonnet-4-6']; // Only Claude models
  const capabilityManager = new ProtocolCapabilityManager(upstream);
  const probeExecutor = {
    async probeResponses() { return { statusCode: 200, ok: true }; },
    async probeChatCompletions() { return { statusCode: 200, ok: true }; },
    async probeAnthropicMessages() { return { statusCode: 200, ok: true }; }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = orchestrator.planProbes(upstream, models, Date.now());

  // Should not plan OpenAI protocols (no non-Claude models)
  assertEquals(plan.responses, null);
  assertEquals(plan.chat_completions, null);
  assertEquals(plan.anthropic_messages, null); // api=openai doesn't probe anthropic
});

test('planProbes with no Claude models should skip anthropic_messages', () => {
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({ api: 'anthropic' });
  const models = ['gpt-5.5', 'gpt-5.4']; // Only non-Claude models
  const capabilityManager = new ProtocolCapabilityManager(upstream);
  const probeExecutor = {
    async probeResponses() { return { statusCode: 200, ok: true }; },
    async probeChatCompletions() { return { statusCode: 200, ok: true }; },
    async probeAnthropicMessages() { return { statusCode: 200, ok: true }; }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = orchestrator.planProbes(upstream, models, Date.now());

  // Should not plan anthropic_messages (no Claude models)
  assertEquals(plan.anthropic_messages, null);
  assertEquals(plan.responses, null); // api=anthropic doesn't probe OpenAI
  assertEquals(plan.chat_completions, null);
});

test('planProbes with empty models list should skip all probes', () => {
  if (!ProtocolProbeOrchestrator) {
    throw new Error('ProtocolProbeOrchestrator not implemented yet');
  }

  const upstream = createMockUpstream({ api: 'both' });
  const models = []; // Empty list
  const capabilityManager = new ProtocolCapabilityManager(upstream);
  const probeExecutor = {
    async probeResponses() { return { statusCode: 200, ok: true }; },
    async probeChatCompletions() { return { statusCode: 200, ok: true }; },
    async probeAnthropicMessages() { return { statusCode: 200, ok: true }; }
  };

  const orchestrator = new ProtocolProbeOrchestrator(capabilityManager, probeExecutor);
  const plan = orchestrator.planProbes(upstream, models, Date.now());

  // Should not plan any probes (no models)
  assertEquals(plan.responses, null);
  assertEquals(plan.chat_completions, null);
  assertEquals(plan.anthropic_messages, null);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: HttpProbeExecutor (Integration with real probe functions)
// ══════════════════════════════════════════════════════════════════════════════

test('HttpProbeExecutor should delegate to real probe functions', async () => {
  // RED: HttpProbeExecutor doesn't exist yet

  // Try to import HttpProbeExecutor
  const module = await import('../src/protocol-probe-orchestrator.mjs');
  const HttpProbeExecutor = module.HttpProbeExecutor;

  if (!HttpProbeExecutor) {
    throw new Error('HttpProbeExecutor not implemented yet');
  }

  // Create mock probe functions
  let responsesCallCount = 0;
  let chatCallCount = 0;
  let anthropicCallCount = 0;

  const mockProbeFunctions = {
    probeResponses: async (upstream, key, config, model) => {
      responsesCallCount++;
      return { statusCode: 200, ok: true, model };
    },
    probeChatCompletions: async (upstream, key, config, model) => {
      chatCallCount++;
      return { statusCode: 200, ok: true, model };
    },
    probeAnthropicMessages: async (upstream, key, config, model) => {
      anthropicCallCount++;
      return { statusCode: 200, ok: true, model };
    }
  };

  const executor = new HttpProbeExecutor(mockProbeFunctions);

  // Verify it has the right methods
  assert(typeof executor.probeResponses === 'function', 'Should have probeResponses method');
  assert(typeof executor.probeChatCompletions === 'function', 'Should have probeChatCompletions method');
  assert(typeof executor.probeAnthropicMessages === 'function', 'Should have probeAnthropicMessages method');

  // Verify it delegates correctly
  const upstream = createMockUpstream();
  const key = { value: 'test-key' };
  const config = {};

  await executor.probeResponses(upstream, key, config, 'gpt-5.5');
  assertEquals(responsesCallCount, 1, 'Should call probeResponses function');

  await executor.probeChatCompletions(upstream, key, config, 'gpt-5.5');
  assertEquals(chatCallCount, 1, 'Should call probeChatCompletions function');

  await executor.probeAnthropicMessages(upstream, key, config, 'claude-opus-4-8');
  assertEquals(anthropicCallCount, 1, 'Should call probeAnthropicMessages function');
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
