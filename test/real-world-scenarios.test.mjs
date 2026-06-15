// Real-world scenario simulation for Codex API Pool.
//
// These tests exercise the INTEGRATED behavior of multiple CORE_FEATURES working
// together, against fake upstreams that mimic real provider behavior. They cover
// the common production scenarios a real deployment hits:
//
//   S1  Dual-client routing: Codex /v1/responses → openai upstream;
//       Claude /v1/messages → anthropic upstream (Feature §1, §2)
//   S2  Native protocol priority: verified-capable upstream preferred over
//       weight when entry protocol matches (Feature §1, §2)
//   S3  Failover + Fallback: first upstream 500s → retry switches upstream
//       (Feature §4)
//   S4  Cooldown: repeated failures cool an upstream, routing shifts away,
//       recovers after expiry (Feature §4, §8)
//   S5  Key-level failover on 429: key1 rate-limited → key2 used, key1 cooled
//       (Feature §8)
//   S6  Streaming Boundary: once 200+stream starts, no mid-stream retry
//       (Feature §4)
//   S7  Messages→Chat adapter with diagnostics: Claude model, no anthropic
//       upstream, adapter on → conversion + stripped header visible (Feature §3)
//   S8  Availability scoring: high-success upstream preferred over low-success
//       despite lower weight (Feature §5)
//   S9  Debug Lock bypasses selection and tries protocol sequence (Feature §11)
//   S10 Management API hot-reload: add upstream, immediate use, no restart
//       (Feature §9)
//
// Each scenario reports PASS/FAIL with evidence. Aggregate result gates exit code.

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-rws-'));
let statsIndex = 0;
const originalMathRandom = Math.random;

process.env.RWS_POOL_TOKEN = 'pool-secret';
process.env.RWS_ADMIN_TOKEN = 'admin-secret';
process.env.RWS_KEY_1 = 'key-1';
process.env.RWS_KEY_2 = 'key-2';

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    const t = setTimeout(finish, 1500);
    setImmediate(() => { server.closeIdleConnections?.(); server.closeAllConnections?.(); });
    server.close(finish);
  });
}

// A configurable fake upstream. `behavior(kind)` returns {status, body, headers}.
// Records every hit: { url, key, attempt }.
function createFakeUpstream(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers['authorization'] || '';
      const key = auth.replace(/^Bearer\s+/i, '');
      const hit = { url: req.url, method: req.method, key, body: Buffer.concat(chunks).toString('utf8') };
      hits.push(hit);
      const resp = handler ? handler(hit, res) : null;
      if (!resp) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no handler' }));
        return;
      }
      const { status = 200, headers = {}, body = '', stream = false } = resp;
      const baseHeaders = { 'content-type': 'application/json', ...headers };
      res.writeHead(status, baseHeaders);
      if (stream) {
        const events = Array.isArray(stream) ? stream : [stream];
        events.forEach((ev, i) => {
          setTimeout(() => {
            res.write(typeof ev === 'string' ? ev : `data: ${JSON.stringify(ev)}\n\n`);
            if (i === events.length - 1) {
              if (!resp.endWithoutDone) res.write('data: [DONE]\n\n');
              res.end();
            }
          }, 10 * (i + 1));
        });
      } else {
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      }
    });
  });
  server.hits = hits;
  return server;
}

const POOL_HEADERS = { authorization: `Bearer ${process.env.RWS_POOL_TOKEN}`, 'content-type': 'application/json' };
const ADMIN_HEADERS = { authorization: `Bearer ${process.env.RWS_ADMIN_TOKEN}`, 'content-type': 'application/json' };

const responsesOk = { id: 'resp_ok', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], status: 'completed', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
const chatOk = { id: 'cc_ok', object: 'chat.completion', model: 'gpt-4', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
const messagesOk = { id: 'msg_ok', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } };

function nextStatsPath() { statsIndex += 1; return path.join(statsRoot, `s-${statsIndex}.json`); }

