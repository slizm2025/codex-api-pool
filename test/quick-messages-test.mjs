#!/usr/bin/env node
// Inline test runner that doesn't need workspace

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';

process.env.TEST_POOL_TOKEN = 'test-secret-token';

const pool = createPoolServer({
  server: {
    host: '127.0.0.1',
    port: 0,
    public_prefix: '/v1',
    auth_token_env: 'TEST_POOL_TOKEN'
  },
  upstreams: []
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: address.port, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function test() {
  const poolInfo = await listen(pool);
  console.log(`Pool listening on ${poolInfo.url}\n`);

  // Test 1: Invalid auth
  console.log('TEST 1: Invalid auth returns 401 with Anthropic format');
  const r1 = await fetch(`${poolInfo.url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-8', messages: [], max_tokens: 100 })
  });
  const j1 = await r1.json();
  console.log(`  Status: ${r1.status}`);
  console.log(`  Response: ${JSON.stringify(j1)}`);
  console.log(`  ${r1.status === 401 && j1.type === 'error' && j1.error ? '✓ PASS' : '✗ FAIL'}\n`);

  // Test 2: Invalid JSON
  console.log('TEST 2: Invalid JSON returns 400 with Anthropic format');
  const r2 = await fetch(`${poolInfo.url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
    body: 'not-json'
  });
  const j2 = await r2.json();
  console.log(`  Status: ${r2.status}`);
  console.log(`  Response: ${JSON.stringify(j2)}`);
  console.log(`  ${r2.status === 400 && j2.type === 'error' ? '✓ PASS' : '✗ FAIL'}\n`);

  // Test 3: Missing required fields
  console.log('TEST 3: Missing required fields returns 400');
  const r3 = await fetch(`${poolInfo.url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-8' })
  });
  const j3 = await r3.json();
  console.log(`  Status: ${r3.status}`);
  console.log(`  Response: ${JSON.stringify(j3)}`);
  console.log(`  ${r3.status === 400 && j3.error?.message?.includes('messages') ? '✓ PASS' : '✗ FAIL'}\n`);

  // Test 4: Responses endpoint still uses OpenAI format
  console.log('TEST 4: Responses endpoint keeps OpenAI error format');
  const r4 = await fetch(`${poolInfo.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5', input: 'hello' })
  });
  const j4 = await r4.json();
  console.log(`  Status: ${r4.status}`);
  console.log(`  Response: ${JSON.stringify(j4)}`);
  console.log(`  ${r4.status === 401 && j4.error && typeof j4.error === 'object' && !j4.type ? '✓ PASS' : '✗ FAIL'}\n`);

  pool.close();
  console.log('✅ All tests completed');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
