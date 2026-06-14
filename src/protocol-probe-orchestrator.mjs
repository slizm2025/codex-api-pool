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
  constructor(capabilityManager, probeExecutor) {
    this._capabilityManager = capabilityManager;
    this._probeExecutor = probeExecutor;
  }

  /**
   * Plan which protocols to probe based on API Type Declaration and current capability state.
   * Returns a probe plan object with protocol → { model, reason, fallbackToChat? } mappings.
   */
  planProbes(upstream, models, now) {
    const api = upstream?.api || 'openai';
    const requestMode = upstream?.requestMode || upstream?.request_mode || 'auto';
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

    // Select representative models
    const claudeModels = models.filter(isClaudeModel);
    const nonClaudeModels = models.filter(m => !isClaudeModel(m));

    // Anthropic Messages (for api=anthropic or api=both)
    if ((api === 'anthropic' || api === 'both') && claudeModels[0]) {
      plan.anthropic_messages = {
        model: claudeModels[0],
        reason: 'initial'
      };
    }

    // OpenAI protocols (for api=openai or api=both)
    if ((api === 'openai' || api === 'both') && nonClaudeModels[0]) {
      // If request_mode=chat_completions, only probe chat
      if (requestMode === 'chat_completions') {
        plan.chat_completions = {
          model: nonClaudeModels[0],
          reason: 'initial'
        };
      } else {
        // Otherwise, probe responses with chat fallback
        plan.responses = {
          model: nonClaudeModels[0],
          reason: 'initial',
          fallbackToChat: true
        };
      }
    }

    return plan;
  }

  /**
   * Execute planned probes with fallback logic.
   * Returns probe results object with protocol → { result, classified } mappings.
   */
  async executeProbes(upstream, key, config, plan, checkedAt) {
    const results = {};

    // Probe responses (with optional chat fallback)
    if (plan.responses) {
      const respResult = await this._probeExecutor.probeResponses(
        upstream,
        key,
        config,
        plan.responses.model
      );

      // For now, assume ok if statusCode is 200
      const respOk = respResult.statusCode === 200;

      results.responses = {
        result: respResult,
        classified: { state: respOk ? 'ok' : 'server_error' }
      };

      // Fallback to chat_completions if responses failed and fallback enabled
      if (!respOk && plan.responses.fallbackToChat) {
        const chatResult = await this._probeExecutor.probeChatCompletions(
          upstream,
          key,
          config,
          plan.responses.model
        );

        const chatOk = chatResult.statusCode === 200;

        results.chat_completions = {
          result: chatResult,
          classified: { state: chatOk ? 'ok' : 'server_error' }
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

      const chatOk = chatResult.statusCode === 200;

      results.chat_completions = {
        result: chatResult,
        classified: { state: chatOk ? 'ok' : 'server_error' }
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

      const anthropicOk = anthropicResult.statusCode === 200;

      results.anthropic_messages = {
        result: anthropicResult,
        classified: { state: anthropicOk ? 'ok' : 'server_error' }
      };
    }

    return results;
  }
}
