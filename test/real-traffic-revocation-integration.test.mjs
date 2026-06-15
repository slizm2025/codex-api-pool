#!/usr/bin/env node
// TDD (regression): real-traffic verification must be revoked on consecutive
// authoritative failures — INTEGRATION through the live server.
//
// Bug (screenshot): site LanLn (https://ai.venlacy.com/v1) showed quota
// 50/50 exhausted, every request returned `retry · 403 · 30s · 0 tok`, yet the
// dashboard kept it green "真实请求验证". Cause: the success path wrote
// capability.source='real_traffic' permanently, but the failure path never
// revoked it — the revokeRealTrafficVerification primitive existed but was
// never called from recordModelInteractionOutcome.
//
// These are HTTP integration tests: they boot a real pool with a mock upstream
// that first succeeds (→ proven_by_traffic) then returns 403 repeatedly, and
// assert on pool.state. This is the only seam that exercises the full
// recordRealTrafficFailure → revoke wiring.

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { deriveVerificationDetail, deriveVerificationTier } from '../src/verification-tier.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-revoke-int-'));

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

function responsesSuccessBody() {
  return JSON.stringify({
    id: 'resp_test',
    object: 'response',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 5, output_tokens: 2 }
  });
}

function responsesForbiddenBody() {
  return JSON.stringify({
    error: { message: 'You have no quota remaining', type: 'permission_denied' }
  });
}

// A mock upstream that succeeds N times, then returns 403 forever. This models
// a site that ran out of quota after a period of healthy real traffic.
function quotaExhaustingUpstream(successCount) {
  let hits = 0;
  return http.createServer((req, res) => {
    hits++;
    const shouldSucceed = hits <= successCount;
    if (shouldSucceed) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(responsesSuccessBody());
      return;
    }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(responsesForbiddenBody());
  });
}

