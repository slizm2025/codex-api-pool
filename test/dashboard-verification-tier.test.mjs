// Dashboard Verification Tier Logic Test
//
// Regression test for dashboard rendering issue where deriveVerificationTier
// was called but not defined in the inline JavaScript.
//
// This test verifies that the dashboard HTML contains all necessary function
// definitions for the verification tier logic.

import { strict as assert } from 'assert';
import http from 'http';

const DASHBOARD_URL = 'http://127.0.0.1:8787/pool/dashboard';

async function fetchDashboard() {
  return new Promise((resolve, reject) => {
    http.get(DASHBOARD_URL, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('Dashboard Verification Tier Logic Test\n');

  let html;
  try {
    html = await fetchDashboard();
  } catch (err) {
    console.error('✗ 无法连接到服务器:', err.message);
    console.error('  请确保服务器运行在 http://127.0.0.1:8787');
    process.exit(1);
  }

  const tests = [
    {
      name: 'deriveVerificationTier 函数已定义',
      check: () => html.includes('function deriveVerificationTier(upstream)')
    },
    {
      name: 'PROTOCOL_CAPABILITY_NAMES 常量已定义',
      check: () => html.includes('PROTOCOL_CAPABILITY_NAMES')
    },
    {
      name: 'verificationDetail 函数已定义 (browser)',
      check: () => html.includes('function verificationDetail(upstream)')
    },
    {
      name: 'verificationTier 函数已定义 (browser)',
      check: () => html.includes('function verificationTier(upstream)')
    },
    {
      name: 'verificationTier 通过 VERIFICATION_TIER_TO_FILTER 映射',
      check: () => html.includes('VERIFICATION_TIER_TO_FILTER')
    },
    {
      name: 'verificationTier 优先使用 server 预计算的 verification_detail',
      check: () => html.includes('verification_detail')
    },
    {
      name: 'verificationFilterMatches 函数已定义',
      check: () => html.includes('verificationFilterMatches')
    },
    {
      name: 'deriveVerificationTier 定义在 verificationDetail 之前',
      check: () => {
        const deriveIndex = html.indexOf('function deriveVerificationTier');
        const detailIndex = html.indexOf('function verificationDetail');
        return deriveIndex > 0 && detailIndex > 0 && deriveIndex < detailIndex;
      }
    },
    {
      name: '包含所有三个协议名称',
      check: () => {
        return html.includes('responses') &&
               html.includes('chat_completions') &&
               html.includes('anthropic_messages');
      }
    },
    {
      name: '包含 proven_by_traffic 检查',
      check: () => html.includes("source === 'real_traffic'")
    },
    {
      name: '包含 proven_by_probe 检查',
      check: () => html.includes("source === 'probe'")
    },
    {
      name: '包含 not_verified 返回值',
      check: () => html.includes("return 'not_verified'")
    },
    {
      name: '卡片渲染 data-verification-indicator 属性',
      check: () => html.includes('data-verification-indicator')
    },
    {
      name: '卡片渲染 verification-dot 可视化徽标',
      check: () => html.includes('verification-dot')
    },
    {
      name: '包含 6 种指示器颜色样式',
      check: () => ['green', 'yellow', 'blue', 'grey', 'orange', 'red']
        .every((c) => html.includes(`data-indicator=\\"${c}\\"`))
    },
    {
      name: '四个验证筛选按钮均存在 (real_verified/probe_only/real_pending/unavailable)',
      check: () => ['real_verified', 'probe_only', 'real_pending', 'unavailable']
        .every((k) => html.includes(`data-verification-filter="${k}"`))
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = test.check();
      if (result) {
        console.log(`✓ ${test.name}`);
        passed++;
      } else {
        console.log(`✗ ${test.name}`);
        failed++;
      }
    } catch (err) {
      console.log(`✗ ${test.name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n测试结果: ${passed} 通过, ${failed} 失败`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
