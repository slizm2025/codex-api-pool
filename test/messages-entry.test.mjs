import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-messages-'));
let statsIndex = 0;

function createTestPool(config, options = {}) {
  statsIndex += 1;
  return createPoolServer(config, { statsPath: path.join(statsRoot, `stats-${statsIndex}.json`), ...options });
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, host, () => {
      server.off('error', onError);
      const address = server.address();
      resolve({ host, port: address.port, url: `http://${host}:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    setImmediate(() => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  });
}

async function postMessages(url, token, body) {
  const bodyString = JSON.stringify(body);
  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: bodyString
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { response, text, json };
}

async function postResponses(url, token, body) {
  const bodyString = JSON.stringify(body);
  const response = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: bodyString
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { response, text, json };
}

// Set up test environment
process.env.TEST_POOL_TOKEN = 'test-secret-token';
process.env.TEST_UPSTREAM_KEY = 'upstream-key';

// ============================================================================
// RED: Test 1 - Messages endpoint returns 401 for missing auth
// ============================================================================
console.log('TEST 1: Messages endpoint authentication - missing token');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    upstreams: []
  });

  const poolInfo = await listen(pool);
  try {
    const result = await postMessages(poolInfo.url, 'wrong-token', {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100
    });

    if (result.response.status !== 401) {
      throw new Error(`Expected 401 for invalid token, got ${result.response.status}: ${result.text}`);
    }

    // Verify Anthropic error format
    if (!result.json || result.json.type !== 'error') {
      throw new Error(`Expected Anthropic error format with type: "error", got: ${result.text}`);
    }

    if (!result.json.error || !result.json.error.type || !result.json.error.message) {
      throw new Error(`Expected Anthropic error format with error.type and error.message, got: ${result.text}`);
    }

    console.log('✓ Messages endpoint returns 401 with Anthropic error format for invalid token');
  } finally {
    await close(pool);
  }
}

// ============================================================================
// RED: Test 2 - Messages endpoint returns 400 for invalid JSON
// ============================================================================
console.log('\nTEST 2: Messages endpoint validation - invalid JSON');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    upstreams: []
  });

  const poolInfo = await listen(pool);
  try {
    const response = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
        'content-type': 'application/json'
      },
      body: 'not-valid-json'
    });

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    if (response.status !== 400) {
      throw new Error(`Expected 400 for invalid JSON, got ${response.status}: ${text}`);
    }

    if (!json || json.type !== 'error' || !json.error) {
      throw new Error(`Expected Anthropic error format, got: ${text}`);
    }

    console.log('✓ Messages endpoint returns 400 with Anthropic error format for invalid JSON');
  } finally {
    await close(pool);
  }
}

// ============================================================================
// RED: Test 3 - Messages endpoint returns 400 for missing required fields
// ============================================================================
console.log('\nTEST 3: Messages endpoint validation - missing required fields');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    upstreams: []
  });

  const poolInfo = await listen(pool);
  try {
    // Missing messages field
    const result1 = await postMessages(poolInfo.url, process.env.TEST_POOL_TOKEN, {
      model: 'claude-opus-4-8',
      max_tokens: 100
    });

    if (result1.response.status !== 400) {
      throw new Error(`Expected 400 for missing messages, got ${result1.response.status}: ${result1.text}`);
    }

    if (!result1.json || result1.json.type !== 'error') {
      throw new Error(`Expected Anthropic error format, got: ${result1.text}`);
    }

    // Missing max_tokens field
    const result2 = await postMessages(poolInfo.url, process.env.TEST_POOL_TOKEN, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hello' }]
    });

    if (result2.response.status !== 400) {
      throw new Error(`Expected 400 for missing max_tokens, got ${result2.response.status}: ${result2.text}`);
    }

    // Missing model field
    const result3 = await postMessages(poolInfo.url, process.env.TEST_POOL_TOKEN, {
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100
    });

    if (result3.response.status !== 400) {
      throw new Error(`Expected 400 for missing model, got ${result3.response.status}: ${result3.text}`);
    }

    console.log('✓ Messages endpoint validates required fields (model, messages, max_tokens)');
  } finally {
    await close(pool);
  }
}

// ============================================================================
// RED: Test 4 - Responses endpoint still returns OpenAI error format
// ============================================================================
console.log('\nTEST 4: Responses endpoint error format unchanged');
{
  const pool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    upstreams: []
  });

  const poolInfo = await listen(pool);
  try {
    const result = await postResponses(poolInfo.url, 'wrong-token', {
      model: 'gpt-5.5',
      input: 'hello',
      stream: false
    });

    if (result.response.status !== 401) {
      throw new Error(`Expected 401 for invalid token, got ${result.response.status}: ${result.text}`);
    }

    // Verify OpenAI error format (NOT Anthropic format)
    if (!result.json || !result.json.error || typeof result.json.error !== 'object') {
      throw new Error(`Expected OpenAI error format with nested error object, got: ${result.text}`);
    }

    if (result.json.type === 'error') {
      throw new Error(`Responses endpoint should NOT use Anthropic error format, got: ${result.text}`);
    }

    console.log('✓ Responses endpoint still returns OpenAI error format (not affected by Messages changes)');
  } finally {
    await close(pool);
  }
}

console.log('\n✅ All Messages entry infrastructure tests defined (RED phase)');
console.log('Next: Implement /v1/messages endpoint to make tests pass (GREEN phase)');
