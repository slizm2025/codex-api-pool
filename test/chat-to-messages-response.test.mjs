#!/usr/bin/env node
// Runtime tests for Chat Completions → Messages response conversion

import { __testInternals } from '../src/server.mjs';

if (!__testInternals || !__testInternals.chatCompletionToMessagesJson) {
  console.error('❌ Test internals not exported properly');
  process.exit(1);
}

const { chatCompletionToMessagesJson } = __testInternals;

console.log('🧪 Runtime Tests: Chat Completions → Messages Response Conversion\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${error.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  const actualStr = JSON.stringify(actual, null, 2);
  const expectedStr = JSON.stringify(expected, null, 2);
  if (actualStr !== expectedStr) {
    throw new Error(`${message}\n  Expected: ${expectedStr}\n  Actual: ${actualStr}`);
  }
}

// Test 1: Simple text response
test('Simple text response conversion', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1234567890,
    model: 'gpt-4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'Hello, how can I help you?'
      },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18
    }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.type, 'message', 'Type should be message');
  assertEqual(output.role, 'assistant', 'Role should be assistant');
  assertEqual(output.content.length, 1, 'Should have 1 content block');
  assertEqual(output.content[0].type, 'text', 'Content type should be text');
  assertEqual(output.content[0].text, 'Hello, how can I help you?', 'Text should match');
  assertEqual(output.stop_reason, 'end_turn', 'stop should map to end_turn');
  assertEqual(output.usage.input_tokens, 10, 'Input tokens should match');
  assertEqual(output.usage.output_tokens, 8, 'Output tokens should match');
});

// Test 2: Message ID conversion
test('Message ID conversion (chatcmpl → msg)', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: { role: 'assistant', content: 'Hi' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.id, 'msg_abc123', 'ID should be converted from chatcmpl to msg');
});

// Test 3: Tool calls conversion
test('Tool calls → tool_use conversion', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-456',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"NYC","unit":"celsius"}'
            }
          }
        ]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 15, completion_tokens: 10 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.content.length, 1, 'Should have 1 content block');
  assertEqual(output.content[0].type, 'tool_use', 'Content type should be tool_use');
  assertEqual(output.content[0].id, 'call_abc', 'Tool use ID should match');
  assertEqual(output.content[0].name, 'get_weather', 'Tool name should match');
  assertEqual(output.content[0].input.location, 'NYC', 'Tool input should be parsed');
  assertEqual(output.content[0].input.unit, 'celsius', 'Tool input should be complete');
  assertEqual(output.stop_reason, 'tool_use', 'tool_calls finish_reason should map to tool_use');
});

// Test 4: Text + tool calls combined
test('Text + tool calls combined', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-789',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: {
        role: 'assistant',
        content: 'Let me check that for you.',
        tool_calls: [
          {
            id: 'call_xyz',
            type: 'function',
            function: {
              name: 'search',
              arguments: '{"query":"test"}'
            }
          }
        ]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 20, completion_tokens: 15 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.content.length, 2, 'Should have 2 content blocks');
  assertEqual(output.content[0].type, 'text', 'First block should be text');
  assertEqual(output.content[0].text, 'Let me check that for you.', 'Text should match');
  assertEqual(output.content[1].type, 'tool_use', 'Second block should be tool_use');
  assertEqual(output.content[1].name, 'search', 'Tool name should match');
});

// Test 5: Multiple tool calls
test('Multiple tool calls', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-multi',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'tool_a', arguments: '{"arg":"a"}' }
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'tool_b', arguments: '{"arg":"b"}' }
          }
        ]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 25, completion_tokens: 20 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.content.length, 2, 'Should have 2 tool_use blocks');
  assertEqual(output.content[0].name, 'tool_a', 'First tool name should match');
  assertEqual(output.content[1].name, 'tool_b', 'Second tool name should match');
});

// Test 6: Finish reason mappings
test('Finish reason: length → max_tokens', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-len',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: { role: 'assistant', content: 'Text' },
      finish_reason: 'length'
    }],
    usage: { prompt_tokens: 5, completion_tokens: 100 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.stop_reason, 'max_tokens', 'length should map to max_tokens');
});

test('Finish reason: content_filter → stop_sequence', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-filter',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: { role: 'assistant', content: 'Filtered' },
      finish_reason: 'content_filter'
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.stop_reason, 'stop_sequence', 'content_filter should map to stop_sequence');
});

// Test 7: Usage tokens mapping
test('Usage tokens mapping', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-usage',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: { role: 'assistant', content: 'Test' },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 123,
      completion_tokens: 456,
      total_tokens: 579
    }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.usage.input_tokens, 123, 'prompt_tokens should map to input_tokens');
  assertEqual(output.usage.output_tokens, 456, 'completion_tokens should map to output_tokens');
  assertEqual(output.usage.total_tokens, undefined, 'total_tokens should not be in Messages format');
});

// Test 8: Model passthrough
test('Model passthrough', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-model',
    object: 'chat.completion',
    model: 'gpt-4-turbo-preview',
    choices: [{
      message: { role: 'assistant', content: 'Test' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4-turbo-preview');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.model, 'gpt-4-turbo-preview', 'Model should match response model');
});

// Test 9: Empty content handling
test('Empty content handling', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-empty',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: { role: 'assistant', content: '' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 5, completion_tokens: 0 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.content.length, 0, 'Empty content should result in empty array');
});

// Test 10: Invalid JSON handling
test('Invalid JSON handling', () => {
  const input = Buffer.from('not valid json');

  const result = chatCompletionToMessagesJson(input, 'gpt-4');

  assertEqual(result.toString('utf8'), 'not valid json', 'Invalid JSON should be returned as-is');
});

// Test 11: Missing choices handling
test('Missing choices handling', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-nochoice',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 0 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');

  // Should return original body when no valid choice
  assertEqual(result, input, 'Missing choices should return original body');
});

// Test 12: Tool arguments parsing error handling
test('Tool arguments parsing error handling', () => {
  const input = Buffer.from(JSON.stringify({
    id: 'chatcmpl-badargs',
    object: 'chat.completion',
    model: 'gpt-4',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bad',
            type: 'function',
            function: {
              name: 'test_tool',
              arguments: 'not valid json{'
            }
          }
        ]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }));

  const result = chatCompletionToMessagesJson(input, 'gpt-4');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.content[0].type, 'tool_use', 'Should still create tool_use block');
  assertEqual(typeof output.content[0].input, 'object', 'Input should be object even if parsing fails');
  assertEqual(Object.keys(output.content[0].input).length, 0, 'Input should be empty object on parse error');
});

// Summary
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}

console.log('\n✅ All response conversion tests passed!');
