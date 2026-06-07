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

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveKey(entry) {
  if (!entry) return { value: '', label: 'no-auth' };
  if (typeof entry === 'string') return { value: entry, label: maskSecret(entry) };
  if (entry.value) return { value: entry.value, label: entry.label || maskSecret(entry.value) };
  if (entry.env) return { value: process.env[entry.env] || '', label: entry.env };
  return { value: '', label: 'empty-key' };
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
    baseUrl: upstream.base_url,
    siteUrl: deriveSiteUrl(upstream.base_url, upstream.site_url),
    healthPath: typeof upstream.health_path === 'string' ? upstream.health_path : '',
    probeAuth: typeof upstream.probe_auth === 'string' ? upstream.probe_auth : 'bearer',
    probeHeaders: upstream.probe_headers && typeof upstream.probe_headers === 'object' && !Array.isArray(upstream.probe_headers)
      ? { ...upstream.probe_headers }
      : {},
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
      state: 'unknown',
      checkedAt: null,
      latencyMs: 0,
      httpStatus: 0,
      error: '',
      models: [],
      modelsCount: null,
      keyLabel: null
    },
    stats: {
      attempts: 0,
      responses: 0,
      successes: 0,
      failures: 0,
      retries: 0,
      lastUsedAt: null,
      lastStatus: 0
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
    .filter((upstream) => upstream.enabled !== false)
    .map((upstream, index) => createUpstreamState(upstream, index));

  return {
    retry,
    upstreams,
    probing: false,
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
      upstream.quota = { ...upstream.quota, ...(old.quota || {}) };
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
  target.quota = { ...target.quota, ...source.quota };
  if (preserveHealth) target.health = { ...target.health, ...source.health };

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
  return upstream.baseUrl && upstream.cooldownUntil <= at && upstream.keys.some((key) => keyAvailable(key, at));
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

function requestUpstream({ req, body, targetUrl, upstream, key, timeoutMs, allowRetry, retryableStatus }) {
  return new Promise((resolve) => {
    const target = new URL(targetUrl);
    const client = target.protocol === 'https:' ? https : http;
    const startedAt = now();
    let settled = false;

    const headers = sanitizeRequestHeaders(req.headers, key.value, targetUrl);
    headers['content-length'] = body.length;

    const upstreamReq = client.request(
      target,
      {
        method: req.method,
        headers,
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

async function probeOneUpstream(state, upstream, config) {
  const healthConfig = config.health || {};
  const publicPrefix = normalizePrefix(config.server?.public_prefix || '/v1');
  const pathSuffix = upstream.healthPath || healthConfig.path || '/models';
  const timeoutMs = Number(healthConfig.timeout_ms || 10000);
  const key = upstream.keys.find((item) => Boolean(item.value)) || upstream.keys[0];
  const checkedAt = new Date().toISOString();

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
    await mapWithConcurrency(state.upstreams, concurrency, (upstream) => probeOneUpstream(state, upstream, config));
  } catch (error) {
    logger.warn?.(`[health] ${error.message}`);
  } finally {
    state.probing = false;
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
      --ink: #16211b;
      --muted: #657268;
      --paper: #f3ead6;
      --panel: rgba(255, 251, 238, 0.82);
      --line: rgba(22, 33, 27, 0.16);
      --good: #16885a;
      --warn: #b77908;
      --bad: #b43b32;
      --cold: #315f7d;
      --glow: rgba(22, 136, 90, 0.18);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Optima, Candara, "Avenir Next", Verdana, sans-serif;
      background:
        radial-gradient(circle at 14% 18%, rgba(22, 136, 90, 0.18), transparent 28rem),
        radial-gradient(circle at 86% 8%, rgba(183, 121, 8, 0.18), transparent 24rem),
        linear-gradient(135deg, #efe3c6 0%, #f8f0dd 42%, #e9ddc1 100%);
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(22,33,27,.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(22,33,27,.045) 1px, transparent 1px);
      background-size: 34px 34px;
      mask-image: radial-gradient(circle at 50% 20%, black, transparent 78%);
    }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 56px; }
    header { display: grid; grid-template-columns: 1.2fr .8fr; gap: 24px; align-items: end; margin-bottom: 24px; }
    h1 { font-family: Didot, Bodoni 72, Georgia, serif; font-size: clamp(42px, 7vw, 92px); line-height: .86; margin: 0; letter-spacing: -0.07em; }
    .lede { color: var(--muted); font-size: 15px; line-height: 1.65; max-width: 520px; }
    .toolbar { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    button, input, select { font: inherit; }
    a { color: inherit; }
    button {
      border: 1px solid var(--ink);
      color: var(--paper);
      background: var(--ink);
      padding: 10px 14px;
      border-radius: 999px;
      cursor: pointer;
      box-shadow: 0 8px 22px rgba(22,33,27,.16);
      transition: transform .18s ease, box-shadow .18s ease;
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 12px 26px rgba(22,33,27,.22); }
    .ghost { color: var(--ink); background: transparent; }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      backdrop-filter: blur(14px);
      border-radius: 28px;
      box-shadow: 0 24px 80px rgba(77, 62, 35, .16);
    }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 18px; }
    .metric { padding: 18px; position: relative; overflow: hidden; }
    .metric::after { content: ""; position: absolute; right: -24px; top: -28px; width: 86px; height: 86px; border: 1px solid var(--line); border-radius: 999px; }
    .metric b { display: block; font-size: 30px; letter-spacing: -0.05em; }
    .metric span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .16em; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .card { padding: 18px; min-height: 260px; animation: rise .45s ease both; cursor: pointer; transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
    .grid.stable .card { animation: none; }
    .card:hover { transform: translateY(-2px); border-color: rgba(22,33,27,.34); box-shadow: 0 28px 86px rgba(77, 62, 35, .2); }
    .card.editing { border-color: rgba(22, 136, 90, .62); box-shadow: 0 0 0 4px var(--glow), 0 24px 80px rgba(77, 62, 35, .16); }
    @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 14px; }
    .name { font-family: Didot, Bodoni 72, Georgia, serif; font-size: 30px; letter-spacing: -0.05em; word-break: break-word; }
    .url { color: var(--muted); font-size: 12px; word-break: break-all; margin-top: 5px; }
    .card-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
    .pill { border-radius: 999px; border: 1px solid currentColor; padding: 6px 10px; font-size: 12px; white-space: nowrap; }
    .site-link { border: 1px solid var(--ink); border-radius: 999px; padding: 7px 10px; font-size: 12px; text-decoration: none; white-space: nowrap; background: rgba(255,255,255,.26); }
    .site-link:hover { background: var(--ink); color: var(--paper); }
    .probe-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .probe-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .ok { color: var(--good); background: rgba(22,136,90,.08); }
    .warn { color: var(--warn); background: rgba(183,121,8,.1); }
    .bad { color: var(--bad); background: rgba(180,59,50,.1); }
    .cold { color: var(--cold); background: rgba(49,95,125,.1); }
    .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .fact { border: 1px solid var(--line); border-radius: 18px; padding: 11px; background: rgba(255,255,255,.28); }
    .fact small { color: var(--muted); display: block; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
    .fact strong { font-size: 18px; }
    .keys { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
    .key { border: 1px dashed var(--line); border-radius: 999px; padding: 7px 9px; color: var(--muted); font-size: 12px; }
    form { margin-top: 18px; padding: 18px; display: grid; grid-template-columns: 1fr 1.5fr 1.5fr .6fr 1fr auto auto; gap: 10px; align-items: end; }
    .form-mode { grid-column: 1 / -1; color: var(--muted); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
    input, select { width: 100%; border: 1px solid var(--line); background: rgba(255,255,255,.46); border-radius: 16px; padding: 11px 12px; color: var(--ink); outline: none; }
    input:focus, select:focus { border-color: rgba(22,33,27,.42); box-shadow: 0 0 0 4px var(--glow); }
    .model-panel { margin-bottom: 18px; padding: 18px; display: grid; grid-template-columns: minmax(220px, .8fr) 1.2fr auto; gap: 14px; align-items: end; }
    .model-readout { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .requests { margin-top: 18px; padding: 18px; }
    .requests-head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
    .requests-head h2 { margin: 0; font-family: Didot, Bodoni 72, Georgia, serif; font-size: 30px; letter-spacing: -0.04em; }
    .request-list { display: grid; gap: 8px; max-height: 300px; overflow: auto; }
    .request-row { display: grid; grid-template-columns: 1.2fr 1fr 1fr .6fr; gap: 10px; align-items: center; border: 1px solid var(--line); border-radius: 16px; padding: 10px; background: rgba(255,255,255,.28); font-size: 12px; }
    .request-row strong { font-size: 13px; overflow-wrap: anywhere; }
    .request-row small { color: var(--muted); display: block; letter-spacing: .08em; text-transform: uppercase; }
    .models { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; max-height: 112px; overflow: auto; }
    .model-chip { color: var(--ink); background: rgba(255,255,255,.34); border-color: var(--line); box-shadow: none; padding: 7px 9px; font-size: 12px; max-width: 100%; overflow-wrap: anywhere; }
    .model-chip.active { color: var(--paper); background: var(--ink); border-color: var(--ink); }
    .toast { min-height: 22px; margin-top: 12px; color: var(--muted); }
    .empty { padding: 24px; color: var(--muted); }
    @media (max-width: 900px) { header, .summary, .model-panel, .grid, form { grid-template-columns: 1fr; } .toolbar { justify-content: flex-start; } }
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
        <button id="refresh">立即刷新</button>
        <button class="ghost" id="probeAll">重新探测全部</button>
      </div>
    </header>

    <section class="summary">
      <div class="metric panel"><span>Upstreams</span><b id="total">0</b></div>
      <div class="metric panel"><span>Available</span><b id="available">0</b></div>
      <div class="metric panel"><span>Healthy</span><b id="healthy">0</b></div>
      <div class="metric panel"><span>Cooling</span><b id="cooling">0</b></div>
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
    <div id="toast" class="toast"></div>
  </main>

  <script>
    const cards = document.querySelector('#cards');
    const toast = document.querySelector('#toast');
    const modelSelect = document.querySelector('#modelSelect');
    const modelReadout = document.querySelector('#modelReadout');
    const requestList = document.querySelector('#requestList');
    const upstreamForm = document.querySelector('#addForm');
    const formMode = document.querySelector('#formMode');
    const submitUpstream = document.querySelector('#submitUpstream');
    const cancelEdit = document.querySelector('#cancelEdit');
    let editingName = '';
    let upstreamCache = new Map();
    let cardsSignature = '';
    let modelOptionsSignature = '';
    const probingUpstreams = new Set();
    const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    const stateClass = (state) => {
      if (state === 'ok') return 'ok';
      if (state === 'models_unsupported' || state === 'unexpected_status') return 'warn';
      if (state === 'unknown') return 'cold';
      return 'bad';
    };
    const fmt = (value, suffix = '') => value === null || value === undefined || value === '' ? '—' : \`\${value}\${suffix}\`;
    const sortedUpstreams = (items) => [...items].sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0) || String(a.name).localeCompare(String(b.name)));
    const cardSignature = (items, activeModel) => items.map((u) => [
      u.name,
      u.base_url,
      u.site_url || '',
      u.weight,
      (u.keys || []).map((k) => \`\${k.label}:\${k.configured}\`).join(','),
      (u.health?.models || []).join(','),
      activeModel
    ].join('|')).join('||');
    function setText(root, selector, value) {
      const node = root.querySelector(selector);
      if (node) node.textContent = value;
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
      setText(card, '[data-field="req_left"]', fmt(upstream.quota?.requestsRemaining || upstream.quota?.quotaRemaining));
      setText(card, '[data-field="tok_left"]', fmt(upstream.quota?.tokensRemaining));
      card.querySelectorAll('[data-model]').forEach((button) => {
        button.classList.toggle('active', button.dataset.model === activeModel);
      });
      const probeButton = card.querySelector('[data-probe]');
      if (probeButton) {
        const probing = probingUpstreams.has(upstream.name);
        probeButton.disabled = probing;
        probeButton.textContent = probing ? '测试中' : '测试';
      }
    }
    function renderRecentRequests(items) {
      requestList.innerHTML = items.length ? items.map((item) => \`
        <div class="request-row">
          <div><small>Model</small><strong>\${esc(item.originalModel || 'none')} -> \${esc(item.actualModel || 'none')}</strong></div>
          <div><small>Upstream</small><strong>\${esc(item.upstream || 'unknown')}</strong></div>
          <div><small>Status</small><strong>\${esc(item.outcome || '')} · \${esc(item.status ?? 0)} · \${esc(item.durationMs ?? 0)}ms</strong></div>
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model })
      });
      const result = await response.json();
      toast.textContent = response.ok ? (model ? \`已切换模型：\${model}\` : '已清空模型覆盖') : \`切换失败：\${result.error}\`;
      await load();
    }
    async function load() {
      const response = await fetch('/pool/status');
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
        <article class="card panel \${u.name === editingName ? 'editing' : ''}" data-upstream="\${esc(u.name)}" style="animation-delay:\${index * 45}ms">
          <div class="card-head">
            <div><div class="name">\${esc(u.name)}</div><div class="url">\${esc(u.base_url)}</div></div>
            <div class="card-actions">
              <div class="pill \${stateClass(u.health?.state)}" data-field="state">\${esc(u.health?.state || 'unknown')}</div>
              <button class="ghost probe-site" type="button" data-probe="\${esc(u.name)}" \${probingUpstreams.has(u.name) ? 'disabled' : ''}>\${probingUpstreams.has(u.name) ? '测试中' : '测试'}</button>
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
            <div class="fact"><small>Req Left</small><strong data-field="req_left">\${fmt(u.quota?.requestsRemaining || u.quota?.quotaRemaining)}</strong></div>
            <div class="fact"><small>Tok Left</small><strong data-field="tok_left">\${fmt(u.quota?.tokensRemaining)}</strong></div>
          </div>
          <div class="keys">\${(u.keys || []).map(k => \`<span class="key">\${esc(k.label)}: \${esc(k.configured ? k.health?.state || 'ready' : 'missing')}</span>\`).join('')}</div>
          <div class="models">\${(u.health?.models || []).length ? (u.health.models || []).map(model => \`<button class="model-chip \${model === activeModel ? 'active' : ''}" type="button" data-model="\${esc(model)}">\${esc(model)}</button>\`).join('') : '<span class="key">暂无模型列表</span>'}</div>
        </article>\`).join('') : '<div class="empty panel">暂无站点。</div>';
        cardsSignature = nextCardsSignature;
      } else {
        ups.forEach((upstream) => updateCard(upstream, activeModel));
      }
      toast.textContent = \`最后刷新：\${new Date().toLocaleTimeString()}\`;
      markEditingCard();
    }
    async function probeAll() {
      const status = await (await fetch('/pool/status')).json();
      for (const u of status.upstreams || []) {
        await fetch(\`/pool/upstreams/\${encodeURIComponent(u.name)}/probe\`, { method: 'POST' });
      }
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
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/probe\`, { method: 'POST' });
        const result = await response.json();
        toast.textContent = response.ok
          ? \`\${name} 测试完成：\${result.health?.state || 'unknown'}，模型 \${result.health?.modelsCount ?? result.health?.models_count ?? 0} 个\`
          : \`\${name} 测试失败：\${result.error || response.status}\`;
      } catch (error) {
        toast.textContent = \`\${name} 测试失败：\${error.message}\`;
      } finally {
        probingUpstreams.delete(name);
        await load();
      }
    }
    document.querySelector('#refresh').addEventListener('click', load);
    document.querySelector('#probeAll').addEventListener('click', probeAll);
    modelSelect.addEventListener('change', () => setModel(modelSelect.value));
    document.querySelector('#clearModel').addEventListener('click', () => setModel(''));
    cards.addEventListener('click', (event) => {
      const probeButton = event.target.closest('[data-probe]');
      if (probeButton) {
        probeOne(probeButton.dataset.probe || '');
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      toast.textContent = response.ok
        ? \`\${payload.replace ? '已保存' : '已添加'}：\${result.upstream}，探测状态：\${result.health?.state}\`
        : \`\${payload.replace ? '保存失败' : '添加失败'}：\${result.error}\`;
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
  return [...new Set(state.upstreams.flatMap((upstream) => upstream.health?.models || []))]
    .sort((a, b) => a.localeCompare(b));
}

function createStatusPayload(config, state) {
  const at = now();
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
    upstreams: state.upstreams.map((upstream) => ({
      name: upstream.name,
      base_url: upstream.baseUrl,
      site_url: upstream.siteUrl,
      health_path: upstream.healthPath || config.health?.path || '/models',
      probe_auth: upstream.probeAuth,
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
      quota: upstream.quota,
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

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/pool/status' || pathname === '/pool/upstreams')) {
    return jsonResponse(res, 200, createStatusPayload(config, state));
  }

  if (!isAdminAuthorized(req, config)) {
    return jsonResponse(res, 401, { error: 'unauthorized: invalid Codex API pool admin token' });
  }

  if (req.method === 'POST' && pathname === '/pool/probe') {
    await runHealthChecks(state, config);
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
        const targetUrl = joinTargetUrl(upstream.baseUrl, req.url || '/', publicPrefix);
        const allowRetry = attempt < maxAttempts;
        const attemptedModel = requestedModel;
        const body = rewriteModelInBody(req, originalBody, attemptedModel);
        recordAttempt(upstream, key);

        const result = await requestUpstream({ req, body, targetUrl, upstream, key, timeoutMs, allowRetry, retryableStatus: state.retry.retryableStatus });

        if (result.type === 'response') {
          applyQuota(upstream, key, result.response.headers);
          recordResponseStats(upstream, key, result.statusCode, false);
          persistStats(state, statsPath);
          const headers = sanitizeResponseHeaders(result.response.headers, upstream.name);
          res.writeHead(result.statusCode, headers);

          result.response.on('end', () => {
            upstream.inFlight = Math.max(0, upstream.inFlight - 1);
            if (result.statusCode >= 200 && result.statusCode < 400) {
              recordSuccess(upstream, result.startedAt, result.statusCode);
            } else {
              recordFailure(state, upstream, key, `HTTP ${result.statusCode}`, result.statusCode, result.response.headers?.['retry-after']);
            }
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
              outcome: result.statusCode >= 200 && result.statusCode < 400 ? 'ok' : 'error',
              reason: result.statusCode >= 400 ? `HTTP ${result.statusCode}` : ''
            });
            persistStats(state, statsPath);
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

          result.response.pipe(res);
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
    const authMessage = authEnv && process.env[authEnv]
      ? `auth=${authEnv}:${maskSecret(process.env[authEnv])}`
      : 'auth=disabled-or-env-missing';
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
