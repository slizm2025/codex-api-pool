// Unit tests for Protocol-Layered Availability
//
// Tests the extension of availability tracking to support per-protocol statistics,
// allowing accurate measurement of upstream availability for different protocols.

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

function assertArrayEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Data Structure and Normalization
// ══════════════════════════════════════════════════════════════════════════════

// RED: Module doesn't exist yet
import {
  emptyAvailabilityWindow,
  normalizeAvailability,
  migrateOldAvailabilityFormat,
  recordAvailabilityAttempt,
  calculateAvailabilityMultiplier,
  getProtocolAvailabilityRate,
  getProtocolAvailabilityMultiplier
} from '../src/protocol-availability.mjs';

test('emptyAvailabilityWindow: creates correct structure', () => {
  const window = emptyAvailabilityWindow(50);

  assert(Array.isArray(window.recent), 'recent should be array');
  assertEquals(window.recent.length, 0);
  assertEquals(window.success_count, 0);
  assertEquals(window.total_count, 0);
  assertEquals(window.rate, 0);
  assertEquals(window.multiplier, 1.0);
  assertEquals(window.last_success, null);
  assertEquals(window.last_failure, null);
});

test('normalizeAvailability: creates new format from scratch', () => {
  const availability = normalizeAvailability(null);

  assert(availability.overall, 'should have overall');
  assert(availability.by_protocol, 'should have by_protocol');
  assert(availability.by_protocol.responses, 'should have responses protocol');
  assert(availability.by_protocol.chat_completions, 'should have chat_completions protocol');
  assert(availability.by_protocol.anthropic_messages, 'should have anthropic_messages protocol');
});

test('migrateOldAvailabilityFormat: converts old format to new', () => {
  const old = {
    recent: [true, false, true, true, false],
    success_count: 3,
    total_count: 5,
    rate: 0.60,
    multiplier: 0.65,
    last_success: '2026-06-14T10:30:00Z',
    last_failure: '2026-06-14T10:25:00Z'
  };

  const migrated = migrateOldAvailabilityFormat(old);

  // Old data should be in overall
  assertEquals(migrated.overall.success_count, 3);
  assertEquals(migrated.overall.total_count, 5);
  assertEquals(migrated.overall.rate, 0.60);
  assertArrayEquals(migrated.overall.recent, [true, false, true, true, false]);

  // by_protocol should be initialized to empty
  assertEquals(migrated.by_protocol.responses.total_count, 0);
  assertEquals(migrated.by_protocol.chat_completions.total_count, 0);
  assertEquals(migrated.by_protocol.anthropic_messages.total_count, 0);
});

