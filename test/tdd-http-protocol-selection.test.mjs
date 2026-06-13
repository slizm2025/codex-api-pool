#!/usr/bin/env node
// TDD Test: HTTP/HTTPS protocol selection for Messages endpoint

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-protocol-test-'));

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: address.port, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    setImmediate(() => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  });
}

process.env.TEST_POOL_TOKEN = 'test-token';
process.env.TEST_KEY = 'test-key';

console.log('🔴 RED: Test HTTP protocol selection\n');

// Test: HTTP upstream should work (not fail with HTTPS)
{
  let httpUpstreamHit = false;

  const httpUpstream = http.createServer((req, res) => {
    httpUpstreamHit = true;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_http_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'HTTP works' }],
        model: 'claude-opus-4-8',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 }
      }));
    });
  });

  const upstreamInfo = await listen(httpUpstream);
  console.log(`HTTP upstream listening on: ${upstreamInfo.url}`);

  const pool = createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
    retry: { max_attempts: 1 },
    upstreams: [
      {
        name: 'http-upstream',
        base_url: upstreamInfo.url,  // HTTP URL
        api: 'anthropic',
        weight: 1,
        keys: [{ env: 'TEST_KEY' }]
      }
    ]
  }, { statsPath: path.join(statsRoot, 'stats-http.json') });

  const poolInfo = await listen(pool);

  try {
    console.log('Sending request to pool...');
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'test http' }],
        max_tokens: 100
      })
    });

    const json = await result.json();
    console.log(`Status: ${result.status}`);
    console.log(`HTTP upstream hit: ${httpUpstreamHit}`);
    console.log(`Response: ${JSON.stringify(json).substring(0, 100)}`);

    if (result.status === 200 && httpUpstreamHit && json.type === 'message') {
      console.log('✅ PASS: HTTP upstream works correctly\n');
      process.exit(0);
    } else {
      console.log('❌ FAIL: HTTP upstream not working');
      console.log(`  Expected: 200 status with message response`);
      console.log(`  Got: ${result.status}, upstream hit: ${httpUpstreamHit}\n`);
      process.exit(1);
    }
  } catch (error) {
    console.log('❌ FAIL: Request failed with error');
    console.log(`  Error: ${error.message}`);
    console.log(`  This likely means the code is using https.request for http:// URLs\n`);
    process.exit(1);
  } finally {
    await close(pool);
    await close(httpUpstream);
  }
}
