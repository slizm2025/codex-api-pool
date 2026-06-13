#!/usr/bin/env node
// TDD: Dashboard 可观测性 - 后端 API 数据准备
// 测试 /pool/status 是否包含入口协议信息

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-dashboard-'));

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
process.env.TEST_ADMIN_TOKEN = 'admin-token';
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

console.log('🔴 RED: Dashboard 可观测性 API 测试\n');

// Test 1: Recent requests should include entry_protocol
await test('Recent requests include entry_protocol field', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test',
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
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'test',
      base_url: upstreamInfo.url,
      api: 'anthropic',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'stats-1.json') });

  const poolInfo = await listen(pool);

  try {
    // Send Messages request
    await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    // Check status endpoint
    const statusResult = await fetch(`${poolInfo.url}/pool/status`, {
      headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` }
    });

    const status = await statusResult.json();

    if (!status.recent_requests || status.recent_requests.length === 0) {
      throw new Error('No recent requests recorded');
    }

    const request = status.recent_requests[0];
    if (!request.entry_protocol) {
      throw new Error('entry_protocol field missing');
    }
    if (request.entry_protocol !== 'messages') {
      throw new Error(`Expected entry_protocol='messages', got '${request.entry_protocol}'`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 2: Responses entry should have entry_protocol='responses'
await test('Responses requests have entry_protocol=responses', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_test',
      output: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 }
    }));
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'test',
      base_url: upstreamInfo.url,
      api: 'openai',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'stats-2.json') });

  const poolInfo = await listen(pool);

  try {
    // Send Responses request
    await fetch(`${poolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: [{ type: 'input_text', text: 'test' }],
        response: { modalities: ['text'], instructions: 'reply' }
      })
    });

    // Check status endpoint
    const statusResult = await fetch(`${poolInfo.url}/pool/status`, {
      headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` }
    });

    const status = await statusResult.json();

    if (!status.recent_requests || status.recent_requests.length === 0) {
      throw new Error('No recent requests recorded');
    }

    const request = status.recent_requests[0];
    if (request.entry_protocol !== 'responses') {
      throw new Error(`Expected entry_protocol='responses', got '${request.entry_protocol}'`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 3: Adapter path should include routing_strategy
await test('Adapter path includes routing_strategy', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'gpt-4',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    }));
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    compatibility: {
      adapter_mode: {
        strip_messages_only_features: true,
        adapters: { chat_completions: true }
      }
    },
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'test',
      base_url: upstreamInfo.url,
      api: 'openai',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'stats-3.json') });

  const poolInfo = await listen(pool);

  try {
    // Send Messages request with adapter
    await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    // Check status endpoint
    const statusResult = await fetch(`${poolInfo.url}/pool/status`, {
      headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` }
    });

    const status = await statusResult.json();

    if (!status.recent_requests || status.recent_requests.length === 0) {
      throw new Error('No recent requests recorded');
    }

    const request = status.recent_requests[0];
    if (!request.routing_strategy) {
      throw new Error('routing_strategy field missing');
    }
    if (!request.routing_strategy.includes('messages') || !request.routing_strategy.includes('chat')) {
      throw new Error(`Expected routing_strategy to mention messages→chat, got '${request.routing_strategy}'`);
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
  console.log('\n❌ 有测试失败 - 需要实现后端支持');
  process.exit(1);
}

console.log('\n✅ 所有 Dashboard API 测试通过！');
