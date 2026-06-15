// TDD: Debug Lock Security and Robustness Fixes
//
// Tests for P0 critical issues:
// 1. Race condition in appendDebugLockTestPage (concurrent access)
// 2. Path traversal vulnerability in persistDebugLockPage
// 3. Sensitive data sanitization
// 4. JSON serialization size limits
//
// RED → GREEN → REFACTOR

import { strict as assert } from 'assert';
import { appendDebugLockTestPage, persistDebugLockPage, sanitizeRequestBodyForDiagnostics } from '../src/debug-lock.mjs';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
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

console.log('Debug Lock Security and Robustness Tests\n');

// ══════════════════════════════════════════════════════════════════════════════
// Test 1 - appendDebugLockTestPage basic behavior
// Note: Original "concurrent race condition" concern was a false positive.
// Node.js single-threaded event loop means synchronous code cannot be interrupted.
// This test now verifies correct append behavior and array length limiting.
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('appendDebugLockTestPage appends pages and respects limit', async () => {
  const state = { debugLock: { enabled: true, test_pages: [] } };
  const testCount = 15; // More than DEBUG_LOCK_MAX_TEST_PAGES (10)

  // Sequential appends (Node.js event loop processes these one by one anyway)
  for (let i = 0; i < testCount; i++) {
    appendDebugLockTestPage(state, {
      timestamp: `2026-06-15T10:00:${String(i).padStart(2, '0')}Z`,
      index: i,
      attempts: [{ sequence: 1, protocol: 'responses', status: 200 }]
    });
  }

  // Should cap at DEBUG_LOCK_MAX_TEST_PAGES
  assert.strictEqual(state.debugLock.test_pages.length, 10,
    'should cap at DEBUG_LOCK_MAX_TEST_PAGES');

  // Newest pages should be kept (indices 14, 13, 12, ..., 5)
  const indices = state.debugLock.test_pages.map(p => p.index);
  assert.deepStrictEqual(indices, [14, 13, 12, 11, 10, 9, 8, 7, 6, 5],
    'should keep newest pages, oldest-first order');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 2 - Path traversal attack should be blocked
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('RED: persistDebugLockPage blocks path traversal attacks', async () => {
  const testDir = join(tmpdir(), `debug-lock-test-${Date.now()}`);
  const parentDir = join(testDir, '..');

  // Attempt path traversal via malicious timestamp
  const maliciousDiagnostics = {
    debug_lock: { upstream: 'mysite' },
    client_request: { protocol: 'responses', model: 'gpt-5.5' },
    attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
    timestamp: '../../../tmp/evil-file'  // Path traversal attempt
  };

  const filePath = await persistDebugLockPage(maliciousDiagnostics, { directory: testDir });

  // File should be created INSIDE testDir, not outside
  assert.ok(filePath.startsWith(testDir), 'file path should be inside target directory');

  // Filename should not contain directory separators
  const filename = basename(filePath);
  assert.ok(!filename.includes('/') && !filename.includes('\\'),
    'filename should not contain directory separators');

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
});

await testAsync('RED: persistDebugLockPage sanitizes special characters in timestamp', async () => {
  const testDir = join(tmpdir(), `debug-lock-test-${Date.now()}`);

  // Timestamp with various special characters
  const diagnostics = {
    debug_lock: { upstream: 'mysite' },
    client_request: { protocol: 'responses', model: 'gpt-5.5' },
    attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
    timestamp: '2026:06:15T10/00\\00.000Z'  // Colons, slashes, backslashes
  };

  const filePath = await persistDebugLockPage(diagnostics, { directory: testDir });

  // Filename should only contain safe characters
  const filename = basename(filePath);
  assert.ok(/^debug-lock-[a-zA-Z0-9-]+\.json$/.test(filename),
    'filename should only contain alphanumeric and hyphens');

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 3 - Sensitive data should be redacted from diagnostics
// ══════════════════════════════════════════════════════════════════════════════

test('RED: sanitizeRequestBodyForDiagnostics redacts sensitive fields', () => {
  const bodyWithSecrets = JSON.stringify({
    model: 'gpt-4',
    input: 'hello',
    api_key: 'sk-1234567890abcdef',
    password: 'supersecret',
    authorization: 'Bearer token123'
  });

  const sanitized = sanitizeRequestBodyForDiagnostics(bodyWithSecrets);

  // Sensitive values should be redacted
  assert.ok(!sanitized.includes('sk-1234567890abcdef'), 'api_key should be redacted');
  assert.ok(!sanitized.includes('supersecret'), 'password should be redacted');
  assert.ok(!sanitized.includes('token123'), 'authorization should be redacted');

  // Non-sensitive fields should remain
  assert.ok(sanitized.includes('gpt-4'), 'model should remain');
  assert.ok(sanitized.includes('hello'), 'input should remain');
});

test('RED: sanitizeRequestBodyForDiagnostics handles nested objects', () => {
  const bodyWithNestedSecrets = JSON.stringify({
    model: 'gpt-4',
    metadata: {
      user_token: 'secret123',
      user_id: 'user-456'
    },
    credentials: {
      password: 'pass123',
      username: 'john'
    }
  });

  const sanitized = sanitizeRequestBodyForDiagnostics(bodyWithNestedSecrets);

  // Nested sensitive values should be redacted
  assert.ok(!sanitized.includes('secret123'), 'nested token should be redacted');
  assert.ok(!sanitized.includes('pass123'), 'nested password should be redacted');

  // Non-sensitive nested fields should remain
  assert.ok(sanitized.includes('user-456'), 'user_id should remain');

  // 'credentials' object is redacted as a whole for safety (entire object replaced with [REDACTED])
  // This is safer than trying to recurse into it - any field under 'credentials' is considered sensitive
  assert.ok(!sanitized.includes('john'), 'username inside credentials should be redacted with parent object');
  assert.ok(sanitized.includes('"credentials": "[REDACTED]"'), 'credentials object should be fully redacted');
});

test('RED: sanitizeRequestBodyForDiagnostics truncates very large bodies', () => {
  const hugeBody = JSON.stringify({
    model: 'gpt-4',
    input: 'x'.repeat(200000)  // 200KB of data
  });

  const sanitized = sanitizeRequestBodyForDiagnostics(hugeBody);

  // Should be truncated
  assert.ok(sanitized.length < hugeBody.length, 'large body should be truncated');

  // The entire output should contain truncation marker (format: "[TRUNCATED: N bytes omitted]")
  assert.ok(sanitized.includes('TRUNCATED'), 'should indicate truncation somewhere in output');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 4 - File persistence should handle size limits
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('RED: persistDebugLockPage truncates large request/response bodies', async () => {
  const testDir = join(tmpdir(), `debug-lock-test-${Date.now()}`);

  const diagnostics = {
    debug_lock: { upstream: 'mysite' },
    client_request: {
      protocol: 'responses',
      model: 'gpt-5.5',
      original_body: 'x'.repeat(200000)  // 200KB original body
    },
    attempts: [{
      sequence: 1,
      protocol: 'responses',
      status: 200,
      request_body: 'y'.repeat(300000),  // 300KB request body
      response_body: 'z'.repeat(400000)  // 400KB response body
    }],
    timestamp: '2026-06-15T10:00:00Z'
  };

  const filePath = await persistDebugLockPage(diagnostics, {
    directory: testDir,
    max_body_size: 100 * 1024  // 100KB limit
  });

  // Read back and verify truncation
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(content);

  // Bodies should be truncated
  assert.ok(parsed.client_request.original_body.length < 200000,
    'original_body should be truncated');
  assert.ok(parsed.attempts[0].request_body.length < 300000,
    'request_body should be truncated');
  assert.ok(parsed.attempts[0].response_body.length < 400000,
    'response_body should be truncated');

  // Should indicate truncation - check for TRUNCATED marker (without square brackets)
  assert.ok(parsed.client_request.original_body.includes('TRUNCATED'),
    'original_body should indicate truncation');
  assert.ok(parsed.attempts[0].request_body.includes('TRUNCATED'),
    'request_body should indicate truncation');
  assert.ok(parsed.attempts[0].response_body.includes('TRUNCATED'),
    'response_body should indicate truncation');

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 5 - File rotation should prevent disk exhaustion
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('RED: persistDebugLockPage enforces max file limit', async () => {
  const testDir = join(tmpdir(), `debug-lock-test-${Date.now()}`);
  const maxFiles = 5;

  // Create more files than the limit
  for (let i = 0; i < maxFiles + 3; i++) {
    const diagnostics = {
      debug_lock: { upstream: 'mysite' },
      client_request: { protocol: 'responses', model: 'gpt-5.5' },
      attempts: [{ sequence: 1, protocol: 'responses', status: 200 }],
      timestamp: `2026-06-15T10:00:${String(i).padStart(2, '0')}Z`
    };

    await persistDebugLockPage(diagnostics, {
      directory: testDir,
      max_files: maxFiles
    });

    // Small delay to ensure different mtimes
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  // Check that only maxFiles exist
  const files = await fs.readdir(testDir);
  const debugLockFiles = files.filter(f => f.startsWith('debug-lock-') && f.endsWith('.json'));

  assert.strictEqual(debugLockFiles.length, maxFiles,
    `should only keep ${maxFiles} files, oldest should be deleted`);

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test 6 - Input validation
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('RED: persistDebugLockPage validates diagnostics structure', async () => {
  const testDir = join(tmpdir(), `debug-lock-test-${Date.now()}`);

  // Test null/undefined
  try {
    await persistDebugLockPage(null, { directory: testDir });
    assert.fail('should throw for null diagnostics');
  } catch (err) {
    assert.ok(err.message.includes('must be a non-null object'), 'should validate null');
  }

  // Test missing timestamp
  try {
    await persistDebugLockPage({ attempts: [] }, { directory: testDir });
    assert.fail('should throw for missing timestamp');
  } catch (err) {
    assert.ok(err.message.includes('timestamp is required'), 'should validate timestamp');
  }

  // Test missing attempts
  try {
    await persistDebugLockPage({ timestamp: '2026-06-15T10:00:00Z' }, { directory: testDir });
    assert.fail('should throw for missing attempts');
  } catch (err) {
    assert.ok(err.message.includes('attempts must be an array'), 'should validate attempts');
  }

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Results
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(80)}`);
console.log(`Results: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.log('\n⚠️  Tests are RED - now implement fixes to make them GREEN');
  process.exit(1);
} else {
  console.log('\n✅ All tests GREEN');
}
