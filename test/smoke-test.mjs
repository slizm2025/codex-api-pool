import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { __testInternals, createPoolServer } from '../src/server.mjs';
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

function createConnectProxy() {
  const server = http.createServer();
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = String(req.url || '').split(':');
    const targetSocket = net.connect(Number(port || 443), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => targetSocket.destroy());
  });
  return server;
}

const lateTlsErrorKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDeDnT49y/HKRfF
E4wLfWVkxcdztXTS5z0NWybL/+Canrf1W4eoBoeM3hKaLbRUqIxliWdtjun3PKld
tXyTcMcOdtoQ3ejBvkaQ42rYycPiYmGujXkC66FHP5d1x3a0yl8VAAhSFebIYPlT
Hcu9pagzDyCdKgNFRRdPiiheOdeOMAv0qPnOvTCtCVcSA7l+EXiG+l8/ItqlOCmk
jbqQDZFOy8hC6Dp/mNbMwCrN4Ns1bDKZxfta1iSspTisgU5vmzw0sBMQVQfgSgjS
Ku+mX4ewPzj3AqCs3jhqDf/uPKUPDnKHqSkHqGTE8I0Jm9MfjrrTniruIPj8aTGr
cbrqVQ/TAgMBAAECggEBAL5O95MUDj+LCVMesIx8WLSoCIszPb8u7RUQRMzbLDx3
wMMoQbgQeIWTIbA/cWiI12KCA0FTFVOOCr1EOFMIeaD83WFNPhkloMa2ETFgol/X
303A87A8D4nHh2AqpaLGOfz+fSMUoCila6j/RUjwu5me4l2vzwPD9fl2N6ihvAqf
rAiLaR/PjAQV860KgjVjRKtXUZVFDdjupSK13xVdKKv/D1LVRBb7I3B6OFei5G+Y
a8xYJGeZVeonftvzMq9dhy73NC67lye86J3Exw7uksCfwh3sfDjxl4Jka01Rwuqq
rcKP7O87IgrS+2Jv+dKmu77JIhqnYNX4csxZUDreXDkCgYEA9mtrLpde3h5VC0CZ
Y56nFPragXkDZNEd70gDufKZQxNP2OpwYYEiauQZt+8lDew4eGkYhzps4dMhh5nD
PdAtNHWh6EOb950kpLm2/LxTMYsJaAD1JgOsiMFRjwPuusitJSHDLOdiDaPSNgXk
nJCVUTndKv8MQvYRZG0h3QBsQh0CgYEA5rCOJTpdTDpwbATosh1b5QmK4nhp1s0V
8FFb0Zvoeb7NGXS3Bi8OpGjTxKI8gqPZVaG1Jfz9JZvhqRl6iaYkfLBkGZbv2WcV
lTLU9pWqhIU7fe/iFn72Rvq33cxw7Wd59CeNnFepSivwTzInYVqNU39OKmHLfeE3
1Yj4BWI89q8CgYADfUHnRv1w570Mi72gS37SLTsq2ivSIaPq33ouB+FjscJPsAIn
X0y9dr1mfVxo9g9WpSZTw+AG0paG9QZuuaPqOkAwqcRrnS4HpxmQOppy+SUI8/qE
r0iiJxqgi821l2HcRL4exKf+yXMQkMTL8sAqhkc7dKEX0aQtZ94y4u6lgQKBgEEq
ZK0NhKdw5qsM4/LUqk3T2UDKRROhkW32fZqDkTM6+9MSDlWX22oEFrY4IiHBSTaQ
XIyjn5sNIrzS7rONlEcIyO4VniFqpkUkO9aARs/ylvCnX9V8/fLlBiWIh+n4ThHz
TmR4uuCx8stcXpV4r+2DS8BbKdGgWlZev7k9m/0PAoGAY/ZpI9VJoXBLGEWze+BN
TGS8YsW7HcXCljqfItaCRtH9ZcIG6PvaRqG3FeuHmM7w9vVMkfISBUuK25xiu57/
zRsD/gELmpQ5L3ZlCNDeGxNJo++FJ5bjHeWFczbET7Jf9LPZuIpfaRB6Y/rGv4V1
AKbzUTYS6G81quBHTLufI8c=
-----END PRIVATE KEY-----`;

const lateTlsErrorCert = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQDmhbq2yrY7VTANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjYwNjA5MDYxMTIzWhcNMjYwNjEwMDYxMTIzWjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDe
DnT49y/HKRfFE4wLfWVkxcdztXTS5z0NWybL/+Canrf1W4eoBoeM3hKaLbRUqIxl
iWdtjun3PKldtXyTcMcOdtoQ3ejBvkaQ42rYycPiYmGujXkC66FHP5d1x3a0yl8V
AAhSFebIYPlTHcu9pagzDyCdKgNFRRdPiiheOdeOMAv0qPnOvTCtCVcSA7l+EXiG
+l8/ItqlOCmkjbqQDZFOy8hC6Dp/mNbMwCrN4Ns1bDKZxfta1iSspTisgU5vmzw0
sBMQVQfgSgjSKu+mX4ewPzj3AqCs3jhqDf/uPKUPDnKHqSkHqGTE8I0Jm9MfjrrT
niruIPj8aTGrcbrqVQ/TAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAIs1KTZdQu3H
t2S8QR4GKsYtHDFpsxXm/Z/cSz8m6OVdq3bFjMER0GDC6rSy4Dl4YL37AW5jRBOC
S6IqEo2IqD50inQNULrU68/+OwnOA0sUDTJHINvjiXsCYy0jOrY/fc99bVTW+pGe
/WSPPZjTqhuEQA98bHviNi0+48Jum0odmRxIweoRn7AYs+UZny3trQmR3UpFyD6L
I+rIZ0s8UOnTrqbfR5fhUgzmwOZH5/wmNxx5bQ3uKieFlJlETA0EkHTxnStybnUv
YufnQ0pxWz1KHhrTkW/p+BrtIHSqshC3RPNvRSZGYZbTWgeWewBzH4yu6+auK/dN
mPUvOW2Y5GE=
-----END CERTIFICATE-----`;

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
    'x-saw-authorization': req.headers.authorization ? 'yes' : 'no',
    'x-saw-x-api-key': req.headers['x-api-key'] ? 'yes' : 'no',
    'x-saw-api-key': req.headers['api-key'] ? 'yes' : 'no',
    'x-saw-anthropic-version': req.headers['anthropic-version'] ? 'yes' : 'no',
    'x-saw-openai-organization': req.headers['openai-organization'] ? 'yes' : 'no'
  });
  res.end(JSON.stringify({ ok: true, id: 'resp_good', object: 'response', output_text: 'ok', body: JSON.parse(body) }));
});

const added = createFakeUpstream('added', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'added-model-a' }, { id: 'added-model-b' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, id: 'resp_added', object: 'response', output_text: 'ok', added: true, body: JSON.parse(body) }));
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
    output_text: 'usage-ok',
    body: payload,
    usage: {
      input_tokens: 11,
      output_tokens: 26,
      total_tokens: 37
    }
  }));
});

const zeroOutputUsage = createFakeUpstream('zero-output-usage', ({ req, res }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'resp_zero_output',
    object: 'response',
    output_text: 'looks-ok-but-no-output-tokens',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'looks-ok-but-no-output-tokens' }] }],
    usage: {
      input_tokens: 9,
      output_tokens: 0,
      total_tokens: 9
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

const responsesDataOnly = createFakeUpstream('responses-data-only', ({ req, res }) => {
  if (req.url.endsWith('/models') || req.url.endsWith('/responses')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const responsesObjectOnly = createFakeUpstream('responses-object-only', ({ req, res }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  if (req.url.endsWith('/responses')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_object_only', object: 'response' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const chatChoicesEmpty = createFakeUpstream('chat-choices-empty', ({ req, res }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  if (req.url.endsWith('/responses')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'responses unsupported' }));
    return;
  }
  if (req.url.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl_empty', object: 'chat.completion', choices: [] }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const anthropicContentEmpty = createFakeUpstream('anthropic-content-empty', ({ req, res }) => {
  if (req.url === '/v1/models' && req.headers['x-api-key'] === 'upstream-secret' && req.headers['anthropic-version']) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-test' }] }));
    return;
  }
  if (req.url === '/v1/messages' && req.headers['x-api-key'] === 'upstream-secret' && req.headers['anthropic-version']) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_empty',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-test'
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

let chatOnlyResponsesHits = 0;
let chatOnlyChatHits = 0;
const chatOnly = createFakeUpstream('chat-only', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'models unsupported' }));
    return;
  }
  if (req.url.endsWith('/responses')) {
    chatOnlyResponsesHits += 1;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'responses unsupported' }));
    return;
  }
  if (req.url.endsWith('/chat/completions')) {
    chatOnlyChatHits += 1;
    const payload = JSON.parse(body);
    const leakedFields = ['previous_response_id', 'include', 'reasoning', 'text', 'truncation', 'background', 'conversation']
      .filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
    if (leakedFields.length > 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expected chat payload to be scrubbed of Responses-only fields', leakedFields, payload }));
      return;
    }
    const lastContent = payload.messages.at(-1)?.content;
    if (!['test-model', 'gpt-5.5'].includes(payload.model) || !Array.isArray(payload.messages) || !['hello', 'ping', 'please use tool'].includes(lastContent)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expected chat completions payload', payload }));
      return;
    }
    if (lastContent === 'please use tool') {
      const tool = payload.tools?.[0];
      if (
        tool?.type !== 'function' ||
        tool.function?.name !== 'lookup_weather' ||
        tool.function?.parameters?.properties?.location?.type !== 'string' ||
        payload.tool_choice?.type !== 'function' ||
        payload.tool_choice?.function?.name !== 'lookup_weather'
      ) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected chat tool payload', payload }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-tool-json',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_chat_weather',
              type: 'function',
              function: { name: 'lookup_weather', arguments: '{"location":"Shanghai"}' }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
      return;
    }
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-json',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

let cachedChatThenNativeResponsesHits = 0;
let cachedChatThenNativeChatHits = 0;
const cachedChatThenNative = createFakeUpstream('cached-chat-then-native', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  if (req.url.endsWith('/responses')) {
    cachedChatThenNativeResponsesHits += 1;
    const payload = JSON.parse(body || '{}');
    const hasNativeResponsesFeature = Array.isArray(payload.tools)
      && payload.tools.some((tool) => tool?.type && tool.type !== 'function');
    const hasNativeToolChoice = payload.tool_choice?.type
      && !['function', 'auto', 'none', 'required'].includes(payload.tool_choice.type);
    const hasNativeOnlyTextFormat = payload.text?.format?.type === 'grammar';
    const hasNativeOnlyInput = Array.isArray(payload.input) && payload.input.some((item) => {
      if (!item || typeof item !== 'object') return false;
      if (item.type && !['message', 'function_call', 'function_call_output'].includes(item.type)) return true;
      const content = item.content ?? item.text ?? item.message;
      return Array.isArray(content) && content.some((block) => block && typeof block === 'object' && block.type && !['text', 'input_text', 'output_text'].includes(block.type));
    });
    if (!hasNativeResponsesFeature && !hasNativeToolChoice && !hasNativeOnlyTextFormat && !hasNativeOnlyInput) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'responses unsupported for plain requests' }));
      return;
    }
    if (payload.metadata?.wrong_content_type_test === true && req.headers['content-type'] !== 'application/json') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expected proxy to normalize JSON content-type for native Responses', headers: req.headers, payload }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      id: 'resp_cached_native',
      object: 'response',
      output_text: 'native-ok',
      body: payload
    }));
    return;
  }
  if (req.url.endsWith('/chat/completions')) {
    cachedChatThenNativeChatHits += 1;
    const payload = JSON.parse(body || '{}');
    const leakedNativeTool = payload.tools?.find?.((tool) => tool?.type && tool.type !== 'function');
    const leakedNativeToolChoice = payload.tool_choice?.type
      && !['function', 'auto', 'none', 'required'].includes(payload.tool_choice.type);
    if (leakedNativeTool || leakedNativeToolChoice) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'native Responses tool state must not be converted to chat', leakedNativeTool, leakedNativeToolChoice, payload }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-cached-json',
      object: 'chat.completion',
      created: 1,
      model: payload.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'cached-pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

