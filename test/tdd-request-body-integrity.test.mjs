#!/usr/bin/env node
// TDD: 发现并修复请求体截断 bug

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-truncation-'));

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

console.log('🔴 RED: 测试请求体完整性\n');

// Test: Request body should be complete
{
  let receivedBody = null;
  let bodyComplete = false;

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const fullBody = Buffer.concat(chunks).toString('utf8');
      receivedBody = fullBody;

      try {
        const parsed = JSON.parse(fullBody);
        bodyComplete = true;

        // Echo back some info
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: parsed.model || 'unknown',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 }
        }));
      } catch (e) {
        console.log('❌ Upstream received incomplete JSON');
        console.log(`   Body length: ${fullBody.length}`);
        console.log(`   Body: ${fullBody}`);
        console.log(`   Error: ${e.message}`);

        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  });

  const upstreamInfo = await listen(upstream);

  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
    compatibility: {
      adapter_mode: {
        strip_messages_only_features: true,
        adapters: { chat_completions: true }
      }
    },
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'openai',
      base_url: upstreamInfo.url,
      api: 'openai',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'stats.json') });

  const poolInfo = await listen(pool);

  try {
    console.log('Sending Messages request to pool...');
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test message' }],
        max_tokens: 100
      })
    });

    console.log(`Pool response status: ${result.status}`);

    if (bodyComplete) {
      console.log('✅ PASS: Request body was complete');
      console.log(`   Body length: ${receivedBody.length} bytes`);
    } else {
      console.log('❌ FAIL: Request body was truncated');
      console.log(`   Received: ${receivedBody?.length || 0} bytes`);
      process.exit(1);
    }

    const json = await result.json();
    console.log(`Response type: ${json.type || json.object}`);

  } finally {
    await close(pool);
    await close(upstream);
  }
}

console.log('\n✅ Request body integrity test complete');
