#!/usr/bin/env node
// End-to-end integration test for Messages endpoint with adapters

import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-e2e-'));
let statsIndex = 0;

function createTestPool(config) {
  statsIndex += 1;
  return createPoolServer(config, { statsPath: path.join(statsRoot, `stats-${statsIndex}.json`) });
}

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

process.env.TEST_POOL_TOKEN = 'test-secret-token';
process.env.TEST_UPSTREAM_KEY = 'upstream-key';

console.log('🧪 End-to-End Integration Tests: Messages Endpoint with Adapters\n');

// ============================================================================
// Test 1: Native forwarding to Anthropic upstream
// ============================================================================
console.log('TEST 1: Native forwarding to Anthropic upstream');
{
  const anthropicUpstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_native',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Native response' }],
        model: payload.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 }
      }));
    });
  });

  const anthropicInfo = await listen(anthropicUpstream);

  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
    retry: { max_attempts: 1 },
    upstreams: [
      {
        name: 'anthropic-native',
        base_url: anthropicInfo.url,
        api: 'anthropic',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 100
      })
    });

    const json = await result.json();
    console.log(`  Status: ${result.status}`);
    console.log(`  Response type: ${json.type}`);
    console.log(`  Content: ${json.content?.[0]?.text}`);

    if (result.status === 200 && json.type === 'message' && json.content?.[0]?.text === 'Native response') {
      console.log('  ✓ PASS: Native forwarding works\n');
    } else {
      console.log('  ✗ FAIL: Native forwarding failed\n');
    }
  } finally {
    await close(pool);
    await close(anthropicUpstream);
  }
}

// ============================================================================
// Test 2: Adapter fallback to OpenAI upstream (JSON)
// ============================================================================
console.log('TEST 2: Adapter fallback to OpenAI upstream (JSON)');
{
  const openaiUpstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-adapted',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Adapted response from OpenAI'
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 }
      }));
    });
  });

  const openaiInfo = await listen(openaiUpstream);

  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
    compatibility: {
      adapter_mode: {
        strip_messages_only_features: true,
        adapters: {
          chat_completions: true
        }
      }
    },
    retry: { max_attempts: 1 },
    upstreams: [
      {
        name: 'openai-adapter',
        base_url: openaiInfo.url,
        api: 'openai',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test with adapter' }],
        max_tokens: 100
      })
    });

    const json = await result.json();
    console.log(`  Status: ${result.status}`);
    console.log(`  Response type: ${json.type}`);
    console.log(`  Response ID: ${json.id}`);
    console.log(`  Content: ${json.content?.[0]?.text?.substring(0, 50)}`);

    if (result.status === 200 &&
        json.type === 'message' &&
        json.id === 'msg_adapted' &&
        json.content?.[0]?.text?.includes('Adapted response from OpenAI')) {
      console.log('  ✓ PASS: Adapter conversion works (JSON)\n');
    } else {
      console.log('  ✗ FAIL: Adapter conversion failed\n');
      console.log(`  Full response: ${JSON.stringify(json, null, 2)}`);
    }
  } finally {
    await close(pool);
    await close(openaiUpstream);
  }
}

// ============================================================================
// Test 3: Messages-only features blocked without adapter
// ============================================================================
console.log('TEST 3: Messages-only features blocked without adapter');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
    retry: { max_attempts: 1 },
    upstreams: [
      {
        name: 'openai-only',
        base_url: 'http://127.0.0.1:9999',
        api: 'openai',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: 'answer' }
            ]
          }
        ],
        max_tokens: 100
      })
    });

    const json = await result.json();
    console.log(`  Status: ${result.status}`);
    console.log(`  Error type: ${json.error?.type}`);
    console.log(`  Message: ${json.error?.message?.substring(0, 80)}...`);

    if (result.status === 422 && json.error?.message?.includes('thinking')) {
      console.log('  ✓ PASS: Messages-only features correctly blocked\n');
    } else {
      console.log('  ✗ FAIL: Should have blocked thinking feature\n');
    }
  } finally {
    await close(pool);
  }
}

// ============================================================================
// Test 4: Messages-only features stripped with adapter enabled
// ============================================================================
console.log('TEST 4: Messages-only features stripped with adapter');
{
  let capturedRequest = null;

  const openaiUpstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedRequest = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-stripped',
        object: 'chat.completion',
        model: 'gpt-4',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      }));
    });
  });

  const openaiInfo = await listen(openaiUpstream);

  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
    compatibility: {
      adapter_mode: {
        strip_messages_only_features: true,
        adapters: { chat_completions: true }
      }
    },
    retry: { max_attempts: 1 },
    upstreams: [
      {
        name: 'openai',
        base_url: openaiInfo.url,
        api: 'openai',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });

  const poolInfo = await listen(pool);

  try {
    const result = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'should be stripped' },
              { type: 'text', text: 'visible text' }
            ]
          }
        ],
        max_tokens: 100,
        tools: [
          { type: 'computer_20241022', name: 'computer' },
          { name: 'get_weather', input_schema: { type: 'object' } }
        ]
      })
    });

    const json = await result.json();
    const chatMessages = capturedRequest?.messages || [];
    const hasThinking = JSON.stringify(chatMessages).includes('thinking');
    const tools = capturedRequest?.tools || [];

    console.log(`  Status: ${result.status}`);
    console.log(`  Thinking stripped: ${!hasThinking}`);
    console.log(`  Tools count: ${tools.length} (should be 1, Computer Use stripped)`);

    if (result.status === 200 && !hasThinking && tools.length === 1) {
      console.log('  ✓ PASS: Messages-only features correctly stripped\n');
    } else {
      console.log('  ✗ FAIL: Feature stripping failed\n');
    }
  } finally {
    await close(pool);
    await close(openaiUpstream);
  }
}

console.log('✅ All end-to-end integration tests completed!');
