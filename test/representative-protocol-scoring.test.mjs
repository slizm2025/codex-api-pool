// TDD: Representative selection multiplier must be protocol-aware.
//
// CORE_FEATURES.md §2 and §5: the representative_success_multiplier rewards an
// upstream that has RECENTLY been proven by real traffic for the protocol and
// model being routed. The multiplier is computed from per-protocol representative
// evidence (key.representativeEvidence[protocol][model]).
//
// Bug being locked down: the multiplier helper hardcoded protocol 'responses',
// so when Selection scored candidates for a Claude CLI Messages request it read
// the 'responses' evidence bucket instead of 'anthropic_messages'. An upstream
// with fresh anthropic_messages evidence but no responses evidence got NO boost,
// while an upstream with only responses evidence got an undeserved boost on the
// Messages path.

import { __testInternals } from '../src/server.mjs';

const {
  representativeAvailability,
  representativeSelectionMultiplier,
  protocolCapabilitySelectionMultiplier
} = __testInternals;

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
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeUpstreamWithEvidence({ protocol, model, fresh = true }) {
  const checkedAt = new Date(Date.now() - (fresh ? 1000 : 10 * 60 * 1000)).toISOString();
  const ttlMs = fresh ? 5 * 60 * 1000 : -1; // expired if stale
  return {
    keys: [{
      label: 'k1',
      representativeEvidence: {
        [protocol]: {
          [model]: {
            source: 'real_traffic',
            checked_at: checkedAt,
            expires_at: new Date(Date.parse(checkedAt) + ttlMs).toISOString(),
            http_status: 200
          }
        }
      }
    }]
  };
}

test('representativeAvailability: returns fresh state when matching protocol+model evidence exists', () => {
  const upstream = makeUpstreamWithEvidence({ protocol: 'anthropic_messages', model: 'claude-opus-4-8', fresh: true });
  const result = representativeAvailability(upstream, { model: 'claude-opus-4-8', protocol: 'anthropic_messages' });
  assertEquals(result.state, 'fresh', 'state for matching protocol');
  assertEquals(result.verified, true, 'verified for matching protocol');
});

test('representativeAvailability: returns missing when evidence is for a DIFFERENT protocol', () => {
  // Upstream only has responses evidence, but we are scoring the messages path.
  const upstream = makeUpstreamWithEvidence({ protocol: 'responses', model: 'gpt-5.5', fresh: true });
  const result = representativeAvailability(upstream, { model: 'gpt-5.5', protocol: 'anthropic_messages' });
  assertEquals(result.state, 'missing', 'state must be missing when evidence is for another protocol');
  assertEquals(result.verified, false, 'must not be verified from a different protocol');
});

test('representativeAvailability: responses path reads responses evidence, not messages evidence', () => {
  const upstream = makeUpstreamWithEvidence({ protocol: 'anthropic_messages', model: 'gpt-5.5', fresh: true });
  const result = representativeAvailability(upstream, { model: 'gpt-5.5', protocol: 'responses' });
  assertEquals(result.state, 'missing', 'responses path must not borrow messages evidence');
});

test('representativeSelectionMultiplier: scores the requested protocol evidence only', () => {
  const upstream = makeUpstreamWithEvidence({ protocol: 'responses', model: 'gpt-5.5', fresh: true });
  const expectedResponsesMultiplier = representativeAvailability(upstream, { model: 'gpt-5.5', protocol: 'responses' }).multiplier;
  const responsesMultiplier = representativeSelectionMultiplier(upstream, 'gpt-5.5', 'responses');
  const messagesMultiplier = representativeSelectionMultiplier(upstream, 'gpt-5.5', 'anthropic_messages');
  assertEquals(responsesMultiplier, expectedResponsesMultiplier, 'responses evidence should boost responses scoring');
  assertEquals(messagesMultiplier, 1, 'responses evidence must not boost messages scoring');
});

test('protocolCapabilitySelectionMultiplier: assumed is preferred over unknown without excluding exploration', () => {
  const assumed = { capabilities: { responses: { status: 'assumed' } } };
  const unknown = { capabilities: { responses: { status: 'unknown' } } };
  const failed = { capabilities: { responses: { status: 'failed' } } };
  assertEquals(protocolCapabilitySelectionMultiplier(unknown, 'responses'), 1, 'unknown should be neutral');
  if (protocolCapabilitySelectionMultiplier(assumed, 'responses') <= protocolCapabilitySelectionMultiplier(unknown, 'responses')) {
    throw new Error('assumed protocol support should score above unknown support');
  }
  if (protocolCapabilitySelectionMultiplier(failed, 'responses') >= protocolCapabilitySelectionMultiplier(unknown, 'responses')) {
    throw new Error('failed protocol evidence should score below unknown support');
  }
});

console.log('\n' + '═'.repeat(80));
console.log(`Test Results: ${passCount}/${testCount} passed, ${failCount} failed`);
console.log('═'.repeat(80));
process.exit(failCount > 0 ? 1 : 0);
