#!/usr/bin/env node
// Debug: Check actual Anthropic response usage

import http from 'node:http';

const POOL_PORT = 8787;
const POOL_TOKEN = process.env.CODEX_POOL_API_KEY;

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

async function debug() {
  console.log('Checking Anthropic response usage structure...\n');

  const result = await makeRequest({
    hostname: '127.0.0.1',
    port: POOL_PORT,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POOL_TOKEN}`,
      'anthropic-version': '2023-06-01'
    }
  }, {
    model: 'claude-opus-4-8',
    max_tokens: 50,
    messages: [
      {
        role: 'user',
        content: 'Say "test".'
      }
    ]
  });

  if (result.statusCode !== 200) {
    console.error('Request failed:', result.body);
    process.exit(1);
  }

  const response = JSON.parse(result.body);
  console.log('Full usage object:');
  console.log(JSON.stringify(response.usage, null, 2));

  console.log('\nBreakdown:');
  console.log(`  input_tokens: ${response.usage.input_tokens || 0}`);
  console.log(`  cache_creation_input_tokens: ${response.usage.cache_creation_input_tokens || 0}`);
  console.log(`  cache_read_input_tokens: ${response.usage.cache_read_input_tokens || 0}`);
  console.log(`  output_tokens: ${response.usage.output_tokens || 0}`);
}

debug().catch(console.error);