let anthropicMessagesHits = 0;
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
  anthropicMessagesHits += 1;
  const payload = JSON.parse(body);
  const leakedFields = ['previous_response_id', 'include', 'reasoning', 'text', 'truncation', 'parallel_tool_calls']
    .filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (leakedFields.length > 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'expected anthropic payload to be scrubbed of Responses-only fields', leakedFields, payload }));
    return;
  }
  const firstMessageText = payload.messages?.[0]?.content?.find?.((block) => block?.type === 'text')?.text || '';
  if (firstMessageText === 'need weather') {
    const tool = payload.tools?.[0];
    const toolUse = payload.messages?.[1]?.content?.[0];
    const toolResult = payload.messages?.[2]?.content?.[0];
    if (
      tool?.name !== 'lookup_weather' ||
      tool.input_schema?.properties?.location?.type !== 'string' ||
      payload.tool_choice?.type !== 'tool' ||
      payload.tool_choice?.name !== 'lookup_weather' ||
      toolUse?.type !== 'tool_use' ||
      toolUse.id !== 'call_weather_1' ||
      toolUse.name !== 'lookup_weather' ||
      toolUse.input?.location !== 'Shanghai' ||
      toolResult?.type !== 'tool_result' ||
      toolResult.tool_use_id !== 'call_weather_1' ||
      !String(toolResult.content || '').includes('sunny')
    ) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected anthropic tool payload', payload }));
      return;
    }
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_tool_test', type: 'message', role: 'assistant', model: payload.model, usage: { input_tokens: 4, output_tokens: 1 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_weather_2', name: 'lookup_weather', input: {} } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"location":"Shanghai"}' } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } })}\n\n`);
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_tool_test',
      type: 'message',
      role: 'assistant',
      model: payload.model,
      content: [{ type: 'tool_use', id: 'toolu_weather_2', name: 'lookup_weather', input: { location: 'Shanghai' } }],
      usage: { input_tokens: 4, output_tokens: 3 }
    }));
    return;
  }
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

const streamAbort = createFakeUpstream('stream-abort', ({ req, res, body }) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    return;
  }
  const payload = JSON.parse(body || '{}');
  if (!payload.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_stream_probe', object: 'response', output: [], output_text: 'ok' }));
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
  res.end(JSON.stringify({ ok: true, id: 'resp_next_model', object: 'response', output_text: 'ok', body: JSON.parse(body) }));
});

