import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.local.json');
const DEFAULT_RETRYABLE_STATUS = [400, 401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524];
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
const MAX_USAGE_CAPTURE_BYTES = 50 * 1024 * 1024;
const DEFAULT_BILLING_LARGE_LIMIT_THRESHOLD = 10_000_000;

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDateKey(timestamp = now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthStartDateKey(timestamp = now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

function maskSecret(value) {
  if (!value) return 'none';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.startsWith('/') ? prefix.replace(/\/$/, '') : `/${prefix.replace(/\/$/, '')}`;
}

function joinTargetUrl(baseUrl, incomingUrl, publicPrefix) {
  const incoming = new URL(incomingUrl, 'http://codex-api-pool.local');
  const prefix = normalizePrefix(publicPrefix);
  let suffix = `${incoming.pathname}${incoming.search}`;
  if (prefix && (incoming.pathname === prefix || incoming.pathname.startsWith(`${prefix}/`))) {
    suffix = `${incoming.pathname.slice(prefix.length) || '/'}${incoming.search}`;
  }
  const base = baseUrl.replace(/\/$/, '');
  if (suffix === '/') return `${base}/`;
  return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function joinUrlPath(baseUrl, pathSuffix) {
  const base = baseUrl.replace(/\/$/, '');
  const suffix = String(pathSuffix || '/').trim() || '/';
  if (/^https?:\/\//i.test(suffix)) return suffix;
  return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function deriveSiteUrl(baseUrl, siteUrl) {
  const candidate = String(siteUrl || '').trim();
  try {
    const parsed = new URL(candidate || baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (candidate) return parsed.href.replace(/\/$/, '');
    return parsed.origin;
  } catch {
    return '';
  }
}

function parseRetryAfterMs(value, fallbackMs) {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(1000, dateMs - now());
  return fallbackMs;
}

function sanitizeRequestHeaders(headers, upstreamKey, targetUrl) {
  const target = new URL(targetUrl);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'host') continue;
    if (lower === 'authorization') continue;
    out[name] = value;
  }
  out.host = target.host;
  if (upstreamKey) out.authorization = `Bearer ${upstreamKey}`;
  return out;
}

function buildAnthropicRequestHeaders(targetUrl, keyValue, incomingHeaders = {}, extraHeaders = {}) {
  const target = new URL(targetUrl);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    host: target.host
  };
  if (keyValue) headers['x-api-key'] = keyValue;
  headers['anthropic-version'] = extraHeaders['anthropic-version']
    || extraHeaders['Anthropic-Version']
    || incomingHeaders['anthropic-version']
    || incomingHeaders['Anthropic-Version']
    || '2023-06-01';
  const beta = extraHeaders['anthropic-beta']
    || extraHeaders['Anthropic-Beta']
    || incomingHeaders['anthropic-beta']
    || incomingHeaders['Anthropic-Beta'];
  if (beta) headers['anthropic-beta'] = beta;
  return headers;
}

function buildProbeHeaders(targetUrl, keyValue, authType = 'bearer', extraHeaders = {}) {
  const target = new URL(targetUrl);
  const headers = { accept: 'application/json', host: target.host };
  const type = String(authType || 'bearer').toLowerCase();
  if (keyValue && type === 'anthropic') {
    headers['x-api-key'] = keyValue;
    headers['anthropic-version'] = extraHeaders['anthropic-version'] || extraHeaders['Anthropic-Version'] || '2023-06-01';
  } else if (keyValue && type !== 'none') {
    headers.authorization = `Bearer ${keyValue}`;
  }
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    if (value !== undefined && value !== null) headers[name] = String(value);
  }
  return headers;
}

function sanitizeResponseHeaders(headers, upstreamName) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    out[name] = value;
  }
  out['x-codex-api-pool-upstream'] = upstreamName;
  return out;
}

function jsonResponse(res, statusCode, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length
  });
  res.end(body);
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(`request body too large: ${total} > ${maxBytes}`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, maxBytes) {
  const body = await readBody(req, maxBytes);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    const err = new Error(`invalid JSON body: ${error.message}`);
    err.statusCode = 400;
    throw err;
  }
}

function rewriteModelInBody(req, body, model) {
  if (!model || body.length === 0) return body;
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) return body;
  try {
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body;
    payload.model = model;
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

function modelFromBody(req, body) {
  if (body.length === 0) return '';
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) return '';
  try {
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
    return typeof payload.model === 'string' ? payload.model : '';
  } catch {
    return '';
  }
}

function isClaudeModel(model) {
  return /^claude(?:-|$)/i.test(String(model || '').trim());
}

function isAnthropicUpstream(upstream) {
  return String(upstream?.probeAuth || '').toLowerCase() === 'anthropic';
}

function shouldUseAnthropicResponsesAdapter(pathname, upstream, model) {
  return pathname === '/v1/responses' && isAnthropicUpstream(upstream) && isClaudeModel(model);
}

function textFromResponsesContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') {
      parts.push(block.text);
    } else if (typeof block.input_text === 'string') {
      parts.push(block.input_text);
    } else if (typeof block.output_text === 'string') {
      parts.push(block.output_text);
    }
  }
  return parts.join('\n');
}

function anthropicTextBlocksFromResponsesContent(content) {
  const text = textFromResponsesContent(content);
  return text ? [{ type: 'text', text }] : [];
}

function mergeAnthropicMessages(messages) {
  const merged = [];
  for (const message of messages) {
    if (!message || !message.content?.length) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  return merged;
}

function responsesInputToAnthropicMessages(input) {
  const messages = [];
  const systemParts = [];

  if (typeof input === 'string') {
    return {
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      system: ''
    };
  }

  if (!Array.isArray(input)) return { messages, system: '' };

  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: [{ type: 'text', text: item }] });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
    const content = anthropicTextBlocksFromResponsesContent(item.content ?? item.text ?? item.message);
    if (role === 'system') {
      const text = content.map((block) => block.text).filter(Boolean).join('\n');
      if (text) systemParts.push(text);
      continue;
    }
    messages.push({ role, content });
  }

  return { messages: mergeAnthropicMessages(messages), system: systemParts.join('\n\n') };
}

function numberOption(value, fallback = undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMaxTokens(value) {
  const number = numberOption(value);
  if (!number || number <= 0) return 4096;
  return Math.max(1, Math.floor(number));
}

function buildAnthropicMessagesPayload(body, model) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8') || '{}');
  } catch (error) {
    const err = new Error(`invalid JSON body: ${error.message}`);
    err.statusCode = 400;
    throw err;
  }

  const { messages, system } = responsesInputToAnthropicMessages(payload.input);
  const finalMessages = messages.length > 0
    ? messages
    : [{ role: 'user', content: [{ type: 'text', text: '' }] }];
  const anthropic = {
    model: model || payload.model,
    max_tokens: normalizeMaxTokens(payload.max_output_tokens ?? payload.max_tokens),
    messages: finalMessages,
    stream: Boolean(payload.stream)
  };

  const systemText = [payload.instructions, system]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n\n');
  if (systemText) anthropic.system = systemText;

  const temperature = numberOption(payload.temperature);
  if (temperature !== undefined) anthropic.temperature = temperature;
  const topP = numberOption(payload.top_p);
  if (topP !== undefined) anthropic.top_p = topP;
  if (Array.isArray(payload.stop)) anthropic.stop_sequences = payload.stop.map(String);
  else if (typeof payload.stop === 'string') anthropic.stop_sequences = [payload.stop];

  return Buffer.from(JSON.stringify(anthropic));
}

function responsesCompletedPayload(model, response = {}) {
  return {
    type: 'response.completed',
    response: {
      id: response.id || `resp_pool_${now().toString(36)}`,
      object: 'response',
      created_at: response.created_at || Math.floor(now() / 1000),
      status: 'completed',
      model: response.model || model || '',
      output: response.output || [],
      usage: response.usage === undefined ? null : response.usage
    }
  };
}

function sseEvent(eventName, payload) {
  const event = eventName ? `event: ${eventName}\n` : '';
  return `${event}data: ${JSON.stringify(payload)}\n\n`;
}

function outputTextDeltaEvent(delta) {
  return sseEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    delta
  });
}

function completedResponsesEvent(model, response = {}) {
  return sseEvent('response.completed', responsesCompletedPayload(model, response));
}

function resolveKey(entry) {
  if (!entry) return { value: '', label: 'no-auth' };
  if (typeof entry === 'string') return { value: entry, label: maskSecret(entry) };
  if (entry.value) return { value: entry.value, label: entry.label || maskSecret(entry.value) };
  if (entry.env) return { value: process.env[entry.env] || '', label: entry.env };
  return { value: '', label: 'empty-key' };
}

function emptyBillingState(state = 'unknown', error = '') {
  return {
    state,
    checkedAt: null,
    latencyMs: 0,
    httpStatus: 0,
    error,
    balanceAmount: null,
    usedAmount: null,
    limitAmount: null,
    limitPlaceholder: false,
    currency: '',
    periodStart: null,
    periodEnd: null,
    source: '',
    keyLabel: null
  };
}

function normalizeBillingConfig(config = {}) {
  const input = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const headers = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)
    ? Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key, String(value)]))
    : {};
  const largeLimitThreshold = Number(input.large_limit_threshold);
  return {
    enabled: input.enabled !== false,
    auth: typeof input.auth === 'string' ? input.auth : 'bearer',
    baseUrl: typeof input.base_url === 'string' ? input.base_url.trim().replace(/\/$/, '') : '',
    subscriptionPath: typeof input.subscription_path === 'string'
      ? input.subscription_path.trim()
      : typeof input.balance_path === 'string'
        ? input.balance_path.trim()
        : '/dashboard/billing/subscription',
    usagePath: typeof input.usage_path === 'string'
      ? input.usage_path.trim()
      : '/dashboard/billing/usage?start_date={start_date}&end_date={end_date}',
    creditsBaseUrl: typeof input.credits_base_url === 'string' ? input.credits_base_url.trim().replace(/\/$/, '') : '',
    creditsPath: typeof input.credits_path === 'string' ? input.credits_path.trim() : '',
    creditsKeyEnv: typeof input.credits_key_env === 'string' ? input.credits_key_env.trim() : '',
    creditsAuth: typeof input.credits_auth === 'string' ? input.credits_auth : '',
    keyEnv: typeof input.key_env === 'string' ? input.key_env.trim() : '',
    keyValue: typeof input.key === 'string' ? input.key : '',
    currency: typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '',
    amountUnit: input.amount_unit,
    balanceAmountUnit: input.balance_amount_unit,
    usedAmountUnit: input.used_amount_unit || input.usage_amount_unit,
    limitAmountUnit: input.limit_amount_unit,
    balanceField: typeof input.balance_field === 'string' ? input.balance_field.trim() : '',
    usedField: typeof input.used_field === 'string' ? input.used_field.trim() : '',
    limitField: typeof input.limit_field === 'string' ? input.limit_field.trim() : '',
    currencyField: typeof input.currency_field === 'string' ? input.currency_field.trim() : '',
    startDate: typeof input.start_date === 'string' ? input.start_date.trim() : '',
    endDate: typeof input.end_date === 'string' ? input.end_date.trim() : '',
    largeLimitThreshold: Number.isFinite(largeLimitThreshold) && largeLimitThreshold > 0
      ? largeLimitThreshold
      : DEFAULT_BILLING_LARGE_LIMIT_THRESHOLD,
    trustLargeLimits: input.trust_large_limits === true,
    headers
  };
}

function createUpstreamState(upstream, index) {
  const keyEntries = Array.isArray(upstream.keys) && upstream.keys.length > 0 ? upstream.keys : [null];
  const keys = keyEntries.map((entry, keyIndex) => {
    const resolved = resolveKey(entry);
    return {
      index: keyIndex,
      label: resolved.label,
      value: resolved.value,
      failures: 0,
      cooldownUntil: 0,
      health: {
        state: resolved.value ? 'unknown' : 'missing_key',
        checkedAt: null,
        latencyMs: 0,
        httpStatus: 0,
        error: ''
      },
      stats: {
        attempts: 0,
        responses: 0,
        successes: 0,
        failures: 0,
        retries: 0,
        lastUsedAt: null
      },
      quota: {}
    };
  });

  return {
    index,
    name: upstream.name || `upstream-${index + 1}`,
    enabled: upstream.enabled !== false,
    baseUrl: upstream.base_url,
    siteUrl: deriveSiteUrl(upstream.base_url, upstream.site_url),
    healthPath: typeof upstream.health_path === 'string' ? upstream.health_path : '',
    probeAuth: typeof upstream.probe_auth === 'string' ? upstream.probe_auth : 'bearer',
    probeHeaders: upstream.probe_headers && typeof upstream.probe_headers === 'object' && !Array.isArray(upstream.probe_headers)
      ? { ...upstream.probe_headers }
      : {},
    billingConfig: normalizeBillingConfig(upstream.billing),
    weight: Math.max(0.1, Number(upstream.weight || 1)),
    keys,
    failures: 0,
    successes: 0,
    inFlight: 0,
    ewmaLatencyMs: 0,
    cooldownUntil: 0,
    lastError: '',
    lastStatus: 0,
    health: {
      state: upstream.enabled === false ? 'disabled' : 'unknown',
      checkedAt: null,
      latencyMs: 0,
      httpStatus: 0,
      error: upstream.enabled === false ? 'upstream disabled' : '',
      models: [],
      modelsCount: null,
      keyLabel: null
    },
    billing: upstream.enabled === false ? emptyBillingState('disabled', 'upstream disabled') : emptyBillingState(),
    stats: {
      attempts: 0,
      responses: 0,
      successes: 0,
      failures: 0,
      retries: 0,
      lastUsedAt: null,
      lastStatus: 0,
      tokenUsage: {
        totalTokens: 0,
        byDay: {}
      }
    },
    quota: {}
  };
}

function buildState(config) {
  const retry = {
    maxAttempts: Number(config.retry?.max_attempts || 3),
    failureThreshold: Number(config.retry?.failure_threshold || 2),
    baseCooldownMs: Number(config.retry?.base_cooldown_ms || 30000),
    keyCooldownMs: Number(config.retry?.key_cooldown_ms || 60000),
    retryableStatus: new Set(
      Array.isArray(config.retry?.retryable_statuses)
        ? config.retry.retryable_statuses.map(Number).filter(Number.isFinite)
        : DEFAULT_RETRYABLE_STATUS
    )
  };

  const upstreams = (config.upstreams || [])
    .map((upstream, index) => createUpstreamState(upstream, index));

  return {
    retry,
    upstreams,
    probing: false,
    billingProbing: false,
    modelOverride: typeof config.model_override === 'string' ? config.model_override : '',
    recentRequests: [],
    statsPersistTimer: null
  };
}


function statsSnapshot(state) {
  return {
    updatedAt: new Date().toISOString(),
    recentRequests: state.recentRequests,
    upstreams: Object.fromEntries(state.upstreams.map((upstream) => [upstream.name, {
      stats: upstream.stats,
      quota: upstream.quota,
      billing: upstream.billing,
      health: {
        state: upstream.health.state,
        checkedAt: upstream.health.checkedAt,
        latencyMs: upstream.health.latencyMs,
        httpStatus: upstream.health.httpStatus,
        error: upstream.health.error,
        models: upstream.health.models || [],
        modelsCount: upstream.health.modelsCount,
        keyLabel: upstream.health.keyLabel
      },
      keys: Object.fromEntries(upstream.keys.map((key) => [key.label, {
        stats: key.stats,
        quota: key.quota,
        health: key.health
      }]))
    }]))
  };
}

