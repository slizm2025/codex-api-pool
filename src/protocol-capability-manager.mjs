// Protocol Capability Manager
//
// Single home for all Protocol Capability state: the per-upstream record of
// whether each protocol (responses / chat_completions / anthropic_messages) is
// verified / assumed / unknown / failed / unsupported / disabled, and where that
// evidence came from (user_declared / config / probe / real_traffic).
//
// This module owns the *capability* state machine. Health State (upstream.health)
// is intentionally NOT managed here — see PRD "Out of Scope".
//
// Priority rules (highest wins), encapsulated in `recordProbe`:
//   1. Endpoint 404/405/501 (NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS)
//      definitively marks a protocol `unsupported` — overrides everything.
//   2. A user declaration (source=user_declared) survives a non-endpoint probe
//      failure; only the diagnostic (checked_at / probe_failure_*) is updated.
//   3. Real-traffic verification for the *same model* survives a non-endpoint
//      probe failure.
//   4. Otherwise the probe result is recorded as the new state. A probe for a
//      *different* model (or success) overwrites prior evidence.
//
// The exported free functions are the canonical, pure-ish implementations
// (they take `upstream` and mutate `upstream.capabilities`). server.mjs imports
// them so existing call sites are unchanged. `ProtocolCapabilityManager` is the
// OO entry point that wraps an upstream and injects time/classifier deps for
// deterministic unit testing.

export const PROTOCOL_CAPABILITY_NAMES = ['responses', 'chat_completions', 'anthropic_messages'];

// HTTP statuses that prove an endpoint does not exist (vs. a transient failure).
export const NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS = new Set([404, 405, 501]);

// How long a failed/unsupported capability waits before a Health Probe rechecks it.
export const DEFAULT_PROTOCOL_CAPABILITY_RECHECK_MS = 30 * 60 * 1000;

// ── Default dependency implementations (overridable for tests) ─────────────────
// Kept module-local and intentionally identical to server.mjs's now()/timestampMs()
// so behavior is unchanged whether called via the free functions or the manager.
function defaultNow() {
  return Date.now();
}

function defaultTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Fallback classifier: only used when a caller omits `classified`. Every real
// call site passes a classification, so this never runs in production — it exists
// so the free functions remain self-contained. The manager injects the real
// classifyModelProbe from server.mjs when available.
function defaultClassifyModelProbe(result = {}) {
  return { state: result?.ok ? 'ok' : 'inconclusive' };
}

// ── Pure capability data helpers ──────────────────────────────────────────────

export function emptyProtocolCapability(status = 'unknown', reason = '') {
  return {
    status,
    source: '',
    probe_type: '',
    representative: null,
    checked_at: null,
    model: '',
    http_status: 0,
    reason
  };
}

export function normalizeProtocolCapabilities(input = {}) {
  const capabilities = {};
  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    const value = input?.[protocol] && typeof input[protocol] === 'object' && !Array.isArray(input[protocol])
      ? input[protocol]
      : {};
    capabilities[protocol] = {
      ...emptyProtocolCapability(),
      ...value,
      status: String(value.status || 'unknown'),
      source: String(value.source || ''),
      probe_type: String(value.probe_type || value.probeType || ''),
      representative: typeof value.representative === 'boolean' ? value.representative : value.representative ?? null,
      checked_at: value.checked_at || value.checkedAt || null,
      model: String(value.model || ''),
      http_status: Number(value.http_status ?? value.httpStatus ?? 0) || 0,
      reason: String(value.reason || '')
    };
  }
  return capabilities;
}

export function hasProtocolCapabilityEvidence(capability = {}) {
  return capability.status !== 'unknown' ||
    Boolean(capability.source) ||
    Boolean(capability.probe_type) ||
    capability.representative !== null ||
    Boolean(capability.checked_at) ||
    Boolean(capability.model) ||
    Boolean(capability.http_status) ||
    Boolean(capability.reason);
}

export function protocolCapabilityOverridesRestored(configured = {}) {
  if (configured.source === 'user_declared') return true;
  if (configured.status !== 'disabled') return false;
  return configured.reason === 'upstream disabled' ||
    configured.reason.startsWith('configured ') ||
    configured.reason.startsWith('Codex OAuth ');
}

export function mergeRestoredProtocolCapabilities(restored = {}, configured = {}) {
  const oldCapabilities = normalizeProtocolCapabilities(restored);
  const configuredCapabilities = normalizeProtocolCapabilities(configured);
  const merged = {};
  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    const oldCapability = oldCapabilities[protocol];
    const configuredCapability = configuredCapabilities[protocol];
    merged[protocol] = protocolCapabilityOverridesRestored(configuredCapability) || !hasProtocolCapabilityEvidence(oldCapability)
      ? configuredCapability
      : oldCapability;
  }
  return normalizeProtocolCapabilities(merged);
}

