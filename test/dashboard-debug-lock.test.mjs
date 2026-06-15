// Dashboard Debug Lock UI - TDD Test Suite
//
// Tests the client-side JavaScript logic for Debug Lock Mode UI features:
// 1. Top Diagnostic Bar warning
// 2. Upstream Workbench Lock buttons
// 3. Lock confirmation dialog
// 4. Timeline debug lock icons

import { strict as assert } from 'assert';
import {
  isDebugLockActive,
  getDebugLockInfo,
  shouldShowDebugLockWarning,
  formatDebugLockDuration,
  shouldShowLockButton,
  shouldShowUnlockButton,
  canLockUpstream,
  isDebugLockRequest,
  getDebugLockRequestInfo
} from '../src/dashboard-debug-lock.mjs';

// Test helpers
const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function testAsync(name, fn) {
  tests.push({ name, fn, async: true });
}

function assertEquals(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 1 - Debug Lock State Detection
// ══════════════════════════════════════════════════════════════════════════════

test('isDebugLockActive: returns false when disabled', () => {
  const status = {
    debug_lock: {
      enabled: false
    }
  };

  const result = isDebugLockActive(status);

  assertEquals(result, false);
});

test('isDebugLockActive: returns true when enabled', () => {
  const status = {
    debug_lock: {
      enabled: true,
      upstream: 'mysite',
      locked_at: '2026-06-14T10:00:00Z'
    }
  };

  const result = isDebugLockActive(status);

  assertEquals(result, true);
});

test('isDebugLockActive: returns false when debug_lock missing', () => {
  const status = {};

  const result = isDebugLockActive(status);

  assertEquals(result, false);
});

test('getDebugLockInfo: returns null when disabled', () => {
  const status = {
    debug_lock: {
      enabled: false
    }
  };

  const result = getDebugLockInfo(status);

  assertEquals(result, null);
});

test('getDebugLockInfo: returns lock info when enabled', () => {
  const status = {
    debug_lock: {
      enabled: true,
      upstream: 'mysite',
      locked_at: '2026-06-14T10:00:00Z',
      locked_duration_seconds: 120
    }
  };

  const result = getDebugLockInfo(status);

  assertEquals(result, {
    upstream: 'mysite',
    locked_at: '2026-06-14T10:00:00Z',
    locked_duration_seconds: 120
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 2 - Top Diagnostic Bar Warning
// ══════════════════════════════════════════════════════════════════════════════

test('shouldShowDebugLockWarning: returns true when locked', () => {
  const status = {
    debug_lock: {
      enabled: true,
      upstream: 'mysite'
    }
  };

  const result = shouldShowDebugLockWarning(status);

  assertEquals(result, true);
});

test('shouldShowDebugLockWarning: returns false when not locked', () => {
  const status = {
    debug_lock: {
      enabled: false
    }
  };

  const result = shouldShowDebugLockWarning(status);

  assertEquals(result, false);
});

test('formatDebugLockDuration: formats seconds correctly', () => {
  assertEquals(formatDebugLockDuration(30), '30秒');
  assertEquals(formatDebugLockDuration(90), '1分30秒');
  assertEquals(formatDebugLockDuration(3660), '1小时1分');
  assertEquals(formatDebugLockDuration(7325), '2小时2分');
});

test('formatDebugLockDuration: handles zero', () => {
  assertEquals(formatDebugLockDuration(0), '0秒');
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 3 - Upstream Workbench Lock Buttons
// ══════════════════════════════════════════════════════════════════════════════

test('shouldShowLockButton: returns true when not locked', () => {
  const upstream = { name: 'mysite', api: 'openai' };
  const lockInfo = null;

  const result = shouldShowLockButton(upstream, lockInfo);

  assertEquals(result, true);
});

test('shouldShowLockButton: returns false when this upstream is locked', () => {
  const upstream = { name: 'mysite', api: 'openai' };
  const lockInfo = { upstream: 'mysite' };

  const result = shouldShowLockButton(upstream, lockInfo);

  assertEquals(result, false);
});

test('shouldShowLockButton: returns false when another upstream is locked', () => {
  const upstream = { name: 'mysite', api: 'openai' };
  const lockInfo = { upstream: 'other-site' };

  const result = shouldShowLockButton(upstream, lockInfo);

  assertEquals(result, false);
});

test('shouldShowUnlockButton: returns true when this upstream is locked', () => {
  const upstream = { name: 'mysite', api: 'openai' };
  const lockInfo = { upstream: 'mysite' };

  const result = shouldShowUnlockButton(upstream, lockInfo);

  assertEquals(result, true);
});

test('shouldShowUnlockButton: returns false when not locked', () => {
  const upstream = { name: 'mysite', api: 'openai' };
  const lockInfo = null;

  const result = shouldShowUnlockButton(upstream, lockInfo);

  assertEquals(result, false);
});

test('canLockUpstream: returns true for regular upstream', () => {
  const upstream = { name: 'mysite', api: 'openai' };

  const result = canLockUpstream(upstream);

  assertEquals(result.canLock, true);
  assertEquals(result.reason, null);
});

test('canLockUpstream: returns false for codex-oauth upstream', () => {
  const upstream = { name: 'mysite', api: 'codex-oauth' };

  const result = canLockUpstream(upstream);

  assertEquals(result.canLock, false);
  assert.match(result.reason, /codex.*oauth/i);
});

test('canLockUpstream: returns warning for quarantined upstream', () => {
  const upstream = { name: 'mysite', api: 'openai', quarantined: true };

  const result = canLockUpstream(upstream);

  assertEquals(result.canLock, true);
  assert.match(result.reason, /quarantine/i);
});

test('canLockUpstream: returns warning for disabled upstream', () => {
  const upstream = { name: 'mysite', api: 'openai', enabled: false };

  const result = canLockUpstream(upstream);

  assertEquals(result.canLock, true);
  assert.match(result.reason, /disabled/i);
});

// ══════════════════════════════════════════════════════════════════════════════
// RED: Test Suite 4 - Timeline Debug Lock Markers
// ══════════════════════════════════════════════════════════════════════════════

test('isDebugLockRequest: returns true for debug lock request', () => {
  const request = {
    debug_lock: true,
    locked_upstream: 'mysite'
  };

  const result = isDebugLockRequest(request);

  assertEquals(result, true);
});

test('isDebugLockRequest: returns false for normal request', () => {
  const request = {
    upstream: 'mysite'
  };

  const result = isDebugLockRequest(request);

  assertEquals(result, false);
});

test('isDebugLockRequest: returns false when debug_lock is false', () => {
  const request = {
    debug_lock: false,
    upstream: 'mysite'
  };

  const result = isDebugLockRequest(request);

  assertEquals(result, false);
});

test('getDebugLockRequestInfo: returns info for debug request', () => {
  const request = {
    debug_lock: true,
    locked_upstream: 'mysite',
    attempts: 2,
    final_protocol: 'chat_completions'
  };

  const result = getDebugLockRequestInfo(request);

  assertEquals(result, {
    locked_upstream: 'mysite',
    attempts: 2,
    final_protocol: 'chat_completions'
  });
});

test('getDebugLockRequestInfo: returns null for normal request', () => {
  const request = {
    upstream: 'mysite'
  };

  const result = getDebugLockRequestInfo(request);

  assertEquals(result, null);
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Runner
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== Dashboard Debug Lock UI Test Suite ===\n');

for (const { name, fn, async: isAsync } of tests) {
  try {
    if (isAsync) {
      await fn();
    } else {
      fn();
    }
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    if (error.stack) {
      const lines = error.stack.split('\n').slice(1, 4);
      lines.forEach(line => console.error(`  ${line.trim()}`));
    }
    failed++;
  }
}

console.log('\n' + '='.repeat(80));
console.log('Dashboard Debug Lock UI Test Suite');
console.log('='.repeat(80));
console.log(`\nTests: ${tests.length}, Passed: ${passed}, Failed: ${failed}\n`);

process.exit(failed > 0 ? 1 : 0);
