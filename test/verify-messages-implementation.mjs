#!/usr/bin/env node
// Verification test for Messages entry and forwarding implementation

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';

process.env.TEST_POOL_TOKEN = 'test-secret-token';
process.env.TEST_UPSTREAM_KEY = 'upstream-key';

function createFakeAnthropicUpstream(handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler({ req, res, body }));
  });
}

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

async function runTests() {
  console.log('🧪 Verifying Messages Implementation\n');

  // Test 1: Entry point validation
  console.log('Test 1: Entry point validation (auth, JSON, required fields)');
  {
    const pool = createPoolServer({
      server: {
        host: '127.0.0.1',
        port: 0,
        public_prefix: '/v1',
        auth_token_env: 'TEST_POOL_TOKEN'
      },
      upstreams: []
    });

    const poolInfo = await listen(pool);

    try {
      // Test 1a: Invalid auth
      const r1 = await fetch(`${poolInfo.url}/v1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-8', messages: [], max_tokens: 100 })
      });
      const j1 = await r1.json();

      if (r1.status === 401 && j1.type === 'error' && j1.error?.type) {
        console.log('  ✓ Invalid auth returns 401 Anthropic error');
      } else {
        console.log('  ✗ FAIL: Auth check broken');
        console.log(`    Got: ${r1.status} ${JSON.stringify(j1)}`);
      }

      // Test 1b: Invalid JSON
      const r2 = await fetch(`${poolInfo.url}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
        body: 'not-json'
      });
      const j2 = await r2.json();

      if (r2.status === 400 && j2.type === 'error') {
        console.log('  ✓ Invalid JSON returns 400 Anthropic error');
      } else {
        console.log('  ✗ FAIL: JSON validation broken');
      }

      // Test 1c: Missing required field
      const r3 = await fetch(`${poolInfo.url}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-8' })
      });
      const j3 = await r3.json();

      if (r3.status === 400 && j3.error?.message?.includes('messages')) {
        console.log('  ✓ Missing required field returns 400');
      } else {
        console.log('  ✗ FAIL: Field validation broken');
      }

      // Test 1d: Responses endpoint still uses OpenAI format
      const r4 = await fetch(`${poolInfo.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', input: 'hello' })
      });
      const j4 = await r4.json();

      if (r4.status === 401 && j4.error && !j4.type) {
        console.log('  ✓ Responses endpoint still uses OpenAI error format\n');
      } else {
        console.log('  ✗ FAIL: Responses error format changed\n');
      }
    } finally {
      await close(pool);
    }
  }

  // Test 2: Native forwarding
  console.log('Test 2: Native Messages forwarding');
  {
    let capturedRequest = null;

    const upstream = createFakeAnthropicUpstream(({ req, res, body }) => {
      capturedRequest = { method: req.method, url: req.url, headers: req.headers, body };

      const payload = JSON.parse(body);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from upstream' }],
        model: payload.model || 'claude-opus-4-8',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 }
      }));
    });

    const upstreamInfo = await listen(upstream);

    const pool = createPoolServer({
      server: {
        host: '127.0.0.1',
        port: 0,
        public_prefix: '/v1',
        auth_token_env: 'TEST_POOL_TOKEN'
      },
      retry: { max_attempts: 1 },
      upstreams: [
        {
          name: 'anthropic-test',
          base_url: upstreamInfo.url,
          api: 'anthropic',
          weight: 1,
          keys: [{ env: 'TEST_UPSTREAM_KEY' }]
        }
      ]
    });

    const poolInfo = await listen(pool);

    try {
      const result = await fetch(`${poolInfo.url}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'test message' }],
          max_tokens: 100
        })
      });

      const json = await result.json();

      if (result.status === 200 && json.type === 'message') {
        console.log('  ✓ Successfully forwarded to Anthropic upstream');
      } else {
        console.log('  ✗ FAIL: Forwarding failed');
        console.log(`    Status: ${result.status}`);
        console.log(`    Response: ${JSON.stringify(json)}`);
      }

      if (capturedRequest?.url === '/v1/messages' && capturedRequest?.method === 'POST') {
        console.log('  ✓ Forwarded to correct endpoint (/v1/messages)');
      } else {
        console.log('  ✗ FAIL: Wrong endpoint');
        console.log(`    Got: ${capturedRequest?.method} ${capturedRequest?.url}`);
      }

      if (json.content?.[0]?.text === 'Hello from upstream') {
        console.log('  ✓ Response content matches upstream\n');
      } else {
        console.log('  ✗ FAIL: Response content mismatch\n');
      }
    } finally {
      await close(pool);
      await close(upstream);
    }
  }

  // Test 3: Model Override
  console.log('Test 3: Model Override application');
  {
    let capturedModel = null;

    const upstream = createFakeAnthropicUpstream(({ req, res, body }) => {
      const payload = JSON.parse(body);
      capturedModel = payload.model;

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_override',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'response' }],
        model: payload.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 }
      }));
    });

    const upstreamInfo = await listen(upstream);

    const pool = createPoolServer({
      server: {
        host: '127.0.0.1',
        port: 0,
        public_prefix: '/v1',
        auth_token_env: 'TEST_POOL_TOKEN'
      },
      model_override: 'claude-sonnet-4-6',
      retry: { max_attempts: 1 },
      upstreams: [
        {
          name: 'anthropic-test',
          base_url: upstreamInfo.url,
          api: 'anthropic',
          weight: 1,
          keys: [{ env: 'TEST_UPSTREAM_KEY' }]
        }
      ]
    });

    const poolInfo = await listen(pool);

    try {
      await fetch(`${poolInfo.url}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 50
        })
      });

      if (capturedModel === 'claude-sonnet-4-6') {
        console.log('  ✓ Model Override applied correctly');
        console.log(`    Original: claude-opus-4-8 → Forwarded: ${capturedModel}\n`);
      } else {
        console.log('  ✗ FAIL: Model Override not applied');
        console.log(`    Expected: claude-sonnet-4-6, Got: ${capturedModel}\n`);
      }
    } finally {
      await close(pool);
      await close(upstream);
    }
  }

  // Test 4: Selection filter (only Anthropic upstreams)
  console.log('Test 4: Selection filter (Anthropic-only)');
  {
    let anthropicHit = false;
    let openaiHit = false;

    const anthropicUpstream = createFakeAnthropicUpstream(({ req, res, body }) => {
      anthropicHit = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_anthropic',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'from anthropic' }],
        model: 'claude-opus-4-8',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 }
      }));
    });

    const openaiUpstream = http.createServer((req, res) => {
      openaiHit = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-123', object: 'chat.completion', choices: [] }));
    });

    const anthropicInfo = await listen(anthropicUpstream);
    const openaiInfo = await listen(openaiUpstream);

    const pool = createPoolServer({
      server: {
        host: '127.0.0.1',
        port: 0,
        public_prefix: '/v1',
        auth_token_env: 'TEST_POOL_TOKEN'
      },
      retry: { max_attempts: 1 },
      upstreams: [
        {
          name: 'openai-upstream',
          base_url: openaiInfo.url,
          api: 'openai',
          weight: 10, // Higher weight, should still not be selected
          keys: [{ env: 'TEST_UPSTREAM_KEY' }]
        },
        {
          name: 'anthropic-upstream',
          base_url: anthropicInfo.url,
          api: 'anthropic',
          weight: 1,
          keys: [{ env: 'TEST_UPSTREAM_KEY' }]
        }
      ]
    });

    const poolInfo = await listen(pool);

    try {
      const result = await fetch(`${poolInfo.url}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.TEST_POOL_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 50
        })
      });

      await result.text(); // Consume response

      if (anthropicHit && !openaiHit) {
        console.log('  ✓ Correctly selected Anthropic upstream');
        console.log('  ✓ Ignored OpenAI upstream for Messages entry\n');
      } else {
        console.log('  ✗ FAIL: Selection filter not working');
        console.log(`    Anthropic hit: ${anthropicHit}, OpenAI hit: ${openaiHit}\n`);
      }
    } finally {
      await close(pool);
      await close(anthropicUpstream);
      await close(openaiUpstream);
    }
  }

  console.log('✅ All verification tests completed!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
