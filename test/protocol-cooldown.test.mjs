// Unit tests for Protocol-Specific Cooldown logic
//
// Tests the extension of cooldown mechanism to support per-protocol cooldown,
// allowing an upstream to be in cooldown for one protocol (e.g., responses)
// while remaining available for others (e.g., anthropic_messages).

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Mock factory ──────────────────────────────────────────────────────────────

function createMockUpstream(overrides = {}) {
  return {
    name: 'test-upstream',
    enabled: true,
    cooldown: null,
    ...overrides
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Protocol Cooldown Data Structure
// ══════════════════════════════════════════════════════════════════════════════

// RED: Module doesn't exist yet
import {
  normalizeCooldown,
  isUpstreamInCooldown,
  isUpstreamInProtocolCooldown,
  applyCooldown,
  applyProtocolCooldown,
  clearCooldown,
  clearProtocolCooldown
} from '../src/protocol-cooldown.mjs';

test('normalizeCooldown: handles null input', () => {
  const cooldown = normalizeCooldown(null);
  assertEquals(cooldown.active, false);
  assertEquals(cooldown.until, null);
  assertEquals(cooldown.reason, '');
  assert(cooldown.protocol_specific, 'should have protocol_specific object');
  assertEquals(cooldown.protocol_specific.responses.active, false);
  assertEquals(cooldown.protocol_specific.chat_completions.active, false);
  assertEquals(cooldown.protocol_specific.anthropic_messages.active, false);
});

test('normalizeCooldown: preserves existing global cooldown', () => {
  const input = {
    active: true,
    until: '2026-06-14T10:35:00Z',
    reason: 'consecutive_failures'
  };
  const cooldown = normalizeCooldown(input);
  assertEquals(cooldown.active, true);
  assertEquals(cooldown.until, '2026-06-14T10:35:00Z');
  assertEquals(cooldown.reason, 'consecutive_failures');
});

test('normalizeCooldown: preserves existing protocol-specific cooldown', () => {
  const input = {
    active: false,
    until: null,
    reason: '',
    protocol_specific: {
      responses: {
        active: true,
        until: '2026-06-14T10:35:00Z',
        reason: 'consecutive_failures'
      }
    }
  };
  const cooldown = normalizeCooldown(input);
  assertEquals(cooldown.active, false);
  assertEquals(cooldown.protocol_specific.responses.active, true);
  assertEquals(cooldown.protocol_specific.responses.until, '2026-06-14T10:35:00Z');
  assertEquals(cooldown.protocol_specific.chat_completions.active, false);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Cooldown Queries
// ══════════════════════════════════════════════════════════════════════════════

test('isUpstreamInCooldown: returns true when global cooldown active', () => {
  const upstream = createMockUpstream({
    cooldown: {
      active: true,
      until: '2026-06-14T10:35:00Z',
      reason: 'consecutive_failures'
    }
  });

  const now = new Date('2026-06-14T10:30:00Z').getTime();
  const inCooldown = isUpstreamInCooldown(upstream, now);
  assertEquals(inCooldown, true);
});

test('isUpstreamInCooldown: returns false when cooldown expired', () => {
  const upstream = createMockUpstream({
    cooldown: {
      active: true,
      until: '2026-06-14T10:35:00Z',
      reason: 'consecutive_failures'
    }
  });

  const now = new Date('2026-06-14T10:36:00Z').getTime();
  const inCooldown = isUpstreamInCooldown(upstream, now);
  assertEquals(inCooldown, false);
});

test('isUpstreamInProtocolCooldown: returns true when protocol cooldown active', () => {
  const upstream = createMockUpstream({
    cooldown: {
      active: false,
      until: null,
      reason: '',
      protocol_specific: {
        responses: {
          active: true,
          until: '2026-06-14T10:35:00Z',
          reason: 'consecutive_failures'
        },
        chat_completions: { active: false },
        anthropic_messages: { active: false }
      }
    }
  });

  const now = new Date('2026-06-14T10:30:00Z').getTime();
  const inCooldown = isUpstreamInProtocolCooldown(upstream, 'responses', now);
  assertEquals(inCooldown, true);

  const inCooldownChat = isUpstreamInProtocolCooldown(upstream, 'chat_completions', now);
  assertEquals(inCooldownChat, false);
});

test('isUpstreamInProtocolCooldown: global cooldown affects all protocols', () => {
  const upstream = createMockUpstream({
    cooldown: {
      active: true,
      until: '2026-06-14T10:35:00Z',
      reason: 'global failure'
    }
  });

  const now = new Date('2026-06-14T10:30:00Z').getTime();
  assertEquals(isUpstreamInProtocolCooldown(upstream, 'responses', now), true);
  assertEquals(isUpstreamInProtocolCooldown(upstream, 'chat_completions', now), true);
  assertEquals(isUpstreamInProtocolCooldown(upstream, 'anthropic_messages', now), true);
});

test('isUpstreamInProtocolCooldown: protocol cooldown does not affect other protocols', () => {
  const upstream = createMockUpstream({
    cooldown: {
      active: false,
      protocol_specific: {
        responses: {
          active: true,
          until: '2026-06-14T10:35:00Z',
          reason: 'responses failure'
        },
        chat_completions: { active: false },
        anthropic_messages: { active: false }
      }
    }
  });

  const now = new Date('2026-06-14T10:30:00Z').getTime();
  assertEquals(isUpstreamInProtocolCooldown(upstream, 'responses', now), true);
  assertEquals(isUpstreamInProtocolCooldown(upstream, 'chat_completions', now), false);
  assertEquals(isUpstreamInProtocolCooldown(upstream, 'anthropic_messages', now), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Applying Cooldown
// ══════════════════════════════════════════════════════════════════════════════

test('applyCooldown: sets global cooldown', () => {
  const upstream = createMockUpstream();

  applyCooldown(upstream, {
    until: '2026-06-14T10:35:00Z',
    reason: 'consecutive_failures'
  });

  assertEquals(upstream.cooldown.active, true);
  assertEquals(upstream.cooldown.until, '2026-06-14T10:35:00Z');
  assertEquals(upstream.cooldown.reason, 'consecutive_failures');
});

test('applyProtocolCooldown: sets protocol-specific cooldown', () => {
  const upstream = createMockUpstream();

  applyProtocolCooldown(upstream, 'responses', {
    until: '2026-06-14T10:35:00Z',
    reason: 'responses consecutive failures'
  });

  assertEquals(upstream.cooldown.active, false);
  assertEquals(upstream.cooldown.protocol_specific.responses.active, true);
  assertEquals(upstream.cooldown.protocol_specific.responses.until, '2026-06-14T10:35:00Z');
  assertEquals(upstream.cooldown.protocol_specific.responses.reason, 'responses consecutive failures');
  assertEquals(upstream.cooldown.protocol_specific.chat_completions.active, false);
});

test('applyProtocolCooldown: multiple protocols can be in cooldown independently', () => {
  const upstream = createMockUpstream();

  applyProtocolCooldown(upstream, 'responses', {
    until: '2026-06-14T10:35:00Z',
    reason: 'responses failure'
  });

  applyProtocolCooldown(upstream, 'chat_completions', {
    until: '2026-06-14T10:40:00Z',
    reason: 'chat failure'
  });

  assertEquals(upstream.cooldown.protocol_specific.responses.active, true);
  assertEquals(upstream.cooldown.protocol_specific.responses.until, '2026-06-14T10:35:00Z');
  assertEquals(upstream.cooldown.protocol_specific.chat_completions.active, true);
  assertEquals(upstream.cooldown.protocol_specific.chat_completions.until, '2026-06-14T10:40:00Z');
  assertEquals(upstream.cooldown.protocol_specific.anthropic_messages.active, false);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Clearing Cooldown
// ══════════════════════════════════════════════════════════════════════════════

test('clearCooldown: clears global cooldown', () => {
  const upstream = createMockUpstream({
    cooldown: {
      active: true,
      until: '2026-06-14T10:35:00Z',
      reason: 'consecutive_failures'
    }
  });

  clearCooldown(upstream);

  assertEquals(upstream.cooldown.active, false);
  assertEquals(upstream.cooldown.until, null);
  assertEquals(upstream.cooldown.reason, '');
});

test('clearProtocolCooldown: clears protocol-specific cooldown', () => {
  const upstream = createMockUpstream({
    cooldown: {
      active: false,
      protocol_specific: {
        responses: {
          active: true,
          until: '2026-06-14T10:35:00Z',
          reason: 'responses failure'
        },
        chat_completions: {
          active: true,
          until: '2026-06-14T10:40:00Z',
          reason: 'chat failure'
        },
        anthropic_messages: { active: false }
      }
    }
  });

  clearProtocolCooldown(upstream, 'responses');

  assertEquals(upstream.cooldown.protocol_specific.responses.active, false);
  assertEquals(upstream.cooldown.protocol_specific.responses.until, null);
  assertEquals(upstream.cooldown.protocol_specific.chat_completions.active, true);
});

test('clearProtocolCooldown: handles null upstream gracefully', () => {
  // Should not throw
  clearProtocolCooldown(null, 'responses');
  clearProtocolCooldown(undefined, 'responses');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Edge Cases
// ══════════════════════════════════════════════════════════════════════════════

test('isUpstreamInCooldown: handles null upstream', () => {
  const inCooldown = isUpstreamInCooldown(null, Date.now());
  assertEquals(inCooldown, false);
});

test('isUpstreamInProtocolCooldown: handles null upstream', () => {
  const inCooldown = isUpstreamInProtocolCooldown(null, 'responses', Date.now());
  assertEquals(inCooldown, false);
});

test('applyProtocolCooldown: handles invalid protocol gracefully', () => {
  const upstream = createMockUpstream();
  applyProtocolCooldown(upstream, 'invalid_protocol', {
    until: '2026-06-14T10:35:00Z',
    reason: 'test'
  });
  // Should not throw, just ignore invalid protocol
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
