#!/usr/bin/env node
// TDD: 重构保护测试 - 确保重构不破坏现有功能

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-refactor-'));

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

console.log('🔴 RED: 重构保护测试 - 记录当前行为\n');

// Test 1: Native forwarding behavior
await test('Native Messages forwarding preserves all behavior', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-custom': 'header' });
    res.end(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native response' }],
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    }));
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'test', base_url: upstreamInfo.url, api: 'anthropic', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'stats-1.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    const json = await result.json();

    if (result.status !== 200) throw new Error(`Expected 200, got ${result.status}`);
    if (json.type !== 'message') throw new Error(`Expected type=message, got ${json.type}`);
    if (!result.headers.get('x-custom')) throw new Error('Custom headers not preserved');
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 2: Adapter request conversion behavior
await test('Adapter path converts request correctly', async () => {
  let captured = null;

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'gpt-4',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      }));
    });
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
    compatibility: { adapter_mode: { adapters: { chat_completions: true } } },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'test', base_url: upstreamInfo.url, api: 'openai', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'stats-2.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    const json = await result.json();

    if (!captured) throw new Error('Request not captured');
    if (!captured.messages) throw new Error('Messages not converted');
    if (json.type !== 'message') throw new Error('Response not converted back');
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 3: Error handling behavior
await test('Error responses are handled correctly', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
    res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'test', base_url: upstreamInfo.url, api: 'anthropic', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'stats-3.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    if (result.status !== 429) throw new Error(`Expected 429, got ${result.status}`);
    if (!result.headers.get('retry-after')) throw new Error('retry-after header not preserved');
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 4: Streaming behavior
await test('Streaming responses work correctly', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\n');
    res.write('data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant"}}\n\n');
    res.write('event: content_block_start\n');
    res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    res.write('event: content_block_delta\n');
    res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
    res.write('event: message_stop\n');
    res.write('data: {"type":"message_stop"}\n\n');
    res.end();
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'test', base_url: upstreamInfo.url, api: 'anthropic', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'stats-4.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100, stream: true })
    });

    if (!result.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('Not streaming response');
    }

    const text = await result.text();
    if (!text.includes('message_start')) throw new Error('Stream events missing');
  } finally {
    await close(pool);
    await close(upstream);
  }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  console.log('\n❌ 某些行为测试失败 - 重构前需要修复');
  process.exit(1);
}

console.log('\n✅ 所有行为测试通过 - 可以安全重构！');
console.log('   这些测试将保护重构不破坏现有功能');
