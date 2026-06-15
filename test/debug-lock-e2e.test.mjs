#!/usr/bin/env node
// End-to-end test for Debug Lock Mode
//
// This test verifies the complete debug lock workflow:
// 1. Start a test pool with a mock upstream
// 2. Enable debug lock
// 3. Send a request (should be routed to locked upstream)
// 4. Verify debug headers
// 5. Disable debug lock
// 6. Verify status shows unlocked

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Create a simple mock upstream server
function createMockUpstream(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      // Mock responses endpoint returns 404 (not supported)
      if (req.url === '/v1/responses') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Endpoint not found' } }));
        return;
      }

      // Mock chat/completions endpoint returns success
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'test-123',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-5.5',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Test response' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }));
        return;
      }

      // Mock messages endpoint returns 404
      if (req.url === '/v1/messages') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Endpoint not found' } }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Mock upstream listening on port ${port}`);
      resolve(server);
    });
  });
}

async function httpRequest(method, path, body = null, port = 8787) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Authorization': 'Bearer test-token-123',
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function startTestPool() {
  const configPath = join(tmpdir(), `test-pool-config-${Date.now()}.json`);
  const statsPath = join(tmpdir(), `test-pool-stats-${Date.now()}.json`);

  const config = {
    server: {
      host: '127.0.0.1',
      port: 18788,
      auth_token_env: 'TEST_POOL_TOKEN',
      request_timeout_ms: 10000
    },
    upstreams: [
      {
        name: 'test-upstream',
        api: 'openai',
        base_url: 'http://127.0.0.1:19999/v1',
        weight: 1,
        keys: [{ env: 'TEST_UPSTREAM_KEY' }]
      }
    ]
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  process.env.TEST_POOL_TOKEN = 'test-token-123';
  process.env.TEST_UPSTREAM_KEY = 'test-key-456';

  return new Promise((resolve, reject) => {
    const poolProcess = spawn('node', ['src/server.mjs'], {
      env: { ...process.env, CODEX_POOL_CONFIG: configPath, CODEX_POOL_STATS: statsPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    poolProcess.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('listening on')) {
        resolve({ poolProcess, configPath, statsPath });
      }
    });

    poolProcess.stderr.on('data', (data) => {
      console.error('Pool stderr:', data.toString());
    });

    setTimeout(() => reject(new Error('Pool startup timeout')), 5000);
  });
}

async function runTest() {
  console.log('\n=== Debug Lock Mode E2E Test ===\n');

  // Start mock upstream
  console.log('Starting mock upstream...');
  const mockServer = await createMockUpstream(19999);

  // Start test pool
  console.log('Starting test pool...');
  const { poolProcess, configPath, statsPath } = await startTestPool();

  await sleep(1000); // Give pool time to fully start

  try {
    // Test 1: Enable debug lock
    console.log('\nTest 1: Enable debug lock');
    const lockRes = await httpRequest('POST', '/pool/upstreams/test-upstream/debug-lock', {
      respect_model_override: false
    }, 18788);
    assert(lockRes.status === 200, 'Lock endpoint returns 200');
    assert(lockRes.body.ok === true, 'Lock response has ok: true');
    assert(lockRes.body.debug_lock.enabled === true, 'Debug lock is enabled');
    assert(lockRes.body.debug_lock.upstream === 'test-upstream', 'Locked to correct upstream');

    // Test 2: Check status shows lock
    console.log('\nTest 2: Status shows lock state');
    const statusRes = await httpRequest('GET', '/pool/status', null, 18788);
    assert(statusRes.status === 200, 'Status endpoint returns 200');
    assert(statusRes.body.debug_lock.enabled === true, 'Status shows lock enabled');
    assert(statusRes.body.debug_lock.upstream === 'test-upstream', 'Status shows locked upstream');

    // Test 3: Send a Responses request
    // Note: Our mock returns 200 for all endpoints, so no fallback happens
    console.log('\nTest 3: Send Responses request');
    const modelRes = await httpRequest('POST', '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'input_text', text: 'test' }],
      max_tokens: 10
    }, 18788);
    console.log('  Response status:', modelRes.status);
    console.log('  Response headers:', modelRes.headers);
    console.log('  Response body:', JSON.stringify(modelRes.body).slice(0, 200));
    assert(modelRes.status === 200, 'Model request returns 200');
    assert(modelRes.headers['x-debug-lock-upstream'] === 'test-upstream', 'Has debug lock upstream header');
    assert(modelRes.headers['x-debug-lock-protocol'], 'Has protocol header');
    assert(modelRes.headers['x-debug-lock-adapter'] !== undefined, 'Has adapter header');
    assert(parseInt(modelRes.headers['x-debug-lock-attempts']) >= 1, 'Made at least 1 attempt');
    assert(modelRes.headers['x-debug-lock-latency-ms'], 'Has latency header');

    // Test 4: Disable debug lock
    console.log('\nTest 4: Disable debug lock');
    const unlockRes = await httpRequest('POST', '/pool/debug-unlock', null, 18788);
    assert(unlockRes.status === 200, 'Unlock endpoint returns 200');
    assert(unlockRes.body.ok === true, 'Unlock response has ok: true');
    assert(unlockRes.body.debug_lock.enabled === false, 'Debug lock is disabled');
    assert(unlockRes.body.debug_lock.was_locked_to === 'test-upstream', 'Shows previous lock');

    // Test 5: Check status shows unlocked
    console.log('\nTest 5: Status shows unlocked state');
    const statusRes2 = await httpRequest('GET', '/pool/status', null, 18788);
    assert(statusRes2.status === 200, 'Status endpoint returns 200');
    assert(statusRes2.body.debug_lock.enabled === false, 'Status shows lock disabled');

    console.log(`\n=== Results ===`);
    console.log(`Passed: ${testsPassed}`);
    console.log(`Failed: ${testsFailed}`);

  } finally {
    // Cleanup
    console.log('\nCleaning up...');
    poolProcess.kill();
    mockServer.close();
    if (existsSync(configPath)) unlinkSync(configPath);
    if (existsSync(statsPath)) unlinkSync(statsPath);
  }

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
