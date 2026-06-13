#!/usr/bin/env node
// 简单调试：查看请求是否到达和是否记录

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-debug-'));

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: address.port, url: `http://127.0.0.1:${address.port}` });
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

process.env.TEST_POOL_TOKEN = 'test-token';
process.env.TEST_ADMIN_TOKEN = 'admin-token';
process.env.TEST_KEY = 'test-key';

console.log('🔍 调试请求记录\n');

const upstream = http.createServer((req, res) => {
  console.log('上游收到请求');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 }
  }));
});

const upstreamInfo = await listen(upstream);
console.log(`上游监听: ${upstreamInfo.url}`);

const pool = createPoolServer({
  server: {
    host: '127.0.0.1',
    port: 0,
    public_prefix: '/v1',
    auth_token_env: 'TEST_POOL_TOKEN',
    admin_auth_token_env: 'TEST_ADMIN_TOKEN'
  },
  retry: { max_attempts: 1 },
  upstreams: [{
    name: 'test',
    base_url: upstreamInfo.url,
    api: 'anthropic',
    keys: [{ env: 'TEST_KEY' }]
  }]
}, { statsPath: path.join(statsRoot, 'stats.json') });

const poolInfo = await listen(pool);
console.log(`Pool 监听: ${poolInfo.url}\n`);

// Send Messages request
console.log('发送 Messages 请求...');
const msgResult = await fetch(`${poolInfo.url}/v1/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 })
});

console.log(`Messages 响应: ${msgResult.status}\n`);

// Wait a bit for async operations
await new Promise(r => setTimeout(r, 100));

// Check status endpoint
console.log('查询 /pool/status...');
const statusResult = await fetch(`${poolInfo.url}/pool/status`, {
  headers: { authorization: `Bearer ${process.env.TEST_ADMIN_TOKEN}` }
});

const status = await statusResult.json();
console.log(`Status 响应: ${statusResult.status}`);
console.log(`Recent requests 数量: ${status.recent_requests?.length || 0}`);

if (status.recent_requests && status.recent_requests.length > 0) {
  console.log('\n最近的请求:');
  status.recent_requests.forEach((req, i) => {
    console.log(`  ${i + 1}. ${req.method} ${req.path} - ${req.status} (entry_protocol: ${req.entry_protocol})`);
  });
} else {
  console.log('\n❌ 没有记录任何请求！');
}

await close(pool);
await close(upstream);
