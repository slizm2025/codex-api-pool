#!/usr/bin/env node

import { __testInternals } from '../src/server.mjs';

const {
  buildAnthropicRequestHeaders,
  buildProbeHeaders,
  classifyModelProbe,
  effectiveProbeModelForUpstream
} = __testInternals;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const clientRestricted = classifyModelProbe({
  statusCode: 403,
  error: '',
  body: JSON.stringify({
    error: {
      message: '该渠道不允许当前客户端使用（检测到：Go-http-client/1.1）',
      type: 'new_api_error',
      code: 'channel:client_restricted'
    }
  }),
  headers: { 'content-type': 'application/json' }
}, 'anthropic');

assert(
  clientRestricted.state === 'advanced_curl_required',
  `expected client restriction to be non-representative, got ${clientRestricted.state}`
);
assert(clientRestricted.authoritative === false, 'client restriction must not be authoritative');
assert(clientRestricted.representative === false, 'client restriction must not be representative');

const anyClaudeOneMillionContext = classifyModelProbe({
  statusCode: 400,
  error: '',
  body: JSON.stringify({
    error: '1m 上下文已经全量可用，请启用 1m 上下文后重试',
    type: 'error'
  }),
  headers: { 'content-type': 'application/json' }
}, 'anthropic');

assert(
  anyClaudeOneMillionContext.state === 'advanced_curl_required',
  `expected any 1m context prompt to be non-representative, got ${anyClaudeOneMillionContext.state}`
);
assert(anyClaudeOneMillionContext.authoritative === false, 'any 1m context prompt must not be authoritative');
assert(anyClaudeOneMillionContext.representative === false, 'any 1m context prompt must not be representative');

const anyCodexServiceUnavailable = classifyModelProbe({
  statusCode: 503,
  error: '',
  body: JSON.stringify({
    error: {
      message: 'Service Unavailable',
      type: 'error'
    },
    type: 'error'
  }),
  headers: { 'content-type': 'application/json' }
}, 'responses');

assert(
  anyCodexServiceUnavailable.state === 'inconclusive',
  `expected vague any 503 to remain inconclusive, got ${anyCodexServiceUnavailable.state}`
);
assert(anyCodexServiceUnavailable.authoritative === false, 'vague any 503 must not be authoritative');

const anthropicHeaders = buildAnthropicRequestHeaders('https://example.test/v1/messages', 'upstream-key', {}, {});
assert(anthropicHeaders['x-api-key'] === 'upstream-key', 'Anthropic forwarding should use x-api-key');
assert(/claude-cli\//.test(anthropicHeaders['user-agent'] || ''), 'Anthropic forwarding should use a Claude CLI User-Agent by default');
assert(
  String(anthropicHeaders['anthropic-beta'] || '').includes('context-1m-2025-08-07'),
  `Anthropic forwarding should enable 1m context beta by default, got ${anthropicHeaders['anthropic-beta'] || ''}`
);

const customProbeHeaders = buildProbeHeaders('https://example.test/v1/messages', 'upstream-key', 'anthropic', {
  'User-Agent': 'CustomClaudeProbe/1.0'
});
const userAgentHeaderNames = Object.keys(customProbeHeaders).filter((name) => name.toLowerCase() === 'user-agent');
assert(userAgentHeaderNames.length === 1, `expected one User-Agent header, got ${userAgentHeaderNames.join(',')}`);
assert(customProbeHeaders[userAgentHeaderNames[0]] === 'CustomClaudeProbe/1.0', 'explicit User-Agent should override the default');
assert(
  String(customProbeHeaders['anthropic-beta'] || '').includes('context-1m-2025-08-07'),
  `Anthropic probe should enable 1m context beta by default, got ${customProbeHeaders['anthropic-beta'] || ''}`
);

const selectedProbeModel = effectiveProbeModelForUpstream({
  api: 'anthropic',
  health: { models: ['claude-opus-4-6-cc', 'claude-sonnet-4-6-cc'] }
}, '', 'gpt-5.5');
assert(selectedProbeModel === 'claude-opus-4-6-cc', `expected first Claude model, got ${selectedProbeModel}`);

console.log('claude probe client restriction tests passed');
