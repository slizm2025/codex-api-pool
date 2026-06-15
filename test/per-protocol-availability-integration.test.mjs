#!/usr/bin/env node
// TDD: Per-protocol availability — integration with the live server.
//
// Drives the wiring of src/protocol-availability.mjs (currently dead code) into
// src/server.mjs so that availability is tracked separately per protocol
// (responses / chat_completions / anthropic_messages), per PROJECT_OBJECTIVES.md
// §4.3.4 and the headline §7.2 isolation scenario.
//
// These are HTTP integration tests: they boot a real pool with a mock upstream,
// send a real request, then assert on pool.state (exposed at server.mjs:14562).
// recordAvailability / chooseCandidate are NOT exported, so unit tests cannot
// prove the wiring — only a live request can.

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-pp-avail-'));

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

function anthropicUpstream(handler) {
  return http.createServer((req, res) => handler(req, res));
}

function anthropicSuccessBody() {
  return JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 }
  });
}

// ── Slice 1 (tracer bullet) ───────────────────────────────────────────────────
// After a successful /v1/messages request, the upstream's per-protocol
// availability window for anthropic_messages must be recorded.
await test('Slice 1: successful /v1/messages records by_protocol.anthropic_messages', async () => {
  const upstream = anthropicUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(anthropicSuccessBody());
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
      name: 'claude-upstream',
      base_url: upstreamInfo.url,
      api: 'anthropic',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'slice-1.json') });

  const poolInfo = await listen(pool);

  try {
    const response = await fetch(`${poolInfo.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
    });
    if (!response.ok) throw new Error(`request failed: HTTP ${response.status}`);

    const upstreamState = pool.state.upstreams[0];
    const byProtocol = upstreamState?.availability?.by_protocol;
    if (!byProtocol) {
      throw new Error('upstream.availability.by_protocol is not populated');
    }
    const messagesWindow = byProtocol.anthropic_messages;
    if (!messagesWindow || messagesWindow.total_count !== 1) {
      throw new Error(`expected by_protocol.anthropic_messages.total_count=1, got ${JSON.stringify(messagesWindow)}`);
    }
    if (messagesWindow.success_count !== 1) {
      throw new Error(`expected success_count=1, got ${messagesWindow.success_count}`);
    }
    if (upstreamState.availability.overall.total_count !== 1) {
      throw new Error(`expected overall.total_count=1, got ${upstreamState.availability.overall.total_count}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// ── Slice 2 (shared handler: /v1/chat/completions) ───────────────────────────
// After a successful /v1/chat/completions request, the upstream's per-protocol
// availability window for chat_completions must be recorded. This entry path
// falls through the shared handler (routeTrace.upstream_api === 'passthrough'),
// so the protocol must be derived from the entry pathname, not the route trace.
function chatSuccessBody() {
  return JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion',
    model: 'gpt-5.5',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
  });
}

await test('Slice 2: successful /v1/chat/completions records by_protocol.chat_completions', async () => {
  const upstream = anthropicUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(chatSuccessBody());
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
      name: 'gpt-upstream',
      base_url: upstreamInfo.url,
      api: 'openai',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'slice-2.json') });

  const poolInfo = await listen(pool);

  try {
    const response = await fetch(`${poolInfo.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'test' }] })
    });
    if (!response.ok) throw new Error(`request failed: HTTP ${response.status}`);

    const upstreamState = pool.state.upstreams[0];
    const byProtocol = upstreamState?.availability?.by_protocol;
    if (!byProtocol) {
      throw new Error('upstream.availability.by_protocol is not populated');
    }
    const chatWindow = byProtocol.chat_completions;
    if (!chatWindow || chatWindow.total_count !== 1) {
      throw new Error(`expected by_protocol.chat_completions.total_count=1, got ${JSON.stringify(chatWindow)}`);
    }
    if (chatWindow.success_count !== 1) {
      throw new Error(`expected success_count=1, got ${chatWindow.success_count}`);
    }
    if (upstreamState.availability.overall.total_count !== 1) {
      throw new Error(`expected overall.total_count=1, got ${upstreamState.availability.overall.total_count}`);
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
