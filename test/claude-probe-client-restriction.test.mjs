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

const anthropicHeaders = buildAnthropicRequestHeaders('https://example.test/v1/messages', 'upstream-key', {}, {});
assert(anthropicHeaders['x-api-key'] === 'upstream-key', 'Anthropic forwarding should use x-api-key');
assert(/Mozilla\/5\.0/.test(anthropicHeaders['user-agent'] || ''), 'Anthropic forwarding should use a browser-like User-Agent by default');

const customProbeHeaders = buildProbeHeaders('https://example.test/v1/messages', 'upstream-key', 'anthropic', {
  'User-Agent': 'CustomClaudeProbe/1.0'
});
const userAgentHeaderNames = Object.keys(customProbeHeaders).filter((name) => name.toLowerCase() === 'user-agent');
assert(userAgentHeaderNames.length === 1, `expected one User-Agent header, got ${userAgentHeaderNames.join(',')}`);
assert(customProbeHeaders[userAgentHeaderNames[0]] === 'CustomClaudeProbe/1.0', 'explicit User-Agent should override the default');

const selectedProbeModel = effectiveProbeModelForUpstream({
  api: 'anthropic',
  health: { models: ['claude-opus-4-6-cc', 'claude-sonnet-4-6-cc'] }
}, '', 'gpt-5.5');
assert(selectedProbeModel === 'claude-opus-4-6-cc', `expected first Claude model, got ${selectedProbeModel}`);

console.log('claude probe client restriction tests passed');