async function postResponses(poolInfo) {
  return fetch(`${poolInfo.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5', input: 'test' })
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Slice 1: a proven_by_traffic site that exhausts quota (3 consecutive 403)
// must drop out of proven_by_traffic — its real_traffic evidence revoked.
// ══════════════════════════════════════════════════════════════════════════════
await test('quota-exhausted site drops from proven_by_traffic after 3 consecutive 403', async () => {
  // 1 success to establish real_traffic proof, then 403 forever.
  const upstream = quotaExhaustingUpstream(1);
  const upstreamInfo = await listen(upstream);

  const pool = createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN',
      request_timeout_ms: 5000
    },
    model_override: 'gpt-5.5',
    retry: {
      max_attempts: 1,       // one upstream attempt per request so 3 requests = 3 failures
      failure_threshold: 2,
      base_cooldown_ms: 100, // short cooldown so the site is reselectable each time
      key_cooldown_ms: 100
    },
    health: { enabled: false },
    upstreams: [{
      name: 'venlacy',
      base_url: upstreamInfo.url,
      api: 'openai',
      keys: [{ env: 'TEST_KEY' }]
    }]
  }, { statsPath: path.join(statsRoot, 'slice-1.json') });

  const poolInfo = await listen(pool);

  try {
    // ── Establish real_traffic verification (1 success) ──
    const r0 = await postResponses(poolInfo);
    if (!r0.ok) throw new Error(`setup success failed: HTTP ${r0.status}`);

    const upstreamState = pool.state.upstreams[0];
    if (deriveVerificationTier(upstreamState) !== 'proven_by_traffic') {
      throw new Error(`precondition: expected proven_by_traffic after success, got ${deriveVerificationTier(upstreamState)} (source=${upstreamState.capabilities?.responses?.source})`);
    }

    // ── Three consecutive 403 failures (quota exhausted, as in screenshot) ──
    // Cooldown is short (100ms) but the key is key-scoped for 403; to keep the
    // test deterministic we wait briefly between requests so the site is
    // reselected and the failure streak accumulates across requests.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 3; i++) {
      await postResponses(poolInfo); // each hits the 403 branch
      await sleep(150);
    }

    // ── Assert: real_traffic verification revoked ──
    const after = pool.state.upstreams[0];
    const capSource = after.capabilities?.responses?.source;
    const tier = deriveVerificationTier(after);

    if (capSource === 'real_traffic') {
      throw new Error(`FAIL: capability still real_traffic after 3x403 (status=${after.capabilities.responses.status}). The revoke primitive was never invoked from the failure path.`);
    }
    if (tier === 'proven_by_traffic') {
      throw new Error('FAIL: tier still proven_by_traffic — real_traffic evidence not revoked');
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Slice 2: a single success mid-streak must reset the failure counter, so that
// an intermittent failure does not prematurely revoke a healthy site.
// ══════════════════════════════════════════════════════════════════════════════
await test('a success between failures resets the streak (no premature revoke)', async () => {
  // Sequence: success, fail, success, fail, fail — only 2 consecutive at end.
  // Pattern over requests: 1(ok) then 403,200,403,403.
  const sequence = [200, 403, 200, 403, 403];
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    const code = sequence[hits++] ?? 403;
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(code === 200 ? responsesSuccessBody() : responsesForbiddenBody());
  });
  const upstreamInfo = await listen(upstream);

  const pool = createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN',
      request_timeout_ms: 5000
    },
    model_override: 'gpt-5.5',
    retry: { max_attempts: 1, failure_threshold: 2, base_cooldown_ms: 100, key_cooldown_ms: 100 },
    health: { enabled: false },
    upstreams: [{ name: 'flaky', base_url: upstreamInfo.url, api: 'openai', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'slice-2.json') });

  const poolInfo = await listen(pool);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    for (const _code of sequence) {
      await postResponses(poolInfo);
      await sleep(150);
    }

    const after = pool.state.upstreams[0];
    // Final streak was 2 (403,403) interrupted by a success → under threshold 3.
    // real_traffic proof from the mid success (200 at index 2) should stand.
    const capSource = after.capabilities?.responses?.source;
    const tier = deriveVerificationTier(after);
    if (tier !== 'proven_by_traffic') {
      throw new Error(`FAIL: streak not reset by mid success — tier=${tier}, source=${capSource}. Expected proven_by_traffic to survive.`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Slice 3: once revoked, the site falls back to real_pending (blue) in the
// dashboard detail — "剔除到等待验证，等待下一次验证" per the user's requirement.
// ══════════════════════════════════════════════════════════════════════════════
await test('after revoke the dashboard detail shows real_pending (blue, waiting for recheck)', async () => {
  const upstream = quotaExhaustingUpstream(1);
  const upstreamInfo = await listen(upstream);

  const pool = createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      admin_auth_token_env: 'TEST_ADMIN_TOKEN',
      request_timeout_ms: 5000
    },
    model_override: 'gpt-5.5',
    retry: { max_attempts: 1, failure_threshold: 2, base_cooldown_ms: 100, key_cooldown_ms: 100 },
    health: { enabled: false },
    upstreams: [{ name: 'venlacy2', base_url: upstreamInfo.url, api: 'openai', keys: [{ env: 'TEST_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 'slice-3.json') });

  const poolInfo = await listen(pool);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await postResponses(poolInfo); // establish proof
    for (let i = 0; i < 3; i++) {
      await postResponses(poolInfo); // exhaust quota
      await sleep(150);
    }

    const after = pool.state.upstreams[0];
    // Wait out any residual cooldown so the cooldown cascade doesn't mask the tier.
    await sleep(250);
    const detail = deriveVerificationDetail(after, { now: Date.now() });
    if (detail.tier !== 'real_pending') {
      throw new Error(`FAIL: expected real_pending (blue), got ${detail.tier} (${detail.label}). The revoked site should be '剔除到等待验证'.`);
    }
    if (detail.indicator !== 'blue') {
      throw new Error(`FAIL: expected blue indicator, got ${detail.indicator}`);
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
