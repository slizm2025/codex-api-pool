#!/usr/bin/env node
// Real-world scenario simulation for Codex API Pool.
//
// Spins up fake upstreams + the real pool, then drives the scenarios that matter
// for production stability (CORE_FEATURES.md §1-5, §15):
//   S1. Dual-client routing: Codex Desktop (/v1/responses) + Claude CLI (/v1/messages)
//       each routed to a native-protocol upstream.
//   S2. Failover: first upstream 500s -> request still succeeds via second upstream.
//   S3. Cooldown + recovery: upstream returns 429 repeatedly -> cooled down ->
//       falls back -> after cooldown, participates again.
//   S4. Adapter: Claude CLI request with only openai upstream + adapter mode ->
//       Messages -> Chat conversion succeeds; stripped features surface in header.
//   S5. Streaming: /v1/responses stream forwarded end-to-end (SSE preserved).
//   S6. No-upstream-available: returns a clear error (no 200 with empty body).
//
// Each scenario reports PASS/FAIL with evidence. Exits non-zero if any fail.

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-scenario-'));
let statsIndex = 0;

const scenarios = [];
function scenario(name, fn) { scenarios.push({ name, fn }); }
let passed = 0, failed = 0;

process.env.SCEN_POOL_TOKEN = 'pool-secret';
process.env.SCEN_ADMIN_TOKEN = 'admin-secret';
process.env.SCEN_KEY_A = 'key-a';
process.env.SCEN_KEY_B = 'key-b';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const a = server.address();
      resolve({ port: a.port, url: `http://127.0.0.1:${a.port}` });
    });
  });
}
function close(server) {
  return new Promise((resolve) => {
    setImmediate(() => { server.closeIdleConnections?.(); server.closeAllConnections?.(); });
    server.close(() => resolve());
  });
}
function nextStats() { statsIndex += 1; return path.join(statsRoot, `s-${statsIndex}.json`); }

// A programmable fake upstream that can route by path and return canned responses.
function createFakeUpstream({ name, responses = {}, models = ['gpt-5.5', 'claude-opus-4-8'] }) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const hit = { url: req.url, method: req.method, auth: req.headers.authorization || '', bodyLen: body.length };
      hits.push(hit);

      if (/\/models(\?|$)/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      if (/\/responses(\?|$)/.test(req.url) && responses.responses) {
        return sendCanned(res, responses.responses, hit);
      }
      if (/\/messages(\?|$)/.test(req.url) && responses.messages) {
        return sendCanned(res, responses.messages, hit);
      }
      if (/\/chat\/completions(\?|$)/.test(req.url) && responses.chat) {
        return sendCanned(res, responses.chat, hit);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  server.hits = hits;
  server.hitUrls = () => hits.map((h) => h.url);
  return server;
}

function sendCanned(res, canned, hit) {
  if (typeof canned === 'function') {
    const result = canned(hit) || {};
    res.writeHead(result.status || 200, { 'content-type': 'application/json', ...(result.headers || {}) });
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body || {}));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(typeof canned === 'string' ? canned : JSON.stringify(canned));
}

const authHeaders = { authorization: `Bearer ${process.env.SCEN_POOL_TOKEN}`, 'content-type': 'application/json' };
const adminHeaders = { authorization: `Bearer ${process.env.SCEN_ADMIN_TOKEN}` };

function baseConfig(upstreams) {
  return {
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'SCEN_POOL_TOKEN', admin_auth_token_env: 'SCEN_ADMIN_TOKEN' },
    health: { enabled: false },
    retry: { max_attempts: 4, failure_threshold: 2, base_cooldown_ms: 200, key_cooldown_ms: 200 },
    availability: { window_size: 50, min_samples: 2 },
    upstreams
  };
}

