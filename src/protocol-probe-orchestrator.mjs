// Protocol Probe Orchestrator
//
// Owns the multi-protocol probe strategy: decides which protocols to probe based on
// API Type Declaration, selects representative models, and orchestrates progressive
// fallback (e.g., responses → chat_completions).
//
// Does NOT execute HTTP requests directly — delegates to ProbeExecutor interface.
// Does NOT manage capability state — delegates to ProtocolCapabilityManager.
//
// This separation enables testing probe strategy without HTTP and without time manipulation.

// ── ProbeExecutor Interface ───────────────────────────────────────────────────
// Abstract interface for HTTP probe execution. Tests inject FakeProbeExecutor;
// production uses HttpProbeExecutor that delegates to existing probe functions.

export class ProbeExecutor {
  async probeResponses(upstream, key, config, model) {
    throw new Error('ProbeExecutor.probeResponses not implemented');
  }

  async probeChatCompletions(upstream, key, config, model) {
    throw new Error('ProbeExecutor.probeChatCompletions not implemented');
  }

  async probeAnthropicMessages(upstream, key, config, model) {
    throw new Error('ProbeExecutor.probeAnthropicMessages not implemented');
  }
}

// ── HttpProbeExecutor (delegates to real probe functions) ────────────────────
// Created via factory function that receives the actual probe functions from server.mjs.
// This avoids breaking encapsulation - server.mjs decides which functions to use.

export class HttpProbeExecutor extends ProbeExecutor {
  constructor(probeFunctions) {
    super();
    this._probeResponsesFn = probeFunctions.probeResponses;
    this._probeChatCompletionsFn = probeFunctions.probeChatCompletions;
    this._probeAnthropicMessagesFn = probeFunctions.probeAnthropicMessages;
  }

  async probeResponses(upstream, key, config, model) {
    return await this._probeResponsesFn(upstream, key, config, model);
  }

  async probeChatCompletions(upstream, key, config, model) {
    return await this._probeChatCompletionsFn(upstream, key, config, model);
  }

  async probeAnthropicMessages(upstream, key, config, model) {
    return await this._probeAnthropicMessagesFn(upstream, key, config, model);
  }
}

// ── Protocol Probe Orchestrator ───────────────────────────────────────────────

export class ProtocolProbeOrchestrator {
  constructor(capabilityManager, probeExecutor, classifier = null) {
    this._capabilityManager = capabilityManager;
    this._probeExecutor = probeExecutor;
    this._classifier = classifier; // Optional classifier function
  }

