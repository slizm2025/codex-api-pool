#!/usr/bin/env node
// Runtime tests for Messages → Chat Completions conversion

import { createPoolServer } from '../src/server.mjs';

// Access internal test functions
const { __testInternals } = await import('../src/server.mjs');

if (!__testInternals || !__testInternals.buildChatCompletionsFromMessages) {
  console.error('❌ Test internals not exported. Add to server.mjs:');
  console.error('export const __testInternals = { buildChatCompletionsFromMessages };');
  process.exit(1);
}

const { buildChatCompletionsFromMessages } = __testInternals;

console.log('🧪 Runtime Tests: Messages → Chat Completions Conversion\n');

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

// Test 1: Simple text message
test('Simple text message conversion', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [
      { role: 'user', content: 'Hello' }
    ],
    max_tokens: 100
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.model, 'claude-opus-4-8', 'Model should match');
  assertEqual(output.messages.length, 1, 'Should have 1 message');
  assertEqual(output.messages[0].role, 'user', 'Role should be user');
  assertEqual(output.messages[0].content, 'Hello', 'Content should match');
  assertEqual(output.max_completion_tokens, 100, 'Max tokens should be mapped');
});

// Test 2: Array content with text blocks
test('Array content with text blocks', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' }
        ]
      }
    ],
    max_tokens: 100
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.messages[0].content, 'First part\nSecond part', 'Text blocks should be joined');
});

// Test 3: System prompt conversion (string)
test('System prompt - string format', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    system: 'You are a helpful assistant',
    messages: [
      { role: 'user', content: 'Hello' }
    ],
    max_tokens: 100
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.messages.length, 2, 'Should have system + user message');
  assertEqual(output.messages[0].role, 'system', 'First message should be system');
  assertEqual(output.messages[0].content, 'You are a helpful assistant', 'System content should match');
});

// Test 4: System prompt conversion (array)
test('System prompt - array format', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    system: [
      { type: 'text', text: 'You are helpful.' },
      { type: 'text', text: 'Be concise.' }
    ],
    messages: [
      { role: 'user', content: 'Hello' }
    ],
    max_tokens: 100
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.messages[0].role, 'system', 'First message should be system');
  assertEqual(output.messages[0].content, 'You are helpful.\nBe concise.', 'System blocks should be joined');
});

// Test 5: Tool definitions conversion
test('Tool definitions conversion', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather data',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          },
          required: ['location']
        }
      }
    ]
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(Array.isArray(output.tools), true, 'Should have tools array');
  assertEqual(output.tools.length, 1, 'Should have 1 tool');
  assertEqual(output.tools[0].type, 'function', 'Tool type should be function');
  assertEqual(output.tools[0].function.name, 'get_weather', 'Tool name should match');
  assertEqual(output.tools[0].function.description, 'Get weather data', 'Tool description should match');
  assertEqual(output.tools[0].function.parameters.properties.location.type, 'string', 'Tool parameters should match');
});

// Test 6: Tool choice - auto
test('Tool choice - auto', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    tools: [{ name: 'test_tool', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' }
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.tool_choice, 'auto', 'Tool choice auto should map to "auto"');
});

// Test 7: Tool choice - any → required
test('Tool choice - any → required', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    tools: [{ name: 'test_tool', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' }
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.tool_choice, 'required', 'Tool choice any should map to "required"');
});

// Test 8: Tool choice - specific tool
test('Tool choice - specific tool', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'get_weather' }
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(typeof output.tool_choice, 'object', 'Tool choice should be object');
  assertEqual(output.tool_choice.type, 'function', 'Tool choice type should be function');
  assertEqual(output.tool_choice.function.name, 'get_weather', 'Tool choice name should match');
});

// Test 9: Tool use blocks → tool_calls
test('Tool use blocks → tool_calls', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check that' },
          {
            type: 'tool_use',
            id: 'toolu_123',
            name: 'get_weather',
            input: { location: 'NYC' }
          }
        ]
      }
    ],
    max_tokens: 100
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.messages[0].role, 'assistant', 'Should be assistant message');
  assertEqual(Array.isArray(output.messages[0].tool_calls), true, 'Should have tool_calls');
  assertEqual(output.messages[0].tool_calls.length, 1, 'Should have 1 tool call');
  assertEqual(output.messages[0].tool_calls[0].id, 'toolu_123', 'Tool call ID should match');
  assertEqual(output.messages[0].tool_calls[0].type, 'function', 'Tool call type should be function');
  assertEqual(output.messages[0].tool_calls[0].function.name, 'get_weather', 'Tool name should match');
});

