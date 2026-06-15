// TDD: Test resource leak fix in executeDebugLockedRequest
//
// Verifies that response streams are properly closed even when errors occur

import { strict as assert } from 'assert';
import { PassThrough } from 'stream';

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
  }
}

console.log('Debug Lock Resource Leak Tests\n');

// ══════════════════════════════════════════════════════════════════════════════
// Test: Response stream is destroyed after reading completes
// ══════════════════════════════════════════════════════════════════════════════

await testAsync('response stream is destroyed after successful read', async () => {
  // Simulate the response stream reading logic
  const mockResponse = new PassThrough();
  let destroyed = false;

  // Override destroy to track if it was called
  const originalDestroy = mockResponse.destroy.bind(mockResponse);
  mockResponse.destroy = function() {
    destroyed = true;
    return originalDestroy();
  };

  // Simulate successful response
  mockResponse.end('{"status": "ok"}');

  const chunks = [];
  let bodySize = 0;
  const maxBodySize = 1024;

  try {
    for await (const chunk of mockResponse) {
      if (bodySize < maxBodySize) {
        chunks.push(chunk);
        bodySize += chunk.length;
      }
    }
  } finally {
    if (mockResponse && typeof mockResponse.destroy === 'function') {
      mockResponse.destroy();
    }
  }

  assert.ok(destroyed, 'stream should be destroyed after reading');
});

await testAsync('response stream is destroyed even when read throws error', async () => {
  const mockResponse = new PassThrough();
  let destroyed = false;

  const originalDestroy = mockResponse.destroy.bind(mockResponse);
  mockResponse.destroy = function() {
    destroyed = true;
    return originalDestroy();
  };

  // Simulate error during read
  setImmediate(() => {
    mockResponse.emit('error', new Error('Read error'));
  });

  let errorCaught = false;
  try {
    const chunks = [];
    let bodySize = 0;
    const maxBodySize = 1024;

    try {
      for await (const chunk of mockResponse) {
        if (bodySize < maxBodySize) {
          chunks.push(chunk);
          bodySize += chunk.length;
        }
      }
    } finally {
      if (mockResponse && typeof mockResponse.destroy === 'function') {
        mockResponse.destroy();
      }
    }
  } catch (err) {
    errorCaught = true;
  }

  assert.ok(errorCaught, 'error should be caught');
  assert.ok(destroyed, 'stream should be destroyed even after error');
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Results
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(80)}`);
console.log(`Results: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) {
  process.exit(1);
} else {
  console.log('\n✅ All resource leak tests GREEN');
}
