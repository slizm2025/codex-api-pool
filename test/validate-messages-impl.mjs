#!/usr/bin/env node
// Quick validation script to verify Messages entry implementation

import { readFileSync } from 'node:fs';

const serverCode = readFileSync('./src/server.mjs', 'utf8');

console.log('Validating Messages entry implementation...\n');

// Check 1: anthropicErrorResponse function exists
const hasAnthropicError = /function anthropicErrorResponse\(res, statusCode, errorType, message\)/.test(serverCode);
console.log(`✓ anthropicErrorResponse function: ${hasAnthropicError ? 'FOUND' : 'MISSING'}`);

// Check 2: /v1/messages route handler exists
const hasMessagesRoute = /if \(pathname === '\/v1\/messages'\)/.test(serverCode);
console.log(`✓ /v1/messages route handler: ${hasMessagesRoute ? 'FOUND' : 'MISSING'}`);

// Check 3: Authentication check for Messages
const hasMessagesAuth = /if \(pathname === '\/v1\/messages'\)[\s\S]{1,500}isAuthorized\(req, config\)[\s\S]{1,200}anthropicErrorResponse/.test(serverCode);
console.log(`✓ Messages authentication: ${hasMessagesAuth ? 'FOUND' : 'MISSING'}`);

// Check 4: JSON validation
const hasJsonValidation = /JSON\.parse\(originalBody[\s\S]{1,300}anthropicErrorResponse\(res, 400, 'invalid_request_error'/.test(serverCode);
console.log(`✓ JSON validation: ${hasJsonValidation ? 'FOUND' : 'MISSING'}`);

// Check 5: Field validation (model, messages, max_tokens)
const hasModelValidation = /payload\.model[\s\S]{1,200}missing required field: model/.test(serverCode);
const hasMessagesValidation = /payload\.messages[\s\S]{1,200}missing required field: messages/.test(serverCode);
const hasMaxTokensValidation = /payload\.max_tokens[\s\S]{1,200}max_tokens/.test(serverCode);
console.log(`✓ model field validation: ${hasModelValidation ? 'FOUND' : 'MISSING'}`);
console.log(`✓ messages field validation: ${hasMessagesValidation ? 'FOUND' : 'MISSING'}`);
console.log(`✓ max_tokens field validation: ${hasMaxTokensValidation ? 'FOUND' : 'MISSING'}`);

// Check 6: Anthropic error format structure
const hasAnthropicErrorStructure = /type: 'error'[\s\S]{1,100}error: \{[\s\S]{1,100}type: errorType/.test(serverCode);
console.log(`✓ Anthropic error structure: ${hasAnthropicErrorStructure ? 'FOUND' : 'MISSING'}`);

// Check 7: Responses endpoint still uses OpenAI format
const responsesAuthAfterMessages = serverCode.indexOf("if (pathname === '/v1/messages')") < serverCode.indexOf("{ error: 'unauthorized: invalid Codex API pool token' }");
console.log(`✓ Responses keeps OpenAI format: ${responsesAuthAfterMessages ? 'YES' : 'NO'}`);

const allPassed = hasAnthropicError && hasMessagesRoute && hasMessagesAuth &&
                  hasJsonValidation && hasModelValidation && hasMessagesValidation &&
                  hasMaxTokensValidation && hasAnthropicErrorStructure && responsesAuthAfterMessages;

console.log(`\n${allPassed ? '✅ All checks passed!' : '❌ Some checks failed'}`);
process.exit(allPassed ? 0 : 1);
