// Protocol-Layered Availability Module
//
// Extends availability tracking to support per-protocol statistics, allowing
// accurate measurement of upstream availability for different protocols
// (responses, chat_completions, anthropic_messages).
//
// Data structure:
// upstream.availability = {
//   overall: {
//     recent: [...], success_count, total_count, rate, multiplier,
//     last_success, last_failure
//   },
//   by_protocol: {
//     responses: { recent: [...], success_count, total_count, rate, multiplier, ... },
//     chat_completions: { ... },
//     anthropic_messages: { ... }
//   }
// }

import { PROTOCOL_CAPABILITY_NAMES } from './protocol-capability-manager.mjs';

// Default configuration
const DEFAULT_OVERALL_WINDOW_SIZE = 50;
const DEFAULT_PROTOCOL_WINDOW_SIZE = 30;
const DEFAULT_MIN_SAMPLES = 10;

// Availability multiplier thresholds (same as original implementation)
const AVAILABILITY_THRESHOLDS = [
  { rate: 0.95, multiplier: 1.20 },
  { rate: 0.90, multiplier: 1.00 },
  { rate: 0.75, multiplier: 0.65 },
  { rate: 0.50, multiplier: 0.30 },
  { rate: 0.00, multiplier: 0.08 }
];

// ── Data Structure Helpers ────────────────────────────────────────────────────

/**
 * Create an empty availability window.
 *
 * @param {number} windowSize - Maximum size of the rolling window
 * @returns {object} - Empty availability window
 */
export function emptyAvailabilityWindow(windowSize = DEFAULT_OVERALL_WINDOW_SIZE) {
  return {
    recent: [],
    success_count: 0,
    total_count: 0,
    rate: 0,
    multiplier: 1.0,
    last_success: null,
    last_failure: null
  };
}

/**
 * Migrate old availability format to new layered format.
 *
 * Old format:
 *   { recent: [...], success_count, total_count, ... }
 *
 * New format:
 *   { overall: {...}, by_protocol: { responses: {...}, ... } }
 *
 * @param {object} old - Old format availability object
 * @returns {object} - New format availability object
 */
export function migrateOldAvailabilityFormat(old) {
  if (!old || typeof old !== 'object') {
    return {
      overall: emptyAvailabilityWindow(DEFAULT_OVERALL_WINDOW_SIZE),
      by_protocol: {
        responses: emptyAvailabilityWindow(DEFAULT_PROTOCOL_WINDOW_SIZE),
        chat_completions: emptyAvailabilityWindow(DEFAULT_PROTOCOL_WINDOW_SIZE),
        anthropic_messages: emptyAvailabilityWindow(DEFAULT_PROTOCOL_WINDOW_SIZE)
      }
    };
  }

  // Migrate old data to overall
  const overall = {
    recent: Array.isArray(old.recent) ? [...old.recent] : [],
    success_count: Number(old.success_count) || 0,
    total_count: Number(old.total_count) || 0,
    rate: Number(old.rate) || 0,
    multiplier: Number(old.multiplier) || 1.0,
    last_success: old.last_success || null,
    last_failure: old.last_failure || null
  };

  // Initialize by_protocol to empty
  const by_protocol = {};
  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    by_protocol[protocol] = emptyAvailabilityWindow(DEFAULT_PROTOCOL_WINDOW_SIZE);
  }

  return { overall, by_protocol };
}

/**
 * Normalize availability object to ensure it has the correct structure.
 *
 * Handles:
 * - null/undefined input
 * - Old format (automatic migration)
 * - New format (validation and normalization)
 *
 * @param {object|null} input - Availability object to normalize
 * @param {object} config - Configuration options
 * @returns {object} - Normalized availability object
 */
export function normalizeAvailability(input, config = {}) {
  const {
    overallWindowSize = DEFAULT_OVERALL_WINDOW_SIZE,
    protocolWindowSize = DEFAULT_PROTOCOL_WINDOW_SIZE
  } = config;

  // Null or undefined input
  if (!input || typeof input !== 'object') {
    return {
      overall: emptyAvailabilityWindow(overallWindowSize),
      by_protocol: {
        responses: emptyAvailabilityWindow(protocolWindowSize),
        chat_completions: emptyAvailabilityWindow(protocolWindowSize),
        anthropic_messages: emptyAvailabilityWindow(protocolWindowSize)
      }
    };
  }

  // Detect old format: has 'recent' array but no 'overall' field
  if (Array.isArray(input.recent) && !input.overall) {
    return migrateOldAvailabilityFormat(input);
  }

  // New format: validate and normalize
  const normalized = {
    overall: normalizeAvailabilityWindow(input.overall, overallWindowSize),
    by_protocol: {}
  };

  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    const protocolData = input.by_protocol?.[protocol];
    normalized.by_protocol[protocol] = normalizeAvailabilityWindow(protocolData, protocolWindowSize);
  }

  return normalized;
}

/**
 * Normalize a single availability window.
 */
function normalizeAvailabilityWindow(input, windowSize) {
  if (!input || typeof input !== 'object') {
    return emptyAvailabilityWindow(windowSize);
  }

  return {
    recent: Array.isArray(input.recent) ? [...input.recent] : [],
    success_count: Number(input.success_count) || 0,
    total_count: Number(input.total_count) || 0,
    rate: Number(input.rate) || 0,
    multiplier: Number(input.multiplier) || 1.0,
    last_success: input.last_success || null,
    last_failure: input.last_failure || null
  };
}

