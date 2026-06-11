// PROTOTYPE - throwaway logic for representative model probing.
//
// Question: can an in-memory template captured from real Codex traffic make a
// Management API-triggered probe representative enough to avoid false
// "upstream unavailable" judgements for Codex-context-gated upstreams?

const DEFAULT_TTL_MS = 10 * 60 * 1000;

const TEMPLATE_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'content-type',
  'openai-beta',
  'user-agent',
  'originator',
  'session_id',
  'conversation_id',
  'x-codex-turn-state',
  'x-codex-turn-metadata',
  'x-oai-attestation'
]);

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key'
]);

function lowerHeaderMap(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[String(name).toLowerCase()] = String(value);
  }
  return out;
}

function looksLikeCodexTraffic(headers = {}) {
  const lower = lowerHeaderMap(headers);
  return /codex/i.test(lower.originator || '') || /codex/i.test(lower['user-agent'] || '');
}

function sanitizeHeadersForTemplate(headers = {}) {
  const lower = lowerHeaderMap(headers);
  const out = {};
  for (const [name, value] of Object.entries(lower)) {
    if (SENSITIVE_HEADER_NAMES.has(name)) continue;
    if (!TEMPLATE_HEADER_ALLOWLIST.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function probeInput() {
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Health check: reply with exactly ok.' }]
    }
  ];
}

function sanitizeBodyForTemplate(body = {}) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const template = {};
  for (const field of [
    'instructions',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'store',
    'reasoning',
    'text'
  ]) {
    if (Object.prototype.hasOwnProperty.call(source, field)) template[field] = source[field];
  }
  template.stream = false;
  return template;
}

function representativeBodyFromTemplate(template, model) {
  return {
    ...template.bodyTemplate,
    model,
    input: probeInput(),
    stream: false,
    metadata: {
      ...(template.bodyTemplate.metadata || {}),
      codex_api_pool_probe: 'representative'
    }
  };
}

function syntheticProbeRequest(model) {
  return {
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'codex_cli_rs/0.125.0',
      originator: 'codex_cli_rs',
      'openai-beta': 'responses=experimental'
    },
    body: {
      model,
      input: probeInput(),
      stream: false,
      max_output_tokens: 64,
      tool_choice: 'none',
      metadata: { codex_api_pool_probe: 'synthetic' }
    }
  };
}

function fakeAnyLikeUpstream(request, options = {}) {
  const headers = lowerHeaderMap(request.headers);
  const hasRealCodexContext = headers.originator === 'Codex Desktop' &&
    /^Codex Desktop\//.test(headers['user-agent'] || '') &&
    headers['x-oai-attestation'] === 'attestation-test';
  if (!hasRealCodexContext) {
    return {
      statusCode: 400,
      body: {
        error: {
          message: 'invalid codex request (request id: prototype)',
          type: 'new_api_error',
          code: 'invalid_responses_request'
        }
      }
    };
  }
  return {
    statusCode: 200,
    body: {
      id: 'resp_prototype',
      object: 'response',
      output_text: options.outputText || 'ok',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: options.outputText || 'ok' }] }]
    }
  };
}

function classifyProbeResponse(response, probeKind) {
  if (response.statusCode >= 200 && response.statusCode < 300 && response.body?.output_text) {
    return {
      status: 'verified',
      representative: probeKind === 'representative',
      healthState: 'ok',
      selection: 'selectable',
      reason: ''
    };
  }
  const code = response.body?.error?.code || '';
  const message = response.body?.error?.message || '';
  if (response.statusCode === 400 && code === 'invalid_responses_request' && /invalid codex request/i.test(message)) {
    return {
      status: 'unknown',
      representative: false,
      healthState: 'advanced_curl_required',
      selection: 'selectable_pending_real_codex',
      reason: 'synthetic probe is not representative of real Codex traffic'
    };
  }
  return {
    status: 'failed',
    representative: probeKind === 'representative',
    healthState: 'failed',
    selection: 'not_selectable',
    reason: `HTTP ${response.statusCode}`
  };
}

export function createInitialState(options = {}) {
  return {
    nowMs: 0,
    ttlMs: options.ttlMs || DEFAULT_TTL_MS,
    model: options.model || 'gpt-5.5',
    upstream: {
      name: 'any-like',
      requiresCodexContext: true
    },
    template: null,
    health: {
      state: 'unknown',
      source: '',
      representative: null,
      selection: 'unknown',
      reason: ''
    },
    lastProbe: null,
    events: []
  };
}

function pushEvent(state, event) {
  const events = [{ atMs: state.nowMs, ...event }, ...state.events].slice(0, 8);
  return { ...state, events };
}

