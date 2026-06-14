// Probe Result Applicator
//
// Clarifies the relationship between probe results, Health State, and Protocol Capability.
// A single probe result deterministically updates both state machines through one function.
//
// This module documents the mapping rules:
//   - ok → health=ok, capability=verified
//   - auth_error → health=auth_error, capability=unknown
//   - network_error/timeout → health={same}, capability=unknown
//   - server_error → health=server_error, capability=unknown
//   - etc.

import { recordProtocolCapabilityProbe } from './protocol-capability-manager.mjs';

/**
 * Apply a probe result to both Health State and Protocol Capability.
 *
 * This is the single point where we document how a probe classification maps to:
 * 1. Protocol Capability status (via capabilityManager)
 * 2. Health State (upstream.health, key.health)
 * 3. Cooldown decision (should we apply failure cooldown?)
 *
 * @param {object} upstream - The upstream object
 * @param {object} key - The key object
 * @param {string} protocol - Protocol name (responses/chat_completions/anthropic_messages)
 * @param {object} probeResult - Raw probe result
 * @param {object} classified - Classified probe result (from classifyModelProbe)
 * @param {object} options - { checkedAt, model }
 * @returns {object} { shouldCooldown, cooldownReason }
 */
export function applyProbeResult(upstream, key, protocol, probeResult, classified, options = {}) {
  const { checkedAt, model } = options;

  // 1. Update Protocol Capability (via existing function)
  recordProtocolCapabilityProbe(upstream, protocol, probeResult, classified, {
    checkedAt,
    model
  });

  // 2. Derive Health State from classification
  const healthState = deriveHealthFromProbe(classified, probeResult);

  // 3. Update upstream.health
  upstream.health = {
    state: healthState,
    source: 'probe',
    checkedAt,
    latencyMs: probeResult.latencyMs || 0,
    httpStatus: probeResult.statusCode || 0,
    error: healthState === 'ok' ? '' : (classified.error || probeResult.error || ''),
    warning: '',
    models: upstream.health?.models || [],
    modelsCount: upstream.health?.modelsCount || 0,
    keyLabel: key?.label || null,
    probeModel: model || ''
  };

  // 4. Update key.health
  key.health = {
    state: healthState,
    source: 'probe',
    checkedAt,
    latencyMs: probeResult.latencyMs || 0,
    httpStatus: probeResult.statusCode || 0,
    error: healthState === 'ok' ? '' : (classified.error || probeResult.error || ''),
    warning: '',
    probeModel: model || ''
  };

  // 5. Determine cooldown action
  const cooldownStates = ['auth_error', 'rate_limited', 'server_error', 'network_error', 'timeout'];
  const shouldCooldown = cooldownStates.includes(healthState);

  return {
    shouldCooldown,
    cooldownReason: shouldCooldown ? (classified.error || healthState) : ''
  };
}

/**
 * Map probe classification state to Health State.
 *
 * This documents the canonical mapping between the two state machines.
 */
export function deriveHealthFromProbe(classified, probeResult) {
  const state = classified?.state;

  if (state === 'ok') return 'ok';

  // Auth/rate limit failures
  if (state === 'auth_error') return 'auth_error';
  if (state === 'rate_limited') return 'rate_limited';

  // Server/infrastructure failures
  if (state === 'server_error') return 'server_error';
  if (state === 'network_error') return 'network_error';
  if (state === 'timeout') return 'timeout';

  // Special states
  if (state === 'models_unsupported') return 'models_unsupported';
  if (state === 'unexpected_status') return 'unexpected_status';
  if (state === 'advanced_curl_required') return 'advanced_curl_required';
  if (state === 'codex_forward_only') return 'codex_forward_only';

  // Default: inconclusive
  return 'inconclusive';
}