  /**
   * Plan which protocols to probe based on API Type Declaration and current capability state.
   * Returns a probe plan object with protocol → { model, reason, fallbackToChat? } mappings.
   *
   * Integrates recheck strategy: checks shouldRecheckProtocolCapability to determine if
   * unsupported/failed protocols should be rechecked.
   *
   * Handles resolvedRequestMode: if already resolved to chat_completions, skip responses
   * unless recheck is due.
   */
  planProbes(upstream, models, now) {
    const api = upstream?.api || 'openai';
    const requestMode = upstream?.requestMode || upstream?.request_mode || 'auto';
    const resolvedRequestMode = upstream?.resolvedRequestMode || null;
    const plan = {
      responses: null,
      chat_completions: null,
      anthropic_messages: null
    };

    // Helper: check if model is Claude
    const isClaudeModel = (model) => {
      const normalized = String(model || '').toLowerCase();
      return normalized.startsWith('claude-');
    };

    // Helper: check if protocol needs recheck
    const needsRecheck = (protocol) => {
      return this._capabilityManager.shouldRecheck(protocol, now);
    };

    // Helper: check if protocol is unsupported and no recheck needed
    const shouldSkipProtocol = (protocol) => {
      const status = this._capabilityManager.getStatus(protocol);
      if (status === 'unsupported' && !needsRecheck(protocol)) {
        return true;
      }
      return false;
    };

    // Select representative models
    const claudeModels = models.filter(isClaudeModel);
    const nonClaudeModels = models.filter(m => !isClaudeModel(m));

    // Anthropic Messages (for api=anthropic or api=both)
    if ((api === 'anthropic' || api === 'both') && claudeModels[0]) {
      if (!shouldSkipProtocol('anthropic_messages')) {
        plan.anthropic_messages = {
          model: claudeModels[0],
          reason: needsRecheck('anthropic_messages') ? 'recheck' : 'initial'
        };
      }
    }

    // OpenAI protocols (for api=openai or api=both)
    if ((api === 'openai' || api === 'both') && nonClaudeModels[0]) {
      // If request_mode=chat_completions, only probe chat
      if (requestMode === 'chat_completions') {
        if (!shouldSkipProtocol('chat_completions')) {
          plan.chat_completions = {
            model: nonClaudeModels[0],
            reason: needsRecheck('chat_completions') ? 'recheck' : 'initial'
          };
        }
      }
      // If resolvedRequestMode=chat_completions, skip responses unless recheck
      else if (resolvedRequestMode === 'chat_completions' && !needsRecheck('responses')) {
        if (!shouldSkipProtocol('chat_completions')) {
          plan.chat_completions = {
            model: nonClaudeModels[0],
            reason: needsRecheck('chat_completions') ? 'recheck' : 'initial'
          };
        }
      }
      // Otherwise, probe responses with chat fallback (unless responses is unsupported)
      else {
        if (shouldSkipProtocol('responses')) {
          // Responses is unsupported and no recheck due, go directly to chat
          if (!shouldSkipProtocol('chat_completions')) {
            plan.chat_completions = {
              model: nonClaudeModels[0],
              reason: needsRecheck('chat_completions') ? 'recheck' : 'initial'
            };
          }
        } else {
          // Probe responses with optional chat fallback
          plan.responses = {
            model: nonClaudeModels[0],
            reason: needsRecheck('responses') ? 'recheck' : 'initial',
            fallbackToChat: true
          };
        }
      }
    }

    return plan;
  }

  /**
   * Execute planned probes with fallback logic.
   * Returns probe results object with protocol → { result, classified } mappings.
   *
   * Uses optional classifier function to classify probe results. If no classifier
   * is provided, uses simple statusCode-based classification.
   */
  async executeProbes(upstream, key, config, plan, checkedAt) {
    const results = {};

    // Helper: classify a probe result
    const classify = (result, protocol) => {
      if (this._classifier) {
        return this._classifier(result, protocol);
      }
      // Default simple classification
      const respOk = result.statusCode === 200;
      return { state: respOk ? 'ok' : 'server_error', error: respOk ? '' : (result.error || 'probe failed') };
    };

    // Probe responses (with optional chat fallback)
    if (plan.responses) {
      const respResult = await this._probeExecutor.probeResponses(
        upstream,
        key,
        config,
        plan.responses.model
      );

      const respClassified = classify(respResult, 'responses');
      const respOk = respClassified.state === 'ok';

      results.responses = {
        result: respResult,
        classified: respClassified
      };

      // Fallback to chat_completions if responses failed and fallback enabled
      if (!respOk && plan.responses.fallbackToChat) {
        const chatResult = await this._probeExecutor.probeChatCompletions(
          upstream,
          key,
          config,
          plan.responses.model
        );

        const chatClassified = classify(chatResult, 'chat_completions');

        results.chat_completions = {
          result: chatResult,
          classified: chatClassified
        };
      }
    }

    // Probe chat_completions (standalone, no fallback)
    if (plan.chat_completions && !results.chat_completions) {
      const chatResult = await this._probeExecutor.probeChatCompletions(
        upstream,
        key,
        config,
        plan.chat_completions.model
      );

      const chatClassified = classify(chatResult, 'chat_completions');

      results.chat_completions = {
        result: chatResult,
        classified: chatClassified
      };
    }

    // Probe anthropic_messages
    if (plan.anthropic_messages) {
      const anthropicResult = await this._probeExecutor.probeAnthropicMessages(
        upstream,
        key,
        config,
        plan.anthropic_messages.model
      );

      const anthropicClassified = classify(anthropicResult, 'anthropic_messages');

      results.anthropic_messages = {
        result: anthropicResult,
        classified: anthropicClassified
      };
    }

    return results;
  }

