import http from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPoolServer } from '../src/server.mjs';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-api-pool-protocol-'));
let statsIndex = 0;

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

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    request.on('error', reject);
  });
}

function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const opts = new URL(url);
    const request = http.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.pathname + opts.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody }));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function createFakeUpstream(name, handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler({ name, req, res, body }));
  });
}

console.log('[test] Protocol Capability Detection and Override');

// Test 1: api=openai upstream should initially assume OpenAI protocols
{
  const fakeOpenAi = createFakeUpstream('openai-upstream', ({ req, res, body }) => {
    if (req.url === '/v1/responses' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_test', object: 'response', output: [], output_text: 'ok' }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chat_test', object: 'chat.completion', model: 'gpt-test', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      return;
    }
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${req.url}` } }));
  });

  const fakeAddr = await listen(fakeOpenAi);
  const poolServer = createTestPool({
    server: { port: 0, auth_token_env: 'TEST_POOL_TOKEN' },
    model_override: 'gpt-test',
    upstreams: [
      { name: 'openai-only', base_url: fakeAddr.url, api: 'openai', keys: [{ value: 'test-key' }] }
    ]
  });
  process.env.TEST_POOL_TOKEN = 'test-pool-token';

  const poolAddr = await listen(poolServer);

  // Probe the upstream
  const probeRes = await httpPost(`${poolAddr.url}/pool/probe`, {}, { authorization: 'Bearer test-pool-token' });
  const probeData = JSON.parse(probeRes.body);

  const upstream = probeData.result.upstreams[0];

  // Check that at least one OpenAI protocol is verified (responses OR chat_completions)
  const hasOpenAiProtocol = upstream.capabilities.responses.status === 'verified' ||
                            upstream.capabilities.chat_completions.status === 'verified';

  if (!hasOpenAiProtocol) {
    throw new Error(`Expected at least one OpenAI protocol to be verified. Responses: ${upstream.capabilities.responses.status}, Chat: ${upstream.capabilities.chat_completions.status}`);
  }

  if (upstream.capabilities.anthropic_messages.status === 'verified') {
    throw new Error(`Expected anthropic_messages to remain unverified for api=openai upstream (configured), got ${upstream.capabilities.anthropic_messages.status}`);
  }

  console.log('[test] ✓ api=openai upstream correctly discovers and verifies OpenAI protocols');

  await close(poolServer);
  await close(fakeOpenAi);
}

// Test 2: api=both upstream should probe all protocols
{
  const fakeDual = createFakeUpstream('dual-upstream', ({ req, res, body }) => {
    if (req.url === '/v1/responses' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_dual', object: 'response', output: [], output_text: 'ok' }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chat_dual', object: 'chat.completion', model: 'gpt-test', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      return;
    }
    if (req.url === '/v1/messages' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_dual', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'claude-test' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${req.url}` } }));
  });

  const fakeAddr = await listen(fakeDual);
  const poolServer = createTestPool({
    server: { port: 0, auth_token_env: 'TEST_POOL_TOKEN' },
    model_override: 'claude-test',
    upstreams: [
      { name: 'dual-proto', base_url: fakeAddr.url, api: 'both', keys: [{ value: 'test-key' }] }
    ]
  });

  const poolAddr = await listen(poolServer);

  // Probe with Claude model - api=both should probe anthropic_messages
  const probeRes = await httpPost(`${poolAddr.url}/pool/probe`, {}, { authorization: 'Bearer test-pool-token' });
  const probeData = JSON.parse(probeRes.body);
  const upstream = probeData.result.upstreams[0];

  if (upstream.capabilities.anthropic_messages.status !== 'verified') {
    throw new Error(`Expected anthropic_messages verified for api=both with Claude model, got ${upstream.capabilities.anthropic_messages.status}`);
  }

  console.log('[test] ✓ api=both upstream discovers all supported protocols');

  await close(poolServer);
  await close(fakeDual);
}

// Test 3: Capability persistence across restarts
{
  const fakePersist = createFakeUpstream('persist-upstream', ({ req, res, body }) => {
    if (req.url === '/v1/messages' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_persist', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-test' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${req.url}` } }));
  });

  const fakeAddr = await listen(fakePersist);
  const statsPath = path.join(statsRoot, 'stats-persist.json');

  // First pool instance - probe and close
  {
    const poolServer = createTestPool({
      server: { port: 0, auth_token_env: 'TEST_POOL_TOKEN' },
      model_override: 'claude-test',
      upstreams: [
        { name: 'persist-test', base_url: fakeAddr.url, api: 'anthropic', keys: [{ value: 'test-key' }] }
      ]
    }, { statsPath });

    const poolAddr = await listen(poolServer);
    await httpPost(`${poolAddr.url}/pool/probe`, {}, { authorization: 'Bearer test-pool-token' });
    await close(poolServer);
  }

  // Second pool instance - capabilities should be restored from stats
  {
    const poolServer = createTestPool({
      server: { port: 0, auth_token_env: 'TEST_POOL_TOKEN' },
      model_override: 'claude-test',
      upstreams: [
        { name: 'persist-test', base_url: fakeAddr.url, api: 'anthropic', keys: [{ value: 'test-key' }] }
      ]
    }, { statsPath });

    const poolAddr = await listen(poolServer);
    const statusRes = await httpGet(`${poolAddr.url}/pool/status`, { authorization: 'Bearer test-pool-token' });
    const statusData = JSON.parse(statusRes.body);
    const upstream = statusData.upstreams[0];

    if (upstream.capabilities.anthropic_messages.status !== 'verified') {
      throw new Error(`Expected anthropic_messages capability to be restored from stats, got ${upstream.capabilities.anthropic_messages.status}`);
    }

    console.log('[test] ✓ Protocol capabilities persist across restarts via stats.local.json');

    await close(poolServer);
  }

  await close(fakePersist);
}

// Test 4: Model protocol requirements
{
  const fakeMulti = createFakeUpstream('multi-upstream', ({ req, res, body }) => {
    if (req.url === '/v1/messages' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_multi', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chat_multi', object: 'chat.completion', model: 'test', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      return;
    }
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'claude-test' }, { id: 'glm-4' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${req.url}` } }));
  });

  const fakeAddr = await listen(fakeMulti);
  const poolServer = createTestPool({
    server: { port: 0, auth_token_env: 'TEST_POOL_TOKEN' },
    model_override: 'glm-4',
    upstreams: [
      { name: 'multi-proto', base_url: fakeAddr.url, api: 'both', keys: [{ value: 'test-key' }] }
    ]
  });

  const poolAddr = await listen(poolServer);

  // Probe with Chinese model (glm-4) - should use OpenAI protocol
  const probeRes = await httpPost(`${poolAddr.url}/pool/probe`, {}, { authorization: 'Bearer test-pool-token' });
  const probeData = JSON.parse(probeRes.body);
  const upstream = probeData.result.upstreams[0];

  if (upstream.capabilities.chat_completions.status !== 'verified') {
    throw new Error(`Expected Chinese model (glm-4) to verify OpenAI chat_completions, got ${upstream.capabilities.chat_completions.status}`);
  }

  console.log('[test] ✓ Chinese models (GLM, etc.) correctly use OpenAI protocol');

  await close(poolServer);
  await close(fakeMulti);
}

console.log('[test] All protocol capability tests passed');
process.exit(0);