function restoreStats(state, statsPath) {
  if (!statsPath || !existsSync(statsPath)) return;
  try {
    const saved = JSON.parse(readFileSync(statsPath, 'utf8'));
    if (Array.isArray(saved.recentRequests)) {
      state.recentRequests = saved.recentRequests.slice(0, 30);
    }
    for (const upstream of state.upstreams) {
      const old = saved.upstreams?.[upstream.name];
      if (!old) continue;
      upstream.stats = { ...upstream.stats, ...(old.stats || {}) };
      ensureTokenUsage(upstream.stats);
      upstream.quota = { ...upstream.quota, ...(old.quota || {}) };
      if (old.billing) upstream.billing = { ...upstream.billing, ...old.billing };
      if (old.health?.models?.length) {
        upstream.health = {
          ...upstream.health,
          ...old.health,
          models: old.health.models,
          modelsCount: old.health.modelsCount ?? old.health.models.length
        };
      }
      for (const key of upstream.keys) {
        const oldKey = old.keys?.[key.label];
        if (!oldKey) continue;
        key.stats = { ...key.stats, ...(oldKey.stats || {}) };
        key.quota = { ...key.quota, ...(oldKey.quota || {}) };
        if (oldKey.health) key.health = { ...key.health, ...oldKey.health };
      }
      if (!upstream.enabled) {
        upstream.cooldownUntil = 0;
        upstream.health = {
          ...upstream.health,
          state: 'disabled',
          error: 'upstream disabled'
        };
        upstream.billing = {
          ...upstream.billing,
          state: 'disabled',
          error: 'upstream disabled'
        };
      }
    }
  } catch (error) {
    console.warn?.(`[stats] failed to restore ${statsPath}: ${error.message}`);
  }
}

function rememberRequest(state, event) {
  state.recentRequests.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    ...event
  });
  state.recentRequests.splice(30);
}

function writeStatsNow(state, statsPath) {
  if (!statsPath) return;
  try {
    writeFileSync(statsPath, `${JSON.stringify(statsSnapshot(state), null, 2)}\n`);
  } catch (error) {
    console.warn?.(`[stats] failed to persist ${statsPath}: ${error.message}`);
  }
}

function persistStats(state, statsPath, options = {}) {
  if (!statsPath) return;
  if (options.immediate) {
    if (state.statsPersistTimer) {
      clearTimeout(state.statsPersistTimer);
      state.statsPersistTimer = null;
    }
    writeStatsNow(state, statsPath);
    return;
  }
  if (state.statsPersistTimer) return;
  state.statsPersistTimer = setTimeout(() => {
    state.statsPersistTimer = null;
    writeStatsNow(state, statsPath);
  }, Number(options.delayMs || 750));
  state.statsPersistTimer.unref?.();
}

function flushStats(state, statsPath) {
  persistStats(state, statsPath, { immediate: true });
}

function copyRuntimeState(target, source, { preserveHealth }) {
  target.failures = source.failures;
  target.successes = source.successes;
  target.ewmaLatencyMs = source.ewmaLatencyMs;
  target.cooldownUntil = source.cooldownUntil;
  target.lastError = source.lastError;
  target.lastStatus = source.lastStatus;
  target.stats = { ...target.stats, ...source.stats };
  ensureTokenUsage(target.stats);
  target.quota = { ...target.quota, ...source.quota };
  target.billing = { ...target.billing, ...source.billing };
  if (preserveHealth) target.health = { ...target.health, ...source.health };
  if (!target.enabled) {
    target.cooldownUntil = 0;
    target.health = {
      ...target.health,
      state: 'disabled',
      error: 'upstream disabled'
    };
    target.billing = {
      ...target.billing,
      state: 'disabled',
      error: 'upstream disabled'
    };
  }

  for (const key of target.keys) {
    const oldKey = source.keys.find((item) => item.label === key.label);
    if (!oldKey) continue;
    key.failures = oldKey.failures;
    key.cooldownUntil = oldKey.cooldownUntil;
    key.stats = { ...key.stats, ...oldKey.stats };
    key.quota = { ...key.quota, ...oldKey.quota };
    if (preserveHealth) key.health = { ...key.health, ...oldKey.health };
  }
}

function rebuildUpstreams(state, config) {
  const oldUpstreams = new Map(state.upstreams.map((upstream) => [upstream.name, upstream]));
  const rebuilt = buildState(config);
  for (const upstream of rebuilt.upstreams) {
    const old = oldUpstreams.get(upstream.name);
    if (!old) continue;
    copyRuntimeState(upstream, old, { preserveHealth: old.baseUrl === upstream.baseUrl });
  }
  state.upstreams.splice(0, state.upstreams.length, ...rebuilt.upstreams);
}

function keyAvailable(keyState, at) {
  return Boolean(keyState.value) && keyState.cooldownUntil <= at;
}

function upstreamAvailable(upstream, at) {
  return upstream.enabled && upstream.baseUrl && upstream.cooldownUntil <= at && upstream.keys.some((key) => keyAvailable(key, at));
}

function upstreamSupportsModel(upstream, model) {
  if (!model) return true;
  const models = upstream.health?.models || [];
  return models.length === 0 || models.includes(model);
}

function chooseCandidate(state, tried, options = {}) {
  const at = now();
  const preferredModel = options.preferredModel || state.modelOverride;
  let candidates = state.upstreams.filter((upstream) => {
    if (!upstreamAvailable(upstream, at)) return false;
    return upstream.keys.some((key) => keyAvailable(key, at) && !tried.has(`${upstream.name}:${key.index}`));
  });

  if (preferredModel) {
    const modelCandidates = candidates.filter((upstream) => upstreamSupportsModel(upstream, preferredModel));
    if (modelCandidates.length > 0 || !options.allowUnknownModelFallback) {
      candidates = modelCandidates;
    }
  }

  if (candidates.length === 0) return null;

  let total = 0;
  const weighted = candidates.map((upstream) => {
    const latencyPenalty = upstream.ewmaLatencyMs > 0 ? Math.min(4, upstream.ewmaLatencyMs / 15000) : 0;
    const healthPenalty = ['server_error', 'network_error', 'timeout', 'rate_limited'].includes(upstream.health.state) ? 2 : 0;
    const score = upstream.weight / (1 + upstream.inFlight + latencyPenalty + healthPenalty + upstream.failures * 0.4);
    total += score;
    return { upstream, score };
  });

  let pick = Math.random() * total;
  let selected = weighted[weighted.length - 1].upstream;
  for (const item of weighted) {
    pick -= item.score;
    if (pick <= 0) {
      selected = item.upstream;
      break;
    }
  }

  const keys = selected.keys
    .filter((key) => keyAvailable(key, at) && !tried.has(`${selected.name}:${key.index}`))
    .sort((a, b) => a.failures - b.failures);

  if (keys.length === 0) return null;
  return { upstream: selected, key: keys[0] };
}


function firstHeader(headers, names) {
  for (const name of names) {
    const value = headers?.[name];
    if (Array.isArray(value)) return value[0];
    if (value !== undefined) return value;
  }
  return undefined;
}

function extractQuota(headers = {}) {
  return {
    requestsRemaining: firstHeader(headers, ['x-ratelimit-remaining-requests', 'x-rate-limit-remaining-requests', 'x-remaining-requests', 'x-quota-remaining-requests', 'x-ratelimit-remaining']),
    tokensRemaining: firstHeader(headers, ['x-ratelimit-remaining-tokens', 'x-rate-limit-remaining-tokens', 'x-remaining-tokens', 'x-quota-remaining-tokens']),
    requestsLimit: firstHeader(headers, ['x-ratelimit-limit-requests', 'x-rate-limit-limit-requests', 'x-quota-limit-requests', 'x-ratelimit-limit']),
    tokensLimit: firstHeader(headers, ['x-ratelimit-limit-tokens', 'x-rate-limit-limit-tokens', 'x-quota-limit-tokens']),
    requestsReset: firstHeader(headers, ['x-ratelimit-reset-requests', 'x-rate-limit-reset-requests', 'x-quota-reset-requests']),
    tokensReset: firstHeader(headers, ['x-ratelimit-reset-tokens', 'x-rate-limit-reset-tokens', 'x-quota-reset-tokens']),
    quotaRemaining: firstHeader(headers, ['x-quota-remaining', 'x-remaining-quota', 'x-api-quota-remaining']),
    retryAfter: firstHeader(headers, ['retry-after'])
  };
}

function cleanQuota(quota) {
  const out = {};
  for (const [key, value] of Object.entries(quota)) {
    if (value !== undefined && value !== null && value !== '') out[key] = String(value);
  }
  return out;
}

function applyQuota(upstream, key, headers) {
  const quota = cleanQuota(extractQuota(headers));
  if (Object.keys(quota).length === 0) return;
  quota.updatedAt = new Date().toISOString();
  upstream.quota = { ...upstream.quota, ...quota };
  key.quota = { ...key.quota, ...quota };
}

function numberFromUnknown(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function extractTokenUsageFromJson(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      const total = extractTokenUsageFromJson(item);
      if (total) return total;
    }
    return 0;
  }
  const usage = value.usage && typeof value.usage === 'object'
    ? value.usage
    : value.usage_metadata && typeof value.usage_metadata === 'object'
      ? value.usage_metadata
      : value.usageMetadata && typeof value.usageMetadata === 'object'
        ? value.usageMetadata
        : value;
  for (const key of ['total_tokens', 'totalTokens', 'total_token_count', 'totalTokenCount']) {
    const total = numberFromUnknown(usage[key]);
    if (total) return total;
  }
  const pairs = [
    ['input_tokens', 'output_tokens'],
    ['inputTokens', 'outputTokens'],
    ['prompt_tokens', 'completion_tokens'],
    ['promptTokens', 'completionTokens'],
    ['promptTokenCount', 'candidatesTokenCount']
  ];
  for (const [inputKey, outputKey] of pairs) {
    const total = numberFromUnknown(usage[inputKey]) + numberFromUnknown(usage[outputKey]);
    if (total) return total;
  }
  for (const key of ['response', 'data', 'result']) {
    const total = extractTokenUsageFromJson(value[key]);
    if (total) return total;
  }
  return 0;
}

function extractTokenUsageFromHeaders(headers = {}) {
  return numberFromUnknown(firstHeader(headers, [
    'x-usage-total-tokens',
    'x-total-tokens',
    'x-openai-total-tokens',
    'x-ratelimit-used-tokens',
    'x-used-tokens'
  ]));
}

function extractTokenUsageFromBody(body) {
  if (!body || body.length === 0) return 0;
  const text = body.toString('utf8');
  try {
    return extractTokenUsageFromJson(JSON.parse(text));
  } catch {
    return extractTokenUsageFromSse(text);
  }
}

function extractTokenUsageFromSse(text) {
  let lastTotal = 0;
  for (const event of String(text).split(/\r?\n\r?\n/)) {
    const payload = event
      .split(/\r?\n/)
      .map((line) => line.trimStart())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const total = extractTokenUsageFromJson(JSON.parse(payload));
      if (total) lastTotal = total;
    } catch {
      // Ignore non-JSON event payloads; upstream response is still forwarded unchanged.
    }
  }
  return lastTotal;
}

function shouldCaptureUsageBody(headers = {}) {
  const contentType = String(firstHeader(headers, ['content-type']) || '').toLowerCase();
  const contentEncoding = String(firstHeader(headers, ['content-encoding']) || '').toLowerCase();
  if (!contentType.includes('json') && !contentType.includes('event-stream')) return false;
  return !contentEncoding || contentEncoding === 'identity';
}

function createUsageCapture(headers = {}) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  const captureBody = shouldCaptureUsageBody(headers);
  return {
    push(chunk) {
      if (!captureBody || tooLarge) return;
      size += chunk.length;
      if (size > MAX_USAGE_CAPTURE_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    },
    tokenCount() {
      if (!captureBody || tooLarge || chunks.length === 0) return extractTokenUsageFromHeaders(headers);
      return extractTokenUsageFromBody(Buffer.concat(chunks, size)) || extractTokenUsageFromHeaders(headers);
    }
  };
}

function isEventStream(headers = {}) {
  return String(firstHeader(headers, ['content-type']) || '').toLowerCase().includes('event-stream');
}

function isUncompressedResponse(headers = {}) {
  const contentEncoding = String(firstHeader(headers, ['content-encoding']) || '').toLowerCase();
  return !contentEncoding || contentEncoding === 'identity';
}

function shouldNormalizeResponsesStream(pathname, headers = {}) {
  return pathname === '/v1/responses' && isEventStream(headers) && isUncompressedResponse(headers);
}

function deleteHeader(headers, headerName) {
  const normalized = String(headerName || '').toLowerCase();
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === normalized) delete headers[name];
  }
}

function findSseBoundary(text) {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf < 0) return crlf < 0 ? null : { index: crlf, length: 4 };
  if (crlf < 0) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function inspectResponsesSseEvent(eventText) {
  const lines = String(eventText).split(/\r?\n/);
  const eventName = lines
    .map((line) => line.trimStart())
    .find((line) => line.startsWith('event:'))
    ?.slice(6)
    .trim();
  const payload = lines
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();

  if (payload === '[DONE]') return { done: true, completed: false, response: null };

  try {
    const parsed = payload ? JSON.parse(payload) : null;
    return {
      done: false,
      completed: eventName === 'response.completed' || parsed?.type === 'response.completed',
      response: parsed?.response && typeof parsed.response === 'object' ? parsed.response : null
    };
  } catch {
    return { done: false, completed: eventName === 'response.completed', response: null };
  }
}

function syntheticResponsesCompletedEvent(model, response) {
  const completedResponse = response && typeof response === 'object'
    ? { ...response, status: 'completed' }
    : {
        id: `resp_pool_${now().toString(36)}`,
        object: 'response',
        created_at: Math.floor(now() / 1000),
        status: 'completed',
        model: model || '',
        output: [],
        usage: null
      };
  return `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`;
}

function createResponsesCompletionNormalizer(res, model) {
  let buffer = '';
  let sawCompleted = false;
  let latestResponse = null;

  function writeCompletionIfMissing() {
    if (sawCompleted) return;
    res.write(syntheticResponsesCompletedEvent(model, latestResponse));
    sawCompleted = true;
  }

  function writeEvent(eventText) {
    const inspected = inspectResponsesSseEvent(eventText);
    if (inspected.response) latestResponse = inspected.response;
    if (inspected.completed) sawCompleted = true;
    if (inspected.done) writeCompletionIfMissing();
    res.write(eventText);
  }

  return {
    write(chunk) {
      buffer += chunk.toString('utf8');
      for (;;) {
        const boundary = findSseBoundary(buffer);
        if (!boundary) break;
        const eventText = buffer.slice(0, boundary.index + boundary.length);
        buffer = buffer.slice(boundary.index + boundary.length);
        writeEvent(eventText);
      }
    },
    end() {
      if (buffer) {
        const inspected = inspectResponsesSseEvent(buffer);
        if (inspected.response) latestResponse = inspected.response;
        if (inspected.completed) sawCompleted = true;
        if (inspected.done) writeCompletionIfMissing();
        res.write(buffer);
        buffer = '';
      }
      writeCompletionIfMissing();
      res.end();
    }
  };
}

