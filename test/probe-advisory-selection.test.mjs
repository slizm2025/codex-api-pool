#!/usr/bin/env node
// TDD: Probe layer is advisory-only — probe results must NOT gate Selection.
//
// Goal (decoupling): Health Probes only do basic monitoring / dashboard display.
// They must NOT exclude an upstream from Selection. Only real Model Interaction
// Request outcomes may set cooldowns / failures / gate availability.
//
// Scenarios:
//   A. A 429/5xx probe result sets health.state but does NOT set cooldown and
//      does NOT make the upstream unavailable.
//   B. A models_unsupported probe result does NOT make the upstream unavailable.
//   C. (Regression guard) Real /v1/chat/completions traffic failures DO gate
//      the upstream via cooldown — real-traffic gating must remain intact.
//   D. A successful probe does NOT clear a cooldown that real traffic set.

import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-probe-advisory-'));
let statsIndex = 0;
let testCount = 0;
let passCount = 0;
let failCount = 0;

process.env.PA_POOL_TOKEN = 'pool-secret';
process.env.PA_UPSTREAM_KEY = 'upstream-secret';

function test(name, fn) {
  testCount++;
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        passCount++;
        console.log(`✓ ${name}`);
      },
      (error) => {
        failCount++;
        console.error(`✗ ${name}`);
        console.error(`  ${error.message}`);
      }
    );
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const { port } = server.address();
      resolve({ port, url: `http://127.0.0.1:${port}` });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A configurable fake upstream. All model endpoints (/responses AND
// /chat/completions) return probeStatus, so the probe's multi-protocol fallback
// cannot mask a failure by succeeding on another path. /v1/chat/completions can
// be set independently via chatStatus for the real-traffic regression test.
function createFakeUpstream({ probeStatus = 200, probeBody = null, chatStatus, models = ['gpt-5.5'] } = {}) {
  const effectiveChatStatus = chatStatus ?? probeStatus;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      const url = req.url;

      if (url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }

      if (url.endsWith('/chat/completions')) {
        if (effectiveChatStatus >= 200 && effectiveChatStatus < 400) {
          res.writeHead(effectiveChatStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chat_test',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            model: 'gpt-5.5',
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
          }));
          return;
        }
        res.writeHead(effectiveChatStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream failure', type: 'error' } }));
        return;
      }

      if (url.endsWith('/responses')) {
        if (probeStatus >= 200 && probeStatus < 400) {
          res.writeHead(probeStatus, { 'content-type': 'application/json' });
          res.end(probeBody || JSON.stringify({
            id: 'resp_test',
            object: 'response',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 5, output_tokens: 2 }
          }));
          return;
        }
        res.writeHead(probeStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'error' } }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  server.requests = requests;
  return server;
}

function createPool(upstreamUrl, upstreamExtra = {}, poolExtra = {}) {
  statsIndex++;
  return createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'PA_POOL_TOKEN',
      request_timeout_ms: 5000
    },
    model_override: 'gpt-5.5',
    retry: {
      max_attempts: 1,
      failure_threshold: 2,
      base_cooldown_ms: 30000,
      key_cooldown_ms: 30000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      {
        name: 'probe-target',
        base_url: `${upstreamUrl}/v1`,
        weight: 1,
        api: 'openai',
        keys: [{ env: 'PA_UPSTREAM_KEY' }],
        ...upstreamExtra
      }
    ],
    ...poolExtra
  }, { statsPath: path.join(statsRoot, `stats-${statsIndex}.json`) });
}

