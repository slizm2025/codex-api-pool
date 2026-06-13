#!/usr/bin/env node
// TDD Tests for Issue #3: Messages-only Features detection

import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-features-'));
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

// ============================================================================
// RED: Test 1 - Detect system-level cache_control
// ============================================================================
console.log('TEST 1: Detect system-level cache_control');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
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
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
        system: [
          { type: 'text', text: 'You are helpful', cache_control: { type: 'ephemeral' } }
        ]
      })
    });

    const json = await result.json();
    console.log(`  Status: ${result.status}`);
    console.log(`  Error type: ${json.error?.type}`);
    console.log(`  Message: ${json.error?.message?.substring(0, 100)}`);

    if (result.status === 422 &&
        json.type === 'error' &&
        json.error?.message?.toLowerCase().includes('cache_control')) {
      console.log('  ✓ PASS: Detected system cache_control\n');
    } else {
      console.log('  ✗ FAIL: Did not detect system cache_control\n');
    }
  } finally {
    await close(pool);
  }
}

// ============================================================================
// RED: Test 2 - Detect message-level cache_control
// ============================================================================
console.log('TEST 2: Detect message-level cache_control');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
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
            role: 'user',
            content: [
              { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }
            ]
          }
        ],
        max_tokens: 100
      })
    });

    const json = await result.json();

    if (result.status === 422 &&
        json.error?.message?.toLowerCase().includes('cache_control')) {
      console.log('  ✓ PASS: Detected message-level cache_control\n');
    } else {
      console.log('  ✗ FAIL: Did not detect message-level cache_control\n');
    }
  } finally {
    await close(pool);
  }
}

// ============================================================================
// RED: Test 3 - Detect thinking content blocks
// ============================================================================
console.log('TEST 3: Detect thinking content blocks');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
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
              { type: 'thinking', thinking: 'Let me think...' },
              { type: 'text', text: 'Answer' }
            ]
          }
        ],
        max_tokens: 100
      })
    });

    const json = await result.json();

    if (result.status === 422 &&
        json.error?.message?.toLowerCase().includes('thinking')) {
      console.log('  ✓ PASS: Detected thinking content block\n');
    } else {
      console.log('  ✗ FAIL: Did not detect thinking block\n');
    }
  } finally {
    await close(pool);
  }
}

// ============================================================================
// RED: Test 4 - Detect Computer Use tools
// ============================================================================
console.log('TEST 4: Detect Computer Use tools');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
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
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
        tools: [
          { type: 'computer_20241022', name: 'computer', display_width_px: 1024, display_height_px: 768 }
        ]
      })
    });

    const json = await result.json();

    if (result.status === 422 &&
        json.error?.message?.toLowerCase().includes('computer')) {
      console.log('  ✓ PASS: Detected Computer Use tool\n');
    } else {
      console.log('  ✗ FAIL: Did not detect Computer Use tool\n');
    }
  } finally {
    await close(pool);
  }
}

// ============================================================================
// RED: Test 5 - Allow request without Messages-only features
// ============================================================================
console.log('TEST 5: Allow request without Messages-only features');
{
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_clean',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'clean response' }],
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 }
    }));
  });

  const upstreamInfo = await listen(upstream);

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
        name: 'anthropic-test',
        base_url: upstreamInfo.url,
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
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100
      })
    });

    const json = await result.json();

    if (result.status === 200 && json.type === 'message') {
      console.log('  ✓ PASS: Allowed clean request\n');
    } else {
      console.log('  ✗ FAIL: Blocked clean request\n');
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
}

// ============================================================================
// RED: Test 6 - Lists detected features in error message
// ============================================================================
console.log('TEST 6: Lists detected features in error message');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
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
              { type: 'text', text: 'answer', cache_control: { type: 'ephemeral' } }
            ]
          }
        ],
        max_tokens: 100,
        tools: [
          { type: 'bash_20241022', name: 'bash' }
        ]
      })
    });

    const json = await result.json();
    const message = json.error?.message?.toLowerCase() || '';

    const hasThinking = message.includes('thinking');
    const hasCacheControl = message.includes('cache_control');
    const hasBash = message.includes('bash') || message.includes('computer use');

    if (result.status === 422 && hasThinking && hasCacheControl && hasBash) {
      console.log('  ✓ PASS: Error message lists all detected features\n');
    } else {
      console.log('  ✗ FAIL: Error message incomplete');
      console.log(`    Has thinking: ${hasThinking}, cache_control: ${hasCacheControl}, bash: ${hasBash}\n`);
    }
  } finally {
    await close(pool);
  }
}

console.log('✅ All Messages-only Features detection tests defined (RED phase)');
console.log('Next: Implement detection logic (GREEN phase)');
