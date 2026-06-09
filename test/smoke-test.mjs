import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';
import { resolveModelArg, summarizeStatus } from '../scripts/set-model.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-smoke-'));
let statsIndex = 0;

if (resolveModelArg('gpt') !== 'gpt-5.5' || resolveModelArg('claude') !== 'claude-opus-4-8' || resolveModelArg('off') !== '' || resolveModelArg('custom-model') !== 'custom-model') {
  throw new Error('expected model switch aliases to resolve');
}

const modelSwitchSummary = summarizeStatus({
  model: { override: 'claude-opus-4-8' },
  upstreams: [
    { available: true, health: { models: ['claude-opus-4-8'] } },
    { available: true, api: 'anthropic', health: { models: ['claude-opus-4-8'] } },
    { available: true, api: 'both', health: { models: ['claude-opus-4-8'] } },
    { available: true, health: { models: ['gpt-5.5'] } },
    { available: true, probe_auth: 'anthropic', health: { models: [] } },
    { available: false, health: { models: ['claude-opus-4-8'] } }
  ]
}, 'claude-opus-4-8');
if (modelSwitchSummary.override !== 'claude-opus-4-8' || modelSwitchSummary.availableCount !== 5 || modelSwitchSummary.matchingCount !== 3) {
  throw new Error(`expected model switch status summary to count available matching upstreams: ${JSON.stringify(modelSwitchSummary)}`);
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createFakeUpstream(name, handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler({ name, req, res, body }));
  });
}

async function requestJson(url, token) {
  const body = JSON.stringify({ model: 'test-model', input: 'hello', stream: false });
  const response = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body))
    },
    body
  });
  const text = await response.text();
  return { response, text, json: JSON.parse(text) };
}

async function postJson(url, token, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  return { response, text, json: JSON.parse(text) };
}

async function deleteJson(url, token) {
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  const text = await response.text();
  return { response, text, json: JSON.parse(text) };
}

async function getJson(url, token = '') {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  const text = await response.text();
  return { response, text, json: JSON.parse(text) };
}

async function getText(url, token = '') {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  const text = await response.text();
  return { response, text };
}

const bad = createFakeUpstream('bad', ({ res }) => {
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'temporary failure' }));
});

const modelError = createFakeUpstream('model-error', ({ req, res }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'model is not available on this upstream' } }));
});

const good = createFakeUpstream('good', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-saw-authorization': req.headers.authorization ? 'yes' : 'no'
  });
  res.end(JSON.stringify({ ok: true, body: JSON.parse(body) }));
});

const added = createFakeUpstream('added', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'added-model-a' }, { id: 'added-model-b' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, added: true, body: JSON.parse(body) }));
});

const usageUpstream = createFakeUpstream('usage-site', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'usage-model' }] }));
    return;
  }
  const payload = JSON.parse(body);
  if (payload.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 12, total_tokens: 19 } } })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    body: payload,
    usage: {
      input_tokens: 11,
      output_tokens: 26,
      total_tokens: 37
    }
  }));
});

const responsesMissingCompleted = createFakeUpstream('responses-missing-completed', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  const payload = JSON.parse(body);
  if (payload.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

const anthropicMessages = createFakeUpstream('anthropic-messages', ({ req, res, body }) => {
  if (req.url === '/v1/models' && req.headers['x-api-key'] === 'upstream-secret' && req.headers['anthropic-version']) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-test' }] }));
    return;
  }
  if (req.url !== '/v1/messages' || req.headers['x-api-key'] !== 'upstream-secret' || !req.headers['anthropic-version']) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'expected anthropic messages auth and path' }));
    return;
  }
  const payload = JSON.parse(body);
  const userText = payload.messages?.[0]?.content?.[0]?.text || '';
  if (payload.model !== 'claude-opus-test' || payload.max_tokens !== 128 || userText !== 'hello claude') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected anthropic payload', payload }));
    return;
  }
  if (payload.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: payload.model, usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 2 } })}\n\n`);
    res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: payload.model,
    content: [{ type: 'text', text: 'pong' }],
    usage: { input_tokens: 3, output_tokens: 2 }
  }));
});

const billingUpstream = createFakeUpstream('billing-site', ({ req, res, body }) => {
  if (req.url.startsWith('/dashboard/billing/')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'billing must keep the /v1 prefix on this upstream' }));
    return;
  }
  if (req.url === '/v1/dashboard/billing/subscription') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hard_limit_usd: 20 }));
    return;
  }
  if (req.url.startsWith('/v1/dashboard/billing/usage?')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total_usage: 1234 }));
    return;
  }
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'billing-model' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, body: body ? JSON.parse(body) : null }));
});

const billingHugeLimitUpstream = createFakeUpstream('billing-huge-limit', ({ req, res }) => {
  if (req.url.startsWith('/dashboard/billing/')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'billing must keep the /v1 prefix on this upstream' }));
    return;
  }
  if (req.url === '/v1/dashboard/billing/subscription') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hard_limit_usd: 100000000 }));
    return;
  }
  if (req.url.startsWith('/v1/dashboard/billing/usage?')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total_usage: 948 }));
    return;
  }
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'huge-limit-model' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

const billingBlockedUpstream = createFakeUpstream('billing-blocked', ({ req, res }) => {
  if (req.url.startsWith('/dashboard/billing/') || req.url.startsWith('/v1/dashboard/billing/')) {
    res.writeHead(403, { 'content-type': 'text/html', 'cf-ray': 'test-ray' });
    res.end('<!doctype html><title>Just a moment...</title><script>window._cf_chl_opt={}</script>');
    return;
  }
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'blocked-billing-model' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

const billingLoginHtmlUpstream = createFakeUpstream('billing-login-html', ({ req, res }) => {
  if (req.url.startsWith('/dashboard/billing/') || req.url.startsWith('/v1/dashboard/billing/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><form id="login">Sign in</form></body></html>');
    return;
  }
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'login-html-billing-model' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

const cloudflareTimeout = createFakeUpstream('cloudflare-timeout', ({ req, res }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'cf-only-model' }] }));
    return;
  }
  res.writeHead(522, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>522: Connection timed out</title>');
});

const streamAbort = createFakeUpstream('stream-abort', ({ req, res }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`);
  setTimeout(() => res.destroy(new Error('simulated upstream stream abort')), 5);
});

const nextModelSite = createFakeUpstream('next-model-site', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'next-site-model' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, body: JSON.parse(body) }));
});

const anthropicModels = createFakeUpstream('anthropic-models', ({ req, res }) => {
  if (req.url === '/v1/models' && req.headers['x-api-key'] === 'upstream-secret' && req.headers['anthropic-version']) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-test' }] }));
    return;
  }
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'expected anthropic model probe' }));
});

const dualProtocolModels = createFakeUpstream('dual-protocol-models', ({ req, res }) => {
  if (req.url === '/v1/models' && req.headers['x-api-key'] === 'upstream-secret' && req.headers['anthropic-version']) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-test' }] }));
    return;
  }
  if (req.url === '/v1/models' && req.headers.authorization === 'Bearer upstream-secret') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'claude-sonnet-test' }] }));
    return;
  }
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'expected OpenAI or Anthropic model probe' }));
});

let codexOauthLastRequest = null;
const codexOauthBackend = createFakeUpstream('codex-oauth-backend', ({ req, res, body }) => {
  codexOauthLastRequest = { url: req.url, headers: req.headers, body };
  if (
    req.url === '/backend-api/codex/responses'
    && req.headers.authorization === 'Bearer oauth-secret'
    && req.headers['openai-beta'] === 'responses=experimental'
    && req.headers.originator === 'codex_cli_rs'
    && req.headers['chatgpt-account-id'] === 'chatgpt-acc'
    && /^codex_cli_rs\/0\.125\.0\b/.test(req.headers['user-agent'] || '')
    && req.headers['x-api-key'] === undefined
  ) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, body: JSON.parse(body) }));
    return;
  }
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'expected Codex OAuth forwarding headers', request: codexOauthLastRequest }));
});

let codexOauthCompactOnlyRequests = [];
const codexOauthCompactOnlyBackend = createFakeUpstream('codex-oauth-compact-only-backend', ({ req, res, body }) => {
  codexOauthCompactOnlyRequests.push({ url: req.url, headers: req.headers, body });
  if (req.url === '/backend-api/codex/responses') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Unauthorized' }));
    return;
  }
  if (
    req.url === '/backend-api/codex/responses/compact'
    && req.headers.authorization === 'Bearer web-session-token'
    && req.headers['openai-beta'] === 'responses=experimental'
    && req.headers.originator === 'codex_cli_rs'
    && req.headers['chatgpt-account-id'] === 'chatgpt-acc'
    && req.headers.version === '0.125.0'
  ) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_compact', object: 'response.compaction', body: JSON.parse(body) }));
    return;
  }
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'expected compact diagnostic request', request: codexOauthCompactOnlyRequests.at(-1) }));
});

