#!/usr/bin/env node
// Debug: 检查转换函数的输出

import { __testInternals } from '../src/server.mjs';

const { buildChatCompletionsFromMessages } = __testInternals;

console.log('🔍 调试 buildChatCompletionsFromMessages\n');

const testInput = Buffer.from(JSON.stringify({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'test message' }],
  max_tokens: 100
}));

console.log('输入:');
console.log(testInput.toString('utf8'));
console.log(`\n输入长度: ${testInput.length} 字节\n`);

const result = buildChatCompletionsFromMessages(testInput, 'gpt-4', { stripMessagesOnlyFeatures: true });

console.log('输出:');
console.log(result.toString('utf8'));
console.log(`\n输出长度: ${result.length} 字节`);
console.log(`输出类型: ${result.constructor.name}`);

// 验证 JSON 有效性
try {
  const parsed = JSON.parse(result.toString('utf8'));
  console.log('\n✅ 输出是有效的 JSON');
  console.log(`字段数量: ${Object.keys(parsed).length}`);
  console.log(`字段: ${Object.keys(parsed).join(', ')}`);
} catch (e) {
  console.log(`\n❌ 输出不是有效的 JSON: ${e.message}`);
}
