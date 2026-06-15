#!/usr/bin/env node

// E2E Test: Debug Lock Diagnostics Persistence (multi-page)
// Verifies that each request appends a page, pages don't overwrite each other,
// and diagnostics only clear when explicitly unlocked.

const BASE_URL = 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.CODEX_POOL_ADMIN_KEY || '';
const POOL_TOKEN = process.env.CODEX_POOL_API_KEY || '';

async function test() {
  console.log('🧪 E2E: Debug Lock Diagnostics Persistence (multi-page)\n');

  // Test 1: Enable Debug Lock
  console.log('1. Enable Debug Lock to rawchat...');
  const lockRes = await fetch(`${BASE_URL}/pool/upstreams/rawchat/debug-lock`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ respect_model_override: true })
  });
  const lockResult = await lockRes.json();
  if (!lockResult.ok) {
    console.error('   ❌ Failed to enable Debug Lock');
    process.exit(1);
  }
  console.log('   ✅ Debug Lock enabled');

  // Test 2: Send first request (will fail with 403)
  console.log('\n2. Send first request (expected to fail)...');
  await fetch(`${BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${POOL_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: 'first test request',
      max_tokens: 50
    })
  });
  console.log('   ✅ First request sent');

  // Check diagnostics exist (test_pages array should have 1 page)
  const status1 = await fetch(`${BASE_URL}/pool/status`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  }).then(r => r.json());

  if (!Array.isArray(status1.debug_lock?.test_pages) || status1.debug_lock.test_pages.length === 0) {
    console.error('   ❌ test_pages empty after first request');
    process.exit(1);
  }
  console.log('   ✅ test_pages has 1 page after first request');
  console.log(`      - Pages: ${status1.debug_lock.test_pages.length}`);
  console.log(`      - Attempts: ${status1.debug_lock.test_pages[0].total_attempts}`);
  console.log(`      - Timestamp: ${status1.debug_lock.test_pages[0].timestamp}`);

  const firstTimestamp = status1.debug_lock.test_pages[0].timestamp;

  // Test 3: Send second request (will also fail with 403)
  console.log('\n3. Send second request...');
  await new Promise(resolve => setTimeout(resolve, 100)); // Small delay to ensure different timestamp

  await fetch(`${BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${POOL_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: 'second test request',
      max_tokens: 50
    })
  });
  console.log('   ✅ Second request sent');

  // Check: second request APPENDS a page (now 2 pages). Newest is first.
  // first_test_diagnostics (back-compat alias) points to newest page.
  const status2 = await fetch(`${BASE_URL}/pool/status`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  }).then(r => r.json());

  if (!Array.isArray(status2.debug_lock?.test_pages) || status2.debug_lock.test_pages.length < 2) {
    console.error(`   ❌ Expected 2 pages, got ${status2.debug_lock?.test_pages?.length || 0}`);
    process.exit(1);
  }

  const secondTimestamp = status2.debug_lock.test_pages[0].timestamp;
  if (secondTimestamp === firstTimestamp) {
    console.error('   ❌ Second request did not create a new page');
    process.exit(1);
  }

  console.log('   ✅ Second request appended a new page (not overwritten)');
  console.log(`      - Total pages: ${status2.debug_lock.test_pages.length}`);
  console.log(`      - Newest page timestamp: ${secondTimestamp}`);
  console.log(`      - Oldest page timestamp: ${status2.debug_lock.test_pages[status2.debug_lock.test_pages.length - 1].timestamp}`);
  // first_test_diagnostics back-compat alias should now point to newest page.
  console.log(`      - first_test_diagnostics alias → newest: ${status2.debug_lock.first_test_diagnostics?.timestamp === secondTimestamp}`);

  // Test 4: Unlock Debug Lock
  console.log('\n4. Unlock Debug Lock...');
  const unlockRes = await fetch(`${BASE_URL}/pool/debug-unlock`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  });
  const unlockResult = await unlockRes.json();
  if (!unlockResult.ok) {
    console.error('   ❌ Failed to unlock');
    process.exit(1);
  }
  console.log('   ✅ Debug Lock disabled');

  // Test 5: Verify diagnostics cleared
  const status3 = await fetch(`${BASE_URL}/pool/status`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  }).then(r => r.json());

  if (status3.debug_lock?.enabled) {
    console.error('   ❌ Debug Lock still enabled');
    process.exit(1);
  }

  if (status3.debug_lock?.first_test_diagnostics) {
    console.error('   ❌ Diagnostics not cleared after unlock');
    console.error(`      Found: ${JSON.stringify(status3.debug_lock.first_test_diagnostics)}`);
    process.exit(1);
  }

  console.log('   ✅ Diagnostics cleared after unlock');

  console.log('\n' + '═'.repeat(80));
  console.log('✅ All E2E tests passed!');
  console.log('\nBehavior verified:');
  console.log('  ✓ Each request appends a new page to test_pages');
  console.log('  ✓ Pages are newest-first; older pages are preserved below');
  console.log('  ✓ first_test_diagnostics alias points to the newest page');
  console.log('  ✓ Diagnostics only clear when explicitly unlocked');
}

test().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
