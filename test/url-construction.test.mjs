#!/usr/bin/env node

// Test: URL Construction Logic
// Verifies that all URL building functions in server.mjs correctly handle
// base_url with/without /v1, custom path prefixes, and configured health paths.

import assert from 'assert';
import { __testInternals } from '../src/server.mjs';

const {
  joinUrlPath,
  joinTargetUrl,
  joinDebugRequestUrl,
  responsesPathForBaseUrl,
  chatCompletionsPathForBaseUrl,
  anthropicMessagesPathForBaseUrl,
  anthropicModelsPathForBaseUrl
} = __testInternals;

console.log('🧪 Test: URL Construction Logic (real functions from server.mjs)\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
    failed++;
  }
}

console.log('═'.repeat(80));
console.log('Smart Path Functions — base WITHOUT /v1');
console.log('═'.repeat(80));

test('responses path', () => assert.strictEqual(responsesPathForBaseUrl('https://api.com'), '/v1/responses'));
test('chat path', () => assert.strictEqual(chatCompletionsPathForBaseUrl('https://api.com'), '/v1/chat/completions'));
test('messages path', () => assert.strictEqual(anthropicMessagesPathForBaseUrl('https://api.com'), '/v1/messages'));
test('models path', () => assert.strictEqual(anthropicModelsPathForBaseUrl('https://api.com'), '/v1/models'));

console.log('\n' + '═'.repeat(80));
console.log('Smart Path Functions — base WITH /v1');
console.log('═'.repeat(80));

test('responses path', () => assert.strictEqual(responsesPathForBaseUrl('https://api.com/v1'), '/responses'));
test('chat path', () => assert.strictEqual(chatCompletionsPathForBaseUrl('https://api.com/v1'), '/chat/completions'));
test('messages path', () => assert.strictEqual(anthropicMessagesPathForBaseUrl('https://api.com/v1'), '/messages'));
test('models path', () => assert.strictEqual(anthropicModelsPathForBaseUrl('https://api.com/v1'), '/models'));

test('responses path — trailing slash', () => assert.strictEqual(responsesPathForBaseUrl('https://api.com/v1/'), '/responses'));
test('responses path — custom prefix + /v1', () => assert.strictEqual(responsesPathForBaseUrl('https://api.com/codex/v1'), '/responses'));

console.log('\n' + '═'.repeat(80));
console.log('Full URL — Responses probe (probeResponsesUpstream fix)');
console.log('═'.repeat(80));

function responsesUrl(baseUrl) {
  return joinUrlPath(baseUrl, responsesPathForBaseUrl(baseUrl));
}

test('base without /v1', () => assert.strictEqual(responsesUrl('https://api.com'), 'https://api.com/v1/responses'));
test('base with /v1', () => assert.strictEqual(responsesUrl('https://api.com/v1'), 'https://api.com/v1/responses'));
test('base with custom prefix + /v1', () => assert.strictEqual(responsesUrl('https://api.com/codex/v1'), 'https://api.com/codex/v1/responses'));
test('base with custom prefix, no /v1', () => assert.strictEqual(responsesUrl('https://api.com/codex'), 'https://api.com/codex/v1/responses'));

console.log('\n' + '═'.repeat(80));
console.log('Full URL — Supplemental models with custom healthPath (joinDebugRequestUrl fix)');
console.log('═'.repeat(80));

// This is the previously-broken case: healthPath="/v1/models" + base ending in /v1
test('healthPath=/v1/models + base with /v1 (NO duplicate)', () => {
  assert.strictEqual(joinDebugRequestUrl('https://api.com/v1', '/v1/models'), 'https://api.com/v1/models');
});
test('healthPath=/v1/models + base without /v1', () => {
  assert.strictEqual(joinDebugRequestUrl('https://api.com', '/v1/models'), 'https://api.com/v1/models');
});
test('healthPath=/models + base with /v1 (preserved as-is)', () => {
  assert.strictEqual(joinDebugRequestUrl('https://api.com/v1', '/models'), 'https://api.com/v1/models');
});
test('healthPath=/custom/models preserved (no /v1 munging)', () => {
  assert.strictEqual(joinDebugRequestUrl('https://api.com', '/custom/models'), 'https://api.com/custom/models');
});
test('healthPath=/v1/models + custom prefix + /v1 (NO duplicate)', () => {
  assert.strictEqual(joinDebugRequestUrl('https://api.com/codex/v1', '/v1/models'), 'https://api.com/codex/v1/models');
});
test('healthPath as full URL passes through', () => {
  assert.strictEqual(joinDebugRequestUrl('https://api.com/v1', 'https://other.com/x'), 'https://other.com/x');
});

console.log('\n' + '═'.repeat(80));
console.log('joinTargetUrl — publicPrefix stripping (default health path)');
console.log('═'.repeat(80));

test('base without /v1, prefix /v1', () => assert.strictEqual(joinTargetUrl('https://api.com', '/v1/models', '/v1'), 'https://api.com/models'));
test('base with /v1, prefix /v1', () => assert.strictEqual(joinTargetUrl('https://api.com/v1', '/v1/models', '/v1'), 'https://api.com/v1/models'));
test('base with custom prefix + /v1, prefix /v1', () => assert.strictEqual(joinTargetUrl('https://api.com/codex/v1', '/v1/models', '/v1'), 'https://api.com/codex/v1/models'));

console.log('\n' + '═'.repeat(80));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(80));

if (failed > 0) {
  console.log('\n⚠️  URL construction has issues');
  process.exit(1);
}
console.log('\n✅ All URL construction tests passed!');
