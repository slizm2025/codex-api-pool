#!/usr/bin/env node
// Test: Check what headers Anthropic returns

import http from 'node:http';

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

async function testHeaders() {
  console.log('Testing Anthropic response headers...\n');

  const result = await makeRequest({
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
        content: [{ type: 'input_text', text: 'Say "Hello" only.' }]
      }
    ]
  });

  console.log('Response headers:');
  for (const [key, value] of Object.entries(result.headers)) {
    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('usage')) {
      console.log(`  ${key}: ${value}`);
    }
  }

  console.log('\nResponse body usage:');
  const response = JSON.parse(result.body);
  console.log(`  ${JSON.stringify(response.usage)}`);
}

testHeaders().catch(console.error);
