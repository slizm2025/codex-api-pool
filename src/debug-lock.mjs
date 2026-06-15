// Debug Lock Mode - State Management
//
// Provides functions to enable, disable, and query debug lock state.
// Debug lock forces all requests to a specific upstream for diagnostic purposes.

/**
 * Enable debug lock mode, forcing all requests to the specified upstream.
 *
 * @param {Object} state - Runtime state object
 * @param {string} upstreamName - Name of upstream to lock to
 * @param {Object} options - Configuration options
 * @param {boolean} options.respect_model_override - Whether to apply model override (default: true)
 * @returns {Object} Result with ok status and debug_lock info
 */
export function enableDebugLock(state, upstreamName, options = {}) {
  const locked_at = new Date().toISOString();
  const respect_model_override = options.respect_model_override !== false;

  state.debugLock = {
    enabled: true,
    upstream: upstreamName,
    respect_model_override,
    locked_at
  };

  return {
    ok: true,
    debug_lock: {
      enabled: true,
      upstream: upstreamName,
      respect_model_override,
      locked_at
    }
  };
}

/**
 * Disable debug lock mode, returning to normal selection.
 *
 * @param {Object} state - Runtime state object
 * @returns {Object} Result with ok status and lock duration info
 */
export function disableDebugLock(state) {
  if (!state.debugLock || !state.debugLock.enabled) {
    return {
      ok: false,
      error: 'No active debug lock to disable'
    };
  }

  const was_locked_to = state.debugLock.upstream;
  const locked_at = new Date(state.debugLock.locked_at);
  const now = new Date();
  const locked_duration_seconds = Math.floor((now - locked_at) / 1000);

  state.debugLock = {
    enabled: false,
    last_diagnostics: null  // Clear diagnostics when unlocking
  };

  return {
    ok: true,
    debug_lock: {
      enabled: false,
      was_locked_to,
      locked_duration_seconds
    }
  };
}

/**
 * Check if debug lock mode is currently active.
 *
 * @param {Object} state - Runtime state object
 * @returns {boolean} True if debug lock is enabled
 */
export function isDebugLockActive(state) {
  return state.debugLock?.enabled === true;
}

/**
 * Get current debug lock state information.
 *
 * @param {Object} state - Runtime state object
 * @returns {Object} Debug lock state info
 */
export function getDebugLockState(state) {
  if (!state.debugLock || !state.debugLock.enabled) {
    return {
      enabled: false
    };
  }

  const locked_at = new Date(state.debugLock.locked_at);
  const now = new Date();
  const locked_duration_seconds = Math.floor((now - locked_at) / 1000);

  const result = {
    enabled: true,
    upstream: state.debugLock.upstream,
    respect_model_override: state.debugLock.respect_model_override,
    locked_at: state.debugLock.locked_at,
    locked_duration_seconds
  };

  // Include last diagnostics if available
  if (state.debugLock.last_diagnostics) {
    result.last_diagnostics = state.debugLock.last_diagnostics;
  }

  return result;
}

/**
 * Build the protocol attempt sequence for debug lock mode based on client protocol.
 *
 * @param {string} clientProtocol - Client entry protocol ('responses' or 'anthropic_messages')
 * @returns {Array<Object>} Array of protocol attempts with {protocol, adapter} properties
 */
export function buildProtocolAttemptSequence(clientProtocol) {
  if (clientProtocol === 'responses') {
    return [
      { protocol: 'responses', adapter: false },
      { protocol: 'chat_completions', adapter: true },
      { protocol: 'anthropic_messages', adapter: true }
    ];
  }

  if (clientProtocol === 'anthropic_messages') {
    return [
      { protocol: 'anthropic_messages', adapter: false }
    ];
  }

  // Default to responses sequence for unknown protocols
  return [
    { protocol: 'responses', adapter: false }
  ];
}

/**
 * Determine if debug lock should fallback to next protocol based on response.
 *
 * Uses conservative strategy: only fallback on clear "endpoint not found" signals.
 * Other errors (auth, rate limit, server errors) are returned to client immediately.
 *
 * @param {number} status - HTTP status code
 * @param {string} errorBody - Response body (may be JSON or plain text)
 * @returns {Object} Result with {fallback: boolean, reason: string}
 */
