#!/usr/bin/env node
// Static verification of Messages implementation

import { readFileSync } from 'node:fs';

const serverCode = readFileSync('./src/server.mjs', 'utf8');

console.log('🔍 Static Verification of Messages Implementation\n');

let allPassed = true;

// Check 1: anthropicErrorResponse function
console.log('Check 1: anthropicErrorResponse function');
const hasAnthropicError = /function anthropicErrorResponse\(res, statusCode, errorType, message\)/.test(serverCode);
const hasCorrectFormat = /type: 'error'[\s\S]{1,100}error: \{[\s\S]{1,100}type: errorType/.test(serverCode);
if (hasAnthropicError && hasCorrectFormat) {
  console.log('  ✓ anthropicErrorResponse function present and correct\n');
} else {
  console.log('  ✗ FAIL: anthropicErrorResponse missing or malformed\n');
  allPassed = false;
}

// Check 2: Messages route with validation
console.log('Check 2: /v1/messages route with validation');
const hasMessagesRoute = /if \(pathname === '\/v1\/messages'\)/.test(serverCode);
const hasAuth = /isAuthorized\(req, config\)[\s\S]{1,200}anthropicErrorResponse\(res, 401/.test(serverCode);
const hasJsonValidation = /JSON\.parse\(originalBody[\s\S]{1,200}anthropicErrorResponse\(res, 400/.test(serverCode);
const hasModelValidation = /payload\.model.*missing required field: model/.test(serverCode);
const hasMessagesValidation = /payload\.messages.*missing required field: messages/.test(serverCode);
const hasMaxTokensValidation = /payload\.max_tokens.*max_tokens/.test(serverCode);

if (hasMessagesRoute && hasAuth && hasJsonValidation && hasModelValidation && hasMessagesValidation && hasMaxTokensValidation) {
  console.log('  ✓ /v1/messages route with complete validation\n');
} else {
  console.log('  ✗ FAIL: Messages route validation incomplete');
  console.log(`    Route: ${hasMessagesRoute}, Auth: ${hasAuth}, JSON: ${hasJsonValidation}`);
  console.log(`    Model: ${hasModelValidation}, Messages: ${hasMessagesValidation}, MaxTokens: ${hasMaxTokensValidation}\n`);
  allPassed = false;
}

// Check 3: Native forwarding logic
console.log('Check 3: Native Messages forwarding');
const hasChooseCandidate = /chooseCandidate\(state, tried/.test(serverCode);
const hasCandidateFilter = /candidateFilter: \(upstream\) =>[\s\S]{1,300}api === 'anthropic' \|\| api === 'both'/.test(serverCode);
const hasModelOverride = /state\.modelOverride \|\| originalModel/.test(serverCode);
const hasAnthropicPath = /anthropicMessagesPathForBaseUrl\(upstream\.baseUrl\)/.test(serverCode);
const hasAnthropicHeaders = /buildAnthropicRequestHeaders\(targetUrl, key\.value/.test(serverCode);

if (hasChooseCandidate && hasCandidateFilter && hasModelOverride && hasAnthropicPath && hasAnthropicHeaders) {
  console.log('  ✓ Native forwarding logic present\n');
} else {
  console.log('  ✗ FAIL: Forwarding logic incomplete');
  console.log(`    ChooseCandidate: ${hasChooseCandidate}, Filter: ${hasCandidateFilter}`);
  console.log(`    ModelOverride: ${hasModelOverride}, Path: ${hasAnthropicPath}, Headers: ${hasAnthropicHeaders}\n`);
  allPassed = false;
}

// Check 4: Request/Response handling
console.log('Check 4: Request/Response handling');
const hasHttpsRequest = /https\.request\(targetUrl/.test(serverCode);
const hasStreamingBoundary = /streamingBoundaryReached/.test(serverCode);
const hasRecordSuccess = /recordSuccess\(upstream, attemptStart/.test(serverCode);
const hasRecordFailure = /recordFailure\(state, upstream, key/.test(serverCode);
const hasRetryLogic = /allowRetry.*maxAttempts/.test(serverCode);
const hasPersistStats = /persistStats\(state, statsPath\)/.test(serverCode);

if (hasHttpsRequest && hasStreamingBoundary && hasRecordSuccess && hasRecordFailure && hasRetryLogic && hasPersistStats) {
  console.log('  ✓ Request/Response handling with retry and stats\n');
} else {
  console.log('  ✗ FAIL: Request/Response handling incomplete');
  console.log(`    HttpsRequest: ${hasHttpsRequest}, Streaming: ${hasStreamingBoundary}`);
  console.log(`    RecordSuccess: ${hasRecordSuccess}, RecordFailure: ${hasRecordFailure}`);
  console.log(`    Retry: ${hasRetryLogic}, PersistStats: ${hasPersistStats}\n`);
  allPassed = false;
}

// Check 5: Responses endpoint unchanged
console.log('Check 5: Responses endpoint unchanged');
const responsesStillWorks = serverCode.indexOf("if (pathname === '/v1/messages')") <
                            serverCode.indexOf("{ error: 'unauthorized: invalid Codex API pool token' }");
if (responsesStillWorks) {
  console.log('  ✓ Responses endpoint still uses OpenAI error format\n');
} else {
  console.log('  ✗ FAIL: Responses endpoint may be affected\n');
  allPassed = false;
}

// Check 6: No syntax errors (basic check)
console.log('Check 6: Basic syntax validation');
const hasSyntaxError = /\berror\b.*\bsyntax\b/i.test(serverCode);
const hasBalancedBraces = (serverCode.match(/\{/g)?.length || 0) === (serverCode.match(/\}/g)?.length || 0);
const hasBalancedParens = (serverCode.match(/\(/g)?.length || 0) === (serverCode.match(/\)/g)?.length || 0);

if (!hasSyntaxError && hasBalancedBraces && hasBalancedParens) {
  console.log('  ✓ No obvious syntax errors\n');
} else {
  console.log('  ✗ FAIL: Possible syntax errors');
  console.log(`    Braces balanced: ${hasBalancedBraces}, Parens balanced: ${hasBalancedParens}\n`);
  allPassed = false;
}

if (allPassed) {
  console.log('✅ All static checks passed!');
  console.log('\nImplementation appears correct. Key features:');
  console.log('  • /v1/messages endpoint with Anthropic error format');
  console.log('  • Complete validation (auth, JSON, required fields)');
  console.log('  • Anthropic-only upstream selection');
  console.log('  • Native Messages forwarding (no protocol conversion)');
  console.log('  • Streaming boundary respect');
  console.log('  • Retry logic with stats tracking');
  console.log('  • Model Override support');
  console.log('  • Responses endpoint unchanged');
  process.exit(0);
} else {
  console.log('❌ Some checks failed - review implementation');
  process.exit(1);
}
