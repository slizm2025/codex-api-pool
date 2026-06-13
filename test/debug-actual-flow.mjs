#!/usr/bin/env node
// Debug: 在实际流程中检查 Buffer 长度

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
process.env.TEST_KEY = 'test-key';

console.log('🔍 调试实际请求流程\n');

const receivedChunks = [];

const upstream = http.createServer((req, res) => {
  console.log(`上游收到请求: ${req.method} ${req.url}`);
  console.log(`Content-Length header: ${req.headers['content-length']}`);

  req.on('data', (chunk) => {
    console.log(`收到数据块: ${chunk.length} 字节`);
    receivedChunks.push(chunk);
  });

  req.on('end', () => {
    const fullBody = Buffer.concat(receivedChunks);
    console.log(`总接收: ${fullBody.length} 字节`);
    console.log(`内容: ${fullBody.toString('utf8')}`);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'gpt-4',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    }));
  });
});

const upstreamInfo = await listen(upstream);
console.log(`上游监听: ${upstreamInfo.url}\n`);

const pool = createPoolServer({
  server: { host: '127.0.0.1', port: 0, public_prefix: '/v1', auth_token_env: 'TEST_POOL_TOKEN' },
  compatibility: {
    adapter_mode: {
      strip_messages_only_features: true,
      adapters: { chat_completions: true }
    }
  },
  retry: { max_attempts: 1 },
  upstreams: [{
    name: 'openai',
    base_url: upstreamInfo.url,
    api: 'openai',
    keys: [{ env: 'TEST_KEY' }]
  }]
}, { statsPath: path.join(statsRoot, 'stats.json') });

const poolInfo = await listen(pool);
console.log(`Pool 监听: ${poolInfo.url}\n`);

const testPayload = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'test message' }],
  max_tokens: 100
};

console.log('发送 Messages 请求...');
console.log(`Payload: ${JSON.stringify(testPayload)}\n`);

const result = await fetch(`${poolInfo.url}/v1/messages`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify(testPayload)
});

console.log(`\nPool 响应: ${result.status}`);

await close(pool);
await close(upstream);

console.log('\n调试完成');
