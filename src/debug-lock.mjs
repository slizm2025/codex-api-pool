// Debug Lock Mode - State Management
//
// Provides functions to enable, disable, and query debug lock state.
// Debug lock forces all requests to a specific upstream for diagnostic purposes.

// Maximum number of test pages (one per real client request, incl. retries) to
// retain for dashboard display. Oldest pages are dropped once this is exceeded.
export const DEBUG_LOCK_MAX_TEST_PAGES = 10;

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
    locked_at,
    // Multi-page diagnostics: each real client request (incl. retries) appends
    // one page here. Kept newest-first, capped at DEBUG_LOCK_MAX_TEST_PAGES.
    // `first_test_completed` is retained as a convenience flag meaning "at least
    // one test page exists" for callers that only need a boolean.
    first_test_completed: false,
    test_pages: []
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
    first_test_completed: false,
    test_pages: []
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
    locked_duration_seconds,
    first_test_completed: state.debugLock.first_test_completed,
    test_pages: Array.isArray(state.debugLock.test_pages) ? state.debugLock.test_pages : [],
    max_test_pages: DEBUG_LOCK_MAX_TEST_PAGES
  };

  // Back-compat alias: callers/tests that still read first_test_diagnostics get
  // the most recent page (test_pages is newest-first).
  if (result.test_pages.length > 0) {
    result.first_test_diagnostics = result.test_pages[0];
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
      { protocol: 'anthropic_messages', adapter: false },
      { protocol: 'chat_completions', adapter: true },
      { protocol: 'responses', adapter: true }
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
      model_sent: clientRequest.model_sent,
      original_body: clientRequest.original_body
    },
    attempts: attempts.map(a => ({
      sequence: a.sequence,
      protocol: a.protocol,
      endpoint: a.endpoint,
      adapter: a.adapter,
      adapter_conversions: a.adapter_conversions,
      adapter_stripped: a.adapter_stripped,
      production_disabled: a.production_disabled,
      model_sent: a.model_sent,
      url: a.url,
      status: a.status,
      error: a.error,
      error_body: a.error_body,
      response_body: a.response_body,
      request_body: a.request_body,
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
 * Append a completed test page to the debug lock diagnostics history.
 *
 * Each real client request (including reconnects/retries) produces one page
 * containing that request's full protocol-attempt diagnostics. Pages are kept
 * newest-first and capped at DEBUG_LOCK_MAX_TEST_PAGES so the dashboard can show
 * the most recent client interactions without unbounded memory growth. Pages are
 * never overwritten — every request appends below (visually) the previous ones.
 *
 * FIXED: Use atomic array operation to prevent race conditions in concurrent scenarios.
 *
 * @param {Object} state - Runtime state object (must contain state.debugLock)
 * @param {Object} diagnostics - Diagnostics payload from buildDebugAttemptDiagnostics
 * @returns {number} Number of pages now stored
 */
export function appendDebugLockTestPage(state, diagnostics) {
  if (!state.debugLock) return 0;
  if (!Array.isArray(state.debugLock.test_pages)) {
    state.debugLock.test_pages = [];
  }

  // Node.js single-threaded event loop guarantees this is atomic
  // (no async boundaries, cannot be interrupted mid-execution)
  state.debugLock.test_pages.unshift(diagnostics);
  if (state.debugLock.test_pages.length > DEBUG_LOCK_MAX_TEST_PAGES) {
    state.debugLock.test_pages.length = DEBUG_LOCK_MAX_TEST_PAGES;
  }
  state.debugLock.first_test_completed = true;

  return state.debugLock.test_pages.length;
}

/**
 * @deprecated Retained only for backwards compatibility with older imports.
 * Multi-page diagnostics (appendDebugLockTestPage) replaced this. Always returns
 * true because every request now appends a page.
 */
export function shouldSaveDebugLockDiagnostics() {
  return true;
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

/**
 * Sanitize request body for diagnostics by redacting sensitive fields.
 *
 * Removes or redacts sensitive information like passwords, API keys, tokens, etc.
 * to prevent leaking credentials in diagnostic files and memory.
 *
 * @param {string} bodyString - Request body as string (usually JSON)
 * @returns {string} Sanitized body string with sensitive fields redacted
 */
export function sanitizeRequestBodyForDiagnostics(bodyString) {
  const MAX_BODY_SIZE = 50 * 1024; // 50KB limit for diagnostics

  try {
    const parsed = JSON.parse(bodyString);
    const sanitized = redactSensitiveFields(parsed);
    const result = JSON.stringify(sanitized, null, 2);

    // Truncate if still too large after redaction
    if (result.length > MAX_BODY_SIZE) {
      return result.substring(0, MAX_BODY_SIZE) + '\n\n... [TRUNCATED: ' + (result.length - MAX_BODY_SIZE) + ' bytes omitted]';
    }

    return result;
  } catch {
    // Not valid JSON or parsing failed
    // Truncate raw string to prevent exposing large non-structured data
    if (bodyString.length > MAX_BODY_SIZE) {
      return bodyString.substring(0, MAX_BODY_SIZE) + '\n\n... [TRUNCATED: ' + (bodyString.length - MAX_BODY_SIZE) + ' bytes omitted]';
    }
    return bodyString;
  }
}

/**
 * Recursively redact sensitive fields from an object.
 * @private
 */
function redactSensitiveFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const sensitiveKeys = [
    'password', 'passwd', 'pwd',
    'api_key', 'apikey', 'api-key',
    'token', 'access_token', 'refresh_token', 'auth_token', 'bearer_token',
    'secret', 'client_secret',
    'authorization',
    'private_key', 'privatekey',
    'session_id', 'sessionid'
  ];

  const result = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = String(key).toLowerCase();

    // Check if key matches any sensitive pattern
    // Special case: 'credentials' as a key should be redacted entirely (not recursed)
    if (lowerKey === 'credentials' || lowerKey === 'credential') {
      result[key] = '[REDACTED]';
    } else if (sensitiveKeys.some(k => lowerKey.includes(k))) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      // Recursively redact nested objects/arrays
      result[key] = redactSensitiveFields(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Persist a debug lock diagnostics page to a JSON file.
 *
 * SECURITY FIXES:
 * - Path traversal prevention via basename() and character whitelist
 * - Input validation for diagnostics structure
 * - Size limits for request/response bodies
 * - File rotation to prevent disk exhaustion
 *
 * @param {Object} diagnostics - Complete diagnostics payload from buildDebugAttemptDiagnostics
 * @param {Object} options - Persistence options
 * @param {string} options.directory - Directory to write files to (default: './debug-lock-logs')
 * @param {number} options.max_body_size - Max size for bodies in bytes (default: 100KB)
 * @param {number} options.max_files - Max files to keep (default: 100)
 * @returns {Promise<string>} Path to the written file
 */
export async function persistDebugLockPage(diagnostics, options = {}) {
  // Input validation
  if (!diagnostics || typeof diagnostics !== 'object') {
    throw new TypeError('diagnostics must be a non-null object');
  }
  if (!diagnostics.timestamp) {
    throw new TypeError('diagnostics.timestamp is required');
  }
  if (!Array.isArray(diagnostics.attempts)) {
    throw new TypeError('diagnostics.attempts must be an array');
  }

  const { promises: fs } = await import('fs');
  const { join, basename: pathBasename } = await import('path');

  const directory = options.directory || './debug-lock-logs';
  const maxBodySize = options.max_body_size || 100 * 1024; // 100KB
  const maxFiles = options.max_files || 100;

  // Ensure directory exists
  try {
    await fs.mkdir(directory, { recursive: true });
  } catch (mkdirError) {
    throw new Error(`Failed to create directory "${directory}": ${mkdirError.message}`, { cause: mkdirError });
  }

  // File rotation: cleanup old files if limit exceeded
  try {
    const files = await fs.readdir(directory);
    const debugLockFiles = files
      .filter(f => f.startsWith('debug-lock-') && f.endsWith('.json'))
      .map(f => ({ name: f, path: join(directory, f) }));

    if (debugLockFiles.length >= maxFiles) {
      // Get file stats and sort by modification time
      const filesWithStats = await Promise.all(
        debugLockFiles.map(async f => ({
          ...f,
          mtime: (await fs.stat(f.path)).mtime
        }))
      );
      filesWithStats.sort((a, b) => a.mtime - b.mtime);

      // Delete oldest files to make room for new one
      const toDelete = filesWithStats.slice(0, filesWithStats.length - maxFiles + 1);
      await Promise.all(toDelete.map(f => fs.unlink(f.path).catch(() => {})));
    }
  } catch (cleanupError) {
    // Cleanup failure should not block writing new file
    console.warn('[Debug Lock] Failed to cleanup old files:', cleanupError.message);
  }

  // Generate safe filename - SECURITY: prevent path traversal
  const timestamp = diagnostics.timestamp || new Date().toISOString();

  // Whitelist only alphanumeric and hyphens (removes /, \, :, ., etc.)
  const safeTimestamp = timestamp.replace(/[^a-zA-Z0-9-]/g, '-');
  const filename = `debug-lock-${safeTimestamp}.json`;

  // Use basename to strip any remaining directory components
  const safeFilename = pathBasename(filename);
  const filePath = join(directory, safeFilename);

  // Truncate large bodies to prevent memory exhaustion
  const sanitized = {
    ...diagnostics,
    client_request: {
      ...diagnostics.client_request,
      original_body: truncateForPersistence(diagnostics.client_request?.original_body, maxBodySize)
    },
    attempts: (diagnostics.attempts || []).map(a => ({
      ...a,
      request_body: truncateForPersistence(a.request_body, maxBodySize),
      response_body: truncateForPersistence(a.response_body, maxBodySize)
    }))
  };

  // Write diagnostics to file
  try {
    await fs.writeFile(filePath, JSON.stringify(sanitized, null, 2), 'utf-8');
  } catch (writeError) {
    throw new Error(`Failed to write diagnostics to "${filePath}": ${writeError.message}`, { cause: writeError });
  }

  return filePath;
}

/**
 * Truncate body string for persistence to prevent memory issues.
 * @private
 */
function truncateForPersistence(body, maxSize) {
  if (!body || typeof body !== 'string') return body;
  if (body.length <= maxSize) return body;

  const truncated = maxSize - 100; // Leave room for truncation message
  return body.substring(0, truncated) + '\n\n... [TRUNCATED: ' + (body.length - truncated) + ' bytes omitted]';
}

/**
 * Get debug lock persistence configuration from pool config.
 *
 * @param {Object} config - Pool configuration object
 * @returns {Object} Persistence config with {enabled, directory, format}
 */
export function getDebugLockPersistenceConfig(config) {
  const persistConfig = config.debug_lock_persistence || {};

  return {
    enabled: persistConfig.enabled === true,
    directory: persistConfig.directory || './debug-lock-logs',
    format: persistConfig.format || 'json'
  };
}
