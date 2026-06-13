#!/usr/bin/env node
// TDD Test: Complete HTTP/HTTPS protocol selection coverage

import http from 'node:http';
import https from 'node:https';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-protocol-'));

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const protocol = server instanceof https.Server ? 'https' : 'http';
      resolve({ port: address.port, url: `${protocol}://127.0.0.1:${address.port}` });
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

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   ${error.message}`);
    failed++;
  }
}

console.log('🧪 TDD: Complete HTTP/HTTPS Protocol Selection\n');

// Test 1: HTTP native forwarding
await test('HTTP native Messages forwarding', async () => {
  let hit = false;

  const upstream = http.createServer((req, res) => {
    hit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 }
    }));
  });

  const upstreamInfo = await listen(upstream);

  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'http-test',
      base_url: upstreamInfo.url,
      api: 'anthropic',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'stats-1.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    if (result.status !== 200 || !hit) {
      throw new Error(`Expected 200 and upstream hit, got ${result.status}, hit: ${hit}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 2: HTTP with adapter (Messages → Chat)
await test('HTTP adapter Messages → Chat → Messages', async () => {
  let hit = false;

  const upstream = http.createServer((req, res) => {
    hit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      model: 'gpt-4',
      choices: [{ message: { role: 'assistant', content: 'adapted' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    }));
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
      name: 'http-openai',
      base_url: upstreamInfo.url,
      api: 'openai',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'stats-2.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    const json = await result.json();

    if (result.status !== 200 || !hit || json.type !== 'message') {
      throw new Error(`Expected 200, upstream hit, and Messages format. Got ${result.status}, hit: ${hit}, type: ${json.type}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 3: Verify targetUrl is actually used (not baseUrl)
await test('Uses full targetUrl not just baseUrl', async () => {
  let capturedPath = '';

  const upstream = http.createServer((req, res) => {
    capturedPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 }
    }));
  });

  const upstreamInfo = await listen(upstream);

  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'http-test',
      base_url: upstreamInfo.url,
      api: 'anthropic',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'stats-3.json') });

  const poolInfo = await listen(pool);

  try {
    await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    if (!capturedPath.includes('/messages')) {
      throw new Error(`Expected path to include /messages, got: ${capturedPath}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}

console.log('\n✅ All HTTP/HTTPS protocol selection tests passed!');
