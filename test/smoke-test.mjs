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

  const statusAfterAdd = await (await fetch(`${poolInfo.url}/pool/status`)).json();
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
  const statusAfterReplace = await (await fetch(`${poolInfo.url}/pool/status`)).json();
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

    const siteFallbackStatus = await (await fetch(`${siteFallbackInfo.url}/pool/status`)).json();
    const latest = siteFallbackStatus.recent_requests?.[0];
    if (!latest || latest.originalModel !== 'test-model' || latest.actualModel !== 'cf-only-model' || latest.upstream !== 'next-model-site') {
      throw new Error(`expected recent request to show original -> actual -> upstream: ${JSON.stringify(latest)}`);
    }
  } finally {
    await close(siteFallbackPool);
  }

  console.log('smoke ok: auth guard, fallback, runtime add, config-preserving edit, model discovery, anthropic model probe, model override, 400/522 site fallback, recent requests, and immediate health probe all passed');
} finally {
  await close(nextModelSite);
  await close(cloudflareTimeout);
  await close(pool);
  await close(anthropicModels);
  await close(added);
  await close(good);
  await close(modelError);
  await close(bad);
}
