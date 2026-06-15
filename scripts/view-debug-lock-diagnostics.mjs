#!/usr/bin/env node

// Debug Lock 诊断查看器
// 用法: node scripts/view-debug-lock-diagnostics.mjs [upstream_name]

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CODEX_POOL_CONFIG || resolve(__dirname, '../config.local.json');

// 读取配置获取 tokens
let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error('无法读取配置文件:', err.message);
  process.exit(1);
}

const BASE_URL = `http://${config.server?.host || '127.0.0.1'}:${config.server?.port || 8787}`;
const ADMIN_TOKEN = process.env[config.server?.admin_auth_token_env || 'CODEX_POOL_ADMIN_KEY'] || '';
const POOL_TOKEN = process.env[config.server?.auth_token_env || 'CODEX_POOL_API_KEY'] || '';

const upstreamName = process.argv[2];

async function main() {
  console.log('🔍 Debug Lock 诊断查看器\n');

  // 1. 检查当前 Debug Lock 状态
  const statusRes = await fetch(`${BASE_URL}/pool/status`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  });

  if (!statusRes.ok) {
    console.error('❌ 无法连接到 API Pool');
    console.error('   请确保服务器正在运行，且 ADMIN_TOKEN 正确');
    process.exit(1);
  }

  const status = await statusRes.json();

  console.log('📊 当前 Debug Lock 状态:');
  if (status.debug_lock?.enabled) {
    console.log(`   ✅ 已启用，锁定到: ${status.debug_lock.upstream}`);
    console.log(`   ⏰ 锁定时间: ${status.debug_lock.locked_at}`);
    console.log(`   🔧 模型覆盖: ${status.debug_lock.respect_model_override ? '开启' : '关闭'}`);
  } else {
    console.log('   ❌ 未启用');
    if (upstreamName) {
      console.log(`\n📝 提示: 可以使用以下命令启用 Debug Lock:`);
      console.log(`   curl -X POST ${BASE_URL}/pool/upstreams/${upstreamName}/debug-lock \\`);
      console.log(`     -H "Authorization: Bearer $CODEX_POOL_ADMIN_KEY" \\`);
      console.log(`     -H "Content-Type: application/json" \\`);
      console.log(`     -d '{"respect_model_override": true}'`);
    }
  }

  // 2. 查看最近的 Debug Lock 请求
  console.log('\n\n📋 最近的 Debug Lock 请求:\n');
  const debugLockRequests = (status.recent_requests || []).filter(r => r.debug_lock);

  if (debugLockRequests.length === 0) {
    console.log('   暂无 Debug Lock 请求记录');
    console.log('\n💡 提示: 启用 Debug Lock 后，发送一个测试请求，然后再次运行此脚本');
    return;
  }

  for (const req of debugLockRequests.slice(0, 5)) {
    const succeeded = req.succeeded ? '✅' : '❌';
    const icon = succeeded === '✅' ? '✅' : '❌';
    console.log(`${icon} ${req.at}`);
    console.log(`   Upstream: ${req.locked_upstream || req.upstream}`);
    console.log(`   模型: ${req.model || 'N/A'}`);
    console.log(`   状态: ${req.status} ${req.succeeded ? '成功' : '失败'}`);
    console.log(`   尝试: ${req.attempts} 次`);
    console.log(`   延迟: ${req.durationMs}ms`);
    if (req.final_protocol) {
      console.log(`   最终协议: ${req.final_protocol}`);
    }
    console.log('');
  }

  // 3. 如果最近有失败的请求，提供详细诊断获取方法
  const latestFailed = debugLockRequests.find(r => !r.succeeded);
  if (latestFailed) {
    console.log('\n\n💡 如何获取详细的诊断信息:\n');
    console.log('当 Debug Lock 请求失败时，完整的诊断信息在错误响应体中。');
    console.log('\n方法 1: 使用 curl 重新发送请求查看详细错误:\n');
    console.log(`curl -v ${BASE_URL}/v1/responses \\`);
    console.log(`  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -d '{"model": "gpt-4o", "input": "test", "max_tokens": 50}' | jq .`);

    console.log('\n方法 2: 启用请求日志 (在 config.local.json 中):\n');
    console.log('  "debug": {');
    console.log('    "capture_request_headers": true,');
    console.log('    "request_log_path": "./debug-requests.jsonl"');
    console.log('  }');
    console.log('\n然后重启服务器，所有请求的详细信息会写入 debug-requests.jsonl');
  }
}

main().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
