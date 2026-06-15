// WS3 — deriveVerificationDetail(): the canonical 3-tier decision flowchart.
//
// Returns { tier, indicator, label, reason } where:
//   tier       ∈ proven_by_traffic | proven_by_probe | real_pending | unavailable
//   indicator  ∈ green | yellow | blue | grey | orange | red
//   label      short display string
//   reason     tooltip string (may equal label)
//
// MONITOR-ONLY PROBE PRINCIPLE: Health Probe states (auth_error, rate_limited,
// server_error, network_error, timeout, models_unsupported) are advisory-only.
// They must NOT push an upstream into the `unavailable` tier, because probes
// must never exclude an upstream from selection (WS2). An upstream with only a
// probe-derived failure stays in real_pending (still selectable) and surfaces
// its failure via the health badge. The `unavailable` tier is driven ONLY by:
//   - disabled / quarantined (admin)
//   - no valid key (config)
//   - upstream cooldownUntil in the future (real-traffic outcome)
// Plus the authoritative capability tiers (real_traffic / probe verified).

import { strict as assert } from 'assert';
import { deriveVerificationDetail } from '../src/verification-tier.mjs';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`✓ ${name}`); }
  catch (e) { fail++; console.log(`✗ ${name}\n  ${e.stack || e.message}`); }
}

function cap(source, { model = 'gpt-5-codex' } = {}) {
  return { status: 'verified', source, representative: true, model, checked_at: '2026-06-14T00:00:00Z' };
}
const NOW = new Date('2026-06-14T12:00:00Z').getTime();
const at = (iso) => new Date(iso).getTime();

function baseUpstream(overrides = {}) {
  return {
    enabled: true,
    quarantined: false,
    cooldownUntil: 0,
    keys: [{ value: 'sk-test', cooldownUntil: 0 }],
    health: { state: 'unknown', checkedAt: '2026-06-14T00:00:00Z' },
    capabilities: {},
    ...overrides
  };
}

// ── Tier 1: proven_by_traffic ──

test('proven_by_traffic: green, any protocol real_traffic verified', () => {
  const u = baseUpstream({ capabilities: { responses: cap('real_traffic') } });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'proven_by_traffic');
  assert.equal(d.indicator, 'green');
});

test('proven_by_traffic beats proven_by_probe', () => {
  const u = baseUpstream({
    capabilities: { responses: cap('probe'), chat_completions: cap('real_traffic') }
  });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'proven_by_traffic');
  assert.equal(d.indicator, 'green');
});

// ── Tier 2: proven_by_probe ──

test('proven_by_probe: yellow, probe verified, no real_traffic', () => {
  const u = baseUpstream({ capabilities: { responses: cap('probe') } });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'proven_by_probe');
  assert.equal(d.indicator, 'yellow');
});

// ── Tier 3a: unavailability cascade — driven by admin/config/real-traffic ONLY ──

test('unavailable: disabled → grey', () => {
  const u = baseUpstream({ enabled: false });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable');
  assert.equal(d.indicator, 'grey');
});

test('unavailable: quarantined → orange', () => {
  const u = baseUpstream({ quarantined: true });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable');
  assert.equal(d.indicator, 'orange');
});

test('unavailable: no valid key → red', () => {
  const u = baseUpstream({ keys: [{ value: '', cooldownUntil: 0 }] });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable');
  assert.equal(d.indicator, 'red');
});

test('unavailable: all keys cooled → red', () => {
  const u = baseUpstream({ keys: [{ value: 'sk-test', cooldownUntil: at('2026-06-14T13:00:00Z') }] });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable');
  assert.equal(d.indicator, 'red');
});

test('unavailable: upstream cooldown in future → orange (冷却中, real-traffic outcome)', () => {
  const u = baseUpstream({ cooldownUntil: at('2026-06-14T13:00:00Z') });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable');
  assert.equal(d.indicator, 'orange');
});

// ── Monitor-only: probe-derived health states stay SELECTABLE (real_pending) ──
// These do NOT push to unavailable. They surface via the health badge instead.

for (const state of ['auth_error', 'rate_limited', 'server_error', 'network_error', 'timeout', 'models_unsupported', 'unexpected_status']) {
  test(`monitor-only: probe health.state=${state} stays real_pending (not unavailable)`, () => {
    const u = baseUpstream({ health: { state, checkedAt: '2026-06-14T00:00:00Z' } });
    const d = deriveVerificationDetail(u, { now: NOW });
    assert.equal(d.tier, 'real_pending', `${state} must not exclude; probes are advisory`);
    assert.equal(d.indicator, 'blue');
  });
}

// ── Tier 3b: real_pending ──