function parseSseEvent(eventText) {
  const lines = String(eventText).split(/\r?\n/);
  const eventName = lines
    .map((line) => line.trimStart())
    .find((line) => line.startsWith('event:'))
    ?.slice(6)
    .trim() || '';
  const payload = lines
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  return { eventName, payload };
}

function anthropicUsageToResponsesUsage(usage = {}) {
  const inputTokens = numberFromUnknown(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = numberFromUnknown(usage.output_tokens ?? usage.outputTokens);
  if (!inputTokens && !outputTokens) return null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
}

function createAnthropicResponsesStreamAdapter(res, model) {
  let buffer = '';
  let completed = false;
  let responseId = '';
  let responseModel = model || '';
  let outputText = '';
  let usage = null;

  function mergeUsage(nextUsage) {
    const normalized = anthropicUsageToResponsesUsage(nextUsage);
    if (!normalized) return;
    usage = {
      input_tokens: normalized.input_tokens || usage?.input_tokens || 0,
      output_tokens: normalized.output_tokens || usage?.output_tokens || 0,
      total_tokens: (normalized.input_tokens || usage?.input_tokens || 0) + (normalized.output_tokens || usage?.output_tokens || 0)
    };
  }

  function writeCompleted() {
    if (completed) return;
    completed = true;
    res.write(completedResponsesEvent(model, {
      id: responseId,
      model: responseModel,
      output: outputText
        ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outputText }] }]
        : [],
      usage
    }));
    res.write('data: [DONE]\n\n');
  }

  function handleEvent(eventText) {
    const { payload } = parseSseEvent(eventText);
    if (!payload || payload === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }

    if (event.type === 'message_start' && event.message) {
      responseId = event.message.id || responseId;
      responseModel = event.message.model || responseModel;
      mergeUsage(event.message.usage);
      return;
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const delta = String(event.delta.text || '');
      if (!delta) return;
      outputText += delta;
      res.write(outputTextDeltaEvent(delta));
      return;
    }

    if (event.type === 'message_delta') {
      mergeUsage(event.usage);
      return;
    }

    if (event.type === 'message_stop') {
      writeCompleted();
    }
  }

  return {
    write(chunk) {
      buffer += chunk.toString('utf8');
      for (;;) {
        const boundary = findSseBoundary(buffer);
        if (!boundary) break;
        const eventText = buffer.slice(0, boundary.index + boundary.length);
        buffer = buffer.slice(boundary.index + boundary.length);
        handleEvent(eventText);
      }
    },
    end() {
      if (buffer) {
        handleEvent(buffer);
        buffer = '';
      }
      writeCompleted();
      res.end();
    }
  };
}

function anthropicMessageToResponsesJson(body, model) {
  let message;
  try {
    message = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return body;
  }
  const text = Array.isArray(message.content)
    ? message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
    : '';
  return Buffer.from(JSON.stringify({
    id: message.id || `resp_pool_${now().toString(36)}`,
    object: 'response',
    created_at: Math.floor(now() / 1000),
    status: 'completed',
    model: message.model || model || '',
    output: text
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
      : [],
    output_text: text,
    usage: anthropicUsageToResponsesUsage(message.usage)
  }));
}

function ensureTokenUsage(stats) {
  if (!stats.tokenUsage || typeof stats.tokenUsage !== 'object') {
    stats.tokenUsage = { totalTokens: 0, byDay: {} };
  }
  stats.tokenUsage.totalTokens = numberFromUnknown(stats.tokenUsage.totalTokens);
  if (!stats.tokenUsage.byDay || typeof stats.tokenUsage.byDay !== 'object' || Array.isArray(stats.tokenUsage.byDay)) {
    stats.tokenUsage.byDay = {};
  }
  return stats.tokenUsage;
}

function recordTokenUsage(upstream, tokenCount, timestamp = now()) {
  const tokens = numberFromUnknown(tokenCount);
  if (!tokens) return 0;
  const usage = ensureTokenUsage(upstream.stats);
  const day = localDateKey(timestamp);
  usage.totalTokens += tokens;
  usage.byDay[day] = numberFromUnknown(usage.byDay[day]) + tokens;
  return tokens;
}

function usagePayload(stats, today = localDateKey()) {
  const usage = ensureTokenUsage(stats);
  return {
    total_tokens: usage.totalTokens,
    today_tokens: numberFromUnknown(usage.byDay[today]),
    by_day: { ...usage.byDay }
  };
}

function aggregateUsage(upstreams, today = localDateKey()) {
  const byDay = {};
  let totalTokens = 0;
  for (const upstream of upstreams) {
    const usage = ensureTokenUsage(upstream.stats);
    totalTokens += usage.totalTokens;
    for (const [day, value] of Object.entries(usage.byDay)) {
      byDay[day] = numberFromUnknown(byDay[day]) + numberFromUnknown(value);
    }
  }
  return {
    total_tokens: totalTokens,
    today_tokens: numberFromUnknown(byDay[today]),
    by_day: byDay
  };
}

function normalizeMoneyKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function numberFromMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) return null;
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function moneyUnitDivisor(unit, fieldName = '') {
  if (typeof unit === 'number' && Number.isFinite(unit) && unit > 0) return unit;
  const normalized = String(unit || 'auto').toLowerCase();
  if (normalized === 'cent' || normalized === 'cents') return 100;
  if (normalized === 'usd' || normalized === 'dollar' || normalized === 'dollars' || normalized === 'cny' || normalized === 'yuan') return 1;
  return normalizeMoneyKey(fieldName) === 'totalusage' ? 100 : 1;
}

function normalizeBillingAmount(value, unit, fieldName = '') {
  const number = numberFromMoney(value);
  if (number === null) return null;
  return roundMoney(number / moneyUnitDivisor(unit, fieldName));
}

function billingLargeLimitThreshold(billingConfig = {}) {
  const threshold = Number(billingConfig.largeLimitThreshold);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_BILLING_LARGE_LIMIT_THRESHOLD;
}

function isBillingPlaceholderLimit(amount, billingConfig = {}, fieldName = '') {
  if (billingConfig.trustLargeLimits || billingConfig.limitField) return false;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return false;
  if (amount < billingLargeLimitThreshold(billingConfig)) return false;
  const normalized = normalizeMoneyKey(fieldName);
  return !normalized || /hardlimit|systemhardlimit|limit|granted/.test(normalized);
}

function sanitizeBillingAmounts(balanceAmount, usedAmount, limitAmount, billingConfig = {}, limitPlaceholder = false) {
  if (limitPlaceholder) return { balanceAmount, usedAmount, limitAmount, limitPlaceholder: true };
  if (!isBillingPlaceholderLimit(limitAmount, billingConfig, 'limit')) {
    return { balanceAmount, usedAmount, limitAmount, limitPlaceholder: false };
  }

  const sanitized = { balanceAmount, usedAmount, limitAmount: null, limitPlaceholder: true };
  const derivedFromPlaceholder = typeof balanceAmount === 'number' && (
    Math.abs(balanceAmount - limitAmount) <= 0.01 ||
    balanceAmount >= billingLargeLimitThreshold(billingConfig) ||
    (typeof usedAmount === 'number' && Math.abs(roundMoney(balanceAmount + usedAmount) - limitAmount) <= 0.01)
  );
  if (derivedFromPlaceholder) sanitized.balanceAmount = null;
  return sanitized;
}

function valueAtPath(value, pathSpec) {
  if (!pathSpec) return undefined;
  let current = value;
  for (const part of String(pathSpec).split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function findBillingScalar(value, wantedKeys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  const wanted = new Set(wantedKeys.map(normalizeMoneyKey));
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) {
      const match = findBillingScalar(item, wantedKeys, depth + 1);
      if (match) return match;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!wanted.has(normalizeMoneyKey(key))) continue;
    const number = numberFromMoney(entry);
    if (number !== null) return { key, value: entry };
  }
  for (const entry of Object.values(value)) {
    const match = findBillingScalar(entry, wantedKeys, depth + 1);
    if (match) return match;
  }
  return null;
}

function findStringScalar(value, wantedKeys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return '';
  const wanted = new Set(wantedKeys.map(normalizeMoneyKey));
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) {
      const match = findStringScalar(item, wantedKeys, depth + 1);
      if (match) return match;
    }
    return '';
  }
  for (const [key, entry] of Object.entries(value)) {
    if (wanted.has(normalizeMoneyKey(key)) && typeof entry === 'string' && entry.trim()) return entry.trim();
  }
  for (const entry of Object.values(value)) {
    const match = findStringScalar(entry, wantedKeys, depth + 1);
    if (match) return match;
  }
  return '';
}

function configuredBillingAmount(json, field, unit) {
  if (!field) return { amount: null, key: '' };
  const value = valueAtPath(json, field);
  return { amount: normalizeBillingAmount(value, unit, field), key: field };
}

function inferredBillingAmount(json, keys, unit) {
  const match = findBillingScalar(json, keys);
  if (!match) return { amount: null, key: '' };
  return { amount: normalizeBillingAmount(match.value, unit, match.key), key: match.key };
}

function extractBillingCurrency(json, billingConfig, usedKeys) {
  if (billingConfig.currency) return billingConfig.currency;
  if (billingConfig.currencyField) {
    const value = valueAtPath(json, billingConfig.currencyField);
    if (typeof value === 'string' && value.trim()) return value.trim().toUpperCase();
  }
  const found = findStringScalar(json, ['currency', 'currency_code', 'currencyCode', 'unit']);
  if (found) return found.toUpperCase();
  if (usedKeys.some((key) => /usd/i.test(key))) return 'USD';
  if (usedKeys.some((key) => /cny|yuan|rmb/i.test(key))) return 'CNY';
  return billingConfig.currency || 'USD';
}

function parseBillingBody(body, billingConfig, source) {
  let json;
  try {
    json = JSON.parse(body || '{}');
  } catch {
    return { error: 'billing response is not JSON', source };
  }

  const balance = configuredBillingAmount(json, billingConfig.balanceField, billingConfig.balanceAmountUnit || billingConfig.amountUnit);
  const used = configuredBillingAmount(json, billingConfig.usedField, billingConfig.usedAmountUnit || billingConfig.amountUnit);
  const limit = configuredBillingAmount(json, billingConfig.limitField, billingConfig.limitAmountUnit || billingConfig.amountUnit);

  const inferredBalance = balance.amount === null
    ? inferredBillingAmount(json, [
      'balance',
      'balance_usd',
      'remaining_balance',
      'available_balance',
      'remaining_amount',
      'available_amount',
      'credit',
      'credits',
      'remaining_credit'
    ], billingConfig.balanceAmountUnit || billingConfig.amountUnit)
    : balance;
  const inferredUsed = used.amount === null
    ? inferredBillingAmount(json, [
      'used',
      'used_amount',
      'used_usd',
      'spent',
      'spent_amount',
      'total_spent',
      'consumed',
      'consumed_amount',
      'cost',
      'total_cost',
      'usage_amount',
      'usage_usd',
      'total_usage'
    ], billingConfig.usedAmountUnit || billingConfig.amountUnit)
    : used;
  const inferredLimit = limit.amount === null
    ? inferredBillingAmount(json, [
      'hard_limit_usd',
      'soft_limit_usd',
      'system_hard_limit_usd',
      'limit',
      'limit_usd',
      'credit_limit',
      'granted_amount',
      'total_granted'
    ], billingConfig.limitAmountUnit || billingConfig.amountUnit)
    : limit;
  const limitPlaceholder = limit.amount === null && isBillingPlaceholderLimit(inferredLimit.amount, billingConfig, inferredLimit.key);
  const finalLimit = limitPlaceholder
    ? { amount: null, key: '' }
    : inferredLimit;

  const usedKeys = [inferredBalance.key, inferredUsed.key, finalLimit.key].filter(Boolean);
  return {
    balanceAmount: inferredBalance.amount,
    usedAmount: inferredUsed.amount,
    limitAmount: finalLimit.amount,
    limitPlaceholder,
    currency: extractBillingCurrency(json, billingConfig, usedKeys),
    source,
    fields: usedKeys
  };
}

function mergeBillingParts(parts, billingConfig, periodStart, periodEnd) {
  const merged = {
    balanceAmount: null,
    usedAmount: null,
    limitAmount: null,
    limitPlaceholder: false,
    currency: billingConfig.currency || '',
    periodStart,
    periodEnd,
    source: ''
  };
  const sources = [];
  for (const part of parts) {
    if (!part || part.error) continue;
    if (merged.balanceAmount === null && part.balanceAmount !== null) merged.balanceAmount = part.balanceAmount;
    if (merged.usedAmount === null && part.usedAmount !== null) merged.usedAmount = part.usedAmount;
    if (merged.limitAmount === null && part.limitAmount !== null) merged.limitAmount = part.limitAmount;
    if (part.limitPlaceholder) merged.limitPlaceholder = true;
    if (!merged.currency && part.currency) merged.currency = part.currency;
    if (part.source) sources.push(part.source);
  }
  if (merged.balanceAmount === null && merged.limitAmount !== null && merged.usedAmount !== null) {
    merged.balanceAmount = roundMoney(merged.limitAmount - merged.usedAmount);
  }
  merged.currency = (merged.currency || 'USD').toUpperCase();
  merged.source = [...new Set(sources)].join('+');
  return merged;
}

function billingPayload(billing = emptyBillingState(), billingConfig = {}) {
  const amounts = sanitizeBillingAmounts(billing.balanceAmount, billing.usedAmount, billing.limitAmount, billingConfig, billing.limitPlaceholder);
  return {
    state: billing.state,
    checked_at: billing.checkedAt,
    latency_ms: billing.latencyMs,
    http_status: billing.httpStatus,
    error: billing.error,
    balance_amount: amounts.balanceAmount,
    used_amount: amounts.usedAmount,
    limit_amount: amounts.limitAmount,
    limit_placeholder: amounts.limitPlaceholder,
    currency: billing.currency,
    period_start: billing.periodStart,
    period_end: billing.periodEnd,
    source: billing.source,
    key_label: billing.keyLabel
  };
}

function addBillingAmount(bucket, key, amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return;
  bucket[key] = roundMoney((bucket[key] || 0) + amount);
}

