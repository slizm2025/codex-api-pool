// Dashboard Debug Lock UI Functions
// This module contains client-side logic for debug lock UI features
// In production, these functions are inlined into dashboardHtml() in server.mjs

/**
 * Check if debug lock is currently active
 * @param {Object} status - Pool status object from /pool/status
 * @returns {boolean} True if debug lock is enabled
 */
export function isDebugLockActive(status) {
  return Boolean(status?.debug_lock?.enabled);
}

/**
 * Get debug lock information if active
 * @param {Object} status - Pool status object from /pool/status
 * @returns {Object|null} Lock info object or null if not locked
 */
export function getDebugLockInfo(status) {
  if (!isDebugLockActive(status)) {
    return null;
  }

  const lock = status.debug_lock;
  return {
    upstream: lock.upstream,
    locked_at: lock.locked_at,
    locked_duration_seconds: lock.locked_duration_seconds
  };
}

/**
 * Check if debug lock warning should be shown
 * @param {Object} status - Pool status object from /pool/status
 * @returns {boolean} True if warning should be displayed
 */
export function shouldShowDebugLockWarning(status) {
  return isDebugLockActive(status);
}

/**
 * Format debug lock duration for display
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration string (e.g., "2分30秒")
 */
export function formatDebugLockDuration(seconds) {
  if (seconds === 0) return '0秒';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (secs > 0 && hours === 0) parts.push(`${secs}秒`);

  return parts.join('');
}

/**
 * Check if Lock button should be shown for an upstream
 * @param {Object} upstream - Upstream object
 * @param {Object|null} lockInfo - Current lock info or null
 * @returns {boolean} True if Lock button should be shown
 */
export function shouldShowLockButton(upstream, lockInfo) {
  // No lock button if any upstream is locked (including this one)
  if (lockInfo) return false;
  return true;
}

/**
 * Check if Unlock button should be shown for an upstream
 * @param {Object} upstream - Upstream object
 * @param {Object|null} lockInfo - Current lock info or null
 * @returns {boolean} True if Unlock button should be shown
 */
export function shouldShowUnlockButton(upstream, lockInfo) {
  if (!lockInfo) return false;
  return lockInfo.upstream === upstream.name;
}

/**
 * Check if an upstream can be locked (validation)
 * @param {Object} upstream - Upstream object
 * @returns {Object} Result with {canLock: boolean, reason: string|null}
 */
export function canLockUpstream(upstream) {
  // Check for codex-oauth (not allowed)
  if (upstream.api === 'codex-oauth') {
    return {
      canLock: false,
      reason: 'Codex OAuth upstreams cannot be locked (require per-request auth)'
    };
  }

  // Check for quarantined (warning but allowed)
  if (upstream.quarantined) {
    return {
      canLock: true,
      reason: 'Warning: This upstream is quarantined'
    };
  }

  // Check for disabled (warning but allowed)
  if (upstream.enabled === false) {
    return {
      canLock: true,
      reason: 'Warning: This upstream is disabled'
    };
  }

  // All good
  return {
    canLock: true,
    reason: null
  };
}

/**
 * Check if a request is a debug lock request
 * @param {Object} request - Request object from recent requests
 * @returns {boolean} True if this is a debug lock request
 */
export function isDebugLockRequest(request) {
  return Boolean(request?.debug_lock);
}

/**
 * Get debug lock information from a request
 * @param {Object} request - Request object from recent requests
 * @returns {Object|null} Debug lock info or null
 */
export function getDebugLockRequestInfo(request) {
  if (!isDebugLockRequest(request)) {
    return null;
  }

  return {
    locked_upstream: request.locked_upstream,
    attempts: request.attempts,
    final_protocol: request.final_protocol
  };
}
