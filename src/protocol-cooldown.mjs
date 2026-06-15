// Protocol-Specific Cooldown Module
//
// Extends the cooldown mechanism to support per-protocol cooldown, allowing
// an upstream to be in cooldown for one protocol while remaining available
// for others.
//
// Data structure:
// upstream.cooldown = {
//   active: boolean,           // Global cooldown (affects all protocols)
//   until: string|null,        // ISO timestamp
//   reason: string,
//   protocol_specific: {
//     responses: { active, until, reason },
//     chat_completions: { active, until, reason },
//     anthropic_messages: { active, until, reason }
//   }
// }

import { PROTOCOL_CAPABILITY_NAMES } from './protocol-capability-manager.mjs';

/**
 * Create an empty protocol cooldown entry.
 */
function emptyProtocolCooldownEntry() {
  return {
    active: false,
    until: null,
    reason: ''
  };
}

/**
 * Normalize cooldown object to ensure all required fields exist.
 *
 * @param {object|null} input - The cooldown object to normalize
 * @returns {object} - Normalized cooldown object
 */
export function normalizeCooldown(input) {
  const cooldown = {
    active: Boolean(input?.active),
    until: input?.until || null,
    reason: String(input?.reason || ''),
    protocol_specific: {}
  };

  // Normalize protocol_specific entries
  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    const entry = input?.protocol_specific?.[protocol];
    cooldown.protocol_specific[protocol] = {
      active: Boolean(entry?.active),
      until: entry?.until || null,
      reason: String(entry?.reason || '')
    };
  }

  return cooldown;
}

/**
 * Check if an upstream is in global cooldown.
 *
 * @param {object} upstream - The upstream object
 * @param {number} nowMs - Current time in milliseconds
 * @returns {boolean} - True if in cooldown
 */
export function isUpstreamInCooldown(upstream, nowMs = Date.now()) {
  if (!upstream || !upstream.cooldown) {
    return false;
  }

  const cooldown = normalizeCooldown(upstream.cooldown);

  if (!cooldown.active) {
    return false;
  }

  if (!cooldown.until) {
    return true; // Active but no expiry time = permanent cooldown
  }

  const untilMs = Date.parse(cooldown.until);
  if (!Number.isFinite(untilMs)) {
    return false; // Invalid timestamp
  }

  return nowMs < untilMs;
}

/**
 * Check if an upstream is in cooldown for a specific protocol.
 *
 * Returns true if either:
 * 1. Global cooldown is active (affects all protocols)
 * 2. Protocol-specific cooldown is active for the given protocol
 *
 * @param {object} upstream - The upstream object
 * @param {string} protocol - Protocol name
 * @param {number} nowMs - Current time in milliseconds
 * @returns {boolean} - True if in cooldown for this protocol
 */
export function isUpstreamInProtocolCooldown(upstream, protocol, nowMs = Date.now()) {
  if (!upstream) {
    return false;
  }

  // Global cooldown affects all protocols
  if (isUpstreamInCooldown(upstream, nowMs)) {
    return true;
  }

  // Check protocol-specific cooldown
  if (!PROTOCOL_CAPABILITY_NAMES.includes(protocol)) {
    return false;
  }

  const cooldown = normalizeCooldown(upstream.cooldown);
  const protocolCooldown = cooldown.protocol_specific[protocol];

  if (!protocolCooldown.active) {
    return false;
  }

  if (!protocolCooldown.until) {
    return true;
  }

  const untilMs = Date.parse(protocolCooldown.until);
  if (!Number.isFinite(untilMs)) {
    return false;
  }

  return nowMs < untilMs;
}

/**
 * Apply global cooldown to an upstream.
 * Mutates the upstream in place.
 *
 * @param {object} upstream - The upstream object
 * @param {object} options - { until: string, reason: string }
 */
export function applyCooldown(upstream, options = {}) {
  if (!upstream) return;

  const { until = null, reason = '' } = options;

  upstream.cooldown = normalizeCooldown(upstream.cooldown);
  upstream.cooldown.active = true;
  upstream.cooldown.until = until;
  upstream.cooldown.reason = String(reason);
}

/**
 * Apply protocol-specific cooldown to an upstream.
 * Mutates the upstream in place.
 *
 * @param {object} upstream - The upstream object
 * @param {string} protocol - Protocol name
 * @param {object} options - { until: string, reason: string }
 */
export function applyProtocolCooldown(upstream, protocol, options = {}) {
  if (!upstream || !PROTOCOL_CAPABILITY_NAMES.includes(protocol)) {
    return;
  }

  const { until = null, reason = '' } = options;

  upstream.cooldown = normalizeCooldown(upstream.cooldown);
  upstream.cooldown.protocol_specific[protocol] = {
    active: true,
    until,
    reason: String(reason)
  };
}

/**
 * Clear global cooldown from an upstream.
 * Mutates the upstream in place.
 *
 * @param {object} upstream - The upstream object
 */
export function clearCooldown(upstream) {
  if (!upstream) return;

  upstream.cooldown = normalizeCooldown(upstream.cooldown);
  upstream.cooldown.active = false;
  upstream.cooldown.until = null;
  upstream.cooldown.reason = '';
}

/**
 * Clear protocol-specific cooldown from an upstream.
 * Mutates the upstream in place.
 *
 * @param {object} upstream - The upstream object
 * @param {string} protocol - Protocol name
 */
export function clearProtocolCooldown(upstream, protocol) {
  if (!upstream || !PROTOCOL_CAPABILITY_NAMES.includes(protocol)) {
    return;
  }

  upstream.cooldown = normalizeCooldown(upstream.cooldown);
  upstream.cooldown.protocol_specific[protocol] = emptyProtocolCooldownEntry();
}

/**
 * Clear all expired cooldowns (both global and protocol-specific).
 * Mutates the upstream in place.
 *
 * @param {object} upstream - The upstream object
 * @param {number} nowMs - Current time in milliseconds
 */
export function clearExpiredCooldowns(upstream, nowMs = Date.now()) {
  if (!upstream || !upstream.cooldown) {
    return;
  }

  const cooldown = normalizeCooldown(upstream.cooldown);

  // Clear expired global cooldown
  if (cooldown.active && cooldown.until) {
    const untilMs = Date.parse(cooldown.until);
    if (Number.isFinite(untilMs) && nowMs >= untilMs) {
      clearCooldown(upstream);
    }
  }

  // Clear expired protocol-specific cooldowns
  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    const protocolCooldown = cooldown.protocol_specific[protocol];
    if (protocolCooldown.active && protocolCooldown.until) {
      const untilMs = Date.parse(protocolCooldown.until);
      if (Number.isFinite(untilMs) && nowMs >= untilMs) {
        clearProtocolCooldown(upstream, protocol);
      }
    }
  }
}