function aggregateBilling(upstreams) {
  const byCurrency = {};
  for (const upstream of upstreams) {
    const billing = upstream.billing || {};
    if (billing.state !== 'ok') continue;
    const amounts = sanitizeBillingAmounts(billing.balanceAmount, billing.usedAmount, billing.limitAmount, upstream.billingConfig, billing.limitPlaceholder);
    const currency = (billing.currency || 'USD').toUpperCase();
    if (!byCurrency[currency]) {
      byCurrency[currency] = {
        balance_amount: null,
        used_amount: null,
        limit_amount: null,
        sites: 0
      };
    }
    const bucket = byCurrency[currency];
    addBillingAmount(bucket, 'balance_amount', amounts.balanceAmount);
    addBillingAmount(bucket, 'used_amount', amounts.usedAmount);
    addBillingAmount(bucket, 'limit_amount', amounts.limitAmount);
    bucket.sites += 1;
  }
  const currencies = Object.keys(byCurrency).sort();
  const single = currencies.length === 1 ? byCurrency[currencies[0]] : {};
  return {
    currency: currencies.length === 1 ? currencies[0] : '',
    balance_amount: currencies.length === 1 ? single.balance_amount : null,
    used_amount: currencies.length === 1 ? single.used_amount : null,
    limit_amount: currencies.length === 1 ? single.limit_amount : null,
    by_currency: byCurrency
  };
}

function recordAttempt(upstream, key) {
  const at = new Date().toISOString();
  upstream.stats.attempts += 1;
  upstream.stats.lastUsedAt = at;
  key.stats.attempts += 1;
  key.stats.lastUsedAt = at;
}

function recordResponseStats(upstream, key, statusCode, retried = false) {
  upstream.stats.responses += 1;
  upstream.stats.lastStatus = statusCode || 0;
  key.stats.responses += 1;
  if (retried) {
    upstream.stats.retries += 1;
    key.stats.retries += 1;
  }
  if (statusCode >= 200 && statusCode < 400) {
    upstream.stats.successes += 1;
    key.stats.successes += 1;
  } else {
    upstream.stats.failures += 1;
    key.stats.failures += 1;
  }
}

function recordSuccess(upstream, startedAt, statusCode = 200) {
  const elapsed = now() - startedAt;
  upstream.successes += 1;
  upstream.failures = 0;
  upstream.lastError = '';
  upstream.lastStatus = statusCode;
  upstream.ewmaLatencyMs = upstream.ewmaLatencyMs === 0 ? elapsed : Math.round(upstream.ewmaLatencyMs * 0.75 + elapsed * 0.25);
}

function recordFailure(state, upstream, key, reason, statusCode, retryAfter) {
  upstream.failures += 1;
  upstream.lastError = reason;
  upstream.lastStatus = statusCode || 0;
  key.failures += 1;

  const cooldownBase = statusCode === 429 ? state.retry.keyCooldownMs : state.retry.baseCooldownMs;
  const cooldownMs = parseRetryAfterMs(retryAfter, cooldownBase);

  if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
    key.cooldownUntil = now() + cooldownMs;
  }

  if (upstream.failures >= state.retry.failureThreshold || statusCode === 429) {
    upstream.cooldownUntil = now() + cooldownMs;
  }
}

function finishResponseAttempt({ state, upstream, key, method, pathname, originalModel, attemptedModel, statusCode, startedAt, attempt, reason = '', retryAfter, tokenCount = 0, statsPath }) {
  const recordedTokens = statusCode >= 200 && statusCode < 400 ? recordTokenUsage(upstream, tokenCount, startedAt) : 0;
  if (statusCode >= 200 && statusCode < 400) {
    recordSuccess(upstream, startedAt, statusCode);
  } else {
    recordFailure(state, upstream, key, reason || `HTTP ${statusCode}`, statusCode, retryAfter);
  }
  rememberRequest(state, {
    method,
    path: pathname,
    upstream: upstream.name,
    key: key.label,
    originalModel: originalModel || null,
    actualModel: attemptedModel || null,
    status: statusCode,
    durationMs: now() - startedAt,
    retried: attempt > 1,
    outcome: statusCode >= 200 && statusCode < 400 ? 'ok' : 'error',
    reason: statusCode >= 400 ? reason || `HTTP ${statusCode}` : '',
    tokens: recordedTokens
  });
  persistStats(state, statsPath);
}

function classifyHealth(statusCode, error) {
  if (error) {
    if (/timeout/i.test(error)) return 'timeout';
    return 'network_error';
  }
  if (statusCode >= 200 && statusCode < 300) return 'ok';
  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 404) return 'models_unsupported';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 500) return 'server_error';
  return 'unexpected_status';
}

function requestUpstream({ req, body, targetUrl, upstream, key, timeoutMs, allowRetry, retryableStatus, method, headers }) {
  return new Promise((resolve) => {
    const target = new URL(targetUrl);
    const client = target.protocol === 'https:' ? https : http;
    const startedAt = now();
    let settled = false;

    const requestHeaders = headers || sanitizeRequestHeaders(req.headers, key.value, targetUrl);
    requestHeaders['content-length'] = body.length;

    const upstreamReq = client.request(
      target,
      {
        method: method || req.method,
        headers: requestHeaders,
        timeout: timeoutMs
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 502;
        const retryAfter = upstreamRes.headers['retry-after'];

        if (allowRetry && retryableStatus.has(statusCode)) {
          upstreamRes.resume();
          upstreamRes.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({ type: 'retry', statusCode, retryAfter, headers: upstreamRes.headers, reason: `HTTP ${statusCode}`, startedAt });
          });
          upstreamRes.on('error', (error) => {
            if (settled) return;
            settled = true;
            resolve({ type: 'retry', statusCode, retryAfter, headers: upstreamRes.headers, reason: error.message, startedAt });
          });
          return;
        }

        settled = true;
        resolve({ type: 'response', response: upstreamRes, statusCode, startedAt });
      }
    );

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });

    upstreamReq.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ type: 'retry', statusCode: 0, headers: {}, reason: error.message, startedAt });
    });

    upstreamReq.end(body);
  });
}

function probeHttp(targetUrl, keyValue, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const target = new URL(targetUrl);
    const client = target.protocol === 'https:' ? https : http;
    const startedAt = now();
    let settled = false;
    let body = '';

    const headers = buildProbeHeaders(targetUrl, keyValue, options.authType, options.headers);

    const probeReq = client.request(target, { method: 'GET', headers, timeout: timeoutMs }, (probeRes) => {
      probeRes.setEncoding('utf8');
      probeRes.on('data', (chunk) => {
        if (body.length < 1024 * 1024) body += chunk;
      });
      probeRes.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: probeRes.statusCode || 0,
          latencyMs: now() - startedAt,
          body,
          error: '',
          retryAfter: probeRes.headers['retry-after'],
          headers: probeRes.headers
        });
      });
    });

    probeReq.on('timeout', () => {
      probeReq.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });

    probeReq.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode: 0, latencyMs: now() - startedAt, body: '', error: error.message, retryAfter: undefined, headers: {} });
    });

    probeReq.end();
  });
}

function fillBillingPath(pathTemplate, startDate, endDate) {
  return String(pathTemplate || '')
    .replaceAll('{start_date}', encodeURIComponent(startDate))
    .replaceAll('{end_date}', encodeURIComponent(endDate));
}

function billingBaseUrls(upstream) {
  if (upstream.billingConfig.baseUrl) return [upstream.billingConfig.baseUrl];
  const urls = [];
  try {
    urls.push(new URL(upstream.baseUrl).origin);
  } catch {
    // Fall through to the configured base URL below.
  }
  urls.push(upstream.baseUrl);
  return [...new Set(urls.map((url) => String(url || '').replace(/\/$/, '')).filter(Boolean))];
}

function billingTargetUrls(upstream, pathTemplate, startDate, endDate) {
  const path = fillBillingPath(pathTemplate, startDate, endDate);
  return [...new Set(billingBaseUrls(upstream).map((baseUrl) => joinUrlPath(baseUrl, path)))];
}

function billingTargetUrlsWithBase(upstream, baseUrl, pathTemplate, startDate, endDate) {
  if (!baseUrl) return billingTargetUrls(upstream, pathTemplate, startDate, endDate);
  const path = fillBillingPath(pathTemplate, startDate, endDate);
  return [joinUrlPath(String(baseUrl).replace(/\/$/, ''), path)];
}

function billingConfiguredKey(billingConfig, fallbackKey) {
  if (billingConfig.keyValue) return { value: billingConfig.keyValue, label: 'billing.key' };
  if (billingConfig.keyEnv) return { value: process.env[billingConfig.keyEnv] || '', label: billingConfig.keyEnv };
  return fallbackKey;
}

function billingRequestKey(request, billingConfig, fallbackKey) {
  if (request.source === 'credits' && billingConfig.creditsKeyEnv) {
    const value = process.env[billingConfig.creditsKeyEnv] || '';
    if (value) return { value, label: billingConfig.creditsKeyEnv };
  }
  return billingConfiguredKey(billingConfig, fallbackKey);
}

function billingHttpState(statusCode, error) {
  if (error) return /timeout/i.test(error) ? 'timeout' : 'network_error';
  if (statusCode >= 200 && statusCode < 300) return 'ok';
  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 404) return 'unsupported';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 500) return 'server_error';
  return 'unexpected_status';
}

function billingBlockedByHtml(result = {}) {
  const contentType = String(firstHeader(result.headers, ['content-type']) || '').toLowerCase();
  const body = String(result.body || '').slice(0, 12000);
  return result.statusCode === 403 && (
    contentType.includes('text/html') ||
    /cloudflare|cf-ray|cdn-cgi|challenge-platform|just a moment|attention required/i.test(body)
  );
}

async function probeOneBilling(upstream, config) {
  const billingConfig = upstream.billingConfig || normalizeBillingConfig();
  const checkedAt = new Date().toISOString();
  const upstreamKey = upstream.keys.find((item) => Boolean(item.value)) || upstream.keys[0];
  const key = billingConfiguredKey(billingConfig, upstreamKey);

  if (!upstream.enabled) {
    upstream.billing = { ...upstream.billing, state: 'disabled', checkedAt, latencyMs: 0, httpStatus: 0, error: 'upstream disabled', keyLabel: null };
    return upstream.billing;
  }

  if (!billingConfig.enabled) {
    upstream.billing = { ...upstream.billing, state: 'disabled', checkedAt, latencyMs: 0, httpStatus: 0, error: 'billing probe disabled', keyLabel: null };
    return upstream.billing;
  }

  if (!key || !key.value) {
    upstream.billing = { ...emptyBillingState('missing_key', 'no configured key'), checkedAt, keyLabel: key?.label || null };
    return upstream.billing;
  }

  const at = now();
  const startDate = billingConfig.startDate || monthStartDateKey(at);
  const endDate = billingConfig.endDate || localDateKey(at);
  const timeoutMs = Number(config.billing?.timeout_ms || config.health?.timeout_ms || 10000);
  const requests = [];
  if (billingConfig.creditsPath) {
    for (const url of billingTargetUrlsWithBase(upstream, billingConfig.creditsBaseUrl, billingConfig.creditsPath, startDate, endDate)) {
      requests.push({ source: 'credits', url });
    }
  }
  if (billingConfig.subscriptionPath) {
    for (const url of billingTargetUrls(upstream, billingConfig.subscriptionPath, startDate, endDate)) {
      requests.push({ source: 'subscription', url });
    }
  }
  if (billingConfig.usagePath) {
    for (const url of billingTargetUrls(upstream, billingConfig.usagePath, startDate, endDate)) {
      requests.push({ source: 'usage', url });
    }
  }

  if (requests.length === 0) {
    upstream.billing = { ...emptyBillingState('unsupported', 'no billing paths configured'), checkedAt, keyLabel: key.label };
    return upstream.billing;
  }

  const startedAt = now();
  const results = [];
  const completedSources = new Set();
  for (const request of requests) {
    if (completedSources.has(request.source)) continue;
    const requestKey = billingRequestKey(request, billingConfig, key);
    if (!requestKey?.value) {
      results.push({
        request,
        result: { statusCode: 0, latencyMs: 0, body: '', error: `missing key ${requestKey?.label || 'billing key'}`, retryAfter: undefined, headers: {} }
      });
      continue;
    }
    const result = await probeHttp(request.url, requestKey.value, timeoutMs, {
      authType: request.source === 'credits'
        ? billingConfig.creditsAuth || billingConfig.auth || upstream.probeAuth
        : billingConfig.auth || upstream.probeAuth,
      headers: billingConfig.headers
    });
    results.push({ request, result });
    if (result.statusCode >= 200 && result.statusCode < 300) {
      completedSources.add(request.source);
    }
  }

  const okResults = results.filter((item) => item.result.statusCode >= 200 && item.result.statusCode < 300);
  const parts = okResults.map((item) => parseBillingBody(item.result.body, billingConfig, item.request.source));
  const billing = mergeBillingParts(parts, billingConfig, startDate, endDate);
  const firstFailure = results.find((item) => item.result.error || item.result.statusCode >= 400);
  const creditsFailure = results.find((item) => item.request.source === 'credits' && (item.result.error || item.result.statusCode >= 400));
  const firstResult = okResults[0]?.result || firstFailure?.result || results[0]?.result;
  const hasAnyAmount = [billing.balanceAmount, billing.usedAmount, billing.limitAmount].some((value) => value !== null);
  const parseError = parts.find((part) => part?.error)?.error || '';
  const blockedByHtml = !hasAnyAmount && okResults.length === 0 && billingBlockedByHtml(firstResult);
  const creditsError = billingConfig.creditsPath && billing.balanceAmount === null && creditsFailure
    ? `credits endpoint failed: ${creditsFailure.result.error || `HTTP ${creditsFailure.result.statusCode || 0}`}`
    : '';
  const stateName = hasAnyAmount
    ? 'ok'
    : okResults.length > 0
      ? 'no_amount'
      : blockedByHtml
        ? 'blocked'
        : billingHttpState(firstResult?.statusCode || 0, firstResult?.error || '');

  upstream.billing = {
    ...upstream.billing,
    state: stateName,
    checkedAt,
    latencyMs: now() - startedAt,
    httpStatus: firstResult?.statusCode || 0,
    error: hasAnyAmount
      ? creditsError
      : blockedByHtml
        ? 'billing endpoint returned a browser/Cloudflare challenge instead of API JSON'
        : parseError || firstResult?.error || (okResults.length > 0 ? 'billing amount fields not found' : `HTTP ${firstResult?.statusCode || 0}`),
    balanceAmount: billing.balanceAmount,
    usedAmount: billing.usedAmount,
    limitAmount: billing.limitAmount,
    limitPlaceholder: billing.limitPlaceholder,
    currency: billing.currency,
    periodStart: billing.periodStart,
    periodEnd: billing.periodEnd,
    source: billing.source,
    keyLabel: key.label
  };
  return upstream.billing;
}

