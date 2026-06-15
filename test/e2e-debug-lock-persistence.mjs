#!/usr/bin/env node

// E2E Test: Debug Lock Diagnostics Persistence
// Verifies that diagnostics persist across requests and only clear on unlock

const BASE_URL = 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.CODEX_POOL_ADMIN_KEY || '';
const POOL_TOKEN = process.env.CODEX_POOL_API_KEY || '';

async function test() {
  console.log('🧪 E2E: Debug Lock Diagnostics Persistence\n');

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

  // Check diagnostics exist
  const status1 = await fetch(`${BASE_URL}/pool/status`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  }).then(r => r.json());

  if (!status1.debug_lock?.last_diagnostics) {
    console.error('   ❌ Diagnostics not saved after first request');
    process.exit(1);
  }
  console.log('   ✅ Diagnostics saved after first request');
  console.log(`      - Attempts: ${status1.debug_lock.last_diagnostics.total_attempts}`);
  console.log(`      - Timestamp: ${status1.debug_lock.last_diagnostics.timestamp}`);

  const firstTimestamp = status1.debug_lock.last_diagnostics.timestamp;

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

  // Check diagnostics updated
  const status2 = await fetch(`${BASE_URL}/pool/status`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  }).then(r => r.json());

  if (!status2.debug_lock?.last_diagnostics) {
    console.error('   ❌ Diagnostics not saved after second request');
    process.exit(1);
  }

  const secondTimestamp = status2.debug_lock.last_diagnostics.timestamp;
  if (secondTimestamp === firstTimestamp) {
    console.error('   ❌ Diagnostics not updated (timestamp unchanged)');
    process.exit(1);
  }

  console.log('   ✅ Diagnostics updated with latest request');
  console.log(`      - New timestamp: ${secondTimestamp}`);
  console.log(`      - Still present: true`);

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

  if (status3.debug_lock?.last_diagnostics) {
    console.error('   ❌ Diagnostics not cleared after unlock');
    console.error(`      Found: ${JSON.stringify(status3.debug_lock.last_diagnostics)}`);
    process.exit(1);
  }

  console.log('   ✅ Diagnostics cleared after unlock');

  console.log('\n' + '═'.repeat(80));
  console.log('✅ All E2E tests passed!');
  console.log('\nBehavior verified:');
  console.log('  ✓ Diagnostics persist across multiple requests');
  console.log('  ✓ Each request updates the diagnostics');
  console.log('  ✓ Diagnostics only clear when explicitly unlocked');
}

test().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
