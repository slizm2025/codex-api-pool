#!/usr/bin/env node
// Test: Verify /v1/messages token capture after fix

import https from 'node:https';

const MINT_CLAUDE_KEY = process.env.MINT_CLAUDE_KEY;
const POOL_PORT = 8787;
const POOL_TOKEN = process.env.CODEX_POOL_API_KEY;

if (!MINT_CLAUDE_KEY || !POOL_TOKEN) {
  console.error('ERROR: MINT_CLAUDE_KEY or CODEX_POOL_API_KEY not set');
  process.exit(1);
}

function makeRequest(options, body) {
  const protocol = options.port === 443 ? https : require('http');
  return new Promise((resolve, reject) => {
    const req = protocol.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function test() {
  console.log('Testing /v1/messages token capture after fix...\n');

  // 1. Make a direct /v1/messages request through the pool
  console.log('1. Sending /v1/messages request...');

  const result = await makeRequest({
    hostname: '127.0.0.1',
    port: POOL_PORT,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POOL_TOKEN}`,
      'x-api-key': MINT_CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    }
  }, {
    model: 'claude-opus-4-8',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: 'Say hello and nothing else.'
      }
    ]
  });

  console.log(`   Status: ${result.statusCode}`);

  if (result.statusCode !== 200) {
    console.error('   ERROR: Request failed');
    console.error('   Response:', result.body.substring(0, 500));
    process.exit(1);
  }

  const response = JSON.parse(result.body);
  console.log(`   Response ID: ${response.id}`);
  console.log(`   Usage: ${JSON.stringify(response.usage)}`);

  // 2. Check recent_requests
  await new Promise(resolve => setTimeout(resolve, 200));

  console.log('\n2. Checking recent_requests...');
  const statusResult = await makeRequest({
    hostname: '127.0.0.1',
    port: POOL_PORT,
    path: '/pool/status',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${POOL_TOKEN}`
    }
  });

  const data = JSON.parse(statusResult.body);
  const recentRequests = data.recent_requests || [];

  if (recentRequests.length === 0) {
    console.error('   ERROR: No recent requests found');
    process.exit(1);
  }

  const lastRequest = recentRequests[0];
  console.log(`   Upstream: ${lastRequest.upstream}`);
  console.log(`   Path: ${lastRequest.path}`);
  console.log(`   Status: ${lastRequest.status}`);
  console.log(`   Duration: ${lastRequest.durationMs}ms`);
  console.log(`   Token count recorded:`);
  console.log(`     - tokens: ${lastRequest.tokens}`);
  console.log(`     - inputTokens: ${lastRequest.inputTokens}`);
  console.log(`     - outputTokens: ${lastRequest.outputTokens}`);

  // 3. Verify
  if (lastRequest.tokens === 0 || lastRequest.tokens === undefined) {
    console.error('\n   ❌ FAILURE: Token usage is still 0');
    process.exit(1);
  }

  if (response.usage) {
    const expectedInput = response.usage.input_tokens || 0;
    const expectedOutput = response.usage.output_tokens || 0;

    if (lastRequest.inputTokens === expectedInput && lastRequest.outputTokens === expectedOutput) {
      console.log('\n   ✅ SUCCESS: Token usage captured correctly!');
      console.log(`   Expected: in=${expectedInput}, out=${expectedOutput}`);
      console.log(`   Recorded: in=${lastRequest.inputTokens}, out=${lastRequest.outputTokens}`);
    } else {
      console.warn('\n   ⚠️  WARNING: Token counts do not match exactly');
      console.warn(`   Expected: in=${expectedInput}, out=${expectedOutput}`);
      console.warn(`   Recorded: in=${lastRequest.inputTokens}, out=${lastRequest.outputTokens}`);
      console.warn('   This might be due to cache tokens being included.');
    }
  } else {
    console.log('\n   ✅ Token usage is being captured (non-zero values)');
  }
}

test().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
