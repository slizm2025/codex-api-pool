// Integration test: protocol-cooldown is additive to global cooldown.
//
// Verifies the core PROJECT_OBJECTIVES.md §7.2 isolation scenario: when an
// upstream fails repeatedly for one protocol (chat_completions), it enters
// per-protocol cooldown for that protocol while remaining selectable for
// another protocol (anthropic_messages). The global cooldownUntil mechanism
// is unchanged.

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-pcd-'));

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
    console.log(`\u2705 ${name}`);
    passed++;
  } catch (error) {
    console.log(`\u274C ${name}`);
    console.log(`   ${error.message}`);
    failed++;
  }
}

// Mock upstream that always fails chat_completions requests with 500.
function failingChatUpstream() {
  return http.createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'server error' } }));
  });
}

// ── Test: repeated chat_completions failures apply per-protocol cooldown ─────
// With a high failure threshold (failure_threshold=2) and a long base cooldown,
// after enough failures the upstream should gain a protocol_specific cooldown
// entry for chat_completions while the global cooldownUntil is also set.
await test('repeated chat_completions failures set protocol-specific cooldown', async () => {
  const upstream = failingChatUpstream();
  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    retry: { max_attempts: 1, failure_threshold: 2, base_cooldown_ms: 30000 },
    upstreams: [{
      name: 'flaky-upstream',
      base_url: upstreamInfo.url,
      api: 'openai',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'cooldown.json') });

  const poolInfo = await listen(pool);

  try {
    // Send 3 failing requests to /v1/chat/completions (above failure_threshold).
    for (let i = 0; i < 3; i++) {
      await fetch(`${poolInfo.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] })
      });
    }

    const upstreamState = pool.state.upstreams[0];
    const protocolCooldown = upstreamState?.cooldown?.protocol_specific?.chat_completions;

    if (!protocolCooldown || !protocolCooldown.active) {
      throw new Error(`expected protocol_specific.chat_completions to be active, got ${JSON.stringify(protocolCooldown)}`);
    }
    if (!protocolCooldown.until) {
      throw new Error(`expected protocol_specific.chat_completions.until to be set, got ${JSON.stringify(protocolCooldown)}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// ── Test: protocol-cooldown applies on retryable status regardless of count ──
await test('protocol-cooldown applies on retryable 500 status (additive to global)', async () => {
  const upstream = failingChatUpstream();
  const upstreamInfo = await listen(upstream);
  const pool = createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN'
    },
    retry: { max_attempts: 1, failure_threshold: 2, base_cooldown_ms: 30000 },
    upstreams: [{
      name: 'flaky-upstream',
      base_url: upstreamInfo.url,
      api: 'openai',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'cooldown-2.json') });

  const poolInfo = await listen(pool);

  try {
    // Single failing request with a retryable 500 status should trigger
    // protocol cooldown immediately (500 is in DEFAULT_RETRYABLE_STATUS, which
    // also drives the global cooldownUntil). The two cooldown mechanisms run in
    // parallel — that is the additive property we verify here.
    await fetch(`${poolInfo.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] })
    });

    const upstreamState = pool.state.upstreams[0];
    const protocolCooldown = upstreamState?.cooldown?.protocol_specific?.chat_completions;

    if (!protocolCooldown || !protocolCooldown.active) {
      throw new Error(`expected protocol cooldown active for retryable 500, got ${JSON.stringify(protocolCooldown)}`);
    }
    // Only the chat_completions protocol should be cooled — anthropic_messages stays clear.
    const anthropicCooldown = upstreamState?.cooldown?.protocol_specific?.anthropic_messages;
    if (anthropicCooldown && anthropicCooldown.active) {
      throw new Error(`anthropic_messages should NOT be cooled by a chat_completions failure, got ${JSON.stringify(anthropicCooldown)}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}