  /**
   * Determine overall health status from probe results.
   *
   * Implements health priority logic:
   * 1. OK status is preferred
   * 2. For OpenAI: responses ok > chat ok > both failed
   * 3. For failures: auth_error > other errors
   * 4. Returns { state, protocol, result, error, warning?, resolvedMode? }
   */
  determineHealthStatus(probeResults, model) {
    const responses = probeResults.responses;
    const chat = probeResults.chat_completions;
    const anthropic = probeResults.anthropic_messages;

    // Helper: check if state is ok
    const isOk = (classified) => classified?.state === 'ok';

    // Helper: check if state is authoritative failure (auth_error, rate_limited, etc.)
    const isAuthoritativeFailure = (state) => {
      return ['auth_error', 'rate_limited', 'server_error', 'network_error', 'timeout'].includes(state);
    };

    // Anthropic Messages (if present)
    if (anthropic) {
      return {
        state: anthropic.classified.state,
        protocol: 'anthropic_messages',
        result: anthropic.result,
        error: anthropic.classified.error || ''
      };
    }

    // OpenAI protocols
    if (responses && chat) {
      // Both probed - apply priority logic
      if (isOk(responses.classified)) {
        // Responses ok - preferred
        return {
          state: 'ok',
          protocol: 'responses',
          result: responses.result,
          error: '',
          resolvedMode: 'responses'
        };
      }

      if (isOk(chat.classified)) {
        // Chat ok, responses failed
        return {
          state: 'ok',
          protocol: 'chat_completions',
          result: chat.result,
          error: '',
          warning: `responses probe ${responses.classified.state}; chat_completions probe ok`,
          resolvedMode: 'chat_completions'
        };
      }

      // Both failed - report more authoritative error
      const responsesState = responses.classified.state;
      const chatState = chat.classified.state;

      if (isAuthoritativeFailure(chatState)) {
        return {
          state: chatState,
          protocol: 'chat_completions',
          result: chat.result,
          error: chat.classified.error || chat.result.error || ''
        };
      }

      if (isAuthoritativeFailure(responsesState)) {
        return {
          state: responsesState,
          protocol: 'responses',
          result: responses.result,
          error: responses.classified.error || responses.result.error || ''
        };
      }

      // Both inconclusive/other - report both
      return {
        state: chatState || responsesState,
        protocol: 'chat_completions',
        result: chat.result,
        error: `responses: ${responses.classified.error || responsesState}; chat: ${chat.classified.error || chatState}`
      };
    }

    // Only responses probed
    if (responses) {
      return {
        state: responses.classified.state,
        protocol: 'responses',
        result: responses.result,
        error: responses.classified.error || '',
        resolvedMode: isOk(responses.classified) ? 'responses' : undefined
      };
    }

    // Only chat probed
    if (chat) {
      return {
        state: chat.classified.state,
        protocol: 'chat_completions',
        result: chat.result,
        error: chat.classified.error || '',
        resolvedMode: isOk(chat.classified) ? 'chat_completions' : undefined
      };
    }

    // No results (shouldn't happen)
    return {
      state: 'unexpected_status',
      protocol: null,
      result: { statusCode: 0, error: 'no probe results' },
      error: 'no probe results'
    };
  }

  /**
   * High-level method: orchestrate complete upstream probe.
   *
   * Combines planning, execution, and health determination into one call.
   * Returns { health, probeResults, plan } for easy integration.
   *
   * @param {object} upstream - Upstream object
   * @param {object} key - Key object
   * @param {object} config - Config object
   * @param {string[]} models - Available models
   * @param {number} now - Current timestamp
   * @returns {Promise<object>} { health, probeResults, plan }
   */
  async probeUpstream(upstream, key, config, models, now) {
    // Step 1: Plan which protocols to probe
    const plan = this.planProbes(upstream, models, now);

    // Step 2: Execute planned probes
    const probeResults = await this.executeProbes(upstream, key, config, plan, new Date(now).toISOString());

    // Step 3: Determine overall health status
    const health = this.determineHealthStatus(probeResults, models[0]);

    return {
      health,
      probeResults,
      plan
    };
  }
}