function extractModels(body) {
  try {
    const json = JSON.parse(body);
    const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return [...new Set(list
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.id || item.name || item.model || '';
        return '';
      })
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  return [];
}

async function probeOneUpstream(state, upstream, config, options = {}) {
  const healthConfig = config.health || {};
  const publicPrefix = normalizePrefix(config.server?.public_prefix || '/v1');
  const pathSuffix = upstream.healthPath || healthConfig.path || '/models';
  const timeoutMs = Number(healthConfig.timeout_ms || 10000);
  const key = upstream.keys.find((item) => Boolean(item.value)) || upstream.keys[0];
  const checkedAt = new Date().toISOString();

  if (!upstream.enabled) {
    upstream.health = { ...upstream.health, state: 'disabled', checkedAt, latencyMs: 0, httpStatus: 0, error: 'upstream disabled', models: upstream.health?.models || [], modelsCount: upstream.health?.modelsCount ?? 0, keyLabel: null };
    return upstream.health;
  }

  if (!key || !key.value) {
    upstream.health = { state: 'missing_key', checkedAt, latencyMs: 0, httpStatus: 0, error: 'no configured key', models: [], modelsCount: 0, keyLabel: key?.label || null };
    return upstream.health;
  }

  const targetUrl = upstream.healthPath
    ? joinUrlPath(upstream.baseUrl, pathSuffix)
    : joinTargetUrl(upstream.baseUrl, `${publicPrefix}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`, publicPrefix);
  const result = await probeHttp(targetUrl, key.value, timeoutMs, {
    authType: upstream.probeAuth,
    headers: upstream.probeHeaders
  });
  const stateName = classifyHealth(result.statusCode, result.error);
  const models = extractModels(result.body);
  applyQuota(upstream, key, result.headers || {});
  if (options.includeBilling) await probeOneBilling(upstream, config);

  upstream.health = {
    state: stateName,
    checkedAt,
    latencyMs: result.latencyMs,
    httpStatus: result.statusCode,
    error: result.error,
    models,
    modelsCount: models.length,
    keyLabel: key.label
  };

  key.health = {
    state: stateName,
    checkedAt,
    latencyMs: result.latencyMs,
    httpStatus: result.statusCode,
    error: result.error
  };

  if (stateName === 'ok' || stateName === 'models_unsupported' || stateName === 'unexpected_status') {
    upstream.lastError = '';
    upstream.lastStatus = result.statusCode;
    if (stateName === 'ok') upstream.cooldownUntil = 0;
    return upstream.health;
  }

  if (stateName === 'auth_error' || stateName === 'rate_limited' || stateName === 'server_error' || stateName === 'network_error' || stateName === 'timeout') {
    recordFailure(state, upstream, key, result.error || `health ${stateName}`, result.statusCode, result.retryAfter);
  }

  return upstream.health;
}

async function mapWithConcurrency(items, limit, fn) {
  const queue = [...items];
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, queue.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function runHealthChecks(state, config, logger = console) {
  if (state.probing) return;
  state.probing = true;
  try {
    const concurrency = Math.max(1, Number(config.health?.concurrency || 4));
    await mapWithConcurrency(state.upstreams.filter((upstream) => upstream.enabled), concurrency, (upstream) => probeOneUpstream(state, upstream, config));
  } catch (error) {
    logger.warn?.(`[health] ${error.message}`);
  } finally {
    state.probing = false;
  }
}

async function runBillingChecks(state, config, logger = console) {
  if (state.billingProbing) return;
  state.billingProbing = true;
  try {
    const concurrency = Math.max(1, Number(config.billing?.concurrency || 3));
    const upstreams = state.upstreams.filter((upstream) => upstream.enabled && upstream.billingConfig?.enabled !== false);
    await mapWithConcurrency(upstreams, concurrency, (upstream) => probeOneBilling(upstream, config));
  } catch (error) {
    logger.warn?.(`[billing] ${error.message}`);
  } finally {
    state.billingProbing = false;
  }
}

function startHealthLoop(state, config, logger = console) {
  const healthConfig = config.health || {};
  if (healthConfig.enabled === false) return null;
  const intervalMs = Number(healthConfig.interval_ms || 60000);
  setTimeout(() => runHealthChecks(state, config, logger), 500).unref?.();
  const timer = setInterval(() => runHealthChecks(state, config, logger), intervalMs);
  timer.unref?.();
  return timer;
}

function scheduleStartupProbe(state, config, statsPath, logger = console) {
  if (config.health?.enabled !== false) return;
  setTimeout(async () => {
    await runHealthChecks(state, config, logger);
    persistStats(state, statsPath);
  }, 500).unref?.();
}


function dashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex API Pool Radar</title>
  <style>
    :root {
      --ink: #17211d;
      --muted: #63706b;
      --paper: #eef2f1;
      --panel: rgba(252, 253, 251, 0.9);
      --line: rgba(23, 33, 29, 0.14);
      --line-strong: rgba(23, 33, 29, 0.28);
      --good: #12805c;
      --warn: #a66a05;
      --bad: #b33a33;
      --cold: #38627b;
      --accent: #244f45;
      --glow: rgba(18, 128, 92, 0.14);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Optima, Candara, "Avenir Next", Verdana, sans-serif;
      background:
        linear-gradient(rgba(23,33,29,.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(23,33,29,.035) 1px, transparent 1px),
        linear-gradient(135deg, #eef2f1 0%, #f8faf7 46%, #e2e9e7 100%);
      background-size: 32px 32px, 32px 32px, auto;
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(180deg, rgba(255,255,255,.64), rgba(255,255,255,0));
    }
    .shell { position: relative; width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: end; margin-bottom: 20px; }
    h1 { font-family: Didot, Bodoni 72, Georgia, serif; font-size: clamp(38px, 5.6vw, 72px); line-height: .92; margin: 0; letter-spacing: 0; }
    .lede { color: var(--muted); font-size: 14px; line-height: 1.6; max-width: 620px; }
    .toolbar { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    button, input, select { font: inherit; }
    a { color: inherit; }
    button {
      min-height: 38px;
      border: 1px solid var(--ink);
      color: var(--paper);
      background: var(--ink);
      padding: 8px 12px;
      border-radius: 7px;
      cursor: pointer;
      box-shadow: 0 8px 18px rgba(23,33,29,.12);
      transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 12px 22px rgba(23,33,29,.18); }
    button:focus-visible, input:focus-visible, select:focus-visible, .card:focus-visible, .site-link:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
    .ghost { color: var(--ink); background: transparent; }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      backdrop-filter: blur(12px);
      border-radius: 8px;
      box-shadow: 0 18px 48px rgba(31, 45, 39, .1);
    }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 12px; margin-bottom: 14px; }
    .metric { padding: 14px 16px; position: relative; overflow: hidden; border-left: 4px solid var(--accent); }
    .metric b { display: block; font-size: 28px; letter-spacing: 0; line-height: 1.05; }
    .metric span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .card { padding: 16px; min-height: 278px; animation: rise .35s ease both; cursor: pointer; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
    .grid.stable .card { animation: none; }
    .card:hover { transform: translateY(-2px); border-color: var(--line-strong); box-shadow: 0 20px 54px rgba(31, 45, 39, .14); }
    .card.editing { border-color: rgba(18, 128, 92, .62); box-shadow: 0 0 0 4px var(--glow), 0 18px 48px rgba(31, 45, 39, .1); }
    .card.paused { border-style: dashed; opacity: .76; }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 14px; }
    .name { font-family: Didot, Bodoni 72, Georgia, serif; font-size: 28px; letter-spacing: 0; line-height: 1.02; word-break: break-word; }
    .url { color: var(--muted); font-size: 12px; word-break: break-all; margin-top: 5px; }
    .card-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
    .pill { border-radius: 999px; border: 1px solid currentColor; padding: 6px 10px; font-size: 12px; white-space: nowrap; }
    .site-link { border: 1px solid var(--line-strong); border-radius: 7px; padding: 7px 10px; font-size: 12px; text-decoration: none; white-space: nowrap; background: rgba(255,255,255,.46); min-width: 58px; text-align: center; }
    .site-link:hover { background: var(--ink); color: var(--paper); }
    .probe-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .probe-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .billing-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .billing-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .toggle-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .toggle-site::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: currentColor; opacity: .72; }
    .toggle-site.is-off { color: var(--paper); background: var(--ink); border-color: var(--ink); }
    .toggle-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .ok { color: var(--good); background: rgba(22,136,90,.08); }
    .warn { color: var(--warn); background: rgba(183,121,8,.1); }
    .bad { color: var(--bad); background: rgba(180,59,50,.1); }
    .cold { color: var(--cold); background: rgba(49,95,125,.1); }
    .facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .fact { border: 1px solid var(--line); border-radius: 6px; padding: 9px 10px; background: rgba(255,255,255,.48); min-width: 0; }
    .fact small { color: var(--muted); display: block; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
    .fact strong { display: block; font-size: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fact strong.money { font-variant-numeric: tabular-nums; letter-spacing: 0; }
    .fact strong.money[data-size="medium"] { font-size: 15px; }
    .fact strong.money[data-size="long"] { font-size: 13px; }
    .fact strong.money[data-size="tiny"] { font-size: 11px; }
    .keys { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
    .key { border: 1px dashed var(--line-strong); border-radius: 7px; padding: 6px 8px; color: var(--muted); font-size: 12px; }
    .key.ok { color: var(--good); background: rgba(22,136,90,.06); }
    .key.warn { color: var(--warn); background: rgba(183,121,8,.08); }
    .key.bad { color: var(--bad); background: rgba(180,59,50,.08); }
    .key.cold { color: var(--cold); background: rgba(49,95,125,.08); }
    form { margin-top: 18px; padding: 18px; display: grid; grid-template-columns: 1fr 1.5fr 1.5fr .6fr 1fr auto auto; gap: 10px; align-items: end; }
    .form-mode { grid-column: 1 / -1; color: var(--muted); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
    input, select { width: 100%; min-height: 38px; border: 1px solid var(--line); background: rgba(255,255,255,.62); border-radius: 7px; padding: 9px 11px; color: var(--ink); outline: none; }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
    .token-input { width: 180px; }
    .model-panel { margin-bottom: 14px; padding: 16px; display: grid; grid-template-columns: minmax(220px, .8fr) 1.2fr auto; gap: 14px; align-items: end; }
    .model-readout { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .requests { margin-top: 18px; padding: 18px; }
    .requests-head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
    .requests-head h2 { margin: 0; font-family: Didot, Bodoni 72, Georgia, serif; font-size: 28px; letter-spacing: 0; }
    .request-list { display: grid; gap: 8px; max-height: 300px; overflow: auto; }
    .request-row { display: grid; grid-template-columns: 1.2fr 1fr 1fr .6fr; gap: 10px; align-items: center; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: rgba(255,255,255,.48); font-size: 12px; }
    .request-row strong { font-size: 13px; overflow-wrap: anywhere; }
    .request-row small { color: var(--muted); display: block; letter-spacing: .08em; text-transform: uppercase; }
    .models { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; max-height: 112px; overflow: auto; }
    .model-chip { color: var(--ink); background: rgba(255,255,255,.54); border-color: var(--line); box-shadow: none; padding: 6px 8px; font-size: 12px; max-width: 100%; overflow-wrap: anywhere; }
    .model-chip.active { color: var(--paper); background: var(--ink); border-color: var(--ink); }
    .usage-days { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; max-height: 78px; overflow: auto; }
    .usage-day { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: rgba(255,255,255,.44); color: var(--muted); font-size: 12px; }
    .usage-day strong { color: var(--ink); margin-left: 6px; }
    .statusbar { min-height: 24px; margin-top: 12px; display: flex; justify-content: space-between; gap: 16px; align-items: center; color: var(--muted); font-size: 13px; }
    .toast { min-width: 0; overflow-wrap: anywhere; }
    .last-refresh { flex: 0 0 auto; color: rgba(99,112,107,.82); }
    .empty { padding: 24px; color: var(--muted); }
    @media (max-width: 1100px) { .grid { grid-template-columns: repeat(2, 1fr); } .facts { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 760px) { header, .summary, .model-panel, .grid, form { grid-template-columns: 1fr; } .toolbar { justify-content: flex-start; } .token-input { width: 100%; } .request-row { grid-template-columns: 1fr; } .statusbar { align-items: flex-start; flex-direction: column; gap: 6px; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>API Pool<br/>Radar</h1>
        <p class="lede">本地 Codex API 池检测面板。自动刷新每个站点的健康状态、延迟、状态码、模型数量、冷却时间，并支持运行时添加新站点。</p>
      </div>
      <div class="toolbar">
        <input id="adminToken" class="token-input" type="password" placeholder="Admin token" autocomplete="off" />
        <button id="refresh">立即刷新</button>
        <button class="ghost" id="probeAll">重新探测全部</button>
        <button class="ghost" id="billingAll">刷新余额</button>
      </div>
    </header>

    <section class="summary">
      <div class="metric panel"><span>Upstreams</span><b id="total">0</b></div>
      <div class="metric panel"><span>Available</span><b id="available">0</b></div>
      <div class="metric panel"><span>Healthy</span><b id="healthy">0</b></div>
      <div class="metric panel"><span>Cooling</span><b id="cooling">0</b></div>
      <div class="metric panel"><span>Tokens</span><b id="totalTokens">0</b></div>
    </section>

    <section class="model-panel panel">
      <label>当前模型<select id="modelSelect"><option value="">跟随 Codex 请求</option></select></label>
      <div class="model-readout" id="modelReadout">尚未完成模型探测。</div>
      <button class="ghost" id="clearModel" type="button">清空覆盖</button>
    </section>

    <section id="cards" class="grid"></section>

    <section class="requests panel">
      <div class="requests-head">
        <h2>最近请求</h2>
        <div class="model-readout">原模型 -> 实际模型 -> 上游</div>
      </div>
      <div id="requestList" class="request-list"></div>
    </section>

    <form id="addForm" class="panel">
      <div class="form-mode" id="formMode">添加新站点</div>
      <label>名称<input name="name" placeholder="mysite" required /></label>
      <label>Base URL<input name="base_url" placeholder="https://example.com/v1" required /></label>
      <label>签到页<input name="site_url" placeholder="https://example.com" /></label>
      <label>权重<input name="weight" type="number" min="0.1" step="0.1" value="1" /></label>
      <label>Key Env<input name="key_env" placeholder="MYSITE_API_KEY" /></label>
      <button id="submitUpstream" type="submit">添加站点</button>
      <button class="ghost" id="cancelEdit" type="button" hidden>取消</button>
    </form>
    <div class="statusbar">
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
      <div id="lastRefresh" class="last-refresh"></div>
    </div>
  </main>

  <script>
    const cards = document.querySelector('#cards');
    const toast = document.querySelector('#toast');
    const lastRefresh = document.querySelector('#lastRefresh');
    const modelSelect = document.querySelector('#modelSelect');
    const modelReadout = document.querySelector('#modelReadout');
    const requestList = document.querySelector('#requestList');
    const adminTokenInput = document.querySelector('#adminToken');
    const upstreamForm = document.querySelector('#addForm');
    const formMode = document.querySelector('#formMode');
    const submitUpstream = document.querySelector('#submitUpstream');
    const cancelEdit = document.querySelector('#cancelEdit');
    let editingName = '';
    let upstreamCache = new Map();
    let cardsSignature = '';
    let modelOptionsSignature = '';
    let adminToken = localStorage.getItem('codexPoolAdminToken') || '';
    const probingUpstreams = new Set();
    const billingUpstreams = new Set();
    adminTokenInput.value = adminToken;
    const authHeaders = () => adminToken ? { authorization: \`Bearer \${adminToken}\` } : {};
    const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    const setToast = (message) => { toast.textContent = message || ''; };
    const stateClass = (state) => {
      if (state === 'ok') return 'ok';
      if (state === 'models_unsupported' || state === 'unexpected_status' || state === 'unsupported' || state === 'no_amount' || state === 'rate_limited' || state === 'blocked') return 'warn';
      if (state === 'unknown' || state === 'disabled') return 'cold';
      return 'bad';
    };
    const fmt = (value, suffix = '') => value === null || value === undefined || value === '' ? '—' : \`\${value}\${suffix}\`;
    function compactNumber(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return String(value);
      const absolute = Math.abs(number);
      const units = [
        [1e12, 'T'],
        [1e9, 'B'],
        [1e6, 'M'],
        [1e3, 'K']
      ];
      const format = (scaled, digits) => scaled.toLocaleString(undefined, { maximumFractionDigits: digits });
      for (const [factor, unit] of units) {
        if (absolute >= factor) {
          const scaled = number / factor;
          const digits = Math.abs(scaled) >= 100 ? 2 : 3;
          return \`\${format(scaled, digits)}\${unit}\`;
        }
      }
      return number.toLocaleString(undefined, { maximumFractionDigits: absolute >= 100 ? 2 : 6 });
    }
    function fullNumber(value) {
      const number = Number(value);
      return Number.isFinite(number)
        ? number.toLocaleString(undefined, { maximumFractionDigits: 8 })
        : String(value);
    }
    function fmtMoney(value, currency = '') {
      if (value === null || value === undefined || value === '') return '—';
      const prefix = currency ? \`\${currency} \` : '';
      return \`\${prefix}\${compactNumber(value)}\`;
    }
    function fullMoney(value, currency = '') {
      if (value === null || value === undefined || value === '') return '—';
      const prefix = currency ? \`\${currency} \` : '';
      return \`\${prefix}\${fullNumber(value)}\`;
    }
    function moneySize(value, currency = '') {
      const length = fmtMoney(value, currency).length;
      if (length > 18) return 'tiny';
      if (length > 14) return 'long';
      if (length > 10) return 'medium';
      return 'normal';
    }
    function unlimitedBilling(upstream, field) {
      return Boolean(upstream.billing?.limit_placeholder && field === 'limit' && (
        upstream.billing?.[\`\${field}_amount\`] === null ||
        upstream.billing?.[\`\${field}_amount\`] === undefined ||
        upstream.billing?.[\`\${field}_amount\`] === ''
      ));
    }
    function needsBillingManagementKey(upstream, field) {
      return field === 'balance' &&
        (upstream.billing?.balance_amount === null || upstream.billing?.balance_amount === undefined || upstream.billing?.balance_amount === '') &&
        /credits endpoint failed/i.test(upstream.billing?.error || '');
    }
    function billingAmountText(upstream, field) {
      if (needsBillingManagementKey(upstream, field)) return '需管理Key';
      return unlimitedBilling(upstream, field) ? '不限' : fmtMoney(upstream.billing?.[\`\${field}_amount\`], upstream.billing?.currency);
    }
    function billingAmountTitle(upstream, field) {
      if (needsBillingManagementKey(upstream, field)) return upstream.billing?.error || 'credits endpoint failed';
      return unlimitedBilling(upstream, field)
        ? '上游返回占位/不限额上限，无法计算精确余额'
        : fullMoney(upstream.billing?.[\`\${field}_amount\`], upstream.billing?.currency);
    }
    function billingAmountSize(upstream, field) {
      if (needsBillingManagementKey(upstream, field)) return 'long';
      return unlimitedBilling(upstream, field) ? 'normal' : moneySize(upstream.billing?.[\`\${field}_amount\`], upstream.billing?.currency);
    }
    const quotaReqValue = (upstream) => upstream.quota?.requestsRemaining || upstream.quota?.quotaRemaining || '';
    const quotaTokValue = (upstream) => upstream.quota?.tokensRemaining || '';
    const sortedUpstreams = (items) => [...items].sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0) || String(a.name).localeCompare(String(b.name)));
    const cardSignature = (items, activeModel) => items.map((u) => [
      u.name,
      u.base_url,
      u.site_url || '',
      u.enabled,
      u.weight,
      u.usage?.today_tokens || 0,
      u.usage?.total_tokens || 0,
      JSON.stringify(u.usage?.by_day || {}),
      u.billing?.state || '',
      u.billing?.balance_amount ?? '',
      u.billing?.used_amount ?? '',
      u.billing?.limit_amount ?? '',
      u.billing?.limit_placeholder ? 'placeholder' : '',
      u.billing?.currency || '',
      u.billing?.error || '',
      quotaReqValue(u),
      quotaTokValue(u),
      (u.keys || []).map((k) => \`\${k.label}:\${k.configured}\`).join(','),
      (u.keys || []).map((k) => \`\${k.label}:\${k.health?.state || ''}:\${k.health?.error || ''}\`).join(','),
      (u.health?.models || []).join(','),
      activeModel
    ].join('|')).join('||');
    function keySummaryHtml(upstream) {
      return (upstream.keys || []).map((key) => {
        const state = key.configured ? key.health?.state || 'ready' : 'missing';
        const className = key.configured ? stateClass(state === 'ready' ? 'ok' : state) : 'bad';
        const error = key.health?.error ? \` title="\${esc(key.health.error)}"\` : '';
        return \`<span class="key \${className}"\${error}>\${esc(key.label)}: \${esc(state)}</span>\`;
      }).join('');
    }
    function usageDaysHtml(upstream) {
      const entries = Object.entries(upstream.usage?.by_day || {})
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 14);
      return entries.length
        ? entries.map(([day, tokens]) => \`<span class="usage-day">\${esc(day)}<strong>\${fmt(tokens)}</strong></span>\`).join('')
        : '<span class="key">暂无 token 记录</span>';
    }
    function quotaFactsHtml(upstream) {
      const requestValue = quotaReqValue(upstream);
      const tokenValue = quotaTokValue(upstream);
      return [
        requestValue ? \`<div class="fact"><small>Rate Req</small><strong data-field="req_left">\${fmt(requestValue)}</strong></div>\` : '',
        tokenValue ? \`<div class="fact"><small>Rate Tok</small><strong data-field="tok_left">\${fmt(tokenValue)}</strong></div>\` : ''
      ].join('');
    }
    function setText(root, selector, value) {
      const node = root.querySelector(selector);
      if (node) node.textContent = value;
    }
    function setMoney(root, selector, value, currency, options = {}) {
      const node = root.querySelector(selector);
      if (!node) return;
      if (options.unlimited) {
        node.textContent = '不限';
        node.title = '上游返回占位/不限额上限，无法计算精确余额';
        node.dataset.size = 'normal';
        return;
      }
      if (options.needsManagementKey) {
        node.textContent = '需管理Key';
        node.title = options.title || 'credits endpoint failed';
        node.dataset.size = 'long';
        return;
      }
      node.textContent = fmtMoney(value, currency);
      node.title = fullMoney(value, currency);
      node.dataset.size = moneySize(value, currency);
    }
    function updateCard(upstream, activeModel) {
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(upstream.name)}"]\`);
      if (!card) return;
      const state = upstream.health?.state || 'unknown';
      const pill = card.querySelector('[data-field="state"]');
      if (pill) {
        pill.textContent = state;
        pill.className = \`pill \${stateClass(state)}\`;
      }
      setText(card, '[data-field="http"]', fmt(upstream.health?.http_status));
      setText(card, '[data-field="latency"]', fmt(upstream.health?.latency_ms, 'ms'));
      setText(card, '[data-field="models_count"]', fmt(upstream.health?.models_count));
      setText(card, '[data-field="cooldown"]', \`\${Math.ceil((upstream.cooldown_ms || 0) / 1000)}s\`);
      setText(card, '[data-field="weight"]', upstream.weight);
      setText(card, '[data-field="failures"]', upstream.failures);
      setText(card, '[data-field="calls"]', upstream.stats?.attempts || 0);
      setText(card, '[data-field="today_tokens"]', fmt(upstream.usage?.today_tokens));
      setText(card, '[data-field="total_tokens"]', fmt(upstream.usage?.total_tokens));
      setText(card, '[data-field="billing_state"]', upstream.billing?.state || 'unknown');
      const billingFact = card.querySelector('[data-billing-fact]');
      if (billingFact) billingFact.title = upstream.billing?.error || '';
      setMoney(card, '[data-field="balance"]', upstream.billing?.balance_amount, upstream.billing?.currency, {
        needsManagementKey: needsBillingManagementKey(upstream, 'balance'),
        title: upstream.billing?.error || ''
      });
      setMoney(card, '[data-field="spent"]', upstream.billing?.used_amount, upstream.billing?.currency);
      setMoney(card, '[data-field="limit"]', upstream.billing?.limit_amount, upstream.billing?.currency, { unlimited: unlimitedBilling(upstream, 'limit') });
      setText(card, '[data-field="req_left"]', fmt(quotaReqValue(upstream)));
      setText(card, '[data-field="tok_left"]', fmt(quotaTokValue(upstream)));
      card.querySelectorAll('[data-model]').forEach((button) => {
        button.classList.toggle('active', button.dataset.model === activeModel);
      });
      const probeButton = card.querySelector('[data-probe]');
      if (probeButton) {
        const probing = probingUpstreams.has(upstream.name);
        probeButton.disabled = probing || !upstream.enabled;
        probeButton.textContent = !upstream.enabled ? '停用中' : probing ? '测试中' : '测试';
      }
      const billingButton = card.querySelector('[data-billing]');
      if (billingButton) {
        const billing = billingUpstreams.has(upstream.name);
        billingButton.disabled = billing || !upstream.enabled;
        billingButton.textContent = !upstream.enabled ? '停用中' : billing ? '刷新中' : '余额';
      }
      const toggleButton = card.querySelector('[data-toggle]');
      if (toggleButton) {
        toggleButton.disabled = false;
        toggleButton.textContent = upstream.enabled ? '停用' : '启用';
        toggleButton.className = \`ghost toggle-site \${upstream.enabled ? 'is-on' : 'is-off'}\`;
        toggleButton.setAttribute('aria-pressed', String(upstream.enabled));
      }
    }
    function renderRecentRequests(items) {
      requestList.innerHTML = items.length ? items.map((item) => \`
        <div class="request-row">
          <div><small>Model</small><strong>\${esc(item.originalModel || 'none')} -> \${esc(item.actualModel || 'none')}</strong></div>
          <div><small>Upstream</small><strong>\${esc(item.upstream || 'unknown')}</strong></div>
          <div><small>Status</small><strong>\${esc(item.outcome || '')} · \${esc(item.status ?? 0)} · \${esc(item.durationMs ?? 0)}ms · \${esc(item.tokens ?? 0)} tok</strong></div>
          <div><small>When</small><strong>\${new Date(item.at).toLocaleTimeString()}</strong></div>
        </div>\`).join('') : '<div class="empty">暂无请求记录。</div>';
    }
    function resetEdit(clearValues = true) {
      editingName = '';
      formMode.textContent = '添加新站点';
      submitUpstream.textContent = '添加站点';
      cancelEdit.hidden = true;
      upstreamForm.elements.name.readOnly = false;
      if (clearValues) upstreamForm.reset();
      document.querySelectorAll('.card.editing').forEach((card) => card.classList.remove('editing'));
    }
    function markEditingCard() {
      document.querySelectorAll('.card').forEach((card) => {
        card.classList.toggle('editing', Boolean(editingName) && card.dataset.upstream === editingName);
      });
    }
    function startEdit(upstream) {
      editingName = upstream.name;
      upstreamForm.elements.name.value = upstream.name || '';
      upstreamForm.elements.name.readOnly = true;
      upstreamForm.elements.base_url.value = upstream.base_url || '';
      upstreamForm.elements.site_url.value = upstream.site_url || '';
      upstreamForm.elements.weight.value = upstream.weight || 1;
      upstreamForm.elements.key_env.value = upstream.keys?.[0]?.label || '';
      formMode.textContent = \`编辑站点：\${upstream.name}\`;
      submitUpstream.textContent = '保存修改';
      cancelEdit.hidden = false;
      markEditingCard();
      upstreamForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    async function setModel(model) {
      const response = await fetch('/pool/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ model })
      });
      const result = await response.json();
      setToast(response.ok ? (model ? \`已切换模型：\${model}\` : '已清空模型覆盖') : \`切换失败：\${result.error}\`);
      await load();
    }
    async function load() {
      const response = await fetch('/pool/status', { headers: authHeaders() });
      if (response.status === 401) {
        setToast('管理接口需要 admin token。');
        lastRefresh.textContent = '鉴权失败';
        return;
      }
      const data = await response.json();
      const ups = sortedUpstreams(data.upstreams || []);
      upstreamCache = new Map(ups.map((upstream) => [upstream.name, upstream]));
      if (editingName && !upstreamCache.has(editingName)) resetEdit(false);
      const knownModels = data.model?.known || [];
      const activeModel = data.model?.override || '';
      const selectModels = activeModel && !knownModels.includes(activeModel) ? [activeModel, ...knownModels] : knownModels;
      document.querySelector('#total').textContent = ups.length;
      document.querySelector('#available').textContent = ups.filter(u => u.available).length;
      document.querySelector('#healthy').textContent = ups.filter(u => u.health?.state === 'ok').length;
      document.querySelector('#cooling').textContent = ups.filter(u => u.cooldown_ms > 0).length;
      document.querySelector('#totalTokens').textContent = fmt(data.usage?.total_tokens || 0);
      const nextModelOptionsSignature = selectModels.join('|');
      if (nextModelOptionsSignature !== modelOptionsSignature) {
        modelSelect.innerHTML = '<option value="">跟随 Codex 请求</option>' + selectModels.map((model) => \`<option value="\${esc(model)}">\${esc(model)}</option>\`).join('');
        modelOptionsSignature = nextModelOptionsSignature;
      }
      modelSelect.value = activeModel;
      modelReadout.textContent = activeModel
        ? \`代理会把后续 JSON 请求中的 model 改写为 \${activeModel}。已探测到 \${knownModels.length} 个模型。\`
        : \`未设置模型覆盖；后续请求将使用 Codex 原始 model。已探测到 \${knownModels.length} 个模型。\`;
      renderRecentRequests(data.recent_requests || []);
      const nextCardsSignature = cardSignature(ups, activeModel);
      if (nextCardsSignature !== cardsSignature) {
        cards.classList.toggle('stable', Boolean(cardsSignature));
        cards.innerHTML = ups.length ? ups.map((u, index) => \`
        <article class="card panel \${u.name === editingName ? 'editing' : ''} \${u.enabled ? '' : 'paused'}" data-upstream="\${esc(u.name)}" tabindex="0" role="button" aria-label="编辑站点 \${esc(u.name)}" style="animation-delay:\${index * 45}ms">
          <div class="card-head">
            <div><div class="name">\${esc(u.name)}</div><div class="url">\${esc(u.base_url)}</div></div>
            <div class="card-actions">
              <div class="pill \${stateClass(u.health?.state)}" data-field="state">\${esc(u.health?.state || 'unknown')}</div>
              <button class="ghost toggle-site \${u.enabled ? 'is-on' : 'is-off'}" type="button" data-toggle="\${esc(u.name)}" data-enabled="\${u.enabled ? 'true' : 'false'}" aria-pressed="\${u.enabled ? 'true' : 'false'}">\${u.enabled ? '停用' : '启用'}</button>
              <button class="ghost probe-site" type="button" data-probe="\${esc(u.name)}" \${probingUpstreams.has(u.name) || !u.enabled ? 'disabled' : ''}>\${!u.enabled ? '停用中' : probingUpstreams.has(u.name) ? '测试中' : '测试'}</button>
              <button class="ghost billing-site" type="button" data-billing="\${esc(u.name)}" \${billingUpstreams.has(u.name) || !u.enabled ? 'disabled' : ''}>\${!u.enabled ? '停用中' : billingUpstreams.has(u.name) ? '刷新中' : '余额'}</button>
              \${u.site_url ? \`<a class="site-link" href="\${esc(u.site_url)}" target="_blank" rel="noopener noreferrer">签到</a>\` : ''}
            </div>
          </div>
          <div class="facts">
            <div class="fact"><small>HTTP</small><strong data-field="http">\${fmt(u.health?.http_status)}</strong></div>
            <div class="fact"><small>Latency</small><strong data-field="latency">\${fmt(u.health?.latency_ms, 'ms')}</strong></div>
            <div class="fact"><small>Models</small><strong data-field="models_count">\${fmt(u.health?.models_count)}</strong></div>
            <div class="fact"><small>Cooldown</small><strong data-field="cooldown">\${Math.ceil((u.cooldown_ms || 0) / 1000)}s</strong></div>
            <div class="fact"><small>Weight</small><strong data-field="weight">\${u.weight}</strong></div>
            <div class="fact"><small>Failures</small><strong data-field="failures">\${u.failures}</strong></div>
            <div class="fact"><small>Calls</small><strong data-field="calls">\${u.stats?.attempts || 0}</strong></div>
            <div class="fact"><small>Today Tok</small><strong data-field="today_tokens">\${fmt(u.usage?.today_tokens)}</strong></div>
            <div class="fact"><small>Total Tok</small><strong data-field="total_tokens">\${fmt(u.usage?.total_tokens)}</strong></div>
            <div class="fact" data-billing-fact title="\${esc(u.billing?.error || '')}"><small>Billing</small><strong data-field="billing_state">\${esc(u.billing?.state || 'unknown')}</strong></div>
            <div class="fact"><small>Balance</small><strong class="money" data-field="balance" data-size="\${billingAmountSize(u, 'balance')}" title="\${esc(billingAmountTitle(u, 'balance'))}">\${billingAmountText(u, 'balance')}</strong></div>
            <div class="fact"><small>Spent</small><strong class="money" data-field="spent" data-size="\${moneySize(u.billing?.used_amount, u.billing?.currency)}" title="\${esc(fullMoney(u.billing?.used_amount, u.billing?.currency))}">\${fmtMoney(u.billing?.used_amount, u.billing?.currency)}</strong></div>
            <div class="fact"><small>Limit</small><strong class="money" data-field="limit" data-size="\${billingAmountSize(u, 'limit')}" title="\${esc(billingAmountTitle(u, 'limit'))}">\${billingAmountText(u, 'limit')}</strong></div>
            \${quotaFactsHtml(u)}
          </div>
          <div class="keys">\${keySummaryHtml(u)}</div>
          <div class="usage-days">\${usageDaysHtml(u)}</div>
          <div class="models">\${(u.health?.models || []).length ? (u.health.models || []).map(model => \`<button class="model-chip \${model === activeModel ? 'active' : ''}" type="button" data-model="\${esc(model)}">\${esc(model)}</button>\`).join('') : '<span class="key">暂无模型列表</span>'}</div>
        </article>\`).join('') : '<div class="empty panel">暂无站点。</div>';
        cardsSignature = nextCardsSignature;
      } else {
        ups.forEach((upstream) => updateCard(upstream, activeModel));
      }
      lastRefresh.textContent = \`最后刷新：\${new Date().toLocaleTimeString()}\`;
      markEditingCard();
    }
    async function probeAll() {
      const response = await fetch('/pool/probe', { method: 'POST', headers: authHeaders() });
      const result = await response.json();
      setToast(response.ok ? '全部站点探测完成。' : \`全部探测失败：\${result.error || response.status}\`);
      await load();
    }
    async function probeOne(name) {
      probingUpstreams.add(name);
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
      const button = card?.querySelector('[data-probe]');
      if (button) {
        button.disabled = true;
        button.textContent = '测试中';
      }
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/probe\`, { method: 'POST', headers: authHeaders() });
        const result = await response.json();
        setToast(response.ok
          ? \`\${name} 测试完成：\${result.health?.state || 'unknown'}，模型 \${result.health?.modelsCount ?? result.health?.models_count ?? 0} 个\`
          : \`\${name} 测试失败：\${result.error || response.status}\`);
      } catch (error) {
        setToast(\`\${name} 测试失败：\${error.message}\`);
      } finally {
        probingUpstreams.delete(name);
        await load();
      }
    }
    async function probeBillingAll() {
      const response = await fetch('/pool/billing', { method: 'POST', headers: authHeaders() });
      const result = await response.json();
      setToast(response.ok ? '全部余额刷新完成。' : \`余额刷新失败：\${result.error || response.status}\`);
      await load();
    }
    async function probeBillingOne(name) {
      billingUpstreams.add(name);
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
      const button = card?.querySelector('[data-billing]');
      if (button) {
        button.disabled = true;
        button.textContent = '刷新中';
      }
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/billing\`, { method: 'POST', headers: authHeaders() });
        const result = await response.json();
        const billing = result.billing || {};
        const amount = fmtMoney(billing.balance_amount, billing.currency);
        setToast(response.ok
          ? \`\${name} 余额刷新完成：\${billing.state || 'unknown'}，余额 \${amount}\`
          : \`\${name} 余额刷新失败：\${result.error || response.status}\`);
      } catch (error) {
        setToast(\`\${name} 余额刷新失败：\${error.message}\`);
      } finally {
        billingUpstreams.delete(name);
        await load();
      }
    }
    async function setUpstreamEnabled(name, enabled) {
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
      const button = card?.querySelector('[data-toggle]');
      if (button) {
        button.disabled = true;
        button.textContent = enabled ? '启用中' : '停用中';
      }
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/enabled\`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ enabled })
        });
        const result = await response.json();
        setToast(response.ok
          ? \`\${name} 已\${enabled ? '启用' : '停用'}，状态：\${result.health?.state || 'unknown'}\`
          : \`\${name} 切换失败：\${result.error || response.status}\`);
      } catch (error) {
        setToast(\`\${name} 切换失败：\${error.message}\`);
      } finally {
        await load();
      }
    }
    document.querySelector('#refresh').addEventListener('click', load);
    document.querySelector('#probeAll').addEventListener('click', probeAll);
    document.querySelector('#billingAll').addEventListener('click', probeBillingAll);
    adminTokenInput.addEventListener('change', () => {
      adminToken = adminTokenInput.value.trim();
      if (adminToken) localStorage.setItem('codexPoolAdminToken', adminToken);
      else localStorage.removeItem('codexPoolAdminToken');
      load();
    });
    modelSelect.addEventListener('change', () => setModel(modelSelect.value));
    document.querySelector('#clearModel').addEventListener('click', () => setModel(''));
    cards.addEventListener('click', (event) => {
      const toggleButton = event.target.closest('[data-toggle]');
      if (toggleButton) {
        const currentlyEnabled = toggleButton.dataset.enabled === 'true';
        setUpstreamEnabled(toggleButton.dataset.toggle || '', !currentlyEnabled);
        return;
      }
      const probeButton = event.target.closest('[data-probe]');
      if (probeButton) {
        probeOne(probeButton.dataset.probe || '');
        return;
      }
      const billingButton = event.target.closest('[data-billing]');
      if (billingButton) {
        probeBillingOne(billingButton.dataset.billing || '');
        return;
      }
      const button = event.target.closest('[data-model]');
      if (button) {
        setModel(button.dataset.model || '');
        return;
      }
      if (event.target.closest('a, button, input, select, label')) return;
      const card = event.target.closest('[data-upstream]');
      if (!card) return;
      const upstream = upstreamCache.get(card.dataset.upstream);
      if (upstream) startEdit(upstream);
    });
    cards.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('button, a, input, select, label')) return;
      const card = event.target.closest('[data-upstream]');
      if (!card) return;
      const upstream = upstreamCache.get(card.dataset.upstream);
      if (!upstream) return;
      event.preventDefault();
      startEdit(upstream);
    });
    cancelEdit.addEventListener('click', () => resetEdit());
    upstreamForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const upstreamName = editingName || form.get('name');
      const payload = {
        name: upstreamName,
        base_url: form.get('base_url'),
        site_url: form.get('site_url'),
        weight: Number(form.get('weight') || 1),
        keys: [{ env: form.get('key_env') || String(upstreamName).toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY' }],
        replace: Boolean(editingName)
      };
      const response = await fetch('/pool/upstreams', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      setToast(response.ok
        ? \`\${payload.replace ? '已保存' : '已添加'}：\${result.upstream}，探测状态：\${result.health?.state}\`
        : \`\${payload.replace ? '保存失败' : '添加失败'}：\${result.error}\`);
      if (response.ok) resetEdit();
      await load();
    });
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}

function knownModels(state) {
  return [...new Set(state.upstreams.filter((upstream) => upstream.enabled).flatMap((upstream) => upstream.health?.models || []))]
    .sort((a, b) => a.localeCompare(b));
}

function createStatusPayload(config, state) {
  const at = now();
  const today = localDateKey(at);
  return {
    ok: true,
    listen: `${config.server?.host || '127.0.0.1'}:${config.server?.port || 8787}`,
    public_prefix: normalizePrefix(config.server?.public_prefix || '/v1') || '/',
    model: {
      override: state.modelOverride,
      known: knownModels(state)
    },
    recent_requests: state.recentRequests,
    health: {
      enabled: config.health?.enabled !== false,
      interval_ms: Number(config.health?.interval_ms || 60000),
      path: config.health?.path || '/models'
    },
    usage: aggregateUsage(state.upstreams, today),
    billing: aggregateBilling(state.upstreams),
    upstreams: state.upstreams.map((upstream) => ({
      name: upstream.name,
      base_url: upstream.baseUrl,
      site_url: upstream.siteUrl,
      health_path: upstream.healthPath || config.health?.path || '/models',
      probe_auth: upstream.probeAuth,
      enabled: upstream.enabled,
      weight: upstream.weight,
      available: upstreamAvailable(upstream, at),
      cooldown_ms: Math.max(0, upstream.cooldownUntil - at),
      in_flight: upstream.inFlight,
      successes: upstream.successes,
      failures: upstream.failures,
      ewma_latency_ms: upstream.ewmaLatencyMs,
      last_status: upstream.lastStatus,
      last_error: upstream.lastError,
      stats: upstream.stats,
      usage: usagePayload(upstream.stats, today),
      quota: upstream.quota,
      billing: billingPayload(upstream.billing, upstream.billingConfig),
      health: {
        state: upstream.health.state,
        checked_at: upstream.health.checkedAt,
        latency_ms: upstream.health.latencyMs,
        http_status: upstream.health.httpStatus,
        error: upstream.health.error,
        models: upstream.health.models || [],
        models_count: upstream.health.modelsCount,
        key_label: upstream.health.keyLabel
      },
      keys: upstream.keys.map((key) => ({
        label: key.label,
        configured: Boolean(key.value),
        cooldown_ms: Math.max(0, key.cooldownUntil - at),
        failures: key.failures,
        stats: key.stats,
        quota: key.quota,
        health: {
          state: key.health.state,
          checked_at: key.health.checkedAt,
          latency_ms: key.health.latencyMs,
          http_status: key.health.httpStatus,
          error: key.health.error
        }
      }))
    }))
  };
}

function tokenMatches(req, envName) {
  if (!envName) return true;
  const expected = process.env[envName];
  if (!expected) return false;
  const authorization = req.headers.authorization || '';
  return authorization === `Bearer ${expected}`;
}

function isAuthorized(req, config) {
  return tokenMatches(req, config.server?.auth_token_env);
}

function isAdminAuthorized(req, config) {
  if (Object.prototype.hasOwnProperty.call(config.server || {}, 'admin_auth_token_env')) {
    return tokenMatches(req, config.server.admin_auth_token_env);
  }
  return isAuthorized(req, config);
}

function validateUpstreamPayload(payload, config) {
  if (!payload || typeof payload !== 'object') {
    const error = new Error('upstream payload must be a JSON object');
    error.statusCode = 400;
    throw error;
  }

  const name = String(payload.name || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    const error = new Error('name must be 1-64 chars: letters, numbers, dot, underscore, hyphen');
    error.statusCode = 400;
    throw error;
  }

  const existing = (config.upstreams || []).find((upstream) => upstream.name === name);
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(payload, key);

  if (existing && !payload.replace) {
    const error = new Error(`upstream already exists: ${name}`);
    error.statusCode = 409;
    throw error;
  }

  const baseUrl = String(payload.base_url || '').trim().replace(/\/$/, '');
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch (cause) {
    const error = new Error(`invalid base_url: ${cause.message}`);
    error.statusCode = 400;
    throw error;
  }

  const keyInput = Array.isArray(payload.keys) && payload.keys.length > 0
    ? payload.keys
    : payload.replace && Array.isArray(existing?.keys) && existing.keys.length > 0
      ? existing.keys
      : null;

  const keys = keyInput
    ? keyInput.map((entry) => {
      if (typeof entry === 'string') return { env: entry };
      if (entry && typeof entry === 'object' && entry.env) return { env: String(entry.env) };
      if (entry && typeof entry === 'object' && entry.value) return { value: String(entry.value), label: entry.label ? String(entry.label) : undefined };
      const error = new Error('each key must be an env name, {"env":"NAME"}, or {"value":"secret"}');
      error.statusCode = 400;
      throw error;
    })
    : [{ env: 'CODEX_CUSTOM_API_KEY' }];

  const siteUrlInput = hasOwn('site_url') ? payload.site_url : existing?.site_url;
  const healthPathInput = hasOwn('health_path') ? payload.health_path : existing?.health_path;
  const probeAuthInput = hasOwn('probe_auth') ? payload.probe_auth : existing?.probe_auth;
  const probeHeadersInput = hasOwn('probe_headers') ? payload.probe_headers : existing?.probe_headers;
  const billingInput = hasOwn('billing') ? payload.billing : existing?.billing;

  return {
    name,
    base_url: baseUrl,
    site_url: deriveSiteUrl(baseUrl, siteUrlInput),
    health_path: typeof healthPathInput === 'string'
      ? healthPathInput.trim()
      : undefined,
    probe_auth: typeof probeAuthInput === 'string'
      ? probeAuthInput.trim()
      : undefined,
    probe_headers: probeHeadersInput && typeof probeHeadersInput === 'object' && !Array.isArray(probeHeadersInput)
      ? Object.fromEntries(Object.entries(probeHeadersInput).map(([key, value]) => [key, String(value)]))
      : undefined,
    billing: billingInput && typeof billingInput === 'object' && !Array.isArray(billingInput)
      ? { ...billingInput }
      : undefined,
    weight: Number(hasOwn('weight') ? payload.weight || 1 : existing?.weight || 1),
    keys,
    enabled: hasOwn('enabled') ? payload.enabled !== false : existing?.enabled !== false
  };
}

async function saveConfig(config, configPath) {
  if (!configPath) return;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function handlePoolApi(req, res, config, state, options, statsPath) {
  const maxBodyBytes = Number(config.server?.max_body_bytes || 50 * 1024 * 1024);
  const url = new URL(req.url || '/', 'http://codex-api-pool.local');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/pool/dashboard') {
    const body = Buffer.from(dashboardHtml());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
    return res.end(body);
  }

  if (req.method === 'GET' && pathname === '/health') {
    return jsonResponse(res, 200, {
      ok: true,
      service: 'codex-api-pool',
      listen: `${config.server?.host || '127.0.0.1'}:${config.server?.port || 8787}`,
      upstreams: state.upstreams.length
    });
  }

  if (!isAdminAuthorized(req, config)) {
    return jsonResponse(res, 401, { error: 'unauthorized: invalid Codex API pool admin token' });
  }

  if (req.method === 'GET' && (pathname === '/pool/status' || pathname === '/pool/upstreams')) {
    return jsonResponse(res, 200, createStatusPayload(config, state));
  }

  if (req.method === 'POST' && pathname === '/pool/probe') {
    await runHealthChecks(state, config);
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, result: createStatusPayload(config, state) });
  }

  if (req.method === 'POST' && pathname === '/pool/billing') {
    await runBillingChecks(state, config);
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, result: createStatusPayload(config, state) });
  }

  if (req.method === 'POST' && pathname === '/pool/model') {
    const payload = await readJsonBody(req, maxBodyBytes);
    const model = String(payload.model || '').trim();
    if (model.length > 200) {
      return jsonResponse(res, 400, { error: 'model must be 200 chars or fewer' });
    }
    state.modelOverride = model;
    config.model_override = model;
    await saveConfig(config, options.configPath);
    return jsonResponse(res, 200, { ok: true, model_override: model });
  }

  const enabledMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/enabled$/);
  if (req.method === 'POST' && enabledMatch) {
    const name = decodeURIComponent(enabledMatch[1]);
    const payload = await readJsonBody(req, maxBodyBytes);
    if (typeof payload.enabled !== 'boolean') {
      return jsonResponse(res, 400, { error: 'enabled must be a boolean' });
    }
    const existingIndex = (config.upstreams || []).findIndex((item) => item.name === name);
    if (existingIndex < 0) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    config.upstreams[existingIndex] = {
      ...config.upstreams[existingIndex],
      enabled: payload.enabled
    };
    rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    const upstream = state.upstreams.find((item) => item.name === name);
    const health = upstream?.enabled ? await probeOneUpstream(state, upstream, config) : upstream?.health || null;
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, upstream: name, enabled: payload.enabled, health });
  }

  if (req.method === 'POST' && pathname === '/pool/upstreams') {
    const payload = await readJsonBody(req, maxBodyBytes);
    const upstream = validateUpstreamPayload(payload, config);
    const existingIndex = (config.upstreams || []).findIndex((item) => item.name === upstream.name);
    if (!Array.isArray(config.upstreams)) config.upstreams = [];
    if (existingIndex >= 0) config.upstreams.splice(existingIndex, 1, upstream);
    else config.upstreams.push(upstream);
    rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    const added = state.upstreams.find((item) => item.name === upstream.name);
    const health = added ? await probeOneUpstream(state, added, config) : null;
    persistStats(state, statsPath);
    return jsonResponse(res, existingIndex >= 0 ? 200 : 201, {
      ok: true,
      action: existingIndex >= 0 ? 'replaced' : 'added',
      upstream: upstream.name,
      persisted: Boolean(options.configPath),
      plaintext_key_warning: upstream.keys.some((key) => key.value) ? 'one or more keys were saved as plaintext values' : null,
      health
    });
  }

  const probeMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/probe$/);
  if (req.method === 'POST' && probeMatch) {
    const name = decodeURIComponent(probeMatch[1]);
    const upstream = state.upstreams.find((item) => item.name === name);
    if (!upstream) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    const health = await probeOneUpstream(state, upstream, config);
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, upstream: name, health });
  }

  const billingMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/billing$/);
  if (req.method === 'POST' && billingMatch) {
    const name = decodeURIComponent(billingMatch[1]);
    const upstream = state.upstreams.find((item) => item.name === name);
    if (!upstream) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    const billing = await probeOneBilling(upstream, config);
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, upstream: name, billing: billingPayload(billing, upstream.billingConfig) });
  }

  return jsonResponse(res, 404, { error: 'pool API route not found' });
}

export function createPoolServer(config, options = {}) {
  const logger = options.logger || console;
  const state = buildState(config);
  const serverConfig = config.server || {};
  const publicPrefix = normalizePrefix(serverConfig.public_prefix || '/v1');
  const maxBodyBytes = Number(serverConfig.max_body_bytes || 50 * 1024 * 1024);
  const timeoutMs = Number(serverConfig.request_timeout_ms || 180000);
  const statsPath = options.statsPath || path.resolve(path.dirname(options.configPath || DEFAULT_CONFIG_PATH), config.stats?.path || 'stats.local.json');
  restoreStats(state, statsPath);
  const healthTimer = startHealthLoop(state, config, logger);
  scheduleStartupProbe(state, config, statsPath, logger);

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', 'http://codex-api-pool.local').pathname;

      if (pathname === '/health' || pathname.startsWith('/pool/')) {
        return await handlePoolApi(req, res, config, state, options, statsPath);
      }

      if (!isAuthorized(req, config)) {
        return jsonResponse(res, 401, { error: 'unauthorized: invalid Codex API pool token' });
      }

      if (state.upstreams.length === 0) {
        return jsonResponse(res, 503, { error: 'no upstreams configured' });
      }

      const originalBody = await readBody(req, maxBodyBytes);
      const requestedModel = state.modelOverride || modelFromBody(req, originalBody);
      const originalModel = modelFromBody(req, originalBody);
      const tried = new Set();
      const attempts = [];
      const maxAttempts = Math.max(1, state.retry.maxAttempts);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const candidate = chooseCandidate(state, tried, { preferredModel: requestedModel, allowUnknownModelFallback: attempt > 1 });
        if (!candidate) break;

        const { upstream, key } = candidate;
        tried.add(`${upstream.name}:${key.index}`);
        upstream.inFlight += 1;
        const allowRetry = attempt < maxAttempts;
        const attemptedModel = requestedModel;
        const useAnthropicAdapter = shouldUseAnthropicResponsesAdapter(pathname, upstream, attemptedModel);
        const targetUrl = useAnthropicAdapter
          ? joinUrlPath(upstream.baseUrl, '/v1/messages')
          : joinTargetUrl(upstream.baseUrl, req.url || '/', publicPrefix);
        const body = useAnthropicAdapter
          ? buildAnthropicMessagesPayload(rewriteModelInBody(req, originalBody, attemptedModel), attemptedModel)
          : rewriteModelInBody(req, originalBody, attemptedModel);
        const requestHeaders = useAnthropicAdapter
          ? buildAnthropicRequestHeaders(targetUrl, key.value, req.headers, upstream.probeHeaders)
          : undefined;
        const requestMethod = useAnthropicAdapter ? 'POST' : req.method;
        recordAttempt(upstream, key);

        const result = await requestUpstream({
          req,
          body,
          targetUrl,
          upstream,
          key,
          timeoutMs,
          allowRetry,
          retryableStatus: state.retry.retryableStatus,
          method: requestMethod,
          headers: requestHeaders
        });

        if (result.type === 'response') {
          applyQuota(upstream, key, result.response.headers);
          recordResponseStats(upstream, key, result.statusCode, false);
          persistStats(state, statsPath);
          const usageCapture = createUsageCapture(result.response.headers);
          const isSuccessfulAnthropicAdapter = useAnthropicAdapter && result.statusCode >= 200 && result.statusCode < 300;
          const adaptAnthropicStream = isSuccessfulAnthropicAdapter && isEventStream(result.response.headers) && isUncompressedResponse(result.response.headers);
          const adaptAnthropicJson = isSuccessfulAnthropicAdapter && !isEventStream(result.response.headers) && isUncompressedResponse(result.response.headers);
          const normalizeResponsesStream = !adaptAnthropicStream && shouldNormalizeResponsesStream(pathname, result.response.headers);
          const headers = sanitizeResponseHeaders(result.response.headers, upstream.name);
          if (normalizeResponsesStream || adaptAnthropicStream || adaptAnthropicJson) deleteHeader(headers, 'content-length');
          if (adaptAnthropicStream) headers['content-type'] = 'text/event-stream; charset=utf-8';
          if (adaptAnthropicJson) headers['content-type'] = 'application/json; charset=utf-8';
          res.writeHead(result.statusCode, headers);
          const anthropicStreamAdapter = adaptAnthropicStream
            ? createAnthropicResponsesStreamAdapter(res, attemptedModel)
            : null;
          const responsesCompletionNormalizer = normalizeResponsesStream
            ? createResponsesCompletionNormalizer(res, attemptedModel)
            : null;
          const anthropicJsonChunks = adaptAnthropicJson ? [] : null;
          let anthropicJsonSize = 0;

          result.response.on('data', (chunk) => {
            usageCapture.push(chunk);
            if (anthropicStreamAdapter) anthropicStreamAdapter.write(chunk);
            else if (anthropicJsonChunks) {
              anthropicJsonSize += chunk.length;
              anthropicJsonChunks.push(chunk);
            } else if (responsesCompletionNormalizer) responsesCompletionNormalizer.write(chunk);
            else res.write(chunk);
          });

          result.response.on('end', () => {
            if (anthropicStreamAdapter) anthropicStreamAdapter.end();
            else if (anthropicJsonChunks) res.end(anthropicMessageToResponsesJson(Buffer.concat(anthropicJsonChunks, anthropicJsonSize), attemptedModel));
            else if (responsesCompletionNormalizer) responsesCompletionNormalizer.end();
            else res.end();
            upstream.inFlight = Math.max(0, upstream.inFlight - 1);
            finishResponseAttempt({
              state,
              upstream,
              key,
              method: req.method,
              pathname,
              originalModel,
              attemptedModel,
              statusCode: result.statusCode,
              startedAt: result.startedAt,
              attempt,
              reason: `HTTP ${result.statusCode}`,
              retryAfter: result.response.headers?.['retry-after'],
              tokenCount: usageCapture.tokenCount(),
              statsPath
            });
          });

          result.response.on('error', (error) => {
            upstream.inFlight = Math.max(0, upstream.inFlight - 1);
            recordFailure(state, upstream, key, error.message, result.statusCode, undefined);
            rememberRequest(state, {
              method: req.method,
              path: pathname,
              upstream: upstream.name,
              key: key.label,
              originalModel: originalModel || null,
              actualModel: attemptedModel || null,
              status: result.statusCode,
              durationMs: now() - result.startedAt,
              retried: attempt > 1,
              outcome: 'stream_error',
              reason: error.message
            });
            persistStats(state, statsPath);
            if (!res.destroyed) res.destroy(error);
          });
          return;
        }

        upstream.inFlight = Math.max(0, upstream.inFlight - 1);
        applyQuota(upstream, key, result.headers || {});
        recordResponseStats(upstream, key, result.statusCode, true);
        persistStats(state, statsPath);
        recordFailure(state, upstream, key, result.reason, result.statusCode, result.retryAfter);
        rememberRequest(state, {
          method: req.method,
          path: pathname,
          upstream: upstream.name,
          key: key.label,
          originalModel: originalModel || null,
          actualModel: attemptedModel || null,
          status: result.statusCode,
          durationMs: now() - result.startedAt,
          retried: true,
          outcome: 'retry',
          reason: result.reason
        });
        persistStats(state, statsPath);
        attempts.push({
          upstream: upstream.name,
          key: key.label,
          model: attemptedModel || null,
          status: result.statusCode,
          reason: result.reason
        });

        const smallBackoff = Math.min(1000, 100 * attempt);
        if (allowRetry) await sleep(smallBackoff);
      }

      const lastAttempt = attempts[attempts.length - 1] || null;
      rememberRequest(state, {
        method: req.method,
        path: pathname,
        upstream: lastAttempt?.upstream || null,
        key: lastAttempt?.key || null,
        originalModel: originalModel || null,
        actualModel: requestedModel || null,
        status: 502,
        durationMs: null,
        retried: attempts.length > 1,
        outcome: 'failed',
        reason: attempts.length ? 'all upstream attempts failed' : 'no available upstream candidate'
      });
      persistStats(state, statsPath);

      return jsonResponse(res, 502, {
        error: 'all upstream attempts failed',
        attempts
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return jsonResponse(res, statusCode, { error: error.message });
    }
  });

  server.state = state;
  server.config = config;
  server.healthTimer = healthTimer;
  server.statsPath = statsPath;

  server.on('close', () => {
    if (healthTimer) clearInterval(healthTimer);
    flushStats(state, statsPath);
  });

  server.on('clientError', (error, socket) => {
    logger.warn?.(`[client-error] ${error.message}`);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

export async function loadConfig(configPath = process.env.CODEX_POOL_CONFIG || DEFAULT_CONFIG_PATH) {
  const resolved = path.resolve(configPath);
  if (!existsSync(resolved)) {
    throw new Error(`config file not found: ${resolved}`);
  }
  const raw = await readFile(resolved, 'utf8');
  const config = JSON.parse(raw);
  if (!Array.isArray(config.upstreams) || config.upstreams.length === 0) {
    throw new Error('config.upstreams must contain at least one upstream');
  }
  return { config, configPath: resolved };
}

export async function start(configPath) {
  const loaded = await loadConfig(configPath);
  const config = loaded.config;
  const host = config.server?.host || '127.0.0.1';
  const port = Number(config.server?.port || 8787);
  const server = createPoolServer(config, {
    configPath: loaded.configPath,
    statsPath: path.resolve(path.dirname(loaded.configPath), config.stats?.path || 'stats.local.json')
  });

  server.listen(port, host, () => {
    const authEnv = config.server?.auth_token_env;
    const authMessage = authEnv
      ? process.env[authEnv]
        ? `auth=${authEnv}:${maskSecret(process.env[authEnv])}`
        : `auth=${authEnv}:missing-deny`
      : 'auth=disabled';
    console.log(`[codex-api-pool] listening on http://${host}:${port}${normalizePrefix(config.server?.public_prefix || '/v1')} (${authMessage})`);
    console.log(`[codex-api-pool] config ${loaded.configPath}`);
    for (const upstream of server.state.upstreams) {
      const configuredKeys = upstream.keys.filter((key) => key.value).map((key) => key.label).join(', ') || 'no configured key';
      console.log(`[codex-api-pool] upstream ${upstream.name} -> ${upstream.baseUrl} keys=[${configuredKeys}] weight=${upstream.weight}`);
    }
  });

  const shutdown = () => {
    console.log('[codex-api-pool] shutting down');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start(process.argv[2]).catch((error) => {
    console.error(`[codex-api-pool] failed to start: ${error.stack || error.message}`);
    process.exit(1);
  });
}
