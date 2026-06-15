#!/usr/bin/env node
// Characterization tests for probeOneUpstream behavior.
//
// These lock in the OBSERVABLE behavior of the health probe (state, resolved
// request mode, protocol capabilities, quota, cooldown reset) BEFORE refactoring
// the internals to use ProtocolProbeOrchestrator for planning + execution.
//
// Tests drive the real code path through the /pool/upstreams/:name/probe
// management endpoint against a local fake upstream, so they survive the
// internal refactor — they describe WHAT the probe concludes, not HOW.

import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-probe-char-'));
let statsIndex = 0;

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  return Promise.resolve()
    .then(fn)
    .then(
      () => { passCount++; console.log(`✓ ${name}`); },
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

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
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

// ── Fake upstream ────────────────────────────────────────────────────────────
// Routes by URL suffix so it is robust to exact path-joining. Each endpoint
// handler returns { status, body, headers }. Records which paths were hit.

function createFakeUpstream(handlers = {}) {
  const hits = [];
  const defaults = {
    models: () => ({ status: 200, body: JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'claude-opus-4-8' }] }) }),
    responses: () => ({ status: 200, body: JSON.stringify({ output_text: 'pong' }) }),
    chat: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }) }),
    messages: () => ({ status: 200, body: JSON.stringify({ content: [{ type: 'text', text: 'pong' }] }) })
  };
  const pick = (url) => {
    if (/\/models(\?|$)/.test(url)) return 'models';
    if (/\/chat\/completions(\?|$)/.test(url)) return 'chat';
    if (/\/responses(\?|$)/.test(url)) return 'responses';
    if (/\/messages(\?|$)/.test(url)) return 'messages';
    return null;
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const kind = pick(req.url);
      hits.push({ kind, url: req.url, method: req.method });
      const handler = handlers[kind] || defaults[kind];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const { status = 200, body: respBody = '', headers = {} } = handler({ body, req });
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof respBody === 'string' ? respBody : JSON.stringify(respBody));
    });
  });
  server.hits = hits;
  server.hitKinds = () => hits.map((h) => h.kind);
  return server;
}

process.env.CHAR_POOL_TOKEN = 'char-pool-token';
process.env.CHAR_UPSTREAM_KEY = 'char-upstream-key';

function createPool(upstreamUrl, overrides = {}) {
  statsIndex += 1;
  const config = {
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'CHAR_POOL_TOKEN' },
    model_override: 'gpt-5.5',
    health: { timeout_ms: 3000 },
    retry: { max_attempts: 1 },
    upstreams: [
      {
        name: 'fake',
        base_url: `${upstreamUrl}/v1`,
        api: 'openai',
        weight: 1,
        keys: [{ env: 'CHAR_UPSTREAM_KEY' }],
        ...(overrides.upstream || {})
      }
    ],
    ...(overrides.config || {})
  };
  return createPoolServer(config, { statsPath: path.join(statsRoot, `stats-${statsIndex}.json`) });
}

const authHeaders = { authorization: `Bearer ${process.env.CHAR_POOL_TOKEN}`, 'content-type': 'application/json' };

async function probeUpstream(poolUrl, name = 'fake') {
  const res = await fetch(`${poolUrl}/pool/upstreams/${name}/probe`, { method: 'POST', headers: authHeaders, body: '{}' });
  return res.json();
}

async function statusUpstream(poolUrl, name = 'fake') {
  const res = await fetch(`${poolUrl}/pool/status`, { headers: authHeaders });
  const json = await res.json();
  return (json.upstreams || []).find((u) => u.name === name);
}

// ══════════════════════════════════════════════════════════════════════════════
// Run tests sequentially (shared fake-upstream ports, deterministic output)
// ══════════════════════════════════════════════════════════════════════════════

console.log('🧪 probeOneUpstream characterization tests\n');

// ── CT1: responses success → ok, resolved to responses, capability supported ──
await test('responses 200 → health ok, resolved_request_mode=responses, responses capability supported', async () => {
  const upstream = createFakeUpstream();
  const up = await listen(upstream);
  const pool = createPool(up.url);
  const poolInfo = await listen(pool);
  try {
    const probe = await probeUpstream(poolInfo.url);
    assertEquals(probe.health.state, 'ok', 'health state');
    assert(!probe.health.warning, `expected no warning, got: ${probe.health.warning}`);

    const view = await statusUpstream(poolInfo.url);
    assertEquals(view.resolved_request_mode, 'responses', 'resolved_request_mode');
    assertEquals(view.capabilities.responses.status, 'supported', 'responses capability');
    // responses succeeded → chat must NOT have been probed
    assert(!upstream.hitKinds().includes('chat'), `chat should not be probed, hits: ${upstream.hitKinds().join(',')}`);
  } finally {
    await close(pool);
    await close(upstream);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(80));
console.log(`Test Results: ${passCount}/${testCount} passed, ${failCount} failed`);
console.log('═'.repeat(80));
process.exit(failCount > 0 ? 1 : 0);