test('real_pending: health oauth_ready → blue', () => {
  const u = baseUpstream({ health: { state: 'oauth_ready', checkedAt: '2026-06-14T00:00:00Z' } });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'real_pending');
  assert.equal(d.indicator, 'blue');
});

test('real_pending: never probed (checkedAt null) → blue', () => {
  const u = baseUpstream({ health: { state: 'unknown', checkedAt: null } });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'real_pending');
  assert.equal(d.indicator, 'blue');
});

test('real_pending: configured, probed-ok-but-not-verified → blue', () => {
  const u = baseUpstream({ health: { state: 'ok', checkedAt: '2026-06-14T00:00:00Z' } });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'real_pending');
  assert.equal(d.indicator, 'blue');
});

// ── Bug-fix: admin/config unavailable states must override proven_by_probe ──
// proven_by_probe is weak evidence (only a Health Probe passed). Admin intent
// (disabled, quarantined) and config reality (no key) are stronger and must
// surface correctly — otherwise 4 live quarantined upstreams showed as
// "一层检测通过" (yellow) instead of "已隔离" (orange).

test('unavailable: quarantined beats proven_by_probe → orange/已隔离', () => {
  const u = baseUpstream({ quarantined: true, capabilities: { responses: cap('probe') } });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable', 'quarantined must override probe-verified tier');
  assert.equal(d.indicator, 'orange', 'quarantined → orange');
  assert.equal(d.label, '已隔离');
});

test('unavailable: disabled beats proven_by_probe → grey/已禁用', () => {
  const u = baseUpstream({ enabled: false, capabilities: { responses: cap('probe') } });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable', 'disabled must override probe-verified tier');
  assert.equal(d.indicator, 'grey', 'disabled → grey');
  assert.equal(d.label, '已禁用');
});

test('unavailable: no valid key beats proven_by_probe → red/缺少 Key', () => {
  const u = baseUpstream({ keys: [], capabilities: { responses: cap('probe') } });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable', 'no key must override probe-verified tier');
  assert.equal(d.indicator, 'red', 'no key → red');
  assert.equal(d.label, '缺少 Key');
});

test('unavailable: all keys cooled beats proven_by_probe → red/认证失败', () => {
  const u = baseUpstream({
    keys: [{ value: 'sk-test', cooldownUntil: at('2026-06-14T13:00:00Z') }],
    capabilities: { responses: cap('probe') }
  });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable', 'all keys cooled must override probe-verified tier');
  assert.equal(d.indicator, 'red', 'all keys cooled → red');
  assert.equal(d.label, '认证失败');
});

test('unavailable: cooldown beats proven_by_probe → orange/冷却中', () => {
  const u = baseUpstream({
    cooldownUntil: at('2026-06-14T13:00:00Z'),
    capabilities: { responses: cap('probe') }
  });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable', 'cooldown must override probe-verified tier');
  assert.equal(d.indicator, 'orange', 'cooldown → orange');
});

// ── Cascade precedence (order matters) ──

test('precedence: disabled beats quarantined beats missing key', () => {
  const u = baseUpstream({ enabled: false, quarantined: true, keys: [{ value: '', cooldownUntil: 0 }] });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.indicator, 'grey', 'disabled is checked first');
});

test('precedence: proven_by_traffic ignores downstream unavailable flags', () => {
  const u = baseUpstream({
    enabled: false,
    capabilities: { responses: cap('real_traffic') }
  });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'proven_by_traffic',
    'real_traffic evidence is authoritative regardless of disabled/quarantined');
});

// ── Real-traffic cooldown + probe state: cooldown wins (unavailable) ──

test('precedence: real-traffic cooldown beats probe health state', () => {
  const u = baseUpstream({
    cooldownUntil: at('2026-06-14T13:00:00Z'),
    health: { state: 'server_error', checkedAt: '2026-06-14T00:00:00Z' }
  });
  const d = deriveVerificationDetail(u, { now: NOW });
  assert.equal(d.tier, 'unavailable');
  assert.equal(d.indicator, 'orange', 'real-traffic cooldown → unavailable; probe state is advisory');
});

// ── Null safety ──

test('null upstream → unavailable/grey', () => {
  const d = deriveVerificationDetail(null, { now: NOW });
  assert.equal(d.tier, 'unavailable');
  assert.equal(d.indicator, 'grey');
});

test('missing capabilities → falls through to cascade', () => {
  const d = deriveVerificationDetail({ enabled: true, keys: [{ value: 'k' }] }, { now: NOW });
  assert.equal(d.tier, 'real_pending');
});

console.log(`\n${'═'.repeat(70)}\nVerification detail: ${pass}/${pass + fail} passed, ${fail} failed\n${'═'.repeat(70)}`);
if (fail > 0) process.exit(1);
