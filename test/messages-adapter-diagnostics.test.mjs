// TDD: Messages → Chat Completions adapter must surface diagnostics.
//
// CORE_FEATURES.md §3 and §11: when Adapter Compatibility Mode converts a
// Messages request to Chat Completions and strips Messages-only features
// (cache_control, thinking blocks, computer_use tools), the conversion must be
// VISIBLE to the client — via the x-codex-api-pool-stripped response header and
// the Recent Request Timeline compatibility record. Silent stripping violates the
// spec ("用户文本和多模态内容不会被静默剥离... 通过响应头和 Timeline 透明化").

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-msg-diag-'));
let passed = 0;
let failed = 0;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
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

process.env.MSGDIAG_POOL_TOKEN = 'test-token';
process.env.MSGDIAG_ADMIN_TOKEN = 'admin-token';
process.env.MSGDIAG_KEY = 'test-key';

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  ${error.message}`);
    failed++;
  }
}

console.log('🧪 Messages adapter diagnostics tests\n');

// A Messages request carrying Messages-only features (cache_control + thinking),
// sent to an openai-only pool with adapter mode ON, must surface the stripping.

await test('Messages→Chat adapter sets x-codex-api-pool-stripped header', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-x', object: 'chat.completion', model: 'gpt-4',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    }));
  });
  const ui = await listen(upstream);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'MSGDIAG_POOL_TOKEN', admin_auth_token_env: 'MSGDIAG_ADMIN_TOKEN' },
    compatibility: { adapter_mode: { strip_messages_only_features: true, adapters: { chat_completions: true } } },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'openai', base_url: ui.url, api: 'openai', keys: [{ env: 'MSGDIAG_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 's1.json') });
  const pi = await listen(pool);
  try {
    const result = await fetch(`${pi.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.MSGDIAG_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{
          role: 'user',
          content: [
            { type: 'thinking', thinking: 'internal reasoning' },
            { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }
          ]
        }],
        max_tokens: 100
      })
    });
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}: ${await result.text()}`);
    const stripped = result.headers.get('x-codex-api-pool-stripped');
    if (!stripped) throw new Error('x-codex-api-pool-stripped header missing on adapter response');
    // cache_control and/or thinking should be named in the header
    if (!/cache_control|thinking/i.test(stripped)) {
      throw new Error(`expected stripped header to name cache_control/thinking, got: ${stripped}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

await test('Messages→Chat adapter records compatibility in Recent Request Timeline', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-y', object: 'chat.completion', model: 'gpt-4',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    }));
  });
  const ui = await listen(upstream);
  const pool = createPoolServer({
    server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'MSGDIAG_POOL_TOKEN', admin_auth_token_env: 'MSGDIAG_ADMIN_TOKEN' },
    compatibility: { adapter_mode: { strip_messages_only_features: true, adapters: { chat_completions: true } } },
    retry: { max_attempts: 1 },
    upstreams: [{ name: 'openai', base_url: ui.url, api: 'openai', keys: [{ env: 'MSGDIAG_KEY' }] }]
  }, { statsPath: path.join(statsRoot, 's2.json') });
  const pi = await listen(pool);
  try {
    await fetch(`${pi.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.MSGDIAG_POOL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{
          role: 'user',
          content: [
            { type: 'thinking', thinking: 'internal reasoning' },
            { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }
          ]
        }],
        max_tokens: 100
      })
    });
    const statusRes = await fetch(`${pi.url}/pool/status`, { headers: { authorization: `Bearer ${process.env.MSGDIAG_ADMIN_TOKEN}` } });
    const status = await statusRes.json();
    const recent = status.recent_requests || [];
    if (recent.length === 0) throw new Error('no recent request recorded');
    const req0 = recent[0];
    if (req0.routing_strategy !== 'messages_to_chat_completions') {
      throw new Error(`expected routing_strategy messages_to_chat_completions, got ${req0.routing_strategy}`);
    }
    const compat = req0.compatibility;
    if (!compat) throw new Error('Timeline entry missing compatibility record');
    const stripped = JSON.stringify(compat.stripped || compat.strippedFeatures || []);
    if (!/cache_control|thinking/i.test(stripped)) {
      throw new Error(`expected compatibility.stripped to name cache_control/thinking, got: ${stripped}`);
    }
  } finally {
    await close(pool);
    await close(upstream);
  }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
