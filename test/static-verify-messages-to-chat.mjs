#!/usr/bin/env node
// TDD Tests for Issue #4: Messages → Chat Completions request conversion

import { readFileSync } from 'node:fs';

// Load server code to access conversion functions
const serverCode = readFileSync('./src/server.mjs', 'utf8');

console.log('🧪 Testing Messages → Chat Completions Conversion\n');

// Test 1: Check that conversion functions exist
console.log('Test 1: Conversion functions defined');
{
  const hasMessagesToChatMessages = /function anthropicMessagesToChatMessages/.test(serverCode);
  const hasSystemToChatSystem = /function anthropicSystemToChatSystem/.test(serverCode);
  const hasToolsToChatTools = /function anthropicToolsToChatTools/.test(serverCode);
  const hasToolChoiceConversion = /function anthropicToolChoiceToChatToolChoice/.test(serverCode);
  const hasBuildFunction = /function buildChatCompletionsFromMessages/.test(serverCode);

  if (hasMessagesToChatMessages && hasSystemToChatSystem && hasToolsToChatTools &&
      hasToolChoiceConversion && hasBuildFunction) {
    console.log('  ✓ All conversion functions defined\n');
  } else {
    console.log('  ✗ FAIL: Missing conversion functions');
    console.log(`    Messages: ${hasMessagesToChatMessages}, System: ${hasSystemToChatSystem}`);
    console.log(`    Tools: ${hasToolsToChatTools}, ToolChoice: ${hasToolChoiceConversion}`);
    console.log(`    Build: ${hasBuildFunction}\n`);
  }
}

