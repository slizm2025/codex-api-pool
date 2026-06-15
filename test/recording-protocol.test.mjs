// Unit tests for recording-protocol derivation
//
// The recording protocol is the protocol-family name used to bucket per-protocol
// availability. It is derived per entry path because routeTrace.upstream_api is
// unreliable for /v1/messages and /v1/chat/completions (both return 'passthrough').

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`\u2713 ${name}`);
  } catch (error) {
    failCount++;
    console.error(`\u2717 ${name}`);
    console.error(`  ${error.message}`);
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// RED: Module doesn't exist yet
import { deriveRecordingProtocol, RECORDING_PROTOCOLS } from '../src/recording-protocol.mjs';

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Shared handler (/v1/responses) — rich upstreamApi values
// ══════════════════════════════════════════════════════════════════════════════

test('shared /v1/responses: upstream_api=responses -> responses', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/responses', upstreamApi: 'responses' }), 'responses');
});

test('shared /v1/responses: upstream_api=codex_oauth_responses -> responses', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/responses', upstreamApi: 'codex_oauth_responses' }), 'responses');
});

test('shared /v1/responses: upstream_api=chat_completions -> chat_completions', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/responses', upstreamApi: 'chat_completions' }), 'chat_completions');
});

test('shared /v1/responses: upstream_api=anthropic_messages -> anthropic_messages', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/responses', upstreamApi: 'anthropic_messages' }), 'anthropic_messages');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Shared handler (/v1/chat/completions) — passthrough fallback
// ══════════════════════════════════════════════════════════════════════════════

test('shared /v1/chat/completions: upstream_api=passthrough -> chat_completions', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/chat/completions', upstreamApi: 'passthrough' }), 'chat_completions');
});

test('shared /v1/chat/completions: missing upstreamApi -> chat_completions', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/chat/completions' }), 'chat_completions');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: /v1/messages handler — derived from useAdapter
// ══════════════════════════════════════════════════════════════════════════════

test('/v1/messages: native forwarding (useAdapter=false) -> anthropic_messages', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/messages', useAdapter: false }), 'anthropic_messages');
});

test('/v1/messages: adapter path (useAdapter=true) -> chat_completions', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/messages', useAdapter: true }), 'chat_completions');
});

test('/v1/messages: no useAdapter flag defaults to anthropic_messages', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/messages' }), 'anthropic_messages');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: Edge cases — unknown paths return null (no recording)
// ══════════════════════════════════════════════════════════════════════════════

test('unknown pathname -> null (no protocol)', () => {
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/models' }), null);
});

test('missing pathname -> null', () => {
  assertEquals(deriveRecordingProtocol({}), null);
});

test('null input -> null', () => {
  assertEquals(deriveRecordingProtocol(null), null);
});

test('passthrough on /v1/responses -> null (should not happen, but safe)', () => {
  // /v1/responses should never produce passthrough upstream_api; if it does,
  // we return null rather than guess, so no recording happens (safe default).
  assertEquals(deriveRecordingProtocol({ pathname: '/v1/responses', upstreamApi: 'passthrough' }), null);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite: RECORDING_PROTOCOLS constant
// ══════════════════════════════════════════════════════════════════════════════

test('RECORDING_PROTOCOLS exposes the three protocol families', () => {
  assertEquals(RECORDING_PROTOCOLS.length, 3);
  assertEquals(RECORDING_PROTOCOLS.includes('responses'), true);
  assertEquals(RECORDING_PROTOCOLS.includes('chat_completions'), true);
  assertEquals(RECORDING_PROTOCOLS.includes('anthropic_messages'), true);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Summary
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '\u2550'.repeat(80));
console.log(`Test Results: ${passCount}/${testCount} passed, ${failCount} failed`);
console.log('\u2550'.repeat(80));

if (failCount > 0) {
  process.exit(1);
}