// Test 10: Tool result blocks → tool messages
test('Tool result blocks → tool messages', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            content: 'Weather is sunny'
          }
        ]
      }
    ],
    max_tokens: 100
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.messages[0].role, 'tool', 'Should be tool message');
  assertEqual(output.messages[0].tool_call_id, 'toolu_123', 'Tool call ID should match');
  assertEqual(output.messages[0].content, 'Weather is sunny', 'Tool result content should match');
});

// Test 11: Image conversion - base64
test('Image conversion - base64', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo='
            }
          }
        ]
      }
    ],
    max_tokens: 100
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(Array.isArray(output.messages[0].content), true, 'Content should be array');
  assertEqual(output.messages[0].content.length, 2, 'Should have text + image');
  assertEqual(output.messages[0].content[1].type, 'image_url', 'Second item should be image_url');
  assertEqual(
    output.messages[0].content[1].image_url.url,
    'data:image/png;base64,iVBORw0KGgo=',
    'Image URL should be data URI'
  );
});

// Test 12: Temperature and top_p
test('Temperature and top_p mapping', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    temperature: 0.7,
    top_p: 0.9
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.temperature, 0.7, 'Temperature should match');
  assertEqual(output.top_p, 0.9, 'Top_p should match');
});

// Test 13: Stop sequences
test('Stop sequences mapping', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    stop_sequences: ['STOP', 'END']
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(Array.isArray(output.stop), true, 'Stop should be array');
  assertEqual(output.stop.length, 2, 'Should have 2 stop sequences');
  assertEqual(output.stop[0], 'STOP', 'First stop should match');
});

// Test 14: Output format - json_schema
test('Output format - json_schema', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    output_config: {
      format: {
        type: 'json_schema',
        json_schema: {
          name: 'person',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' }
            }
          }
        }
      }
    }
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.response_format.type, 'json_schema', 'Response format type should match');
  assertEqual(output.response_format.json_schema.name, 'person', 'Schema name should match');
});

// Test 15: Metadata user_id → user
test('Metadata user_id → user', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    metadata: { user_id: 'user-123' }
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.user, 'user-123', 'User should be mapped from metadata.user_id');
});

// Test 16: Stream with stream_options
test('Stream with stream_options', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    stream: true
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8');
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.stream, true, 'Stream should be true');
  assertEqual(output.stream_options.include_usage, true, 'Should include usage in stream');
});

// Test 17: Strip thinking blocks
test('Strip thinking blocks when stripMessagesOnlyFeatures enabled', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'The answer is 42' }
        ]
      }
    ],
    max_tokens: 100
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8', {
    stripMessagesOnlyFeatures: true
  });
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.messages[0].content, 'The answer is 42', 'Thinking block should be stripped');
});

// Test 18: Strip Computer Use tools
test('Strip Computer Use tools when stripMessagesOnlyFeatures enabled', () => {
  const input = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    tools: [
      { name: 'get_weather', input_schema: { type: 'object' } },
      { type: 'computer_20241022', name: 'computer', display_width_px: 1024, display_height_px: 768 },
      { name: 'calculate', input_schema: { type: 'object' } }
    ]
  }));

  const result = buildChatCompletionsFromMessages(input, 'claude-opus-4-8', {
    stripMessagesOnlyFeatures: true
  });
  const output = JSON.parse(result.toString('utf8'));

  assertEqual(output.tools.length, 2, 'Should have 2 tools (Computer Use stripped)');
  assertEqual(output.tools[0].function.name, 'get_weather', 'First tool should be get_weather');
  assertEqual(output.tools[1].function.name, 'calculate', 'Second tool should be calculate');
});

// Summary
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}

console.log('\n✅ All conversion tests passed!');