async function sendResponses(poolUrl, model = 'gpt-5.5') {
  return fetch(`${poolUrl}/v1/responses`, {
    method: 'POST', headers: POOL_HEADERS,
    body: JSON.stringify({ model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] })
  });
}
async function sendMessages(poolUrl, model = 'claude-opus-4-8') {
  return fetch(`${poolUrl}/v1/messages`, {
    method: 'POST', headers: POOL_HEADERS,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 })
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// S1: Dual-client routing
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS1: Dual-client routing (Codex→openai, Claude→anthropic)');
{
  const openaiUp = createFakeUpstream((hit) => /\/responses/.test(hit.url) ? { body: responsesOk } : null);
  const anthropicUp = createFakeUpstream((hit) => /\/messages/.test(hit.url) ? { body: messagesOk } : null);
  const openaiInfo = await listen(openaiUp);
  const anthropicInfo = await listen(anthropicUp);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [
      { name: 'openai-svc', base_url: `${openaiInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] },
      { name: 'anthropic-svc', base_url: `${anthropicInfo.url}/v1`, api: 'anthropic', weight: 1, keys: [{ env: 'RWS_KEY_1' }] }
    ]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    const r1 = await sendResponses(pi.url);
    const r2 = await sendMessages(pi.url);
    record('Codex /v1/responses → 200', r1.status === 200, `status ${r1.status}`);
    record('Claude /v1/messages → 200', r2.status === 200, `status ${r2.status}`);
    record('openai-svc got the responses request', openaiUp.hits.some(h => /\/responses/.test(h.url)), `${openaiUp.hits.length} hits`);
    record('anthropic-svc got the messages request', anthropicUp.hits.some(h => /\/messages/.test(h.url)), `${anthropicUp.hits.length} hits`);
    record('openai-svc did NOT get a messages request', !openaiUp.hits.some(h => /\/messages/.test(h.url)));
    record('anthropic-svc did NOT get a responses request', !anthropicUp.hits.some(h => /\/responses/.test(h.url)));
  } finally {
    await close(pool); await close(openaiUp); await close(anthropicUp);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// S2: Native protocol priority beats weight
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS2: Native protocol priority beats weight');
{
  const nativeLowWeight = createFakeUpstream((hit) => /\/responses/.test(hit.url) ? { body: responsesOk } : null);
  const assumedHighWeight = createFakeUpstream((hit) => /\/responses/.test(hit.url) ? { body: responsesOk } : null);
  const nativeInfo = await listen(nativeLowWeight);
  const assumedInfo = await listen(assumedHighWeight);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [
      { name: 'native-low-weight', base_url: `${nativeInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] },
      { name: 'assumed-high-weight', base_url: `${assumedInfo.url}/v1`, api: 'openai', weight: 100, keys: [{ env: 'RWS_KEY_1' }] }
    ]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    const native = pool.state.upstreams.find((u) => u.name === 'native-low-weight');
    native.capabilities.responses = {
      ...native.capabilities.responses,
      status: 'verified',
      source: 'real_traffic',
      representative: true,
      checked_at: new Date().toISOString(),
      model: 'gpt-5.5',
      http_status: 200,
      reason: 'seeded representative native responses evidence'
    };

    Math.random = () => 0.99;
    const r = await sendResponses(pi.url);
    const used = r.headers.get('x-codex-api-pool-upstream');
    record('Verified native Responses upstream served request', r.status === 200 && used === 'native-low-weight', `status=${r.status}, used=${used}`);
    record('Higher-weight assumed upstream was not selected', assumedHighWeight.hits.length === 0, `assumed hits=${assumedHighWeight.hits.length}`);
  } finally {
    Math.random = originalMathRandom;
    await close(pool); await close(nativeLowWeight); await close(assumedHighWeight);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// S3: Failover — first upstream 500s, retry switches to second
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS3: Failover + Fallback on 500');
{
  const order = [];
  const upA = createFakeUpstream((hit) => {
    order.push(`svc-a:${hit.url}`);
    return { status: 500, body: { error: 'boom' } };
  });
  const upB = createFakeUpstream((hit) => {
    order.push(`svc-b:${hit.url}`);
    return { body: responsesOk };
  });
  const aInfo = await listen(upA);
  const bInfo = await listen(upB);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    retry: { max_attempts: 4, failure_threshold: 5, base_cooldown_ms: 60000, key_cooldown_ms: 60000 },
    upstreams: [
      { name: 'svc-a', base_url: `${aInfo.url}/v1`, api: 'openai', weight: 10, keys: [{ env: 'RWS_KEY_1' }] },
      { name: 'svc-b', base_url: `${bInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] }
    ]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    Math.random = () => 0.01;
    const r = await sendResponses(pi.url);
    const used = r.headers.get('x-codex-api-pool-upstream');
    record('Request succeeded via fallback (200)', r.status === 200, `status ${r.status}, upstream=${used}`);
    record('Fallback reached svc-b', used === 'svc-b' || upB.hits.length > 0, `upstream header=${used}, b hits=${upB.hits.length}`);
    const firstA = order.findIndex((item) => item.startsWith('svc-a:'));
    const firstB = order.findIndex((item) => item.startsWith('svc-b:'));
    record('svc-a was attempted before svc-b fallback', firstA !== -1 && firstB !== -1 && firstA < firstB, `order=${order.join(' -> ')}`);
  } finally {
    Math.random = originalMathRandom;
    await close(pool); await close(upA); await close(upB);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// S4: Cooldown isolates a repeatedly-failing upstream, then recovers
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS4: Cooldown isolates failing upstream, then recovers');
{
  let svcADown = true;
  const upA = createFakeUpstream(() => svcADown ? { status: 500, body: { error: 'down' } } : { body: responsesOk });
  const upB = createFakeUpstream(() => ({ body: responsesOk }));
  const aInfo = await listen(upA);
  const bInfo = await listen(upB);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    retry: { max_attempts: 4, failure_threshold: 2, base_cooldown_ms: 200, key_cooldown_ms: 60000 },
    upstreams: [
      { name: 'svc-a', base_url: `${aInfo.url}/v1`, api: 'openai', weight: 10, keys: [{ env: 'RWS_KEY_1' }] },
      { name: 'svc-b', base_url: `${bInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] }
    ]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    const svcAState = pool.state.upstreams.find(u => u.name === 'svc-a');
    svcAState.capabilities.responses = {
      ...svcAState.capabilities.responses,
      status: 'verified',
      source: 'real_traffic',
      representative: true,
      checked_at: new Date().toISOString(),
      model: 'gpt-5.5',
      http_status: 200,
      reason: 'seeded pre-outage successful Responses traffic'
    };

    // Several requests: svc-a fails, gets cooled, traffic shifts to svc-b
    for (let i = 0; i < 4; i++) {
      await sendResponses(pi.url);
    }
    const bHitsDuringOutage = upB.hits.length;
    record('Traffic shifted to svc-b during outage', bHitsDuringOutage >= 3, `svc-b hits=${bHitsDuringOutage}`);

    // Wait for the actual recorded cooldown(s) to expire, then restore svc-a.
    const protocolCooldowns = Object.values(svcAState?.cooldown?.protocol_specific || {})
      .map((item) => Date.parse(item?.until || ''))
      .filter((value) => Number.isFinite(value));
    const cooldownUntil = Math.max(Number(svcAState?.cooldownUntil || 0), ...protocolCooldowns, Date.now());
    await new Promise(r => setTimeout(r, Math.max(400, cooldownUntil - Date.now() + 100)));
    svcADown = false;
    upA.hits.length = 0;
    // Send several requests; with svc-a healthy again and weight 10 vs 1, it should get traffic
    for (let i = 0; i < 8; i++) {
      Math.random = () => 0.05; // strongly favor highest score
      await sendResponses(pi.url);
    }
    record('svc-a recovered and resumed serving', upA.hits.length > 0, `svc-a post-recovery hits=${upA.hits.length}`);
  } finally {
    Math.random = originalMathRandom;
    await close(pool); await close(upA); await close(upB);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// S5: Key-level failover on 429
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS5: Key-level failover on 429');
{
  const up = createFakeUpstream((hit) => {
    if (hit.key === 'key-1') return { status: 429, headers: { 'retry-after': '60' }, body: { error: { type: 'rate_limit_error', message: 'rate limited' } } };
    return { body: responsesOk };
  });
  const upInfo = await listen(up);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    retry: { max_attempts: 4, failure_threshold: 5, base_cooldown_ms: 60000, key_cooldown_ms: 60000 },
    upstreams: [
      { name: 'rate-svc', base_url: `${upInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }, { env: 'RWS_KEY_2' }] }
    ]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    const r = await sendResponses(pi.url);
    record('Request succeeded via second key (200)', r.status === 200, `status ${r.status}`);
    const k1Hits = up.hits.filter(h => h.key === 'key-1').length;
    const k2Hits = up.hits.filter(h => h.key === 'key-2').length;
    record('key-1 was tried and rate-limited', k1Hits >= 1, `k1 hits=${k1Hits}`);
    record('key-2 served the retried request', k2Hits >= 1, `k2 hits=${k2Hits}`);
  } finally {
    await close(pool); await close(up);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// S6: Streaming Boundary — no retry once the response stream has started
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS6: Streaming Boundary prevents mid-stream retry');
{
  const streamSource = createFakeUpstream(() => ({
    stream: [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'
    ],
    endWithoutDone: true
  }));
  const fallback = createFakeUpstream(() => ({ body: responsesOk }));
  const sourceInfo = await listen(streamSource);
  const fallbackInfo = await listen(fallback);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    retry: { max_attempts: 4, failure_threshold: 5, base_cooldown_ms: 60000, key_cooldown_ms: 60000 },
    upstreams: [
      { name: 'stream-source', base_url: `${sourceInfo.url}/v1`, api: 'openai', weight: 10, keys: [{ env: 'RWS_KEY_1' }] },
      { name: 'fallback-after-stream', base_url: `${fallbackInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] }
    ]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    Math.random = () => 0.01;
    const r = await fetch(`${pi.url}/v1/responses`, {
      method: 'POST',
      headers: POOL_HEADERS,
      body: JSON.stringify({
        model: 'gpt-5.5',
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'stream' }] }]
      })
    });
    const text = await r.text();
    record('Streaming request returned initial upstream response', r.status === 200 && /partial/.test(text), `status=${r.status}, body=${text.slice(0, 80)}`);
    record('Fallback upstream was not called after stream start', fallback.hits.length === 0, `fallback hits=${fallback.hits.length}`);
  } finally {
    Math.random = originalMathRandom;
    await close(pool); await close(streamSource); await close(fallback);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// S7: Messages→Chat adapter with diagnostics
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS7: Messages→Chat adapter + diagnostics');
{
  const up = createFakeUpstream(() => ({ body: chatOk }));
  const upInfo = await listen(up);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    compatibility: { adapter_mode: { strip_messages_only_features: true, adapters: { chat_completions: true } } },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'chat-only', base_url: `${upInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] }]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    const r = await fetch(`${pi.url}/v1/messages`, {
      method: 'POST', headers: POOL_HEADERS,
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
        max_tokens: 100
      })
    });
    const text = await r.text();
    record('Adapter request succeeded (200)', r.status === 200, `status ${r.status}, body=${text.slice(0, 80)}`);
    record('Response is Messages-shaped', /"type":"message"/.test(text));
    record('x-codex-api-pool-stripped header present', Boolean(r.headers.get('x-codex-api-pool-stripped')));
    record('Stripped header names cache_control', /cache_control/i.test(r.headers.get('x-codex-api-pool-stripped') || ''));
    record('Upstream received a chat-completions request', up.hits.some(h => /\/chat\/completions/.test(h.url)), `${up.hits.length} hits`);

    const st = await (await fetch(`${pi.url}/pool/status`, { headers: ADMIN_HEADERS })).json();
    const rr = st.recent_requests?.[0];
    record('Timeline routing_strategy=messages_to_chat_completions', rr?.routing_strategy === 'messages_to_chat_completions', `got ${rr?.routing_strategy}`);
    record('Timeline records compatibility.stripped', Boolean(rr?.compatibility?.stripped));
  } finally {
    await close(pool); await close(up);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// S8: Availability scoring prefers high-success upstream
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS8: Availability scoring prefers high-success over weight');
{
  const upGood = createFakeUpstream(() => ({ body: responsesOk }));
  const upBad = createFakeUpstream(() => ({ status: 500, body: { error: 'down' } }));
  const goodInfo = await listen(upGood);
  const badInfo = await listen(upBad);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    model_override: 'gpt-5.5',
    availability: { window_size: 50, min_samples: 10 },
    retry: { max_attempts: 4, failure_threshold: 5, base_cooldown_ms: 60000, key_cooldown_ms: 60000 },
    upstreams: [
      { name: 'flaky-heavy', base_url: `${badInfo.url}/v1`, api: 'openai', weight: 10, keys: [{ env: 'RWS_KEY_1' }] },
      { name: 'stable-light', base_url: `${goodInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] }
    ]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    // Seed availability: flaky-heavy all failures, stable-light all success
    const flaky = pool.state.upstreams.find(u => u.name === 'flaky-heavy');
    const stable = pool.state.upstreams.find(u => u.name === 'stable-light');
    flaky.stats.availability.samples = Array(12).fill(0);
    stable.stats.availability.samples = Array(12).fill(1);
    // Force deterministic selection (pick the only viable winner deterministically)
    Math.random = () => 0.5;
    const r = await sendResponses(pi.url);
    const used = r.headers.get('x-codex-api-pool-upstream');
    record('Selected the high-availability upstream', used === 'stable-light', `used=${used}, status=${r.status}`);
    const st = await (await fetch(`${pi.url}/pool/status`, { headers: ADMIN_HEADERS })).json();
    const flakyView = st.upstreams.find(u => u.name === 'flaky-heavy');
    const stableView = st.upstreams.find(u => u.name === 'stable-light');
    record('flaky-heavy availability multiplier heavily reduced', flakyView.availability.multiplier < 0.5, `mult=${flakyView.availability.multiplier}`);
    record('stable-light availability multiplier boosted', stableView.availability.multiplier > 1, `mult=${stableView.availability.multiplier}`);
  } finally {
    Math.random = originalMathRandom;
    await close(pool); await close(upGood); await close(upBad);
  }
}

