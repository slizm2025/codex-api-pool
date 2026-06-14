// 分析状态词汇表的一致性

import { readFileSync } from 'fs';

const serverCode = readFileSync('src/server.mjs', 'utf-8');
const managerCode = readFileSync('src/protocol-capability-manager.mjs', 'utf-8');

console.log('=== protocolCapabilityStatusFromProbeState 可能返回的状态 ===');
const statusFromProbeMatches = managerCode.match(/return ['"](\w+)['"]/g);
if (statusFromProbeMatches) {
  const statuses = [...new Set(statusFromProbeMatches.map(m => m.match(/['"](\w+)['"]/)[1]))];
  console.log('Possible returns:', statuses);
}

console.log('\n=== 代码中检查的状态值 ===');
const statusChecks = [
  ...serverCode.matchAll(/\.status\s*===\s*['"](failed|unsupported|unknown|verified|assumed|disabled)['"]/g),
  ...managerCode.matchAll(/\.status\s*===\s*['"](failed|unsupported|unknown|verified|assumed|disabled)['"]/g)
];

const checks = {};
for (const match of statusChecks) {
  const status = match[1];
  checks[status] = (checks[status] || 0) + 1;
}

console.log('Status checks found:');
Object.entries(checks).sort().forEach(([status, count]) => {
  console.log(`  ${status}: ${count} 次`);
});

console.log('\n=== 潜在的不一致 ===');
if (checks.failed) {
  console.log(`⚠️  代码中有 ${checks.failed} 处检查 status === 'failed'`);
  console.log(`   但 protocolCapabilityStatusFromProbeState 不再返回 'failed'`);
}
