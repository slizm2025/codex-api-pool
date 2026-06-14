#!/usr/bin/env node

import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-model-suffix-'));
let statsIndex = 0;
let passed = 0;
let failed = 0;

process.env.TEST_POOL_TOKEN = 'test-token';
process.env.TEST_ADMIN_TOKEN = 'admin-token';
process.env.TEST_UPSTREAM_KEY = 'test-upstream-key';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({ port: address.port, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    setImmediate(() => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    server.close(done);
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`FAIL ${name}`);
    console.log(`  ${error.stack || error.message}`);
    failed += 1;
  }
}

function createPool(config) {
  statsIndex += 1;
  return createPoolServer(config, { statsPath: path.join(statsRoot, `stats-${statsIndex}.json`) });
}

function createAnthropicUpstream(handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler({ req, res, body }));
  });
}

function anthropicMessageResponse(model) {
  return {
    id: 'msg_suffix_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 }
  };
}

await test('Upstream Model Suffix is applied to outgoing body when Discovered Models are empty', async () => {
  let capturedBody = null;

  const upstream = createAnthropicUpstream(({ res, body }) => {
    capturedBody = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(anthropicMessageResponse(capturedBody.model)));
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'mint-claude',
      base_url: upstreamInfo.url,
      api: 'anthropic',
      model_suffix_strip: '-cc',
      keys: [{ env: 'TEST_UPSTREAM_KEY' }]
    }]
  });

  const poolInfo = await listen(pool);

  try {
    const response = await fetch(`${poolInfo.url}/v1/messages`, {
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

    if (response.status !== 200) {
      throw new Error(`expected request to succeed, got HTTP ${response.status}: ${await response.text()}`);
    }
    if (capturedBody?.model !== 'claude-opus-4-8-cc') {
      throw new Error(`expected upstream body model claude-opus-4-8-cc, got ${capturedBody?.model}`);
    }

    const statusResponse = await fetch(`${poolInfo.url}/pool/status`, {
      headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` }
    });
    const status = await statusResponse.json();
    const recent = status.recent_requests?.[0];
    if (recent?.actualModel !== 'claude-opus-4-8') {
      throw new Error(`expected Recent Request Timeline actualModel to stay standard, got ${recent?.actualModel}`);
    }
    if (recent?.route?.forwarded_model !== 'claude-opus-4-8-cc') {
      throw new Error(`expected route.forwarded_model claude-opus-4-8-cc, got ${recent?.route?.forwarded_model}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

await test('Discovered Models are normalized before status and Selection use them', async () => {
  let capturedBody = null;

  const upstream = createAnthropicUpstream(({ req, res, body }) => {
    if (req.url === '/v1/models' || req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'claude-opus-4-8-cc' },
          { id: 'claude-sonnet-4-6-cc' }
        ]
      }));
      return;
    }

    capturedBody = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(anthropicMessageResponse(capturedBody.model)));
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    model_override: 'claude-opus-4-8',
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'mint-claude',
      base_url: upstreamInfo.url,
      api: 'anthropic',
      health_path: '/v1/models',
      model_suffix_strip: '-cc',
      keys: [{ env: 'TEST_UPSTREAM_KEY' }]
    }]
  });

  const poolInfo = await listen(pool);

  try {
    const probeResponse = await fetch(`${poolInfo.url}/pool/probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` }
    });
    if (probeResponse.status !== 200) {
      throw new Error(`expected probe to succeed, got HTTP ${probeResponse.status}: ${await probeResponse.text()}`);
    }

    const statusResponse = await fetch(`${poolInfo.url}/pool/status`, {
      headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` }
    });
    const status = await statusResponse.json();
    const models = status.upstreams?.[0]?.health?.models || [];
    if (!models.includes('claude-opus-4-8') || !models.includes('claude-sonnet-4-6')) {
      throw new Error(`expected normalized models in status, got ${JSON.stringify(models)}`);
    }
    if (models.includes('claude-opus-4-8-cc')) {
      throw new Error(`expected suffix-specific model to be hidden from status, got ${JSON.stringify(models)}`);
    }

    const response = await fetch(`${poolInfo.url}/v1/messages`, {
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
    if (response.status !== 200) {
      throw new Error(`expected request to succeed, got HTTP ${response.status}: ${await response.text()}`);
    }
    if (capturedBody?.model !== 'claude-opus-4-8-cc') {
      throw new Error(`expected upstream body model claude-opus-4-8-cc, got ${capturedBody?.model}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

await test('Upstream Model Suffix append is idempotent for already suffixed requests', async () => {
  let capturedBody = null;

  const upstream = createAnthropicUpstream(({ res, body }) => {
    capturedBody = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(anthropicMessageResponse(capturedBody.model)));
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    retry: { max_attempts: 1 },
    upstreams: [{
      name: 'mint-claude',
      base_url: upstreamInfo.url,
      api: 'anthropic',
      model_suffix_strip: '-cc',
      keys: [{ env: 'TEST_UPSTREAM_KEY' }]
    }]
  });

  const poolInfo = await listen(pool);

  try {
    const response = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8-cc',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100
      })
    });

    if (response.status !== 200) {
      throw new Error(`expected request to succeed, got HTTP ${response.status}: ${await response.text()}`);
    }
    if (capturedBody?.model !== 'claude-opus-4-8-cc') {
      throw new Error(`expected upstream body model claude-opus-4-8-cc, got ${capturedBody?.model}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

await test('Management API preserves Upstream Model Suffix configuration', async () => {
  const upstream = createAnthropicUpstream(({ req, res, body }) => {
    if (req.url === '/v1/models' || req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-opus-4-8-cc' }] }));
      return;
    }
    const payload = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(anthropicMessageResponse(payload.model)));
  });

  const upstreamInfo = await listen(upstream);
  const pool = createPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    model_override: 'claude-opus-4-8',
    retry: { max_attempts: 1 },
    upstreams: []
  });

  const poolInfo = await listen(pool);

  try {
    const addResponse = await fetch(`${poolInfo.url}/pool/upstreams`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'mint-claude',
        base_url: upstreamInfo.url,
        api: 'anthropic',
        health_path: '/v1/models',
        model_suffix_strip: '-cc',
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      })
    });
    if (addResponse.status !== 201) {
      throw new Error(`expected upstream create to succeed, got HTTP ${addResponse.status}: ${await addResponse.text()}`);
    }

    const statusResponse = await fetch(`${poolInfo.url}/pool/status`, {
      headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` }
    });
    const status = await statusResponse.json();
    const added = status.upstreams?.find((item) => item.name === 'mint-claude');
    if (added?.model_suffix_strip !== '-cc') {
      throw new Error(`expected status model_suffix_strip -cc, got ${added?.model_suffix_strip}`);
    }
    if (!added?.health?.models?.includes('claude-opus-4-8')) {
      throw new Error(`expected normalized model after create probe, got ${JSON.stringify(added?.health?.models)}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