// ── Recording Attempts ────────────────────────────────────────────────────────

/**
 * Calculate availability multiplier based on success rate.
 *
 * @param {number} successCount - Number of successful attempts
 * @param {number} totalCount - Total number of attempts
 * @param {number} minSamples - Minimum samples required for scoring
 * @returns {number} - Multiplier (0.08 to 1.20)
 */
export function calculateAvailabilityMultiplier(successCount, totalCount, minSamples = DEFAULT_MIN_SAMPLES) {
  // Not enough samples → default multiplier
  if (totalCount < minSamples) {
    return 1.0;
  }

  const rate = totalCount > 0 ? successCount / totalCount : 0;

  // Find matching threshold
  for (const threshold of AVAILABILITY_THRESHOLDS) {
    if (rate >= threshold.rate) {
      return threshold.multiplier;
    }
  }

  return 0.08; // Fallback (should never reach here)
}

/**
 * Record an availability attempt (success or failure) for a specific protocol.
 * Updates both overall and protocol-specific statistics.
 * Mutates the upstream in place.
 *
 * @param {object} upstream - The upstream object
 * @param {string} protocol - Protocol name
 * @param {boolean} success - Whether the attempt succeeded
 * @param {object} options - Additional options
 */
export function recordAvailabilityAttempt(upstream, protocol, success, options = {}) {
  if (!upstream) return;

  const {
    timestamp = new Date().toISOString(),
    overallWindowSize = DEFAULT_OVERALL_WINDOW_SIZE,
    protocolWindowSize = DEFAULT_PROTOCOL_WINDOW_SIZE,
    minSamples = DEFAULT_MIN_SAMPLES
  } = options;

  // Normalize availability structure
  upstream.availability = normalizeAvailability(upstream.availability, {
    overallWindowSize,
    protocolWindowSize
  });

  // Update overall statistics
  updateAvailabilityWindow(
    upstream.availability.overall,
    success,
    timestamp,
    overallWindowSize,
    minSamples
  );

  // Update protocol-specific statistics (if valid protocol)
  if (PROTOCOL_CAPABILITY_NAMES.includes(protocol)) {
    updateAvailabilityWindow(
      upstream.availability.by_protocol[protocol],
      success,
      timestamp,
      protocolWindowSize,
      minSamples
    );
  }
}

/**
 * Update a single availability window with a new attempt.
 * Mutates the window in place.
 */
function updateAvailabilityWindow(window, success, timestamp, windowSize, minSamples) {
  // Add to rolling window
  window.recent.push(success);
  if (window.recent.length > windowSize) {
    window.recent.shift();
  }

  // Update counts
  window.total_count += 1;
  if (success) {
    window.success_count += 1;
  }

  // Update rate
  window.rate = window.total_count > 0 ? window.success_count / window.total_count : 0;

  // Update multiplier
  window.multiplier = calculateAvailabilityMultiplier(
    window.success_count,
    window.total_count,
    minSamples
  );

  // Update timestamps
  if (success) {
    window.last_success = timestamp;
  } else {
    window.last_failure = timestamp;
  }
}

// ── Querying Availability ─────────────────────────────────────────────────────

/**
 * Get availability rate for a specific protocol.
 *
 * Priority:
 * 1. Use protocol-specific rate if samples >= minSamples
 * 2. Fallback to overall rate if samples >= minSamples
 * 3. Return null if neither has enough samples
 *
 * @param {object} upstream - The upstream object
 * @param {string} protocol - Protocol name
 * @param {number} minSamples - Minimum samples required
 * @returns {number|null} - Availability rate (0-1) or null
 */
export function getProtocolAvailabilityRate(upstream, protocol, minSamples = DEFAULT_MIN_SAMPLES) {
  if (!upstream || !upstream.availability) {
    return null;
  }

  const availability = normalizeAvailability(upstream.availability);

  // Try protocol-specific first
  if (PROTOCOL_CAPABILITY_NAMES.includes(protocol)) {
    const protocolWindow = availability.by_protocol[protocol];
    if (protocolWindow.total_count >= minSamples) {
      return protocolWindow.rate;
    }
  }

  // Fallback to overall
  if (availability.overall.total_count >= minSamples) {
    return availability.overall.rate;
  }

  // Not enough samples
  return null;
}

/**
 * Get availability multiplier for a specific protocol.
 *
 * Priority:
 * 1. Use protocol-specific multiplier if samples >= minSamples
 * 2. Fallback to overall multiplier if samples >= minSamples
 * 3. Return 1.0 (default) if neither has enough samples
 *
 * @param {object} upstream - The upstream object
 * @param {string} protocol - Protocol name
 * @param {number} minSamples - Minimum samples required
 * @returns {number} - Availability multiplier (0.08 to 1.20)
 */
export function getProtocolAvailabilityMultiplier(upstream, protocol, minSamples = DEFAULT_MIN_SAMPLES) {
  if (!upstream || !upstream.availability) {
    return 1.0;
  }

  const availability = normalizeAvailability(upstream.availability);

  // Try protocol-specific first
  if (PROTOCOL_CAPABILITY_NAMES.includes(protocol)) {
    const protocolWindow = availability.by_protocol[protocol];
    if (protocolWindow.total_count >= minSamples) {
      return protocolWindow.multiplier;
    }
  }

  // Fallback to overall
  if (availability.overall.total_count >= minSamples) {
    return availability.overall.multiplier;
  }

  // Not enough samples → default
  return 1.0;
}

