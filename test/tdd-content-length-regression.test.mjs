#!/usr/bin/env node
// TDD 回归测试: Content-Length header 必须在请求体转换后正确处理
// 这个测试保护我们修复的 bug 不再回归

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-content-length-'));

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

console.log('🛡️ TDD 回归测试: Content-Length 处理\n');

// Test 1: 转换后的请求体必须完整传递
await test('Converted request body is transmitted completely', async () => {
  let receivedBodyLength = 0;
  let receivedBodyComplete = false;

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      receivedBodyLength = body.length;
      try {
        JSON.parse(body.toString('utf8'));
        receivedBodyComplete = true;
      } catch {
        receivedBodyComplete = false;
      }
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
    compatibility: { adapter_mode: { strip_messages_only_features: true, adapters: { chat_completions: true } } },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'openai', base_url: upstreamInfo.url, api: 'openai', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'stats-1.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'test message' }], max_tokens: 100 })
    });

    if (!receivedBodyComplete) {
      throw new Error(`Body incomplete: received ${receivedBodyLength} bytes but JSON parse failed`);
    }
    if (result.status !== 200) {
      throw new Error(`Expected 200, got ${result.status}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 2: 较长请求体也必须完整传递（多个消息）
await test('Large request body with multiple messages transmitted completely', async () => {
  let receivedBodyComplete = false;
  let messageCount = 0;

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        receivedBodyComplete = true;
        messageCount = parsed.messages?.length || 0;
      } catch {
        receivedBodyComplete = false;
      }
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
    compatibility: { adapter_mode: { strip_messages_only_features: true, adapters: { chat_completions: true } } },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'openai', base_url: upstreamInfo.url, api: 'openai', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'stats-2.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'user', content: 'First message with some content' },
          { role: 'assistant', content: 'First response from assistant' },
          { role: 'user', content: 'Second message with more content here' }
        ],
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9
      })
    });

    if (!receivedBodyComplete) {
      throw new Error('Large body was truncated');
    }
    if (messageCount !== 3) {
      throw new Error(`Expected 3 messages, got ${messageCount}`);
    }
    if (result.status !== 200) {
      throw new Error(`Expected 200, got ${result.status}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// Test 3: 原生路径也必须正确处理 content-length
await test('Native path request body transmitted completely', async () => {
  let receivedBodyComplete = false;

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        JSON.parse(body.toString('utf8'));
        receivedBodyComplete = true;
      } catch {
        receivedBodyComplete = false;
      }
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
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'anthropic', base_url: upstreamInfo.url, api: 'anthropic', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'stats-3.json') });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });

    if (!receivedBodyComplete) {
      throw new Error('Native path body was truncated');
    }
    if (result.status !== 200) {
      throw new Error(`Expected 200, got ${result.status}`);
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

console.log('\n✅ Content-Length 回归测试全部通过!');
console.log('   保护了请求体转换后的完整传输');
