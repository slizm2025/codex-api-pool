#!/usr/bin/env node

import { createPoolServer, __testInternals } from '../src/server.mjs';

const {
  capabilityManagerFor,
  classifyModelProbe,
  healthProbeOk,
  healthProbeStatus,
  chooseCandidate,
  upstreamAvailable
} = __testInternals;

let testCount = 0;
let passCount = 0;
let failCount = 0;

process.env.ANY_UPSTREAM_KEY = 'upstream-secret';

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function createPool(upstream, modelOverride) {
  return createPoolServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      public_prefix: '/v1',
      request_timeout_ms: 5000
    },
    model_override: modelOverride,
    retry: {
      max_attempts: 1,
      failure_threshold: 1,
      base_cooldown_ms: 1000,
      key_cooldown_ms: 1000
    },
    health: { enabled: false, path: '/models', timeout_ms: 1000 },
    upstreams: [
      {
        base_url: 'https://any.example.test/v1',
        weight: 1,
        keys: [{ env: 'ANY_UPSTREAM_KEY' }],
        ...upstream
      }
    ]
  });
}

function applySyntheticProbe({
  upstream,
  key,
  classifierProtocol,
  capabilityProtocol,
  model,
  statusCode,
  body
}) {
  const result = {
    statusCode,
    body: JSON.stringify(body),
    ok: false,
    latencyMs: 12,
    headers: { 'content-type': 'application/json' }
  };
  const classified = classifyModelProbe(result, classifierProtocol);
  const action = capabilityManagerFor(upstream).applyProbeResult(
    key,
    capabilityProtocol,
    result,
    classified,
    { checkedAt: '2026-06-15T00:00:00Z', model }
  );
  return { result, classified, action };
}

function assertStillSelectable(server, model, expectedName) {
  const upstream = server.state.upstreams.find((item) => item.name === expectedName);
  assert(upstream, `expected upstream ${expectedName}`);
  assert(upstreamAvailable(upstream, Date.now(), model) === true, `expected ${expectedName} to stay selectable`);
  const candidate = chooseCandidate(server.state, new Set(), { preferredModel: model });
  assert(candidate?.upstream?.name === expectedName, `expected Selection to keep ${expectedName}, got ${candidate?.upstream?.name || 'none'}`);
  assert(candidate?.key?.value === process.env.ANY_UPSTREAM_KEY, 'expected configured key to remain selectable');
}

test('any GPT Service Unavailable probe is inconclusive and remains selectable', () => {
  const server = createPool({ name: 'any-gpt', api: 'openai' }, 'gpt-5.5');
  const upstream = server.state.upstreams[0];
  const key = upstream.keys[0];

  const { classified, action } = applySyntheticProbe({
    upstream,
    key,
    classifierProtocol: 'responses',
    capabilityProtocol: 'responses',
    model: 'gpt-5.5',
    statusCode: 503,
    body: {
      error: {
        message: 'Service Unavailable',
        type: 'error'
      },
      type: 'error'
    }
  });

  assert(classified.state === 'inconclusive', `expected inconclusive classification, got ${classified.state}`);
  assert(classified.authoritative === false, 'expected non-authoritative classification');
  assert(classified.representative === false, 'expected non-representative classification');
  assert(action.shouldCooldown === false, 'expected no probe-driven cooldown');
  assert(upstream.cooldownUntil === 0, 'expected upstream cooldown to remain clear');
  assert(key.cooldownUntil === 0, 'expected key cooldown to remain clear');
  assert(upstream.health.state === 'inconclusive', `expected inconclusive health, got ${upstream.health.state}`);
  assert(healthProbeOk(upstream.health, 'gpt-5.5') === false, 'expected probe_ok=false');
  assert(healthProbeStatus(upstream.health, 'gpt-5.5') === 'skipped', 'expected skipped probe status');
  assert(upstream.capabilities.responses.status === 'unknown', `expected unknown capability, got ${upstream.capabilities.responses.status}`);
  assert(upstream.capabilities.responses.representative === false, 'expected capability evidence to remain non-representative');
  assertStillSelectable(server, 'gpt-5.5', 'any-gpt');
});