// Test 2: Messages array conversion handles text blocks
console.log('Test 2: Text block conversion');
{
  const hasTextHandling = /block\.type === 'text'/.test(serverCode);
  const pushesTextParts = /textParts\.push\(block\.text/.test(serverCode);

  if (hasTextHandling && pushesTextParts) {
    console.log('  ✓ Text block handling present\n');
  } else {
    console.log('  ✗ FAIL: Text block handling incomplete\n');
  }
}

// Test 3: Image conversion to image_url format
console.log('Test 3: Image conversion');
{
  const hasImageHandling = /block\.type === 'image'/.test(serverCode);
  const hasBase64Conversion = /data:.*base64/.test(serverCode);
  const hasImageUrl = /image_url/.test(serverCode);

  if (hasImageHandling && hasBase64Conversion && hasImageUrl) {
    console.log('  ✓ Image to image_url conversion present\n');
  } else {
    console.log('  ✗ FAIL: Image conversion incomplete\n');
  }
}

// Test 4: Tool use blocks → tool_calls
console.log('Test 4: Tool use → tool_calls conversion');
{
  const hasToolUseHandling = /block\.type === 'tool_use'/.test(serverCode);
  const hasToolCallsPush = /toolCalls\.push/.test(serverCode);
  const hasFunctionType = /type: 'function'/.test(serverCode);

  if (hasToolUseHandling && hasToolCallsPush && hasFunctionType) {
    console.log('  ✓ Tool use → tool_calls conversion present\n');
  } else {
    console.log('  ✗ FAIL: Tool calls conversion incomplete\n');
  }
}

// Test 5: Tool result blocks → tool messages
console.log('Test 5: Tool result → tool message conversion');
{
  const hasToolResultHandling = /block\.type === 'tool_result'/.test(serverCode);
  const hasToolRole = /role: 'tool'/.test(serverCode);
  const hasToolCallId = /tool_call_id/.test(serverCode);

  if (hasToolResultHandling && hasToolRole && hasToolCallId) {
    console.log('  ✓ Tool result → tool message conversion present\n');
  } else {
    console.log('  ✗ FAIL: Tool result conversion incomplete\n');
  }
}

// Test 6: System prompt conversion
console.log('Test 6: System prompt conversion');
{
  const hasSystemFunction = /function anthropicSystemToChatSystem/.test(serverCode);
  const hasStringHandling = /typeof system === 'string'/.test(serverCode);
  const hasArrayHandling = /Array\.isArray\(system\)/.test(serverCode);

  if (hasSystemFunction && hasStringHandling && hasArrayHandling) {
    console.log('  ✓ System prompt conversion (string + array)\n');
  } else {
    console.log('  ✗ FAIL: System prompt conversion incomplete\n');
  }
}

// Test 7: Tools array conversion
console.log('Test 7: Tools array conversion');
{
  const hasToolsFunction = /function anthropicToolsToChatTools/.test(serverCode);
  const hasInputSchemaMapping = /input_schema.*parameters/.test(serverCode);
  const hasFunctionWrapper = /type: 'function'[\s\S]{0,200}function:/.test(serverCode);

  if (hasToolsFunction && hasInputSchemaMapping && hasFunctionWrapper) {
    console.log('  ✓ Tools → Chat tools conversion present\n');
  } else {
    console.log('  ✗ FAIL: Tools conversion incomplete\n');
  }
}

// Test 8: Tool choice conversion
console.log('Test 8: Tool choice conversion');
{
  const hasToolChoiceFunction = /function anthropicToolChoiceToChatToolChoice/.test(serverCode);
  const hasAutoMapping = /type === 'auto'.*return 'auto'/.test(serverCode);
  const hasAnyMapping = /type === 'any'.*return 'required'/.test(serverCode);
  const hasToolMapping = /type === 'tool'/.test(serverCode);

  if (hasToolChoiceFunction && hasAutoMapping && hasAnyMapping && hasToolMapping) {
    console.log('  ✓ Tool choice conversion (auto/any/tool)\n');
  } else {
    console.log('  ✗ FAIL: Tool choice conversion incomplete');
    console.log(`    Auto: ${hasAutoMapping}, Any: ${hasAnyMapping}, Tool: ${hasToolMapping}\n`);
  }
}

// Test 9: Field mappings
console.log('Test 9: Field mappings');
{
  const hasMaxTokens = /max_tokens.*max_completion_tokens/.test(serverCode);
  const hasTemperature = /payload\.temperature.*chat\.temperature/.test(serverCode);
  const hasTopP = /payload\.top_p.*chat\.top_p/.test(serverCode);
  const hasStop = /stop_sequences[\s\S]{0,160}chat\.stop/.test(serverCode);
  const hasResponseFormat = /output_config[\s\S]{0,240}response_format/.test(serverCode);
  const hasUserMetadata = /metadata\?\.user_id[\s\S]{0,120}chat\.user/.test(serverCode);

  if (hasMaxTokens && hasTemperature && hasTopP && hasStop && hasResponseFormat && hasUserMetadata) {
    console.log('  ✓ All field mappings present\n');
  } else {
    console.log('  ✗ FAIL: Some field mappings missing');
    console.log(`    MaxTokens: ${hasMaxTokens}, Temp: ${hasTemperature}, TopP: ${hasTopP}`);
    console.log(`    Stop: ${hasStop}, Format: ${hasResponseFormat}, User: ${hasUserMetadata}\n`);
  }
}

// Test 10: Messages-only features stripping
console.log('Test 10: Messages-only features stripping');
{
  const hasStripOption = /stripMessagesOnlyFeatures/.test(serverCode);
  const hasThinkingStrip = /type === 'thinking'[\s\S]{0,100}stripFeatures[\s\S]{0,100}continue/.test(serverCode);
  const hasComputerUseStrip = /COMPUTER_USE_TOOL_TYPES/.test(serverCode);

  if (hasStripOption && hasThinkingStrip && hasComputerUseStrip) {
    console.log('  ✓ Feature stripping logic present\n');
  } else {
    console.log('  ✗ FAIL: Feature stripping incomplete');
    console.log(`    StripOption: ${hasStripOption}, Thinking: ${hasThinkingStrip}, ComputerUse: ${hasComputerUseStrip}\n`);
  }
}

// Test 11: Main build function structure
console.log('Test 11: Main build function');
{
  const hasBuildFunction = /function buildChatCompletionsFromMessages/.test(serverCode);
  const parsesPayload = /JSON\.parse\(body\.toString/.test(serverCode);
  const callsMessageConversion = /anthropicMessagesToChatMessages/.test(serverCode);
  const callsSystemConversion = /anthropicSystemToChatSystem/.test(serverCode);
  const returnsBuffer = /return Buffer\.from\(JSON\.stringify\(chat\)\)/.test(serverCode);

  if (hasBuildFunction && parsesPayload && callsMessageConversion &&
      callsSystemConversion && returnsBuffer) {
    console.log('  ✓ Main build function structure complete\n');
  } else {
    console.log('  ✗ FAIL: Main build function incomplete');
    console.log(`    Function: ${hasBuildFunction}, Parse: ${parsesPayload}`);
    console.log(`    Messages: ${callsMessageConversion}, System: ${callsSystemConversion}`);
    console.log(`    Return: ${returnsBuffer}\n`);
  }
}

// Test 12: Stream options
console.log('Test 12: Stream options handling');
{
  const hasStreamOptions = /chat\.stream.*stream_options/.test(serverCode);
  const hasIncludeUsage = /include_usage: true/.test(serverCode);

  if (hasStreamOptions && hasIncludeUsage) {
    console.log('  ✓ Stream options with include_usage\n');
  } else {
    console.log('  ✗ FAIL: Stream options handling missing\n');
  }
}

console.log('✅ Static verification complete!');
console.log('\nNext: Create runtime tests with actual conversion examples');