export function normalizeDeclaredProtocolCapabilities(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const declared = {};
  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(source, protocol)) continue;
    const value = source[protocol];
    let status = '';
    let reason = '';
    if (value === true) {
      status = 'assumed';
      reason = 'user declared protocol support';
    } else if (value === false) {
      status = 'disabled';
      reason = 'user declared protocol disabled';
    } else if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['assumed', 'supported', 'true', 'yes', 'on'].includes(normalized)) {
        status = 'assumed';
        reason = 'user declared protocol support';
      } else if (['disabled', 'false', 'no', 'off'].includes(normalized)) {
        status = 'disabled';
        reason = 'user declared protocol disabled';
      } else if (normalized === 'unknown') {
        status = 'unknown';
        reason = 'user declared protocol unknown';
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const normalized = String(value.status || '').trim().toLowerCase();
      if (normalized === 'assumed') {
        status = 'assumed';
        reason = String(value.reason || 'user declared protocol support');
      } else if (normalized === 'disabled') {
        status = 'disabled';
        reason = String(value.reason || 'user declared protocol disabled');
      } else if (normalized === 'unknown') {
        status = 'unknown';
        reason = String(value.reason || 'user declared protocol unknown');
      }
    }
    if (!status) continue;
    declared[protocol] = {
      status,
      source: 'user_declared',
      probe_type: '',
      representative: null,
      checked_at: null,
      model: '',
      http_status: 0,
      reason
    };
  }
  return declared;
}

// ── Initialization ────────────────────────────────────────────────────────────
// Pure: takes a normalized descriptor (the caller does config introspection so
// this module has no dependency on server.mjs config helpers).
//   descriptor = { enabled, codexOAuth, requestMode, api, declared }
export function initialProtocolCapabilities(descriptor = {}) {
  const {
    enabled,
    codexOAuth = false,
    requestMode = 'auto',
    api = 'openai',
    declared = {}
  } = descriptor || {};

  const capabilities = normalizeProtocolCapabilities();

  if (enabled === false) {
    for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
      capabilities[protocol] = emptyProtocolCapability('disabled', 'upstream disabled');
    }
    return normalizeProtocolCapabilities({ ...capabilities, ...normalizeDeclaredProtocolCapabilities(declared) });
  }

  if (codexOAuth) {
    capabilities.responses = {
      ...emptyProtocolCapability('assumed', 'configured request_mode=codex_oauth'),
      source: 'config'
    };
    capabilities.chat_completions = emptyProtocolCapability('disabled', 'Codex OAuth upstream uses native Responses protocol');
    capabilities.anthropic_messages = emptyProtocolCapability('disabled', 'Codex OAuth upstream uses native Responses protocol');
    return capabilities;
  }

  if (requestMode === 'responses') {
    capabilities.responses = {
      ...emptyProtocolCapability('assumed', 'configured request_mode=responses'),
      source: 'config'
    };
    capabilities.chat_completions = emptyProtocolCapability('disabled', 'configured request_mode=responses');
  } else if (requestMode === 'chat_completions') {
    capabilities.responses = emptyProtocolCapability('disabled', 'configured request_mode=chat_completions');
    capabilities.chat_completions = {
      ...emptyProtocolCapability('assumed', 'configured request_mode=chat_completions'),
      source: 'config'
    };
  }

  if (api === 'anthropic') {
    capabilities.anthropic_messages = {
      ...emptyProtocolCapability('assumed', 'configured api=anthropic'),
      source: 'config'
    };
  } else if (api === 'openai') {
    capabilities.responses = {
      ...emptyProtocolCapability('assumed', 'configured api=openai'),
      source: 'config'
    };
    capabilities.chat_completions = {
      ...emptyProtocolCapability('assumed', 'configured api=openai'),
      source: 'config'
    };
  } else if (api === 'both') {
    capabilities.responses = {
      ...emptyProtocolCapability('assumed', 'configured api=both'),
      source: 'config'
    };
    capabilities.chat_completions = {
      ...emptyProtocolCapability('assumed', 'configured api=both'),
      source: 'config'
    };
    capabilities.anthropic_messages = {
      ...emptyProtocolCapability('assumed', 'configured api=both'),
      source: 'config'
    };
  }

  return normalizeProtocolCapabilities({ ...capabilities, ...normalizeDeclaredProtocolCapabilities(declared) });
}

// ── Status mapping helpers ────────────────────────────────────────────────────