async function postJson(url, payload = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.PA_POOL_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { res, text, json };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${process.env.PA_POOL_TOKEN}` } });
  const text = await res.text();
  return { res, text, json: JSON.parse(text) };
}

function findUpstream(statusJson, name = 'probe-target') {
  return statusJson.upstreams.find((item) => item.name === name);
}

// ── Test A: a 429 probe result is advisory — no cooldown, still selectable ────
await test('Test A: 429 probe result keeps upstream available with no cooldown', async () => {
  const backend = createFakeUpstream({ probeStatus: 429 });
  const backendInfo = await listen(backend);
  const pool = createPool(backendInfo.url);
  const poolInfo = await listen(pool);
  try {
    const probe = await postJson(`${poolInfo.url}/pool/upstreams/probe-target/probe`);
    assert(probe.res.status === 200, `expected probe endpoint 200: ${probe.text}`);
    assert(probe.json.probe_ok === false, `expected probe_ok=false: ${probe.text}`);

    const status = await getJson(`${poolInfo.url}/pool/status`);
    const upstream = findUpstream(status.json);
    assert(upstream, `expected upstream in status: ${status.text}`);
    assert(upstream.available === true,
      `expected probe-target to remain available (advisory probe): ${JSON.stringify(upstream)}`);
    assert(upstream.cooldown_ms === 0,
      `expected NO cooldown from probe (only real traffic sets cooldown): ${JSON.stringify(upstream)}`);
    assert(upstream.selection_score > 0,
      `expected positive selection_score despite probe failure: ${JSON.stringify(upstream)}`);
  } finally {
    await close(pool);
    await close(backend);
  }
});

// ── Test B: models_unsupported probe result is advisory — still selectable ────
await test('Test B: models_unsupported probe keeps upstream available', async () => {
  // Upstream /models lists a model the override does NOT request → probe model
  // is unsupported on this upstream.
  const backend = createFakeUpstream({ probeStatus: 200, models: ['some-other-model'] });
  const backendInfo = await listen(backend);
  const pool = createPool(backendInfo.url);
  const poolInfo = await listen(pool);
  try {
    const probe = await postJson(`${poolInfo.url}/pool/upstreams/probe-target/probe`);
    assert(probe.res.status === 200, `expected probe endpoint 200: ${probe.text}`);

    const status = await getJson(`${poolInfo.url}/pool/status`);
    const upstream = findUpstream(status.json);
    assert(upstream, `expected upstream in status: ${status.text}`);
    assert(upstream.available === true,
      `expected probe-target to remain available despite models_unsupported probe: ${JSON.stringify(upstream)}`);
    assert(upstream.selection_score > 0,
      `expected positive selection_score: ${JSON.stringify(upstream)}`);
  } finally {
    await close(pool);
    await close(backend);
  }
});

// ── Test C: real traffic failures DO gate the upstream (regression guard) ─────
await test('Test C: real /v1/chat/completions failures gate the upstream via cooldown', async () => {
  const backend = createFakeUpstream({ chatStatus: 429 });
  const backendInfo = await listen(backend);
  const pool = createPool(backendInfo.url);
  const poolInfo = await listen(pool);
  try {
    // failure_threshold is 2; 429 is a retryable single-failure gate, so one
    // failing real request must cool the upstream.
    await postJson(`${poolInfo.url}/v1/chat/completions`, {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'x' }]
    });

    const status = await getJson(`${poolInfo.url}/pool/status`);
    const upstream = findUpstream(status.json);
    assert(upstream, `expected upstream in status: ${status.text}`);
    assert(upstream.available === false,
      `expected real-traffic 429 to make upstream unavailable: ${JSON.stringify(upstream)}`);
    assert(upstream.cooldown_ms > 0,
      `expected real-traffic 429 to set cooldown > 0: ${JSON.stringify(upstream)}`);
  } finally {
    await close(pool);
    await close(backend);
  }
});

// ── Test D: a successful probe does NOT clear a real-traffic cooldown ────────
await test('Test D: successful probe does not clear a real-traffic cooldown', async () => {
  // First backend fails real traffic so a cooldown is set.
  const failBackend = createFakeUpstream({ chatStatus: 429, probeStatus: 200 });
  const failInfo = await listen(failBackend);
  const statsPath = path.join(statsRoot, `cooldown-persist-${statsIndex}.json`);

  // Use a single pool so cooldown persists in its state, then re-probe on a
  // healthy backend by swapping the upstream base via direct state mutation.
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'PA_POOL_TOKEN', request_timeout_ms: 5000 },
    model_override: 'gpt-5.5',
    retry: { max_attempts: 1, failure_threshold: 2, base_cooldown_ms: 30000, key_cooldown_ms: 30000 },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [{ name: 'probe-target', base_url: `${failInfo.url}/v1`, weight: 1, api: 'openai', keys: [{ env: 'PA_UPSTREAM_KEY' }] }]
  }, { statsPath });
  const poolInfo = await listen(pool);
  try {
    // Drive a real failure → cooldown set.
    await postJson(`${poolInfo.url}/v1/chat/completions`, {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'x' }]
    });
    let status = await getJson(`${poolInfo.url}/pool/status`);
    let upstream = findUpstream(status.json);
    assert(upstream.cooldown_ms > 0,
      `expected real-traffic failure to set cooldown: ${JSON.stringify(upstream)}`);
    const cooldownBefore = upstream.cooldown_ms;

    // Now run a successful probe. Under the new advisory contract, a probe
    // (even successful) must NOT clear a cooldown produced by real traffic.
    const probe = await postJson(`${poolInfo.url}/pool/upstreams/probe-target/probe`);
    assert(probe.res.status === 200, `expected probe endpoint 200: ${probe.text}`);

    status = await getJson(`${poolInfo.url}/pool/status`);
    upstream = findUpstream(status.json);
    // Cooldown must still be active (the probe must not have cleared it). Allow
    // for a few ms of natural time decay, but require it to remain substantial
    // — a cleared cooldown would read ~0.
    assert(upstream.cooldown_ms > 25000,
      `expected probe success to NOT clear real-traffic cooldown: ${JSON.stringify({ cooldown_before: cooldownBefore, cooldown_after: upstream.cooldown_ms })}`);
    assert(upstream.available === false,
      `expected upstream to remain unavailable while real-traffic cooldown is active: ${JSON.stringify(upstream)}`);
  } finally {
    await close(pool);
    await close(failBackend);
  }
});

await sleep(0); // flush

console.log('\n' + '═'.repeat(80));
console.log(`Test Results: ${passCount}/${testCount} passed, ${failCount} failed`);
console.log('═'.repeat(80));
process.exit(failCount > 0 ? 1 : 0);
