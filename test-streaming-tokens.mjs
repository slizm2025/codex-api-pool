#!/usr/bin/env node
// Test: Check if streaming responses capture tokens

import http from 'node:http';

const POOL_PORT = 8787;
const POOL_TOKEN = process.env.CODEX_POOL_API_KEY;

function makeStreamingRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
        process.stdout.write('.');
      });
      res.on('end', () => {
        console.log(' done');
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

async function makeRequest(options, body) {
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

async function testStreaming() {
  console.log('Testing streaming request...\n');

  const result = await makeStreamingRequest({
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
    stream: true,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Say hello.' }]
      }
    ]
  });

  console.log('\nChecking recent requests...');

  await new Promise(resolve => setTimeout(resolve, 200));

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
    console.error('ERROR: No recent requests');
    process.exit(1);
  }

  const lastRequest = recentRequests[0];
  console.log(`Upstream: ${lastRequest.upstream}`);
  console.log(`Status: ${lastRequest.status}`);
  console.log(`Duration: ${lastRequest.durationMs}ms`);
  console.log(`Tokens: ${lastRequest.tokens}`);
  console.log(`Input tokens: ${lastRequest.inputTokens}`);
  console.log(`Output tokens: ${lastRequest.outputTokens}`);

  if (lastRequest.tokens === 0 && lastRequest.inputTokens === 0 && lastRequest.outputTokens === 0) {
    console.error('\n❌ STREAMING REQUEST: Token usage is 0');
    process.exit(1);
  } else {
    console.log('\n✅ STREAMING REQUEST: Tokens captured');
  }
}

testStreaming().catch(console.error);