let codexOauthProxyLastRequest = null;
const codexOauthProxy = createFakeUpstream('codex-oauth-proxy', ({ req, res, body }) => {
  codexOauthProxyLastRequest = { method: req.method, url: req.url, headers: req.headers };
  if (req.method !== 'POST' || !/^http:\/\/127\.0\.0\.1:\d+\/backend-api\/codex\/responses$/.test(req.url)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'expected absolute proxy request URL', request: codexOauthProxyLastRequest }));
    return;
  }
  const target = new URL(req.url);
  const proxyReq = http.request(target, {
    method: req.method,
    headers: {
      ...req.headers,
      host: target.host
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  });
  proxyReq.end(body);
});

process.env.TEST_POOL_TOKEN = 'pool-secret';
process.env.TEST_UPSTREAM_KEY = 'upstream-secret';
delete process.env.TEST_MISSING_POOL_TOKEN;

const badInfo = await listen(bad);
const modelErrorInfo = await listen(modelError);
const goodInfo = await listen(good);
const addedInfo = await listen(added);
const usageInfo = await listen(usageUpstream);
const responsesMissingCompletedInfo = await listen(responsesMissingCompleted);
const anthropicMessagesInfo = await listen(anthropicMessages);
const billingInfo = await listen(billingUpstream);
const billingHugeLimitInfo = await listen(billingHugeLimitUpstream);
const billingBlockedInfo = await listen(billingBlockedUpstream);
const billingLoginHtmlInfo = await listen(billingLoginHtmlUpstream);
const cloudflareTimeoutInfo = await listen(cloudflareTimeout);
const streamAbortInfo = await listen(streamAbort);
const nextModelSiteInfo = await listen(nextModelSite);
const anthropicModelsInfo = await listen(anthropicModels);
const dualProtocolModelsInfo = await listen(dualProtocolModels);
const codexOauthBackendInfo = await listen(codexOauthBackend);
const codexOauthCompactOnlyBackendInfo = await listen(codexOauthCompactOnlyBackend);
const codexOauthProxyInfo = await listen(codexOauthProxy);

