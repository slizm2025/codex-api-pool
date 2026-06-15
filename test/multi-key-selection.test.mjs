#!/usr/bin/env node

import { __testInternals } from '../src/server.mjs';

const { chooseCandidate, upstreamAvailable } = __testInternals;

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function makeUpstream(overrides = {}) {
  return {
    name: 'multi-key',
    enabled: true,
    quarantined: false,
    baseUrl: 'http://example.test/v1',
    api: 'openai',
    codexOAuth: false,
    oauthExpiresAt: '',
    cooldownUntil: 0,
    weight: 1,
    failures: 0,
    ewmaLatencyMs: 0,
    stats: { availability: { samples: [] } },
    health: { state: 'ok' },
    capabilities: {},
    keys: [
      { index: 0, label: 'key-one', value: 'sk-one', failures: 0, cooldownUntil: 0, stats: { availability: { samples: [] } } },
      { index: 1, label: 'key-two', value: 'sk-two', failures: 0, cooldownUntil: 0, stats: { availability: { samples: [] } } }
    ],
    ...overrides
  };
}

function makeState(upstream) {
  return {
    modelOverride: 'gpt-5.5',
    availability: { windowSize: 50, minSamples: 10 },
    upstreams: [upstream]
  };
}

assert(typeof chooseCandidate === 'function', 'chooseCandidate must be exposed for focused multi-key selection tests');

const at = Date.now();

const oneKeyCooled = makeUpstream();
oneKeyCooled.keys[0].cooldownUntil = at + 60_000;
assert(
  upstreamAvailable(oneKeyCooled, at, 'gpt-5.5') === true,
  'Upstream should remain selectable while at least one Upstream Key is available'
);
let selected = chooseCandidate(makeState(oneKeyCooled), new Set(), { preferredModel: 'gpt-5.5' });
assert(selected?.key?.label === 'key-two', `expected Selection to skip cooled key-one and use key-two, got ${selected?.key?.label}`);

const triedFirstKey = makeUpstream();
selected = chooseCandidate(makeState(triedFirstKey), new Set(['multi-key:0']), { preferredModel: 'gpt-5.5' });
assert(selected?.key?.label === 'key-two', `expected Retry to use second key after key-one was tried, got ${selected?.key?.label}`);

const lowerFailureKey = makeUpstream();
lowerFailureKey.keys[0].failures = 3;
lowerFailureKey.keys[1].failures = 0;
selected = chooseCandidate(makeState(lowerFailureKey), new Set(), { preferredModel: 'gpt-5.5' });
assert(selected?.key?.label === 'key-two', `expected Selection to prefer lower-failure key-two, got ${selected?.key?.label}`);

const noKeysAvailable = makeUpstream();
noKeysAvailable.keys[0].cooldownUntil = at + 60_000;
noKeysAvailable.keys[1].value = '';
assert(
  upstreamAvailable(noKeysAvailable, at, 'gpt-5.5') === false,
  'Upstream should be unavailable when every Upstream Key is missing or cooled'
);

console.log('multi-key selection tests passed');
