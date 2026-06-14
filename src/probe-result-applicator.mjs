// Probe Result Applicator (DEPRECATED - merged into protocol-capability-manager.mjs)
//
// This module has been merged into protocol-capability-manager.mjs to eliminate
// the shallow module and create a deeper, more cohesive module.
//
// Re-exports for backward compatibility. This file will be removed in a future cleanup.

import { ProtocolCapabilityManager, deriveHealthFromProbe } from './protocol-capability-manager.mjs';

/**
 * @deprecated Use ProtocolCapabilityManager.applyProbeResult() instead.
 *
 * This free function is kept for backward compatibility but should not be used
 * in new code. Use the OO interface instead.
 */
export function applyProbeResult(upstream, key, protocol, probeResult, classified, options = {}) {
  // For backward compatibility, delegate to the manager
  const manager = new ProtocolCapabilityManager(upstream);
  return manager.applyProbeResult(key, protocol, probeResult, classified, options);
}

/**
 * @deprecated Exported for backward compatibility.
 * Use deriveHealthFromProbe from protocol-capability-manager.mjs instead.
 */
export { deriveHealthFromProbe };