// ── S1: Dual-client routing ─────────────────────────────────────────────────
scenario('S1 dual-client: Codex Responses -> openai upstream, Claude Messages -> anthropic upstream', async () => {
  const openaiUp = createFakeUpstream({
    name: 'oai',
    responses: { responses: { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi from openai' }] }], status: 'completed', model: 'gpt-5.5', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } }
  });
  const anthropicUp = createFakeUpstream({
    name: 'ant',
    responses: { messages: { id: 'msg1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi from anthropic' }], model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } } }
  });
  const oaiInfo = await listen(openaiUp);
  const antInfo = await listen(anthropicUp);

  const pool = createPoolServer(baseConfig([
    { name: 'oai', base_url: `${oaiInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'SCEN_KEY_A' }] },
    { name: 'ant', base_url: `${antInfo.url}/v1`, api: 'anthropic', weight: 1, keys: [{ env: 'SCEN_KEY_B' }] }
  ]), { statsPath: nextStats() });
  const pi = await listen(pool);
  try {
    const resp = await fetch(`${pi.url}/v1/responses`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: 'gpt-5.5', input: 'hi' }) });
    const rj = await resp.json();
    assert(resp.status === 200, `responses status ${resp.status}: ${JSON.stringify(rj)}`);
    assert(resp.headers.get('x-codex-api-pool-upstream') === 'oai', `expected oai upstream, got ${resp.headers.get('x-codex-api-pool-upstream')}`);

    const msg = await fetch(`${pi.url}/v1/messages`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 }) });
    const mj = await msg.json();
    assert(msg.status === 200, `messages status ${msg.status}: ${JSON.stringify(mj)}`);
    assert(msg.headers.get('x-codex-api-pool-upstream') === 'ant', `expected ant upstream, got ${msg.headers.get('x-codex-api-pool-upstream')}`);

    return { evidence: `responses->${resp.headers.get('x-codex-api-pool-upstream')}, messages->${msg.headers.get('x-codex-api-pool-upstream')}` };
  } finally {
    await close(pool); await close(openaiUp); await close(anthropicUp);
  }
});

// ── S2: Failover on 500 ─────────────────────────────────────────────────────
scenario('S2 failover: upstream-A 500s -> request succeeds via upstream-B', async () => {
  let aCalls = 0;
  const upA = createFakeUpstream({ name: 'a', responses: { responses: () => { aCalls += 1; return { status: 500, body: { error: 'boom' } }; } } });
  const upB = createFakeUpstream({ name: 'b', responses: { responses: { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok-b' }] }], status: 'completed', model: 'gpt-5.5', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } });
  const aInfo = await listen(upA); const bInfo = await listen(upB);

  const pool = createPoolServer(baseConfig([
    { name: 'a', base_url: `${aInfo.url}/v1`, api: 'openai', weight: 5, keys: [{ env: 'SCEN_KEY_A' }] },
    { name: 'b', base_url: `${bInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'SCEN_KEY_B' }] }
  ]), { statsPath: nextStats() });
  const pi = await listen(pool);
  try {
    const resp = await fetch(`${pi.url}/v1/responses`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: 'gpt-5.5', input: 'hi' }) });
    const rj = await resp.json();
    assert(resp.status === 200, `expected 200 via failover, got ${resp.status}: ${JSON.stringify(rj)}`);
    assert(resp.headers.get('x-codex-api-pool-upstream') === 'b', `expected b after failover, got ${resp.headers.get('x-codex-api-pool-upstream')}`);
    return { evidence: `aCalls=${aCalls}, succeeded via b` };
  } finally {
    await close(pool); await close(upA); await close(upB);
  }
});

