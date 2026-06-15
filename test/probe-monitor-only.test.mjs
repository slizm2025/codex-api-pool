// WS2 — Monitor-only probes (regression characterization)
//
// Design contract: the probe-derived Health State is advisory-only and must
// NEVER exclude an upstream from Selection. `healthAllowsSelection` therefore
// returns true unconditionally — probes only inform ranking (soft) via
// selectionHealthPenalty. Hard exclusion happens ONLY through real Model
// Interaction Request outcomes, enforced by `upstreamAvailable` via
// `upstream.cooldownUntil` + key availability + quarantine.
//
// These tests pin that contract so it cannot regress to "probes exclude".

import { strict as assert } from 'assert';
import { __testInternals } from '../src/server.mjs';

const { healthAllowsSelection, upstreamAvailable } = __testInternals;

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`✓ ${name}`); }
  catch (e) { fail++; console.log(`✗ ${name}\n  ${e.message}`); }
}

function makeUpstream(overrides = {}) {
  return {
    enabled: true,
    quarantined: false,
    baseUrl: 'https://example.com',
    cooldownUntil: 0,
    keys: [{ value: 'sk-test', cooldownUntil: 0 }],
    health: { state: 'server_error', source: 'probe', checkedAt: '2026-06-14T00:00:00Z' },
    ...overrides
  };
}

// ── healthAllowsSelection is unconditionally true (probes never gate) ──

for (const state of ['ok', 'server_error', 'rate_limited', 'auth_error', 'network_error', 'timeout', 'models_unsupported', 'unexpected_status', 'unknown', 'missing_key', 'disabled']) {
  test(`healthAllowsSelection=true for health.state=${state} (probe advisory-only)`, () => {
    const u = makeUpstream({ health: { state, source: 'probe' } });
    assert.equal(healthAllowsSelection(u), true, `${state} must not gate selection`);
  });
}

test('healthAllowsSelection=true even with no source field', () => {
  const u = makeUpstream({ health: { state: 'rate_limited' } });
  assert.equal(healthAllowsSelection(u), true);
});

// ── A probe-failed upstream with no cooldown stays selectable (e2e) ──

test('upstreamAvailable=true when only a probe failed (no cooldown, key ok)', () => {
  const u = makeUpstream(); // health server_error/probe, cooldown 0, valid key
  assert.equal(upstreamAvailable(u, Date.now()), true,
    'probe-only failure must not exclude from selection');
});

// ── Hard exclusion still works (real-traffic / config levers), regression guard ──

test('upstreamAvailable=false when real-traffic cooldownUntil is in the future', () => {
  const u = makeUpstream({ cooldownUntil: Date.now() + 60000 });
  assert.equal(upstreamAvailable(u, Date.now()), false, 'real-traffic cooldown must exclude');
});

test('upstreamAvailable=false when quarantined', () => {
  const u = makeUpstream({ quarantined: true });
  assert.equal(upstreamAvailable(u, Date.now()), false);
});

test('upstreamAvailable=false when disabled', () => {
  const u = makeUpstream({ enabled: false });
  assert.equal(upstreamAvailable(u, Date.now()), false);
});

test('upstreamAvailable=false when no key is available (key cooled)', () => {
  const u = makeUpstream({ keys: [{ value: 'sk-test', cooldownUntil: Date.now() + 60000 }] });
  assert.equal(upstreamAvailable(u, Date.now()), false);
});

test('upstreamAvailable=false when key value missing', () => {
  const u = makeUpstream({ keys: [{ value: '', cooldownUntil: 0 }] });
  assert.equal(upstreamAvailable(u, Date.now()), false);
});

test('upstreamAvailable=false when Codex OAuth token is expired', () => {
  const u = makeUpstream({
    codexOAuth: true,
    oauthExpiresAt: '2026-06-14T11:00:00Z'
  });
  assert.equal(upstreamAvailable(u, new Date('2026-06-14T12:00:00Z').getTime()), false);
});

console.log(`\n${'═'.repeat(70)}\nProbe monitor-only: ${pass}/${pass + fail} passed, ${fail} failed\n${'═'.repeat(70)}`);
if (fail > 0) process.exit(1);