test('normalizeAvailability: preserves new format', () => {
  const newFormat = {
    overall: {
      recent: [true, false],
      success_count: 1,
      total_count: 2,
      rate: 0.50
    },
    by_protocol: {
      responses: {
        recent: [false],
        success_count: 0,
        total_count: 1,
        rate: 0
      },
      chat_completions: {
        recent: [true],
        success_count: 1,
        total_count: 1,
        rate: 1.0
      },
      anthropic_messages: {
        recent: [],
        success_count: 0,
        total_count: 0,
        rate: 0
      }
    }
  };

  const normalized = normalizeAvailability(newFormat);

  assertEquals(normalized.overall.total_count, 2);
  assertEquals(normalized.by_protocol.responses.total_count, 1);
  assertEquals(normalized.by_protocol.chat_completions.total_count, 1);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Recording Attempts
// ══════════════════════════════════════════════════════════════════════════════

function createMockUpstream() {
  return {
    name: 'test-upstream',
    availability: null
  };
}

test('recordAvailabilityAttempt: records success for responses protocol', () => {
  const upstream = createMockUpstream();

  recordAvailabilityAttempt(upstream, 'responses', true, {
    timestamp: '2026-06-14T10:30:00Z',
    overallWindowSize: 50,
    protocolWindowSize: 30
  });

  // Overall should be updated
  assertEquals(upstream.availability.overall.success_count, 1);
  assertEquals(upstream.availability.overall.total_count, 1);
  assertEquals(upstream.availability.overall.rate, 1.0);
  assertArrayEquals(upstream.availability.overall.recent, [true]);

  // Responses protocol should be updated
  assertEquals(upstream.availability.by_protocol.responses.success_count, 1);
  assertEquals(upstream.availability.by_protocol.responses.total_count, 1);
  assertEquals(upstream.availability.by_protocol.responses.rate, 1.0);
  assertArrayEquals(upstream.availability.by_protocol.responses.recent, [true]);

  // Other protocols should be empty
  assertEquals(upstream.availability.by_protocol.chat_completions.total_count, 0);
  assertEquals(upstream.availability.by_protocol.anthropic_messages.total_count, 0);
});

test('recordAvailabilityAttempt: records failure for chat_completions protocol', () => {
  const upstream = createMockUpstream();

  recordAvailabilityAttempt(upstream, 'chat_completions', false, {
    timestamp: '2026-06-14T10:30:00Z'
  });

  assertEquals(upstream.availability.overall.success_count, 0);
  assertEquals(upstream.availability.overall.total_count, 1);
  assertEquals(upstream.availability.by_protocol.chat_completions.success_count, 0);
  assertEquals(upstream.availability.by_protocol.chat_completions.total_count, 1);
  assertEquals(upstream.availability.by_protocol.chat_completions.rate, 0);
  assertArrayEquals(upstream.availability.by_protocol.chat_completions.recent, [false]);
});

test('recordAvailabilityAttempt: maintains rolling window', () => {
  const upstream = createMockUpstream();

  // Record 5 attempts: i=0(true), i=1(false), i=2(true), i=3(false), i=4(true)
  for (let i = 0; i < 5; i++) {
    recordAvailabilityAttempt(upstream, 'responses', i % 2 === 0, {
      protocolWindowSize: 3  // Small window for testing
    });
  }

  // Window size is 3, so should only keep last 3: i=2,3,4 → [true, false, true]
  assertEquals(upstream.availability.by_protocol.responses.recent.length, 3);
  assertArrayEquals(upstream.availability.by_protocol.responses.recent, [true, false, true]);

  // But counts should reflect all attempts
  assertEquals(upstream.availability.by_protocol.responses.total_count, 5);
  assertEquals(upstream.availability.by_protocol.responses.success_count, 3); // 0,2,4 are even
});

test('recordAvailabilityAttempt: updates last_success and last_failure', () => {
  const upstream = createMockUpstream();

  recordAvailabilityAttempt(upstream, 'responses', false, {
    timestamp: '2026-06-14T10:25:00Z'
  });

  assertEquals(upstream.availability.overall.last_failure, '2026-06-14T10:25:00Z');
  assertEquals(upstream.availability.overall.last_success, null);

  recordAvailabilityAttempt(upstream, 'responses', true, {
    timestamp: '2026-06-14T10:30:00Z'
  });

  assertEquals(upstream.availability.overall.last_success, '2026-06-14T10:30:00Z');
  assertEquals(upstream.availability.by_protocol.responses.last_success, '2026-06-14T10:30:00Z');
});

test('recordAvailabilityAttempt: different protocols tracked independently', () => {
  const upstream = createMockUpstream();

  // Responses: 2 successes
  recordAvailabilityAttempt(upstream, 'responses', true);
  recordAvailabilityAttempt(upstream, 'responses', true);

  // Chat: 1 success, 1 failure
  recordAvailabilityAttempt(upstream, 'chat_completions', true);
  recordAvailabilityAttempt(upstream, 'chat_completions', false);

  // Anthropic: 3 failures
  recordAvailabilityAttempt(upstream, 'anthropic_messages', false);
  recordAvailabilityAttempt(upstream, 'anthropic_messages', false);
  recordAvailabilityAttempt(upstream, 'anthropic_messages', false);

  // Overall: 3 successes out of 7
  assertEquals(upstream.availability.overall.success_count, 3);
  assertEquals(upstream.availability.overall.total_count, 7);

  // Responses: 2/2
  assertEquals(upstream.availability.by_protocol.responses.success_count, 2);
  assertEquals(upstream.availability.by_protocol.responses.total_count, 2);
  assertEquals(upstream.availability.by_protocol.responses.rate, 1.0);

  // Chat: 1/2
  assertEquals(upstream.availability.by_protocol.chat_completions.success_count, 1);
  assertEquals(upstream.availability.by_protocol.chat_completions.total_count, 2);
  assertEquals(upstream.availability.by_protocol.chat_completions.rate, 0.5);

  // Anthropic: 0/3
  assertEquals(upstream.availability.by_protocol.anthropic_messages.success_count, 0);
  assertEquals(upstream.availability.by_protocol.anthropic_messages.total_count, 3);
  assertEquals(upstream.availability.by_protocol.anthropic_messages.rate, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Multiplier Calculation
// ══════════════════════════════════════════════════════════════════════════════

test('calculateAvailabilityMultiplier: samples < min_samples returns 1.0', () => {
  const multiplier = calculateAvailabilityMultiplier(5, 8, 10);
  assertEquals(multiplier, 1.0);
});

test('calculateAvailabilityMultiplier: rate >= 0.95 returns 1.20', () => {
  const multiplier = calculateAvailabilityMultiplier(48, 50, 10);
  assertEquals(multiplier, 1.20);
});

test('calculateAvailabilityMultiplier: rate >= 0.90 returns 1.00', () => {
  const multiplier = calculateAvailabilityMultiplier(45, 50, 10);
  assertEquals(multiplier, 1.00);
});

test('calculateAvailabilityMultiplier: rate >= 0.75 returns 0.65', () => {
  const multiplier = calculateAvailabilityMultiplier(38, 50, 10);
  assertEquals(multiplier, 0.65);
});

test('calculateAvailabilityMultiplier: rate >= 0.50 returns 0.30', () => {
  const multiplier = calculateAvailabilityMultiplier(25, 50, 10);
  assertEquals(multiplier, 0.30);
});

test('calculateAvailabilityMultiplier: rate < 0.50 returns 0.08', () => {
  const multiplier = calculateAvailabilityMultiplier(10, 50, 10);
  assertEquals(multiplier, 0.08);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Querying Protocol Availability
// ══════════════════════════════════════════════════════════════════════════════

test('getProtocolAvailabilityRate: returns protocol rate when sufficient samples', () => {
  const upstream = createMockUpstream();

  // Record 15 attempts (> min_samples)
  for (let i = 0; i < 15; i++) {
    recordAvailabilityAttempt(upstream, 'responses', i < 12); // 12 successes
  }

  const rate = getProtocolAvailabilityRate(upstream, 'responses', 10);
  assertEquals(rate, 12 / 15);
});

test('getProtocolAvailabilityRate: falls back to overall when protocol samples insufficient', () => {
  const upstream = createMockUpstream();

  // Record 5 responses attempts (< min_samples)
  for (let i = 0; i < 5; i++) {
    recordAvailabilityAttempt(upstream, 'responses', true);
  }

  // Record 15 chat attempts
  for (let i = 0; i < 15; i++) {
    recordAvailabilityAttempt(upstream, 'chat_completions', i < 10);
  }

  // Responses has < 10 samples, should fallback to overall
  const rate = getProtocolAvailabilityRate(upstream, 'responses', 10);
  assertEquals(rate, 15 / 20); // overall: 15 successes out of 20
});

test('getProtocolAvailabilityRate: returns null when both protocol and overall insufficient', () => {
  const upstream = createMockUpstream();

  // Only 5 total attempts
  for (let i = 0; i < 5; i++) {
    recordAvailabilityAttempt(upstream, 'responses', true);
  }

  const rate = getProtocolAvailabilityRate(upstream, 'responses', 10);
  assertEquals(rate, null);
});

test('getProtocolAvailabilityMultiplier: returns protocol multiplier', () => {
  const upstream = createMockUpstream();

  // Record 50 attempts with 48 successes (96% rate → 1.20 multiplier)
  for (let i = 0; i < 50; i++) {
    recordAvailabilityAttempt(upstream, 'responses', i < 48);
  }

  const multiplier = getProtocolAvailabilityMultiplier(upstream, 'responses', 10);
  assertEquals(multiplier, 1.20);
});

test('getProtocolAvailabilityMultiplier: returns 1.0 when insufficient samples', () => {
  const upstream = createMockUpstream();

  // Only 5 attempts
  for (let i = 0; i < 5; i++) {
    recordAvailabilityAttempt(upstream, 'responses', true);
  }

  const multiplier = getProtocolAvailabilityMultiplier(upstream, 'responses', 10);
  assertEquals(multiplier, 1.0);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Edge Cases
// ══════════════════════════════════════════════════════════════════════════════

test('recordAvailabilityAttempt: handles null upstream gracefully', () => {
  // Should not throw
  recordAvailabilityAttempt(null, 'responses', true);
});

test('getProtocolAvailabilityRate: handles null upstream', () => {
  const rate = getProtocolAvailabilityRate(null, 'responses');
  assertEquals(rate, null);
});

test('getProtocolAvailabilityMultiplier: handles null upstream', () => {
  const multiplier = getProtocolAvailabilityMultiplier(null, 'responses');
  assertEquals(multiplier, 1.0);
});

test('recordAvailabilityAttempt: handles invalid protocol', () => {
  const upstream = createMockUpstream();
  // Should not throw, just update overall
  recordAvailabilityAttempt(upstream, 'invalid_protocol', true);
  assertEquals(upstream.availability.overall.total_count, 1);
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
