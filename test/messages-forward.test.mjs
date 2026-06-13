#!/usr/bin/env node
// TDD Tests for Issue #2: Native Messages forwarding

import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-messages-forward-'));
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

function createFakeAnthropicUpstream(handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler({ req, res, body }));
  });
}

process.env.TEST_POOL_TOKEN = 'test-secret-token';
process.env.TEST_UPSTREAM_KEY = 'upstream-key';

// ============================================================================
// RED: Test 1 - Selection filters for Anthropic-capable upstreams
// ============================================================================
console.log('TEST 1: Selection filters for Anthropic-capable upstreams');
{
  const anthropicUpstream = createFakeAnthropicUpstream(({ req, res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Anthropic' }],
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    }));
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
        name: 'anthropic-upstream',
        base_url: anthropicInfo.url,
        api: 'anthropic',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      },
      {
        name: 'openai-upstream',
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
        max_tokens: 100
      })
    });

    const json = await result.json();
    console.log(`  Status: ${result.status}`);
    console.log(`  Response: ${JSON.stringify(json).substring(0, 100)}...`);

    if (result.status === 200 && json.type === 'message' && json.content) {
      console.log('  ✓ PASS: Selected Anthropic upstream\n');
    } else {
      console.log('  ✗ FAIL: Did not forward to Anthropic upstream\n');
    }
  } finally {
    await close(pool);
    await close(anthropicUpstream);
  }
}

// ============================================================================
// RED: Test 2 - Messages forward to upstream /v1/messages endpoint
// ============================================================================
console.log('TEST 2: Messages requests forward to upstream /v1/messages');
{
  let capturedRequest = null;

  const anthropicUpstream = createFakeAnthropicUpstream(({ req, res, body }) => {
    capturedRequest = { method: req.method, url: req.url, headers: req.headers, body };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    }));
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
        name: 'anthropic',
        base_url: anthropicInfo.url,
        api: 'anthropic',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });

  const poolInfo = await listen(pool);

  try {
    await fetch(`${poolInfo.url}/v1/messages`, {
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

    console.log(`  Upstream URL: ${capturedRequest?.url}`);
    console.log(`  Upstream method: ${capturedRequest?.method}`);

    if (capturedRequest?.url === '/v1/messages' && capturedRequest?.method === 'POST') {
      console.log('  ✓ PASS: Forwarded to /v1/messages endpoint\n');
    } else {
      console.log('  ✗ FAIL: Did not forward to correct endpoint\n');
    }
  } finally {
    await close(pool);
    await close(anthropicUpstream);
  }
}

// ============================================================================
// RED: Test 3 - Streaming SSE responses work end-to-end
// ============================================================================
console.log('TEST 3: Streaming SSE responses work end-to-end');
{
  const anthropicUpstream = createFakeAnthropicUpstream(({ req, res, body }) => {
    const payload = JSON.parse(body);
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\n');
      res.write('data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant"}}\n\n');
      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n');
      res.write('event: message_delta\n');
      res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', content: [] }));
    }
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
        name: 'anthropic',
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
        max_tokens: 100,
        stream: true
      })
    });

    const text = await result.text();
    console.log(`  Status: ${result.status}`);
    console.log(`  Content-Type: ${result.headers.get('content-type')}`);
    console.log(`  First 100 chars: ${text.substring(0, 100)}`);

    if (result.status === 200 &&
        result.headers.get('content-type')?.includes('text/event-stream') &&
        text.includes('message_start')) {
      console.log('  ✓ PASS: Streaming SSE works\n');
    } else {
      console.log('  ✗ FAIL: Streaming did not work correctly\n');
    }
  } finally {
    await close(pool);
    await close(anthropicUpstream);
  }
}

// ============================================================================
// RED: Test 4 - Model Override applies to Messages requests
// ============================================================================
console.log('TEST 4: Model Override applies to Messages requests');
{
  let capturedBody = null;

  const anthropicUpstream = createFakeAnthropicUpstream(({ req, res, body }) => {
    capturedBody = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
      model: capturedBody.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    }));
  });

  const anthropicInfo = await listen(anthropicUpstream);

  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN'
    },
    model_override: 'claude-sonnet-4-6',
    retry: { max_attempts: 1 },
    upstreams: [
      {
        name: 'anthropic',
        base_url: anthropicInfo.url,
        api: 'anthropic',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });

  const poolInfo = await listen(pool);

  try {
    await fetch(`${poolInfo.url}/v1/messages`, {
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

    console.log(`  Original model: claude-opus-4-8`);
    console.log(`  Forwarded model: ${capturedBody?.model}`);

    if (capturedBody?.model === 'claude-sonnet-4-6') {
      console.log('  ✓ PASS: Model Override applied\n');
    } else {
      console.log('  ✗ FAIL: Model Override not applied\n');
    }
  } finally {
    await close(pool);
    await close(anthropicUpstream);
  }
}

console.log('✅ All Messages forwarding tests defined (RED phase)');
console.log('Next: Implement native Messages forwarding logic (GREEN phase)');