const anthropicModels = createFakeUpstream('anthropic-models', ({ req, res }) => {
  if (req.url === '/v1/models' && req.headers['x-api-key'] === 'upstream-secret' && req.headers['anthropic-version']) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-test' }] }));
    return;
  }
  if (req.url === '/v1/messages' && req.headers['x-api-key'] === 'upstream-secret' && req.headers['anthropic-version']) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_anthropic_probe',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-test',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
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
  if (req.url === '/v1/messages' && req.headers['x-api-key'] === 'upstream-secret' && req.headers['anthropic-version']) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_dual_probe',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-test',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
    return;
  }
  if (req.url === '/v1/responses' && req.headers.authorization === 'Bearer upstream-secret') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_dual_probe',
      object: 'response',
      output: [],
      output_text: 'ok'
    }));
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
let codexOauthRequestCount = 0;
const codexOauthBackend = createFakeUpstream('codex-oauth-backend', ({ req, res, body }) => {
  codexOauthLastRequest = { url: req.url, headers: req.headers, body };
  codexOauthRequestCount += 1;
  if (
    req.url === '/backend-api/codex/responses'
    && req.headers.authorization === 'Bearer oauth-secret'
    && req.headers['openai-beta'] === 'responses=experimental'
    && req.headers.originator === 'codex_cli_rs'
    && req.headers['chatgpt-account-id'] === 'chatgpt-acc'
    && /^codex_cli_rs\/0\.125\.0\b/.test(req.headers['user-agent'] || '')
    && req.headers['x-api-key'] === undefined
  ) {
    const payload = JSON.parse(body);
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_oauth_probe', object: 'response', output: [], output_text: 'ok' } })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: 'resp_oauth', object: 'response', output_text: 'ok', body: payload }));
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
const zeroOutputUsageInfo = await listen(zeroOutputUsage);
const responsesMissingCompletedInfo = await listen(responsesMissingCompleted);
const responsesDataOnlyInfo = await listen(responsesDataOnly);
const responsesObjectOnlyInfo = await listen(responsesObjectOnly);
const chatChoicesEmptyInfo = await listen(chatChoicesEmpty);
const anthropicContentEmptyInfo = await listen(anthropicContentEmpty);
const chatOnlyInfo = await listen(chatOnly);
const cachedChatThenNativeInfo = await listen(cachedChatThenNative);
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
  if (dashboard.text.includes('signinSortBucket')) {
    throw new Error('expected sign-in status to stay out of upstream sorting');
  }
  if (!dashboard.text.includes('enabledBucket(a) - enabledBucket(b)') || !dashboard.text.includes('usabilityBucket(a, activeModel) - usabilityBucket(b, activeModel)')) {
    throw new Error('expected upstream sorting to group enabled sites first, then usable enabled sites');
  }
  const availabilityHistorySourceIndex = dashboard.text.indexOf('...history.map((ok) =>');
  const availabilityEmptySourceIndex = dashboard.text.indexOf('...Array.from({ length: emptyCount }');
  if (availabilityHistorySourceIndex === -1 || availabilityEmptySourceIndex === -1 || availabilityHistorySourceIndex > availabilityEmptySourceIndex) {
    throw new Error('expected availability visualization to render real samples before trailing empty window slots');
  }

  const lateTlsErrorServer = tls.createServer({
    key: lateTlsErrorKey,
    cert: lateTlsErrorCert,
    ALPNProtocols: ['h2', 'http/1.1']
  }, (socket) => {
    socket.on('error', () => {});
  });
  const lateTlsErrorProxy = createConnectProxy();
  const originalTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const lateTlsErrorServerInfo = await listen(lateTlsErrorServer, 'localhost');
  const lateTlsErrorProxyInfo = await listen(lateTlsErrorProxy);
  try {
    const tunnelSocket = await __testInternals.openHttpProxyTunnel(
      lateTlsErrorProxyInfo.url,
      'localhost',
      lateTlsErrorServerInfo.port,
      1000
    );
    try {
      tunnelSocket.emit('error', new Error('late TLS socket EPIPE'));
      tunnelSocket.emit('error', new Error('second late TLS socket EPIPE'));
    } catch (error) {
      throw new Error(`expected late TLS socket errors to be guarded after CONNECT tunnel setup: ${error.message}`);
    } finally {
      tunnelSocket.destroy();
    }
  } finally {
    if (originalTlsRejectUnauthorized === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsRejectUnauthorized;
    await close(lateTlsErrorProxy);
    await close(lateTlsErrorServer);
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
    health: { enabled: false, path: '/models', timeout_ms: 50 },
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

  const sensitiveHeaderBody = JSON.stringify({ model: 'test-model', input: 'hello', stream: false });
  const sensitiveHeaderResponse = await fetch(`${poolInfo.url}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer pool-secret',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(sensitiveHeaderBody)),
      'x-api-key': 'client-secret-that-must-not-forward',
      'api-key': 'client-api-key-that-must-not-forward',
      'anthropic-version': '2023-06-01',
      'openai-organization': 'org-client-that-must-not-forward'
    },
    body: sensitiveHeaderBody
  });
  const sensitiveHeaderText = await sensitiveHeaderResponse.text();
  if (
    sensitiveHeaderResponse.status !== 200 ||
    sensitiveHeaderResponse.headers.get('x-saw-authorization') !== 'yes' ||
    sensitiveHeaderResponse.headers.get('x-saw-x-api-key') !== 'no' ||
    sensitiveHeaderResponse.headers.get('x-saw-api-key') !== 'no' ||
    sensitiveHeaderResponse.headers.get('x-saw-anthropic-version') !== 'no' ||
    sensitiveHeaderResponse.headers.get('x-saw-openai-organization') !== 'no'
  ) {
    throw new Error(`expected ordinary OpenAI-compatible forwarding to strip client auth/vendor headers: ${sensitiveHeaderResponse.status} ${sensitiveHeaderText}`);
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
    health: { enabled: false, path: '/models', timeout_ms: 50 },
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

  const zeroOutputUsagePool = createTestPool({
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
      failure_threshold: 5,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'zero-output-usage', base_url: `${zeroOutputUsageInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const zeroOutputUsagePoolInfo = await listen(zeroOutputUsagePool);
  try {
    const zeroOutputResult = await requestJson(zeroOutputUsagePoolInfo.url, 'pool-secret');
    if (zeroOutputResult.response.status !== 200) {
      throw new Error(`expected upstream HTTP 200 to still pass through to client: ${zeroOutputResult.response.status} ${zeroOutputResult.text}`);
    }
    const zeroOutputStatus = (await getJson(`${zeroOutputUsagePoolInfo.url}/pool/status`, 'pool-secret')).json;
    const zeroOutputSite = zeroOutputStatus.upstreams.find((upstream) => upstream.name === 'zero-output-usage');
    const zeroOutputRecent = zeroOutputStatus.recent_requests?.[0];
    if (
      zeroOutputSite?.stats?.successes !== 0 ||
      zeroOutputSite?.stats?.failures !== 1 ||
      zeroOutputSite?.availability?.samples !== 1 ||
      zeroOutputSite?.availability?.successes !== 0 ||
      zeroOutputSite?.availability?.failures !== 1 ||
      zeroOutputSite?.usage?.total_tokens !== 0
    ) {
      throw new Error(`expected HTTP 200 with output_tokens=0 to count as failed availability without token usage: ${JSON.stringify(zeroOutputSite)}`);
    }
    if (
      zeroOutputRecent?.outcome !== 'error' ||
      zeroOutputRecent?.status !== 200 ||
      zeroOutputRecent?.tokens !== 0 ||
      !String(zeroOutputRecent?.reason || '').includes('output tokens 0')
    ) {
      throw new Error(`expected recent request to expose zero-output HTTP 200 as failed call: ${JSON.stringify(zeroOutputRecent)}`);
    }
  } finally {
    await close(zeroOutputUsagePool);
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

  const responsesDataOnlyPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'responses-data-only', base_url: `${responsesDataOnlyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const responsesDataOnlyPoolInfo = await listen(responsesDataOnlyPool);
  try {
    const dataOnlyBatchProbe = await postJson(`${responsesDataOnlyPoolInfo.url}/pool/probe`, 'pool-secret', {});
    if (
      dataOnlyBatchProbe.response.status !== 200 ||
      dataOnlyBatchProbe.json.ok !== true ||
      dataOnlyBatchProbe.json.probe_ok !== false ||
      dataOnlyBatchProbe.json.probe_status !== 'failed' ||
      dataOnlyBatchProbe.json.summary?.ok_count !== 0 ||
      dataOnlyBatchProbe.json.summary?.failed_count !== 1
    ) {
      throw new Error(`expected batch probe summary to report failed model probe: ${dataOnlyBatchProbe.text}`);
    }
    const dataOnlyProbe = await postJson(`${responsesDataOnlyPoolInfo.url}/pool/upstreams/responses-data-only/probe`, 'pool-secret', {});
    if (dataOnlyProbe.response.status !== 200 || dataOnlyProbe.json.probe_ok !== false || dataOnlyProbe.json.probe_status !== 'failed' || dataOnlyProbe.json.health?.state === 'ok') {
      throw new Error(`expected /responses data-only body not to pass health probe: ${dataOnlyProbe.text}`);
    }
    const dataOnlyStatus = (await getJson(`${responsesDataOnlyPoolInfo.url}/pool/status`, 'pool-secret')).json;
    const dataOnlySite = dataOnlyStatus.upstreams.find((upstream) => upstream.name === 'responses-data-only');
    if (dataOnlySite?.available !== false || dataOnlySite?.selection_score !== 0) {
      throw new Error(`expected failed health probe to remove upstream from Selection: ${JSON.stringify(dataOnlySite)}`);
    }
  } finally {
    await close(responsesDataOnlyPool);
  }

  const responsesObjectOnlyPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'responses-object-only', base_url: `${responsesObjectOnlyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const responsesObjectOnlyPoolInfo = await listen(responsesObjectOnlyPool);
  try {
    const objectOnlyProbe = await postJson(`${responsesObjectOnlyPoolInfo.url}/pool/upstreams/responses-object-only/probe`, 'pool-secret', {});
    if (
      objectOnlyProbe.response.status !== 200 ||
      objectOnlyProbe.json.probe_ok !== false ||
      objectOnlyProbe.json.probe_status !== 'failed' ||
      objectOnlyProbe.json.health?.state === 'ok' ||
      !String(objectOnlyProbe.json.health?.error || '').includes('without Responses output/output_text')
    ) {
      throw new Error(`expected /responses object-only body not to pass health probe: ${objectOnlyProbe.text}`);
    }
  } finally {
    await close(responsesObjectOnlyPool);
  }

  const chatChoicesEmptyPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'chat-choices-empty', base_url: `${chatChoicesEmptyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const chatChoicesEmptyPoolInfo = await listen(chatChoicesEmptyPool);
  try {
    const choicesEmptyProbe = await postJson(`${chatChoicesEmptyPoolInfo.url}/pool/upstreams/chat-choices-empty/probe`, 'pool-secret', {});
    if (
      choicesEmptyProbe.response.status !== 200 ||
      choicesEmptyProbe.json.probe_ok !== false ||
      choicesEmptyProbe.json.probe_status !== 'failed' ||
      choicesEmptyProbe.json.health?.state === 'ok' ||
      !String(choicesEmptyProbe.json.health?.error || '').includes('without choices')
    ) {
      throw new Error(`expected chat completions empty choices not to pass health probe: ${choicesEmptyProbe.text}`);
    }
  } finally {
    await close(chatChoicesEmptyPool);
  }

  const anthropicContentEmptyPool = createTestPool({
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
      { name: 'anthropic-content-empty', api: 'anthropic', base_url: `${anthropicContentEmptyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const anthropicContentEmptyPoolInfo = await listen(anthropicContentEmptyPool);
  try {
    const contentEmptyProbe = await postJson(`${anthropicContentEmptyPoolInfo.url}/pool/upstreams/anthropic-content-empty/probe`, 'pool-secret', {});
    if (
      contentEmptyProbe.response.status !== 200 ||
      contentEmptyProbe.json.probe_ok !== false ||
      contentEmptyProbe.json.probe_status !== 'failed' ||
      contentEmptyProbe.json.health?.state === 'ok' ||
      !String(contentEmptyProbe.json.health?.error || '').includes('without content')
    ) {
      throw new Error(`expected Anthropic empty content not to pass health probe: ${contentEmptyProbe.text}`);
    }
  } finally {
    await close(anthropicContentEmptyPool);
  }

  const nativeUnsupportedToolPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 3000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'native-responses', request_mode: 'responses', base_url: `${goodInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const nativeUnsupportedToolPoolInfo = await listen(nativeUnsupportedToolPool);
  try {
    const unsupportedToolBody = JSON.stringify({
      model: 'test-model',
      input: 'search the web',
      stream: false,
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }],
      metadata: { keep_unknown_tool_test: true }
    });
    const response = await fetch(`${nativeUnsupportedToolPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(unsupportedToolBody))
      },
      body: unsupportedToolBody
    });
    const text = await response.text();
    const json = JSON.parse(text);
    if (
      response.status !== 200 ||
      json.body?.tools?.[0]?.type !== 'web_search_preview' ||
      json.body?.tools?.[0]?.search_context_size !== 'low' ||
      json.body?.metadata?.keep_unknown_tool_test !== true
    ) {
      throw new Error(`expected native Responses upstream to receive unsupported tool fields intact: ${response.status} ${text}`);
    }
  } finally {
    await close(nativeUnsupportedToolPool);
  }

  chatOnlyResponsesHits = 0;
  chatOnlyChatHits = 0;
  const mixedUnsupportedToolPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 3000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'known-chat-only', request_mode: 'chat_completions', base_url: `${chatOnlyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'native-after-chat', request_mode: 'responses', base_url: `${goodInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const mixedUnsupportedToolPoolInfo = await listen(mixedUnsupportedToolPool);
  const originalRandomForMixedUnsupported = Math.random;
  try {
    Math.random = () => 0;
    const unsupportedToolBody = JSON.stringify({
      model: 'test-model',
      input: 'search the web',
      stream: false,
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }]
    });
    const response = await fetch(`${mixedUnsupportedToolPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(unsupportedToolBody))
      },
      body: unsupportedToolBody
    });
    const text = await response.text();
    const json = JSON.parse(text);
    if (
      response.status !== 200 ||
      json.body?.tools?.[0]?.type !== 'web_search_preview' ||
      chatOnlyResponsesHits !== 0 ||
      chatOnlyChatHits !== 0
    ) {
      throw new Error(`expected unsupported Responses tool to skip known chat-only and reach native Responses: ${response.status} ${text} responses=${chatOnlyResponsesHits} chat=${chatOnlyChatHits}`);
    }
  } finally {
    Math.random = originalRandomForMixedUnsupported;
    await close(mixedUnsupportedToolPool);
  }

  chatOnlyResponsesHits = 0;
  chatOnlyChatHits = 0;
  const explicitChatOnlyUnsupportedToolPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 3000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'explicit-chat-only', request_mode: 'chat_completions', base_url: `${chatOnlyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const explicitChatOnlyUnsupportedToolPoolInfo = await listen(explicitChatOnlyUnsupportedToolPool);
  try {
    const unsupportedToolBody = JSON.stringify({
      model: 'test-model',
      input: 'search the web',
      stream: false,
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }]
    });
    const response = await fetch(`${explicitChatOnlyUnsupportedToolPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(unsupportedToolBody))
      },
      body: unsupportedToolBody
    });
    const text = await response.text();
    const json = JSON.parse(text);
    if (
      response.status !== 422 ||
      json.unsupported_tool_types?.[0] !== 'web_search_preview' ||
      !String(json.error || '').includes('no compatible upstream candidate') ||
      json.attempts?.length !== 0 ||
      json.incompatible_upstreams?.[0]?.upstream !== 'explicit-chat-only' ||
      !String(json.incompatible_upstreams?.[0]?.reason || '').includes('request_mode=chat_completions') ||
      chatOnlyResponsesHits !== 0 ||
      chatOnlyChatHits !== 0
    ) {
      throw new Error(`expected explicit chat-only unsupported tool to fail before any upstream call: ${response.status} ${text} responses=${chatOnlyResponsesHits} chat=${chatOnlyChatHits}`);
    }
  } finally {
    await close(explicitChatOnlyUnsupportedToolPool);
  }

  const autoUnsupportedToolPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 3000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000,
      chat_fallback_probe_timeout_ms: 50
    },
    health: { enabled: false, path: '/models', timeout_ms: 50 },
    upstreams: [
      { name: 'chat-only-auto', base_url: `${chatOnlyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const autoUnsupportedToolPoolInfo = await listen(autoUnsupportedToolPool);
  try {
    const unsupportedToolBody = JSON.stringify({
      model: 'test-model',
      input: 'search the web',
      stream: false,
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }]
    });
    const response = await fetch(`${autoUnsupportedToolPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(unsupportedToolBody))
      },
      body: unsupportedToolBody
    });
    const text = await response.text();
    const json = JSON.parse(text);
    if (
      response.status !== 422 ||
      json.unsupported_tool_types?.[0] !== 'web_search_preview' ||
      chatOnlyResponsesHits !== 1 ||
      chatOnlyChatHits !== 0
    ) {
      throw new Error(`expected auto unsupported tool to fail clearly without chat fallback: ${response.status} ${text} responses=${chatOnlyResponsesHits} chat=${chatOnlyChatHits}`);
    }
    const plainBody = JSON.stringify({ model: 'test-model', input: 'hello', stream: false });
    const plainResponse = await fetch(`${autoUnsupportedToolPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(plainBody))
      },
      body: plainBody
    });
    const plainText = await plainResponse.text();
    const plainJson = JSON.parse(plainText);
    if (
      plainResponse.status !== 200 ||
      plainJson.output_text !== 'pong' ||
      chatOnlyResponsesHits !== 2 ||
      chatOnlyChatHits !== 1
    ) {
      throw new Error(`expected native-tool miss not to cooldown auto chat fallback: ${plainResponse.status} ${plainText} responses=${chatOnlyResponsesHits} chat=${chatOnlyChatHits}`);
    }
  } finally {
    await close(autoUnsupportedToolPool);
  }

  cachedChatThenNativeResponsesHits = 0;
  cachedChatThenNativeChatHits = 0;
  const cachedChatThenNativePool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 3000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000,
      chat_fallback_probe_timeout_ms: 50
    },
    health: { enabled: false, path: '/models', timeout_ms: 50 },
    upstreams: [
      { name: 'cached-chat-then-native', base_url: `${cachedChatThenNativeInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const cachedChatThenNativePoolInfo = await listen(cachedChatThenNativePool);
  try {
    const warmupBody = JSON.stringify({ model: 'test-model', input: 'hello', stream: false });
    const warmupResponse = await fetch(`${cachedChatThenNativePoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(warmupBody))
      },
      body: warmupBody
    });
    const warmupText = await warmupResponse.text();
    const warmupJson = JSON.parse(warmupText);
    if (
      warmupResponse.status !== 200 ||
      warmupJson.output_text !== 'cached-pong' ||
      cachedChatThenNativeResponsesHits !== 1 ||
      cachedChatThenNativeChatHits !== 1
    ) {
      throw new Error(`expected warmup to cache chat completions fallback: ${warmupResponse.status} ${warmupText} responses=${cachedChatThenNativeResponsesHits} chat=${cachedChatThenNativeChatHits}`);
    }
    const warmupStatus = (await getJson(`${cachedChatThenNativePoolInfo.url}/pool/status`, 'pool-secret')).json;
    const warmupSite = warmupStatus.upstreams.find((upstream) => upstream.name === 'cached-chat-then-native');
    if (warmupSite?.resolved_request_mode !== 'chat_completions') {
      throw new Error(`expected warmup to resolve request mode as chat_completions: ${JSON.stringify(warmupSite)}`);
    }

    const nativeToolsBody = JSON.stringify({
      model: 'test-model',
      input: 'use native responses tools',
      stream: false,
      tools: [
        { type: 'custom', name: 'shell', description: 'run a custom tool' },
        { type: 'namespace', namespace: 'mcp__node_repl', tools: [{ name: 'js' }] },
        { type: 'tool_search', query: 'browser automation' },
        { type: 'web_search', search_context_size: 'low' },
        { type: 'image_generation', size: '1024x1024' }
      ],
      text: { format: { type: 'grammar', syntax: 'lark', definition: 'start: /ok/' } },
      metadata: { cached_chat_native_tools_test: true }
    });
    const nativeToolsResponse = await fetch(`${cachedChatThenNativePoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(nativeToolsBody))
      },
      body: nativeToolsBody
    });
    const nativeToolsText = await nativeToolsResponse.text();
    const nativeToolsJson = JSON.parse(nativeToolsText);
    const forwardedToolTypes = nativeToolsJson.body?.tools?.map((tool) => tool?.type);
    if (
      nativeToolsResponse.status !== 200 ||
      nativeToolsJson.body?.metadata?.cached_chat_native_tools_test !== true ||
      nativeToolsJson.body?.text?.format?.type !== 'grammar' ||
      !['custom', 'namespace', 'tool_search', 'web_search', 'image_generation'].every((type) => forwardedToolTypes?.includes(type)) ||
      cachedChatThenNativeResponsesHits !== 2 ||
      cachedChatThenNativeChatHits !== 1
    ) {
      throw new Error(`expected cached chat fallback to re-probe native Responses with native tools intact: ${nativeToolsResponse.status} ${nativeToolsText} responses=${cachedChatThenNativeResponsesHits} chat=${cachedChatThenNativeChatHits}`);
    }

    const nativeToolChoiceBody = JSON.stringify({
      model: 'test-model',
      input: 'force native tool choice',
      stream: false,
      tool_choice: { type: 'web_search', name: 'web_search' },
      metadata: { native_tool_choice_test: true }
    });
    const nativeToolChoiceResponse = await fetch(`${cachedChatThenNativePoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(nativeToolChoiceBody))
      },
      body: nativeToolChoiceBody
    });
    const nativeToolChoiceText = await nativeToolChoiceResponse.text();
    const nativeToolChoiceJson = JSON.parse(nativeToolChoiceText);
    if (
      nativeToolChoiceResponse.status !== 200 ||
      nativeToolChoiceJson.body?.tool_choice?.type !== 'web_search' ||
      nativeToolChoiceJson.body?.metadata?.native_tool_choice_test !== true ||
      cachedChatThenNativeResponsesHits !== 3 ||
      cachedChatThenNativeChatHits !== 1
    ) {
      throw new Error(`expected cached chat fallback to re-probe native Responses for native tool_choice: ${nativeToolChoiceResponse.status} ${nativeToolChoiceText} responses=${cachedChatThenNativeResponsesHits} chat=${cachedChatThenNativeChatHits}`);
    }

    const wrongContentTypeBody = JSON.stringify({
      model: 'test-model',
      input: 'json body with wrong content type',
      stream: false,
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      metadata: { wrong_content_type_test: true }
    });
    const wrongContentTypeResponse = await fetch(`${cachedChatThenNativePoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(wrongContentTypeBody))
      },
      body: wrongContentTypeBody
    });
    const wrongContentTypeText = await wrongContentTypeResponse.text();
    const wrongContentTypeJson = JSON.parse(wrongContentTypeText);
    if (
      wrongContentTypeResponse.status !== 200 ||
      wrongContentTypeJson.body?.tools?.[0]?.type !== 'web_search' ||
      wrongContentTypeJson.body?.metadata?.wrong_content_type_test !== true ||
      cachedChatThenNativeResponsesHits !== 4 ||
      cachedChatThenNativeChatHits !== 1
    ) {
      throw new Error(`expected JSON body with wrong content-type to preserve native Responses fields and normalize upstream content-type: ${wrongContentTypeResponse.status} ${wrongContentTypeText} responses=${cachedChatThenNativeResponsesHits} chat=${cachedChatThenNativeChatHits}`);
    }

    const nativeInputBody = JSON.stringify({
      model: 'test-model',
      stream: false,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'look at this' }] },
        { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'native reasoning item' }] }
      ],
      metadata: { native_input_test: true }
    });
    const nativeInputResponse = await fetch(`${cachedChatThenNativePoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(nativeInputBody))
      },
      body: nativeInputBody
    });
    const nativeInputText = await nativeInputResponse.text();
    const nativeInputJson = JSON.parse(nativeInputText);
    if (
      nativeInputResponse.status !== 200 ||
      nativeInputJson.body?.input?.[1]?.content?.[0]?.type !== 'input_image' ||
      nativeInputJson.body?.input?.[2]?.type !== 'reasoning' ||
      nativeInputJson.body?.metadata?.native_input_test !== true ||
      cachedChatThenNativeResponsesHits !== 5 ||
      cachedChatThenNativeChatHits !== 1
    ) {
      throw new Error(`expected cached chat fallback to re-probe native Responses for native input items: ${nativeInputResponse.status} ${nativeInputText} responses=${cachedChatThenNativeResponsesHits} chat=${cachedChatThenNativeChatHits}`);
    }
  } finally {
    await close(cachedChatThenNativePool);
  }

  chatOnlyResponsesHits = 0;
  chatOnlyChatHits = 0;
  const chatOnlyPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 3000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000,
      chat_fallback_probe_timeout_ms: 50
    },
    health: { enabled: false, path: '/models', timeout_ms: 50 },
    upstreams: [
      { name: 'chat-only', base_url: `${chatOnlyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const chatOnlyPoolInfo = await listen(chatOnlyPool);
  try {
    const jsonBody = JSON.stringify({ model: 'test-model', input: 'hello', stream: false });
    const jsonResponse = await fetch(`${chatOnlyPoolInfo.url}/v1/responses`, {
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
    if (jsonResponse.status !== 200 || json.object !== 'response' || json.output_text !== 'pong' || json.usage?.total_tokens !== 5) {
      throw new Error(`expected chat completions JSON to be adapted to Responses JSON: ${jsonResponse.status} ${jsonText}`);
    }
    const streamBody = JSON.stringify({ model: 'test-model', input: 'hello', stream: true });
    const streamResponse = await fetch(`${chatOnlyPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(streamBody))
      },
      body: streamBody
    });
    const streamText = await streamResponse.text();
    if (streamResponse.status !== 200 || !streamText.includes('response.output_text.delta') || !streamText.includes('pong') || !streamText.includes('response.completed') || !streamText.includes('[DONE]')) {
      throw new Error(`expected chat completions stream to be adapted to Responses SSE: ${streamResponse.status} ${streamText}`);
    }
    const chatToolBody = JSON.stringify({
      model: 'test-model',
      input: 'please use tool',
      stream: false,
      tools: [{
        type: 'function',
        name: 'lookup_weather',
        description: 'Look up weather for a city',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location']
        }
      }],
      tool_choice: { type: 'function', name: 'lookup_weather' }
    });
    const chatToolResponse = await fetch(`${chatOnlyPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(chatToolBody))
      },
      body: chatToolBody
    });
    const chatToolText = await chatToolResponse.text();
    const chatToolJson = JSON.parse(chatToolText);
    const chatToolCall = chatToolJson.output?.find((item) => item.type === 'function_call');
    if (
      chatToolResponse.status !== 200 ||
      chatToolCall?.name !== 'lookup_weather' ||
      chatToolCall?.call_id !== 'call_chat_weather' ||
      !String(chatToolCall?.arguments || '').includes('Shanghai')
    ) {
      throw new Error(`expected chat completions tool call to be adapted to Responses: ${chatToolResponse.status} ${chatToolText}`);
    }
    const scrubChatBody = JSON.stringify({
      model: 'test-model',
      input: 'hello',
      stream: false,
      previous_response_id: 'resp_prev',
      include: ['reasoning'],
      reasoning: { effort: 'medium' },
      text: { format: { type: 'text' } },
      truncation: 'auto',
      background: true,
      conversation: 'conv_1'
    });
    const scrubChatResponse = await fetch(`${chatOnlyPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(scrubChatBody))
      },
      body: scrubChatBody
    });
    const scrubChatText = await scrubChatResponse.text();
    const scrubChatJson = JSON.parse(scrubChatText);
    if (scrubChatResponse.status !== 200 || scrubChatJson.output_text !== 'pong') {
      throw new Error(`expected chat adapter to scrub Responses-only fields: ${scrubChatResponse.status} ${scrubChatText}`);
    }
    const unsupportedChatToolBody = JSON.stringify({
      model: 'test-model',
      input: 'search the web',
      stream: false,
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }]
    });
    const unsupportedChatToolResponse = await fetch(`${chatOnlyPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(unsupportedChatToolBody))
      },
      body: unsupportedChatToolBody
    });
    const unsupportedChatToolText = await unsupportedChatToolResponse.text();
    const unsupportedChatToolJson = JSON.parse(unsupportedChatToolText);
    if (
      unsupportedChatToolResponse.status !== 422 ||
      unsupportedChatToolJson.unsupported_tool_types?.[0] !== 'web_search_preview' ||
      !String(unsupportedChatToolJson.error || '').includes('cannot be converted by available upstreams') ||
      unsupportedChatToolJson.attempts?.[0]?.status !== 404 ||
      chatOnlyResponsesHits !== 2 ||
      chatOnlyChatHits !== 4
    ) {
      throw new Error(`expected unsupported tool to re-probe native Responses without chat fallback: ${unsupportedChatToolResponse.status} ${unsupportedChatToolText} responses=${chatOnlyResponsesHits} chat=${chatOnlyChatHits}`);
    }
    if (chatOnlyResponsesHits !== 2 || chatOnlyChatHits !== 4) {
      throw new Error(`expected first request to probe responses once, then reuse chat completions: responses=${chatOnlyResponsesHits} chat=${chatOnlyChatHits}`);
    }
    const unsupportedChatInputBody = JSON.stringify({
      model: 'test-model',
      stream: false,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'look at this' }] },
        { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'native reasoning item' }] }
      ]
    });
    const unsupportedChatInputResponse = await fetch(`${chatOnlyPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(unsupportedChatInputBody))
      },
      body: unsupportedChatInputBody
    });
    const unsupportedChatInputText = await unsupportedChatInputResponse.text();
    const unsupportedChatInputJson = JSON.parse(unsupportedChatInputText);
    if (
      unsupportedChatInputResponse.status !== 422 ||
      !unsupportedChatInputJson.unsupported_input_types?.includes('content:input_image') ||
      !unsupportedChatInputJson.unsupported_input_types?.includes('reasoning') ||
      !String(unsupportedChatInputJson.error || '').includes('cannot be converted by available upstreams') ||
      unsupportedChatInputJson.attempts?.[0]?.status !== 404 ||
      chatOnlyResponsesHits !== 3 ||
      chatOnlyChatHits !== 4
    ) {
      throw new Error(`expected native input not to be degraded through chat adapter: ${unsupportedChatInputResponse.status} ${unsupportedChatInputText} responses=${chatOnlyResponsesHits} chat=${chatOnlyChatHits}`);
    }
    const chatOnlyStatus = (await getJson(`${chatOnlyPoolInfo.url}/pool/status`, 'pool-secret')).json;
    const chatOnlySite = chatOnlyStatus.upstreams.find((upstream) => upstream.name === 'chat-only');
    if (chatOnlySite?.resolved_request_mode !== 'chat_completions' || chatOnlySite?.usage?.total_tokens !== 17 || chatOnlySite?.usage?.input_tokens !== 7 || chatOnlySite?.usage?.output_tokens !== 10) {
      throw new Error(`expected chat completions fallback mode and usage to be recorded: ${JSON.stringify(chatOnlySite)}`);
    }
    const runtimeChatOnly = chatOnlyPool.state.upstreams.find((upstream) => upstream.name === 'chat-only');
    runtimeChatOnly.resolvedRequestMode = '';
    runtimeChatOnly.cooldownUntil = Date.now() + 1000;
    runtimeChatOnly.failures = 2;
    runtimeChatOnly.keys[0].cooldownUntil = Date.now() + 1000;
    runtimeChatOnly.keys[0].failures = 2;
    const probeResult = await postJson(`${chatOnlyPoolInfo.url}/pool/upstreams/chat-only/probe`, 'pool-secret', {});
    if (
      probeResult.response.status !== 200 ||
      probeResult.json.health?.state !== 'ok' ||
      probeResult.json.health?.httpStatus !== 200 ||
      probeResult.json.health?.error ||
      !String(probeResult.json.health?.warning || '').includes('chat_completions probe ok') ||
      chatOnlyPool.state.upstreams.find((upstream) => upstream.name === 'chat-only')?.resolvedRequestMode !== 'chat_completions' ||
      chatOnlyPool.state.upstreams.find((upstream) => upstream.name === 'chat-only')?.cooldownUntil !== 0
    ) {
      throw new Error(`expected health probe to recover chat-only upstream via chat completions: ${probeResult.text}`);
    }
    if (probeResult.json.probe_ok !== true) {
      throw new Error(`expected successful single-upstream probe_ok true: ${probeResult.text}`);
    }
    const postProbeStatus = (await getJson(`${chatOnlyPoolInfo.url}/pool/status`, 'pool-secret')).json;
    const postProbeChatOnly = postProbeStatus.upstreams.find((upstream) => upstream.name === 'chat-only');
    if (
      postProbeChatOnly?.health?.error ||
      !String(postProbeChatOnly?.health?.warning || '').includes('chat_completions probe ok') ||
      postProbeChatOnly?.keys?.[0]?.health?.error ||
      !String(postProbeChatOnly?.keys?.[0]?.health?.warning || '').includes('chat_completions probe ok')
    ) {
      throw new Error(`expected /pool/status to expose warning without error after fallback probe: ${JSON.stringify(postProbeChatOnly)}`);
    }
  } finally {
    await close(chatOnlyPool);
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

    const anthropicToolBody = JSON.stringify({
      model: 'ignored-original-model',
      stream: false,
      max_output_tokens: 128,
      tools: [{
        type: 'function',
        name: 'lookup_weather',
        description: 'Look up weather for a city',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location']
        }
      }],
      tool_choice: { type: 'function', name: 'lookup_weather' },
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'need weather' }] },
        { type: 'function_call', call_id: 'call_weather_1', name: 'lookup_weather', arguments: '{"location":"Shanghai"}' },
        { type: 'function_call_output', call_id: 'call_weather_1', output: '{"forecast":"sunny"}' }
      ]
    });
    const anthropicToolResponse = await fetch(`${anthropicMessagesPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(anthropicToolBody))
      },
      body: anthropicToolBody
    });
    const anthropicToolText = await anthropicToolResponse.text();
    const anthropicToolJson = JSON.parse(anthropicToolText);
    const anthropicToolCall = anthropicToolJson.output?.find((item) => item.type === 'function_call');
    if (
      anthropicToolResponse.status !== 200 ||
      anthropicToolCall?.name !== 'lookup_weather' ||
      anthropicToolCall?.call_id !== 'toolu_weather_2' ||
      !String(anthropicToolCall?.arguments || '').includes('Shanghai')
    ) {
      throw new Error(`expected Anthropic tool use to be adapted to Responses JSON: ${anthropicToolResponse.status} ${anthropicToolText}`);
    }

    const anthropicToolStreamBody = JSON.stringify({ ...JSON.parse(anthropicToolBody), stream: true });
    const anthropicToolStreamResponse = await fetch(`${anthropicMessagesPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(anthropicToolStreamBody))
      },
      body: anthropicToolStreamBody
    });
    const anthropicToolStreamText = await anthropicToolStreamResponse.text();
    const requiredAnthropicToolStreamEvents = [
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
      '[DONE]'
    ];
    if (
      anthropicToolStreamResponse.status !== 200 ||
      !anthropicToolStreamText.includes('lookup_weather') ||
      !anthropicToolStreamText.includes('toolu_weather_2') ||
      requiredAnthropicToolStreamEvents.some((event) => !anthropicToolStreamText.includes(event))
    ) {
      throw new Error(`expected Anthropic streamed tool use to be adapted to Responses SSE: ${anthropicToolStreamResponse.status} ${anthropicToolStreamText}`);
    }

    const scrubAnthropicBody = JSON.stringify({
      model: 'ignored-original-model',
      stream: false,
      max_output_tokens: 128,
      previous_response_id: 'resp_prev',
      include: ['reasoning'],
      reasoning: { effort: 'medium' },
      text: { format: { type: 'text' } },
      truncation: 'auto',
      parallel_tool_calls: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const scrubAnthropicResponse = await fetch(`${anthropicMessagesPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(scrubAnthropicBody))
      },
      body: scrubAnthropicBody
    });
    const scrubAnthropicText = await scrubAnthropicResponse.text();
    const scrubAnthropicJson = JSON.parse(scrubAnthropicText);
    if (scrubAnthropicResponse.status !== 200 || scrubAnthropicJson.status !== 'completed' || scrubAnthropicJson.output_text !== 'pong') {
      throw new Error(`expected Anthropic adapter to scrub Responses-only fields: ${scrubAnthropicResponse.status} ${scrubAnthropicText}`);
    }

    const anthropicHitsBeforeUnsupportedTool = anthropicMessagesHits;
    const unsupportedAnthropicToolBody = JSON.stringify({
      model: 'ignored-original-model',
      stream: false,
      max_output_tokens: 128,
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const unsupportedAnthropicToolResponse = await fetch(`${anthropicMessagesPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(unsupportedAnthropicToolBody))
      },
      body: unsupportedAnthropicToolBody
    });
    const unsupportedAnthropicToolText = await unsupportedAnthropicToolResponse.text();
    const unsupportedAnthropicToolJson = JSON.parse(unsupportedAnthropicToolText);
    if (
      unsupportedAnthropicToolResponse.status !== 422 ||
      unsupportedAnthropicToolJson.unsupported_tool_types?.[0] !== 'web_search_preview' ||
      anthropicMessagesHits !== anthropicHitsBeforeUnsupportedTool
    ) {
      throw new Error(`expected unsupported tool not to be degraded through Anthropic adapter: ${unsupportedAnthropicToolResponse.status} ${unsupportedAnthropicToolText} hits=${anthropicMessagesHits - anthropicHitsBeforeUnsupportedTool}`);
    }

    const anthropicHitsBeforeUnsupportedToolChoice = anthropicMessagesHits;
    const unsupportedAnthropicToolChoiceBody = JSON.stringify({
      model: 'ignored-original-model',
      stream: false,
      max_output_tokens: 128,
      tool_choice: { type: 'web_search', name: 'web_search' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const unsupportedAnthropicToolChoiceResponse = await fetch(`${anthropicMessagesPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(unsupportedAnthropicToolChoiceBody))
      },
      body: unsupportedAnthropicToolChoiceBody
    });
    const unsupportedAnthropicToolChoiceText = await unsupportedAnthropicToolChoiceResponse.text();
    const unsupportedAnthropicToolChoiceJson = JSON.parse(unsupportedAnthropicToolChoiceText);
    if (
      unsupportedAnthropicToolChoiceResponse.status !== 422 ||
      unsupportedAnthropicToolChoiceJson.unsupported_tool_types?.[0] !== 'web_search' ||
      anthropicMessagesHits !== anthropicHitsBeforeUnsupportedToolChoice
    ) {
      throw new Error(`expected unsupported tool_choice not to be silently dropped through Anthropic adapter: ${unsupportedAnthropicToolChoiceResponse.status} ${unsupportedAnthropicToolChoiceText} hits=${anthropicMessagesHits - anthropicHitsBeforeUnsupportedToolChoice}`);
    }

    const anthropicHitsBeforeRequiredWithoutTools = anthropicMessagesHits;
    const requiredWithoutToolsBody = JSON.stringify({
      model: 'ignored-original-model',
      stream: false,
      max_output_tokens: 128,
      tool_choice: 'required',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello claude' }] }]
    });
    const requiredWithoutToolsResponse = await fetch(`${anthropicMessagesPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(requiredWithoutToolsBody))
      },
      body: requiredWithoutToolsBody
    });
    const requiredWithoutToolsText = await requiredWithoutToolsResponse.text();
    const requiredWithoutToolsJson = JSON.parse(requiredWithoutToolsText);
    if (
      requiredWithoutToolsResponse.status !== 422 ||
      requiredWithoutToolsJson.unsupported_tool_types?.[0] !== 'required' ||
      anthropicMessagesHits !== anthropicHitsBeforeRequiredWithoutTools
    ) {
      throw new Error(`expected required tool_choice without tools not to be silently dropped through Anthropic adapter: ${requiredWithoutToolsResponse.status} ${requiredWithoutToolsText} hits=${anthropicMessagesHits - anthropicHitsBeforeRequiredWithoutTools}`);
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

  const knownModelSelectionPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'test-model',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'unknown-model-high-weight', base_url: `${nextModelSiteInfo.url}/v1`, weight: 100, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'known-model-low-weight', base_url: `${goodInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const knownModelSelectionPoolInfo = await listen(knownModelSelectionPool);
  const originalKnownModelSelectionRandom = Math.random;
  try {
    const knownSite = knownModelSelectionPool.state.upstreams.find((upstream) => upstream.name === 'known-model-low-weight');
    knownSite.health.models = ['test-model'];
    knownSite.health.modelsCount = 1;
    Math.random = () => 0;
    const result = await requestJson(knownModelSelectionPoolInfo.url, 'pool-secret');
    if (result.response.status !== 200 || result.response.headers.get('x-codex-api-pool-upstream') !== 'known-model-low-weight') {
      throw new Error(`expected known model support to beat unknown high-weight upstream on first attempt: ${result.response.status} ${result.text}`);
    }
  } finally {
    Math.random = originalKnownModelSelectionRandom;
    await close(knownModelSelectionPool);
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
    model_override: 'added-model-a',
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'preferred-off', base_url: `${addedInfo.url}/v1`, weight: 10, keys: [{ env: 'TEST_UPSTREAM_KEY' }] },
      { name: 'fallback-good', base_url: `${goodInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const toggleInfo = await listen(togglePool);
  try {
    const disableResult = await postJson(`${toggleInfo.url}/pool/upstreams/preferred-off/enabled`, 'pool-secret', { enabled: false });
    if (disableResult.response.status !== 200 || disableResult.json.enabled !== false || disableResult.json.probe_ok !== false || disableResult.json.probe_status !== 'skipped' || disableResult.json.health?.state !== 'disabled') {
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
    const disabledBatchProbe = await postJson(`${toggleInfo.url}/pool/probe`, 'pool-secret', {});
    if (
      disabledBatchProbe.response.status !== 200 ||
      disabledBatchProbe.json.probe_ok !== true ||
      disabledBatchProbe.json.probe_status !== 'ok' ||
      disabledBatchProbe.json.summary?.total_count !== 2 ||
      disabledBatchProbe.json.summary?.enabled_count !== 1 ||
      disabledBatchProbe.json.summary?.disabled_count !== 1 ||
      disabledBatchProbe.json.summary?.ok_count !== 1 ||
      disabledBatchProbe.json.summary?.failed_count !== 0 ||
      disabledBatchProbe.json.summary?.skipped_count !== 1 ||
      disabledBatchProbe.json.summary?.states?.disabled !== 1
    ) {
      throw new Error(`expected batch probe to count disabled upstream as skipped without failing enabled probes: ${disabledBatchProbe.text}`);
    }

    const enableResult = await postJson(`${toggleInfo.url}/pool/upstreams/preferred-off/enabled`, 'pool-secret', { enabled: true });
    if (enableResult.response.status !== 200 || enableResult.json.enabled !== true || enableResult.json.probe_ok !== true || enableResult.json.probe_status !== 'ok' || enableResult.json.health?.state !== 'ok') {
      throw new Error(`expected upstream enable to probe and restore health: ${enableResult.text}`);
    }
  } finally {
    await close(togglePool);
  }

  const preAddModelResult = await postJson(`${poolInfo.url}/pool/model`, 'pool-secret', { model: 'added-model-a' });
  if (preAddModelResult.response.status !== 200 || preAddModelResult.json.model_override !== 'added-model-a') {
    throw new Error(`expected pre-add model override to be saved: ${preAddModelResult.text}`);
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

  if (addResult.json.probe_ok !== true || addResult.json.probe_status !== 'ok' || addResult.json.health?.state !== 'ok' || addResult.json.health?.modelsCount !== 2) {
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
  if (replaceResult.response.status !== 200 || replaceResult.json.probe_ok !== true || replaceResult.json.probe_status !== 'ok') {
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

  const plaintextAddResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'plaintext-site',
    base_url: `${addedInfo.url}/v1`,
    weight: 1,
    keys: [{ value: 'plaintext-runtime-key' }]
  });
  if (plaintextAddResult.response.status !== 201 || !plaintextAddResult.json.plaintext_key_warning) {
    throw new Error(`expected plaintext upstream add to warn about saved key: ${plaintextAddResult.text}`);
  }
  const bearerTokenAddResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'bearer-token-site',
    base_url: `${addedInfo.url}/v1`,
    weight: 1,
    experimental_bearer_token: 'plaintext-bearer-token'
  });
  if (bearerTokenAddResult.response.status !== 201 || !bearerTokenAddResult.json.plaintext_key_warning) {
    throw new Error(`expected experimental_bearer_token add to warn about saved key: ${bearerTokenAddResult.text}`);
  }
  const statusAfterPlaintextAdd = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const plaintextStatus = statusAfterPlaintextAdd.upstreams.find((upstream) => upstream.name === 'plaintext-site');
  const bearerTokenStatus = statusAfterPlaintextAdd.upstreams.find((upstream) => upstream.name === 'bearer-token-site');
  if (
    plaintextStatus?.keys?.[0]?.source !== 'value' ||
    plaintextStatus?.keys?.[0]?.configured !== true ||
    String(plaintextStatus?.keys?.[0]?.label || '').includes('plaintext-runtime-key') ||
    bearerTokenStatus?.keys?.[0]?.source !== 'value' ||
    bearerTokenStatus?.keys?.[0]?.configured !== true ||
    String(bearerTokenStatus?.keys?.[0]?.label || '').includes('plaintext-bearer-token')
  ) {
    throw new Error(`expected plaintext keys to be configured, typed, and masked: ${JSON.stringify({ plaintextStatus, bearerTokenStatus })}`);
  }
  for (const name of ['plaintext-site', 'bearer-token-site']) {
    const deleted = await deleteJson(`${poolInfo.url}/pool/upstreams/${name}`, 'pool-secret');
    if (deleted.response.status !== 200) {
      throw new Error(`expected plaintext test upstream delete 200 for ${name}: ${deleted.text}`);
    }
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
    model_override: 'gpt-test',
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
    codexOauthLastRequest = null;
    codexOauthProxyLastRequest = null;
    const codexOauthBatchProbe = await postJson(`${codexOauthPoolInfo.url}/pool/probe`, 'pool-secret', {});
    const batchOauthSite = codexOauthBatchProbe.json.result?.upstreams?.find((upstream) => upstream.name === 'codex-oauth');
    if (
      codexOauthBatchProbe.response.status !== 200 ||
      codexOauthBatchProbe.json.probe_ok !== true ||
      codexOauthBatchProbe.json.probe_status !== 'ok' ||
      codexOauthBatchProbe.json.summary?.ok_count !== 1 ||
      batchOauthSite?.health?.state !== 'ok' ||
      codexOauthLastRequest?.url !== '/backend-api/codex/responses' ||
      !codexOauthProxyLastRequest?.url?.startsWith(`${codexOauthBackendInfo.url}/backend-api/codex/responses`)
    ) {
      throw new Error(`expected batch probe to send Codex OAuth live request through proxy_url: ${codexOauthBatchProbe.text} request=${JSON.stringify(codexOauthLastRequest)} proxy=${JSON.stringify(codexOauthProxyLastRequest)}`);
    }
    codexOauthLastRequest = null;
    codexOauthProxyLastRequest = null;
    codexOauthRequestCount = 0;
    codexOauthPool.state.probingPromise = sleep(10);
    codexOauthPool.state.probing = true;
    codexOauthPool.state.probingLive = false;
    const [queuedBatchProbe, sharedQueuedBatchProbe] = await Promise.all([
      postJson(`${codexOauthPoolInfo.url}/pool/probe`, 'pool-secret', {}),
      postJson(`${codexOauthPoolInfo.url}/pool/probe`, 'pool-secret', {})
    ]);
    if (
      queuedBatchProbe.response.status !== 200 ||
      queuedBatchProbe.json.probe_ok !== true ||
      queuedBatchProbe.json.probe_status !== 'ok' ||
      queuedBatchProbe.json.result?.upstreams?.find((upstream) => upstream.name === 'codex-oauth')?.health?.state !== 'ok' ||
      sharedQueuedBatchProbe.response.status !== 200 ||
      sharedQueuedBatchProbe.json.probe_ok !== true ||
      sharedQueuedBatchProbe.json.probe_status !== 'ok' ||
      sharedQueuedBatchProbe.json.result?.upstreams?.find((upstream) => upstream.name === 'codex-oauth')?.health?.state !== 'ok' ||
      codexOauthLastRequest?.url !== '/backend-api/codex/responses' ||
      codexOauthRequestCount !== 1
    ) {
      throw new Error(`expected manual batch probes to share one live OAuth probe after in-flight health: first=${queuedBatchProbe.text} second=${sharedQueuedBatchProbe.text} request=${JSON.stringify(codexOauthLastRequest)} count=${codexOauthRequestCount}`);
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
      || health.diagnostics?.compactModel !== 'gpt-5.3-codex'
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

  const preAnthropicModelResult = await postJson(`${poolInfo.url}/pool/model`, 'pool-secret', { model: 'claude-sonnet-test' });
  if (preAnthropicModelResult.response.status !== 200 || preAnthropicModelResult.json.model_override !== 'claude-sonnet-test') {
    throw new Error(`expected pre-anthropic model override to be saved: ${preAnthropicModelResult.text}`);
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

  if (anthropicAddResult.json.probe_ok !== true || anthropicAddResult.json.probe_status !== 'ok' || anthropicAddResult.json.health?.state !== 'ok' || !anthropicAddResult.json.health?.models?.includes('claude-sonnet-test')) {
    throw new Error(`expected anthropic model probe to discover claude model: ${anthropicAddResult.text}`);
  }

  const anthropicReplaceResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'anthropic-models',
    base_url: anthropicModelsInfo.url,
    weight: 2,
    replace: true
  });
  if (anthropicReplaceResult.response.status !== 200 || anthropicReplaceResult.json.probe_ok !== true || anthropicReplaceResult.json.probe_status !== 'ok' || anthropicReplaceResult.json.health?.state !== 'ok') {
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
  if (autoAnthropicAddResult.json.probe_ok !== true || autoAnthropicAddResult.json.probe_status !== 'ok' || autoAnthropicAddResult.json.health?.state !== 'ok' || !autoAnthropicAddResult.json.health?.models?.includes('claude-sonnet-test')) {
    throw new Error(`expected auto Anthropic detection to reuse Anthropic health: ${autoAnthropicAddResult.text}`);
  }

  const autoModelsOnlyAddResult = await postJson(`${poolInfo.url}/pool/upstreams`, 'pool-secret', {
    name: 'auto-models-only',
    base_url: `${modelErrorInfo.url}/v1`,
    weight: 1,
    keys: [{ env: 'TEST_UPSTREAM_KEY' }]
  });
  if (
    autoModelsOnlyAddResult.response.status !== 201 ||
    autoModelsOnlyAddResult.json.api_detected !== 'openai' ||
    autoModelsOnlyAddResult.json.probe_ok !== false ||
    autoModelsOnlyAddResult.json.probe_status !== 'failed' ||
    autoModelsOnlyAddResult.json.health?.state === 'ok' ||
    !autoModelsOnlyAddResult.json.health?.models?.includes('test-model') ||
    !String(autoModelsOnlyAddResult.json.health?.warning || '').includes('api auto-detected from /models')
  ) {
    throw new Error(`expected /models auto-detect not to turn failed real probe into ok: ${autoModelsOnlyAddResult.text}`);
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

  const preDualProtocolModelResult = await postJson(`${poolInfo.url}/pool/model`, 'pool-secret', { model: 'gpt-test' });
  if (preDualProtocolModelResult.response.status !== 200 || preDualProtocolModelResult.json.model_override !== 'gpt-test') {
    throw new Error(`expected pre-dual-protocol model override to be saved: ${preDualProtocolModelResult.text}`);
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

  const staleModelStatus = (await getJson(`${poolInfo.url}/pool/status`, 'pool-secret')).json;
  const staleDualProtocol = staleModelStatus.upstreams.find((upstream) => upstream.name === 'dual-protocol-models');
  if (
    staleDualProtocol?.health?.state !== 'stale_model_override' ||
    staleDualProtocol?.health?.raw_state !== 'stale_model_override' ||
    staleDualProtocol?.health?.probe_model !== 'gpt-test' ||
    !String(staleDualProtocol?.health?.error || '').includes('current model_override is added-model-b')
  ) {
    throw new Error(`expected model override change to invalidate previous health probe: ${JSON.stringify(staleDualProtocol)}`);
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
    model_override: 'test-model',
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
    await postJson(`${siteFallbackInfo.url}/pool/model`, 'pool-secret', { model: 'cf-only-model' });
    await postJson(`${siteFallbackInfo.url}/pool/upstreams/next-model-site/probe`, 'pool-secret', {});

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

  let codexForwardOnlyRequest = null;
  const codexForwardOnlyBackend = createFakeUpstream('codex-forward-only', ({ req, res, body }) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }));
      return;
    }
    const hasCodexRequestMarkers = req.headers.originator === 'Codex Desktop'
      && req.headers['x-oai-attestation'] === 'attestation-test'
      && /^Codex Desktop\//.test(req.headers['user-agent'] || '');
    if (req.url.endsWith('/responses') && hasCodexRequestMarkers) {
      codexForwardOnlyRequest = { url: req.url, headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_codex_forward_only',
        object: 'response',
        output_text: 'ok',
        body: JSON.parse(body || '{}')
      }));
      return;
    }
    if (req.url.endsWith('/responses') || req.url.endsWith('/chat/completions')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: '请使用最新版的codex客户端或codex cli调用（traceid: test-trace）',
          type: 'invalid_request_error',
          code: 'codex_access_restricted',
          trace_id: 'test-trace'
        }
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const codexForwardOnlyInfo = await listen(codexForwardOnlyBackend);
  const codexForwardOnlyPool = createTestPool({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      auth_token_env: 'TEST_POOL_TOKEN',
      max_body_bytes: 1024 * 1024,
      request_timeout_ms: 5000
    },
    model_override: 'gpt-5.5',
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      { name: 'codex-forward-only', base_url: `${codexForwardOnlyInfo.url}/v1`, weight: 1, keys: [{ env: 'TEST_UPSTREAM_KEY' }] }
    ]
  });
  const codexForwardOnlyPoolInfo = await listen(codexForwardOnlyPool);
  try {
    const probe = await postJson(`${codexForwardOnlyPoolInfo.url}/pool/upstreams/codex-forward-only/probe`, 'pool-secret', {});
    if (
      probe.response.status !== 200 ||
      probe.json.probe_ok !== false ||
      probe.json.probe_status !== 'skipped' ||
      probe.json.health?.state !== 'advanced_curl_required' ||
      probe.json.health?.httpStatus !== 403 ||
      !String(probe.json.health?.error || '').includes('真实 Codex')
    ) {
      throw new Error(`expected advanced-curl upstream probe to be skipped, not failed: ${probe.text}`);
    }
    const status = (await getJson(`${codexForwardOnlyPoolInfo.url}/pool/status`, 'pool-secret')).json;
    const site = status.upstreams.find((upstream) => upstream.name === 'codex-forward-only');
    if (site?.available !== true || site?.selection_score <= 0 || site?.health?.state !== 'advanced_curl_required') {
      throw new Error(`expected advanced-curl upstream to stay selectable for real forwarding: ${JSON.stringify(site)}`);
    }
    const realCodexBody = JSON.stringify({ model: 'gpt-5.5', input: 'hello', stream: false });
    const realCodexResponse = await fetch(`${codexForwardOnlyPoolInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pool-secret',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(realCodexBody)),
        'user-agent': 'Codex Desktop/0.138.0-alpha.7',
        originator: 'Codex Desktop',
        'x-oai-attestation': 'attestation-test'
      },
      body: realCodexBody
    });
    const realCodexText = await realCodexResponse.text();
    const realCodexJson = JSON.parse(realCodexText);
    if (
      realCodexResponse.status !== 200 ||
      realCodexJson.output_text !== 'ok' ||
      codexForwardOnlyRequest?.headers?.authorization !== 'Bearer upstream-secret' ||
      codexForwardOnlyRequest?.headers?.['x-oai-attestation'] !== 'attestation-test'
    ) {
      throw new Error(`expected Codex-marked real request to dispatch after skipped probe: ${realCodexResponse.status} ${realCodexText} forwarded=${JSON.stringify(codexForwardOnlyRequest)}`);
    }
  } finally {
    await close(codexForwardOnlyPool);
    await close(codexForwardOnlyBackend);
  }

  const codexCurlDebugBackend = createFakeUpstream('codex-curl-debug', ({ req, res }) => {
    const hasCodexHeaders = req.headers.authorization === 'Bearer rawchat-secret'
      && req.headers['openai-beta'] === 'responses=experimental'
      && req.headers.originator === 'codex_cli_rs'
    && /^codex_cli_rs\/0\.125\.0\b/.test(req.headers['user-agent'] || '');
    if (req.url === '/codex/v1/responses' && hasCodexHeaders) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, output_text: 'ok' }));
      return;
    }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'codex_access_restricted' } }));
  });
  const codexCurlDebugInfo = await listen(codexCurlDebugBackend);
  try {
    const baseUrl = `${codexCurlDebugInfo.url}/codex`;
    const body = JSON.stringify({ model: 'gpt-5.5', input: 'hello' });
    const bearerDebugResult = await __testInternals.runCurlTest({
      base_url: baseUrl,
      path: '/v1/responses',
      method: 'POST',
      auth_type: 'bearer',
      api_key: 'rawchat-secret',
      body
    }, {});
    if (
      bearerDebugResult.ok ||
      bearerDebugResult.status_code !== 403 ||
      bearerDebugResult.judgement?.status !== 'inconclusive' ||
      bearerDebugResult.judgement?.judgement_type !== 'wrong_judgement' ||
      bearerDebugResult.judgement?.representative !== false ||
      bearerDebugResult.judgement?.effect_scope !== 'test_request_only' ||
      bearerDebugResult.judgement?.code !== 'requires_advanced_curl_profile' ||
      bearerDebugResult.judgement?.authoritative !== false ||
      bearerDebugResult.judgement?.blocks_dispatch !== false
    ) {
      throw new Error(`expected plain bearer curl debugger request to be rejected but non-authoritative: ${JSON.stringify(bearerDebugResult)}`);
    }
    const codexDebugResult = await __testInternals.runCurlTest({
      base_url: baseUrl,
      path: '/v1/responses',
      method: 'POST',
      auth_type: 'codex',
      api_key: 'rawchat-secret',
      body
    }, {});
    if (
      !codexDebugResult.ok ||
      codexDebugResult.status_code !== 200 ||
      codexDebugResult.target_url !== `${baseUrl}/v1/responses` ||
      codexDebugResult.judgement?.status !== 'ok' ||
      codexDebugResult.judgement?.judgement_type !== 'capability' ||
      codexDebugResult.judgement?.representative !== true ||
      codexDebugResult.judgement?.effect_scope !== 'exact_request' ||
      codexDebugResult.judgement?.authoritative !== true
    ) {
      throw new Error(`expected Codex CLI curl debugger mode to include Codex headers: ${JSON.stringify(codexDebugResult)}`);
    }
  } finally {
    await close(codexCurlDebugBackend);
  }

  const normalAuthErrorCurlBackend = createFakeUpstream('normal-auth-error-curl', ({ res }) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'invalid api key' } }));
  });
  const normalAuthErrorCurlInfo = await listen(normalAuthErrorCurlBackend);
  try {
    const normalAuthErrorBody = JSON.stringify({ model: 'gpt-5.5', input: 'hello' });
    const normalAuthErrorResult = await __testInternals.runCurlTest({
      base_url: `${normalAuthErrorCurlInfo.url}/v1`,
      path: '/responses',
      method: 'POST',
      auth_type: 'bearer',
      api_key: 'bad-secret',
      body: normalAuthErrorBody
    }, {});
    if (
      normalAuthErrorResult.ok ||
      normalAuthErrorResult.status_code !== 403 ||
      normalAuthErrorResult.judgement?.status !== 'failed' ||
      normalAuthErrorResult.judgement?.judgement_type !== 'correct_judgement' ||
      normalAuthErrorResult.judgement?.representative !== true ||
      normalAuthErrorResult.judgement?.effect_scope !== 'upstream_auth' ||
      normalAuthErrorResult.judgement?.code !== 'auth_error' ||
      normalAuthErrorResult.judgement?.authoritative !== true ||
      normalAuthErrorResult.judgement?.blocks_dispatch !== true
    ) {
      throw new Error(`expected ordinary 403 curl result to remain authoritative auth_error: ${JSON.stringify(normalAuthErrorResult)}`);
    }
  } finally {
    await close(normalAuthErrorCurlBackend);
  }

  console.log('smoke ok: auth guard, fallback, upstream enable toggle, token usage accounting, chat completions fallback, availability scoring, billing accounting, billing main-path isolation, billing huge-limit guard, billing blocked detection, runtime add, config-preserving edit, JSON import, Codex OAuth import/forwarding, Codex curl debugger, model discovery, anthropic model probe, model override, stream-error cooldown, 400/522 site fallback, recent requests, and immediate health probe all passed');
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
  await close(cachedChatThenNative);
  await close(chatOnly);
  await close(anthropicContentEmpty);
  await close(chatChoicesEmpty);
  await close(responsesObjectOnly);
  await close(responsesDataOnly);
  await close(responsesMissingCompleted);
  await close(zeroOutputUsage);
  await close(usageUpstream);
  await close(added);
  await close(good);
  await close(modelError);
  await close(bad);
}
