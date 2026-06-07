import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-smoke-'));
let statsIndex = 0;

function createTestPool(config) {
  statsIndex += 1;
  return createPoolServer(config, { statsPath: path.join(statsRoot, `stats-${statsIndex}.json`) });
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const address = server.address();
      resolve({ host, port: address.port, url: `http://${host}:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
  if (req.url === '/api/v1/credits') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ balance: 65.51, used: 9.49, today_cost: 0.42, currency: 'usd' }));
    return;
  }
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

const cloudflareTimeout = createFakeUpstream('cloudflare-timeout', ({ req, res }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'cf-only-model' }] }));
    return;
  }
  res.writeHead(522, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>522: Connection timed out</title>');
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
const cloudflareTimeoutInfo = await listen(cloudflareTimeout);
const nextModelSiteInfo = await listen(nextModelSite);
const anthropicModelsInfo = await listen(anthropicModels);

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
    'Upstream Workbench rows'
  ];
  for (const marker of requiredDashboardRegions) {
    if (!dashboard.text.includes(marker)) {
      throw new Error(`expected dashboard HTML to include ${marker}`);
    }
  }
  if (!dashboard.text.includes('Management Dashboard') || !dashboard.text.includes('Operational Console')) {
    throw new Error('expected dashboard HTML to expose Management Dashboard / Operational Console structure');
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
    if (!usageSite || usageSite.usage?.total_tokens !== 93 || usageSite.usage?.input_tokens !== 29 || usageSite.usage?.output_tokens !== 64 || usageSite.usage?.today_tokens !== 93 || usageByDayTotal !== 93) {
      throw new Error(`expected per-upstream token usage to total 93 with input/output split: ${JSON.stringify(usageSite?.usage)}`);
    }
    if (usageStatus.usage?.total_tokens !== 93 || usageStatus.usage?.input_tokens !== 29 || usageStatus.usage?.output_tokens !== 64 || usageStatus.usage?.today_tokens !== 93) {
      throw new Error(`expected global token usage to total 93 with input/output split: ${JSON.stringify(usageStatus.usage)}`);
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
        keys: [{ env: 'TEST_UPSTREAM_KEY' }],
        billing: {
          credits_base_url: billingHugeLimitInfo.url,
          credits_path: '/api/v1/credits'
        }
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
    if (billing.limit_amount !== null || billing.balance_amount !== 65.51 || billing.used_amount !== 9.49 || billing.limit_placeholder !== true) {
      throw new Error(`expected credits API balance to override huge placeholder limit: ${JSON.stringify(billing)}`);
    }
    const status = (await getJson(`${hugeLimitBillingInfo.url}/pool/status`, 'pool-secret')).json;
    const site = status.upstreams.find((upstream) => upstream.name === 'billing-huge-limit');
    if (site?.billing?.limit_amount !== null || site?.billing?.balance_amount !== 65.51 || status.billing?.limit_amount !== null || status.billing?.balance_amount !== 65.51) {
      throw new Error(`expected status aggregation to keep credits API balance and ignore huge placeholder limits: ${JSON.stringify(status.billing)} / ${JSON.stringify(site?.billing)}`);
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
  } finally {
    await close(blockedBillingPool);
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
  if (!replaced || replaced.site_url !== `${addedInfo.url}/signin` || replaced.weight !== 3) {
    throw new Error(`expected replace to preserve site_url and update weight: ${JSON.stringify(replaced)}`);
  }
  if (!statusAfterReplace.model?.known?.includes('added-model-b')) {
    throw new Error(`expected replace to keep model cache warm: ${JSON.stringify(statusAfterReplace.model)}`);
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

  const modelResult = await postJson(`${poolInfo.url}/pool/model`, 'pool-secret', { model: 'added-model-b' });
  if (modelResult.response.status !== 200 || modelResult.json.model_override !== 'added-model-b') {
    throw new Error(`expected model override to be saved: ${modelResult.text}`);
  }

  const overrideResult = await requestJson(poolInfo.url, 'pool-secret');
  if (overrideResult.response.status !== 200 || overrideResult.json.body?.model !== 'added-model-b') {
    throw new Error(`expected request model to be overridden: ${overrideResult.text}`);
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
    const latest = siteFallbackStatus.recent_requests?.[0];
    if (!latest || latest.originalModel !== 'test-model' || latest.actualModel !== 'cf-only-model' || latest.upstream !== 'next-model-site') {
      throw new Error(`expected recent request to show original -> actual -> upstream: ${JSON.stringify(latest)}`);
    }
  } finally {
    await close(siteFallbackPool);
  }

  console.log('smoke ok: auth guard, fallback, upstream enable toggle, token usage accounting, billing accounting, billing huge-limit guard, billing blocked detection, runtime add, config-preserving edit, model discovery, anthropic model probe, model override, 400/522 site fallback, recent requests, and immediate health probe all passed');
} finally {
  await close(nextModelSite);
  await close(cloudflareTimeout);
  await close(pool);
  await close(anthropicModels);
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
