#!/usr/bin/env node

// Verification: Dashboard displays Debug Lock diagnostics
// Tests that the /pool/status API returns diagnostics in the correct format

const BASE_URL = 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.CODEX_POOL_ADMIN_KEY || '';
const POOL_TOKEN = process.env.CODEX_POOL_API_KEY || '';

async function test() {
  console.log('🔍 Verify: Dashboard Debug Lock Diagnostics Display\n');

  // 1. Enable Debug Lock
  console.log('1. Enable Debug Lock...');
  await fetch(`${BASE_URL}/pool/upstreams/rawchat/debug-lock`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ respect_model_override: true })
  });
  console.log('   ✅ Enabled');

  // 2. Send request
  console.log('\n2. Send test request...');
  await fetch(`${BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${POOL_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: 'dashboard test',
      max_tokens: 50
    })
  });
  console.log('   ✅ Request sent');

  // 3. Fetch status
  console.log('\n3. Check /pool/status response...');
  const status = await fetch(`${BASE_URL}/pool/status`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  }).then(r => r.json());

  // Verify structure
  if (!status.debug_lock) {
    console.error('   ❌ Missing debug_lock field');
    process.exit(1);
  }
  console.log('   ✅ debug_lock field present');

  if (!status.debug_lock.enabled) {
    console.error('   ❌ Debug lock not enabled');
    process.exit(1);
  }
  console.log('   ✅ debug_lock.enabled = true');

  if (!status.debug_lock.last_diagnostics) {
    console.error('   ❌ Missing last_diagnostics');
    process.exit(1);
  }
  console.log('   ✅ debug_lock.last_diagnostics present');

  const diag = status.debug_lock.last_diagnostics;

  // Verify diagnostics structure
  const requiredFields = [
    'debug_lock',
    'client_request',
    'attempts',
    'total_attempts',
    'total_latency_ms',
    'timestamp'
  ];

  for (const field of requiredFields) {
    if (!(field in diag)) {
      console.error(`   ❌ Missing field: ${field}`);
      process.exit(1);
    }
  }
  console.log('   ✅ All required fields present');

  // Display diagnostics summary
  console.log('\n📊 Diagnostics Summary:');
  console.log(`   Client protocol: ${diag.client_request.protocol}`);
  console.log(`   Request model: ${diag.client_request.model}`);
  console.log(`   Total attempts: ${diag.total_attempts}`);
  console.log(`   Total latency: ${diag.total_latency_ms}ms`);
  console.log(`   Success: ${diag.succeeded_with ? 'YES' : 'NO'}`);

  if (diag.attempts && diag.attempts.length > 0) {
    console.log('\n   Attempts:');
    for (const attempt of diag.attempts) {
      console.log(`     #${attempt.sequence}: ${attempt.protocol} → ${attempt.status} (${attempt.latency_ms}ms)`);
      if (attempt.error) {
        console.log(`       Error: ${attempt.error}`);
      }
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('✅ Dashboard diagnostics format verified!');
  console.log('\nThe Dashboard JavaScript will receive:');
  console.log('  - lockInfo.last_diagnostics with full attempt details');
  console.log('  - updateDebugLockDiagnostics() will render the panel');
  console.log('  - Panel will show all protocol attempts with status, errors, latency');

  // Cleanup
  await fetch(`${BASE_URL}/pool/debug-unlock`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  });
  console.log('\n🧹 Cleanup: Debug Lock unlocked');
}

test().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