export function shouldFallbackToNextProtocol(status, errorBody) {
  // Clear endpoint not found signals
  if ([404, 405, 501].includes(status)) {
    return { fallback: true, reason: 'endpoint_not_found' };
  }

  // 400 with explicit unsupported endpoint language
  if (status === 400) {
    const body = String(errorBody).toLowerCase();
    if (/unsupported.*endpoint|invalid.*path|route.*not.*found|endpoint.*not.*supported/i.test(body)) {
      return { fallback: true, reason: 'endpoint_explicitly_unsupported' };
    }
    return { fallback: false, reason: 'bad_request' };
  }

  // Auth errors
  if ([401, 403].includes(status)) {
    return { fallback: false, reason: 'auth_error' };
  }

  // Rate limiting
  if (status === 429) {
    return { fallback: false, reason: 'rate_limited' };
  }

  // Server errors
  if ([500, 502, 503].includes(status)) {
    return { fallback: false, reason: 'server_error' };
  }

  // Unknown error - don't fallback
  return { fallback: false, reason: 'unknown_error' };
}

/**
 * Build complete debug attempt diagnostics from protocol attempts.
 *
 * @param {Array<Object>} attempts - Array of protocol attempt results
 * @param {Object} debugLockState - Current debug lock state
 * @param {Object} clientRequest - Client request info
 * @returns {Object} Complete diagnostics payload
 */
export function buildDebugAttemptDiagnostics(attempts, debugLockState, clientRequest) {
  const succeededAttempt = attempts.find(a => a.status >= 200 && a.status < 300);
  const totalLatency = attempts.reduce((sum, a) => sum + (a.latency_ms || 0), 0);

  return {
    debug_lock: {
      upstream: debugLockState.upstream,
      locked_at: debugLockState.locked_at,
      respect_model_override: debugLockState.respect_model_override
    },
    client_request: {
      protocol: clientRequest.protocol,
      model: clientRequest.model,
      model_sent: clientRequest.model_sent
    },
    attempts: attempts.map(a => ({
      sequence: a.sequence,
      protocol: a.protocol,
      endpoint: a.endpoint,
      adapter: a.adapter,
      adapter_conversions: a.adapter_conversions,
      adapter_stripped: a.adapter_stripped,
      production_disabled: a.production_disabled,
      url: a.url,
      status: a.status,
      error: a.error,
      error_body: a.error_body,
      latency_ms: a.latency_ms,
      tokens: a.tokens,
      streaming: a.streaming,
      fallback_reason: a.fallback_reason
    })),
    succeeded_with: succeededAttempt ? {
      protocol: succeededAttempt.protocol,
      adapter: succeededAttempt.adapter,
      sequence: succeededAttempt.sequence
    } : null,
    total_attempts: attempts.length,
    total_latency_ms: totalLatency,
    timestamp: new Date().toISOString()
  };
}

/**
 * Add debug lock diagnostic headers to response.
 *
 * @param {Object} res - HTTP response object
 * @param {Object} diagnostics - Debug diagnostics from buildDebugAttemptDiagnostics
 */
export function addDebugLockHeaders(res, diagnostics) {
  res.setHeader('X-Debug-Lock-Upstream', diagnostics.debug_lock.upstream);

  if (diagnostics.succeeded_with) {
    res.setHeader('X-Debug-Lock-Protocol', diagnostics.succeeded_with.protocol);
    res.setHeader('X-Debug-Lock-Adapter', diagnostics.succeeded_with.adapter ? 'true' : 'false');
  }

  res.setHeader('X-Debug-Lock-Attempts', String(diagnostics.total_attempts));
  res.setHeader('X-Debug-Lock-Latency-Ms', String(diagnostics.total_latency_ms));

  // Add failed attempts summary
  const failedAttempts = diagnostics.attempts
    .filter(a => a.status < 200 || a.status >= 300)
    .map(a => `${a.protocol}(${a.status})`)
    .join(',');

  if (failedAttempts) {
    res.setHeader('X-Debug-Lock-Failed', failedAttempts);
  }
}

