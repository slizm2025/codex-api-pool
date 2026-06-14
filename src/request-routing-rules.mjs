// Request Routing Rules
//
// Centralizes all routing decision logic that determines whether to attempt
// native /v1/responses or fall back to /v1/chat/completions.
//
// This module extracts the scattered routing functions from server.mjs into
// a single, testable, reusable module.

import { normalizeProtocolCapabilities } from './protocol-capability-manager.mjs';

const DEFAULT_NATIVE_RESPONSES_RECHECK_MS = 30 * 60 * 1000; // 30 minutes

const ROUTE_STRATEGY_NAMES = new Set([
  'responses',
  'chat_completions',
  'chat_completions_compatibility',
  'codex_oauth_responses'
]);

/**
 * Request Routing Rules
 *
 * Encapsulates the decision tree for protocol selection.
 */
export class RequestRoutingRules {
  constructor(config = {}, dependencies = {}) {
    this._config = config;
    this._nativeResponsesRecheckMs = config.retry?.native_responses_recheck_ms || DEFAULT_NATIVE_RESPONSES_RECHECK_MS;

    // Injectable dependencies for testing
    this._shouldUseAnthropicResponsesAdapter = dependencies.shouldUseAnthropicResponsesAdapter || (() => false);
    this._canUseChatCompletionsAdapter = dependencies.canUseChatCompletionsAdapter || (() => true);
  }

  /**
   * Main decision point: can we attempt native /v1/responses?
   *
   * @param {string} pathname - Request path
   * @param {object} upstream - Upstream configuration
   * @param {string} model - Model name
   * @param {object} options - { at?, nativeResponsesRecheckMs? }
   * @returns {boolean}
   */
  canAttemptNativeResponses(pathname, upstream, model, options = {}) {
    const at = options.at || Date.now();
    const recheckMs = options.nativeResponsesRecheckMs || this._nativeResponsesRecheckMs;

    // Non-responses paths always return true (no decision needed)
    if (pathname !== '/v1/responses') return true;

    // Check if we should use Anthropic adapter (Claude models)
    if (this._shouldUseAnthropicResponsesAdapter(pathname, model)) return false;

    // If chat completions adapter can't be used, must use responses
    if (!this._canUseChatCompletionsAdapter(pathname, upstream, model)) return true;

    // Explicit chat_completions mode
    if (upstream?.requestMode === 'chat_completions') return false;

    // Check learned strategy
    const learnedStrategy = this.getRouteStrategy(upstream, model);
    if (this.routeStrategyUsesNativeResponses(learnedStrategy)) return true;

    if (this.routeStrategyUsesChatCompletions(learnedStrategy)) {
      return this.nativeResponsesCapabilityNewerThanStrategy(upstream, learnedStrategy, model) ||
        this.nativeResponsesRecheckDue(learnedStrategy, { at, intervalMs: recheckMs });
    }

    // Explicit responses mode
    if (upstream?.requestMode === 'responses') return true;

    // Check resolved mode
    if (upstream?.resolvedRequestMode === 'chat_completions') {
      const checkedAt = upstream?.health?.checkedAt || upstream?.capabilities?.chat_completions?.checked_at || '';
      const resolvedModeEvidence = { checked_at: checkedAt };
      return this.nativeResponsesCapabilityNewerThanStrategy(upstream, resolvedModeEvidence, model) ||
        this.nativeResponsesRecheckDue(resolvedModeEvidence, { at, intervalMs: recheckMs });
    }

    // Default: can attempt unless explicitly in chat-only mode
    return !this.isChatCompletionsOnlyMode(upstream);
  }

  /**
   * Get the learned route strategy for an upstream + model combination.
   */
  getRouteStrategy(upstream, model) {
    const strategies = this._normalizeRouteStrategies(upstream?.routeStrategies || upstream?.route_strategies);
    const modelKey = this._routeStrategyModelKey(model);
    return strategies[modelKey] || strategies.__default__ || null;
  }

  /**
   * Check if a strategy uses native responses.
   */
  routeStrategyUsesNativeResponses(strategy) {
    const value = typeof strategy === 'string' ? strategy : strategy?.strategy;
    return value === 'responses' || value === 'codex_oauth_responses';
  }

  /**
   * Check if a strategy uses chat completions.
   */
  routeStrategyUsesChatCompletions(strategy) {
    const value = typeof strategy === 'string' ? strategy : strategy?.strategy;
    return value === 'chat_completions' || value === 'chat_completions_compatibility';
  }

  /**
   * Check if upstream is in chat-completions-only mode.
   */
  isChatCompletionsOnlyMode(upstream) {
    return upstream?.requestMode === 'chat_completions' ||
      upstream?.resolvedRequestMode === 'chat_completions';
  }

  /**
   * Check if native responses capability is newer than strategy.
   */
  nativeResponsesCapabilityNewerThanStrategy(upstream, strategy, model = '') {
    const capability = normalizeProtocolCapabilities(upstream?.capabilities).responses;
    if (capability?.status !== 'verified') return false;

    const capabilityModel = String(capability.model || '').trim();
    const requestedModel = String(model || '').trim();
    if (capabilityModel && requestedModel && capabilityModel !== requestedModel) return false;

    const capabilityCheckedAt = this._timestampMs(capability.checked_at);
    const strategyCheckedAt = this._timestampMs(strategy?.checked_at);
    return capabilityCheckedAt > 0 && capabilityCheckedAt >= strategyCheckedAt;
  }

  /**
   * Check if native responses recheck is due.
   */
  nativeResponsesRecheckDue(strategy, options = {}) {
    const at = options.at || Date.now();
    const intervalMs = options.intervalMs || this._nativeResponsesRecheckMs;

    const interval = Number(intervalMs);
    if (!Number.isFinite(interval) || interval <= 0) return true;

    const checkedAt = this._timestampMs(strategy?.checked_at);
    if (!checkedAt) return true;

    return at - checkedAt >= interval;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  _routeStrategyModelKey(model) {
    return String(model || '').trim() || '__default__';
  }

  _normalizeRouteStrategies(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const entries = {};
    for (const [modelKey, value] of Object.entries(input)) {
      const normalized = this._normalizeRouteStrategyEntry(value, modelKey);
      if (normalized) entries[modelKey] = normalized;
    }
    return entries;
  }

  _normalizeRouteStrategyEntry(entry, modelKey = '') {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const strategy = String(entry.strategy || entry.route || '').trim();
    if (!ROUTE_STRATEGY_NAMES.has(strategy)) return null;
    return {
      strategy,
      model: String(entry.model || modelKey || ''),
      source: String(entry.source || 'real_traffic'),
      checked_at: typeof entry.checked_at === 'string'
        ? entry.checked_at
        : typeof entry.checkedAt === 'string'
          ? entry.checkedAt
          : new Date().toISOString(),
      reason: String(entry.reason || '')
    };
  }

  _timestampMs(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

