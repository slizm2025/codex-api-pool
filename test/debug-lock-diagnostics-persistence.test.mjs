// TDD: Debug Lock Diagnostics Persistence and Display
//
// Tests for the multi-page diagnostic display behavior:
// 1. Each real client request (incl. retries) appends a page — never overwrites
// 2. Pages persist across multiple requests, newest-first, capped at 10
// 3. Diagnostics only clear when explicitly unlocked
// 4. Diagnostics can be persisted to files for analysis
//
// RED → GREEN → REFACTOR

import { strict as assert } from 'assert';
import { appendDebugLockTestPage, DEBUG_LOCK_MAX_TEST_PAGES } from '../src/debug-lock.mjs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
// RED: Test 1 - Successful request should KEEP first diagnostics (not clear)
// ══════════════════════════════════════════════════════════════════════════════

test('RED: successful request preserves diagnostics', () => {
  // After a successful Debug Lock request, the diagnostics page must persist in
  // state.debugLock.test_pages (newest-first).

  const state = {
    debugLock: {
      enabled: true,
      upstream: 'test-upstream',
      first_test_completed: false,
      test_pages: []
    }
  };

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

  appendDebugLockTestPage(state, mockDiagnostics);

  assert.strictEqual(state.debugLock.test_pages.length, 1, 'diagnostics page should exist after successful request');
  assert.strictEqual(state.debugLock.test_pages[0].succeeded_with.protocol, 'responses');
  assert.strictEqual(state.debugLock.test_pages[0].total_attempts, 1);
  assert.strictEqual(state.debugLock.first_test_completed, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 2 - Multiple requests should retain first diagnostics
// ══════════════════════════════════════════════════════════════════════════════

test('a failed request then a successful request each append their own page', () => {
  const state = {
    debugLock: {
      enabled: true,
      upstream: 'test-upstream',
      first_test_completed: false,
      test_pages: []
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
  appendDebugLockTestPage(state, firstDiagnostics);
  assert.strictEqual(state.debugLock.test_pages.length, 1);

  // Second request (successful) — appends as a new page, does not overwrite.
  const secondDiagnostics = {
    attempts: [
      { sequence: 1, protocol: 'responses', status: 200 }
    ],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    timestamp: '2026-06-14T10:01:00.000Z'
  };
  appendDebugLockTestPage(state, secondDiagnostics);

  assert.strictEqual(state.debugLock.test_pages.length, 2);
  // Newest first: the successful page is on top.
  assert.strictEqual(state.debugLock.test_pages[0].timestamp, '2026-06-14T10:01:00.000Z');
  assert.strictEqual(state.debugLock.test_pages[0].succeeded_with.protocol, 'responses');
  // The failed page is preserved below, not overwritten.
  assert.strictEqual(state.debugLock.test_pages[1].timestamp, '2026-06-14T10:00:00.000Z');
  assert.strictEqual(state.debugLock.test_pages[1].succeeded_with, null);
});

test('multiple successful requests each append a page (none overwritten)', () => {
  const state = {
    debugLock: {
      enabled: true,
      upstream: 'test-upstream',
      first_test_completed: false,
      test_pages: []
    }
  };

  const firstDiagnostics = {
    attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    timestamp: '2026-06-14T10:00:00.000Z'
  };
  appendDebugLockTestPage(state, firstDiagnostics);

  const secondDiagnostics = {
    attempts: [{ sequence: 1, protocol: 'chat_completions', status: 200 }],
    succeeded_with: { protocol: 'chat_completions', adapter: true, sequence: 1 },
    total_attempts: 1,
    timestamp: '2026-06-14T10:01:00.000Z'
  };
  appendDebugLockTestPage(state, secondDiagnostics);

  // Both pages are retained; latest on top, oldest preserved below.
  assert.strictEqual(state.debugLock.test_pages.length, 2);
  assert.strictEqual(state.debugLock.test_pages[0].timestamp, '2026-06-14T10:01:00.000Z');
  assert.strictEqual(state.debugLock.test_pages[0].succeeded_with.protocol, 'chat_completions');
  assert.strictEqual(state.debugLock.test_pages[1].timestamp, '2026-06-14T10:00:00.000Z');
  assert.strictEqual(state.debugLock.test_pages[1].succeeded_with.protocol, 'responses');
});

test('history is capped at DEBUG_LOCK_MAX_TEST_PAGES pages', () => {
  const state = { debugLock: { enabled: true, test_pages: [] } };
  for (let i = 0; i < DEBUG_LOCK_MAX_TEST_PAGES + 3; i++) {
    appendDebugLockTestPage(state, { timestamp: `t${i}`, index: i });
  }
  assert.strictEqual(state.debugLock.test_pages.length, DEBUG_LOCK_MAX_TEST_PAGES);
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
      first_test_completed: true,
      test_pages: [
        {
          attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
          succeeded_with: { protocol: 'responses' },
          total_attempts: 1
        }
      ]
    }
  };

  const { disableDebugLock } = await import('../src/debug-lock.mjs');
  const result = disableDebugLock(state);

  assert.ok(result.ok, 'should successfully disable');
  assert.strictEqual(state.debugLock.enabled, false);

  // Diagnostics pages should be cleared on unlock.
  assert.ok(Array.isArray(state.debugLock.test_pages), 'test_pages should be an array');
  assert.strictEqual(state.debugLock.test_pages.length, 0, 'diagnostics pages should be cleared on unlock');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 4 - Integration test with executeDebugLockedRequest
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('RED: executeDebugLockedRequest preserves diagnostics on success', async () => {
  // Mirrors the state mutation that executeDebugLockedRequest performs: it
  // appends a diagnostics page regardless of success/failure.

  const state = {
    debugLock: {
      enabled: true,
      upstream: 'test-upstream',
      respect_model_override: true,
      locked_at: new Date().toISOString(),
      test_pages: []
    }
  };

  const diagnostics = {
    attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    total_latency_ms: 150
  };

  // Same call executeDebugLockedRequest makes after building diagnostics.
  appendDebugLockTestPage(state, diagnostics);

  assert.strictEqual(state.debugLock.test_pages.length, 1, 'diagnostics page should be preserved even on success');
  assert.ok(state.debugLock.test_pages[0].succeeded_with, 'should have success information');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 5 - File Persistence (tracer bullet)
// ══════════════════════════════════════════════════════════════════════════════

import { persistDebugLockPage } from '../src/debug-lock.mjs';

await testAsync('RED: persistDebugLockPage writes diagnostics to JSON file', async () => {
  const testDir = join(tmpdir(), `debug-lock-test-${Date.now()}`);

  const diagnostics = {
    debug_lock: {
      upstream: 'mysite',
      locked_at: '2026-06-15T10:00:00Z',
      respect_model_override: true
    },
    client_request: {
      protocol: 'responses',
      model: 'gpt-5.5',
      model_sent: 'gpt-5.5',
      original_body: '{"model":"gpt-5.5","input":"hello"}'
    },
    attempts: [
      {
        sequence: 1,
        protocol: 'responses',
        endpoint: '/v1/responses',
        adapter: false,
        status: 200,
        request_body: '{"model":"gpt-5.5","input":"hello"}',
        response_body: '{"id":"resp-1","output":[{"content":"hi"}]}',
        latency_ms: 123
      }
    ],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    total_latency_ms: 123,
    timestamp: '2026-06-15T10:00:01Z'
  };

  const filePath = await persistDebugLockPage(diagnostics, { directory: testDir });

  // Verify file was created
  const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
  assert.ok(fileExists, `File should exist at ${filePath}`);

  // Verify file contains correct data
  const fileContent = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(fileContent);

  assert.strictEqual(parsed.debug_lock.upstream, 'mysite');
  assert.strictEqual(parsed.client_request.original_body, '{"model":"gpt-5.5","input":"hello"}');
  assert.strictEqual(parsed.attempts[0].request_body, '{"model":"gpt-5.5","input":"hello"}');
  assert.strictEqual(parsed.attempts[0].response_body, '{"id":"resp-1","output":[{"content":"hi"}]}');

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
});

await testAsync('RED: multiple requests create separate files without conflicts', async () => {
  const testDir = join(tmpdir(), `debug-lock-test-${Date.now()}`);

  const diagnostics1 = {
    debug_lock: { upstream: 'mysite' },
    client_request: { protocol: 'responses', model: 'gpt-5.5', original_body: '{"input":"hello"}' },
    attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    total_latency_ms: 100,
    timestamp: '2026-06-15T10:00:00Z'
  };

  const diagnostics2 = {
    debug_lock: { upstream: 'mysite' },
    client_request: { protocol: 'responses', model: 'gpt-5.5', original_body: '{"input":"world"}' },
    attempts: [{ sequence: 1, protocol: 'chat_completions', status: 200 }],
    succeeded_with: { protocol: 'chat_completions', adapter: true, sequence: 1 },
    total_attempts: 1,
    total_latency_ms: 150,
    timestamp: '2026-06-15T10:00:01Z'
  };

  const filePath1 = await persistDebugLockPage(diagnostics1, { directory: testDir });
  const filePath2 = await persistDebugLockPage(diagnostics2, { directory: testDir });

  // Files should be different
  assert.notStrictEqual(filePath1, filePath2, 'should create different files');

  // Both files should exist
  const exists1 = await fs.access(filePath1).then(() => true).catch(() => false);
  const exists2 = await fs.access(filePath2).then(() => true).catch(() => false);
  assert.ok(exists1, 'first file should exist');
  assert.ok(exists2, 'second file should exist');

  // Verify each file contains correct data
  const content1 = JSON.parse(await fs.readFile(filePath1, 'utf-8'));
  const content2 = JSON.parse(await fs.readFile(filePath2, 'utf-8'));

  assert.strictEqual(content1.client_request.original_body, '{"input":"hello"}');
  assert.strictEqual(content2.client_request.original_body, '{"input":"world"}');

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
});

await testAsync('RED: creates directory if it does not exist', async () => {
  const testDir = join(tmpdir(), `debug-lock-test-${Date.now()}-nested`, 'subdir');

  // Verify directory doesn't exist initially
  const dirExists = await fs.access(testDir).then(() => true).catch(() => false);
  assert.strictEqual(dirExists, false, 'directory should not exist initially');

  const diagnostics = {
    debug_lock: { upstream: 'mysite' },
    client_request: { protocol: 'responses', model: 'gpt-5.5', original_body: '{}' },
    attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
    succeeded_with: { protocol: 'responses', adapter: false, sequence: 1 },
    total_attempts: 1,
    total_latency_ms: 100,
    timestamp: '2026-06-15T10:00:00Z'
  };

  const filePath = await persistDebugLockPage(diagnostics, { directory: testDir });

  // Verify directory was created
  const dirExistsAfter = await fs.access(testDir).then(() => true).catch(() => false);
  assert.ok(dirExistsAfter, 'directory should be created');

  // Verify file exists
  const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
  assert.ok(fileExists, 'file should exist in created directory');

  // Cleanup (remove parent directory)
  const parentDir = join(testDir, '..');
  await fs.rm(parentDir, { recursive: true, force: true }).catch(() => {});
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 6 - Persistence Configuration
// ══════════════════════════════════════════════════════════════════════════════

import { getDebugLockPersistenceConfig } from '../src/debug-lock.mjs';

test('RED: getDebugLockPersistenceConfig returns defaults when not configured', () => {
  const config = {};
  const persistConfig = getDebugLockPersistenceConfig(config);

  assert.strictEqual(persistConfig.enabled, false, 'should be disabled by default');
  assert.strictEqual(persistConfig.directory, './debug-lock-logs', 'should have default directory');
  assert.strictEqual(persistConfig.format, 'json', 'should default to json format');
});

test('RED: getDebugLockPersistenceConfig reads from config', () => {
  const config = {
    debug_lock_persistence: {
      enabled: true,
      directory: '/tmp/my-debug-logs',
      format: 'json'
    }
  };

  const persistConfig = getDebugLockPersistenceConfig(config);

  assert.strictEqual(persistConfig.enabled, true);
  assert.strictEqual(persistConfig.directory, '/tmp/my-debug-logs');
  assert.strictEqual(persistConfig.format, 'json');
});

test('RED: getDebugLockPersistenceConfig handles partial config', () => {
  const config = {
    debug_lock_persistence: {
      enabled: true
    }
  };

  const persistConfig = getDebugLockPersistenceConfig(config);

  assert.strictEqual(persistConfig.enabled, true, 'should use configured enabled');
  assert.strictEqual(persistConfig.directory, './debug-lock-logs', 'should use default directory');
  assert.strictEqual(persistConfig.format, 'json', 'should use default format');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Results
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(80)}`);
console.log(`Results: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) {
  process.exit(1);
}