export function protocolCapabilityStatusFromProbeState(state, statusCode = 0) {
  if (state === 'ok') return 'verified';
  if (state === 'advanced_curl_required' || state === 'codex_forward_only') return 'unknown';

  // Transient failures → unknown (short recheck interval)
  if (state === 'network_error' || state === 'timeout') return 'unknown';
  if (state === 'rate_limited') return 'unknown';
  if (state === 'server_error') return 'unknown';
  if (state === 'inconclusive') return 'unknown';

  // Hard endpoint-unsupported (404/405/501) → unsupported (long recheck interval)
  if (NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS.has(statusCode)) return 'unsupported';

  // Other failures (auth_error, etc.) → unknown
  return 'unknown';
}

export function protocolCapabilityReason(classified, result, protocol) {
  if (classified?.error) return classified.error;
  if (result?.error) return result.error;
  if (classified?.state === 'ok') return '';
  const statusCode = Number(result?.statusCode || 0);
  return statusCode ? `${protocol} probe returned HTTP ${statusCode}` : `${protocol} probe ${classified?.state || 'unknown'}`;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function protocolCapabilityStatus(upstream, protocol) {
  return String(upstream?.capabilities?.[protocol]?.status || 'unknown');
}

export function upstreamHasVerifiedProtocolCapability(upstream, protocol) {
  return protocolCapabilityStatus(upstream, protocol) === 'verified';
}

export function upstreamHasUserDeclaredProtocolCapability(upstream, protocol, status = 'assumed') {
  const capability = upstream?.capabilities?.[protocol];
  return capability?.source === 'user_declared' && capability?.status === status;
}

export function shouldRecheckProtocolCapability(upstream, protocol, {
  now: nowFn = defaultNow,
  timestampMs: timestampMsFn = defaultTimestampMs,
  intervalMs = DEFAULT_PROTOCOL_CAPABILITY_RECHECK_MS
} = {}) {
  const capability = normalizeProtocolCapabilities(upstream?.capabilities)[protocol];
  if (!capability) return false;

  // Explicit endpoint-unsupported (404/405/501) or a probe failure should be
  // rechecked periodically so an upstream can recover when it adds support.
  if (capability.endpoint_unsupported === true || capability.status === 'unsupported' || capability.status === 'failed') {
    const lastCheckedAt = timestampMsFn(capability.checked_at);
    return nowFn() - lastCheckedAt >= intervalMs;
  }

  return false;
}

// ── Recording ─────────────────────────────────────────────────────────────────

export function recordProtocolCapabilityProbe(upstream, protocol, result, classified, {
  checkedAt = new Date().toISOString(),
  model = '',
  probeType = 'model_request',
  representative = true,
  classifyModelProbe = defaultClassifyModelProbe
} = {}) {
  if (!upstream || !PROTOCOL_CAPABILITY_NAMES.includes(protocol)) return;
  const state = classified?.state || classifyModelProbe(result || {}, protocol).state;
  const statusCode = Number(result?.statusCode || 0);

  // ── Explicit failure: 404/405/501 means the endpoint definitively does not exist ──
  const isClearEndpointUnsupported = NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS.has(statusCode);

  // ── Protection 1: user declaration wins (unless explicit endpoint-unsupported) ──
  if (state !== 'ok' && !isClearEndpointUnsupported && upstreamHasUserDeclaredProtocolCapability(upstream, protocol)) {
    // User declared support but the probe failed (not a clear 404/405/501) →
    // keep the declaration, only stamp the probe-failure diagnostics.
    const existing = upstream.capabilities?.[protocol];
    if (existing?.source === 'user_declared') {
      upstream.capabilities = normalizeProtocolCapabilities(upstream.capabilities);
      upstream.capabilities[protocol] = {
        ...existing,
        checked_at: checkedAt,
        http_status: statusCode,
        probe_failure_reason: protocolCapabilityReason({ ...(classified || {}), state }, result, protocol),
        probe_failure_at: checkedAt
      };
    }
    return;
  }

  // ── Protection 2: real-traffic verification wins (unless explicit endpoint-unsupported) ──
  const existing = upstream.capabilities?.[protocol];
  if (
    state !== 'ok' &&
    !isClearEndpointUnsupported &&
    existing?.status === 'verified' &&
    existing?.source === 'real_traffic' &&
    existing?.representative === true &&
    String(existing?.model || '').trim() === String(model || '').trim()
  ) {
    // Real traffic already proved this protocol for this model; a probe failure
    // (not a clear 404/405/501) keeps the evidence but stamps the failure.
    upstream.capabilities = normalizeProtocolCapabilities(upstream.capabilities);
    upstream.capabilities[protocol] = {
      ...existing,
      probe_failure_reason: protocolCapabilityReason({ ...(classified || {}), state }, result, protocol),
      probe_failure_at: checkedAt
    };
    return;
  }

  // ── Record the new capability state from the probe ──
  upstream.capabilities = normalizeProtocolCapabilities(upstream.capabilities);
  const newStatus = protocolCapabilityStatusFromProbeState(state, statusCode);

  upstream.capabilities[protocol] = {
    status: newStatus,
    source: 'probe',
    probe_type: probeType,
    representative: state === 'advanced_curl_required' || state === 'codex_forward_only' ? false : representative,
    checked_at: checkedAt,
    model: String(model || ''),
    http_status: statusCode,
    reason: protocolCapabilityReason({ ...(classified || {}), state }, result, protocol),
    // Mark recheckable when the endpoint is clearly unsupported.
    endpoint_unsupported: isClearEndpointUnsupported,
    last_probe_state: state
  };
}

export function recordProtocolCapabilityRealTraffic(upstream, protocol, {
  checkedAt = new Date().toISOString(),
  model = '',
  httpStatus = 0,
  reason = ''
} = {}) {
  if (!upstream || !PROTOCOL_CAPABILITY_NAMES.includes(protocol)) return;
  upstream.capabilities = normalizeProtocolCapabilities(upstream.capabilities);
  upstream.capabilities[protocol] = {
    status: 'verified',
    source: 'real_traffic',
    probe_type: 'real_traffic',
    representative: true,
    checked_at: checkedAt,
    model: String(model || ''),
    http_status: Number(httpStatus || 0) || 0,
    reason: String(reason || '')
  };
}

// ── OO entry point ────────────────────────────────────────────────────────────
// Wraps a single upstream and operates directly on `upstream.capabilities` (the
// single source of truth). Inject `now`/`timestampMs`/`classifyModelProbe` for
// deterministic tests; production injects server.mjs's real implementations.
export class ProtocolCapabilityManager {
  constructor(upstream, deps = {}) {
    this.upstream = upstream || {};
    this._deps = {
      now: typeof deps.now === 'function' ? deps.now : defaultNow,
      timestampMs: typeof deps.timestampMs === 'function' ? deps.timestampMs : defaultTimestampMs,
      classifyModelProbe: typeof deps.classifyModelProbe === 'function' ? deps.classifyModelProbe : defaultClassifyModelProbe
    };
    this._recheckIntervalMs = Number(deps.recheckIntervalMs) > 0
      ? Number(deps.recheckIntervalMs)
      : DEFAULT_PROTOCOL_CAPABILITY_RECHECK_MS;
  }

  // Live, normalized view of the wrapped upstream's capabilities.
  get capabilities() {
    this.upstream.capabilities = normalizeProtocolCapabilities(this.upstream.capabilities);
    return this.upstream.capabilities;
  }

  // Build initial capabilities from a descriptor, optionally merging restored state.
  initialize(descriptor = {}, restoredCapabilities = null) {
    let capabilities = initialProtocolCapabilities(descriptor);
    if (restoredCapabilities) {
      capabilities = mergeRestoredProtocolCapabilities(restoredCapabilities, capabilities);
    }
    this.upstream.capabilities = capabilities;
    return capabilities;
  }

  recordProbe(protocol, result, classified, options = {}) {
    recordProtocolCapabilityProbe(this.upstream, protocol, result, classified, {
      classifyModelProbe: this._deps.classifyModelProbe,
      ...options
    });
    return this.getStatus(protocol);
  }

  // Note: options-object form (matches the server.mjs call site), not the PRD's
  // positional (protocol, model, httpStatus) sketch — keeps callers extensible.
  recordRealTraffic(protocol, options = {}) {
    recordProtocolCapabilityRealTraffic(this.upstream, protocol, options);
    return this.getStatus(protocol);
  }

  getStatus(protocol) {
    return protocolCapabilityStatus(this.upstream, protocol);
  }

  hasVerified(protocol) {
    return upstreamHasVerifiedProtocolCapability(this.upstream, protocol);
  }

  hasUserDeclared(protocol, status = 'assumed') {
    return upstreamHasUserDeclaredProtocolCapability(this.upstream, protocol, status);
  }

  shouldRecheck(protocol, nowMs) {
    return shouldRecheckProtocolCapability(this.upstream, protocol, {
      now: typeof nowMs === 'number' ? () => nowMs : this._deps.now,
      timestampMs: this._deps.timestampMs,
      intervalMs: this._recheckIntervalMs
    });
  }

  toJSON() {
    return normalizeProtocolCapabilities(this.upstream.capabilities);
  }
}