// ── S3: Cooldown + recovery ─────────────────────────────────────────────────
scenario('S3 cooldown: 429 cools the key -> fallback -> recovery after cooldown', async () => {
  let aStatus = 429;
  const upA = createFakeUpstream({ name: 'a', responses: { responses: () => ({ status: aStatus, headers: { 'retry-after': '0' }, body: aStatus === 429 ? { error: { type: 'rate_limit' } } : { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok-a' }] }], status: 'completed', model: 'gpt-5.5', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) } });
  const upB = createFakeUpstream({ name: 'b', responses: { responses: { id: 'r4', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok-b' }] }], status: 'completed', model: 'gpt-5.5', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } });
  const aInfo = await listen(upA); const bInfo = await listen(upB);

  const pool = createPoolServer({
    ...baseConfig([
      { name: 'a', base_url: `${aInfo.url}/v1`, api: 'openai', weight: 5, keys: [{ env: 'SCEN_KEY_A' }] },
      { name: 'b', base_url: `${bInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'SCEN_KEY_B' }] }
    ]),
    retry: { max_attempts: 4, failure_threshold: 2, base_cooldown_ms: 150, key_cooldown_ms: 150 }
  }, { statsPath: nextStats() });
  const pi = await listen(pool);
  try {
    const r1 = await fetch(`${pi.url}/v1/responses`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: 'gpt-5.5', input: 'hi' }) });
    assert(r1.status === 200, `first request should failover to b, got ${r1.status}`);
    assert(r1.headers.get('x-codex-api-pool-upstream') === 'b', `expected b, got ${r1.headers.get('x-codex-api-pool-upstream')}`);

    // Wait for a's cooldown to expire, then make a healthy again.
    await new Promise((resolve) => setTimeout(resolve, 350));
    aStatus = 200;
    const r2 = await fetch(`${pi.url}/v1/responses`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: 'gpt-5.5', input: 'hi' }) });
    assert(r2.status === 200, `second request should succeed, got ${r2.status}`);
    // a has weight 5 vs b weight 1, so after recovery a should be selectable again.
    // We can't guarantee a is picked on a single draw, but it must at least be eligible.
    const status = await (await fetch(`${pi.url}/pool/status`, { headers: adminHeaders })).json();
    const aUp = status.upstreams.find((u) => u.name === 'a');
    const aCooled = aUp?.cooldown_remaining_ms > 0;
    assert(!aCooled, `a should no longer be in cooldown after recovery, cooldown_remaining_ms=${aUp?.cooldown_remaining_ms}`);
    return { evidence: `failover worked; a cooldown_remaining_ms=${aUp?.cooldown_remaining_ms} after wait` };
  } finally {
    await close(pool); await close(upA); await close(upB);
  }
});

// ── S4: Adapter Messages->Chat ──────────────────────────────────────────────
scenario('S4 adapter: Claude Messages -> openai-only pool w/ adapter mode -> conversion + stripped header', async () => {
  const upA = createFakeUpstream({ name: 'oai', responses: { chat: { id: 'cc1', object: 'chat.completion', model: 'gpt-4', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } } } });
  const aInfo = await listen(upA);
  const pool = createPoolServer({
    ...baseConfig([{ name: 'oai', base_url: `${aInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'SCEN_KEY_A' }] }]),
    compatibility: { adapter_mode: { strip_messages_only_features: true, adapters: { chat_completions: true } } }
  }, { statsPath: nextStats() });
  const pi = await listen(pool);
  try {
    const msg = await fetch(`${pi.url}/v1/messages`, { method: 'POST', headers: authHeaders, body: JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
      max_tokens: 50
    }) });
    const mj = await msg.json();
    assert(msg.status === 200, `adapter messages status ${msg.status}: ${JSON.stringify(mj)}`);
    assert(mj.type === 'message', `expected message shape, got type=${mj.type}`);
    const stripped = msg.headers.get('x-codex-api-pool-stripped');
    assert(stripped && /cache_control/i.test(stripped), `expected stripped header naming cache_control, got: ${stripped}`);
    // The upstream must have received a chat/completions request.
    assert(upA.hitUrls().some((u) => /\/chat\/completions/.test(u)), `expected chat/completions hit on upstream, got: ${JSON.stringify(upA.hitUrls())}`);
    return { evidence: `adapter ok, stripped header present, upstream hit /chat/completions` };
  } finally {
    await close(pool); await close(upA);
  }
});

// ── S5: Streaming ───────────────────────────────────────────────────────────
scenario('S5 streaming: /v1/responses stream forwarded end-to-end', async () => {
  const sseBody = [
    'event: response.output_text.delta\ndata: {"type":"output_text.delta","delta":"Hello"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"output_text.delta","delta":" world"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}\n\n'
  ].join('');
  const upA = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(sseBody);
  });
  const aInfo = await listen(upA);
  const pool = createPoolServer(baseConfig([{ name: 'oai', base_url: `${aInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'SCEN_KEY_A' }] }]), { statsPath: nextStats() });
  const pi = await listen(pool);
  try {
    const resp = await fetch(`${pi.url}/v1/responses`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: 'gpt-5.5', input: 'hi', stream: true }) });
    assert(resp.status === 200, `stream status ${resp.status}`);
    assert((resp.headers.get('content-type') || '').includes('text/event-stream'), `expected SSE content-type, got ${resp.headers.get('content-type')}`);
    const text = await resp.text();
    assert(text.includes('Hello') && text.includes(' world'), `stream body incomplete: ${text.slice(0, 120)}`);
    assert(text.includes('response.completed'), `stream should include completion event`);
    return { evidence: `SSE forwarded, ${text.length} bytes` };
  } finally {
    await close(pool); await close(upA);
  }
});

// ── S6: No upstream available ───────────────────────────────────────────────
scenario('S6 no-upstream: returns clear error, no silent 200', async () => {
  const pool = createPoolServer(baseConfig([{ name: 'oai', base_url: 'http://127.0.0.1:1/v1', api: 'openai', weight: 1, keys: [{ env: 'SCEN_KEY_A' }], enabled: false }]), { statsPath: nextStats() });
  const pi = await listen(pool);
  try {
    const resp = await fetch(`${pi.url}/v1/responses`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ model: 'gpt-5.5', input: 'hi' }) });
    assert(resp.status >= 500 && resp.status < 600, `expected 5xx when no upstream, got ${resp.status}`);
    const text = await resp.text();
    assert(text.length > 0 && !text.includes('"output"'), `expected an error body, got: ${text.slice(0, 120)}`);
    return { evidence: `status ${resp.status}, clear error returned` };
  } finally {
    await close(pool);
  }
});

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── Run ─────────────────────────────────────────────────────────────────────
console.log('🧪 Real-world scenario simulation\n');
for (const { name, fn } of scenarios) {
  try {
    const result = await fn();
    passed++;
    console.log(`✓ ${name}${result?.evidence ? `  (${result.evidence})` : ''}`);
  } catch (error) {
    failed++;
    console.log(`✗ ${name}`);
    console.log(`  ${error.message}`);
  }
}
console.log(`\n${'='.repeat(60)}`);
console.log(`Scenarios: ${passed}/${scenarios.length} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