export function captureRepresentativeTemplate(state, request) {
  if (request.method !== 'POST' || request.path !== '/v1/responses') {
    return pushEvent(state, { type: 'capture_rejected', reason: 'not a Responses model interaction request' });
  }
  if (!looksLikeCodexTraffic(request.headers)) {
    return pushEvent(state, { type: 'capture_rejected', reason: 'missing Codex request markers' });
  }
  const template = {
    capturedAtMs: state.nowMs,
    expiresAtMs: state.nowMs + state.ttlMs,
    headers: sanitizeHeadersForTemplate(request.headers),
    bodyTemplate: sanitizeBodyForTemplate(request.body)
  };
  return pushEvent({ ...state, template }, {
    type: 'template_captured',
    retainedHeaders: Object.keys(template.headers),
    retainedBodyFields: Object.keys(template.bodyTemplate)
  });
}

export function runSyntheticProbe(state) {
  const request = syntheticProbeRequest(state.model);
  const response = fakeAnyLikeUpstream(request);
  const classified = classifyProbeResponse(response, 'synthetic');
  return pushEvent({
    ...state,
    health: {
      state: classified.healthState,
      source: 'synthetic_probe',
      representative: classified.representative,
      selection: classified.selection,
      reason: classified.reason
    },
    lastProbe: {
      kind: 'synthetic',
      request,
      response,
      classified
    }
  }, { type: 'synthetic_probe', statusCode: response.statusCode, healthState: classified.healthState });
}

export function runRepresentativeProbe(state) {
  if (!state.template) {
    return pushEvent({
      ...state,
      lastProbe: {
        kind: 'representative',
        blocked: true,
        reason: 'no captured representative request template'
      }
    }, { type: 'representative_probe_blocked', reason: 'no template' });
  }
  if (state.template.expiresAtMs <= state.nowMs) {
    return pushEvent({
      ...state,
      template: null,
      lastProbe: {
        kind: 'representative',
        blocked: true,
        reason: 'representative request template expired'
      }
    }, { type: 'representative_probe_blocked', reason: 'template expired' });
  }
  const request = {
    headers: state.template.headers,
    body: representativeBodyFromTemplate(state.template, state.model)
  };
  const response = fakeAnyLikeUpstream(request);
  const classified = classifyProbeResponse(response, 'representative');
  return pushEvent({
    ...state,
    health: {
      state: classified.healthState,
      source: 'representative_probe',
      representative: classified.representative,
      selection: classified.selection,
      reason: classified.reason
    },
    lastProbe: {
      kind: 'representative',
      request,
      response,
      classified
    }
  }, { type: 'representative_probe', statusCode: response.statusCode, healthState: classified.healthState });
}

export function advanceTime(state, ms) {
  return pushEvent({ ...state, nowMs: state.nowMs + ms }, { type: 'time_advanced', ms });
}

export function realCodexRequestFixture() {
  return {
    method: 'POST',
    path: '/v1/responses',
    headers: {
      authorization: 'Bearer pool-secret',
      'content-type': 'application/json',
      'user-agent': 'Codex Desktop/0.138.0-alpha.7',
      originator: 'Codex Desktop',
      'x-oai-attestation': 'attestation-test',
      'x-codex-turn-state': 'state-test',
      'x-codex-turn-metadata': 'metadata-test',
      'openai-beta': 'responses=experimental'
    },
    body: {
      model: 'codex-auto-review',
      input: 'real user content that must not be kept',
      stream: false,
      tools: [
        { type: 'custom', name: 'shell' },
        { type: 'web_search_preview', search_context_size: 'low' }
      ],
      tool_choice: 'none',
      metadata: { real_request_id: 'must-not-matter' }
    }
  };
}

export function displayState(state) {
  const template = state.template ? {
    capturedAtMs: state.template.capturedAtMs,
    expiresAtMs: state.template.expiresAtMs,
    ttlRemainingMs: Math.max(0, state.template.expiresAtMs - state.nowMs),
    headers: Object.fromEntries(Object.entries(state.template.headers).map(([name, value]) => [
      name,
      name === 'x-oai-attestation' ? '[retained in memory, masked for display]' : value
    ])),
    bodyTemplate: state.template.bodyTemplate
  } : null;
  const lastProbe = state.lastProbe ? {
    ...state.lastProbe,
    request: state.lastProbe.request ? {
      headers: Object.fromEntries(Object.entries(state.lastProbe.request.headers || {}).map(([name, value]) => [
        name,
        name === 'x-oai-attestation' ? '[masked]' : value
      ])),
      body: state.lastProbe.request.body
    } : undefined
  } : null;
  return {
    nowMs: state.nowMs,
    model: state.model,
    upstream: state.upstream,
    template,
    health: state.health,
    lastProbe,
    events: state.events
  };
}
