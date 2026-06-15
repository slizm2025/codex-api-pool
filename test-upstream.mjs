#!/usr/bin/env node

import https from 'https';
import http from 'http';
import { URL } from 'url';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function testEndpoint(baseUrl, apiKey, endpoint, requestBody, headers, name, stream = false) {
  return new Promise((resolve) => {
    const fullUrl = `${baseUrl.replace(/\/$/, '')}${endpoint}`;
    const requestBodyStr = JSON.stringify(requestBody);

    const parsedUrl = new URL(fullUrl);
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': 'codex-api-pool-tester/1.0.0',
        ...headers,
        'content-length': Buffer.byteLength(requestBodyStr)
      },
      timeout: 30000
    };

    console.log(`\n========== ${name} ==========`);
    console.log(`Endpoint: ${fullUrl}`);
    console.log(`Stream: ${stream}`);
    console.log(`Request Body:`);
    console.log(JSON.stringify(requestBody, null, 2));

    const req = httpModule.request(options, (res) => {
      console.log(`\nHTTP ${res.statusCode}`);
      console.log('Response Headers:');
      console.log(JSON.stringify(res.headers, null, 2));

      if (stream) {
        console.log('\nStreaming Response:');
        let chunkCount = 0;
        res.on('data', (chunk) => {
          chunkCount++;
          const lines = chunk.toString().split('\n').filter(l => l.trim());
          lines.forEach(line => {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                console.log(`[Chunk ${chunkCount}]`, JSON.stringify(data));
              } catch {
                console.log(`[Chunk ${chunkCount}]`, line);
              }
            } else if (line === 'data: [DONE]') {
              console.log('[DONE]');
            }
          });
        });
        res.on('end', () => {
          console.log(`\nTotal chunks: ${chunkCount}`);
          resolve();
        });
      } else {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          console.log('\nResponse Body:');
          try {
            console.log(JSON.stringify(JSON.parse(body), null, 2));
          } catch {
            console.log(body);
          }
          resolve();
        });
      }
    });

    req.on('error', (e) => {
      console.error('\n❌ Error:', e.message);
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('\n❌ Timeout');
      resolve();
    });

    req.write(requestBodyStr);
    req.end();
  });
}

async function main() {
  console.log('API Upstream Tester\n');
  console.log('选择测试类型:');
  console.log('1. Claude Messages API (非流式)');
  console.log('2. Claude Messages API (流式)');
  console.log('3. GPT Responses API (非流式)');
  console.log('4. GPT Responses API (流式)');
  console.log('5. GPT Chat Completions API (非流式)');
  console.log('6. GPT Chat Completions API (流式)');
  console.log('7. All (测试所有端点)\n');

  const choice = await question('请选择 (1-7): ');
  const baseUrl = await question('Base URL: ');
  const apiKey = await question('API Key: ');
  rl.close();

  // Claude Messages API - 非流式
  if (choice === '1' || choice === '7') {
    await testEndpoint(
      baseUrl,
      apiKey,
      '/v1/messages',
      {
        model: 'claude-opus-4-8',
        max_tokens: 64000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Say "Hello from Claude Messages API (non-streaming)"' }
            ]
          }
        ]
      },
      {
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey
      },
      'Claude Messages API (非流式)',
      false
    );
  }

  // Claude Messages API - 流式
  if (choice === '2' || choice === '7') {
    await testEndpoint(
      baseUrl,
      apiKey,
      '/v1/messages',
      {
        model: 'claude-opus-4-8',
        max_tokens: 64000,
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Say "Hello from Claude Messages API (streaming)"' }
            ]
          }
        ]
      },
      {
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey
      },
      'Claude Messages API (流式)',
      true
    );
  }

  // GPT Responses API - 非流式 (按照真实Codex请求格式)
  if (choice === '3' || choice === '7') {
    await testEndpoint(
      baseUrl,
      apiKey,
      '/v1/responses',
      {
        model: 'gpt-5.5',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Say "Hello from GPT Responses API (non-streaming)"' }
            ]
          }
        ]
      },
      {
        'authorization': `Bearer ${apiKey}`
      },
      'GPT Responses API (非流式)',
      false
    );
  }

  // GPT Responses API - 流式
  if (choice === '4' || choice === '7') {
    await testEndpoint(
      baseUrl,
      apiKey,
      '/v1/responses',
      {
        model: 'gpt-5.5',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'developer',
            content: [
              { type: 'input_text', text: 'You are a helpful assistant.' }
            ]
          },
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Say "Hello from GPT Responses API (streaming)"' }
            ]
          }
        ]
      },
      {
        'authorization': `Bearer ${apiKey}`
      },
      'GPT Responses API (流式)',
      true
    );
  }

  // GPT Chat Completions API - 非流式
  if (choice === '5' || choice === '7') {
    await testEndpoint(
      baseUrl,
      apiKey,
      '/v1/chat/completions',
      {
        model: 'gpt-5.5',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'Say "Hello from GPT Chat Completions API (non-streaming)"' }
        ]
      },
      {
        'authorization': `Bearer ${apiKey}`
      },
      'GPT Chat Completions API (非流式)',
      false
    );
  }

  // GPT Chat Completions API - 流式
  if (choice === '6' || choice === '7') {
    await testEndpoint(
      baseUrl,
      apiKey,
      '/v1/chat/completions',
      {
        model: 'gpt-5.5',
        max_tokens: 100,
        stream: true,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say "Hello from GPT Chat Completions API (streaming)"' }
        ]
      },
      {
        'authorization': `Bearer ${apiKey}`
      },
      'GPT Chat Completions API (流式)',
      true
    );
  }

  console.log('\n========== Tests Complete ==========\n');
}

main();