// S9: Debug Lock bypasses Selection
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS9: Debug Lock bypasses Selection');
{
  const normal = createFakeUpstream((hit) => /\/responses/.test(hit.url) ? { body: responsesOk } : null);
  const locked = createFakeUpstream((hit) => /\/responses/.test(hit.url) ? { body: responsesOk } : null);
  const normalInfo = await listen(normal);
  const lockedInfo = await listen(locked);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [
      { name: 'normal-heavy', base_url: `${normalInfo.url}/v1`, api: 'openai', weight: 100, keys: [{ env: 'RWS_KEY_1' }] },
      { name: 'locked-light', base_url: `${lockedInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] }
    ]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    const lockRes = await fetch(`${pi.url}/pool/upstreams/locked-light/debug-lock`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ respect_model_override: true })
    });
    const lockJson = await lockRes.json();
    record('Debug Lock enabled through Management API', lockRes.status === 200 && lockJson.debug_lock?.upstream === 'locked-light', `status=${lockRes.status}`);

    Math.random = () => 0.99;
    const r = await sendResponses(pi.url);
    const used = r.headers.get('x-debug-lock-upstream') || r.headers.get('x-codex-api-pool-upstream');
    record('Locked upstream served request despite lower weight', r.status === 200 && used === 'locked-light', `status=${r.status}, used=${used}`);
    record('Normal high-weight upstream was bypassed', normal.hits.length === 0, `normal hits=${normal.hits.length}`);
    record('Locked upstream received request', locked.hits.length === 1, `locked hits=${locked.hits.length}`);
  } finally {
    Math.random = originalMathRandom;
    await close(pool); await close(normal); await close(locked);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// S10: Management API hot-reload — add upstream, use immediately
// ══════════════════════════════════════════════════════════════════════════════
console.log('\nS10: Management API hot-reload (add upstream, immediate use)');
{
  const upInitial = createFakeUpstream(() => ({ body: responsesOk }));
  const initialInfo = await listen(upInitial);
  const upNew = createFakeUpstream(() => ({ body: responsesOk }));
  const newInfo = await listen(upNew);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'RWS_POOL_TOKEN', admin_auth_token_env: 'RWS_ADMIN_TOKEN' },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'initial', base_url: `${initialInfo.url}/v1`, api: 'openai', weight: 1, keys: [{ env: 'RWS_KEY_1' }] }]
  }, { statsPath: nextStatsPath() });
  const pi = await listen(pool);
  try {
    const addRes = await fetch(`${pi.url}/pool/upstreams`, {
      method: 'POST', headers: ADMIN_HEADERS,
      body: JSON.stringify({ name: 'added', base_url: `${newInfo.url}/v1`, api: 'openai', weight: 5, keys: [{ env: 'RWS_KEY_1' }] })
    });
    record('Add upstream via Management API → 201', addRes.status === 201, `status ${addRes.status}`);

    // Disable the initial upstream so only 'added' is selectable
    await fetch(`${pi.url}/pool/upstreams/initial/enabled`, { method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ enabled: false }) });

    const r = await sendResponses(pi.url);
    const used = r.headers.get('x-codex-api-pool-upstream');
    record('Newly-added upstream serves request immediately (no restart)', used === 'added' && r.status === 200, `status=${r.status}, used=${used}`);
  } finally {
    await close(pool); await close(upInitial); await close(upNew);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log(`Real-world scenarios: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('\n✅ All real-world scenarios passed — pool is stable for production use.');
process.exit(0);
