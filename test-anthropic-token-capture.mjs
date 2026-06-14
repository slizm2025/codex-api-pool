#!/usr/bin/env node
// Test: Verify Anthropic Messages API token usage is captured correctly

import http from 'node:http';
import { spawn } from 'node:child_process';

const POOL_PORT = 8787;
const POOL_TOKEN = process.env.CODEX_POOL_API_KEY;

if (!POOL_TOKEN) {
  console.error('ERROR: CODEX_POOL_API_KEY not set');
  process.exit(1);
}

function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
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

async function getRecentRequests() {
  const result = await makeRequest({
    hostname: '127.0.0.1',
    port: POOL_PORT,
    path: '/pool/status',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${POOL_TOKEN}`
    }
  });

  const data = JSON.parse(result.body);
  return data.recent_requests || [];
}

async function testAnthropicTokenCapture() {
  console.log('Testing Anthropic token capture...\n');

  // Clear recent requests by making a simple health check
  console.log('1. Making a test request to Anthropic upstream...');

  const testResult = await makeRequest({
    hostname: '127.0.0.1',
    port: POOL_PORT,
    path: '/v1/responses',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POOL_TOKEN}`
    }
  }, {
    model: 'claude-opus-4-8',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Say "Hello" and nothing else.' }]
      }
    ]
  });

  console.log(`   Status: ${testResult.statusCode}`);

  if (testResult.statusCode !== 200) {
    console.error('   ERROR: Request failed');
    console.error('   Response:', testResult.body.substring(0, 500));
    process.exit(1);
  }

  const response = JSON.parse(testResult.body);
  console.log(`   Response ID: ${response.id}`);
  console.log(`   Usage in response: ${JSON.stringify(response.usage)}`);

  // Wait a moment for stats to be recorded
  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('\n2. Checking recent_requests...');
  const recentRequests = await getRecentRequests();

  if (recentRequests.length === 0) {
    console.error('   ERROR: No recent requests found');
    process.exit(1);
  }

  const lastRequest = recentRequests[0];
  console.log(`   Last request upstream: ${lastRequest.upstream}`);
  console.log(`   Status: ${lastRequest.status}`);
  console.log(`   Token count recorded:`);
  console.log(`     - tokens: ${lastRequest.tokens}`);
  console.log(`     - inputTokens: ${lastRequest.inputTokens}`);
  console.log(`     - outputTokens: ${lastRequest.outputTokens}`);

  // Verify
  if (lastRequest.tokens === 0 && lastRequest.inputTokens === 0 && lastRequest.outputTokens === 0) {
    console.error('\n   ❌ FAILURE: Token usage is 0 despite successful response');
    console.error('   Expected usage from response:', response.usage);
    process.exit(1);
  }

  if (response.usage) {
    const expectedInput = response.usage.input_tokens || 0;
    const expectedOutput = response.usage.output_tokens || 0;

    if (lastRequest.inputTokens !== expectedInput || lastRequest.outputTokens !== expectedOutput) {
      console.error('\n   ❌ FAILURE: Token counts do not match');
      console.error(`   Expected: in=${expectedInput}, out=${expectedOutput}`);
      console.error(`   Recorded: in=${lastRequest.inputTokens}, out=${lastRequest.outputTokens}`);
      process.exit(1);
    }
  }

  console.log('\n   ✅ SUCCESS: Token usage captured correctly');
}

testAnthropicTokenCapture().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