const pool = createTestPool({
  server: {
    host: '127.0.0.1',
    port: 0,
    public_prefix: '/v1',
    auth_token_env: 'TEST_POOL_TOKEN',
    max_body_bytes: 1024 * 1024,
    request_timeout_ms: 5000
  },
  retry: {
    max_attempts: 2,
    failure_threshold: 1,
    base_cooldown_ms: 1000,
    key_cooldown_ms: 1000
  },
  health: {
    enabled: false,
    path: '/models',
    timeout_ms: 1000
  },
  upstreams: [
    { name: 'bad', base_url: `${badInfo.url}/v1`, weight: 10, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
    { name: 'good', base_url: `${goodInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
  ]
});

const poolInfo = await listen(pool);

try {
  const dashboard = await getText(`${poolInfo.url}/pool/dashboard`);
  const requiredDashboardRegions = [
    'data-dashboard-region="top-diagnostic-bar"',
    'data-dashboard-region="upstream-workbench"',
    'data-dashboard-region="recent-request-timeline"',
    'data-dashboard-region="upstream-editor"',
    'id="poolDiagnostic"',
    'Pool Usability',
    'Most Likely Reason',
    'id="selectionCount"',
    'id="modelOverrideState"',
    'id="adminTokenState"',
    'function updateTopDiagnostic(data, ups, activeModel)',
    "eligible.length === 0 ? 'blocked' : degraded ? 'degraded' : 'usable'",
    'class="workbench-list"',
    'class="workbench-head"',
    'class="card workbench-row panel',
    'Upstream Workbench rows',
    'id="checkClaude"',
    'data-claude-check',
    'data-claude-result',
    'function checkClaudeForForm()'
  ];
  for (const marker of requiredDashboardRegions) {
    if (!dashboard.text.includes(marker)) {
      throw new Error(`expected dashboard HTML to include ${marker}`);
    }
  }
  if (!dashboard.text.includes('Management Dashboard') || !dashboard.text.includes('Operational Console')) {
    throw new Error('expected dashboard HTML to expose Management Dashboard / Operational Console structure');
  }
  if (!dashboard.text.includes('availability-readout') || !dashboard.text.includes('availability-samples')) {
    throw new Error('expected dashboard HTML to expose availability visualization');
  }
  if (dashboard.text.includes('availability-dot empty') || dashboard.text.includes('availability-dot ok') || dashboard.text.includes('availability-dot fail')) {
    throw new Error('expected availability visualization classes to avoid global status/empty class collisions');
  }
  if (!dashboard.text.includes('availability-dot is-empty') || !dashboard.text.includes('is-success') || !dashboard.text.includes('is-failure')) {
    throw new Error('expected availability visualization to use scoped sample classes');
  }
  const availabilityHistorySourceIndex = dashboard.text.indexOf('...history.map((ok) =>');
  const availabilityEmptySourceIndex = dashboard.text.indexOf('...Array.from({ length: emptyCount }');
  if (availabilityHistorySourceIndex === -1 || availabilityEmptySourceIndex === -1 || availabilityHistorySourceIndex > availabilityEmptySourceIndex) {
    throw new Error('expected availability visualization to render real samples before trailing empty window slots');
  }

  const authFailPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_MISSING_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'good', base_url: `${goodInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const authFailInfo = await listen(authFailPool);
  try {
    const unauthorized = await requestJson(authFailInfo.url, 'pool-secret');
    if (unauthorized.response.status !== 401) {
      throw new Error(`expected missing auth env to deny proxy access, got ${unauthorized.response.status}: ${unauthorized.text}`);
    }
    const health = await getJson(`${authFailInfo.url}/health`);
    if (health.response.status !== 200 || Array.isArray(health.json.upstreams)) {
      throw new Error(`expected public health to be minimal and available: ${health.text}`);
    }
    const protectedStatus = await getJson(`${authFailInfo.url}/pool/status`);
    if (protectedStatus.response.status !== 401) {
      throw new Error(`expected pool status to require admin/proxy auth, got ${protectedStatus.response.status}: ${protectedStatus.text}`);
    }
  } finally {
    await close(authFailPool);
  }

  const result = await requestJson(poolInfo.url, 'pool-secret');

  if (result.response.status !== 200) {
    throw new Error(`expected 200, got ${result.response.status}: ${result.text}`);
  }

  if (result.response.headers.get('x-codex-api-pool-upstream') !== 'good') {
    throw new Error(`expected fallback to good upstream, got ${result.response.headers.get('x-codex-api-pool-upstream')}`);
  }

  if (!result.json.ok || result.json.body.input !== 'hello') {
    throw new Error(`unexpected response body: ${result.text}`);
  }

  const modelErrorPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 2,
      failure_threshold: 2,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'model-error', base_url: `${modelErrorInfo.url}/v1`, weight: 10, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'good', base_url: `${goodInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const modelErrorPoolInfo = await listen(modelErrorPool);
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const fallback400 = await requestJson(modelErrorPoolInfo.url, 'pool-secret');
    if (fallback400.response.status !== 200) {
      throw new Error(`expected 400 model error fallback to succeed, got ${fallback400.response.status}: ${fallback400.text}`);
    }
    if (fallback400.response.headers.get('x-codex-api-pool-upstream') !== 'good') {
      throw new Error(`expected 400 fallback to good upstream, got ${fallback400.response.headers.get('x-codex-api-pool-upstream')}`);
    }
    if (fallback400.json.body?.model !== 'test-model') {
      throw new Error(`expected model to stay test-model after 400 site fallback: ${fallback400.text}`);
    }
  } finally {
    Math.random = originalRandom;
    await close(modelErrorPool);
  }

  const usagePool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'usage-site', base_url: `${usageInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const usagePoolInfo = await listen(usagePool);
  try {
    await requestJson(usagePoolInfo.url, 'pool-secret');
    await requestJson(usagePoolInfo.url, 'pool-secret');
    const streamBody = JSON.stringify({ model: 'test-model', input: 'hello', stream: true });
    const streamUsage = await fetch(`${usagePoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(streamBody))
      },
      body: streamBody
    });
    const streamText = await streamUsage.text();
    if (streamUsage.status !== 200 || !streamText.includes('response.completed')) {
      throw new Error(`expected stream usage response to pass through: ${streamUsage.status} ${streamText}`);
    }
    const usageStatus = (await getJson(`${usagePoolInfo.url}/pool/status`, 'pool-secret')).json;
    const usageSite = usageStatus.upstreams.find((upstream) => upstream.name === 'usage-site');
    const usageByDayTotal = Object.values(usageSite?.usage?.by_day || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const usageDay = Object.keys(usageSite?.usage?.daily || {})[0];
    const usageDaily = usageSite?.usage?.daily?.[usageDay];
    if (!usageSite || usageSite.usage?.total_tokens !== 93 || usageSite.usage?.input_tokens !== 29 || usageSite.usage?.output_tokens !== 64 || usageSite.usage?.today_tokens !== 93 || usageByDayTotal !== 93 || usageDaily?.total_tokens !== 93 || usageDaily?.input_tokens !== 29 || usageDaily?.output_tokens !== 64) {
      throw new Error(`expected per-upstream token usage to total 93 with input/output split: ${JSON.stringify(usageSite?.usage)}`);
    }
    if (usageStatus.usage?.total_tokens !== 93 || usageStatus.usage?.input_tokens !== 29 || usageStatus.usage?.output_tokens !== 64 || usageStatus.usage?.today_tokens !== 93 || usageStatus.usage?.daily?.[usageDay]?.total_tokens !== 93) {
      throw new Error(`expected global token usage to total 93 with input/output split: ${JSON.stringify(usageStatus.usage)}`);
    }
    const dailyJson = await getJson(`${usagePoolInfo.url}/pool/usage/daily.json`, 'pool-secret');
    if (dailyJson.response.status !== 200 || dailyJson.json.rows?.[0]?.upstream !== 'usage-site' || dailyJson.json.rows?.[0]?.total_tokens !== 93 || dailyJson.json.rows?.[0]?.input_tokens !== 29 || dailyJson.json.rows?.[0]?.output_tokens !== 64) {
      throw new Error(`expected daily usage json export: ${dailyJson.text}`);
    }
    const dailyCsvResponse = await fetch(`${usagePoolInfo.url}/pool/usage/daily.csv`, {
      headers: { authorization: 'Bearer pool-secret' }
    });
    const dailyCsv = await dailyCsvResponse.text();
    if (dailyCsvResponse.status !== 200 || !dailyCsv.includes('date,upstream,input_tokens,output_tokens,total_tokens') || !dailyCsv.includes(',usage-site,29,64,93')) {
      throw new Error(`expected daily usage csv export: ${dailyCsvResponse.status} ${dailyCsv}`);
    }
    const latestUsage = usageStatus.recent_requests?.[0];
    if (!latestUsage || latestUsage.tokens !== 19 || latestUsage.inputTokens !== 7 || latestUsage.outputTokens !== 12 || latestUsage.upstream !== 'usage-site') {
      throw new Error(`expected recent request to include token usage split: ${JSON.stringify(latestUsage)}`);
    }
  } finally {
    await close(usagePool);
  }

  const missingCompletedPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'responses-missing-completed', base_url: `${responsesMissingCompletedInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const missingCompletedPoolInfo = await listen(missingCompletedPool);
  try {
    const streamBody = JSON.stringify({ model: 'test-model', input: 'hello', stream: true });
    const response = await fetch(`${missingCompletedPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(streamBody))
      },
      body: streamBody
    });
    const text = await response.text();
    const completedIndex = text.indexOf('response.completed');
    const doneIndex = text.indexOf('[DONE]');
    if (response.status !== 200 || completedIndex < 0 || doneIndex < 0 || completedIndex > doneIndex) {
      throw new Error(`expected missing Responses completion to be normalized before [DONE]: ${response.status} ${text}`);
    }
  } finally {
    await close(missingCompletedPool);
  }

  const anthropicMessagesPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'claude-opus-test',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      {
        name: 'anthropic-messages',
        base_url: anthropicMessagesInfo.url,
        health_path: '/v1/models',
        probe_auth: 'anthropic',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });
  const anthropicMessagesPoolInfo = await listen(anthropicMessagesPool);
  try {
    const streamBody = JSON.stringify({
      model: 'ignored-original-model',
      stream: true,
      max_output_tokens: 128,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const streamResponse = await fetch(`${anthropicMessagesPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(streamBody))
      },
      body: streamBody
    });
    const streamText = await streamResponse.text();
    const requiredAnthropicStreamEvents = [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      '[DONE]'
    ];
    if (streamResponse.status !== 200 || !streamText.includes('pong') || requiredAnthropicStreamEvents.some((event) => !streamText.includes(event))) {
      throw new Error(`expected Anthropic stream to be adapted to Responses SSE: ${streamResponse.status} ${streamText}`);
    }

    const jsonBody = JSON.stringify({
      model: 'ignored-original-model',
      stream: false,
      max_output_tokens: 128,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const jsonResponse = await fetch(`${anthropicMessagesPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(jsonBody))
      },
      body: jsonBody
    });
    const jsonText = await jsonResponse.text();
    const json = JSON.parse(jsonText);
    if (jsonResponse.status !== 200 || json.status !== 'completed' || json.output_text !== 'pong' || json.usage?.total_tokens !== 5) {
      throw new Error(`expected Anthropic JSON to be adapted to Responses JSON: ${jsonResponse.status} ${jsonText}`);
    }
  } finally {
    await close(anthropicMessagesPool);
  }

  const explicitClaudePool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'gpt-test',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      {
        name: 'explicit-claude-site',
        base_url: anthropicMessagesInfo.url,
        health_path: '/v1/models',
        probe_auth: 'anthropic',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });
  const explicitClaudePoolInfo = await listen(explicitClaudePool);
  try {
    const streamBody = JSON.stringify({
      model: 'claude-opus-test',
      stream: true,
      max_output_tokens: 128,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const response = await fetch(`${explicitClaudePoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(streamBody))
      },
      body: streamBody
    });
    const text = await response.text();
    if (response.status !== 200 || !text.includes('response.completed') || !text.includes('pong')) {
      throw new Error(`expected explicit Claude request model to bypass non-Claude override: ${response.status} ${text}`);
    }
    const status = (await getJson(`${explicitClaudePoolInfo.url}/pool/status`, 'pool-secret')).json;
    const latest = status.recent_requests?.[0];
    if (!latest || latest.originalModel !== 'claude-opus-test' || latest.actualModel !== 'claude-opus-test' || latest.upstream !== 'explicit-claude-site') {
      throw new Error(`expected explicit Claude request to stay Claude despite non-Claude override: ${JSON.stringify(latest)}`);
    }
  } finally {
    await close(explicitClaudePool);
  }

  const listedClaudePool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'claude-opus-test',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      {
        name: 'listed-claude-site',
        api: 'anthropic',
        base_url: `${anthropicMessagesInfo.url}/v1`,
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });
  listedClaudePool.state.upstreams[0].health.models = ['claude-opus-test'];
  listedClaudePool.state.upstreams[0].health.modelsCount = 1;
  const listedClaudePoolInfo = await listen(listedClaudePool);
  try {
    const streamBody = JSON.stringify({
      model: 'ignored-original-model',
      stream: true,
      max_output_tokens: 128,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const response = await fetch(`${listedClaudePoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(streamBody))
      },
      body: streamBody
    });
    const text = await response.text();
    if (response.status !== 200 || !text.includes('response.output_item.done') || !text.includes('response.completed') || !text.includes('pong')) {
      throw new Error(`expected listed Claude model upstream to use Anthropic Messages adapter: ${response.status} ${text}`);
    }
  } finally {
    await close(listedClaudePool);
  }

  const claudeSelectionPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'claude-opus-test',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'openai-generic', base_url: `${nextModelSiteInfo.url}/v1`, weight: 100, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'anthropic-only', api: 'anthropic', base_url: anthropicMessagesInfo.url, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const claudeSelectionPoolInfo = await listen(claudeSelectionPool);
  try {
    const body = JSON.stringify({
      model: 'ignored-original-model',
      stream: false,
      max_output_tokens: 128,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const response = await fetch(`${claudeSelectionPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body))
      },
      body
    });
    const text = await response.text();
    if (response.status !== 200 || response.headers.get('x-codex-api-pool-upstream') !== 'anthropic-only') {
      throw new Error(`expected Claude model selection to skip unmarked OpenAI upstreams: ${response.status} ${text}`);
    }
  } finally {
    await close(claudeSelectionPool);
  }

  const nonClaudeSelectionPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'gpt-test',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'anthropic-only', api: 'anthropic', base_url: anthropicMessagesInfo.url, weight: 100, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'both-protocols', api: 'both', base_url: `${nextModelSiteInfo.url}/v1`, weight: 10, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'openai-generic', base_url: `${nextModelSiteInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const nonClaudeSelectionPoolInfo = await listen(nonClaudeSelectionPool);
  const originalNonClaudeSelectionRandom = Math.random;
  try {
    Math.random = () => 0;
    const result = await requestJson(nonClaudeSelectionPoolInfo.url, 'pool-secret');
    if (result.response.status !== 200 || result.response.headers.get('x-codex-api-pool-upstream') !== 'both-protocols' || result.json.body?.model !== 'gpt-test') {
      throw new Error(`expected non-Claude model selection to skip Anthropic-only upstreams but allow both-protocol upstreams: ${result.response.status} ${result.text}`);
    }
  } finally {
    Math.random = originalNonClaudeSelectionRandom;
    await close(nonClaudeSelectionPool);
  }

  const billingPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    billing: { concurrency: 2, timeout_ms: 1000 },
    upstreams: [
      { name: 'billing-site', base_url: `${billingInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const billingPoolInfo = await listen(billingPool);
  try {
    const billingResult = await postJson(`${billingPoolInfo.url}/pool/upstreams/billing-site/billing`, 'pool-secret', {});
    if (billingResult.response.status !== 200 || billingResult.json.billing?.state !== 'ok') {
      throw new Error(`expected billing probe ok: ${billingResult.text}`);
    }
    const billing = billingResult.json.billing;
    if (billing.currency !== 'USD' || billing.limit_amount !== 20 || billing.used_amount !== 12.34 || billing.balance_amount !== 7.66) {
      throw new Error(`expected billing amounts from OpenAI-style endpoints: ${JSON.stringify(billing)}`);
    }
    const billingStatus = (await getJson(`${billingPoolInfo.url}/pool/status`, 'pool-secret')).json;
    const billingSite = billingStatus.upstreams.find((upstream) => upstream.name === 'billing-site');
    if (billingSite?.billing?.balance_amount !== 7.66 || billingStatus.billing?.balance_amount !== 7.66 || billingStatus.billing?.used_amount !== 12.34) {
      throw new Error(`expected billing status aggregation: ${JSON.stringify(billingStatus.billing)} / ${JSON.stringify(billingSite?.billing)}`);
    }
    const billingAll = await postJson(`${billingPoolInfo.url}/pool/billing`, 'pool-secret', {});
    if (billingAll.response.status !== 200 || billingAll.json.result?.billing?.limit_amount !== 20) {
      throw new Error(`expected pool billing refresh to aggregate: ${billingAll.text}`);
    }
  } finally {
    await close(billingPool);
  }

  const hugeLimitBillingPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    billing: { concurrency: 2, timeout_ms: 1000 },
    upstreams: [
      {
        name: 'billing-huge-limit',
        base_url: `${billingHugeLimitInfo.url}/v1`,
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  });
  const hugeLimitBillingInfo = await listen(hugeLimitBillingPool);
  try {
    const hugeLimit = await postJson(`${hugeLimitBillingInfo.url}/pool/upstreams/billing-huge-limit/billing`, 'pool-secret', {});
    if (hugeLimit.response.status !== 200 || hugeLimit.json.billing?.state !== 'ok') {
      throw new Error(`expected huge-limit billing probe ok: ${hugeLimit.text}`);
    }
    const billing = hugeLimit.json.billing;
    if (billing.limit_amount !== null || billing.balance_amount !== null || billing.used_amount !== 9.48 || billing.limit_placeholder !== true) {
      throw new Error(`expected huge placeholder limit to be hidden while keeping usage: ${JSON.stringify(billing)}`);
    }
    const status = (await getJson(`${hugeLimitBillingInfo.url}/pool/status`, 'pool-secret')).json;
    const site = status.upstreams.find((upstream) => upstream.name === 'billing-huge-limit');
    if (site?.billing?.limit_amount !== null || site?.billing?.balance_amount !== null || status.billing?.limit_amount !== null || status.billing?.balance_amount !== null) {
      throw new Error(`expected status aggregation to ignore huge placeholder limits: ${JSON.stringify(status.billing)} / ${JSON.stringify(site?.billing)}`);
    }
  } finally {
    await close(hugeLimitBillingPool);
  }

  const blockedBillingPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    billing: { concurrency: 2, timeout_ms: 1000 },
    upstreams: [
      { name: 'billing-blocked', base_url: `${billingBlockedInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const blockedBillingInfo = await listen(blockedBillingPool);
  try {
    const blockedBilling = await postJson(`${blockedBillingInfo.url}/pool/upstreams/billing-blocked/billing`, 'pool-secret', {});
    if (blockedBilling.response.status !== 200 || blockedBilling.json.billing?.state !== 'blocked') {
      throw new Error(`expected HTML-protected billing endpoint to be marked blocked: ${blockedBilling.text}`);
    }
    if (!/browser\/Cloudflare/i.test(blockedBilling.json.billing?.error || '')) {
      throw new Error(`expected blocked billing error to mention browser/Cloudflare challenge: ${blockedBilling.text}`);
    }
    const mainAfterBlockedBilling = await requestJson(blockedBillingInfo.url, 'pool-secret');
    if (mainAfterBlockedBilling.response.status !== 200) {
      throw new Error(`expected main request to stay usable after blocked billing: ${mainAfterBlockedBilling.response.status} ${mainAfterBlockedBilling.text}`);
    }
  } finally {
    await close(blockedBillingPool);
  }

  const loginHtmlBillingPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    billing: { concurrency: 2, timeout_ms: 1000 },
    upstreams: [
      { name: 'billing-login-html', base_url: `${billingLoginHtmlInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const loginHtmlBillingInfo = await listen(loginHtmlBillingPool);
  try {
    const loginHtmlBilling = await postJson(`${loginHtmlBillingInfo.url}/pool/upstreams/billing-login-html/billing`, 'pool-secret', {});
    if (loginHtmlBilling.response.status !== 200 || loginHtmlBilling.json.billing?.state !== 'blocked' || loginHtmlBilling.json.billing?.balance_amount !== null) {
      throw new Error(`expected 200 HTML billing login page to be blocked with empty amounts: ${loginHtmlBilling.text}`);
    }
  } finally {
    await close(loginHtmlBillingPool);
  }

  const togglePool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'preferred-off', base_url: `${addedInfo.url}/v1`, weight: 10, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'fallback-good', base_url: `${goodInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const toggleInfo = await listen(togglePool);
  try {
    const disableResult = await postJson(`${toggleInfo.url}/pool/upstreams/preferred-off/enabled`, 'pool-secret', { enabled: false });
    if (disableResult.response.status !== 200 || disableResult.json.enabled !== false || disableResult.json.health?.state !== 'disabled') {
      throw new Error(`expected upstream disable to persist disabled state: ${disableResult.text}`);
    }
    const disabledStatus = (await getJson(`${toggleInfo.url}/pool/status`, 'pool-secret')).json;
    const disabledPreferred = disabledStatus.upstreams.find((upstream) => upstream.name === 'preferred-off');
    if (!disabledPreferred || disabledPreferred.enabled !== false || disabledPreferred.available !== false || disabledStatus.upstreams.length !== 2) {
      throw new Error(`expected disabled upstream to remain visible and unavailable: ${JSON.stringify(disabledStatus.upstreams)}`);
    }

    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      const disabledRoute = await requestJson(toggleInfo.url, 'pool-secret');
      if (disabledRoute.response.status !== 200 || disabledRoute.response.headers.get('x-codex-api-pool-upstream') !== 'fallback-good') {
        throw new Error(`expected disabled preferred upstream to be skipped: ${disabledRoute.response.status} ${disabledRoute.text}`);
      }
    } finally {
      Math.random = originalRandom;
    }

    const enableResult = await postJson(`${toggleInfo.url}/pool/upstreams/preferred-off/enabled`, 'pool-secret', { enabled: true });
    if (enableResult.response.status !== 200 || enableResult.json.enabled !== true || enableResult.json.health?.state !== 'ok') {
      throw new Error(`expected upstream enable to probe and restore health: ${enableResult.text}`);
    }
  } finally {
    await close(togglePool);
  }

  const addResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'added-site',
    base_url: `${addedInfo.url}/v1`,
    site_url: `${addedInfo.url}/signin`,
    signin_completed: true,
    weight: 2,
    keys: [{ env: 'TEST_UPSTREAM_KEY' }]
  });

  if (addResult.response.status !== 201) {
    throw new Error(`expected add upstream 201, got ${addResult.response.status}: ${addResult.text}`);
  }

  if (addResult.json.health?.state !== 'ok' || addResult.json.health?.modelsCount !== 2) {
    throw new Error(`expected added upstream health ok with two models: ${addResult.text}`);
  }

  const statusAfterAdd = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  if (!statusAfterAdd.model?.known?.includes('added-model-b')) {
    throw new Error(`expected status to include added models: ${JSON.stringify(statusAfterAdd.model)}`);
  }
  const today = localDateKey();
  const yesterday = localDateKey(Date.now() - 24 * 60 * 60 * 1000);
  const addedStatus = statusAfterAdd.upstreams.find((upstream) => upstream.name === 'added-site');
  if (!addedStatus?.signin_available || addedStatus?.signin_status !== 'completed' || addedStatus?.signin_completed !== true || addedStatus?.signin_completed_date !== today) {
    throw new Error(`expected status to expose sign-in availability and completion: ${JSON.stringify(addedStatus)}`);
  }

  const replaceResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'added-site',
    base_url: `${addedInfo.url}/v1`,
    weight: 3,
    replace: true
  });
  if (replaceResult.response.status !== 200) {
    throw new Error(`expected replace upstream 200, got ${replaceResult.response.status}: ${replaceResult.text}`);
  }
  const statusAfterReplace = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const replaced = statusAfterReplace.upstreams.find((upstream) => upstream.name === 'added-site');
  if (!replaced || replaced.site_url !== `${addedInfo.url}/signin` || replaced.signin_status !== 'completed' || replaced.signin_completed !== true || replaced.signin_completed_date !== today || replaced.weight !== 3) {
    throw new Error(`expected replace to preserve site_url/signin state and update weight: ${JSON.stringify(replaced)}`);
  }
  if (!statusAfterReplace.model?.known?.includes('added-model-b')) {
    throw new Error(`expected replace to keep model cache warm: ${JSON.stringify(statusAfterReplace.model)}`);
  }

  const signinUnavailableResult = await postJson(`${poolInfo.url}/pool/upstreams/added-site/signin`, 'pool-secret', { signin_available: false });
  if (
    signinUnavailableResult.response.status !== 200 ||
    signinUnavailableResult.json.signin_available !== false ||
    signinUnavailableResult.json.signin_status !== 'not_required' ||
    signinUnavailableResult.json.signin_completed !== false ||
    signinUnavailableResult.json.signin_completed_date !== ''
  ) {
    throw new Error(`expected sign-in availability off to clear today's completion: ${signinUnavailableResult.text}`);
  }
  const statusAfterSigninUnavailable = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const signinUnavailable = statusAfterSigninUnavailable.upstreams.find((upstream) => upstream.name === 'added-site');
  if (!signinUnavailable || signinUnavailable.signin_available !== false || signinUnavailable.signin_status !== 'not_required' || signinUnavailable.signin_completed !== false || signinUnavailable.signin_completed_date !== '') {
    throw new Error(`expected status to expose unavailable sign-in state: ${JSON.stringify(signinUnavailable)}`);
  }

  const signinUnavailableCompleteResult = await postJson(`${poolInfo.url}/pool/upstreams/added-site/signin`, 'pool-secret', { signin_completed: true });
  if (signinUnavailableCompleteResult.response.status !== 400 || !signinUnavailableCompleteResult.json.error?.includes('not sign-in available')) {
    throw new Error(`expected unavailable sign-in completion to be rejected: ${signinUnavailableCompleteResult.text}`);
  }

  const signinAvailableResult = await postJson(`${poolInfo.url}/pool/upstreams/added-site/signin`, 'pool-secret', { signin_available: true });
  if (
    signinAvailableResult.response.status !== 200 ||
    signinAvailableResult.json.signin_available !== true ||
    signinAvailableResult.json.signin_status !== 'pending' ||
    signinAvailableResult.json.signin_completed !== false ||
    signinAvailableResult.json.signin_completed_date !== ''
  ) {
    throw new Error(`expected sign-in availability on to remain not completed today: ${signinAvailableResult.text}`);
  }

  const signinCompleteResult = await postJson(`${poolInfo.url}/pool/upstreams/added-site/signin`, 'pool-secret', { signin_completed: true });
  if (
    signinCompleteResult.response.status !== 200 ||
    signinCompleteResult.json.signin_available !== true ||
    signinCompleteResult.json.signin_status !== 'completed' ||
    signinCompleteResult.json.signin_completed !== true ||
    signinCompleteResult.json.signin_completed_date !== today
  ) {
    throw new Error(`expected completing sign-in to persist today's date: ${signinCompleteResult.text}`);
  }
  const statusAfterSigninComplete = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const signinComplete = statusAfterSigninComplete.upstreams.find((upstream) => upstream.name === 'added-site');
  if (!signinComplete || signinComplete.signin_available !== true || signinComplete.signin_status !== 'completed' || signinComplete.signin_completed !== true || signinComplete.signin_completed_date !== today) {
    throw new Error(`expected status to expose today's completed sign-in state: ${JSON.stringify(signinComplete)}`);
  }

  const signinUndoResult = await postJson(`${poolInfo.url}/pool/upstreams/added-site/signin`, 'pool-secret', { signin_completed: false });
  if (
    signinUndoResult.response.status !== 200 ||
    signinUndoResult.json.signin_available !== true ||
    signinUndoResult.json.signin_status !== 'pending' ||
    signinUndoResult.json.signin_completed !== false ||
    signinUndoResult.json.signin_completed_date !== ''
  ) {
    throw new Error(`expected undoing sign-in to clear today's date: ${signinUndoResult.text}`);
  }

  const staleSigninResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'stale-signin-site',
    base_url: `${addedInfo.url}/v1`,
    site_url: `${addedInfo.url}/signin`,
    signin_completed_date: yesterday,
    weight: 2,
    keys: [{ env: 'TEST_UPSTREAM_KEY' }]
  });
  if (staleSigninResult.response.status !== 201) {
    throw new Error(`expected stale sign-in upstream add 201, got ${staleSigninResult.response.status}: ${staleSigninResult.text}`);
  }
  const statusAfterStaleSignin = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const staleSignin = statusAfterStaleSignin.upstreams.find((upstream) => upstream.name === 'stale-signin-site');
  if (!staleSignin || staleSignin.signin_available !== true || staleSignin.signin_status !== 'pending' || staleSignin.signin_completed !== false || staleSignin.signin_completed_date !== '') {
    throw new Error(`expected stale sign-in date to be hidden and treated as pending: ${JSON.stringify(staleSignin)}`);
  }
  const deleteStaleSignin = await deleteJson(`${poolInfo.url}/pool/upstreams/stale-signin-site`, 'pool-secret');
  if (deleteStaleSignin.response.status !== 200) {
    throw new Error(`expected stale sign-in upstream delete 200: ${deleteStaleSignin.text}`);
  }

  const importResult = await postJson(`${poolInfo.url}/pool/import/upstreams?secret_mode=env`, 'pool-secret', {
    sites: [
      {
        name: 'cpa-json-site',
        apiUrl: `${addedInfo.url}/v1`,
        siteUrl: `${addedInfo.url}/panel`,
        token: 'plaintext-import-key',
        weight: 4
      },
      {
        name: 'added-site',
        baseUrl: `${addedInfo.url}/v1`,
        key_env: 'TEST_UPSTREAM_KEY'
      }
    ]
  });
  if (importResult.response.status !== 201 || importResult.json.added !== 1 || importResult.json.skipped !== 1 || importResult.json.plaintext_key_warning !== null) {
    throw new Error(`expected import to add one upstream, skip duplicate, and avoid plaintext key in env mode: ${importResult.text}`);
  }

  const statusAfterImport = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const imported = statusAfterImport.upstreams.find((upstream) => upstream.name === 'cpa-json-site');
  if (!imported || imported.base_url !== `${addedInfo.url}/v1` || imported.site_url !== `${addedInfo.url}/panel` || imported.weight !== 4 || imported.keys?.[0]?.label !== 'CPA_JSON_SITE_API_KEY') {
    throw new Error(`expected cpa/sub2api JSON import to normalize upstream fields: ${JSON.stringify(imported)}`);
  }

  const importReplaceResult = await postJson(`${poolInfo.url}/pool/import/upstreams?replace=true`, 'pool-secret', {
    providers: [
      {
        id: 'cpa-json-site',
        base_url: `${addedInfo.url}/v1`,
        key_env: 'TEST_UPSTREAM_KEY',
        weight: 5
      }
    ]
  });
  if (importReplaceResult.response.status !== 201 || importReplaceResult.json.replaced !== 1) {
    throw new Error(`expected import replace to replace same-name upstream: ${importReplaceResult.text}`);
  }
  const statusAfterImportReplace = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const importedReplaced = statusAfterImportReplace.upstreams.find((upstream) => upstream.name === 'cpa-json-site');
  if (!importedReplaced || importedReplaced.weight !== 5 || importedReplaced.keys?.[0]?.configured !== true) {
    throw new Error(`expected import replace to update weight and env key: ${JSON.stringify(importedReplaced)}`);
  }

  const deleteImported = await deleteJson(`${poolInfo.url}/pool/upstreams/cpa-json-site`, 'pool-secret');
  if (deleteImported.response.status !== 200 || deleteImported.json.action !== 'deleted' || deleteImported.json.removed_upstreams !== 1) {
    throw new Error(`expected runtime delete to remove imported upstream: ${deleteImported.text}`);
  }
  const statusAfterDelete = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  if (statusAfterDelete.upstreams.some((upstream) => upstream.name === 'cpa-json-site')) {
    throw new Error(`expected deleted upstream to disappear from status: ${JSON.stringify(statusAfterDelete.upstreams)}`);
  }
  const missingDelete = await deleteJson(`${poolInfo.url}/pool/upstreams/cpa-json-site`, 'pool-secret');
  if (missingDelete.response.status !== 404 || !missingDelete.json.error?.includes('upstream not found')) {
    throw new Error(`expected deleting a missing upstream to return 404: ${missingDelete.text}`);
  }

  const proxyWithAccountExport = await postJson(`${poolInfo.url}/pool/import/upstreams`, 'pool-secret', {
    exported_at: '2026-06-08T10:20:06.003Z',
    proxies: [
      {
        name: 'proxy-json-site',
        endpoint: `${addedInfo.url}/v1`,
        key_env: 'TEST_UPSTREAM_KEY'
      }
    ],
    accounts: [
      {
        name: 'oauth-account',
        platform: 'openai',
        type: 'oauth',
        credentials: { access_token: 'oauth-account-token' },
        extra: { source: 'chatgpt_web_session' }
      }
    ]
  });
  if (proxyWithAccountExport.response.status !== 201 || proxyWithAccountExport.json.added !== 1) {
    throw new Error(`expected import to prefer proxies over OAuth accounts: ${proxyWithAccountExport.text}`);
  }

  const oauthAccountJwt = [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      exp: Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000),
      client_id: 'app_test_chatgpt_web',
      sub: 'user-sub',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'jwt-chatgpt-acc',
        chatgpt_account_user_id: 'jwt-chatgpt-user',
        chatgpt_plan_type: 'team'
      },
      'https://api.openai.com/profile': {
        email: 'slizm@example.test'
      }
    })).toString('base64url'),
    'signature'
  ].join('.');

  const accountExportImport = await postJson(`${poolInfo.url}/pool/import/upstreams`, 'pool-secret', {
    exported_at: '2026-06-08T10:20:06.003Z',
    proxies: [],
    accounts: [
      {
        name: 'slizm@example.test',
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: oauthAccountJwt
        },
        extra: {
          source: 'chatgpt_web_session'
        }
      }
    ]
  });
  if (
    accountExportImport.response.status !== 201
    || accountExportImport.json.added !== 1
    || accountExportImport.json.secretCount !== 1
    || accountExportImport.json.plaintext_key_warning !== null
  ) {
    throw new Error(`expected OAuth account export without proxies to import as a Codex OAuth account with secret storage: ${accountExportImport.text}`);
  }
  const statusAfterAccountImport = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const accountUpstream = statusAfterAccountImport.upstreams.find((upstream) => upstream.name === 'slizm-example.test');
  if (
    !accountUpstream
    || accountUpstream.base_url !== 'https://chatgpt.com/backend-api/codex'
    || accountUpstream.api !== 'openai'
    || accountUpstream.codex_oauth !== true
    || accountUpstream.request_mode !== 'codex_oauth'
    || accountUpstream.oauth_expires_at !== '2099-01-01T00:00:00.000Z'
    || accountUpstream.oauth_client_id !== 'app_test_chatgpt_web'
    || accountUpstream.chatgpt_account_id !== 'jwt-chatgpt-acc'
    || accountUpstream.chatgpt_user_id !== 'jwt-chatgpt-user'
    || accountUpstream.oauth_plan_type !== 'team'
    || accountUpstream.keys?.[0]?.configured !== true
  ) {
    throw new Error(`expected OAuth account export to normalize into a Codex OAuth upstream: ${JSON.stringify(accountUpstream)}`);
  }

  const addProxyToAccount = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'slizm-example.test',
    base_url: 'https://chatgpt.com/backend-api/codex',
    proxy_url: 'http://127.0.0.1:7897',
    codex_oauth: true,
    request_mode: 'codex_oauth',
    oauth_expires_at: '2099-01-01T00:00:00.000Z',
    api: 'openai',
    probe_auth: 'none',
    replace: true,
    keys: [{ value: 'oauth-account-token' }]
  });
  if (!addProxyToAccount.response.ok) {
    throw new Error(`expected setting proxy_url on imported OAuth account to succeed: ${addProxyToAccount.text}`);
  }
  const accountReplacePreservesProxy = await postJson(`${poolInfo.url}/pool/import/upstreams?replace=true`, 'pool-secret', {
    exported_at: '2026-06-08T10:20:06.003Z',
    proxies: [],
    accounts: [
      {
        name: 'slizm@example.test',
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: 'oauth-account-token',
          expires_at: '2099-01-01T00:00:00.000Z'
        },
        extra: { source: 'chatgpt_web_session' }
      }
    ]
  });
  if (accountReplacePreservesProxy.response.status !== 201 || accountReplacePreservesProxy.json.replaced !== 1) {
    throw new Error(`expected replace import to preserve existing OAuth account proxy_url: ${accountReplacePreservesProxy.text}`);
  }
  const statusAfterAccountReplace = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const replacedAccountUpstream = statusAfterAccountReplace.upstreams.find((upstream) => upstream.name === 'slizm-example.test');
  if (replacedAccountUpstream?.proxy_url !== 'http://127.0.0.1:7897') {
    throw new Error(`expected replace import without proxy_url to preserve existing proxy_url: ${JSON.stringify(replacedAccountUpstream)}`);
  }
  const deleteAccountUpstream = await deleteJson(`${poolInfo.url}/pool/upstreams/slizm-example.test`, 'pool-secret');
  if (
    deleteAccountUpstream.response.status !== 200
    || deleteAccountUpstream.json.removed_accounts !== 1
    || deleteAccountUpstream.json.removed_secrets !== 1
  ) {
    throw new Error(`expected deleting imported OAuth account upstream to remove account and secret: ${deleteAccountUpstream.text}`);
  }
  const statusAfterAccountDelete = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  if (statusAfterAccountDelete.upstreams.some((upstream) => upstream.name === 'slizm-example.test')) {
    throw new Error(`expected deleted OAuth account upstream to disappear from status: ${JSON.stringify(statusAfterAccountDelete.upstreams)}`);
  }

  const codexOauthPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      auth_token_env: 'TEST_POOL_TOKEN',
      public_prefix: '/v1'
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      {
        name: 'codex-oauth',
        api: 'openai',
        codex_oauth: true,
        base_url: `${codexOauthBackendInfo.url}/backend-api/codex`,
        proxy_url: codexOauthProxyInfo.url,
        chatgpt_account_id: 'chatgpt-acc',
        keys: [{ value: 'oauth-secret' }]
      }
    ]
  });
  const codexOauthPoolInfo = await listen(codexOauthPool);
  try {
    const codexOauthHealth = await postJson(`${codexOauthPoolInfo.url}/pool/upstreams/codex-oauth/probe`, 'pool-secret', {});
    if (codexOauthHealth.response.status !== 200 || codexOauthHealth.json.health?.state !== 'ok' || codexOauthHealth.json.health?.httpStatus !== 200) {
      throw new Error(`expected Codex OAuth manual probe to send a live request through proxy_url: ${codexOauthHealth.text}`);
    }
    const codexOauthResponse = await fetch(`${codexOauthPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'x-api-key': 'must-not-forward'
      },
      body: JSON.stringify({ model: 'gpt-test', input: 'hello', stream: false })
    });
    const codexOauthText = await codexOauthResponse.text();
    if (codexOauthResponse.status !== 200) {
      throw new Error(`expected Codex OAuth forwarding 200, got ${codexOauthResponse.status}: ${codexOauthText}`);
    }
    if (codexOauthLastRequest?.url !== '/backend-api/codex/responses') {
      throw new Error(`expected Codex OAuth target path /backend-api/codex/responses: ${JSON.stringify(codexOauthLastRequest)}`);
    }
    if (!codexOauthProxyLastRequest?.url?.startsWith(`${codexOauthBackendInfo.url}/backend-api/codex/responses`)) {
      throw new Error(`expected Codex OAuth request to pass through proxy_url: ${JSON.stringify(codexOauthProxyLastRequest)}`);
    }
  } finally {
    await close(codexOauthPool);
  }

  codexOauthCompactOnlyRequests = [];
  const codexOauthCompactOnlyPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      auth_token_env: 'TEST_POOL_TOKEN',
      public_prefix: '/v1'
    },
    model_override: 'gpt-5.3-codex',
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      {
        name: 'codex-oauth-compact-only',
        api: 'openai',
        codex_oauth: true,
        base_url: `${codexOauthCompactOnlyBackendInfo.url}/backend-api/codex`,
        oauth_client_id: 'app_test_chatgpt_web',
        chatgpt_account_id: 'chatgpt-acc',
        keys: [{ value: 'web-session-token' }]
      }
    ]
  });
  const codexOauthCompactOnlyPoolInfo = await listen(codexOauthCompactOnlyPool);
  try {
    const compactOnlyHealth = await postJson(`${codexOauthCompactOnlyPoolInfo.url}/pool/upstreams/codex-oauth-compact-only/probe`, 'pool-secret', {});
    const health = compactOnlyHealth.json.health || {};
    if (
      compactOnlyHealth.response.status !== 200
      || health.state !== 'auth_error'
      || health.httpStatus !== 401
      || health.diagnostics?.compactStatusCode !== 200
      || health.diagnostics?.compactModel !== 'gpt-5.5'
      || !String(health.error || '').includes('not a full Codex OAuth upstream token')
      || !String(health.error || '').includes('app_test_chatgpt_web')
    ) {
      throw new Error(`expected Codex OAuth probe to report compact-only diagnostic: ${compactOnlyHealth.text}`);
    }
    if (!codexOauthCompactOnlyRequests.some((request) => request.url === '/backend-api/codex/responses/compact')) {
      throw new Error(`expected compact diagnostic request after /responses auth failure: ${JSON.stringify(codexOauthCompactOnlyRequests)}`);
    }
  } finally {
    await close(codexOauthCompactOnlyPool);
  }

  const webSessionImport = await postJson(`${poolInfo.url}/pool/import/upstreams`, 'pool-secret', {
    user: { email: 'test@example.com' },
    expires: '2099-01-01T00:00:00.000Z',
    accessToken: 'web-session-token'
  });
  if (webSessionImport.response.status !== 400 || !webSessionImport.json.error?.includes('ChatGPT Web session JSON')) {
    throw new Error(`expected ChatGPT Web session JSON import to be rejected: ${webSessionImport.text}`);
  }

  const anthropicAddResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'anthropic-models',
    base_url: anthropicModelsInfo.url,
    health_path: '/v1/models',
    probe_auth: 'anthropic',
    weight: 1,
    keys: [{ env: 'TEST_UPSTREAM_KEY' }]
  });

  if (anthropicAddResult.response.status !== 201) {
    throw new Error(`expected anthropic upstream add 201, got ${anthropicAddResult.response.status}: ${anthropicAddResult.text}`);
  }

  if (anthropicAddResult.json.health?.state !== 'ok' || !anthropicAddResult.json.health?.models?.includes('claude-sonnet-test')) {
    throw new Error(`expected anthropic model probe to discover claude model: ${anthropicAddResult.text}`);
  }

  const anthropicReplaceResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'anthropic-models',
    base_url: anthropicModelsInfo.url,
    weight: 2,
    replace: true
  });
  if (anthropicReplaceResult.response.status !== 200 || anthropicReplaceResult.json.health?.state !== 'ok') {
    throw new Error(`expected anthropic replace to preserve health probe settings: ${anthropicReplaceResult.text}`);
  }

  const autoAnthropicAddResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'auto-anthropic-models',
    base_url: anthropicModelsInfo.url,
    weight: 1,
    keys: [{ env: 'TEST_UPSTREAM_KEY' }]
  });
  if (autoAnthropicAddResult.response.status !== 201 || autoAnthropicAddResult.json.api !== 'anthropic' || autoAnthropicAddResult.json.api_detected !== 'anthropic') {
    throw new Error(`expected auto Anthropic detection to persist api=anthropic: ${autoAnthropicAddResult.text}`);
  }
  if (autoAnthropicAddResult.json.health?.state !== 'ok' || !autoAnthropicAddResult.json.health?.models?.includes('claude-sonnet-test')) {
    throw new Error(`expected auto Anthropic detection to reuse Anthropic health: ${autoAnthropicAddResult.text}`);
  }

  const draftClaudeCheck = await postJson(`${poolInfo.url}/pool/claude-check`, 'pool-secret', {
    name: 'draft-claude-only',
    base_url: anthropicModelsInfo.url,
    weight: 1,
    keys: [{ env: 'TEST_UPSTREAM_KEY' }]
  });
  if (
    draftClaudeCheck.response.status !== 200 ||
    draftClaudeCheck.json.claude_check?.supports_claude !== true ||
    draftClaudeCheck.json.claude_check?.claude_only !== true ||
    draftClaudeCheck.json.claude_check?.suggested_api !== 'anthropic' ||
    !draftClaudeCheck.json.claude_check?.claude_models?.includes('claude-sonnet-test')
  ) {
    throw new Error(`expected draft Claude check to identify Claude-only upstream: ${draftClaudeCheck.text}`);
  }

  const dualProtocolAddResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'dual-protocol-models',
    base_url: `${dualProtocolModelsInfo.url}/v1`,
    weight: 1,
    keys: [{ env: 'TEST_UPSTREAM_KEY' }]
  });
  if (dualProtocolAddResult.response.status !== 201 || dualProtocolAddResult.json.api !== 'both' || dualProtocolAddResult.json.api_detected !== 'both') {
    throw new Error(`expected dual protocol detection to persist api=both: ${dualProtocolAddResult.text}`);
  }
  if (!dualProtocolAddResult.json.health?.models?.includes('gpt-test') || !dualProtocolAddResult.json.health?.models?.includes('claude-sonnet-test')) {
    throw new Error(`expected dual protocol detection to merge OpenAI and Anthropic models: ${dualProtocolAddResult.text}`);
  }

  const dualClaudeCheck = await postJson(`${poolInfo.url}/pool/upstreams/dual-protocol-models/claude-check`, 'pool-secret', {});
  if (
    dualClaudeCheck.response.status !== 200 ||
    dualClaudeCheck.json.claude_check?.supports_claude !== true ||
    dualClaudeCheck.json.claude_check?.claude_only !== false ||
    dualClaudeCheck.json.claude_check?.suggested_api !== 'both' ||
    !dualClaudeCheck.json.claude_check?.non_claude_models?.includes('gpt-test')
  ) {
    throw new Error(`expected saved dual-protocol Claude check to identify mixed model upstream: ${dualClaudeCheck.text}`);
  }

  const modelResult = await postJson(`${poolInfo.url}/pool/model`, 'pool-secret', { model: 'added-model-b' });
  if (modelResult.response.status !== 200 || modelResult.json.model_override !== 'added-model-b') {
    throw new Error(`expected model override to be saved: ${modelResult.text}`);
  }

  const overrideResult = await requestJson(poolInfo.url, 'pool-secret');
  if (overrideResult.response.status !== 200 || overrideResult.json.body?.model !== 'added-model-b') {
    throw new Error(`expected request model to be overridden: ${overrideResult.text}`);
  }

  const streamAbortPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 2,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: {
      enabled: false,
      path: '/models',
      timeout_ms: 1000
    },
    upstreams: [
      { name: 'stream-abort', base_url: `${streamAbortInfo.url}/v1`, weight: 10, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'next-model-site', base_url: `${nextModelSiteInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const streamAbortPoolInfo = await listen(streamAbortPool);
  try {
    await postJson(`${streamAbortPoolInfo.url}/pool/upstreams/stream-abort/probe`, 'pool-secret', {});
    await postJson(`${streamAbortPoolInfo.url}/pool/upstreams/next-model-site/probe`, 'pool-secret', {});

    try {
      const response = await fetch(`${streamAbortPoolInfo.url}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer pool-secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'test-model', input: 'hello', stream: true })
      });
      await response.text();
    } catch {
      // The client sees the broken stream; the pool must mark the upstream unhealthy for later requests.
    }
    await sleep(20);

    const streamAbortStatus = (await getJson(`${streamAbortPoolInfo.url}/pool/status`, 'pool-secret')).json;
    const cooledStreamSite = streamAbortStatus.upstreams.find((upstream) => upstream.name === 'stream-abort');
    if (!cooledStreamSite || cooledStreamSite.cooldown_ms <= 0 || cooledStreamSite.last_status !== 502) {
      throw new Error(`expected stream abort to cool down the failing site: ${JSON.stringify(cooledStreamSite)}`);
    }
    if (cooledStreamSite.availability?.samples !== 1 || cooledStreamSite.availability?.successes !== 0 || cooledStreamSite.availability?.failures !== 1) {
      throw new Error(`expected stream abort to record an availability failure: ${JSON.stringify(cooledStreamSite?.availability)}`);
    }
    const streamError = streamAbortStatus.recent_requests?.find((item) => item.upstream === 'stream-abort');
    if (!streamError || streamError.outcome !== 'stream_error' || streamError.status !== 502) {
      throw new Error(`expected stream abort recent request to be recorded as stream_error 502: ${JSON.stringify(streamError)}`);
    }

    const afterAbortResult = await requestJson(streamAbortPoolInfo.url, 'pool-secret');
    if (afterAbortResult.response.status !== 200 || afterAbortResult.response.headers.get('x-codex-api-pool-upstream') !== 'next-model-site') {
      throw new Error(`expected stream-aborted site to be skipped: ${afterAbortResult.response.status} ${afterAbortResult.text}`);
    }
  } finally {
    await close(streamAbortPool);
  }

  const availabilityStatsPath = path.join(statsRoot, 'availability-persist.json');
  const availabilityPoolConfig = {
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 1,
      failure_threshold: 20,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    availability: {
      window_size: 50,
      min_samples: 10,
      boost_threshold: 0.95,
      healthy_threshold: 0.9,
      degraded_threshold: 0.75,
      poor_threshold: 0.5
    },
    health: {
      enabled: false,
      path: '/models',
      timeout_ms: 1000
    },
    upstreams: [
      { name: 'unstable-high', base_url: `${goodInfo.url}/v1`, weight: 10, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'steady-low', base_url: `${nextModelSiteInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  };
  const availabilityPool = createTestPool(availabilityPoolConfig, { statsPath: availabilityStatsPath });
  const availabilityInfo = await listen(availabilityPool);
  const originalAvailabilityRandom = Math.random;
  try {
    availabilityPool.state.upstreams.find((upstream) => upstream.name === 'unstable-high').stats.availability.samples = Array(10).fill(0);
    availabilityPool.state.upstreams.find((upstream) => upstream.name === 'steady-low').stats.availability.samples = Array(10).fill(1);
    Math.random = () => 0.6;
    const availabilityResult = await requestJson(availabilityInfo.url, 'pool-secret');
    if (availabilityResult.response.status !== 200 || availabilityResult.response.headers.get('x-codex-api-pool-upstream') !== 'steady-low') {
      throw new Error(`expected availability multiplier to prefer steady-low despite lower base weight: ${availabilityResult.response.status} ${availabilityResult.text}`);
    }
    const availabilityStatus = (await getJson(`${availabilityInfo.url}/pool/status`, 'pool-secret')).json;
    const unstableHigh = availabilityStatus.upstreams.find((upstream) => upstream.name === 'unstable-high');
    const steadyLow = availabilityStatus.upstreams.find((upstream) => upstream.name === 'steady-low');
    if (unstableHigh.availability?.samples !== 10 || unstableHigh.availability?.rate !== 0 || unstableHigh.availability?.multiplier !== 0.08 || unstableHigh.selection_weight !== 0.8) {
      throw new Error(`expected unstable-high availability to heavily reduce selection weight: ${JSON.stringify(unstableHigh?.availability)} / ${unstableHigh?.selection_weight}`);
    }
    if (steadyLow.availability?.samples !== 11 || steadyLow.availability?.successes !== 11 || steadyLow.availability?.multiplier !== 1.2 || steadyLow.selection_weight !== 1.2) {
      throw new Error(`expected steady-low availability to keep boosted selection weight after success: ${JSON.stringify(steadyLow?.availability)} / ${steadyLow?.selection_weight}`);
    }
    if (!(steadyLow.selection_score > unstableHigh.selection_score)) {
      throw new Error(`expected dynamic selection score to rank steady-low above unstable-high: ${steadyLow.selection_score} / ${unstableHigh.selection_score}`);
    }
  } finally {
    Math.random = originalAvailabilityRandom;
    await close(availabilityPool);
  }

  const restoredAvailabilityPool = createTestPool(availabilityPoolConfig, { statsPath: availabilityStatsPath });
  const restoredAvailabilityInfo = await listen(restoredAvailabilityPool);
  try {
    const restoredStatus = (await getJson(`${restoredAvailabilityInfo.url}/pool/status`, 'pool-secret')).json;
    const restoredUnstable = restoredStatus.upstreams.find((upstream) => upstream.name === 'unstable-high');
    if (restoredUnstable.availability?.samples !== 10 || restoredUnstable.availability?.failures !== 10 || restoredUnstable.availability?.multiplier !== 0.08) {
      throw new Error(`expected availability window to persist across restart: ${JSON.stringify(restoredUnstable?.availability)}`);
    }
    restoredAvailabilityPool.state.upstreams.find((upstream) => upstream.name === 'steady-low').cooldownUntil = Date.now() + 30000;
    const cooledStatus = (await getJson(`${restoredAvailabilityInfo.url}/pool/status`, 'pool-secret')).json;
    const cooledSteady = cooledStatus.upstreams.find((upstream) => upstream.name === 'steady-low');
    if (cooledSteady.available !== false || cooledSteady.selection_score !== 0) {
      throw new Error(`expected cooled upstream to be unavailable with zero dynamic selection score: ${JSON.stringify(cooledSteady)}`);
    }
  } finally {
    await close(restoredAvailabilityPool);
  }

  const siteFallbackPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    retry: {
      max_attempts: 2,
      failure_threshold: 2,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: {
      enabled: false,
      path: '/models',
      timeout_ms: 1000
    },
    upstreams: [
      { name: 'cloudflare-timeout', base_url: `${cloudflareTimeoutInfo.url}/v1`, weight: 10, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'next-model-site', base_url: `${nextModelSiteInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const siteFallbackInfo = await listen(siteFallbackPool);
  try {
    await postJson(`${siteFallbackInfo.url}/pool/upstreams/cloudflare-timeout/probe`, 'pool-secret', {});
    await postJson(`${siteFallbackInfo.url}/pool/upstreams/next-model-site/probe`, 'pool-secret', {});
    await postJson(`${siteFallbackInfo.url}/pool/model`, 'pool-secret', { model: 'cf-only-model' });

    const siteFallbackResult = await requestJson(siteFallbackInfo.url, 'pool-secret');
    if (siteFallbackResult.response.status !== 200) {
      throw new Error(`expected site fallback 200, got ${siteFallbackResult.response.status}: ${siteFallbackResult.text}`);
    }
    if (siteFallbackResult.response.headers.get('x-codex-api-pool-upstream') !== 'next-model-site') {
      throw new Error(`expected fallback to next-model-site, got ${siteFallbackResult.response.headers.get('x-codex-api-pool-upstream')}`);
    }
    if (siteFallbackResult.json.body?.model !== 'cf-only-model') {
      throw new Error(`expected model to stay cf-only-model after 522 site fallback: ${siteFallbackResult.text}`);
    }

    const siteFallbackStatus = (await getJson(`${siteFallbackInfo.url}/pool/status`, 'pool-secret')).json;
    const cooledSite = siteFallbackStatus.upstreams.find((upstream) => upstream.name === 'cloudflare-timeout');
    if (!cooledSite || cooledSite.cooldown_ms <= 0) {
      throw new Error(`expected retryable 522 failure to cool down the failing site: ${JSON.stringify(cooledSite)}`);
    }
    const latest = siteFallbackStatus.recent_requests?.[0];
    if (!latest || latest.originalModel !== 'test-model' || latest.actualModel !== 'cf-only-model' || latest.upstream !== 'next-model-site') {
      throw new Error(`expected recent request to show original -> actual -> upstream: ${JSON.stringify(latest)}`);
    }
    const nextFallbackResult = await requestJson(siteFallbackInfo.url, 'pool-secret');
    if (nextFallbackResult.response.status !== 200 || nextFallbackResult.response.headers.get('x-codex-api-pool-upstream') !== 'next-model-site') {
      throw new Error(`expected cooled 522 site to be skipped on the next request: ${nextFallbackResult.response.status} ${nextFallbackResult.text}`);
    }
  } finally {
    await close(siteFallbackPool);
  }

  console.log('smoke ok: auth guard, fallback, upstream enable toggle, token usage accounting, availability scoring, billing accounting, billing main-path isolation, billing huge-limit guard, billing blocked detection, runtime add, config-preserving edit, JSON import, Codex OAuth import/forwarding, model discovery, anthropic model probe, model override, stream-error cooldown, 400/522 site fallback, recent requests, and immediate health probe all passed');
} finally {
  await close(codexOauthProxy);
  await close(codexOauthCompactOnlyBackend);
  await close(codexOauthBackend);
  await close(nextModelSite);
  await close(streamAbort);
  await close(cloudflareTimeout);
  await close(pool);
  await close(dualProtocolModels);
  await close(anthropicModels);
  await close(billingLoginHtmlUpstream);
  await close(billingBlockedUpstream);
  await close(billingHugeLimitUpstream);
  await close(billingUpstream);
  await close(anthropicMessages);
  await close(responsesMissingCompleted);
  await close(usageUpstream);
  await close(added);
  await close(good);
  await close(modelError);
  await close(bad);
}
