#!/usr/bin/env node
// Debug: Check what's being captured

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
  console.log('Sending request...\n');

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
        content: [{ type: 'input_text', text: 'Count to 3.' }]
      }
    ]
  });

  const response = JSON.parse(result.body);
  console.log('Full response:');
  console.log(JSON.stringify(response, null, 2));
}

debug().catch(console.error);