test('any GPT Service Unavailable JSON envelope is inconclusive even when HTTP status is 200', () => {
  const server = createPool({ name: 'any-gpt-200-envelope', api: 'openai' }, 'gpt-5.5');
  const upstream = server.state.upstreams[0];
  const key = upstream.keys[0];

  const { classified, action } = applySyntheticProbe({
    upstream,
    key,
    classifierProtocol: 'responses',
    capabilityProtocol: 'responses',
    model: 'gpt-5.5',
    statusCode: 200,
    body: {
      error: {
        message: 'Service Unavailable',
        type: 'error'
      },
      type: 'error'
    }
  });

  assert(classified.state === 'inconclusive', `expected inconclusive classification, got ${classified.state}`);
  assert(classified.authoritative === false, 'expected non-authoritative classification');
  assert(classified.representative === false, 'expected non-representative classification');
  assert(action.shouldCooldown === false, 'expected no probe-driven cooldown');
  assert(upstream.capabilities.responses.status === 'unknown', `expected unknown capability, got ${upstream.capabilities.responses.status}`);
  assert(upstream.capabilities.responses.representative === false, 'expected capability evidence to remain non-representative');
  assertStillSelectable(server, 'gpt-5.5', 'any-gpt-200-envelope');
});

test('any Claude 1m context probe is advanced-curl-required and remains selectable', () => {
  const server = createPool({
    name: 'any-claude',
    api: 'anthropic',
    probe_auth: 'anthropic'
  }, 'claude-opus-4-8');
  const upstream = server.state.upstreams[0];
  const key = upstream.keys[0];

  const { classified, action } = applySyntheticProbe({
    upstream,
    key,
    classifierProtocol: 'anthropic',
    capabilityProtocol: 'anthropic_messages',
    model: 'claude-opus-4-8',
    statusCode: 400,
    body: {
      error: '1m 上下文已经全量可用，请启用 1m 上下文后重试',
      type: 'error'
    }
  });

  assert(classified.state === 'advanced_curl_required', `expected advanced_curl_required classification, got ${classified.state}`);
  assert(classified.authoritative === false, 'expected non-authoritative classification');
  assert(classified.representative === false, 'expected non-representative classification');
  assert(action.shouldCooldown === false, 'expected no probe-driven cooldown');
  assert(upstream.cooldownUntil === 0, 'expected upstream cooldown to remain clear');
  assert(key.cooldownUntil === 0, 'expected key cooldown to remain clear');
  assert(upstream.health.state === 'advanced_curl_required', `expected advanced_curl_required health, got ${upstream.health.state}`);
  assert(healthProbeOk(upstream.health, 'claude-opus-4-8') === false, 'expected probe_ok=false');
  assert(healthProbeStatus(upstream.health, 'claude-opus-4-8') === 'skipped', 'expected skipped probe status');
  assert(upstream.capabilities.anthropic_messages.status === 'unknown', `expected unknown capability, got ${upstream.capabilities.anthropic_messages.status}`);
  assert(upstream.capabilities.anthropic_messages.representative === false, 'expected capability evidence to remain non-representative');
  assertStillSelectable(server, 'claude-opus-4-8', 'any-claude');
});

test('any Claude 1m context JSON envelope is advanced-curl-required even when HTTP status is 200', () => {
  const server = createPool({
    name: 'any-claude-200-envelope',
    api: 'anthropic',
    probe_auth: 'anthropic'
  }, 'claude-opus-4-8');
  const upstream = server.state.upstreams[0];
  const key = upstream.keys[0];

  const { classified, action } = applySyntheticProbe({
    upstream,
    key,
    classifierProtocol: 'anthropic',
    capabilityProtocol: 'anthropic_messages',
    model: 'claude-opus-4-8',
    statusCode: 200,
    body: {
      error: '1m 上下文已经全量可用，请启用 1m 上下文后重试',
      type: 'error'
    }
  });

  assert(classified.state === 'advanced_curl_required', `expected advanced_curl_required classification, got ${classified.state}`);
  assert(classified.authoritative === false, 'expected non-authoritative classification');
  assert(classified.representative === false, 'expected non-representative classification');
  assert(action.shouldCooldown === false, 'expected no probe-driven cooldown');
  assert(upstream.capabilities.anthropic_messages.status === 'unknown', `expected unknown capability, got ${upstream.capabilities.anthropic_messages.status}`);
  assert(upstream.capabilities.anthropic_messages.representative === false, 'expected capability evidence to remain non-representative');
  assertStillSelectable(server, 'claude-opus-4-8', 'any-claude-200-envelope');
});

console.log('\n' + '='.repeat(80));
console.log(`Test Results: ${passCount}/${testCount} passed, ${failCount} failed`);
console.log('='.repeat(80));
process.exit(failCount > 0 ? 1 : 0);
