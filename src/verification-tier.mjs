// Verification Tier Module
//
// Derives the verification tier (and detailed display info) for an upstream
// based on its protocol capabilities + live state.
//
// Top-level tiers (highest to lowest authority):
// - proven_by_traffic: At least one protocol has verified real traffic success
// - proven_by_probe:   At least one protocol has verified probe success (no real traffic)
// - real_pending:      Not verified, but configured & selectable (waiting for verification)
// - unavailable:       Disabled / quarantined / no key / hard health error / cooled
//
// Design note (monitor-only probes): Health State is advisory for ranking only
// (see healthAllowsSelection in server.mjs). The detailed classification here is
// for DASHBOARD DISPLAY, not for selection gating. Selection is governed by
// upstreamAvailable() via cooldown / quarantine / key availability.

import { PROTOCOL_CAPABILITY_NAMES } from './protocol-capability-manager.mjs';

/**
 * Derive verification tier from upstream protocol capabilities.
 *
 * Returns one of: 'proven_by_traffic' | 'proven_by_probe' | 'not_verified'
 * (the coarse top-level tier, before the real_pending/unavailable split).
 *
 * @param {object} upstream - The upstream object
 * @returns {string}
 */
export function deriveVerificationTier(upstream) {
  if (!upstream || !upstream.capabilities) {
    return 'not_verified';
  }

  const capabilities = upstream.capabilities;
  let hasProbeVerified = false;

  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    const capability = capabilities[protocol];
    if (!capability || capability.status !== 'verified') {
      continue;
    }

    // Real traffic evidence is the highest authority
    if (capability.source === 'real_traffic') {
      return 'proven_by_traffic';
    }

    // Probe evidence is secondary
    if (capability.source === 'probe') {
      hasProbeVerified = true;
    }
  }

  return hasProbeVerified ? 'proven_by_probe' : 'not_verified';
}

/**
 * Derive the full verification detail for dashboard display.
 *
 * Encodes the canonical 3-tier decision flowchart:
 *   1. proven_by_traffic  (green)   — real_traffic verified capability
 *   2. proven_by_probe    (yellow)  — probe verified capability
 *   3. unavailable cascade (grey/orange/red, first hit wins)
 *   4. real_pending       (blue)    — configured, waiting for verification
 *
 * Real-traffic evidence is authoritative: if present, tier is always
 * proven_by_traffic regardless of enabled/quarantined/key state.
 *
 * @param {object} upstream - The upstream object
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()] - Current epoch ms (for cooldown checks)
 * @returns {{tier: string, indicator: string, label: string, reason: string}}
 */
export function deriveVerificationDetail(upstream, { now = Date.now() } = {}) {
  // ── Tier 1 & 2: capability evidence (authoritative) ──
  const tier = deriveVerificationTier(upstream);
  if (tier === 'proven_by_traffic') {
    return { tier: 'proven_by_traffic', indicator: 'green', label: '真实请求验证', reason: '已被真实 Codex 请求验证' };
  }
  if (tier === 'proven_by_probe') {
    return { tier: 'proven_by_probe', indicator: 'yellow', label: '一层检测通过', reason: '仅通过健康探针验证，等待真实流量确认' };
  }

  // ── Guard: null/missing upstream → unavailable ──
  if (!upstream) {
    return { tier: 'unavailable', indicator: 'grey', label: '已禁用', reason: '上游未配置' };
  }

  // ── Tier 3a: unavailability cascade (first hit wins) ──
  if (upstream.enabled === false) {
    return { tier: 'unavailable', indicator: 'grey', label: '已禁用', reason: '用户已禁用该上游' };
  }
  if (upstream.quarantined === true) {
    return { tier: 'unavailable', indicator: 'orange', label: '已隔离', reason: '上游处于隔离状态' };
  }

  const keys = Array.isArray(upstream.keys) ? upstream.keys : [];
  const hasValidKey = keys.some((k) => k && k.value && (!k.cooldownUntil || k.cooldownUntil <= now));
  const allKeysCooledOrEmpty = keys.length > 0 && !hasValidKey && keys.some((k) => k && k.value);

  if (!hasValidKey && (keys.length === 0 || !keys.some((k) => k && k.value))) {
    return { tier: 'unavailable', indicator: 'red', label: '缺少 Key', reason: '没有可用的有效 API Key' };
  }
  if (allKeysCooledOrEmpty) {
    return { tier: 'unavailable', indicator: 'red', label: '认证失败', reason: '所有 Key 处于冷却或认证失败状态' };
  }

  const healthState = upstream.health?.state || '';

  // NOTE: Health Probe states (auth_error, rate_limited, server_error,
  // network_error, timeout, models_unsupported) are ADVISORY ONLY and must NOT
  // drive the `unavailable` tier. Only real Model Interaction Request outcomes
  // gate Selection, and the dashboard tier mirrors that: an upstream with a
  // probe-derived failure state stays in real_pending (still selectable) and is
  // surfaced via its health badge for diagnosis. The hard `unavailable` cascade
  // below is driven only by real-traffic cooldown.

  const cooldownUntil = Number(upstream.cooldownUntil || 0);
  if (cooldownUntil > now) {
    const secs = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
    return { tier: 'unavailable', indicator: 'orange', label: '冷却中', reason: `上游冷却中，约 ${secs}s 后恢复` };
  }

  // ── Tier 3b: real_pending (configured, selectable, not yet verified) ──
  if (healthState === 'oauth_ready') {
    return { tier: 'real_pending', indicator: 'blue', label: '等待 OAuth 登录', reason: '等待 Codex OAuth 登录' };
  }
  if (!upstream.health?.checkedAt) {
    return { tier: 'real_pending', indicator: 'blue', label: '探针未运行', reason: '配置完成，需要运行探针验证' };
  }
  return { tier: 'real_pending', indicator: 'blue', label: '配置完成，待验证', reason: '配置完成，等待真实请求验证' };
}

/**
 * Add or update the verification_tier field on an upstream object.
 * Mutates the upstream in place.
 *
 * @param {object} upstream - The upstream object to update
 */
export function addVerificationTierToUpstream(upstream) {
  if (!upstream) return;
  upstream.verification_tier = deriveVerificationTier(upstream);
}

/**
 * Bulk update verification tiers for an array of upstreams.
 * Mutates each upstream in place.
 *
 * @param {Array} upstreams - Array of upstream objects
 */
export function addVerificationTierToUpstreams(upstreams) {
  if (!Array.isArray(upstreams)) return;
  for (const upstream of upstreams) {
    addVerificationTierToUpstream(upstream);
  }
}
