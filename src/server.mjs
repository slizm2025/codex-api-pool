import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  CHATGPT_CODEX_BASE_URL,
  CODEX_CLI_USER_AGENT,
  CODEX_CLI_VERSION,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_OAUTH_TEST_INSTRUCTIONS
} from './codex-oauth/constants.mjs';
import { codexOauthMetadataFromToken, firstString } from './codex-oauth/jwt.mjs';
import {
  extractCodexOAuthAccountItems,
  looksLikeChatGptAccountExport,
  looksLikeChatGptWebSession,
  normalizeCodexOAuthAccount,
  shouldImportAsCodexOAuthAccounts
} from './codex-oauth/account-import.mjs';
import {
  defaultSecretsPath,
  ensureCodexOAuthConfig,
  importCodexOAuthAccountsIntoConfig,
  loadSecretsSync,
  materializeRuntimeConfig,
  saveSecrets
} from './codex-oauth/account-store.mjs';
import {
  PROTOCOL_CAPABILITY_NAMES,
  NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS,
  ProtocolCapabilityManager,
  emptyProtocolCapability,
  normalizeProtocolCapabilities,
  hasProtocolCapabilityEvidence,
  protocolCapabilityOverridesRestored,
  mergeRestoredProtocolCapabilities,
  normalizeDeclaredProtocolCapabilities,
  initialProtocolCapabilities,
  protocolCapabilityStatus,
  protocolCapabilityStatusFromProbeState,
  protocolCapabilityReason,
  upstreamHasVerifiedProtocolCapability,
  upstreamHasUserDeclaredProtocolCapability,
  shouldRecheckProtocolCapability,
  recordProtocolCapabilityProbe,
  recordProtocolCapabilityRealTraffic
} from './protocol-capability-manager.mjs';
import {
  ProtocolProbeOrchestrator,
  HttpProbeExecutor
} from './protocol-probe-orchestrator.mjs';
import {
  RequestRoutingRules
} from './request-routing-rules.mjs';
import {
  enableDebugLock,
  disableDebugLock,
  isDebugLockActive,
  getDebugLockState,
  buildProtocolAttemptSequence,
  shouldFallbackToNextProtocol,
  buildDebugAttemptDiagnostics,
  addDebugLockHeaders
} from './debug-lock.mjs';
import {
  deriveVerificationTier,
  deriveVerificationDetail
} from './verification-tier.mjs';
import {
  normalizeAvailability as normalizeLayeredAvailability,
  recordAvailabilityAttempt,
  getProtocolAvailabilityMultiplier
} from './protocol-availability.mjs';
import {
  deriveRecordingProtocol
} from './recording-protocol.mjs';
import {
  isUpstreamInProtocolCooldown,
  applyProtocolCooldown,
  clearProtocolCooldown,
  clearExpiredCooldowns as clearExpiredProtocolCooldowns
} from './protocol-cooldown.mjs';

const DEFAULT_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.local.json');
const DEFAULT_RETRYABLE_STATUS = [400, 401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524];
const KEY_SCOPED_FAILURE_STATUS = new Set([401, 403, 429]);
const DEFAULT_NATIVE_RESPONSES_RECHECK_MS = 30 * 60 * 1000;
const STREAM_ERROR_STATUS = 502;
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
const CLIENT_AUTH_HEADERS = new Set([
  'x-api-key',
  'api-key',
  'anthropic-version',
  'anthropic-beta',
  'openai-organization',
  'openai-project'
]);
const MAX_USAGE_CAPTURE_BYTES = 50 * 1024 * 1024;
const DEFAULT_BILLING_LARGE_LIMIT_THRESHOLD = 10_000_000;
const DEFAULT_AVAILABILITY_WINDOW_SIZE = 50;
const DEFAULT_AVAILABILITY_MIN_SAMPLES = 10;
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 15000;
const BROWSER_LIKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_CLAUDE_CLI_ANTHROPIC_BETA = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'redact-thinking-2026-02-12',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'effort-2025-11-24',
  'context-1m-2025-08-07'
].join(',');
const STRIPPABLE_RESPONSES_INPUT_ITEM_TYPES = new Set(['reasoning']);
const RESPONSE_COMPATIBILITY_SCRUB_FIELDS = [
  'previous_response_id',
  'include',
  'truncation',
  'background',
  'conversation',
  'context_management',
  'prompt',
  'moderation',
  'max_tool_calls'
];
const RESPONSE_COMPATIBILITY_CHAT_TEXT_VERBOSITY_FIELD = 'text.verbosity';
function now() {
  return Date.now();
}

function localDateTimeString(timestamp = now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const tzOffset = -date.getTimezoneOffset();
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
  const tzMinutes = String(Math.abs(tzOffset) % 60).padStart(2, '0');
  const tzSign = tzOffset >= 0 ? '+' : '-';
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${tzSign}${tzHours}:${tzMinutes}`;
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

function normalizeProxyUrl(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:') return '';
    return parsed.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy.username && !proxy.password) return '';
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
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
    if (CLIENT_AUTH_HEADERS.has(lower)) continue;
    if (lower === 'host') continue;
    if (lower === 'authorization') continue;
    out[name] = value;
  }
  out.host = target.host;
  if (upstreamKey) out.authorization = `Bearer ${upstreamKey}`;
  return out;
}

function captureIncomingRequestHeaders(config, headers = {}) {
  if (config.debug?.capture_request_headers !== true) return undefined;
  // Capture ALL headers without filtering when debug mode is enabled
  const captured = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    captured[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return captured;
}

function requestDebugFields(incomingHeaders, incomingBody) {
  const fields = {};
  if (incomingHeaders) fields.incomingHeaders = incomingHeaders;
  if (incomingBody !== undefined) {
    try {
      // Convert Buffer to string first, then parse JSON
      const bodyString = Buffer.isBuffer(incomingBody)
        ? incomingBody.toString('utf8')
        : String(incomingBody);
      fields.incomingBody = JSON.parse(bodyString);
    } catch {
      // If not JSON or parsing fails, store as string
      fields.incomingBody = Buffer.isBuffer(incomingBody)
        ? incomingBody.toString('utf8')
        : incomingBody;
    }
  }
  return fields;
}

function stripRequestDebugFields(requests = []) {
  return requests.map(({ incomingHeaders, incomingBody, ...request }) => request);
}

function isCodexCliUserAgent(value) {
  return /\bcodex_cli(?:_rs)?\//i.test(String(value || ''));
}

function headerValueCaseInsensitive(headers = {}, names = []) {
  const wanted = new Set(names.map((name) => String(name || '').toLowerCase()));
  for (const [name, value] of Object.entries(headers || {})) {
    if (!wanted.has(String(name || '').toLowerCase())) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function setHeaderCaseInsensitive(headers, name, value) {
  if (value === undefined || value === null) return;
  const normalized = String(name || '').toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === normalized) delete headers[existing];
  }
  headers[name] = String(value);
}

function isResponsesCompactUrl(targetUrl) {
  try {
    const pathname = new URL(targetUrl).pathname.replace(/\/+$/, '');
    return pathname.endsWith('/responses/compact') || pathname.includes('/responses/compact/');
  } catch {
    return false;
  }
}

function buildCodexOAuthRequestHeaders(targetUrl, keyValue, incomingHeaders = {}, extraHeaders = {}) {
  const target = new URL(targetUrl);
  const allowed = new Set([
    'accept',
    'accept-language',
    'content-type',
    'conversation_id',
    'openai-beta',
    'user-agent',
    'originator',
    'session_id',
    'x-codex-turn-state',
    'x-codex-turn-metadata'
  ]);
  const headers = { host: target.host };
  for (const [name, value] of Object.entries(incomingHeaders || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || !allowed.has(lower)) continue;
    headers[name] = value;
  }
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    if (value !== undefined && value !== null) headers[name] = String(value);
  }
  if (keyValue) headers.authorization = `Bearer ${keyValue}`;
  if (!headers.accept) headers.accept = isResponsesCompactUrl(targetUrl) ? 'application/json' : 'text/event-stream';
  if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
  if (!headers['OpenAI-Beta'] && !headers['openai-beta']) headers['OpenAI-Beta'] = 'responses=experimental';
  if (!headers.originator && !headers.Originator) headers.originator = 'codex_cli_rs';
  const userAgent = headers['user-agent'] || headers['User-Agent'];
  if (!isCodexCliUserAgent(userAgent)) headers['user-agent'] = CODEX_CLI_USER_AGENT;
  if (isResponsesCompactUrl(targetUrl) && !headers.version && !headers.Version) headers.version = CODEX_CLI_VERSION;
  return headers;
}

function codexOAuthExtraHeaders(upstream) {
  const headers = { ...(upstream?.probeHeaders || {}) };
  if (upstream?.chatGptAccountId && !headers['chatgpt-account-id'] && !headers['ChatGPT-Account-ID']) {
    headers['chatgpt-account-id'] = upstream.chatGptAccountId;
  }
  return headers;
}

function responsesRequestPathSuffix(incomingUrl) {
  const incoming = new URL(incomingUrl || '/', 'http://codex-api-pool.local');
  const normalizedPath = incoming.pathname.trim().replace(/\/+$/, '');
  const index = normalizedPath.lastIndexOf('/responses');
  if (index < 0) return incoming.search || '';
  const suffix = normalizedPath.slice(index + '/responses'.length);
  return `${suffix && suffix.startsWith('/') ? suffix : ''}${incoming.search || ''}`;
}

function codexOAuthTargetUrl(baseUrl, incomingUrl, publicPrefix) {
  const base = baseUrl.replace(/\/$/, '');
  try {
    const parsed = new URL(base);
    if (parsed.pathname.replace(/\/+$/, '').endsWith('/responses')) {
      return `${base}${responsesRequestPathSuffix(incomingUrl)}`;
    }
  } catch {
    // Fall back to the normal prefix-stripping join below.
  }
  return joinTargetUrl(base, incomingUrl || '/', publicPrefix);
}

function ignoreLateSocketError() {}

function guardLateSocketErrors(socket) {
  try {
    if (!socket?.on || !socket.listeners) return socket;
    if (!socket.listeners('error').includes(ignoreLateSocketError)) {
      socket.on('error', ignoreLateSocketError);
    }
  } catch {
    // Some Node wrappers restrict direct socket inspection; caller-level error
    // handlers still receive normal request/session failures.
  }
  return socket;
}

function openHttpProxyTunnel(proxyUrl, targetHostInput, targetPortInput, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const targetPort = Number(targetPortInput || 443);
    const rawTargetHost = String(targetHostInput || '').trim();
    const targetHost = rawTargetHost.startsWith('[')
      ? rawTargetHost.replace(/^\[|\](?::\d+)?$/g, '')
      : rawTargetHost.replace(/:\d+$/, '');
    let finished = false;
    let response = Buffer.alloc(0);

    const fail = (error) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      reject(error);
    };

    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port || 80)
    });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail(new Error(`proxy CONNECT timeout after ${timeoutMs}ms`)));
    socket.once('error', fail);
    socket.once('connect', () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Proxy-Connection: Keep-Alive'
      ];
      const proxyAuth = proxyAuthorizationHeader(proxy);
      if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });

    socket.on('data', (chunk) => {
      if (finished) return;
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = response.subarray(0, headerEnd).toString('latin1');
      const status = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] || 0);
      if (status < 200 || status >= 300) {
        fail(new Error(`proxy CONNECT failed with HTTP ${status || 'unknown'}`));
        return;
      }

      finished = true;
      socket.removeAllListeners('data');
      socket.removeAllListeners('timeout');
      socket.removeAllListeners('error');
      const rest = response.subarray(headerEnd + 4);
      if (rest.length) socket.unshift(rest);

      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        ALPNProtocols: ['h2', 'http/1.1']
      });
      guardLateSocketErrors(tlsSocket);
      let tlsSettled = false;
      tlsSocket.once('secureConnect', () => {
        if (tlsSettled) return;
        tlsSettled = true;
        resolve(tlsSocket);
      });
      tlsSocket.on('error', (error) => {
        if (tlsSettled) return;
        tlsSettled = true;
        reject(error);
      });
    });

  });
}

function guardHttp2SessionSocket(session) {
  guardLateSocketErrors(session?.socket);
  return session;
}

function createHttpProxyTunnel(proxyUrl, timeoutMs) {
  return (connectOptions, callback) => {
    openHttpProxyTunnel(
      proxyUrl,
      connectOptions.hostname || connectOptions.host,
      connectOptions.port || 443,
      timeoutMs
    ).then((socket) => {
      guardLateSocketErrors(socket);
      callback(null, socket);
      setImmediate(() => guardLateSocketErrors(socket));
    }, callback);
    return undefined;
  };
}

function requestOptionsForTarget(targetUrl, method, headers, timeoutMs, proxyUrl = '') {
  const target = new URL(targetUrl);
  const normalizedProxy = normalizeProxyUrl(proxyUrl);
  if (!normalizedProxy) {
    return {
      client: target.protocol === 'https:' ? https : http,
      target,
      options: { method, headers, timeout: timeoutMs }
    };
  }

  const proxy = new URL(normalizedProxy);
  if (target.protocol === 'http:') {
    const proxyHeaders = { ...headers, host: target.host };
    const proxyAuth = proxyAuthorizationHeader(proxy);
    if (proxyAuth) proxyHeaders['proxy-authorization'] = proxyAuth;
    return {
      client: http,
      target: proxy,
      options: {
        method,
        path: target.href,
        headers: proxyHeaders,
        timeout: timeoutMs
      }
    };
  }

  return {
    client: https,
    target,
    options: {
      method,
      headers,
      timeout: timeoutMs,
      createConnection: createHttpProxyTunnel(normalizedProxy, timeoutMs)
    }
  };
}

async function openHttp2Session(target, proxyUrl, timeoutMs) {
  const normalizedProxy = normalizeProxyUrl(proxyUrl);
  const origin = target.origin;
  if (!normalizedProxy) {
    return guardHttp2SessionSocket(http2.connect(origin));
  }
  const socket = await openHttpProxyTunnel(normalizedProxy, target.hostname, target.port || 443, timeoutMs);
  return guardHttp2SessionSocket(http2.connect(origin, {
    createConnection: () => socket
  }));
}

function http2HeadersForTarget(target, method, headers = {}) {
  const out = {
    ':method': method,
    ':scheme': target.protocol.replace(':', ''),
    ':authority': target.host,
    ':path': `${target.pathname}${target.search}`
  };
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
    out[lower] = value;
  }
  return out;
}

function requestHttp2Upstream({ body, targetUrl, upstream, key, timeoutMs, allowRetry, retryableStatus, method, headers }) {
  return new Promise((resolve) => {
    const target = new URL(targetUrl);
    const startedAt = now();
    let settled = false;
    let session = null;
    let stream = null;

    const finishRetry = (statusCode, responseHeaders, reason, retryAfter) => {
      if (settled) return;
      settled = true;
      session?.close();
      resolve({ type: 'retry', statusCode, retryAfter, headers: responseHeaders || {}, reason, startedAt });
    };

    openHttp2Session(target, upstream.proxyUrl, timeoutMs).then((openedSession) => {
      if (settled) {
        openedSession.close();
        return;
      }
      session = openedSession;
      session.setTimeout(timeoutMs, () => {
        stream?.close(http2.constants.NGHTTP2_CANCEL);
        session.close();
        finishRetry(0, {}, `timeout after ${timeoutMs}ms`);
      });
      session.once('error', (error) => finishRetry(0, {}, error.message));

      stream = session.request(http2HeadersForTarget(target, method || 'POST', headers));
      stream.setTimeout(timeoutMs, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        finishRetry(0, {}, `timeout after ${timeoutMs}ms`);
      });

      stream.once('response', (responseHeaders) => {
        const statusCode = Number(responseHeaders[':status'] || 502);
        const headersOut = { ...responseHeaders };
        delete headersOut[':status'];
        const retryAfter = headersOut['retry-after'];

        if (allowRetry && retryableStatus.has(statusCode)) {
          const chunks = [];
          let total = 0;
          stream.on('data', (chunk) => {
            if (total >= 4096) return;
            const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const available = Math.max(0, 4096 - total);
            chunks.push(next.subarray(0, available));
            total += Math.min(next.length, available);
          });
          stream.once('end', () => {
            const bodyText = chunks.length ? Buffer.concat(chunks, total).toString('utf8').trim() : '';
            const reason = bodyText ? `HTTP ${statusCode}: ${bodyText.slice(0, 1000)}` : `HTTP ${statusCode}`;
            finishRetry(statusCode, headersOut, reason, retryAfter);
          });
          return;
        }

        if (settled) return;
        settled = true;
        const response = new PassThrough();
        response.headers = headersOut;
        response.statusCode = statusCode;
        response.once('close', () => session?.close());
        stream.on('data', (chunk) => response.write(chunk));
        stream.once('end', () => response.end());
        stream.once('error', (error) => response.destroy(error));
        resolve({ type: 'response', response, statusCode, startedAt });
      });

      stream.once('error', (error) => finishRetry(0, {}, error.message));
      stream.end(body);
    }, (error) => finishRetry(0, {}, error.message));
  });
}

function probeHttp2(targetUrl, body, headers, upstream, timeoutMs) {
  return new Promise((resolve) => {
    const target = new URL(targetUrl);
    const startedAt = now();
    let settled = false;
    let session = null;
    const chunks = [];
    let bodySize = 0;
    let bodyTooLarge = false;

    const finish = (statusCode, responseHeaders = {}, error = '') => {
      if (settled) return;
      settled = true;
      session?.close();
      const responseBody = bodyTooLarge ? '' : decodeHttpBody(chunks, bodySize, responseHeaders);
      resolve(probeResult(
        statusCode || 0,
        now() - startedAt,
        responseBody,
        bodyTooLarge ? 'response body too large' : error,
        responseHeaders['retry-after'],
        responseHeaders
      ));
    };

    openHttp2Session(target, upstream.proxyUrl, timeoutMs).then((openedSession) => {
      session = openedSession;
      session.setTimeout(timeoutMs, () => finish(0, {}, `timeout after ${timeoutMs}ms`));
      session.once('error', (error) => finish(0, {}, error.message));
      const stream = session.request(http2HeadersForTarget(target, 'POST', headers));
      stream.setTimeout(timeoutMs, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        finish(0, {}, `timeout after ${timeoutMs}ms`);
      });
      stream.once('response', (responseHeaders) => {
        const statusCode = Number(responseHeaders[':status'] || 0);
        const headersOut = { ...responseHeaders };
        delete headersOut[':status'];
        stream.on('data', (chunk) => {
          if (bodyTooLarge) return;
          bodySize += chunk.length;
          if (bodySize > 128 * 1024) {
            bodyTooLarge = true;
            chunks.length = 0;
            bodySize = 0;
            return;
          }
          chunks.push(chunk);
        });
        stream.once('end', () => finish(statusCode, headersOut));
      });
      stream.once('error', (error) => finish(0, {}, error.message));
      stream.end(body);
    }, (error) => finish(0, {}, error.message));
  });
}

function buildAnthropicRequestHeaders(targetUrl, keyValue, incomingHeaders = {}, extraHeaders = {}) {
  const target = new URL(targetUrl);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    host: target.host
  };
  if (keyValue) headers['x-api-key'] = keyValue;

  // Use Claude CLI compatible User-Agent
  const incomingUserAgent = headerValueCaseInsensitive(extraHeaders, ['user-agent'])
    || headerValueCaseInsensitive(incomingHeaders, ['user-agent']);

  // If incoming request has a Claude CLI user-agent, preserve it; otherwise use it by default
  if (incomingUserAgent && incomingUserAgent.includes('claude-cli')) {
    headers['user-agent'] = incomingUserAgent;
  } else {
    headers['user-agent'] = 'claude-cli/2.1.177 (external, cli)';
  }

  headers['anthropic-version'] = extraHeaders['anthropic-version']
    || extraHeaders['Anthropic-Version']
    || incomingHeaders['anthropic-version']
    || incomingHeaders['Anthropic-Version']
    || '2023-06-01';

  const beta = extraHeaders['anthropic-beta']
    || extraHeaders['Anthropic-Beta']
    || incomingHeaders['anthropic-beta']
    || incomingHeaders['Anthropic-Beta']
    || DEFAULT_CLAUDE_CLI_ANTHROPIC_BETA;
  if (beta) headers['anthropic-beta'] = beta;

  // Add Claude CLI specific headers
  headers['anthropic-dangerous-direct-browser-access'] =
    extraHeaders['anthropic-dangerous-direct-browser-access']
    || incomingHeaders['anthropic-dangerous-direct-browser-access']
    || 'true';

  headers['x-app'] =
    extraHeaders['x-app']
    || incomingHeaders['x-app']
    || 'cli';

  return headers;
}

function buildProbeHeaders(targetUrl, keyValue, authType = 'bearer', extraHeaders = {}) {
  const target = new URL(targetUrl);
  const headers = {
    accept: 'application/json',
    host: target.host,
    'user-agent': BROWSER_LIKE_USER_AGENT
  };
  const type = String(authType || 'bearer').toLowerCase();
  if (keyValue && type === 'anthropic') {
    // Use Claude CLI compatible headers for Anthropic probes
    headers['x-api-key'] = keyValue;
    headers['user-agent'] = 'claude-cli/2.1.177 (external, cli)';
    headers['anthropic-version'] = extraHeaders['anthropic-version'] || extraHeaders['Anthropic-Version'] || '2023-06-01';
    headers['anthropic-beta'] = extraHeaders['anthropic-beta'] || DEFAULT_CLAUDE_CLI_ANTHROPIC_BETA;
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    headers['x-app'] = 'cli';
  } else if (keyValue && type !== 'none') {
    headers.authorization = `Bearer ${keyValue}`;
  }
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    setHeaderCaseInsensitive(headers, name, value);
  }
  return headers;
}

function decodeHttpBody(chunks, size, headers = {}) {
  const buffer = Buffer.concat(chunks, size);
  const encoding = String(firstHeader(headers, ['content-encoding']) || '').toLowerCase().trim();
  try {
    if (encoding.includes('gzip')) return zlib.gunzipSync(buffer).toString('utf8');
    if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer).toString('utf8');
    if (encoding.includes('deflate')) return zlib.inflateSync(buffer).toString('utf8');
  } catch {
    return buffer.toString('utf8');
  }
  return buffer.toString('utf8');
}

function probeResult(statusCode, latencyMs, body = '', error = '', retryAfter = undefined, headers = {}) {
  return { statusCode, latencyMs, body, error, retryAfter, headers };
}

function probeUpstreamResultPayload(result) {
  if (!result) return undefined;
  return {
    status_code: Number(result.statusCode || 0),
    latency_ms: Number(result.latencyMs || 0),
    headers: result.headers || {},
    body: String(result.body || ''),
    error: result.error || '',
    retry_after: result.retryAfter
  };
}

function probeUpstreamErrorPayload(result) {
  if (!result) return undefined;
  const parts = responseErrorParts(result);
  const message = parts.message || result.error || String(result.body || '').trim();
  return {
    code: parts.code || '',
    message,
    status_code: Number(result.statusCode || 0),
    transport_error: result.error || ''
  };
}

function probeHealthDebugPayload(health, result) {
  if (!health || health.state === 'ok' || !result) return health;
  return {
    ...health,
    api_pool_error: health.error || '',
    upstream_error: probeUpstreamErrorPayload(result),
    upstream_result: probeUpstreamResultPayload(result)
  };
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

function anthropicErrorResponse(res, statusCode, errorType, message) {
  const payload = {
    type: 'error',
    error: {
      type: errorType,
      message: message
    }
  };
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length
  });
  res.end(body);
}

function errorDisplay({ layer, category, severity = 'blocked', title, message, action = '' }) {
  return {
    layer,
    category,
    severity,
    title,
    message,
    action
  };
}

function noUpstreamsConfiguredDisplay() {
  return errorDisplay({
    layer: 'configuration',
    category: 'no_upstreams_configured',
    title: 'No Upstreams configured',
    message: 'No Upstreams are configured in the Pool Configuration.',
    action: 'Add at least one enabled Upstream with a configured Upstream Key.'
  });
}

function noAvailableCandidateDisplay() {
  return errorDisplay({
    layer: 'configuration',
    category: 'no_available_candidate',
    title: 'No available Upstream candidate',
    message: 'Selection could not find an enabled Upstream with an available Upstream Key for this request.',
    action: 'Check Disabled Upstreams, missing Upstream Keys, Cooldown, Health State, and Model Override compatibility.'
  });
}

function upstreamFailureDisplay(attempt = {}) {
  const status = Number(attempt?.status || 0);
  const reason = String(attempt?.reason || '');
  const upstream = attempt?.upstream ? `Upstream ${attempt.upstream}` : 'The selected Upstream';
  if (status === 429 || /rate.?limit|quota|retry-after/i.test(reason)) {
    return errorDisplay({
      layer: 'upstream',
      category: 'rate_limit',
      severity: 'retryable',
      title: 'Upstream rate limit',
      message: `${upstream} rejected the request with a rate limit response${status ? ` (HTTP ${status})` : ''}.`,
      action: 'Wait for Retry-After or Cooldown to expire, reduce request rate, or enable another compatible Upstream.'
    });
  }
  if (status === 0 && /timeout|timed out/i.test(reason)) {
    return errorDisplay({
      layer: 'upstream',
      category: 'timeout',
      severity: 'retryable',
      title: 'Upstream timeout',
      message: `${upstream} did not respond before the API Pool request timeout.`,
      action: 'Check upstream latency, proxy/network connectivity, or increase request_timeout_ms if appropriate.'
    });
  }
  if (status === 0) {
    return errorDisplay({
      layer: 'upstream',
      category: 'network',
      severity: 'retryable',
      title: 'Upstream network error',
      message: `${upstream} could not be reached by the API Pool.`,
      action: 'Check DNS, TLS, proxy settings, and upstream base_url connectivity.'
    });
  }
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid[_ -]?api[_ -]?key|permission/i.test(reason)) {
    return errorDisplay({
      layer: 'upstream',
      category: 'auth',
      title: 'Upstream authentication failed',
      message: `${upstream} rejected the configured Upstream Key${status ? ` (HTTP ${status})` : ''}.`,
      action: 'Verify the Upstream Key, account permissions, and auth mode for this Upstream.'
    });
  }
  if (status >= 500 || (status >= 521 && status <= 524)) {
    return errorDisplay({
      layer: 'upstream',
      category: 'server',
      severity: 'retryable',
      title: 'Upstream server error',
      message: `${upstream} returned a server-side failure${status ? ` (HTTP ${status})` : ''}.`,
      action: 'Try again later, check the upstream status page, or enable another compatible Upstream.'
    });
  }
  return errorDisplay({
    layer: 'upstream',
    category: 'unknown',
    severity: 'degraded',
    title: 'Upstream request failed',
    message: `${upstream} failed this request${status ? ` (HTTP ${status})` : ''}.`,
    action: 'Inspect the attempt reason and upstream diagnostics for details.'
  });
}

function requestCompatibilityDisplay() {
  return errorDisplay({
    layer: 'compatibility',
    category: 'request_compatibility',
    title: 'Native Responses Route required',
    message: 'This request contains Responses-only Features that require a Native Responses Route, but no compatible Upstream is currently available.',
    action: 'Enable a native /v1/responses Upstream, remove the Responses-only Features, or enable Adapter Compatibility Mode when lossy conversion is acceptable.'
  });
}

function requestFailureDisplay({ attempts = [], nativeResponsesFailure = false } = {}) {
  if (nativeResponsesFailure) return requestCompatibilityDisplay();
  const lastAttempt = attempts[attempts.length - 1] || null;
  return lastAttempt ? upstreamFailureDisplay(lastAttempt) : noAvailableCandidateDisplay();
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

function requestHasJsonContentType(req) {
  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  return contentType.includes('application/json') || /application\/[^;\s]+\+json\b/.test(contentType);
}

function bodyLooksJsonLike(body) {
  if (!body || body.length === 0) return false;
  const text = body.toString('utf8').trimStart();
  return text.startsWith('{') || text.startsWith('[');
}

function jsonObjectFromRequestBody(req, body, options = {}) {
  if (!body || body.length === 0) return null;
  const inferJsonLike = options.inferJsonLike === true;
  if (!requestHasJsonContentType(req) && !(inferJsonLike && bodyLooksJsonLike(body))) return null;
  try {
    const payload = JSON.parse(body.toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function buildJsonRequestHeaders(targetUrl, keyValue, incomingHeaders = {}) {
  const headers = sanitizeRequestHeaders(incomingHeaders, keyValue, targetUrl);
  for (const name of Object.keys(headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName === 'content-type' || lowerName === 'content-length') {
      delete headers[name];
    }
  }
  headers['content-type'] = 'application/json';
  // Note: content-length will be set automatically by http.request based on the body
  return headers;
}

function codexResponsesProbeIncomingHeaders() {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': CODEX_CLI_USER_AGENT,
    originator: 'codex_cli_rs',
    'openai-beta': 'responses=experimental'
  };
}

function codexResponsesProbePayload(model) {
  return {
    model,
    instructions: CODEX_OAUTH_TEST_INSTRUCTIONS,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Health check: reply with exactly "ok".' }
        ]
      },
      {
        type: 'reasoning',
        summary: [
          { type: 'summary_text', text: 'Codex API Pool health probe.' }
        ]
      }
    ],
    stream: false,
    max_output_tokens: 64,
    tool_choice: 'none',
    metadata: {
      codex_api_pool_probe: 'health'
    }
  };
}

const REPRESENTATIVE_TEMPLATE_TTL_MS = 30 * 60 * 1000;
const REPRESENTATIVE_EVIDENCE_TTL_MS = 30 * 60 * 1000;
const FRESH_REPRESENTATIVE_EVIDENCE_MULTIPLIER = 1.15;
const REPRESENTATIVE_REPLAY_RISK_HEADER_PATTERN = /(?:attestation|nonce|signature|signed|token|turn|metadata|state|session|request[-_]?id|idempotency|trace|challenge|csrf)/i;

function codexClientFamilyFromHeaders(headers = {}) {
  const originator = String(headers.originator || headers.Originator || '').trim().toLowerCase();
  const userAgent = String(headers['user-agent'] || headers['User-Agent'] || '').trim().toLowerCase();
  if (originator === 'codex desktop' || userAgent.includes('codex desktop/')) return 'codex_desktop';
  return '';
}

function representativeTemplateFresh(template, at = now()) {
  return Boolean(template && Number(template.expiresAt || 0) > at);
}

function representativeTemplateKey(protocol, clientFamily) {
  return `${protocol}:${clientFamily}`;
}

function representativeHeaderAllowed(name) {
  const lower = String(name || '').toLowerCase();
  return lower === 'accept' ||
    lower === 'accept-language' ||
    lower === 'content-type' ||
    lower === 'openai-beta' ||
    lower === 'originator' ||
    lower === 'user-agent' ||
    lower === 'x-codex-turn-state' ||
    lower === 'x-codex-turn-metadata' ||
    lower.startsWith('x-oai-');
}

function sanitizeRepresentativeHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = String(name || '').toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower === 'set-cookie' || lower === 'content-length') continue;
    if (!representativeHeaderAllowed(lower)) continue;
    if (Array.isArray(value)) out[lower] = value.join(', ');
    else if (value !== undefined && value !== null) out[lower] = String(value);
  }
  if (!out.accept) out.accept = 'application/json';
  if (!out['content-type']) out['content-type'] = 'application/json';
  return out;
}

function representativeTemplateReplayRisk(template) {
  const fields = [];
  for (const name of Object.keys(template?.headers || {})) {
    if (REPRESENTATIVE_REPLAY_RISK_HEADER_PATTERN.test(name)) fields.push(`headers.${name}`);
  }
  return {
    present: fields.length > 0,
    fields
  };
}

function captureRepresentativeRequestTemplate(state, { req, pathname, body, model, options = {} } = {}) {
  if (!state || pathname !== '/v1/responses') return null;
  const clientFamily = codexClientFamilyFromHeaders(req?.headers || {});
  if (clientFamily !== 'codex_desktop') return null;
  const payload = jsonObjectFromRequestBody(req, body, options);
  if (!payload) return null;
  const capturedAtMs = now();
  const sanitizedHeaders = sanitizeRepresentativeHeaders(req.headers);
  const template = {
    protocol: 'responses',
    clientFamily,
    capturedAt: new Date(capturedAtMs).toISOString(),
    capturedAtMs,
    expiresAt: capturedAtMs + REPRESENTATIVE_TEMPLATE_TTL_MS,
    model: String(model || payload.model || '').trim(),
    headers: Object.fromEntries(Object.keys(sanitizedHeaders).map((name) => [name, 'redacted']))
  };
  state.representativeTemplates.set(representativeTemplateKey('responses', clientFamily), template);
  return template;
}

function representativeTemplatesPayload(state, at = now()) {
  const out = {};
  for (const [key, template] of state?.representativeTemplates || []) {
    const [protocol, clientFamily] = key.split(':');
    if (!protocol || !clientFamily) continue;
    if (!out[protocol]) out[protocol] = {};
    out[protocol][clientFamily] = {
      fresh: representativeTemplateFresh(template, at),
      captured_at: template.capturedAt,
      expires_in_ms: Math.max(0, Number(template.expiresAt || 0) - at),
      model: template.model || '',
      replay_risk: representativeTemplateReplayRisk(template),
      headers: Object.fromEntries(Object.keys(template.headers || {}).map((name) => [name, 'redacted']))
    };
  }
  return out;
}

function ensureRepresentativeEvidence(key) {
  if (!key.representativeEvidence || typeof key.representativeEvidence !== 'object' || Array.isArray(key.representativeEvidence)) {
    key.representativeEvidence = {};
  }
  return key.representativeEvidence;
}

function recordRepresentativeSuccessEvidence(key, protocol, {
  model = '',
  source = '',
  checkedAt = new Date().toISOString(),
  httpStatus = 0
} = {}) {
  if (!key || !protocol) return;
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) return;
  const evidence = ensureRepresentativeEvidence(key);
  if (!evidence[protocol] || typeof evidence[protocol] !== 'object' || Array.isArray(evidence[protocol])) evidence[protocol] = {};
  evidence[protocol][normalizedModel] = {
    source: String(source || ''),
    checked_at: checkedAt,
    expires_at: new Date(Date.parse(checkedAt) + REPRESENTATIVE_EVIDENCE_TTL_MS).toISOString(),
    http_status: Number(httpStatus || 0) || 0
  };
}

function representativeEvidenceFresh(item, at = now()) {
  const expiresAt = Date.parse(item?.expires_at || '');
  return Number.isFinite(expiresAt) && expiresAt > at;
}

function representativeEvidencePayload(value = {}, at = now()) {
  const out = {};
  for (const [protocol, byModel] of Object.entries(value || {})) {
    if (!byModel || typeof byModel !== 'object' || Array.isArray(byModel)) continue;
    out[protocol] = {};
    for (const [model, item] of Object.entries(byModel)) {
      out[protocol][model] = {
        ...item,
        fresh: representativeEvidenceFresh(item, at),
        expires_in_ms: Math.max(0, Date.parse(item?.expires_at || '') - at) || 0
      };
    }
  }
  return out;
}

function representativeAvailability(upstream, {
  model = '',
  protocol = 'responses',
  at = now()
} = {}) {
  const normalizedModel = String(model || '').trim();
  const evidence = [];
  for (const key of upstream?.keys || []) {
    const byModel = key?.representativeEvidence?.[protocol] || {};

    if (normalizedModel) {
      // Specific model: collect evidence for that model only
      const item = byModel[normalizedModel];
      if (!item) continue;
      const checkedAtMs = Date.parse(item.checked_at || '');
      evidence.push({
        keyLabel: key.label || '',
        source: String(item.source || ''),
        checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
        fresh: representativeEvidenceFresh(item, at)
      });
    } else {
      // No model specified: aggregate evidence across ALL models
      for (const [modelName, item] of Object.entries(byModel)) {
        if (!item) continue;
        const checkedAtMs = Date.parse(item.checked_at || '');
        evidence.push({
          keyLabel: key.label || '',
          modelName: modelName,
          source: String(item.source || ''),
          checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
          fresh: representativeEvidenceFresh(item, at)
        });
      }
    }
  }
  const freshEvidence = evidence.filter((item) => item.fresh);
  const latest = evidence
    .slice()
    .sort((a, b) => b.checkedAtMs - a.checkedAtMs)[0];
  const state = freshEvidence.length > 0
    ? 'fresh'
    : evidence.length > 0
      ? 'stale'
      : 'missing';
  return {
    protocol,
    model: normalizedModel,
    aggregated: !normalizedModel,
    state,
    verified: freshEvidence.length > 0,
    fresh_evidence_count: freshEvidence.length,
    evidence_count: evidence.length,
    sources: [...new Set(freshEvidence.map((item) => item.source).filter(Boolean))].sort(),
    latest_checked_at: latest?.checkedAtMs ? new Date(latest.checkedAtMs).toISOString() : '',
    multiplier: state === 'fresh' ? FRESH_REPRESENTATIVE_EVIDENCE_MULTIPLIER : 1
  };
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

function rewriteModelInBody(req, body, model, options = {}) {
  if (!model || body.length === 0) return body;
  const payload = jsonObjectFromRequestBody(req, body, options);
  if (!payload) return body;
  payload.model = model;
  return Buffer.from(JSON.stringify(payload));
}

function modelFromBody(req, body, options = {}) {
  if (body.length === 0) return '';
  const payload = jsonObjectFromRequestBody(req, body, options);
  return typeof payload?.model === 'string' ? payload.model : '';
}

function normalizeModelSuffix(value) {
  return String(value || '').trim();
}

// Forward mapping: strip an Upstream Model Suffix from a Discovered Model so
// Selection and diagnostics use the standard model name (e.g. claude-opus-4-8-cc -> claude-opus-4-8).
function stripUpstreamModelSuffix(model, suffix) {
  const name = String(model || '');
  const tail = normalizeModelSuffix(suffix);
  if (!tail || !name.endsWith(tail)) return name;
  return name.slice(0, name.length - tail.length);
}

// Reverse mapping: reattach an Upstream Model Suffix to the model name sent in the
// request body to a non-standard Upstream (e.g. claude-opus-4-8 -> claude-opus-4-8-cc).
// Idempotent: never appends a suffix that is already present.
function applyUpstreamModelSuffix(model, suffix) {
  const name = String(model || '');
  const tail = normalizeModelSuffix(suffix);
  if (!tail || !name || name.endsWith(tail)) return name;
  return `${name}${tail}`;
}

// Resolve the model name to send in the outgoing request body for the chosen Upstream.
// Returns the standard name unchanged unless the Upstream declares a model_suffix_strip.
function forwardModelForUpstream(upstream, model) {
  const suffix = upstream?.modelSuffixStrip;
  if (!normalizeModelSuffix(suffix)) return String(model || '');
  const models = upstream?.health?.models || [];
  // If health.models is populated, it already contains normalized (standard) names.
  // Check if the requested model is in the normalized list.
  if (models.length > 0 && models.includes(model)) {
    // Model is in the normalized list → apply suffix for this upstream
    return applyUpstreamModelSuffix(model, suffix);
  }
  // Fallback for empty models list (health probe not run yet):
  // If suffix is configured, assume all models need it and apply with idempotency check
  if (normalizeModelSuffix(suffix)) {
    return applyUpstreamModelSuffix(model, suffix);
  }
  return String(model || '');
}

function normalizeDiscoveredModelsForUpstream(upstream, models) {
  const suffix = upstream?.modelSuffixStrip;
  return [...new Set((Array.isArray(models) ? models : [])
    .map((model) => stripUpstreamModelSuffix(model, suffix))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function attachForwardedModelTrace(routeTrace, attemptedModel, forwardedModel) {
  if (!routeTrace || !forwardedModel || forwardedModel === attemptedModel) return routeTrace;
  return { ...routeTrace, forwarded_model: forwardedModel };
}

function isClaudeModel(model) {
  return /^claude(?:-|$)/i.test(String(model || '').trim());
}

function modelRequiresProtocol(model) {
  const normalized = String(model || '').trim();
  if (!normalized) return null;
  // Claude models require Anthropic Messages API
  if (isClaudeModel(normalized)) return 'anthropic_messages';
  // All other models (GPT, GLM, Qwen, DeepSeek, Yi, etc.) default to OpenAI protocol
  // Most Chinese model providers offer OpenAI-compatible APIs
  return 'openai';
}

function normalizeUpstreamApi(value, probeAuth = '') {
  const api = String(value || '').trim().toLowerCase();
  if (api) return api;
  return String(probeAuth || '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

function isAnthropicUpstream(upstream) {
  // Priority: verified protocol capability > api configuration
  if (upstreamHasVerifiedProtocolCapability(upstream, 'anthropic_messages')) return true;
  // Fallback: check api configuration
  return upstream?.api === 'anthropic' ||
    upstream?.api === 'both' ||
    String(upstream?.probeAuth || '').trim().toLowerCase() === 'anthropic';
}

function isOpenAiUpstream(upstream) {
  // Priority: verified protocol capability > api configuration
  if (upstreamHasVerifiedProtocolCapability(upstream, 'responses') ||
      upstreamHasVerifiedProtocolCapability(upstream, 'chat_completions')) {
    return true;
  }
  // Fallback: check api configuration (default to openai if not specified)
  return upstream?.api === 'openai' ||
    upstream?.api === 'both' ||
    !upstream?.api;
}

function isCodexOAuthModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return value === '' || value.startsWith('gpt-') || value.startsWith('codex');
}

function isCodexOAuthConfig(input) {
  return input?.codex_oauth === true || String(input?.request_mode || '').trim().toLowerCase() === 'codex_oauth';
}

const ROUTE_STRATEGY_NAMES = new Set([
  'responses',
  'chat_completions',
  'chat_completions_compatibility',
  'anthropic_messages',
  'anthropic_messages_compatibility',
  'codex_oauth_responses'
]);
const REQUEST_PROTOCOL_METADATA = {
  responses: { label: 'Responses', shortLabel: 'Responses', path: '/v1/responses' },
  chat_completions: { label: 'Chat Completions', shortLabel: 'Chat', path: '/v1/chat/completions' },
  anthropic_messages: { label: 'Anthropic Messages', shortLabel: 'Messages', path: '/v1/messages' },
  codex_oauth_responses: { label: 'Codex OAuth Responses', shortLabel: 'Codex OAuth', path: '/backend-api/codex/responses' }
};
const ROUTE_STRATEGY_METADATA = {
  responses: REQUEST_PROTOCOL_METADATA.responses,
  chat_completions: REQUEST_PROTOCOL_METADATA.chat_completions,
  chat_completions_compatibility: { ...REQUEST_PROTOCOL_METADATA.chat_completions, label: 'Chat Completions + Compatibility', shortLabel: 'Chat + Compat' },
  anthropic_messages: REQUEST_PROTOCOL_METADATA.anthropic_messages,
  anthropic_messages_compatibility: { ...REQUEST_PROTOCOL_METADATA.anthropic_messages, label: 'Anthropic Messages + Compatibility', shortLabel: 'Messages + Compat' },
  codex_oauth_responses: REQUEST_PROTOCOL_METADATA.codex_oauth_responses
};

function routeStrategyModelKey(model) {
  return String(model || '').trim() || '__default__';
}

function normalizeRouteStrategyEntry(entry, modelKey = '') {
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

function normalizeRouteStrategies(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries = {};
  for (const [modelKey, value] of Object.entries(input)) {
    const normalized = normalizeRouteStrategyEntry(value, modelKey);
    if (normalized) entries[modelKey] = normalized;
  }
  return entries;
}

function routeStrategyForUpstream(upstream, model) {
  const strategies = normalizeRouteStrategies(upstream?.routeStrategies || upstream?.route_strategies);
  return strategies[routeStrategyModelKey(model)] || strategies.__default__ || null;
}

function routeStrategyUsesChatCompletions(strategy) {
  const value = typeof strategy === 'string' ? strategy : strategy?.strategy;
  return value === 'chat_completions' || value === 'chat_completions_compatibility';
}

function routeStrategyUsesNativeResponses(strategy) {
  const value = typeof strategy === 'string' ? strategy : strategy?.strategy;
  return value === 'responses' || value === 'codex_oauth_responses';
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function nativeResponsesCapabilityNewerThanStrategy(upstream, strategy, model = '') {
  const capability = normalizeProtocolCapabilities(upstream?.capabilities).responses;
  if (capability?.status !== 'verified') return false;
  const capabilityModel = String(capability.model || '').trim();
  const requestedModel = String(model || '').trim();
  if (capabilityModel && requestedModel && capabilityModel !== requestedModel) return false;
  const capabilityCheckedAt = timestampMs(capability.checked_at);
  const strategyCheckedAt = timestampMs(strategy?.checked_at);
  return capabilityCheckedAt > 0 && capabilityCheckedAt >= strategyCheckedAt;
}

function nativeResponsesRecheckDue(strategy, {
  at = now(),
  intervalMs = DEFAULT_NATIVE_RESPONSES_RECHECK_MS
} = {}) {
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return true;
  const checkedAt = timestampMs(strategy?.checked_at);
  if (!checkedAt) return true;
  return at - checkedAt >= interval;
}

function learnRouteStrategy(upstream, model, strategy, { source = 'real_traffic', reason = '' } = {}) {
  if (!upstream || !ROUTE_STRATEGY_NAMES.has(strategy)) return;
  const modelKey = routeStrategyModelKey(model);
  upstream.routeStrategies = normalizeRouteStrategies(upstream.routeStrategies);
  upstream.routeStrategies[modelKey] = {
    strategy,
    model: String(model || ''),
    source,
    checked_at: new Date().toISOString(),
    reason: String(reason || '')
  };
}

function requestProtocolType(protocol, upstream = {}, configuredMode = '') {
  return protocol === 'responses' && (configuredMode === 'codex_oauth' || upstream.codexOAuth || upstream.codex_oauth)
    ? 'codex_oauth_responses'
    : protocol;
}

function requestProtocolView(protocol, capability = {}, upstream = {}, configuredMode = '') {
  const type = requestProtocolType(protocol, upstream, configuredMode);
  const metadata = REQUEST_PROTOCOL_METADATA[type] || REQUEST_PROTOCOL_METADATA[protocol] || { label: protocol, shortLabel: protocol, path: '' };
  return {
    type,
    protocol,
    label: metadata.label,
    short_label: metadata.shortLabel || metadata.label,
    path: metadata.path || '',
    status: capability.status || 'unknown',
    source: capability.source || '',
    checked_at: capability.checked_at || null,
    model: capability.model || '',
    http_status: capability.http_status || 0,
    reason: capability.reason || ''
  };
}

function supportedRequestProtocols(upstream = {}, configuredMode = '') {
  const capabilities = normalizeProtocolCapabilities(upstream.capabilities);
  const protocols = PROTOCOL_CAPABILITY_NAMES
    .map((protocol) => requestProtocolView(protocol, capabilities[protocol] || {}, upstream, configuredMode))
    .filter((item) => ['verified', 'assumed'].includes(item.status));

  // Sort by status priority: verified > assumed
  protocols.sort((a, b) => {
    if (a.status === 'verified' && b.status !== 'verified') return -1;
    if (a.status !== 'verified' && b.status === 'verified') return 1;
    return 0;
  });

  return protocols;
}

function currentRequestProtocolForUpstream(upstream = {}, activeModel = '') {
  const model = String(activeModel || '').trim();
  if (!model) {
    return {
      type: 'by_requested_model',
      label: 'By Requested Model',
      short_label: 'By model',
      source: 'request',
      model: '',
      reason: 'Dashboard is following each incoming Requested Model.'
    };
  }
  const strategy = routeStrategyForUpstream(upstream, model);
  if (!strategy) {
    return {
      type: 'not_learned',
      label: 'Not Learned',
      short_label: 'Not learned',
      source: 'none',
      model,
      reason: 'No successful real traffic has learned a Forwarding Strategy for this Requested Model.'
    };
  }
  const strategyName = String(strategy.strategy || '');
  const metadata = ROUTE_STRATEGY_METADATA[strategyName] || { label: strategyName || 'Unknown', shortLabel: strategyName || 'Unknown', path: '' };
  return {
    type: strategyName,
    strategy: strategyName,
    label: metadata.label,
    short_label: metadata.shortLabel || metadata.label,
    path: metadata.path || '',
    source: strategy.source || '',
    model: strategy.model && strategy.model !== '__default__' ? strategy.model : model,
    checked_at: strategy.checked_at || null,
    reason: strategy.reason || ''
  };
}

function requestInterfaceForUpstream(upstream = {}, activeModel = '') {
  const configuredMode = upstream.requestMode || normalizeRequestMode(upstream.request_mode, upstream.codexOAuth);
  const resolvedMode = upstream.resolvedRequestMode || upstream.resolved_request_mode || '';
  const capabilities = normalizeProtocolCapabilities(upstream.capabilities);
  const supported = supportedRequestProtocols(upstream, configuredMode);
  const using = currentRequestProtocolForUpstream(upstream, activeModel);
  const verifiedProtocols = PROTOCOL_CAPABILITY_NAMES
    .map((protocol) => ({ protocol, capability: capabilities[protocol] || {}, view: requestProtocolView(protocol, capabilities[protocol] || {}, upstream, configuredMode) }))
    .filter((item) => item.capability.status === 'verified' && ['probe', 'real_traffic'].includes(item.capability.source));

  if (verifiedProtocols.length === 1) {
    const { capability, view } = verifiedProtocols[0];
    return {
      type: view.type,
      label: view.label,
      source: capability.source,
      path: view.path,
      configured_mode: configuredMode || 'auto',
      resolved_mode: resolvedMode || '',
      checked_at: capability.checked_at || null,
      model: capability.model || '',
      http_status: capability.http_status || 0,
      supported,
      using
    };
  }
  if (verifiedProtocols.length > 1) {
    return {
      type: 'model_dependent',
      label: 'Model Dependent',
      source: 'verified',
      path: '',
      configured_mode: configuredMode || 'auto',
      resolved_mode: resolvedMode || '',
      supported,
      using,
      verified: Object.fromEntries(verifiedProtocols.map(({ protocol, view }) => [protocol, view]))
    };
  }
  return {
    type: 'pending',
    label: 'Pending Verification',
    source: 'pending',
    path: '',
    configured_mode: configuredMode || 'auto',
    resolved_mode: '',
    supported,
    using
  };
}

function normalizeRequestMode(value, codexOAuth = false) {
  if (codexOAuth) return 'codex_oauth';
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === 'responses' || normalized === 'response') return 'responses';
  if (normalized === 'chat' || normalized === 'chat_completion' || normalized === 'chat_completions') return 'chat_completions';
  if (normalized === 'codex_oauth') return 'codex_oauth';
  return normalized;
}

function codexOAuthExpired(upstream, at = Date.now()) {
  if (!upstream?.codexOAuth || !upstream.oauthExpiresAt) return false;
  const expiresMs = Date.parse(upstream.oauthExpiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= at;
}

// Codex OAuth access tokens are short-lived (~1h). Refresh proactively before the
// token expires so an upstream does not silently drop out of Selection (CORE_FEATURES §12).
// A small safety margin avoids refreshing in the last few seconds.
const OAUTH_REFRESH_SAFETY_MARGIN_MS = 60 * 1000;

function codexOAuthNeedsRefresh(upstream, at = Date.now()) {
  if (!upstream?.codexOAuth || !upstream.oauthExpiresAt) return false;
  const expiresMs = Date.parse(upstream.oauthExpiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= at + OAUTH_REFRESH_SAFETY_MARGIN_MS;
}

// Exchange a stored refresh_token for a fresh access token. Returns
// { access_token, expires_at, refresh_token? } on success, or null on any
// failure (HTTP error, network error, malformed body). Never throws.
async function refreshCodexOAuthToken({ tokenUrl = CODEX_OAUTH_TOKEN_URL, clientId, refreshToken, timeoutMs = 8000 } = {}) {
  const client = String(clientId || CODEX_OAUTH_CLIENT_ID || '').trim();
  const rt = String(refreshToken || '').trim();
  if (!rt) return null;

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: client });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'application/json',
        'user-agent': CODEX_CLI_USER_AGENT
      },
      body: body.toString(),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const json = await response.json().catch(() => null);
    if (!json || typeof json !== 'object' || typeof json.access_token !== 'string' || !json.access_token) {
      return null;
    }
    const expiresIn = Number(json.expires_in);
    const expiresInMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600 * 1000;
    return {
      access_token: json.access_token,
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      refresh_token: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : undefined
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Ensure a Codex OAuth upstream has a fresh access token before forwarding.
// On success: updates the runtime upstream's key value + oauthExpiresAt, and
// persists the refreshed secret. On failure: returns false so the caller can
// fall back to excluding the upstream from Selection.
async function ensureCodexOAuthFresh({ upstream, runtime, config, at = Date.now() } = {}) {
  if (!upstream?.codexOAuth) return true;
  if (!codexOAuthNeedsRefresh(upstream, at)) return true;

  const credentialRef = upstream.credentialRef || upstream.keys?.[0]?.label || '';
  const secrets = runtime?.secrets || {};
  const secret = (secrets[credentialRef] && typeof secrets[credentialRef] === 'object') ? secrets[credentialRef] : {};
  const refreshToken = secret.refresh_token || '';
  if (!refreshToken) return false; // nothing to refresh with -> stay excluded

  const refreshed = await refreshCodexOAuthToken({
    tokenUrl: CODEX_OAUTH_TOKEN_URL,
    clientId: upstream.oauthClientId || CODEX_OAUTH_CLIENT_ID,
    refreshToken
  });
  if (!refreshed) return false;

  // Update persisted secret.
  secrets[credentialRef] = {
    ...secret,
    access_token: refreshed.access_token,
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
    expires_at: refreshed.expires_at
  };
  if (runtime && typeof runtime.secretsPath === 'string' && runtime.secretsPath) {
    try { await saveSecrets(secrets, runtime.secretsPath); } catch { /* best-effort */ }
  }

  // Update in-memory runtime upstream so Selection can use it immediately.
  upstream.oauthExpiresAt = refreshed.expires_at;
  if (Array.isArray(upstream.keys) && upstream.keys[0]) {
    upstream.keys[0] = { ...upstream.keys[0], value: refreshed.access_token };
  }

  // Keep config.codex_oauth.accounts[*].oauth_expires_at in sync when possible.
  try {
    const accounts = config?.codex_oauth?.accounts;
    if (Array.isArray(accounts)) {
      const acct = accounts.find((a) => a && a.name === upstream.name);
      if (acct) acct.oauth_expires_at = refreshed.expires_at;
    }
  } catch { /* best-effort */ }

  return true;
}

function cleanName(value, fallback = 'upstream') {
  const raw = String(value || '').trim();
  const cleaned = raw
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function envNameForUpstream(name) {
  return `${String(name || 'UPSTREAM').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UPSTREAM'}_API_KEY`;
}

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input || {}, key);
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'replace'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'append'].includes(normalized)) return false;
  return fallback;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function signinAvailableValue(input) {
  return firstDefined(
    input?.signin_available,
    input?.sign_in_available,
    input?.can_signin,
    input?.canSignIn,
    input?.checkin_available,
    input?.check_in_available
  );
}

function signinCompletedValue(input) {
  return firstDefined(
    input?.signin_completed,
    input?.sign_in_completed,
    input?.signed_in,
    input?.signedIn,
    input?.checkin_completed,
    input?.check_in_completed
  );
}

function signinCompletedDateValue(input) {
  return firstDefined(
    input?.signin_completed_date,
    input?.signinCompletedDate,
    input?.sign_in_completed_date,
    input?.signed_in_date,
    input?.checkin_completed_date,
    input?.check_in_completed_date
  );
}

function normalizeDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? localDateKey(parsed) : '';
}

function signinCompletionDate(input, today = localDateKey()) {
  const explicitDate = normalizeDateKey(signinCompletedDateValue(input));
  if (explicitDate) return explicitDate;
  return booleanOption(signinCompletedValue(input), false) ? today : '';
}

function signinStatus(signinAvailable, signinCompletedDate, today = localDateKey()) {
  if (!signinAvailable) return 'not_required';
  return signinCompletedDate === today ? 'completed' : 'pending';
}

function visibleSigninCompletedDate(signinAvailable, signinCompletedDate, today = localDateKey()) {
  return signinStatus(signinAvailable, signinCompletedDate, today) === 'completed' ? signinCompletedDate : '';
}

function shouldUseAnthropicResponsesAdapter(pathname, model) {
  return pathname === '/v1/responses' && isClaudeModel(model);
}

function canUseChatCompletionsAdapter(pathname, upstream, model) {
  return pathname === '/v1/responses'
    && !isClaudeModel(model)
    && !upstream?.codexOAuth
    && isOpenAiUpstream(upstream);
}

function isChatCompletionsOnlyMode(upstream) {
  return upstream?.requestMode === 'chat_completions' ||
    upstream?.resolvedRequestMode === 'chat_completions';
}

const NON_REPRESENTATIVE_NATIVE_RESPONSES_PROBE_STATES = new Set(['unexpected_status', 'server_error', 'models_unsupported', 'inconclusive']);

function upstreamHasConfiguredNativeResponses(upstream) {
  return upstream?.requestMode === 'responses' ||
    upstreamHasUserDeclaredProtocolCapability(upstream, 'responses');
}

function canAttemptNativeResponses(pathname, upstream, model, {
  at = now(),
  nativeResponsesRecheckMs = DEFAULT_NATIVE_RESPONSES_RECHECK_MS
} = {}) {
  if (pathname !== '/v1/responses') return true;
  if (shouldUseAnthropicResponsesAdapter(pathname, model)) return false;
  if (!canUseChatCompletionsAdapter(pathname, upstream, model)) return true;
  if (upstream?.requestMode === 'chat_completions') return false;
  const learnedStrategy = routeStrategyForUpstream(upstream, model);
  if (routeStrategyUsesNativeResponses(learnedStrategy)) return true;
  if (routeStrategyUsesChatCompletions(learnedStrategy)) {
    return nativeResponsesCapabilityNewerThanStrategy(upstream, learnedStrategy, model) ||
      nativeResponsesRecheckDue(learnedStrategy, { at, intervalMs: nativeResponsesRecheckMs });
  }
  if (upstream?.requestMode === 'responses') return true;
  if (upstream?.resolvedRequestMode === 'chat_completions') {
    const checkedAt = upstream?.health?.checkedAt || upstream?.capabilities?.chat_completions?.checked_at || '';
    const resolvedModeEvidence = { checked_at: checkedAt };
    return nativeResponsesCapabilityNewerThanStrategy(upstream, resolvedModeEvidence, model) ||
      nativeResponsesRecheckDue(resolvedModeEvidence, { at, intervalMs: nativeResponsesRecheckMs });
  }
  return !isChatCompletionsOnlyMode(upstream);
}

function isModelInteractionRequest(method, pathname) {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  return pathname === '/v1/responses' ||
    pathname === '/v1/chat/completions' ||
    pathname === '/v1/messages';
}

function requestRouteTrace({
  pathname,
  useAnthropicAdapter = false,
  useChatCompletionsAdapter = false,
  useCodexOAuth = false,
  requiresNativeResponses = false,
  unsupportedToolTypes = [],
  unsupportedOutputFormatTypes = [],
  unsupportedInputTypes = [],
  unsupportedFieldTypes = []
} = {}) {
  const nativeOnly = {};
  if (unsupportedToolTypes.length > 0) nativeOnly.tool_types = unsupportedToolTypes;
  if (unsupportedOutputFormatTypes.length > 0) nativeOnly.output_format_types = unsupportedOutputFormatTypes;
  if (unsupportedInputTypes.length > 0) nativeOnly.input_types = unsupportedInputTypes;
  if (unsupportedFieldTypes.length > 0) nativeOnly.fields = unsupportedFieldTypes;
  if (pathname === '/v1/responses' && useAnthropicAdapter) {
    return {
      input_api: 'responses',
      upstream_api: 'anthropic_messages',
      adapter: 'responses_to_anthropic_messages',
      native_required: requiresNativeResponses,
      native_only: nativeOnly,
      transform: [
        'input_to_anthropic_messages',
        'function_tools_to_anthropic_tools',
        'tool_choice_to_anthropic_tool_choice',
        'anthropic_response_to_responses'
      ]
    };
  }
  if (pathname === '/v1/responses' && useChatCompletionsAdapter) {
    return {
      input_api: 'responses',
      upstream_api: 'chat_completions',
      adapter: 'responses_to_chat_completions',
      native_required: requiresNativeResponses,
      native_only: nativeOnly,
      transform: [
        'input_to_chat_messages',
        'function_tools_to_chat_tools',
        'tool_choice_to_chat_tool_choice',
        'text_format_to_response_format',
        'chat_response_to_responses'
      ]
    };
  }
  if (pathname === '/v1/responses') {
    return {
      input_api: 'responses',
      upstream_api: useCodexOAuth ? 'codex_oauth_responses' : 'responses',
      adapter: 'native_responses_passthrough',
      native_required: requiresNativeResponses,
      native_only: nativeOnly,
      transform: useCodexOAuth ? ['codex_oauth_forward'] : ['passthrough']
    };
  }
  return {
    input_api: pathname || 'unknown',
    upstream_api: 'passthrough',
    adapter: 'passthrough',
    native_required: false,
    native_only: nativeOnly,
    transform: ['passthrough']
  };
}

function planProtocolRoute({ pathname, upstream, model, requiresNativeResponses = false } = {}) {
  const useAnthropicAdapter = shouldUseAnthropicResponsesAdapter(pathname, model);
  const canUseChatAdapter = canUseChatCompletionsAdapter(pathname, upstream, model);
  const allowChatCompletionsAdapter = canUseChatAdapter && !requiresNativeResponses;
  const useChatCompletionsAdapter = allowChatCompletionsAdapter && (
    upstream?.requestMode === 'chat_completions' ||
    upstream?.resolvedRequestMode === 'chat_completions' ||
    upstreamHasVerifiedProtocolCapability(upstream, 'chat_completions')
  );
  return {
    useAnthropicAdapter,
    canUseChatAdapter,
    allowChatCompletionsAdapter,
    useChatCompletionsAdapter,
    useCodexOAuth: !useAnthropicAdapter && upstream?.codexOAuth === true
  };
}

function addRouteTraceHeaders(headers, routeTrace) {
  if (!routeTrace) return;
  headers['x-codex-api-pool-route'] = `${routeTrace.input_api}->${routeTrace.upstream_api}`;
  headers['x-codex-api-pool-adapter'] = routeTrace.adapter;
  headers['x-codex-api-pool-transform'] = routeTrace.transform.join(',');
}

function chatFallbackProbeTimeoutMs(config, timeoutMs) {
  const value = Number(config.retry?.chat_fallback_probe_timeout_ms || config.retry?.responses_fallback_timeout_ms || 15000);
  return Number.isFinite(value) && value > 0 ? Math.min(timeoutMs, value) : timeoutMs;
}

function anthropicModelsPathForBaseUrl(baseUrl) {
  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/$/, '');
    return pathname.endsWith('/v1') ? '/models' : '/v1/models';
  } catch {
    return '/v1/models';
  }
}

function anthropicMessagesPathForBaseUrl(baseUrl) {
  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/$/, '');
    return pathname.endsWith('/v1') ? '/messages' : '/v1/messages';
  } catch {
    return '/v1/messages';
  }
}

function chatCompletionsPathForBaseUrl(baseUrl) {
  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/$/, '');
    return pathname.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions';
  } catch {
    return '/v1/chat/completions';
  }
}

function responsesPathForBaseUrl(baseUrl) {
  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/$/, '');
    return pathname.endsWith('/v1') ? '/responses' : '/v1/responses';
  } catch {
    return '/v1/responses';
  }
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

function responsesContentBlockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.input_text === 'string') return block.input_text;
  if (typeof block.output_text === 'string') return block.output_text;
  return '';
}

function parseDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) return null;
  return {
    mediaType: match[1],
    data: match[2]
  };
}

function trimmedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function responsesFileTitle(block) {
  return trimmedString(firstDefined(block?.filename, block?.title, block?.name));
}

function fileDataForChat(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const dataUrl = parseDataUrl(value.trim());
  return dataUrl ? dataUrl.data : value;
}

function mediaTypeFromResponsesFileBlock(block, dataUrl = null) {
  const explicit = trimmedString(firstDefined(
    block?.media_type,
    block?.mime_type,
    block?.mimeType,
    block?.content_type,
    block?.contentType
  ));
  if (explicit) return explicit.split(';')[0].trim().toLowerCase();
  if (dataUrl?.mediaType) return dataUrl.mediaType.split(';')[0].trim().toLowerCase();
  const title = responsesFileTitle(block).toLowerCase();
  if (title.endsWith('.pdf')) return 'application/pdf';
  if (/\.(txt|text|md|markdown|csv|json|jsonl|xml|html|htm|css|js|jsx|ts|tsx|yaml|yml|log)$/.test(title)) return 'text/plain';
  return '';
}

function isTextLikeMediaType(mediaType) {
  if (!mediaType) return false;
  if (mediaType.startsWith('text/')) return true;
  return [
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/x-ndjson'
  ].includes(mediaType);
}

function decodeBase64Text(data) {
  try {
    return Buffer.from(String(data || ''), 'base64').toString('utf8');
  } catch {
    return String(data || '');
  }
}

function chatImageContentPartFromResponsesBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const url = typeof block.image_url === 'string' && block.image_url.trim()
    ? block.image_url.trim()
    : typeof block.url === 'string' && block.url.trim()
      ? block.url.trim()
      : '';
  if (url) {
    const imageUrl = { url };
    if (['auto', 'low', 'high'].includes(block.detail)) imageUrl.detail = block.detail;
    return { type: 'image_url', image_url: imageUrl };
  }
  if (typeof block.file_id === 'string' && block.file_id.trim()) {
    return { type: 'file', file: { file_id: block.file_id.trim() } };
  }
  return null;
}

function chatFileContentPartFromResponsesBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const file = {};
  const fileId = trimmedString(block.file_id);
  if (fileId) {
    file.file_id = fileId;
  } else {
    const fileData = fileDataForChat(block.file_data);
    if (fileData) file.file_data = fileData;
  }
  const filename = trimmedString(block.filename);
  if (filename) file.filename = filename;
  return file.file_id || file.file_data ? { type: 'file', file } : null;
}

function chatContentFromResponsesContent(content, role = 'user') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    const text = responsesContentBlockText(block);
    if (text) {
      parts.push({ type: 'text', text });
      continue;
    }
    if (role !== 'user') continue;
    if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'input_image') {
      const image = chatImageContentPartFromResponsesBlock(block);
      if (image) parts.push(image);
    } else if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'input_file') {
      const file = chatFileContentPartFromResponsesBlock(block);
      if (file) parts.push(file);
    }
  }
  if (parts.length === 0) return '';
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('\n');
  return parts;
}

function chatContentParts(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) return [{ type: 'text', text: value }];
  return [];
}

function mergeChatMessageContent(message, content) {
  if (!content) return;
  if (typeof message.content === 'string' && typeof content === 'string') {
    message.content += `\n${content}`;
    return;
  }
  message.content = [...chatContentParts(message.content), ...chatContentParts(content)];
}

function anthropicImageBlockFromResponsesBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  if (typeof block.file_id === 'string' && block.file_id.trim()) {
    return { type: 'image', source: { type: 'file', file_id: block.file_id.trim() } };
  }
  const url = typeof block.image_url === 'string' && block.image_url.trim()
    ? block.image_url.trim()
    : typeof block.url === 'string' && block.url.trim()
      ? block.url.trim()
      : '';
  if (!url) return null;
  const dataUrl = parseDataUrl(url);
  if (dataUrl) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrl.mediaType,
        data: dataUrl.data
      }
    };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function anthropicDocumentBlockFromResponsesBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const title = responsesFileTitle(block);
  const withTitle = (document) => {
    if (title) document.title = title;
    return document;
  };

  const fileUrl = trimmedString(firstDefined(block.file_url, block.url));
  if (fileUrl) {
    return withTitle({ type: 'document', source: { type: 'url', url: fileUrl } });
  }

  if (typeof block.file_data !== 'string' || !block.file_data.trim()) return null;
  const rawFileData = block.file_data.trim();
  const dataUrl = parseDataUrl(rawFileData);
  const mediaType = mediaTypeFromResponsesFileBlock(block, dataUrl);
  const data = dataUrl ? dataUrl.data : rawFileData;
  if (mediaType === 'application/pdf') {
    return withTitle({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data }
    });
  }
  if (isTextLikeMediaType(mediaType)) {
    return withTitle({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: dataUrl ? decodeBase64Text(data) : rawFileData }
    });
  }
  return null;
}

function anthropicContentBlocksFromResponsesContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    const text = responsesContentBlockText(block);
    if (text) {
      blocks.push({ type: 'text', text });
      continue;
    }
    if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'input_image') {
      const image = anthropicImageBlockFromResponsesBlock(block);
      if (image) blocks.push(image);
    } else if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'input_file') {
      const document = anthropicDocumentBlockFromResponsesBlock(block);
      if (document) blocks.push(document);
    }
  }
  return blocks;
}

function responsesContentBlockConvertibleForAdapter(block, adapter) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  if (block.type === 'input_image') {
    if (!adapter) {
      return Boolean(chatImageContentPartFromResponsesBlock(block)) || Boolean(anthropicImageBlockFromResponsesBlock(block));
    }
    return adapter === 'anthropic_messages'
      ? Boolean(anthropicImageBlockFromResponsesBlock(block))
      : Boolean(chatImageContentPartFromResponsesBlock(block));
  }
  if (block.type === 'input_file') {
    if (!adapter) {
      return Boolean(chatFileContentPartFromResponsesBlock(block)) || Boolean(anthropicDocumentBlockFromResponsesBlock(block));
    }
    return adapter === 'anthropic_messages'
      ? Boolean(anthropicDocumentBlockFromResponsesBlock(block))
      : Boolean(chatFileContentPartFromResponsesBlock(block));
  }
  return true;
}

const RESPONSES_INPUT_IMAGE_FIELDS = ['detail', 'file_id', 'image_url', 'url'];
const RESPONSES_INPUT_FILE_FIELDS = [
  'detail',
  'file_data',
  'file_id',
  'file_url',
  'filename',
  'url',
  'title',
  'name',
  'media_type',
  'mime_type',
  'mimeType',
  'content_type',
  'contentType'
];

function contentFieldPresent(block, field) {
  return block && block[field] !== undefined && block[field] !== null && block[field] !== '';
}

function firstPresentField(block, fields) {
  return fields.find((field) => contentFieldPresent(block, field)) || '';
}

function consumedResponsesContentFieldsForAdapter(block, adapter) {
  const consumed = new Set(['type']);
  if (!block || typeof block !== 'object' || Array.isArray(block)) return consumed;
  if (block.type === 'input_image') {
    const imageUrlField = firstPresentField(block, ['image_url', 'url']);
    if (adapter === 'anthropic_messages') {
      if (contentFieldPresent(block, 'file_id')) consumed.add('file_id');
      else if (imageUrlField) consumed.add(imageUrlField);
      return consumed;
    }
    if (imageUrlField) {
      consumed.add(imageUrlField);
      if (['auto', 'low', 'high'].includes(block.detail)) consumed.add('detail');
    } else if (contentFieldPresent(block, 'file_id')) {
      consumed.add('file_id');
    }
    return consumed;
  }
  if (block.type === 'input_file') {
    const titleField = firstPresentField(block, ['filename', 'title', 'name']);
    if (adapter === 'anthropic_messages') {
      const fileUrlField = firstPresentField(block, ['file_url', 'url']);
      if (fileUrlField) {
        consumed.add(fileUrlField);
      } else if (contentFieldPresent(block, 'file_data')) {
        consumed.add('file_data');
        const mediaField = firstPresentField(block, ['media_type', 'mime_type', 'mimeType', 'content_type', 'contentType']);
        if (mediaField) consumed.add(mediaField);
      }
      if (titleField) consumed.add(titleField);
      return consumed;
    }
    if (contentFieldPresent(block, 'file_id')) consumed.add('file_id');
    else if (contentFieldPresent(block, 'file_data')) consumed.add('file_data');
    if (contentFieldPresent(block, 'filename')) consumed.add('filename');
    return consumed;
  }
  return consumed;
}

function downgradedResponsesContentFieldsForAdapter(block, adapter) {
  const knownFields = block?.type === 'input_image'
    ? RESPONSES_INPUT_IMAGE_FIELDS
    : block?.type === 'input_file'
      ? RESPONSES_INPUT_FILE_FIELDS
      : [];
  if (knownFields.length === 0) return [];
  const consumed = consumedResponsesContentFieldsForAdapter(block, adapter);
  return knownFields
    .filter((field) => contentFieldPresent(block, field) && !consumed.has(field))
    .map((field) => `${block.type}.${field}`);
}

function stringFromToolOutput(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function objectFromToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { arguments: value };
  }
}

function responseFunctionToolParts(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  if (tool.type && tool.type !== 'function' && !tool.function) return null;
  const source = tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function)
    ? tool.function
    : tool;
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim()
    : typeof tool.name === 'string' && tool.name.trim()
      ? tool.name.trim()
      : '';
  if (!name) return null;
  return {
    name,
    description: firstDefined(source.description, tool.description),
    parameters: firstDefined(source.parameters, tool.parameters, source.input_schema, tool.input_schema),
    strict: firstDefined(source.strict, tool.strict)
  };
}

function safeToolName(value, fallback = 'tool') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return normalized || fallback;
}

function responseCustomToolParts(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  if (tool.type !== 'custom') return null;
  const source = tool.custom && typeof tool.custom === 'object' && !Array.isArray(tool.custom)
    ? tool.custom
    : tool;
  const name = safeToolName(source.name || tool.name, 'custom_tool');
  if (!name) return null;
  const format = objectRecord(source.format)
    ? source.format
    : objectRecord(tool.format)
      ? tool.format
      : objectRecord(source.grammar)
        ? { type: 'grammar', grammar: source.grammar }
        : objectRecord(tool.grammar)
          ? { type: 'grammar', grammar: tool.grammar }
          : undefined;
  return {
    name,
    description: firstDefined(source.description, tool.description),
    format
  };
}

function responseNamespaceToolParts(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || tool.type !== 'namespace') return [];
  const namespace = safeToolName(tool.namespace || tool.name || tool.label, 'namespace');
  if (!Array.isArray(tool.tools)) return [];
  return tool.tools.map((child, index) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) return null;
    const functionParts = responseFunctionToolParts({ ...child, type: child.type || 'function' });
    const childName = safeToolName(functionParts?.name || child.name, `tool_${index + 1}`);
    const name = safeToolName(`${namespace}_${childName}`, childName);
    return {
      type: 'function',
      name,
      description: firstDefined(
        functionParts?.description,
        child.description,
        `Tool ${childName} from namespace ${namespace}.`
      ),
      parameters: firstDefined(
        functionParts?.parameters,
        child.parameters,
        child.input_schema,
        { type: 'object', properties: {} }
      ),
      strict: firstDefined(functionParts?.strict, child.strict)
    };
  }).filter(Boolean);
}

function responsesToolTypeLabel(tool) {
  if (tool && typeof tool === 'object' && !Array.isArray(tool)) {
    if (typeof tool.type === 'string' && tool.type.trim()) return tool.type.trim();
    if (tool.function) return 'function';
  }
  return 'unknown';
}

function unsupportedResponsesToolTypesFromTools(tools) {
  if (!Array.isArray(tools)) return [];
  const types = new Set();
  for (const tool of tools) {
    if (!responseFunctionToolParts(tool)) types.add(responsesToolTypeLabel(tool));
  }
  return [...types];
}

const CHAT_COMPLETIONS_TOOL_CHOICE_STRINGS = new Set(['auto', 'none', 'required']);

function isSimpleToolChoiceObject(choice, type) {
  return choice && typeof choice === 'object' && !Array.isArray(choice)
    && choice.type === type
    && Object.keys(choice).every((key) => key === 'type');
}

function unsupportedResponsesToolChoiceTypesFromChoice(choice) {
  if (choice === undefined) return [];
  if (typeof choice === 'string') {
    const value = choice.trim();
    return CHAT_COMPLETIONS_TOOL_CHOICE_STRINGS.has(value) ? [] : [value || 'unknown'];
  }
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return ['unknown'];
  const type = String(choice.type || '').trim();
  const name = choice.function?.name || choice.name;
  if (type === 'function' && typeof name === 'string' && name.trim()) return [];
  if (CHAT_COMPLETIONS_TOOL_CHOICE_STRINGS.has(type) && isSimpleToolChoiceObject(choice, type)) return [];
  return [type || 'unknown'];
}

function unsupportedResponsesToolTypesFromPayload(payload) {
  const types = new Set(unsupportedResponsesToolTypesFromTools(payload?.tools));
  for (const type of unsupportedResponsesToolChoiceTypesFromChoice(payload?.tool_choice)) types.add(type);
  return [...types];
}

function unsupportedResponsesToolTypesFromBody(req, body, options = {}) {
  const payload = jsonObjectFromRequestBody(req, body, options);
  return payload ? unsupportedResponsesToolTypesFromPayload(payload) : [];
}

// Messages-only Features detection
const COMPUTER_USE_TOOL_TYPES = new Set([
  'computer_20241022',
  'text_editor_20241022',
  'bash_20241022'
]);

function messagesOnlyFeaturesFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const features = new Set();

  // Check system-level cache_control
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      if (block && typeof block === 'object' && block.cache_control) {
        features.add('cache_control');
        break;
      }
    }
  }

  // Check messages for cache_control and thinking blocks
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!message || typeof message !== 'object') continue;

      // Message-level cache_control
      if (message.cache_control) {
        features.add('cache_control');
      }

      // Content blocks
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!block || typeof block !== 'object') continue;

          // Thinking blocks
          if (block.type === 'thinking') {
            features.add('thinking');
          }

          // Content-level cache_control
          if (block.cache_control) {
            features.add('cache_control');
          }
        }
      }
    }
  }

  // Check tools for Computer Use and cache_control
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (!tool || typeof tool !== 'object') continue;

      // Computer Use tools - report the specific tool type for clearer diagnostics
      if (typeof tool.type === 'string' && COMPUTER_USE_TOOL_TYPES.has(tool.type)) {
        features.add(tool.type);
      }

      // Tool-level cache_control
      if (tool.cache_control) {
        features.add('cache_control');
      }
    }
  }

  return [...features];
}

function messagesOnlyFeaturesFromBody(req, body, options = {}) {
  const payload = jsonObjectFromRequestBody(req, body, options);
  return payload ? messagesOnlyFeaturesFromPayload(payload) : [];
}

// Messages → Chat Completions conversion
function anthropicMessagesToChatMessages(messages, options = {}) {
  if (!Array.isArray(messages)) return [];
  const stripFeatures = options.stripMessagesOnlyFeatures || false;
  const chatMessages = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.content;

    // Handle string content
    if (typeof content === 'string') {
      chatMessages.push({ role, content });
      continue;
    }

    // Handle array content
    if (!Array.isArray(content)) continue;

    let textParts = [];
    let toolCalls = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      // Strip thinking blocks if enabled
      if (block.type === 'thinking' && stripFeatures) {
        continue;
      }

      // Text blocks
      if (block.type === 'text') {
        textParts.push(block.text || '');
      }

      // Image blocks
      else if (block.type === 'image') {
        // Convert to OpenAI image_url format
        const source = block.source;
        if (source && source.type === 'base64') {
          textParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${source.media_type || 'image/jpeg'};base64,${source.data}`
            }
          });
        } else if (source && source.type === 'url') {
          textParts.push({
            type: 'image_url',
            image_url: { url: source.url }
          });
        }
      }

      // Document blocks (Anthropic document → Chat file / inline text).
      // CORE_FEATURES §3: user multimodal content (PDF/text docs) must NOT be
      // silently dropped during Messages → Chat conversion.
      else if (block.type === 'document') {
        const source = block.source;
        if (source && source.type === 'base64') {
          textParts.push({
            type: 'file',
            file: {
              file_data: `data:${source.media_type || 'application/pdf'};base64,${source.data || ''}`,
              filename: block.title || 'document'
            }
          });
        } else if (source && source.type === 'url') {
          textParts.push({
            type: 'file',
            file: {
              file_data: source.url || '',
              filename: block.title || 'document'
            }
          });
        } else if (source && source.type === 'text') {
          // Chat Completions has no inline text-document type; preserve content
          // as a text part so the document payload is never silently dropped.
          if (typeof source.data === 'string' && source.data.length) {
            textParts.push(source.data);
          }
        } else if (typeof block.content === 'string' && block.content) {
          // Fallback: some document blocks carry inline text in .content.
          textParts.push(block.content);
        }
      }

      // Tool use blocks (Anthropic → Chat tool_calls)
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${now().toString(36)}`,
          type: 'function',
          function: {
            name: block.name || 'unknown',
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
          }
        });
      }

      // Tool result blocks (Anthropic user message with tool_result → Chat tool message)
      else if (block.type === 'tool_result') {
        chatMessages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
        });
      }
    }

    // Build chat message
    if (toolCalls.length > 0) {
      // Assistant message with tool calls
      const textContent = textParts.filter(p => typeof p === 'string').join('\n').trim();
      chatMessages.push({
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls
      });
    } else if (textParts.length > 0) {
      // Regular message with text/images
      const hasImages = textParts.some(p => typeof p === 'object');
      if (hasImages) {
        // Convert to content array format
        const contentArray = textParts.flatMap(p => {
          if (typeof p === 'string') {
            return p ? [{ type: 'text', text: p }] : [];
          }
          return [p]; // Already in { type: 'image_url', image_url: {...} } format
        });
        chatMessages.push({ role, content: contentArray });
      } else {
        // Simple text content
        const text = textParts.join('\n').trim();
        if (text) chatMessages.push({ role, content: text });
      }
    }
  }

  return chatMessages;
}

function anthropicSystemToChatSystem(system, options = {}) {
  const stripFeatures = options.stripMessagesOnlyFeatures || false;

  // Handle string system
  if (typeof system === 'string') {
    return system.trim();
  }

  // Handle array system
  if (Array.isArray(system)) {
    const textParts = [];
    for (const block of system) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        textParts.push(block.text || '');
      }
      // Strip cache_control (handled by checking for it separately)
    }
    return textParts.join('\n').trim();
  }

  return '';
}

function anthropicToolsToChatTools(tools, options = {}) {
  if (!Array.isArray(tools)) return null;
  const stripFeatures = options.stripMessagesOnlyFeatures || false;

  const chatTools = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;

    // Strip Computer Use tools if enabled
    if (stripFeatures && COMPUTER_USE_TOOL_TYPES.has(tool.type)) {
      continue;
    }

    // Only convert standard tools
    if (!tool.name || !tool.input_schema) continue;

    chatTools.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} }
      }
    });
  }

  return chatTools.length > 0 ? chatTools : null;
}

function anthropicToolChoiceToChatToolChoice(toolChoice) {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'object') {
    const type = toolChoice.type;

    if (type === 'auto') return 'auto';
    if (type === 'any') return 'required';
    if (type === 'tool' && toolChoice.name) {
      return {
        type: 'function',
        function: { name: toolChoice.name }
      };
    }
  }

  return undefined;
}

function buildChatCompletionsFromMessages(body, model, options = {}) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8') || '{}');
  } catch (error) {
    const err = new Error(`invalid JSON body: ${error.message}`);
    err.statusCode = 400;
    throw err;
  }

  const stripFeatures = options.stripMessagesOnlyFeatures || false;

  // Convert messages
  const chatMessages = anthropicMessagesToChatMessages(payload.messages, { stripMessagesOnlyFeatures: stripFeatures });

  // Convert system prompt and prepend as system message
  const systemText = anthropicSystemToChatSystem(payload.system, { stripMessagesOnlyFeatures: stripFeatures });
  const finalMessages = [
    ...(systemText ? [{ role: 'system', content: systemText }] : []),
    ...chatMessages
  ];

  // Build Chat Completions payload
  const chat = {
    model: model || payload.model,
    messages: finalMessages.length > 0 ? finalMessages : [{ role: 'user', content: '' }],
    stream: Boolean(payload.stream)
  };

  // Convert tools
  const chatTools = anthropicToolsToChatTools(payload.tools, { stripMessagesOnlyFeatures: stripFeatures });
  if (chatTools) chat.tools = chatTools;

  // Convert tool_choice
  const chatToolChoice = anthropicToolChoiceToChatToolChoice(payload.tool_choice);
  if (chatToolChoice !== undefined) chat.tool_choice = chatToolChoice;

  // Max tokens
  if (typeof payload.max_tokens === 'number') {
    chat.max_completion_tokens = payload.max_tokens;
  }

  // Temperature, top_p
  if (typeof payload.temperature === 'number') chat.temperature = payload.temperature;
  if (typeof payload.top_p === 'number') chat.top_p = payload.top_p;

  // Stop sequences
  if (Array.isArray(payload.stop_sequences)) {
    chat.stop = payload.stop_sequences;
  }

  // Output format
  if (payload.output_config?.format?.type === 'json_schema') {
    chat.response_format = {
      type: 'json_schema',
      json_schema: payload.output_config.format.json_schema
    };
  }

  // Metadata → user
  if (payload.metadata?.user_id) {
    chat.user = payload.metadata.user_id;
  }

  // Stream options
  if (chat.stream && !chat.stream_options) {
    chat.stream_options = { include_usage: true };
  }

  return Buffer.from(JSON.stringify(chat));
}

// Chat Completions → Messages response conversion

function chatFinishReasonToMessagesStopReason(finishReason) {
  if (!finishReason) return 'end_turn';

  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'stop_sequence';
    default: return 'end_turn';
  }
}

function chatToolCallsToAnthropicContent(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

  return toolCalls.map(toolCall => {
    let input = {};
    try {
      input = typeof toolCall.function?.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function?.arguments || {};
    } catch {
      input = {};
    }

    return {
      type: 'tool_use',
      id: toolCall.id || `toolu_${now().toString(36)}`,
      name: toolCall.function?.name || 'unknown',
      input
    };
  });
}

function chatCompletionToMessagesJson(body, model) {
  let completion;
  try {
    completion = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return body;
  }

  const choice = completion.choices?.[0];
  if (!choice) return body;

  const message = choice.message || {};
  const content = [];

  // Add text content
  if (typeof message.content === 'string' && message.content) {
    content.push({
      type: 'text',
      text: message.content
    });
  }

  // Add tool calls
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    content.push(...chatToolCallsToAnthropicContent(message.tool_calls));
  }

  // Build Messages response
  const messagesResponse = {
    id: completion.id?.replace('chatcmpl-', 'msg_') || `msg_${now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: completion.model || model || '',
    stop_reason: chatFinishReasonToMessagesStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens || 0,
      output_tokens: completion.usage?.completion_tokens || 0
    }
  };

  return Buffer.from(JSON.stringify(messagesResponse));
}

function createChatToMessagesStreamAdapter(res, model) {
  let buffer = '';
  let messageId = `msg_${now().toString(36)}`;
  let messageStarted = false;
  let contentBlockIndex = 0;
  let currentContentBlock = null;
  let toolCallsBuffer = new Map(); // id -> { name, arguments }
  let finishReason = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let responseModel = model || '';

  function ensureMessageStarted() {
    if (messageStarted) return;
    messageStarted = true;

    res.write('event: message_start\n');
    res.write(`data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: responseModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })}\n\n`);
  }

  function startContentBlock(type, data = {}) {
    ensureMessageStarted();
    currentContentBlock = { type, index: contentBlockIndex, ...data };

    res.write('event: content_block_start\n');
    res.write(`data: ${JSON.stringify({
      type: 'content_block_start',
      index: contentBlockIndex,
      content_block: type === 'text'
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: data.id, name: data.name, input: {} }
    })}\n\n`);
  }

  function writeTextDelta(text) {
    if (!currentContentBlock || currentContentBlock.type !== 'text') {
      startContentBlock('text');
    }

    res.write('event: content_block_delta\n');
    res.write(`data: ${JSON.stringify({
      type: 'content_block_delta',
      index: contentBlockIndex,
      delta: { type: 'text_delta', text }
    })}\n\n`);
  }

  function writeToolUseDelta(partialJson) {
    res.write('event: content_block_delta\n');
    res.write(`data: ${JSON.stringify({
      type: 'content_block_delta',
      index: contentBlockIndex,
      delta: { type: 'input_json_delta', partial_json: partialJson }
    })}\n\n`);
  }

  function stopContentBlock() {
    if (currentContentBlock) {
      res.write('event: content_block_stop\n');
      res.write(`data: ${JSON.stringify({
        type: 'content_block_stop',
        index: contentBlockIndex
      })}\n\n`);

      contentBlockIndex++;
      currentContentBlock = null;
    }
  }

  function writeMessageStop() {
    stopContentBlock();

    res.write('event: message_delta\n');
    res.write(`data: ${JSON.stringify({
      type: 'message_delta',
      delta: {
        stop_reason: chatFinishReasonToMessagesStopReason(finishReason),
        stop_sequence: null
      },
      usage: { output_tokens: totalOutputTokens }
    })}\n\n`);

    res.write('event: message_stop\n');
    res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  }

  function handleChunk(chunk) {
    const { payload } = parseSseEvent(chunk);
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') {
        writeMessageStop();
      }
      return;
    }

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }

    // Extract model and ID
    if (event.id) {
      messageId = event.id.replace('chatcmpl-', 'msg_');
    }
    if (event.model) {
      responseModel = event.model;
    }

    const choice = event.choices?.[0];
    if (!choice) return;

    const delta = choice.delta || {};

    // Handle role (message start)
    if (delta.role && !messageStarted) {
      ensureMessageStarted();
    }

    // Handle text content
    if (typeof delta.content === 'string' && delta.content) {
      writeTextDelta(delta.content);
    }

    // Handle tool calls
    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index || 0;
        const id = toolCall.id || `toolu_${index}`;

        if (!toolCallsBuffer.has(id)) {
          // New tool call - stop previous content block and start new one
          stopContentBlock();

          const name = toolCall.function?.name || 'unknown';
          toolCallsBuffer.set(id, { name, arguments: '' });

          startContentBlock('tool_use', { id, name });
        }

        // Accumulate arguments
        if (toolCall.function?.arguments) {
          const toolData = toolCallsBuffer.get(id);
          toolData.arguments += toolCall.function.arguments;
          writeToolUseDelta(toolCall.function.arguments);
        }
      }
    }

    // Handle finish reason
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    // Handle usage (if present in streaming)
    if (event.usage) {
      totalInputTokens = event.usage.prompt_tokens || 0;
      totalOutputTokens = event.usage.completion_tokens || 0;
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
        handleChunk(eventText);
      }
    },
    end() {
      if (buffer) {
        handleChunk(buffer);
        buffer = '';
      }
      writeMessageStop();
      res.end();
    }
  };
}

const CONVERTIBLE_RESPONSES_INPUT_ITEM_TYPES = new Set([
  'message',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output'
]);
const CONVERTIBLE_RESPONSES_CONTENT_TYPES = new Set(['text', 'input_text', 'output_text', 'input_image', 'input_file']);

function unsupportedResponsesInputTypesFromContent(content, options = {}) {
  if (content === undefined || content === null || typeof content === 'string') return [];
  if (!Array.isArray(content)) return ['content:unknown'];
  const adapter = options.targetAdapter || options.adapter || '';
  const types = new Set();
  for (const block of content) {
    if (typeof block === 'string') continue;
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      types.add('content:unknown');
      continue;
    }
    const type = typeof block.type === 'string' && block.type.trim() ? block.type.trim() : '';
    if ((type === 'input_image' || type === 'input_file') && adapter && !responsesContentBlockConvertibleForAdapter(block, adapter)) {
      types.add(`content:${type}`);
      continue;
    }
    if (type && !CONVERTIBLE_RESPONSES_CONTENT_TYPES.has(type)) types.add(`content:${type}`);
  }
  return [...types];
}

function unsupportedResponsesInputTypesFromInput(input, options = {}) {
  if (input === undefined || input === null || typeof input === 'string') return [];
  if (!Array.isArray(input)) return ['unknown'];
  const types = new Set();
  for (const item of input) {
    if (typeof item === 'string') continue;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      types.add('unknown');
      continue;
    }
    const type = typeof item.type === 'string' && item.type.trim() ? item.type.trim() : '';
    if (type && !CONVERTIBLE_RESPONSES_INPUT_ITEM_TYPES.has(type)) types.add(type);
    const contentTypes = unsupportedResponsesInputTypesFromContent(item.content ?? item.text ?? item.message, options);
    for (const contentType of contentTypes) types.add(contentType);
  }
  return [...types];
}

function unsupportedResponsesInputTypesFromPayload(payload, options = {}) {
  return unsupportedResponsesInputTypesFromInput(payload?.input, options);
}

function unsupportedResponsesInputTypesFromBody(req, body, options = {}) {
  const payload = jsonObjectFromRequestBody(req, body, options);
  return payload ? unsupportedResponsesInputTypesFromPayload(payload, options) : [];
}

function unsupportedResponsesFieldTypesFromPayload(payload, options = {}) {
  if (!objectRecord(payload)) return [];
  const fields = new Set();
  for (const field of RESPONSE_COMPATIBILITY_SCRUB_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) fields.add(field);
  }
  if (objectRecord(payload.text) && Object.prototype.hasOwnProperty.call(payload.text, 'verbosity')) {
    fields.add(RESPONSE_COMPATIBILITY_CHAT_TEXT_VERBOSITY_FIELD);
  }
  return [...fields];
}

function unsupportedResponsesFieldTypesFromBody(req, body, options = {}) {
  const payload = jsonObjectFromRequestBody(req, body, options);
  return payload ? unsupportedResponsesFieldTypesFromPayload(payload, options) : [];
}

function responsesInputItemType(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  return typeof item.type === 'string' && item.type.trim() ? item.type.trim() : '';
}

function stripResponsesOnlyFeaturesFromPayload(payload, diagnostics) {
  const next = { ...payload };
  const strippedToolTypes = [];
  if (Array.isArray(next.tools)) {
    const tools = [];
    for (const tool of next.tools) {
      if (responseFunctionToolParts(tool)) {
        tools.push(tool);
      } else {
        strippedToolTypes.push(responsesToolTypeLabel(tool));
      }
    }
    if (tools.length > 0) next.tools = tools;
    else delete next.tools;
  }

  const strippedInputTypes = [];
  if (Array.isArray(next.input)) {
    next.input = next.input.filter((item) => {
      const type = responsesInputItemType(item);
      if (STRIPPABLE_RESPONSES_INPUT_ITEM_TYPES.has(type)) {
        strippedInputTypes.push(type);
        return false;
      }
      return true;
    });
  }

  diagnostics.tool_types = [...new Set(strippedToolTypes)];
  diagnostics.input_types = [...new Set(strippedInputTypes)];
  diagnostics.output_format_types = [];
  diagnostics.content_types = [];
  return next;
}

function stripResponsesOnlyFeaturesFromBody(req, body, diagnostics, options = {}) {
  const payload = jsonObjectFromRequestBody(req, body, options);
  if (!payload) return body;
  return Buffer.from(JSON.stringify(stripResponsesOnlyFeaturesFromPayload(payload, diagnostics)));
}

function unsupportedToolConversionMessage(types, adapterName) {
  const list = types.length ? types.join(', ') : 'unknown';
  return `unsupported Responses tool types for ${adapterName}: ${list}; route this request to a native /v1/responses upstream or use function tools`;
}

function unsupportedToolConversionError(types, adapterName) {
  const err = new Error(unsupportedToolConversionMessage(types, adapterName));
  err.statusCode = 422;
  err.unsupportedToolTypes = types;
  return err;
}

function assertResponsesToolsConvertible(tools, adapterName) {
  const unsupportedTypes = unsupportedResponsesToolTypesFromTools(tools);
  if (unsupportedTypes.length > 0) throw unsupportedToolConversionError(unsupportedTypes, adapterName);
}

function chatToolFromResponsesTool(tool) {
  const customParts = responseCustomToolParts(tool);
  if (customParts) {
    const custom = { name: customParts.name };
    if (customParts.description !== undefined) custom.description = String(customParts.description);
    if (customParts.format !== undefined) custom.format = customParts.format;
    return { type: 'custom', custom };
  }
  const parts = responseFunctionToolParts(tool);
  if (!parts) return null;
  const fn = {
    name: parts.name,
    parameters: parts.parameters && typeof parts.parameters === 'object'
      ? parts.parameters
      : { type: 'object', properties: {} }
  };
  if (parts.description !== undefined) fn.description = String(parts.description);
  if (parts.strict !== undefined) fn.strict = parts.strict;
  return { type: 'function', function: fn };
}

function chatToolsFromResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const expanded = [];
  for (const tool of tools) {
    if (tool?.type === 'namespace') expanded.push(...responseNamespaceToolParts(tool));
    else expanded.push(tool);
  }
  const converted = expanded.map(chatToolFromResponsesTool).filter(Boolean);
  return converted.length > 0 ? converted : undefined;
}

function anthropicToolFromResponsesTool(tool) {
  const customParts = responseCustomToolParts(tool);
  if (customParts) {
    const anthropicCustomTool = {
      name: customParts.name,
      input_schema: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input']
      }
    };
    if (customParts.description !== undefined) anthropicCustomTool.description = String(customParts.description);
    return anthropicCustomTool;
  }
  if (tool?.type === 'web_search' || tool?.type === 'web_search_preview') {
    const webSearch = {
      type: 'web_search_20260209',
      name: 'web_search'
    };
    if (Number.isFinite(Number(tool.max_uses))) webSearch.max_uses = Math.floor(Number(tool.max_uses));
    if (Array.isArray(tool.allowed_domains)) webSearch.allowed_domains = tool.allowed_domains.map(String);
    if (Array.isArray(tool.blocked_domains)) webSearch.blocked_domains = tool.blocked_domains.map(String);
    if (objectRecord(tool.user_location)) {
      const location = tool.user_location.approximate && objectRecord(tool.user_location.approximate)
        ? tool.user_location.approximate
        : tool.user_location;
      webSearch.user_location = {
        type: 'approximate',
        ...Object.fromEntries(
          ['city', 'region', 'country', 'timezone']
            .filter((key) => typeof location[key] === 'string' && location[key].trim())
            .map((key) => [key, location[key]])
        )
      };
    }
    return webSearch;
  }
  if (tool?.type === 'tool_search') {
    return { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' };
  }
  const parts = responseFunctionToolParts(tool);
  if (!parts) return null;
  const anthropicTool = {
    name: parts.name,
    input_schema: parts.parameters && typeof parts.parameters === 'object'
      ? parts.parameters
      : { type: 'object', properties: {} }
  };
  if (parts.description !== undefined) anthropicTool.description = String(parts.description);
  return anthropicTool;
}

function anthropicToolsFromResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const expanded = [];
  for (const tool of tools) {
    if (tool?.type === 'namespace') expanded.push(...responseNamespaceToolParts(tool));
    else expanded.push(tool);
  }
  const converted = expanded.map(anthropicToolFromResponsesTool).filter(Boolean);
  return converted.length > 0 ? converted : undefined;
}

function chatToolChoiceFromResponsesToolChoice(choice) {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') {
    const value = choice.trim();
    if (CHAT_COMPLETIONS_TOOL_CHOICE_STRINGS.has(value)) return value;
    throw unsupportedToolConversionError([value || 'unknown'], 'Chat Completions adapter');
  }
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
    throw unsupportedToolConversionError(['unknown'], 'Chat Completions adapter');
  }
  const name = choice.function?.name || choice.name;
  if (choice.type === 'function' && typeof name === 'string' && name.trim()) {
    return { type: 'function', function: { name: name.trim() } };
  }
  if (choice.type === 'custom' && typeof name === 'string' && name.trim()) {
    return { type: 'custom', custom: { name: safeToolName(name, 'custom_tool') } };
  }
  const type = String(choice.type || '').trim();
  if (CHAT_COMPLETIONS_TOOL_CHOICE_STRINGS.has(type) && isSimpleToolChoiceObject(choice, type)) return type;
  if (type === 'web_search' || type === 'web_search_preview') return undefined;
  throw unsupportedToolConversionError([type || 'unknown'], 'Chat Completions adapter');
}

function anthropicToolChoiceFromResponsesToolChoice(choice) {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'required') return { type: 'any' };
    if (choice === 'auto' || choice === 'none') return { type: choice };
    throw unsupportedToolConversionError([choice || 'unknown'], 'Anthropic Messages adapter');
  }
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
    throw unsupportedToolConversionError(['unknown'], 'Anthropic Messages adapter');
  }
  const type = String(choice.type || '').trim();
  const name = choice.function?.name || choice.name;
  if ((type === 'function' || type === 'custom' || type === 'tool') && typeof name === 'string' && name.trim()) {
    return { type: 'tool', name: safeToolName(name, 'tool') };
  }
  if ((type === 'web_search' || type === 'web_search_preview')) {
    return { type: 'tool', name: 'web_search' };
  }
  if (type === 'tool_search') {
    return { type: 'tool', name: 'tool_search_tool_bm25' };
  }
  if (type === 'required') return { type: 'any' };
  if (type === 'any' || type === 'auto' || type === 'none') return { type };
  throw unsupportedToolConversionError([type || 'unknown'], 'Anthropic Messages adapter');
}

function responsesInputToChatMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    // Handle function/custom tool calls -> assistant message with tool_calls
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const toolCall = {
        id: item.call_id || item.id || `call_${now().toString(36)}`,
        type: item.type === 'custom_tool_call' ? 'custom' : 'function'
      };
      if (item.type === 'custom_tool_call') {
        toolCall.custom = {
          name: safeToolName(item.name || '', 'custom_tool'),
          input: stringFromToolOutput(firstDefined(item.input, item.arguments))
        };
      } else {
        toolCall.function = {
          name: item.name || '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
        };
      }
      // Merge consecutive function_calls into the same assistant message
      const previous = messages[messages.length - 1];
      if (previous && previous.role === 'assistant' && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(toolCall);
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
      }
      continue;
    }

    // Handle function/custom tool outputs -> tool role message
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || '',
        content: stringFromToolOutput(item.output)
      });
      continue;
    }

    const role = item.role === 'assistant'
      ? 'assistant'
      : item.role === 'system'
        ? 'system'
        : item.role === 'developer'
          ? 'developer'
          : 'user';
    const content = chatContentFromResponsesContent(item.content ?? item.text ?? item.message, role);
    if (!content) continue;
    const previous = messages[messages.length - 1];
    if (previous && previous.role === role && !previous.tool_calls) mergeChatMessageContent(previous, content);
    else messages.push({ role, content });
  }
  return messages;
}

function anthropicTextBlocksFromResponsesContent(content) {
  return anthropicContentBlocksFromResponsesContent(content);
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
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const input = item.type === 'custom_tool_call'
        ? { input: stringFromToolOutput(firstDefined(item.input, item.arguments)) }
        : objectFromToolArguments(item.arguments);
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: item.call_id || item.id || `toolu_pool_${now().toString(36)}`,
          name: safeToolName(item.name || '', 'tool'),
          input
        }]
      });
      continue;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: item.call_id || '',
          content: stringFromToolOutput(item.output)
        }]
      });
      continue;
    }
    if (item.type === 'thinking' || item.type === 'redacted_thinking') {
      messages.push({ role: 'assistant', content: [item] });
      continue;
    }
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

const CHAT_COMPLETIONS_PASSTHROUGH_FIELDS = [
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'n',
  'response_format',
  'seed',
  'user',
  'store',
  'metadata',
  'service_tier',
  'stream_options',
  'parallel_tool_calls',
  'modalities',
  'audio',
  'prediction',
  'prompt_cache_key',
  'prompt_cache_retention',
  'reasoning_effort',
  'safety_identifier',
  'verbosity',
  'web_search_options'
];

const CHAT_COMPLETIONS_RESPONSES_TEXT_FORMAT_TYPES = new Set(['text', 'json_object', 'json_schema']);
const ANTHROPIC_RESPONSES_TEXT_FORMAT_TYPES = new Set(['text', 'json_object', 'json_schema']);

function copyPayloadFields(target, source, fields) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
      target[field] = source[field];
    }
  }
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function responsesTextFormatFromPayload(payload) {
  if (!objectRecord(payload) || !objectRecord(payload.text) || !objectRecord(payload.text.format)) return undefined;
  return payload.text.format;
}

function responsesTextFormatTypeLabel(format) {
  if (objectRecord(format) && typeof format.type === 'string' && format.type.trim()) return format.type.trim();
  return 'unknown';
}

function unsupportedResponsesOutputFormatTypesFromPayload(payload, supportedTypes) {
  const format = responsesTextFormatFromPayload(payload);
  if (!format) return [];
  const type = responsesTextFormatTypeLabel(format);
  return supportedTypes.has(type) ? [] : [type];
}

function unsupportedResponsesOutputFormatTypesFromBody(req, body, supportedTypes, options = {}) {
  const payload = jsonObjectFromRequestBody(req, body, options);
  return payload ? unsupportedResponsesOutputFormatTypesFromPayload(payload, supportedTypes) : [];
}

function unsupportedOutputFormatConversionMessage(types, adapterName) {
  const list = types.length ? types.join(', ') : 'unknown';
  return `unsupported Responses text.format types for ${adapterName}: ${list}; route this request to a native /v1/responses upstream or use a convertible output format`;
}

function unsupportedOutputFormatConversionError(types, adapterName) {
  const err = new Error(unsupportedOutputFormatConversionMessage(types, adapterName));
  err.statusCode = 422;
  err.unsupportedOutputFormatTypes = types;
  return err;
}

function assertResponsesOutputFormatConvertible(payload, supportedTypes, adapterName) {
  const unsupportedTypes = unsupportedResponsesOutputFormatTypesFromPayload(payload, supportedTypes);
  if (unsupportedTypes.length > 0) throw unsupportedOutputFormatConversionError(unsupportedTypes, adapterName);
}

function unconvertibleChatOutputFormatTypesFromBody(req, body, options = {}) {
  const payload = jsonObjectFromRequestBody(req, body, options);
  if (!payload) return [];
  try {
    const format = responsesTextFormatFromPayload(payload);
    if (!format) return [];
    chatResponseFormatFromResponsesTextFormat(format);
    return [];
  } catch (error) {
    if (Array.isArray(error.unsupportedOutputFormatTypes)) return error.unsupportedOutputFormatTypes;
    return [];
  }
}

function unsupportedInputConversionMessage(types, adapterName) {
  const list = types.length ? types.join(', ') : 'unknown';
  return `unsupported Responses input item/content types for ${adapterName}: ${list}; route this request to a native /v1/responses upstream or use text/function-call inputs`;
}

function unsupportedResponsesFeatureSummary(toolTypes, outputFormatTypes, inputTypes, fieldTypes = []) {
  const parts = [];
  if (toolTypes.length > 0) parts.push('tool types');
  if (outputFormatTypes.length > 0) parts.push('text.format types');
  if (inputTypes.length > 0) parts.push('input item/content types');
  if (fieldTypes.length > 0) parts.push('fields');
  return parts.length ? parts.join('/') : 'tools/output formats/inputs';
}

function unsupportedChatAdapterConversionMessage(toolTypes, outputFormatTypes, inputTypes = [], fieldTypes = []) {
  if (toolTypes.length > 0 && outputFormatTypes.length === 0 && inputTypes.length === 0 && fieldTypes.length === 0) {
    return unsupportedToolConversionMessage(toolTypes, 'Chat Completions adapter');
  }
  if (outputFormatTypes.length > 0 && toolTypes.length === 0 && inputTypes.length === 0 && fieldTypes.length === 0) {
    return unsupportedOutputFormatConversionMessage(outputFormatTypes, 'Chat Completions adapter');
  }
  if (inputTypes.length > 0 && toolTypes.length === 0 && outputFormatTypes.length === 0 && fieldTypes.length === 0) {
    return unsupportedInputConversionMessage(inputTypes, 'Chat Completions adapter');
  }
  if (fieldTypes.length > 0 && toolTypes.length === 0 && outputFormatTypes.length === 0 && inputTypes.length === 0) {
    return `unsupported Responses fields for Chat Completions adapter: ${fieldTypes.join(', ')}; route this request to a native /v1/responses upstream or enable adapter compatibility mode`;
  }
  const toolList = toolTypes.length ? toolTypes.join(', ') : 'none';
  const outputList = outputFormatTypes.length ? outputFormatTypes.join(', ') : 'none';
  const inputList = inputTypes.length ? inputTypes.join(', ') : 'none';
  const fieldList = fieldTypes.length ? fieldTypes.join(', ') : 'none';
  return `unsupported Responses features for Chat Completions adapter: tool types=${toolList}; text.format types=${outputList}; input item/content types=${inputList}; fields=${fieldList}; route this request to a native /v1/responses upstream or use convertible function tools/output formats/inputs`;
}

function unavailableNativeResponsesConversionMessage(toolTypes, outputFormatTypes, inputTypes = [], fieldTypes = []) {
  if (toolTypes.length > 0 && outputFormatTypes.length === 0 && inputTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses tool types cannot be converted by available upstreams; route this request to a native /v1/responses upstream or use function tools';
  }
  if (outputFormatTypes.length > 0 && toolTypes.length === 0 && inputTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses text.format types cannot be converted by available upstreams; route this request to a native /v1/responses upstream or use a convertible output format';
  }
  if (inputTypes.length > 0 && toolTypes.length === 0 && outputFormatTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses input item/content types cannot be converted by available upstreams; route this request to a native /v1/responses upstream or use text/function-call inputs';
  }
  if (fieldTypes.length > 0 && toolTypes.length === 0 && outputFormatTypes.length === 0 && inputTypes.length === 0) {
    return 'unsupported Responses fields cannot be converted by available upstreams; route this request to a native /v1/responses upstream or enable adapter compatibility mode';
  }
  const summary = unsupportedResponsesFeatureSummary(toolTypes, outputFormatTypes, inputTypes, fieldTypes);
  return `unsupported Responses ${summary} cannot be converted by available upstreams; route this request to a native /v1/responses upstream or use convertible function tools/output formats/inputs`;
}

function nativeResponsesRequiredFailureMessage(toolTypes, outputFormatTypes, inputTypes = [], fieldTypes = []) {
  if (toolTypes.length > 0 && outputFormatTypes.length === 0 && inputTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses tool types cannot be converted by available upstreams; native /v1/responses attempts failed and Chat Completions fallback is disabled';
  }
  if (outputFormatTypes.length > 0 && toolTypes.length === 0 && inputTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses text.format types cannot be converted by available upstreams; native /v1/responses attempts failed and Chat Completions fallback is disabled';
  }
  if (inputTypes.length > 0 && toolTypes.length === 0 && outputFormatTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses input item/content types cannot be converted by available upstreams; native /v1/responses attempts failed and Chat Completions fallback is disabled';
  }
  if (fieldTypes.length > 0 && toolTypes.length === 0 && outputFormatTypes.length === 0 && inputTypes.length === 0) {
    return 'unsupported Responses fields cannot be converted by available upstreams; native /v1/responses attempts failed and Chat Completions fallback is disabled';
  }
  const summary = unsupportedResponsesFeatureSummary(toolTypes, outputFormatTypes, inputTypes, fieldTypes);
  return `unsupported Responses ${summary} cannot be converted by available upstreams; native /v1/responses attempts failed and Chat Completions fallback is disabled`;
}

function noNativeResponsesCandidateMessage(toolTypes, outputFormatTypes, inputTypes = [], fieldTypes = []) {
  if (toolTypes.length > 0 && outputFormatTypes.length === 0 && inputTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses tool types require a native /v1/responses upstream; no compatible upstream candidate is currently available';
  }
  if (outputFormatTypes.length > 0 && toolTypes.length === 0 && inputTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses text.format types require a native /v1/responses upstream; no compatible upstream candidate is currently available';
  }
  if (inputTypes.length > 0 && toolTypes.length === 0 && outputFormatTypes.length === 0 && fieldTypes.length === 0) {
    return 'unsupported Responses input item/content types require a native /v1/responses upstream; no compatible upstream candidate is currently available';
  }
  if (fieldTypes.length > 0 && toolTypes.length === 0 && outputFormatTypes.length === 0 && inputTypes.length === 0) {
    return 'unsupported Responses fields require a native /v1/responses upstream; no compatible upstream candidate is currently available';
  }
  const summary = unsupportedResponsesFeatureSummary(toolTypes, outputFormatTypes, inputTypes, fieldTypes);
  return `unsupported Responses ${summary} require a native /v1/responses upstream; no compatible upstream candidate is currently available`;
}

function retryableStatusWithNativeResponsesUnsupported(baseRetryableStatus) {
  const retryableStatus = new Set(baseRetryableStatus);
  for (const status of NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS) retryableStatus.add(status);
  return retryableStatus;
}

function compatibilityAdapterAllowed(state, model) {
  const mode = state.compatibility?.adapterMode;
  if (!mode?.stripResponsesOnlyFeatures) return false;
  return isClaudeModel(model)
    ? mode.adapters?.anthropicMessages === true
    : mode.adapters?.chatCompletions === true;
}

function emptyCompatibilityBucket() {
  return {
    tool_types: [],
    input_types: [],
    output_format_types: [],
    content_types: [],
    fields: []
  };
}

function addCompatibilityDiagnostic(bucket, key, value) {
  if (!value) return;
  if (!Array.isArray(bucket[key])) bucket[key] = [];
  if (!bucket[key].includes(value)) bucket[key].push(value);
}

function createCompatibilityDiagnostics() {
  return {
    converted: emptyCompatibilityBucket(),
    downgraded: emptyCompatibilityBucket(),
    stripped: emptyCompatibilityBucket()
  };
}

function stripCompatibilityField(payload, diagnostics, field) {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) return;
  delete payload[field];
  addCompatibilityDiagnostic(diagnostics.stripped, 'fields', field);
}

function sanitizeCompatibilityText(payload, adapter, diagnostics) {
  if (!objectRecord(payload.text)) return;
  if (!Object.prototype.hasOwnProperty.call(payload.text, 'verbosity')) return;
  const text = { ...payload.text };
  if (adapter === 'chat_completions') {
    if (payload.verbosity === undefined) {
      payload.verbosity = text.verbosity;
      addCompatibilityDiagnostic(diagnostics.converted, 'fields', 'text.verbosity->verbosity');
    } else {
      addCompatibilityDiagnostic(diagnostics.downgraded, 'fields', RESPONSE_COMPATIBILITY_CHAT_TEXT_VERBOSITY_FIELD);
    }
  } else {
    addCompatibilityDiagnostic(diagnostics.stripped, 'fields', RESPONSE_COMPATIBILITY_CHAT_TEXT_VERBOSITY_FIELD);
  }
  delete text.verbosity;
  if (Object.keys(text).length > 0) payload.text = text;
  else delete payload.text;
}

function compatibilityToolsForAdapter(tool, adapter, payload, diagnostics) {
  const type = responsesToolTypeLabel(tool);
  if (responseFunctionToolParts(tool)) return [tool];
  if (responseCustomToolParts(tool)) {
    addCompatibilityDiagnostic(diagnostics.converted, 'tool_types', 'custom');
    if (adapter === 'anthropic_messages') addCompatibilityDiagnostic(diagnostics.downgraded, 'tool_types', 'custom');
    return [tool];
  }
  if (type === 'namespace') {
    const tools = responseNamespaceToolParts(tool);
    if (tools.length > 0) {
      addCompatibilityDiagnostic(diagnostics.downgraded, 'tool_types', 'namespace');
      return tools;
    }
    addCompatibilityDiagnostic(diagnostics.stripped, 'tool_types', 'namespace');
    return [];
  }
  if (type === 'web_search' || type === 'web_search_preview') {
    if (adapter === 'chat_completions') {
      const webSearchOptions = webSearchOptionsFromResponsesTools([tool]);
      if (webSearchOptions && payload.web_search_options === undefined) payload.web_search_options = webSearchOptions;
      addCompatibilityDiagnostic(diagnostics.converted, 'tool_types', type);
      addCompatibilityDiagnostic(diagnostics.downgraded, 'tool_types', type);
      return [];
    }
    addCompatibilityDiagnostic(diagnostics.converted, 'tool_types', type);
    return [tool];
  }
  if (type === 'tool_search') {
    if (adapter === 'anthropic_messages') {
      addCompatibilityDiagnostic(diagnostics.converted, 'tool_types', 'tool_search');
      addCompatibilityDiagnostic(diagnostics.downgraded, 'tool_types', 'tool_search');
      return [tool];
    }
    addCompatibilityDiagnostic(diagnostics.stripped, 'tool_types', 'tool_search');
    return [];
  }
  addCompatibilityDiagnostic(diagnostics.stripped, 'tool_types', type);
  return [];
}

function sanitizeCompatibilityToolChoice(payload, adapter, diagnostics) {
  const choice = payload.tool_choice;
  if (choice === undefined) return;
  const type = typeof choice === 'string' ? choice.trim() : String(choice?.type || '').trim();
  if (!type || ['auto', 'none', 'required', 'any'].includes(type)) return;
  if (type === 'function' || type === 'custom') return;
  if ((type === 'web_search' || type === 'web_search_preview') && adapter === 'anthropic_messages') return;
  if (type === 'tool_search' && adapter === 'anthropic_messages') return;
  if ((type === 'web_search' || type === 'web_search_preview') && adapter === 'chat_completions') {
    delete payload.tool_choice;
    addCompatibilityDiagnostic(diagnostics.downgraded, 'fields', `tool_choice:${type}`);
    return;
  }
  payload.tool_choice = 'auto';
  addCompatibilityDiagnostic(diagnostics.downgraded, 'fields', `tool_choice:${type}`);
}

function sanitizeCompatibilityContent(content, adapter, diagnostics) {
  if (!Array.isArray(content)) return content;
  const next = [];
  for (const block of content) {
    if (typeof block === 'string') {
      next.push(block);
      continue;
    }
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      addCompatibilityDiagnostic(diagnostics.stripped, 'content_types', 'unknown');
      continue;
    }
    const type = typeof block.type === 'string' && block.type.trim() ? block.type.trim() : '';
    if (type === 'input_image' || type === 'input_file') {
      if (responsesContentBlockConvertibleForAdapter(block, adapter)) {
        addCompatibilityDiagnostic(diagnostics.converted, 'content_types', type);
        for (const field of downgradedResponsesContentFieldsForAdapter(block, adapter)) {
          addCompatibilityDiagnostic(diagnostics.downgraded, 'fields', field);
        }
        next.push(block);
      } else {
        addCompatibilityDiagnostic(diagnostics.stripped, 'content_types', type);
      }
      continue;
    }
    if (type && !CONVERTIBLE_RESPONSES_CONTENT_TYPES.has(type)) {
      addCompatibilityDiagnostic(diagnostics.stripped, 'content_types', type);
      continue;
    }
    next.push(block);
  }
  return next;
}

function sanitizeCompatibilityInput(input, adapter, diagnostics) {
  if (!Array.isArray(input)) return input;
  const next = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      next.push(item);
      continue;
    }
    const type = responsesInputItemType(item);
    if (type === 'reasoning') {
      addCompatibilityDiagnostic(diagnostics.stripped, 'input_types', 'reasoning');
      continue;
    }
    if (type === 'custom_tool_call' || type === 'custom_tool_call_output') {
      addCompatibilityDiagnostic(diagnostics.converted, 'input_types', type);
    } else if (type && !CONVERTIBLE_RESPONSES_INPUT_ITEM_TYPES.has(type)) {
      addCompatibilityDiagnostic(diagnostics.stripped, 'input_types', type);
      continue;
    }

    const contentKey = item.content !== undefined
      ? 'content'
      : item.text !== undefined
        ? 'text'
        : item.message !== undefined
          ? 'message'
          : '';
    const content = contentKey ? item[contentKey] : undefined;
    let nextItem = item;
    if (Array.isArray(content)) {
      nextItem = { ...item, [contentKey]: sanitizeCompatibilityContent(content, adapter, diagnostics) };
    }
    next.push(nextItem);
  }
  return next;
}

function sanitizePayloadForAdapterCompatibility(payload, adapter, diagnostics) {
  const next = { ...payload };
  for (const field of RESPONSE_COMPATIBILITY_SCRUB_FIELDS) stripCompatibilityField(next, diagnostics, field);
  sanitizeCompatibilityText(next, adapter, diagnostics);

  if (objectRecord(next.reasoning)) {
    if (typeof next.reasoning.effort === 'string' && next.reasoning.effort.trim()) {
      if (adapter === 'chat_completions' && next.reasoning_effort === undefined) {
        next.reasoning_effort = next.reasoning.effort.trim();
        addCompatibilityDiagnostic(diagnostics.converted, 'fields', 'reasoning.effort->reasoning_effort');
      } else if (adapter === 'anthropic_messages') {
        next.output_config = objectRecord(next.output_config) ? { ...next.output_config } : {};
        if (next.output_config.effort === undefined) next.output_config.effort = next.reasoning.effort.trim();
        addCompatibilityDiagnostic(diagnostics.converted, 'fields', 'reasoning.effort->output_config.effort');
      }
    }
    delete next.reasoning;
    addCompatibilityDiagnostic(diagnostics.stripped, 'fields', 'reasoning');
  }

  const format = responsesTextFormatFromPayload(next);
  const formatType = responsesTextFormatTypeLabel(format);
  if (format && formatType === 'grammar') {
    delete next.text;
    addCompatibilityDiagnostic(diagnostics.stripped, 'output_format_types', 'grammar');
  } else if (format && formatType === 'json_schema') {
    addCompatibilityDiagnostic(diagnostics.converted, 'output_format_types', 'json_schema');
  } else if (format && formatType === 'json_object') {
    addCompatibilityDiagnostic(diagnostics.converted, 'output_format_types', 'json_object');
    if (adapter === 'anthropic_messages') addCompatibilityDiagnostic(diagnostics.downgraded, 'output_format_types', 'json_object');
  }

  if (Array.isArray(next.tools)) {
    const compatibleTools = [];
    for (const tool of next.tools) {
      compatibleTools.push(...compatibilityToolsForAdapter(tool, adapter, next, diagnostics));
    }
    if (compatibleTools.length > 0) next.tools = compatibleTools;
    else delete next.tools;
  }

  sanitizeCompatibilityToolChoice(next, adapter, diagnostics);
  if (Array.isArray(next.input)) next.input = sanitizeCompatibilityInput(next.input, adapter, diagnostics);
  return next;
}

function buildAdapterCompatibilityPlan({ req, body, model, state, options = {}, trigger = 'no_native_responses_candidate' } = {}) {
  if (!compatibilityAdapterAllowed(state, model)) return null;
  const payload = jsonObjectFromRequestBody(req, body, options);
  if (!payload) return null;
  const adapter = isClaudeModel(model) ? 'anthropic_messages' : 'chat_completions';
  const toolDeclarationTypes = unsupportedResponsesToolTypesFromTools(payload.tools);
  const toolChoiceTypes = unsupportedResponsesToolChoiceTypesFromChoice(payload.tool_choice);
  const inputTypes = unsupportedResponsesInputTypesFromPayload(payload, { targetAdapter: adapter });
  const outputFormatTypes = unsupportedResponsesOutputFormatTypesFromPayload(
    payload,
    adapter === 'anthropic_messages' ? ANTHROPIC_RESPONSES_TEXT_FORMAT_TYPES : CHAT_COMPLETIONS_RESPONSES_TEXT_FORMAT_TYPES
  );
  const fieldTypes = unsupportedResponsesFieldTypesFromPayload(payload, { targetAdapter: adapter });
  if (
    toolDeclarationTypes.length === 0 &&
    toolChoiceTypes.length === 0 &&
    inputTypes.length === 0 &&
    outputFormatTypes.length === 0 &&
    fieldTypes.length === 0
  ) return null;
  const diagnostics = createCompatibilityDiagnostics();
  const compatiblePayload = sanitizePayloadForAdapterCompatibility(payload, adapter, diagnostics);
  return {
    mode: 'adapter',
    trigger,
    target_adapter: adapter,
    converted: diagnostics.converted,
    downgraded: diagnostics.downgraded,
    stripped: diagnostics.stripped,
    strippedBody: Buffer.from(JSON.stringify(compatiblePayload))
  };
}

function compatibilitySummary(plan, routeTrace = null) {
  if (!plan) return null;
  const bucket = (value = {}) => ({
    tool_types: value.tool_types || [],
    input_types: value.input_types || [],
    output_format_types: value.output_format_types || [],
    content_types: value.content_types || [],
    fields: value.fields || []
  });
  return {
    mode: plan.mode,
    trigger: plan.trigger,
    target_adapter: plan.target_adapter || '',
    adapter: routeTrace?.adapter || '',
    converted: bucket(plan.converted),
    downgraded: bucket(plan.downgraded),
    stripped: bucket(plan.stripped)
  };
}

function compatibilityBucketHeader(bucket = {}) {
  const tools = (bucket.tool_types || []).join(',');
  const inputs = (bucket.input_types || []).join(',');
  const outputs = (bucket.output_format_types || []).join(',');
  const content = (bucket.content_types || []).join(',');
  const fields = (bucket.fields || []).join(',');
  return `tools=${tools}; inputs=${inputs}; outputs=${outputs}; content=${content}; fields=${fields}`;
}

function compatibilityStrippedHeader(stripped = {}) {
  return compatibilityBucketHeader(stripped);
}

// Build a compatibility record for the Messages→Chat adapter by inspecting the
// original Anthropic Messages request body for Messages-only features that will
// be stripped during conversion. Returns a plan-shaped object whose `stripped`
// bucket lists the removed features, so the response header and Recent Request
// Timeline can surface the conversion transparently.
function buildMessagesAdapterCompatibility(body) {
  let payload = null;
  try {
    payload = typeof body === 'string' || Buffer.isBuffer(body)
      ? JSON.parse(String(body))
      : body;
  } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;

  const fields = new Set();
  const contentTypes = new Set();
  const toolTypes = new Set();

  // cache_control anywhere (system / message / content / tool)
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      if (block && typeof block === 'object' && block.cache_control) fields.add('cache_control');
    }
  }
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!message || typeof message !== 'object') continue;
      if (message.cache_control) fields.add('cache_control');
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'thinking') contentTypes.add('thinking');
          if (block.cache_control) fields.add('cache_control');
        }
      }
    }
  }
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (!tool || typeof tool !== 'object') continue;
      if (typeof tool.type === 'string' && COMPUTER_USE_TOOL_TYPES.has(tool.type)) toolTypes.add(tool.type);
      if (tool.cache_control) fields.add('cache_control');
    }
  }

  const stripped = {
    tool_types: [...toolTypes].sort(),
    input_types: [],
    output_format_types: [],
    content_types: [...contentTypes].sort(),
    fields: [...fields].sort()
  };
  const hasStripped = stripped.tool_types.length || stripped.content_types.length || stripped.fields.length;
  if (!hasStripped) return null;

  return {
    mode: 'messages_to_chat_completions',
    trigger: 'strip_messages_only_features',
    target_adapter: 'chat_completions',
    converted: { tool_types: [], input_types: [], output_format_types: [], content_types: [], fields: [] },
    downgraded: { tool_types: [], input_types: [], output_format_types: [], content_types: [], fields: [] },
    stripped
  };
}

function chatResponseFormatFromResponsesTextFormat(format) {
  if (!format) return undefined;
  const type = responsesTextFormatTypeLabel(format);
  if (type === 'text') return undefined;
  if (type === 'json_object') return { type: 'json_object' };
  if (type !== 'json_schema') throw unsupportedOutputFormatConversionError([type], 'Chat Completions adapter');

  if (objectRecord(format.json_schema)) {
    return { type: 'json_schema', json_schema: { ...format.json_schema } };
  }

  const name = typeof format.name === 'string' && format.name.trim() ? format.name.trim() : '';
  if (!name || !objectRecord(format.schema)) {
    throw unsupportedOutputFormatConversionError(['json_schema'], 'Chat Completions adapter');
  }

  const jsonSchema = {
    name,
    schema: format.schema
  };
  if (typeof format.description === 'string') jsonSchema.description = format.description;
  if (format.strict !== undefined) jsonSchema.strict = format.strict;
  return { type: 'json_schema', json_schema: jsonSchema };
}

function anthropicJsonSchemaFromResponsesTextFormat(format) {
  if (!format) return undefined;
  const type = responsesTextFormatTypeLabel(format);
  if (type === 'text') return undefined;
  if (type === 'json_object') {
    return { type: 'json_schema', schema: { type: 'object' } };
  }
  if (type !== 'json_schema') throw unsupportedOutputFormatConversionError([type], 'Anthropic Messages adapter');
  if (objectRecord(format.json_schema?.schema)) {
    return { type: 'json_schema', schema: format.json_schema.schema };
  }
  if (objectRecord(format.schema)) {
    return { type: 'json_schema', schema: format.schema };
  }
  throw unsupportedOutputFormatConversionError(['json_schema'], 'Anthropic Messages adapter');
}

function applyReasoningEffort(target, payload, adapterName) {
  const effort = payload?.reasoning && typeof payload.reasoning === 'object' && !Array.isArray(payload.reasoning)
    ? payload.reasoning.effort
    : undefined;
  if (typeof effort !== 'string' || !effort.trim()) return;
  if (adapterName === 'chat') {
    if (target.reasoning_effort === undefined) target.reasoning_effort = effort.trim();
    return;
  }
  if (!objectRecord(target.output_config)) target.output_config = {};
  if (target.output_config.effort === undefined) target.output_config.effort = effort.trim();
}

function applyAnthropicOutputConfig(target, payload) {
  const outputConfig = objectRecord(payload.output_config) ? { ...payload.output_config } : {};
  const format = anthropicJsonSchemaFromResponsesTextFormat(responsesTextFormatFromPayload(payload));
  if (format && outputConfig.format === undefined) outputConfig.format = format;
  const effort = payload?.reasoning && typeof payload.reasoning === 'object' && !Array.isArray(payload.reasoning)
    ? payload.reasoning.effort
    : undefined;
  if (typeof effort === 'string' && effort.trim() && outputConfig.effort === undefined) {
    outputConfig.effort = effort.trim();
  }
  if (Object.keys(outputConfig).length > 0) target.output_config = outputConfig;
}

function webSearchOptionsFromResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const searchTool = tools.find((tool) => tool?.type === 'web_search' || tool?.type === 'web_search_preview');
  if (!searchTool) return undefined;
  const options = {};
  if (['low', 'medium', 'high'].includes(searchTool.search_context_size)) {
    options.search_context_size = searchTool.search_context_size;
  }
  if (objectRecord(searchTool.user_location)) {
    const approximate = searchTool.user_location.approximate && objectRecord(searchTool.user_location.approximate)
      ? searchTool.user_location.approximate
      : searchTool.user_location;
    const location = Object.fromEntries(
      ['city', 'country', 'region', 'timezone']
        .filter((key) => typeof approximate[key] === 'string' && approximate[key].trim())
        .map((key) => [key, approximate[key]])
    );
    if (Object.keys(location).length > 0) {
      options.user_location = { type: 'approximate', approximate: location };
    }
  }
  return Object.keys(options).length > 0 ? options : {};
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
  applyAnthropicOutputConfig(anthropic, payload);

  const systemText = [payload.instructions, system]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n\n');
  if (systemText) anthropic.system = systemText;
  const anthropicTools = anthropicToolsFromResponsesTools(payload.tools);
  if (anthropicTools) anthropic.tools = anthropicTools;
  else delete anthropic.tools;
  const anthropicToolChoice = anthropicToolChoiceFromResponsesToolChoice(payload.tool_choice);
  if (anthropicToolChoice && !anthropicTools && !['auto', 'none'].includes(anthropicToolChoice.type)) {
    const choiceType = typeof payload.tool_choice === 'string'
      ? payload.tool_choice
      : String(payload.tool_choice?.type || 'unknown');
    throw unsupportedToolConversionError([choiceType], 'Anthropic Messages adapter');
  }
  if (anthropicToolChoice && anthropicTools) {
    if (payload.parallel_tool_calls === false) anthropicToolChoice.disable_parallel_tool_use = true;
    anthropic.tool_choice = anthropicToolChoice;
  } else if (payload.parallel_tool_calls === false && anthropicTools) {
    anthropic.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
  } else {
    delete anthropic.tool_choice;
  }

  if (typeof payload.safety_identifier === 'string' && payload.safety_identifier.trim()) {
    anthropic.metadata = { user_id: payload.safety_identifier.trim() };
  } else if (objectRecord(payload.metadata) && typeof payload.metadata.user_id === 'string' && payload.metadata.user_id.trim()) {
    anthropic.metadata = { user_id: payload.metadata.user_id.trim() };
  }
  if (payload.service_tier === 'auto') anthropic.service_tier = 'auto';
  else if (payload.service_tier === 'default' || payload.service_tier === 'standard_only') anthropic.service_tier = 'standard_only';

  const temperature = numberOption(payload.temperature);
  if (temperature !== undefined) anthropic.temperature = temperature;
  const topP = numberOption(payload.top_p);
  if (topP !== undefined) anthropic.top_p = topP;
  if (Array.isArray(payload.stop)) anthropic.stop_sequences = payload.stop.map(String);
  else if (typeof payload.stop === 'string') anthropic.stop_sequences = [payload.stop];
  delete anthropic.stop;

  return Buffer.from(JSON.stringify(anthropic));
}

function buildChatCompletionsPayload(body, model) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8') || '{}');
  } catch (error) {
    const err = new Error(`invalid JSON body: ${error.message}`);
    err.statusCode = 400;
    throw err;
  }

  const messages = responsesInputToChatMessages(payload.input);
  const systemText = typeof payload.instructions === 'string' && payload.instructions.trim()
    ? payload.instructions.trim()
    : '';
  const finalMessages = [
    ...(systemText ? [{ role: 'system', content: systemText }] : []),
    ...(messages.length > 0 ? messages : [{ role: 'user', content: '' }])
  ];
  const chat = {
    model: model || payload.model,
    messages: finalMessages,
    stream: Boolean(payload.stream)
  };
  applyReasoningEffort(chat, payload, 'chat');
  copyPayloadFields(chat, payload, CHAT_COMPLETIONS_PASSTHROUGH_FIELDS);
  if (chat.response_format === undefined) {
    const responseFormat = chatResponseFormatFromResponsesTextFormat(responsesTextFormatFromPayload(payload));
    if (responseFormat) chat.response_format = responseFormat;
  }
  if (chat.web_search_options === undefined) {
    const webSearchOptions = webSearchOptionsFromResponsesTools(payload.tools);
    if (webSearchOptions) chat.web_search_options = webSearchOptions;
  }

  if (chat.stream && !chat.stream_options) {
    chat.stream_options = { include_usage: true };
  }
  const chatTools = chatToolsFromResponsesTools(payload.tools);
  if (chatTools) chat.tools = chatTools;
  const chatToolChoice = chatToolChoiceFromResponsesToolChoice(payload.tool_choice);
  if (chatToolChoice !== undefined) chat.tool_choice = chatToolChoice;

  const maxTokenInput = firstDefined(payload.max_output_tokens, payload.max_tokens, payload.max_completion_tokens);
  if (maxTokenInput !== undefined) chat.max_completion_tokens = normalizeMaxTokens(maxTokenInput);
  const temperature = numberOption(payload.temperature);
  if (temperature !== undefined) chat.temperature = temperature;
  const topP = numberOption(payload.top_p);
  if (topP !== undefined) chat.top_p = topP;
  if (Array.isArray(payload.stop)) chat.stop = payload.stop.map(String);
  else if (typeof payload.stop === 'string') chat.stop = payload.stop;

  return Buffer.from(JSON.stringify(chat));
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

function outputTextDeltaEvent(delta, context = {}) {
  const payload = {
    type: 'response.output_text.delta',
    delta
  };
  if (context.itemId) payload.item_id = context.itemId;
  if (context.outputIndex !== undefined) payload.output_index = context.outputIndex;
  if (context.contentIndex !== undefined) payload.content_index = context.contentIndex;
  return sseEvent('response.output_text.delta', payload);
}

function completedResponsesEvent(model, response = {}) {
  return sseEvent('response.completed', responsesCompletedPayload(model, response));
}

function responseLifecycleEvent(eventName, response) {
  return sseEvent(eventName, {
    type: eventName,
    response
  });
}

function responseOutputItemEvent(eventName, item, outputIndex = 0) {
  return sseEvent(eventName, {
    type: eventName,
    output_index: outputIndex,
    item
  });
}

function responseContentPartEvent(eventName, itemId, part, outputIndex = 0, contentIndex = 0) {
  return sseEvent(eventName, {
    type: eventName,
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    part
  });
}

function outputTextDoneEvent(text, context = {}) {
  const payload = {
    type: 'response.output_text.done',
    text
  };
  if (context.itemId) payload.item_id = context.itemId;
  if (context.outputIndex !== undefined) payload.output_index = context.outputIndex;
  if (context.contentIndex !== undefined) payload.content_index = context.contentIndex;
  return sseEvent('response.output_text.done', payload);
}

function resolveKey(entry) {
  if (!entry) return { value: '', label: 'no-auth', source: 'none' };
  if (typeof entry === 'string') return { value: entry, label: maskSecret(entry), source: 'value' };
  if (entry.value) return { value: entry.value, label: entry.label || maskSecret(entry.value), source: 'value' };
  if (entry.env) return { value: process.env[entry.env] || '', label: entry.env, source: 'env' };
  return { value: '', label: 'empty-key', source: 'none' };
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
      source: resolved.source,
      value: resolved.value,
      failures: 0,
      nonAuthoritativeFailures: 0,
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
        lastUsedAt: null,
        availability: { samples: [] }
      },
      quota: {},
      representativeEvidence: {}
    };
  });
  const siteUrl = deriveSiteUrl(upstream.base_url, upstream.site_url);
  const codexOAuth = isCodexOAuthConfig(upstream);
  const requestMode = normalizeRequestMode(upstream.request_mode, codexOAuth);

  return {
    index,
    name: upstream.name || `upstream-${index + 1}`,
    enabled: upstream.enabled !== false,
    quarantined: upstream.enabled !== false && upstream.quarantined === true,
    baseUrl: upstream.base_url,
    siteUrl,
    signinAvailable: booleanOption(signinAvailableValue(upstream), Boolean(siteUrl)),
    signinCompletedDate: signinCompletionDate(upstream),
    proxyUrl: normalizeProxyUrl(upstream.proxy_url || upstream.proxyUrl),
    requestMode,
    resolvedRequestMode: requestMode === 'chat_completions' || requestMode === 'responses' ? requestMode : '',
    routeStrategies: normalizeRouteStrategies(upstream.route_strategies || upstream.routeStrategies),
    codexOAuth,
    oauthExpiresAt: typeof upstream.oauth_expires_at === 'string' ? upstream.oauth_expires_at : '',
    oauthClientId: typeof upstream.oauth_client_id === 'string' ? upstream.oauth_client_id : '',
    oauthPlanType: typeof upstream.oauth_plan_type === 'string' ? upstream.oauth_plan_type : '',
    oauthEmail: typeof upstream.oauth_email === 'string' ? upstream.oauth_email : '',
    chatGptAccountId: typeof upstream.chatgpt_account_id === 'string' ? upstream.chatgpt_account_id : '',
    chatGptUserId: typeof upstream.chatgpt_user_id === 'string' ? upstream.chatgpt_user_id : '',
    organizationId: typeof upstream.organization_id === 'string' ? upstream.organization_id : '',
    healthPath: typeof upstream.health_path === 'string' ? upstream.health_path : '',
    modelSuffixStrip: normalizeModelSuffix(upstream.model_suffix_strip || upstream.modelSuffixStrip || upstream.model_suffix),
    probeAuth: typeof upstream.probe_auth === 'string' ? upstream.probe_auth : 'bearer',
    api: normalizeUpstreamApi(upstream.api, upstream.probe_auth),
    capabilities: initialProtocolCapabilities({
      enabled: upstream.enabled,
      codexOAuth: isCodexOAuthConfig(upstream),
      requestMode: normalizeRequestMode(upstream.request_mode),
      api: normalizeUpstreamApi(upstream.api, upstream.probe_auth),
      declared: upstream.protocol_capabilities || upstream.protocolCapabilities
    }),
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
        inputTokens: 0,
        outputTokens: 0,
        byDay: {}
      },
      availability: { samples: [] }
    },
    quota: {},
    // Per-protocol availability (overall + by_protocol). Layered structure
    // tracked separately from the flat stats.availability.samples window which
    // still feeds availabilitySummary / Dashboard / Selection.
    availability: normalizeLayeredAvailability(null)
  };
}

function buildState(config) {
  const retry = {
    maxAttempts: Number(config.retry?.max_attempts || 3),
    failureThreshold: Number(config.retry?.failure_threshold || 2),
    baseCooldownMs: Number(config.retry?.base_cooldown_ms || 30000),
    keyCooldownMs: Number(config.retry?.key_cooldown_ms || 60000),
    nativeResponsesRecheckMs: Number(config.retry?.native_responses_recheck_ms || DEFAULT_NATIVE_RESPONSES_RECHECK_MS),
    retryableStatus: new Set(
      Array.isArray(config.retry?.retryable_statuses)
        ? config.retry.retryable_statuses.map(Number).filter(Number.isFinite)
        : DEFAULT_RETRYABLE_STATUS
    )
  };
  if (!Number.isFinite(retry.nativeResponsesRecheckMs) || retry.nativeResponsesRecheckMs < 0) {
    retry.nativeResponsesRecheckMs = DEFAULT_NATIVE_RESPONSES_RECHECK_MS;
  }
  const availability = normalizeAvailabilityConfig(config.availability);
  const compatibility = normalizeCompatibilityConfig(config.compatibility);

  const upstreams = (config.upstreams || [])
    .map((upstream, index) => createUpstreamState(upstream, index));

  return {
    config,
    retry,
    availability,
    compatibility,
    upstreams,
    probing: false,
    probingPromise: null,
    probingLive: false,
    pendingLiveProbePromise: null,
    billingProbing: false,
    modelOverride: typeof config.model_override === 'string' ? config.model_override : '',
    representativeTemplates: new Map(),
    recentRequests: [],
    lastProbeResults: [],
    statsPersistTimer: null
  };
}

function normalizeCompatibilityConfig(input = {}) {
  const adapterMode = input?.adapter_mode && typeof input.adapter_mode === 'object' && !Array.isArray(input.adapter_mode)
    ? input.adapter_mode
    : {};
  const stripResponsesOnlyFeatures = booleanOption(adapterMode.strip_responses_only_features, false);
  const stripMessagesOnlyFeatures = booleanOption(adapterMode.strip_messages_only_features, false);
  const adapters = adapterMode.adapters && typeof adapterMode.adapters === 'object' && !Array.isArray(adapterMode.adapters)
    ? adapterMode.adapters
    : {};
  return {
    adapterMode: {
      stripResponsesOnlyFeatures,
      stripMessagesOnlyFeatures,
      adapters: {
        anthropicMessages: adapters.anthropic_messages === undefined ? stripResponsesOnlyFeatures : booleanOption(adapters.anthropic_messages, false),
        chatCompletions: adapters.chat_completions === undefined ? (stripResponsesOnlyFeatures || stripMessagesOnlyFeatures) : booleanOption(adapters.chat_completions, false)
      }
    }
  };
}


function statsSnapshot(state) {
  return {
    updatedAt: new Date().toISOString(),
    recentRequests: state.config?.debug?.capture_request_headers === true
      ? state.recentRequests
      : stripRequestDebugFields(state.recentRequests),
    upstreams: Object.fromEntries(state.upstreams.map((upstream) => [upstream.name, {
      stats: upstream.stats,
      quota: upstream.quota,
      capabilities: upstream.capabilities,
      routeStrategies: upstream.routeStrategies || {},
      billing: upstream.billing,
      health: {
        state: upstream.health.state,
        source: upstream.health.source || '',
        checkedAt: upstream.health.checkedAt,
        latencyMs: upstream.health.latencyMs,
        httpStatus: upstream.health.httpStatus,
        error: upstream.health.error,
        warning: upstream.health.warning || '',
        diagnostics: upstream.health.diagnostics || undefined,
        probeModel: upstream.health.probeModel || '',
        models: upstream.health.models || [],
        modelsCount: upstream.health.modelsCount,
        keyLabel: upstream.health.keyLabel
      },
      keys: Object.fromEntries(upstream.keys.map((key) => [key.label, {
        stats: key.stats,
        quota: key.quota,
        health: key.health,
        representativeEvidence: key.representativeEvidence || {}
      }]))
    }]))
  };
}

function normalizeAvailabilityConfig(input = {}) {
  const windowSize = Number(input.window_size);
  const minSamples = Number(input.min_samples);
  const boostThreshold = Number(input.boost_threshold);
  const healthyThreshold = Number(input.healthy_threshold);
  const degradedThreshold = Number(input.degraded_threshold);
  const poorThreshold = Number(input.poor_threshold);
  return {
    windowSize: Number.isFinite(windowSize) && windowSize > 0 ? Math.floor(windowSize) : DEFAULT_AVAILABILITY_WINDOW_SIZE,
    minSamples: Number.isFinite(minSamples) && minSamples > 0 ? Math.floor(minSamples) : DEFAULT_AVAILABILITY_MIN_SAMPLES,
    boostThreshold: Number.isFinite(boostThreshold) ? boostThreshold : 0.95,
    healthyThreshold: Number.isFinite(healthyThreshold) ? healthyThreshold : 0.9,
    degradedThreshold: Number.isFinite(degradedThreshold) ? degradedThreshold : 0.75,
    poorThreshold: Number.isFinite(poorThreshold) ? poorThreshold : 0.5
  };
}

function ensureAvailability(stats, availabilityConfig = normalizeAvailabilityConfig()) {
  if (!stats.availability || typeof stats.availability !== 'object' || Array.isArray(stats.availability)) {
    stats.availability = { samples: [] };
  }
  const samples = Array.isArray(stats.availability.samples)
    ? stats.availability.samples
        .map((value) => (value === true || value === 1 || value === '1' || value === 'ok' ? 1 : 0))
        .slice(-availabilityConfig.windowSize)
    : [];
  stats.availability.samples = samples;
  return stats.availability;
}

function availabilitySummary(stats, availabilityConfig = normalizeAvailabilityConfig()) {
  const availability = ensureAvailability(stats, availabilityConfig);
  const samples = availability.samples;
  const successes = samples.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  const failures = samples.length - successes;
  const rate = samples.length > 0 ? successes / samples.length : null;
  const multiplier = availabilityMultiplier(rate, samples.length, availabilityConfig);
  return {
    window_size: availabilityConfig.windowSize,
    min_samples: availabilityConfig.minSamples,
    samples: samples.length,
    successes,
    failures,
    rate,
    multiplier,
    recent: samples.map(s => s ? '1' : '0').join('')
  };
}

function availabilityMultiplier(rate, samples, availabilityConfig = normalizeAvailabilityConfig()) {
  if (!Number.isFinite(rate) || samples < availabilityConfig.minSamples) return 1;
  if (rate >= availabilityConfig.boostThreshold) return 1.2;
  if (rate >= availabilityConfig.healthyThreshold) return 1;
  if (rate >= availabilityConfig.degradedThreshold) return 0.65;
  if (rate >= availabilityConfig.poorThreshold) return 0.3;
  return 0.08;
}

function selectionLatencyPenalty(upstream) {
  return upstream.ewmaLatencyMs > 0 ? Math.min(4, upstream.ewmaLatencyMs / 15000) : 0;
}

function selectionHealthPenalty(upstream) {
  return ['server_error', 'network_error', 'timeout', 'rate_limited'].includes(upstream.health.state) ? 2 : 0;
}

function healthAllowsSelection(upstream, expectedModel = undefined) {
  // Probe layer is advisory-only: the probe-derived Health State must NEVER
  // exclude an upstream from Selection. Only real Model Interaction Request
  // outcomes (cooldown / failure) gate Selection, and those are checked by the
  // caller via `upstream.cooldownUntil` and key availability. Health State still
  // feeds a SOFT weight penalty via selectionHealthPenalty() for ranking.
  return true;
}

function normalizeProbeModel(value) {
  return String(value || '').trim();
}

function probeModelFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  return normalizeProbeModel(payload.probe_model ?? payload.probeModel ?? payload.model);
}

function healthMatchesProbeModel(health, expectedModel) {
  const expected = normalizeProbeModel(expectedModel);
  if (!expected) return true;
  return normalizeProbeModel(health?.probeModel) === expected;
}

function invalidateHealthForModelChange(state, model) {
  const nextModel = normalizeProbeModel(model);
  const checkedAt = new Date().toISOString();
  const staleableStates = new Set(['ok', 'unknown', 'oauth_ready', 'stale_model_override', 'missing_model_override']);
  for (const upstream of state.upstreams) {
    const currentState = upstream.health?.state || 'unknown';
    if (!upstream.enabled || currentState === 'disabled') continue;
    if (!staleableStates.has(currentState)) continue;
    if (!upstream.health?.checkedAt && currentState !== 'ok') continue;
    upstream.health = {
      ...upstream.health,
      state: nextModel ? 'stale_model_override' : 'missing_model_override',
      checkedAt,
      latencyMs: 0,
      httpStatus: 0,
      error: nextModel
        ? `Health Probe must be rerun for current model_override ${nextModel}`
        : 'Health Probe requires model_override so it can test the exact active model',
      probeModel: upstream.health?.probeModel || ''
    };
    for (const key of upstream.keys) {
      key.health = {
        ...key.health,
        state: upstream.health.state,
        checkedAt,
        latencyMs: 0,
        httpStatus: 0,
        error: upstream.health.error,
        probeModel: upstream.health.probeModel
      };
    }
  }
}

function probeResultPayload(health, expectedModel) {
  return {
    probe_ok: healthProbeOk(health, expectedModel),
    probe_status: healthProbeStatus(health, expectedModel)
  };
}

function representativeSelectionMultiplier(upstream, model, protocol = 'responses', at = now()) {
  return representativeAvailability(upstream, { model, protocol: protocol || 'responses', at }).multiplier;
}

function upstreamSelectionWeight(upstream, availability, model = '', protocol = '', at = now()) {
  return upstream.weight * availability.multiplier * representativeSelectionMultiplier(upstream, model, protocol, at);
}

function upstreamSelectionScore(upstream, availability, model = '', protocol = '', at = now()) {
  return upstreamSelectionWeight(upstream, availability, model, protocol, at) / (
    1 +
    upstream.inFlight +
    selectionLatencyPenalty(upstream) +
    selectionHealthPenalty(upstream) +
    upstream.failures * 0.4
  );
}

function roundedSelectionValue(value) {
  return Math.round(value * 1000) / 1000;
}

function recordAvailability(upstream, key, succeeded, availabilityConfig, protocol) {
  const value = succeeded ? 1 : 0;
  for (const stats of [upstream.stats, key.stats]) {
    const availability = ensureAvailability(stats, availabilityConfig);
    availability.samples.push(value);
    if (availability.samples.length > availabilityConfig.windowSize) {
      availability.samples.splice(0, availability.samples.length - availabilityConfig.windowSize);
    }
  }
  // Per-protocol availability (top-level upstream.availability). Optional
  // protocol: when provided, also buckets by_protocol + overall.
  if (protocol) {
    recordAvailabilityAttempt(upstream, protocol, Boolean(succeeded));
  }
}

function shouldRestoreNativeResponsesForwardOnly(upstream) {
  return upstreamHasConfiguredNativeResponses(upstream) &&
    NON_REPRESENTATIVE_NATIVE_RESPONSES_PROBE_STATES.has(upstream?.health?.state);
}

function shouldRestoreInvalidCodexProbeHealth(upstream) {
  const health = upstream?.health || {};
  if (health.state !== 'models_unsupported') return false;
  const capabilities = normalizeProtocolCapabilities(upstream?.capabilities);
  const responses = capabilities.responses;
  const chat = capabilities.chat_completions;
  const previousEvidence = `${health.error || ''} ${responses.reason || ''}`.toLowerCase();
  return responses.source === 'probe' &&
    responses.status === 'failed' &&
    Number(responses.http_status || 0) === 400 &&
    chat.source === 'probe' &&
    Number(chat.http_status || 0) === 404 &&
    /responses probe unexpected_status; chat probe models_unsupported|responses probe returned http 400/.test(previousEvidence);
}

function restoreNativeResponsesForwardOnlyHealth(upstream) {
  const restoreConfiguredNative = shouldRestoreNativeResponsesForwardOnly(upstream);
  const restoreInvalidCodexProbe = shouldRestoreInvalidCodexProbeHealth(upstream);
  if (!restoreConfiguredNative && !restoreInvalidCodexProbe) return;
  const previousState = upstream.health?.state || 'unknown';
  const previousError = upstream.health?.error || `restored Health State ${previousState}`;
  const state = restoreInvalidCodexProbe ? 'advanced_curl_required' : 'codex_forward_only';
  const error = restoreInvalidCodexProbe
    ? `restored Health Probe state was produced by a non-representative synthetic Codex request: ${previousError}; rerun Health Probe or send real Codex traffic to verify availability`
    : `native Responses capability is user-declared or configured, but the restored Health Probe state is not representative of real Codex traffic: ${previousError}`;
  const restoredHttpStatus = restoreInvalidCodexProbe
    ? Number(normalizeProtocolCapabilities(upstream.capabilities).responses.http_status || 0)
    : 0;
  upstream.health = {
    ...upstream.health,
    state,
    ...(restoredHttpStatus ? { httpStatus: restoredHttpStatus } : {}),
    error
  };
  if (restoreInvalidCodexProbe) {
    upstream.capabilities = normalizeProtocolCapabilities(upstream.capabilities);
    upstream.capabilities.responses = {
      ...upstream.capabilities.responses,
      status: 'unknown',
      representative: false,
      reason: error
    };
  }
  for (const key of upstream.keys || []) {
    key.health = {
      ...key.health,
      state,
      ...(restoredHttpStatus ? { httpStatus: restoredHttpStatus } : {}),
      error
    };
  }
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
      ensureAvailability(upstream.stats, state.availability);
      upstream.quota = { ...upstream.quota, ...(old.quota || {}) };
      upstream.capabilities = mergeRestoredProtocolCapabilities(old.capabilities, upstream.capabilities);
      upstream.routeStrategies = normalizeRouteStrategies(old.routeStrategies || old.route_strategies || upstream.routeStrategies);
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
        ensureAvailability(key.stats, state.availability);
        key.quota = { ...key.quota, ...(oldKey.quota || {}) };
        key.representativeEvidence = oldKey.representativeEvidence || {};
        if (oldKey.health) key.health = { ...key.health, ...oldKey.health };
      }
      restoreNativeResponsesForwardOnlyHealth(upstream);
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
    at: localDateTimeString(),
    ...event
  });
  state.recentRequests.splice(30);

  // Write to debug log file if enabled
  if (state.config?.debug?.capture_request_headers === true && state.config?.debug?.request_log_path) {
    writeRequestDebugLog(state.config.debug.request_log_path, {
      id: state.recentRequests[0].id,
      at: state.recentRequests[0].at,
      ...event
    });
  }
}

function writeRequestDebugLog(logPath, request) {
  try {
    const logEntry = JSON.stringify(request) + '\n';
    writeFileSync(logPath, logEntry, { flag: 'a' });
  } catch (error) {
    console.warn?.(`[debug] failed to write request log to ${logPath}: ${error.message}`);
  }
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

function copyRuntimeState(target, source, { preserveHealth, availabilityConfig }) {
  target.failures = source.failures;
  target.successes = source.successes;
  target.ewmaLatencyMs = source.ewmaLatencyMs;
  target.cooldownUntil = source.cooldownUntil;
  target.lastError = source.lastError;
  target.lastStatus = source.lastStatus;
  target.stats = { ...target.stats, ...source.stats };
  ensureTokenUsage(target.stats);
  ensureAvailability(target.stats, availabilityConfig);
  target.quota = { ...target.quota, ...source.quota };
  target.capabilities = normalizeProtocolCapabilities(source.capabilities || target.capabilities);
  target.routeStrategies = normalizeRouteStrategies(source.routeStrategies || target.routeStrategies);
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
  } else if (target.billing?.state === 'disabled' && target.billing?.error === 'upstream disabled') {
    target.billing = emptyBillingState();
  }

  for (const key of target.keys) {
    const oldKey = source.keys.find((item) => item.label === key.label);
    if (!oldKey) continue;
    key.failures = oldKey.failures;
    key.cooldownUntil = oldKey.cooldownUntil;
    key.stats = { ...key.stats, ...oldKey.stats };
    ensureAvailability(key.stats, availabilityConfig);
    key.quota = { ...key.quota, ...oldKey.quota };
    key.representativeEvidence = oldKey.representativeEvidence || {};
    if (preserveHealth) key.health = { ...key.health, ...oldKey.health };
  }
}

function rebuildUpstreams(state, config) {
  const oldUpstreams = new Map(state.upstreams.map((upstream) => [upstream.name, upstream]));
  const rebuilt = buildState(config);
  for (const upstream of rebuilt.upstreams) {
    const old = oldUpstreams.get(upstream.name);
    if (!old) continue;
    copyRuntimeState(upstream, old, { preserveHealth: old.baseUrl === upstream.baseUrl, availabilityConfig: state.availability });
  }
  state.upstreams.splice(0, state.upstreams.length, ...rebuilt.upstreams);
}

function keyAvailable(keyState, at) {
  return Boolean(keyState.value) && keyState.cooldownUntil <= at;
}

function upstreamAvailable(upstream, at, expectedModel = undefined) {
  return upstream.enabled
    && !upstream.quarantined
    && upstream.baseUrl
    && healthAllowsSelection(upstream, expectedModel)
    && !codexOAuthExpired(upstream, at)
    && upstream.cooldownUntil <= at
    && upstream.keys.some((key) => keyAvailable(key, at));
}

function upstreamSupportsModel(upstream, model) {
  if (!model) return true;

  // Check protocol compatibility based on model requirements
  const requiredProtocol = modelRequiresProtocol(model);
  if (requiredProtocol === 'anthropic_messages') {
    if (!isAnthropicUpstream(upstream)) return false;
  } else if (requiredProtocol === 'openai') {
    if (!isOpenAiUpstream(upstream)) return false;
  }

  // Check Codex OAuth model compatibility
  if (upstream.codexOAuth && !isCodexOAuthModel(model)) return false;

  // NOTE: the probe-discovered model list (upstream.health.models) is NOT used
  // to hard-exclude an upstream here. Probes are advisory-only; an upstream
  // whose /models list omits the Requested Model still participates in
  // Selection (and may still serve it). Only real Model Interaction Request
  // failures gate Selection. Model-list evidence may be used for dashboard
  // display and ranking elsewhere, but never as a Selection gate.
  return true;
}

function upstreamHasKnownModel(upstream, model) {
  if (!model) return false;
  const models = upstream.health?.models || [];
  return models.length > 0 && models.includes(model);
}

function chooseCandidate(state, tried, options = {}) {
  const at = now();
  const preferredModel = options.preferredModel || state.modelOverride;
  const allowUnknownModelFallback = options.allowUnknownModelFallback === true;
  const candidateFilter = typeof options.candidateFilter === 'function' ? options.candidateFilter : null;
  const preferredProtocol = options.preferredProtocol || '';
  const targetProtocol = options.targetProtocol || '';
  let candidates = state.upstreams.filter((upstream) => {
    if (!upstreamAvailable(upstream, at)) return false;
    // Per-protocol cooldown: an upstream may be cooled for one protocol while
    // still serving others. Additive to the global cooldownUntil check above.
    if (targetProtocol && isUpstreamInProtocolCooldown(upstream, targetProtocol, at)) return false;
    if (candidateFilter && !candidateFilter(upstream)) return false;
    return upstream.keys.some((key) => keyAvailable(key, at) && !tried.has(`${upstream.name}:${key.index}`));
  });

  if (preferredModel) {
    // Filter to upstreams that pass the (config-driven) protocol-family /
    // Codex OAuth compatibility check. Probe-discovered model lists do NOT
    // participate in this filter — probes are advisory-only and must not
    // exclude an upstream from Selection.
    const modelCandidates = candidates.filter((upstream) => upstreamSupportsModel(upstream, preferredModel));
    if (modelCandidates.length > 0) {
      candidates = modelCandidates;
    }
    void allowUnknownModelFallback;
  }

  // Prioritize upstreams with verified protocol capability for lossless forwarding
  if (preferredProtocol && candidates.length > 0) {
    const protocolMatches = candidates.filter((upstream) =>
      upstreamHasVerifiedProtocolCapability(upstream, preferredProtocol)
    );
    if (protocolMatches.length > 0) {
      candidates = protocolMatches;
    }
    // If no protocol matches, fall back to all candidates (allow protocol conversion)
  }

  if (candidates.length === 0) return null;

  let total = 0;
  const weighted = candidates.map((upstream) => {
    const availability = availabilitySummary(upstream.stats, state.availability);
    const score = upstreamSelectionScore(upstream, availability, preferredModel, preferredProtocol, at);
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

function nativeResponsesCandidateDiagnostics(state, pathname, model, tried = new Set()) {
  if (pathname !== '/v1/responses') return [];
  const at = now();
  return state.upstreams.map((upstream) => {
    let reason = '';
    if (!upstream.enabled) reason = 'upstream is disabled';
    else if (upstream.quarantined) reason = 'upstream is quarantined';
    else if (!upstream.baseUrl) reason = 'upstream has no base_url';
    else if (codexOAuthExpired(upstream, at)) reason = 'Codex OAuth token is expired';
    else if (!healthAllowsSelection(upstream, model)) reason = 'health state does not allow selection for requested model';
    else if (!upstreamSupportsModel(upstream, model)) reason = 'upstream does not support the requested model/API family';
    else if (!upstream.keys.some((key) => keyAvailable(key, at))) reason = 'no upstream key is currently available';
    else if (!canAttemptNativeResponses(pathname, upstream, model, {
      at,
      nativeResponsesRecheckMs: state.retry.nativeResponsesRecheckMs
    })) {
      const learnedStrategy = routeStrategyForUpstream(upstream, model);
      reason = upstream.requestMode === 'chat_completions'
        ? 'configured request_mode=chat_completions cannot carry native Responses-only features'
        : routeStrategyUsesChatCompletions(learnedStrategy)
          ? 'learned Chat Completions Forwarding Strategy is still inside the Native Responses Recheck window'
          : 'resolved request interface chat_completions cannot carry native Responses-only features';
    } else if (!upstream.keys.some((key) => keyAvailable(key, at) && !tried.has(`${upstream.name}:${key.index}`))) {
      reason = 'all available keys have already been attempted';
    }
    return {
      upstream: upstream.name,
      request_mode: upstream.requestMode || 'auto',
      resolved_request_mode: upstream.resolvedRequestMode || '',
      reason: reason || 'eligible'
    };
  }).filter((item) => item.reason !== 'eligible');
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

function emptyTokenUsage() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== 'object') {
    const totalTokens = numberFromUnknown(value);
    return { totalTokens, inputTokens: 0, outputTokens: 0 };
  }
  const inputTokens = numberFromUnknown(value.inputTokens ?? value.input_tokens ?? value.promptTokens ?? value.prompt_tokens);
  const outputTokens = numberFromUnknown(value.outputTokens ?? value.output_tokens ?? value.completionTokens ?? value.completion_tokens);
  const totalTokens = numberFromUnknown(value.totalTokens ?? value.total_tokens) || inputTokens + outputTokens;
  return { totalTokens, inputTokens, outputTokens };
}

function hasTokenUsage(value) {
  const usage = normalizeTokenUsage(value);
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0;
}

function hasConcreteOutputFromJson(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasConcreteOutputFromJson(item));

  if (typeof value.output_text === 'string' && value.output_text.trim()) return true;
  if (typeof value.outputText === 'string' && value.outputText.trim()) return true;
  if (typeof value.text === 'string' && value.text.trim()) return true;
  if (typeof value.content === 'string' && value.content.trim()) return true;
  if (typeof value.delta === 'string' && value.delta.trim()) return true;
  if (typeof value.partial_json === 'string' && value.partial_json.trim()) return true;

  if (value.type === 'function_call' && (String(value.name || '').trim() || String(value.arguments || '').trim())) return true;
  if (value.type === 'custom_tool_call' && (String(value.name || '').trim() || String(value.input || '').trim())) return true;
  if (value.type === 'function' && value.function && typeof value.function === 'object') {
    if (String(value.function.name || '').trim() || String(value.function.arguments || '').trim()) return true;
  }
  if (value.type === 'tool_use' && String(value.name || '').trim()) return true;

  for (const key of ['output', 'content', 'choices', 'message', 'delta', 'content_block', 'tool_calls', 'function', 'response', 'data', 'result']) {
    if (hasConcreteOutputFromJson(value[key])) return true;
  }
  return false;
}

function tokenUsageFromParts({ totalTokens = 0, inputTokens = 0, outputTokens = 0 } = {}) {
  const normalized = {
    totalTokens: numberFromUnknown(totalTokens),
    inputTokens: numberFromUnknown(inputTokens),
    outputTokens: numberFromUnknown(outputTokens)
  };
  if (!normalized.totalTokens) normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  return hasTokenUsage(normalized) ? normalized : emptyTokenUsage();
}

function extractTokenUsageFromJson(value) {
  if (!value || typeof value !== 'object') return emptyTokenUsage();
  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = extractTokenUsageFromJson(item);
      if (hasTokenUsage(usage)) return usage;
    }
    return emptyTokenUsage();
  }
  const usage = value.usage && typeof value.usage === 'object'
    ? value.usage
    : value.usage_metadata && typeof value.usage_metadata === 'object'
      ? value.usage_metadata
      : value.usageMetadata && typeof value.usageMetadata === 'object'
        ? value.usageMetadata
        : value;
  const cacheInputTokens =
    numberFromUnknown(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) +
    numberFromUnknown(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  for (const key of ['total_tokens', 'totalTokens', 'total_token_count', 'totalTokenCount']) {
    const total = numberFromUnknown(usage[key]);
    if (total) {
      const nested = tokenUsageFromParts({
        totalTokens: total,
        inputTokens: numberFromUnknown(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens) + cacheInputTokens,
        outputTokens: numberFromUnknown(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens)
      });
      return nested.totalTokens || nested.inputTokens || nested.outputTokens ? nested : tokenUsageFromParts({ totalTokens: total });
    }
  }
  const pairs = [
    ['input_tokens', 'output_tokens'],
    ['inputTokens', 'outputTokens'],
    ['prompt_tokens', 'completion_tokens'],
    ['promptTokens', 'completionTokens'],
    ['promptTokenCount', 'candidatesTokenCount']
  ];
  for (const [inputKey, outputKey] of pairs) {
    const inputTokens = numberFromUnknown(usage[inputKey]) + cacheInputTokens;
    const outputTokens = numberFromUnknown(usage[outputKey]);
    const tokens = tokenUsageFromParts({ inputTokens, outputTokens });
    if (hasTokenUsage(tokens)) return tokens;
  }
  for (const key of ['response', 'data', 'result', 'message']) {
    const nested = extractTokenUsageFromJson(value[key]);
    if (hasTokenUsage(nested)) return nested;
  }
  return emptyTokenUsage();
}

function extractTokenUsageFromHeaders(headers = {}) {
  const inputTokens = numberFromUnknown(firstHeader(headers, [
    'x-usage-input-tokens',
    'x-input-tokens',
    'x-openai-prompt-tokens',
    'x-prompt-tokens'
  ]));
  const outputTokens = numberFromUnknown(firstHeader(headers, [
    'x-usage-output-tokens',
    'x-output-tokens',
    'x-openai-completion-tokens',
    'x-completion-tokens'
  ]));
  const totalTokens = numberFromUnknown(firstHeader(headers, [
    'x-usage-total-tokens',
    'x-total-tokens',
    'x-openai-total-tokens',
    'x-ratelimit-used-tokens',
    'x-used-tokens'
  ]));
  return tokenUsageFromParts({ totalTokens, inputTokens, outputTokens });
}

function hasExplicitZeroOutputTokensInJson(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasExplicitZeroOutputTokensInJson(item));

  const usage = value.usage && typeof value.usage === 'object'
    ? value.usage
    : value.usage_metadata && typeof value.usage_metadata === 'object'
      ? value.usage_metadata
      : value.usageMetadata && typeof value.usageMetadata === 'object'
        ? value.usageMetadata
        : null;
  if (usage) {
    for (const key of ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'candidatesTokenCount']) {
      if (Object.hasOwn(usage, key) && Number(usage[key]) === 0) return true;
    }
  }

  for (const key of ['response', 'data', 'result', 'message', 'choices']) {
    if (hasExplicitZeroOutputTokensInJson(value[key])) return true;
  }
  return false;
}

function hasExplicitZeroOutputTokensInSse(text) {
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
      if (hasExplicitZeroOutputTokensInJson(JSON.parse(payload))) return true;
    } catch {
      // Non-JSON SSE payloads cannot declare usage.
    }
  }
  return false;
}

function hasExplicitZeroOutputTokensInBody(body) {
  if (!body || body.length === 0) return false;
  const text = body.toString('utf8');
  try {
    return hasExplicitZeroOutputTokensInJson(JSON.parse(text));
  } catch {
    return hasExplicitZeroOutputTokensInSse(text);
  }
}

function hasExplicitZeroOutputTokensInHeaders(headers = {}) {
  const output = firstHeader(headers, [
    'x-usage-output-tokens',
    'x-output-tokens',
    'x-openai-completion-tokens',
    'x-completion-tokens'
  ]);
  return output !== undefined && output !== null && output !== '' && Number(output) === 0;
}

function extractTokenUsageFromBody(body) {
  if (!body || body.length === 0) return emptyTokenUsage();
  const text = body.toString('utf8');
  try {
    return extractTokenUsageFromJson(JSON.parse(text));
  } catch {
    return extractTokenUsageFromSse(text);
  }
}

function hasConcreteOutputFromBody(body) {
  if (!body || body.length === 0) return false;
  const text = body.toString('utf8');
  try {
    return hasConcreteOutputFromJson(JSON.parse(text));
  } catch {
    return hasConcreteOutputFromSse(text);
  }
}

function extractTokenUsageFromSse(text) {
  let lastUsage = emptyTokenUsage();
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
      const usage = extractTokenUsageFromJson(JSON.parse(payload));
      if (hasTokenUsage(usage)) lastUsage = usage;
    } catch {
      // Ignore non-JSON event payloads; upstream response is still forwarded unchanged.
    }
  }
  return lastUsage;
}

function hasConcreteOutputFromSse(text) {
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
      if (hasConcreteOutputFromJson(JSON.parse(payload))) return true;
    } catch {
      if (payload.trim()) return true;
    }
  }
  return false;
}

function shouldCaptureUsageBody(headers = {}) {
  const contentType = String(firstHeader(headers, ['content-type']) || '').toLowerCase();
  if (!contentType.includes('json') && !contentType.includes('event-stream')) return false;
  return true;
}

function capturedUsageBody(chunks, size, headers = {}) {
  const contentEncoding = String(firstHeader(headers, ['content-encoding']) || '').toLowerCase();
  if (!contentEncoding || contentEncoding === 'identity') return Buffer.concat(chunks, size);
  return Buffer.from(decodeHttpBody(chunks, size, headers), 'utf8');
}

function createUsageCapture(headers = {}) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  const captureBody = shouldCaptureUsageBody(headers);
  let captured = null;
  function result() {
    if (captured) return captured;
    if (!captureBody || tooLarge || chunks.length === 0) {
      captured = {
        tokens: extractTokenUsageFromHeaders(headers),
        hasOutput: false,
        hasExplicitZeroOutputTokens: hasExplicitZeroOutputTokensInHeaders(headers)
      };
      return captured;
    }
    const body = capturedUsageBody(chunks, size, headers);
    const bodyUsage = extractTokenUsageFromBody(body);
    captured = {
      tokens: hasTokenUsage(bodyUsage) ? bodyUsage : extractTokenUsageFromHeaders(headers),
      hasOutput: hasConcreteOutputFromBody(body),
      hasExplicitZeroOutputTokens: hasExplicitZeroOutputTokensInHeaders(headers) || hasExplicitZeroOutputTokensInBody(body)
    };
    return captured;
  }
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
    result,
    tokenCount() {
      return result().tokens;
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

function anthropicToolUseToResponsesFunctionCall(block, responseId, index = 0, status = 'completed', argumentsOverride = undefined) {
  const args = argumentsOverride !== undefined
    ? argumentsOverride
    : JSON.stringify(block?.input && typeof block.input === 'object' ? block.input : {});
  return {
    id: `fc_${responseId || now().toString(36)}_${index}`,
    type: 'function_call',
    status,
    name: block?.name || '',
    call_id: block?.id || `toolu_pool_${now().toString(36)}_${index}`,
    arguments: typeof args === 'string' ? args : JSON.stringify(args || {})
  };
}

function chatUsageToResponsesUsage(usage = {}) {
  const inputTokens = numberFromUnknown(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens);
  const outputTokens = numberFromUnknown(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.outputTokens);
  const totalTokens = numberFromUnknown(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
}

function chatToolCallToResponsesItem(tc, responseId, index = 0, status = 'completed') {
  const type = tc?.type === 'custom' ? 'custom' : 'function';
  if (type === 'custom') {
    return {
      id: `ctc_${responseId || now().toString(36)}_${index}`,
      type: 'custom_tool_call',
      status,
      name: tc.custom?.name || '',
      call_id: tc.id || `call_pool_${now().toString(36)}`,
      input: typeof tc.custom?.input === 'string' ? tc.custom.input : stringFromToolOutput(tc.custom?.input)
    };
  }
  return {
    id: `fc_${responseId || now().toString(36)}_${index}`,
    type: 'function_call',
    status,
    name: tc?.function?.name || '',
    call_id: tc?.id || `call_pool_${now().toString(36)}`,
    arguments: typeof tc?.function?.arguments === 'string'
      ? tc.function.arguments
      : JSON.stringify(tc?.function?.arguments || {})
  };
}

function createChatResponsesStreamAdapter(res, model) {
  let buffer = '';
  let completed = false;
  let started = false;
  let contentStarted = false;
  let textDone = false;
  let responseId = '';
  let itemId = '';
  let responseModel = model || '';
  let outputText = '';
  let usage = null;
  const createdAt = Math.floor(now() / 1000);
  const messageOutputIndex = 0;
  const contentIndex = 0;

  // Tool call tracking: keyed by Chat Completions tool_calls index
  const toolCalls = new Map();
  let nextToolOutputIndex = 1; // output_index 0 is the message item
  let textItemEmitted = false;

  function ensureIds() {
    if (!responseId) responseId = `resp_pool_${now().toString(36)}`;
    if (!itemId) itemId = responseId;
  }

  function mergeUsage(nextUsage) {
    const normalized = chatUsageToResponsesUsage(nextUsage);
    if (!normalized) return;
    usage = {
      input_tokens: normalized.input_tokens || usage?.input_tokens || 0,
      output_tokens: normalized.output_tokens || usage?.output_tokens || 0,
      total_tokens: normalized.total_tokens || (normalized.input_tokens || usage?.input_tokens || 0) + (normalized.output_tokens || usage?.output_tokens || 0)
    };
  }

  function responsePayload(status = 'in_progress', output = []) {
    ensureIds();
    return {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status,
      model: responseModel || model || '',
      output,
      usage: status === 'completed' ? usage : null
    };
  }

  function messageItem(status = 'in_progress') {
    ensureIds();
    return {
      id: itemId,
      type: 'message',
      status,
      role: 'assistant',
      content: status === 'completed' && outputText
        ? [{ type: 'output_text', text: outputText, annotations: [] }]
        : []
    };
  }

  function functionCallItem(tc, status = 'in_progress') {
    return tc.type === 'custom'
      ? {
          id: tc.itemId,
          type: 'custom_tool_call',
          status,
          name: tc.name,
          call_id: tc.callId,
          input: tc.arguments
        }
      : {
          id: tc.itemId,
          type: 'function_call',
          status,
          name: tc.name,
          call_id: tc.callId,
          arguments: tc.arguments
        };
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    res.write(responseLifecycleEvent('response.created', responsePayload('in_progress')));
    res.write(responseLifecycleEvent('response.in_progress', responsePayload('in_progress')));
  }

  function ensureTextItemStarted() {
    ensureStarted();
    if (textItemEmitted) return;
    textItemEmitted = true;
    res.write(responseOutputItemEvent('response.output_item.added', messageItem('in_progress'), messageOutputIndex));
  }

  function ensureContentStarted() {
    ensureTextItemStarted();
    if (contentStarted) return;
    contentStarted = true;
    res.write(responseContentPartEvent(
      'response.content_part.added',
      itemId || responseId,
      { type: 'output_text', text: '', annotations: [] },
      messageOutputIndex,
      contentIndex
    ));
  }

  function writeTextDone() {
    if (textDone || !contentStarted) return;
    textDone = true;
    res.write(outputTextDoneEvent(outputText, { itemId: itemId || responseId, outputIndex: messageOutputIndex, contentIndex }));
    res.write(responseContentPartEvent(
      'response.content_part.done',
      itemId || responseId,
      { type: 'output_text', text: outputText, annotations: [] },
      messageOutputIndex,
      contentIndex
    ));
  }

  function finishTextItem() {
    if (!textItemEmitted) return;
    writeTextDone();
    const finalItem = messageItem('completed');
    res.write(responseOutputItemEvent('response.output_item.done', finalItem, messageOutputIndex));
  }

  function finishToolCalls() {
    for (const tc of toolCalls.values()) {
      if (tc.finished) continue;
      tc.finished = true;
      // Emit arguments.done
      res.write(sseEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: tc.itemId,
        output_index: tc.outputIndex,
        call_id: tc.callId,
        name: tc.name,
        arguments: tc.arguments
      }));
      // Emit output_item.done
      res.write(responseOutputItemEvent('response.output_item.done', functionCallItem(tc, 'completed'), tc.outputIndex));
    }
  }

  function buildFinalOutput() {
    const output = [];
    if (textItemEmitted && outputText) {
      output.push(messageItem('completed'));
    }
    for (const tc of toolCalls.values()) {
      output.push(functionCallItem(tc, 'completed'));
    }
    return output;
  }

  function writeCompleted() {
    if (completed) return;
    completed = true;
    ensureStarted();
    // Finish text item if it was started
    if (textItemEmitted) finishTextItem();
    // Finish all tool calls
    finishToolCalls();
    // Emit response.completed with all output items
    const output = buildFinalOutput();
    res.write(completedResponsesEvent(model, {
      id: responseId,
      model: responseModel,
      output,
      usage
    }));
    res.write('data: [DONE]\n\n');
  }

  function handleToolCallDelta(tcDelta) {
    ensureStarted();
    const index = typeof tcDelta.index === 'number' ? tcDelta.index : 0;

    if (!toolCalls.has(index)) {
      // First chunk for this tool call: contains id, function.name, and possibly first argument fragment
      const callId = tcDelta.id || `call_pool_${now().toString(36)}_${index}`;
      const callType = tcDelta.type === 'custom' ? 'custom' : 'function';
      const name = callType === 'custom' ? tcDelta.custom?.name || '' : tcDelta.function?.name || '';
      const outputIndex = nextToolOutputIndex++;
      const tcItemId = `${callType === 'custom' ? 'ctc' : 'fc'}_${responseId || now().toString(36)}_${index}`;
      const tc = {
        type: callType,
        callId,
        name,
        arguments: '',
        outputIndex,
        itemId: tcItemId,
        finished: false
      };
      toolCalls.set(index, tc);

      // Emit response.output_item.added for the function_call
      res.write(responseOutputItemEvent('response.output_item.added', functionCallItem(tc, 'in_progress'), outputIndex));
    }

    const tc = toolCalls.get(index);

    // Update name if it appears in a later chunk (some providers split it)
    if (tcDelta.custom?.name && !tc.name) {
      tc.name = tcDelta.custom.name;
    } else if (tcDelta.function?.name && !tc.name) {
      tc.name = tcDelta.function.name;
    }

    // Accumulate argument fragments
    const argDelta = tc.type === 'custom'
      ? tcDelta.custom?.input || ''
      : tcDelta.function?.arguments || '';
    if (argDelta) {
      tc.arguments += argDelta;
      // Emit response.function_call_arguments.delta
      res.write(sseEvent('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: tc.itemId,
        output_index: tc.outputIndex,
        call_id: tc.callId,
        delta: argDelta
      }));
    }
  }

  function handleEvent(eventText) {
    const { payload } = parseSseEvent(eventText);
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') writeCompleted();
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    responseId = event.id || responseId;
    responseModel = event.model || responseModel;
    if (event.usage) mergeUsage(event.usage);
    const choice = Array.isArray(event.choices) ? event.choices[0] : null;
    if (!choice) return;

    // Handle text content delta
    const textDelta = choice.delta?.content ?? choice.message?.content ?? '';
    if (typeof textDelta === 'string' && textDelta) {
      ensureIds();
      ensureContentStarted();
      outputText += textDelta;
      res.write(outputTextDeltaEvent(textDelta, { itemId: itemId || responseId, outputIndex: messageOutputIndex, contentIndex }));
    }

    // Handle tool_calls deltas
    const deltaToolCalls = choice.delta?.tool_calls || choice.message?.tool_calls;
    if (Array.isArray(deltaToolCalls)) {
      ensureIds();
      for (const tcDelta of deltaToolCalls) {
        handleToolCallDelta(tcDelta);
      }
    }

    if (choice.finish_reason) writeCompleted();
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

function createAnthropicResponsesStreamAdapter(res, model) {
  let buffer = '';
  let completed = false;
  let started = false;
  let contentStarted = false;
  let textDone = false;
  let responseId = '';
  let itemId = '';
  let responseModel = model || '';
  let outputText = '';
  let usage = null;
  const createdAt = Math.floor(now() / 1000);
  const outputIndex = 0;
  const contentIndex = 0;
  const toolUses = new Map();
  let nextToolOutputIndex = 1;

  function ensureIds() {
    if (!responseId) responseId = `resp_pool_${now().toString(36)}`;
    if (!itemId) itemId = responseId;
  }

  function mergeUsage(nextUsage) {
    const normalized = anthropicUsageToResponsesUsage(nextUsage);
    if (!normalized) return;
    usage = {
      input_tokens: normalized.input_tokens || usage?.input_tokens || 0,
      output_tokens: normalized.output_tokens || usage?.output_tokens || 0,
      total_tokens: (normalized.input_tokens || usage?.input_tokens || 0) + (normalized.output_tokens || usage?.output_tokens || 0)
    };
  }

  function responsePayload(status = 'in_progress', output = []) {
    ensureIds();
    return {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status,
      model: responseModel || model || '',
      output,
      usage: status === 'completed' ? (usage === undefined ? null : usage) : null
    };
  }

  function messageItem(status = 'in_progress') {
    ensureIds();
    return {
      id: itemId,
      type: 'message',
      status,
      role: 'assistant',
      content: status === 'completed' && outputText
        ? [{ type: 'output_text', text: outputText, annotations: [] }]
        : []
    };
  }

  function outputTextPart(text = '') {
    return { type: 'output_text', text, annotations: [] };
  }

  function functionCallItem(toolUse, status = 'in_progress') {
    return anthropicToolUseToResponsesFunctionCall(
      { id: toolUse.callId, name: toolUse.name },
      responseId,
      toolUse.index,
      status,
      toolUse.arguments
    );
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    res.write(responseLifecycleEvent('response.created', responsePayload('in_progress')));
    res.write(responseLifecycleEvent('response.in_progress', responsePayload('in_progress')));
    res.write(responseOutputItemEvent('response.output_item.added', messageItem('in_progress'), outputIndex));
  }

  function ensureContentStarted() {
    ensureStarted();
    if (contentStarted) return;
    contentStarted = true;
    res.write(responseContentPartEvent(
      'response.content_part.added',
      itemId || responseId,
      outputTextPart(''),
      outputIndex,
      contentIndex
    ));
  }

  function handleToolUseStart(index, block = {}) {
    ensureStarted();
    if (toolUses.has(index)) return;
    const outputIndexForTool = nextToolOutputIndex++;
    const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
      ? JSON.stringify(block.input)
      : '';
    const toolUse = {
      index,
      callId: block.id || `toolu_pool_${now().toString(36)}_${index}`,
      name: block.name || '',
      arguments: input,
      outputIndex: outputIndexForTool,
      finished: false
    };
    toolUses.set(index, toolUse);
    res.write(responseOutputItemEvent('response.output_item.added', functionCallItem(toolUse, 'in_progress'), outputIndexForTool));
  }

  function handleToolUseDelta(index, partialJson) {
    ensureStarted();
    if (!toolUses.has(index)) handleToolUseStart(index, {});
    const toolUse = toolUses.get(index);
    const delta = String(partialJson || '');
    if (!delta) return;
    toolUse.arguments += delta;
    res.write(sseEvent('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: `fc_${responseId || now().toString(36)}_${toolUse.index}`,
      output_index: toolUse.outputIndex,
      call_id: toolUse.callId,
      delta
    }));
  }

  function finishToolUse(index) {
    const toolUse = toolUses.get(index);
    if (!toolUse || toolUse.finished) return;
    toolUse.finished = true;
    res.write(sseEvent('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: `fc_${responseId || now().toString(36)}_${toolUse.index}`,
      output_index: toolUse.outputIndex,
      call_id: toolUse.callId,
      name: toolUse.name,
      arguments: toolUse.arguments
    }));
    res.write(responseOutputItemEvent('response.output_item.done', functionCallItem(toolUse, 'completed'), toolUse.outputIndex));
  }

  function finishToolUses() {
    for (const index of toolUses.keys()) finishToolUse(index);
  }

  function writeTextDone() {
    if (textDone || !contentStarted) return;
    textDone = true;
    res.write(outputTextDoneEvent(outputText, { itemId: itemId || responseId, outputIndex, contentIndex }));
    res.write(responseContentPartEvent(
      'response.content_part.done',
      itemId || responseId,
      outputTextPart(outputText),
      outputIndex,
      contentIndex
    ));
  }

  function writeCompleted() {
    if (completed) return;
    completed = true;
    ensureStarted();
    writeTextDone();
    finishToolUses();
    const finalItem = messageItem('completed');
    res.write(responseOutputItemEvent('response.output_item.done', finalItem, outputIndex));
    const output = [];
    if (outputText) output.push(finalItem);
    for (const toolUse of toolUses.values()) {
      output.push(functionCallItem(toolUse, 'completed'));
    }
    res.write(completedResponsesEvent(model, {
      id: responseId,
      model: responseModel,
      output,
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
      itemId = event.message.id || itemId || responseId;
      responseModel = event.message.model || responseModel;
      mergeUsage(event.message.usage);
      ensureStarted();
      return;
    }

    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      handleToolUseStart(typeof event.index === 'number' ? event.index : 0, event.content_block);
      return;
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      handleToolUseDelta(typeof event.index === 'number' ? event.index : 0, event.delta.partial_json);
      return;
    }

    if (event.type === 'content_block_stop') {
      finishToolUse(typeof event.index === 'number' ? event.index : 0);
      return;
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const delta = String(event.delta.text || '');
      if (!delta) return;
      ensureContentStarted();
      outputText += delta;
      res.write(outputTextDeltaEvent(delta, { itemId: itemId || responseId, outputIndex, contentIndex }));
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
  const responseId = message.id || `resp_pool_${now().toString(36)}`;
  const output = [];
  if (text) {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }
  if (Array.isArray(message.content)) {
    message.content.forEach((block, index) => {
      if (block?.type === 'tool_use') {
        output.push(anthropicToolUseToResponsesFunctionCall(block, responseId, index));
      }
    });
  }
  return Buffer.from(JSON.stringify({
    id: responseId,
    object: 'response',
    created_at: Math.floor(now() / 1000),
    status: 'completed',
    model: message.model || model || '',
    output,
    output_text: text,
    usage: anthropicUsageToResponsesUsage(message.usage)
  }));
}

function chatCompletionToResponsesJson(body, model) {
  let completion;
  try {
    completion = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return body;
  }
  const choice = Array.isArray(completion.choices) ? completion.choices[0] : null;
  const text = typeof choice?.message?.content === 'string'
    ? choice.message.content
    : typeof choice?.delta?.content === 'string'
      ? choice.delta.content
      : '';
  const responseId = completion.id || `resp_pool_${now().toString(36)}`;
  const output = [];

  // Add message item if there is text content
  if (text) {
    output.push({
      id: responseId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    });
  }

  // Add function_call items for each tool_call
  const toolCalls = choice?.message?.tool_calls || choice?.delta?.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      output.push(chatToolCallToResponsesItem(tc, responseId, tc.index ?? output.length, 'completed'));
    }
  }

  return Buffer.from(JSON.stringify({
    id: responseId,
    object: 'response',
    created_at: completion.created || Math.floor(now() / 1000),
    status: 'completed',
    model: completion.model || model || '',
    output,
    output_text: text,
    usage: chatUsageToResponsesUsage(completion.usage)
  }));
}

function ensureTokenUsage(stats) {
  if (!stats.tokenUsage || typeof stats.tokenUsage !== 'object') {
    stats.tokenUsage = { totalTokens: 0, inputTokens: 0, outputTokens: 0, byDay: {}, daily: {} };
  }
  stats.tokenUsage.totalTokens = numberFromUnknown(stats.tokenUsage.totalTokens);
  stats.tokenUsage.inputTokens = numberFromUnknown(stats.tokenUsage.inputTokens);
  stats.tokenUsage.outputTokens = numberFromUnknown(stats.tokenUsage.outputTokens);
  if (!stats.tokenUsage.byDay || typeof stats.tokenUsage.byDay !== 'object' || Array.isArray(stats.tokenUsage.byDay)) {
    stats.tokenUsage.byDay = {};
  }
  if (!stats.tokenUsage.daily || typeof stats.tokenUsage.daily !== 'object' || Array.isArray(stats.tokenUsage.daily)) {
    stats.tokenUsage.daily = {};
  }
  for (const [day, entry] of Object.entries(stats.tokenUsage.daily)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      stats.tokenUsage.daily[day] = { totalTokens: numberFromUnknown(entry), inputTokens: 0, outputTokens: 0 };
      continue;
    }
    entry.totalTokens = numberFromUnknown(entry.totalTokens);
    entry.inputTokens = numberFromUnknown(entry.inputTokens);
    entry.outputTokens = numberFromUnknown(entry.outputTokens);
  }
  return stats.tokenUsage;
}

function recordTokenUsage(upstream, tokenCount, timestamp = now()) {
  const tokens = normalizeTokenUsage(tokenCount);
  if (!hasTokenUsage(tokens)) return emptyTokenUsage();
  const usage = ensureTokenUsage(upstream.stats);
  const day = localDateKey(timestamp);
  usage.totalTokens += tokens.totalTokens;
  usage.inputTokens += tokens.inputTokens;
  usage.outputTokens += tokens.outputTokens;
  usage.byDay[day] = numberFromUnknown(usage.byDay[day]) + tokens.totalTokens;
  const daily = usage.daily[day] || { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
  daily.totalTokens = numberFromUnknown(daily.totalTokens) + tokens.totalTokens;
  daily.inputTokens = numberFromUnknown(daily.inputTokens) + tokens.inputTokens;
  daily.outputTokens = numberFromUnknown(daily.outputTokens) + tokens.outputTokens;
  usage.daily[day] = daily;
  return tokens;
}

function tokenDailyEntry(usage, day) {
  const entry = usage.daily?.[day];
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return {
      total_tokens: numberFromUnknown(entry.totalTokens),
      input_tokens: numberFromUnknown(entry.inputTokens),
      output_tokens: numberFromUnknown(entry.outputTokens)
    };
  }
  return {
    total_tokens: numberFromUnknown(usage.byDay?.[day]),
    input_tokens: 0,
    output_tokens: 0
  };
}

function tokenDailyPayload(usage) {
  const days = new Set([
    ...Object.keys(usage.byDay || {}),
    ...Object.keys(usage.daily || {})
  ]);
  return Object.fromEntries([...days].sort().map((day) => [day, tokenDailyEntry(usage, day)]));
}

function usagePayload(stats, today = localDateKey()) {
  const usage = ensureTokenUsage(stats);
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    daily: tokenDailyPayload(usage)
  };
}

function aggregateUsage(upstreams, today = localDateKey()) {
  const daily = {};
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const upstream of upstreams) {
    const usage = ensureTokenUsage(upstream.stats);
    totalTokens += usage.totalTokens;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    for (const day of new Set([...Object.keys(usage.byDay || {}), ...Object.keys(usage.daily || {})])) {
      const entry = tokenDailyEntry(usage, day);
      const target = daily[day] || { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
      target.total_tokens += entry.total_tokens;
      target.input_tokens += entry.input_tokens;
      target.output_tokens += entry.output_tokens;
      daily[day] = target;
    }
  }
  return {
    total_tokens: totalTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    daily
  };
}

function dailyUsageRows(upstreams) {
  const rows = [];
  for (const upstream of upstreams) {
    const usage = ensureTokenUsage(upstream.stats);
    const days = new Set([...Object.keys(usage.byDay || {}), ...Object.keys(usage.daily || {})]);
    for (const day of days) {
      const entry = tokenDailyEntry(usage, day);
      if (!entry.total_tokens && !entry.input_tokens && !entry.output_tokens) continue;
      rows.push({
        date: day,
        upstream: upstream.name,
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        total_tokens: entry.total_tokens
      });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.upstream.localeCompare(b.upstream));
  return rows;
}

function dailyUsageSummary(rows) {
  const byDay = {};
  for (const row of rows) {
    const target = byDay[row.date] || { date: row.date, input_tokens: 0, output_tokens: 0, total_tokens: 0, upstreams: 0 };
    target.input_tokens += row.input_tokens;
    target.output_tokens += row.output_tokens;
    target.total_tokens += row.total_tokens;
    target.upstreams += 1;
    byDay[row.date] = target;
  }
  return Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date));
}

function dailyUsageExportPayload(state) {
  const rows = dailyUsageRows(state.upstreams);
  return {
    generated_at: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    summary: dailyUsageSummary(rows),
    rows
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function dailyUsageCsv(payload) {
  const lines = [['date', 'upstream', 'input_tokens', 'output_tokens', 'total_tokens'].join(',')];
  for (const row of payload.rows) {
    lines.push([
      row.date,
      row.upstream,
      row.input_tokens,
      row.output_tokens,
      row.total_tokens
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
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

function recordResponseStats(upstream, key, statusCode, retried = false, succeeded = statusCode >= 200 && statusCode < 400) {
  upstream.stats.responses += 1;
  upstream.stats.lastStatus = statusCode || 0;
  key.stats.responses += 1;
  if (retried) {
    upstream.stats.retries += 1;
    key.stats.retries += 1;
  }
  if (succeeded) {
    upstream.stats.successes += 1;
    key.stats.successes += 1;
  } else {
    upstream.stats.failures += 1;
    key.stats.failures += 1;
  }
}

function recordAttemptOutcome(state, upstream, key, succeeded, protocol) {
  recordAvailability(upstream, key, succeeded, state.availability, protocol);
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
  const failureMultiplier = Math.min(8, Math.max(1, upstream.failures));
  const cooldownMs = parseRetryAfterMs(retryAfter, cooldownBase * failureMultiplier);

  const keyScopedFailure = KEY_SCOPED_FAILURE_STATUS.has(statusCode);
  if (keyScopedFailure) {
    key.cooldownUntil = now() + cooldownMs;
  }

  if (!keyScopedFailure && (upstream.failures >= state.retry.failureThreshold || statusCode === 0 || state.retry.retryableStatus.has(statusCode))) {
    upstream.cooldownUntil = now() + cooldownMs;
  }
}

function realTrafficFailureAuthoritative(statusCode, reason = '') {
  const status = Number(statusCode || 0);
  if (status === STREAM_ERROR_STATUS) return true;
  if (status === 0 || status === 408 || status === 429 || status === 401 || status === 403) return true;
  if (status >= 521 && status <= 524) return true;
  return /timeout|timed out|network|tls|socket|invalid[_ -]?api[_ -]?key|unauthorized|permission_denied|quota|rate.?limit/i.test(String(reason || ''));
}

function recordRealTrafficFailure(state, upstream, key, reason, statusCode, retryAfter) {
  if (realTrafficFailureAuthoritative(statusCode, reason)) {
    key.nonAuthoritativeFailures = 0;
    recordFailure(state, upstream, key, reason, statusCode, retryAfter);
    return;
  }
  const nextNonAuthoritativeFailures = Number(key.nonAuthoritativeFailures || 0) + 1;
  if (nextNonAuthoritativeFailures >= 3) {
    key.nonAuthoritativeFailures = 0;
    recordFailure(state, upstream, key, reason, statusCode, retryAfter);
    return;
  }
  key.nonAuthoritativeFailures = nextNonAuthoritativeFailures;
  upstream.failures += 1;
  upstream.lastError = reason;
  upstream.lastStatus = statusCode || 0;
  key.failures += 1;
}

function recordModelInteractionOutcome({
  state,
  upstream,
  key,
  statusCode,
  startedAt,
  retried = false,
  succeeded = statusCode >= 200 && statusCode < 400,
  reason = '',
  retryAfter,
  tokenCount = 0,
  applyFailure = true,
  protocol
}) {
  recordResponseStats(upstream, key, statusCode, retried, succeeded);
  recordAttemptOutcome(state, upstream, key, succeeded, protocol);
  const recordedTokens = succeeded ? recordTokenUsage(upstream, tokenCount, startedAt) : emptyTokenUsage();
  if (succeeded) {
    recordSuccess(upstream, startedAt, statusCode);
    key.nonAuthoritativeFailures = 0;
    // A real-traffic success clears any per-protocol cooldown for this protocol.
    if (protocol) clearProtocolCooldown(upstream, protocol);
  } else if (applyFailure) {
    const failureReason = reason || `HTTP ${statusCode}`;
    recordRealTrafficFailure(state, upstream, key, failureReason, statusCode, retryAfter);
    // Apply per-protocol cooldown alongside the global cooldown. This is additive:
    // recordRealTrafficFailure / recordFailure already set upstream.cooldownUntil
    // when warranted; here we additionally cool the specific protocol when the
    // same condition holds, so the other protocols can still serve traffic.
    if (protocol && !KEY_SCOPED_FAILURE_STATUS.has(statusCode) && (upstream.failures >= state.retry.failureThreshold || statusCode === 0 || state.retry.retryableStatus.has(statusCode))) {
      const cooldownBase = statusCode === 429 ? state.retry.keyCooldownMs : state.retry.baseCooldownMs;
      const failureMultiplier = Math.min(8, Math.max(1, upstream.failures));
      const cooldownMs = parseRetryAfterMs(retryAfter, cooldownBase * failureMultiplier);
      applyProtocolCooldown(upstream, protocol, {
        until: new Date(now() + cooldownMs).toISOString(),
        reason: failureReason
      });
    }
  }
  return recordedTokens;
}

function finishResponseAttempt({ state, upstream, key, method, pathname, incomingHeaders, incomingBody, originalModel, attemptedModel, statusCode, startedAt, attempt, reason = '', retryAfter, tokenCount = 0, succeeded = statusCode >= 200 && statusCode < 400, routeTrace, compatibility = null, statsPath, protocol }) {
  const failureReason = reason || (statusCode >= 200 && statusCode < 400 ? 'HTTP success without concrete output' : `HTTP ${statusCode}`);
  const recordedTokens = recordModelInteractionOutcome({
    state,
    upstream,
    key,
    statusCode,
    startedAt,
    retried: false,
    succeeded,
    reason: failureReason,
    retryAfter,
    tokenCount,
    protocol
  });
  rememberRequest(state, {
    method,
    path: pathname,
    entry_protocol: 'responses',
    ...requestDebugFields(incomingHeaders, incomingBody),
    upstream: upstream.name,
    key: key.label,
    originalModel: originalModel || null,
    actualModel: attemptedModel || null,
    status: statusCode,
    durationMs: now() - startedAt,
    retried: attempt > 1,
    outcome: succeeded ? 'ok' : 'error',
    reason: succeeded ? '' : failureReason,
    route: routeTrace,
    ...(compatibility ? { compatibility } : {}),
    tokens: recordedTokens.totalTokens,
    inputTokens: recordedTokens.inputTokens,
    outputTokens: recordedTokens.outputTokens
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

function parseJsonBody(body) {
  try {
    return JSON.parse(String(body || '').trim() || '{}');
  } catch {
    return null;
  }
}

function advancedCurlRequiredProbeError(result) {
  const statusCode = Number(result?.statusCode || 0);
  const hasErrorEnvelope = responseHasErrorEnvelope(result);
  if (![400, 401, 403].includes(statusCode) && !(statusCode >= 200 && statusCode < 300 && hasErrorEnvelope)) return '';
  const json = parseJsonBody(result?.body);
  const error = json && typeof json === 'object' ? json.error : null;
  const code = String(
    error && typeof error === 'object'
      ? error.code || ''
      : json?.code || ''
  ).trim();
  const message = String(
    error && typeof error === 'object'
      ? error.message || ''
      : typeof error === 'string'
        ? error
        : json?.message || result?.body || ''
  ).trim();
  const body = `${code} ${message}`.toLowerCase();
  if (
    statusCode === 400 &&
    (code === 'invalid_responses_request' || /invalid_responses_request/i.test(body)) &&
    /invalid codex request/i.test(body)
  ) {
    return '该上游要求真实 Codex 对话转发中的客户端上下文（例如 attestation、turn metadata 或等价签名）。标准 Health Probe 不能伪造完整旧版对话请求形态；请用真实 Codex 请求转发的响应结果验证可用性。';
  }
  if (code === 'codex_access_restricted' || /codex_access_restricted|请使用最新版的codex客户端或codex cli调用|use latest codex client|please use .*codex.*(?:client|cli)/i.test(body)) {
    return '该上游要求比标准 Curl 更完整的请求形态（例如真实 Codex 客户端上下文、签名或额外头），当前测试请求无法单独验证；请使用匹配上游要求的高级 Curl profile 或真实 Codex 请求转发验证。';
  }
  if (/channel:client_restricted|client[_ -]?restricted|不允许当前客户端|current client .*not allowed|client .*restricted|go-http-client/i.test(body)) {
    return '该上游限制了 Health Probe 的客户端形态，当前测试请求不能代表真实 Claude/Codex 转发；请使用真实客户端请求或匹配上游要求的高级测试配置验证可用性。';
  }
  if (/missing .*codex .*context|codex .*context .*required|requires .*codex .*context|真实 codex .*上下文|缺少.*codex.*上下文/i.test(body)) {
    return '该上游要求真实 Codex 请求上下文。标准 Health Probe 只能做合成验证，不能单独证明该上游不可用；请用真实 Codex 请求转发的响应结果验证可用性。';
  }
  if (/1m.*上下文|上下文.*1m|1m .*context|context .*1m|enable .*1m|启用.*1m/i.test(body)) {
    return '该上游要求 Claude 1m 上下文 beta 或等价真实客户端能力。标准 Health Probe 只能做合成验证，不能单独证明该上游不可用；请用真实 Claude 请求转发的响应结果验证可用性。';
  }
  return '';
}

function responseErrorParts(result) {
  const json = parseJsonBody(result?.body);
  const error = json && typeof json === 'object' ? json.error : null;
  const code = String(
    error && typeof error === 'object'
      ? error.code || error.type || ''
      : json?.code || json?.type || ''
  ).trim();
  const message = String(
    error && typeof error === 'object'
      ? error.message || ''
      : typeof error === 'string'
        ? error
        : json?.message || result?.body || ''
  ).trim();
  return { code, message };
}

function responseHasErrorEnvelope(result) {
  const json = parseJsonBody(result?.body);
  return Boolean(json && typeof json === 'object' && (
    Object.prototype.hasOwnProperty.call(json, 'error') ||
    String(json.type || '').trim().toLowerCase() === 'error'
  ));
}

function genericUnavailableErrorEnvelope(result) {
  if (!responseHasErrorEnvelope(result)) return false;
  const { code, message } = responseErrorParts(result);
  const value = `${code} ${message}`.toLowerCase();
  return /service unavailable|temporarily unavailable|upstream unavailable/.test(value);
}

function responseLooksLikeBrowserChallenge(result) {
  const contentType = String(firstHeader(result?.headers || {}, ['content-type']) || '').toLowerCase();
  const body = String(result?.body || '').slice(0, 12000);
  return contentType.includes('text/html') || /<html|<!doctype html|cloudflare|cf-ray|cdn-cgi|challenge-platform|just a moment|attention required/i.test(body);
}

function providerAuthError(result) {
  const { code, message } = responseErrorParts(result);
  const value = `${code} ${message}`.toLowerCase();
  return /invalid[_ -]?api[_ -]?key|authentication_error|unauthorized|permission_denied|permission denied|invalid auth|invalid token|missing api key|incorrect api key/.test(value);
}

function clearUnsupportedModelOrApiError(result) {
  const { code, message } = responseErrorParts(result);
  const value = `${code} ${message}`.toLowerCase();
  return /model[_ -]?not[_ -]?found|unsupported[_ -]?model|model .*not (?:available|supported|found)|unsupported[_ -]?(?:endpoint|api)|endpoint .*not supported|api .*not supported/.test(value);
}

function inconclusiveProbeClassification(result, protocol, reason = '') {
  const statusCode = Number(result?.statusCode || 0);
  const statusText = statusCode ? `HTTP ${statusCode}` : 'probe response';
  return {
    state: 'inconclusive',
    outcome: 'inconclusive',
    authoritative: false,
    representative: false,
    error: reason || `${protocol} probe ${statusText} is not authoritative for Codex Desktop availability`
  };
}

function hasResponsesOutput(json) {
  return Boolean(json && typeof json === 'object' && (
    typeof json.output_text === 'string' ||
    (Array.isArray(json.output) && json.output.length > 0)
  ));
}

function hasChatCompletionsOutput(json) {
  return Boolean(json && typeof json === 'object' && Array.isArray(json.choices) && json.choices.length > 0);
}

function hasAnthropicMessageOutput(json) {
  return Boolean(json && typeof json === 'object' && Array.isArray(json.content) && json.content.length > 0);
}

function hasResponsesSseOutput(body) {
  return /response\.output|\"output_text\"\s*:|\"output\"\s*:\s*\[/.test(String(body || ''));
}

function modelProbeValidationError(result, protocol) {
  const httpState = classifyHealth(result.statusCode, result.error);
  if (httpState !== 'ok') return '';

  const body = String(result.body || '').trim();
  if (!body) return `${protocol} probe returned HTTP ${result.statusCode} without a response body`;

  if (protocol === 'responses' || protocol === 'codex_oauth') {
    if (hasResponsesSseOutput(body)) return '';
    if (hasResponsesOutput(parseJsonBody(body))) return '';
    return `${protocol} probe returned HTTP ${result.statusCode} without Responses output/output_text`;
  }

  const json = parseJsonBody(body);
  if (protocol === 'chat_completions') {
    return hasChatCompletionsOutput(json)
      ? ''
      : `chat_completions probe returned HTTP ${result.statusCode} without choices`;
  }
  if (protocol === 'anthropic') {
    return hasAnthropicMessageOutput(json)
      ? ''
      : `anthropic messages probe returned HTTP ${result.statusCode} without content`;
  }
  return '';
}

function classifyModelProbe(result, protocol, options = {}) {
  const advancedCurlRequiredError = options.representative === true ? '' : advancedCurlRequiredProbeError(result);
  if (advancedCurlRequiredError) {
    return {
      state: 'advanced_curl_required',
      outcome: 'non_representative',
      authoritative: false,
      representative: false,
      error: advancedCurlRequiredError
    };
  }
  const state = classifyHealth(result.statusCode, result.error);
  if (state !== 'ok') {
    if (options.representative === true) return { state, outcome: 'authoritative_failure', authoritative: true, representative: true, error: result.error || '' };
    if (state === 'auth_error') {
      if (responseLooksLikeBrowserChallenge(result) || !providerAuthError(result)) {
        return inconclusiveProbeClassification(result, protocol, `${protocol} probe HTTP ${result.statusCode} did not include a recognized provider auth error shape; result is not authoritative`);
      }
      return { state, outcome: 'authoritative_failure', authoritative: true, representative: true, error: result.error || '' };
    }
    if (state === 'rate_limited' || state === 'network_error' || state === 'timeout') {
      return { state, outcome: 'authoritative_failure', authoritative: true, representative: true, error: result.error || '' };
    }
    if (state === 'models_unsupported') {
      return { state, outcome: 'authoritative_failure', authoritative: true, representative: true, error: result.error || '' };
    }
    if (state === 'server_error' || state === 'unexpected_status') {
      if (clearUnsupportedModelOrApiError(result)) return { state: 'models_unsupported', outcome: 'authoritative_failure', authoritative: true, representative: true, error: result.error || '' };
      return inconclusiveProbeClassification(result, protocol);
    }
    return { state, outcome: 'authoritative_failure', authoritative: true, representative: true, error: result.error || '' };
  }
  const validationError = modelProbeValidationError(result, protocol);
  if (validationError && options.representative !== true && genericUnavailableErrorEnvelope(result)) {
    return inconclusiveProbeClassification(result, protocol, `${protocol} probe returned a provider unavailable error envelope; result is not authoritative`);
  }
  return validationError
    ? { state: 'unexpected_status', outcome: 'authoritative_failure', authoritative: true, representative: options.representative === true, error: validationError }
    : { state: 'ok', outcome: 'ok', authoritative: true, representative: options.representative === true, error: '' };
}

function probeClassificationError(classified, result, protocol) {
  if (classified?.error) return classified.error;
  if (result?.error) return result.error;
  return `${protocol} probe ${classified?.state || 'unknown'}`;
}

function probeClassificationIsAuthoritativeFailure(classified) {
  return classified?.outcome === 'authoritative_failure' || classified?.authoritative === true && classified?.state !== 'ok';
}

function probeClassificationIsNonRepresentative(classified) {
  return classified?.outcome === 'non_representative';
}

function openAiProbeDecision({
  upstream,
  probeModel,
  responsesResult,
  responsesClassification,
  chatResult,
  chatClassification
}) {
  const responsesState = responsesClassification?.state || 'unknown';
  const chatState = chatClassification?.state || 'unknown';
  if (chatState === 'ok') {
    return {
      stateName: 'ok',
      healthResult: chatResult,
      healthError: '',
      healthWarning: `responses probe ${responsesState}; chat_completions probe ok`,
      resolvedMode: 'chat_completions'
    };
  }
  if (responsesState === 'advanced_curl_required' || responsesState === 'codex_forward_only') {
    return {
      stateName: responsesState,
      healthResult: responsesResult,
      healthError: probeClassificationError(responsesClassification, responsesResult, 'responses')
    };
  }
  if (shouldKeepNativeResponsesProbeDispatchable(upstream, responsesClassification)) {
    return {
      stateName: 'codex_forward_only',
      healthResult: responsesResult,
      healthError: codexForwardOnlyProbeError(responsesClassification, chatClassification)
    };
  }
  if (
    responsesState === 'models_unsupported' &&
    probeClassificationIsAuthoritativeFailure(chatClassification) &&
    chatState !== 'models_unsupported'
  ) {
    return {
      stateName: chatState,
      healthResult: chatResult,
      healthError: probeClassificationError(chatClassification, chatResult, 'chat_completions')
    };
  }
  if (probeClassificationIsAuthoritativeFailure(responsesClassification)) {
    return {
      stateName: responsesState,
      healthResult: responsesResult,
      healthError: probeClassificationError(responsesClassification, responsesResult, 'responses')
    };
  }
  if (probeClassificationIsAuthoritativeFailure(chatClassification)) {
    return {
      stateName: chatState,
      healthResult: chatResult,
      healthError: probeClassificationError(chatClassification, chatResult, 'chat_completions')
    };
  }

  const verifiedRealTrafficProtocol = verifiedRealTrafficProtocolForModel(upstream, probeModel);
  if (verifiedRealTrafficProtocol) {
    return {
      stateName: 'codex_forward_only',
      healthResult: responsesResult,
      healthError: `real ${verifiedRealTrafficProtocol} traffic has succeeded for ${probeModel}, but the standard Health Probe is not representative of real Codex traffic: ${codexForwardOnlyProbeError(responsesClassification, chatClassification)}`
    };
  }
  if (chatState === 'advanced_curl_required' || chatState === 'codex_forward_only' || probeClassificationIsNonRepresentative(chatClassification)) {
    return {
      stateName: chatState,
      healthResult: chatResult,
      healthError: probeClassificationError(chatClassification, chatResult, 'chat_completions')
    };
  }
  return {
    stateName: responsesState === 'inconclusive' ? 'inconclusive' : chatState,
    healthResult: responsesState === 'inconclusive' ? responsesResult : chatResult,
    healthError: `${probeClassificationError(responsesClassification, responsesResult, 'responses')}; ${probeClassificationError(chatClassification, chatResult, 'chat_completions')}`
  };
}

function shouldKeepNativeResponsesProbeDispatchable(upstream, responsesClassification) {
  return upstreamHasConfiguredNativeResponses(upstream) &&
    NON_REPRESENTATIVE_NATIVE_RESPONSES_PROBE_STATES.has(responsesClassification?.state);
}

function codexForwardOnlyProbeError(responsesClassification, chatClassification) {
  const responsesError = responsesClassification?.error || `responses probe ${responsesClassification?.state || 'unknown'}`;
  const chatError = chatClassification?.error || `chat probe ${chatClassification?.state || 'unknown'}`;
  return `native Responses capability is user-declared or configured, but the standard Health Probe is not representative of real Codex traffic: ${responsesError}; ${chatError}`;
}

function updateHealthFromRealTraffic(upstream, key, {
  checkedAt = new Date().toISOString(),
  model = '',
  httpStatus = 0,
  latencyMs = 0,
  protocol = ''
} = {}) {
  if (!upstream) return;
  const models = upstream.health?.models || [];
  const health = {
    ...upstream.health,
    state: 'ok',
    source: 'real_traffic',
    checkedAt,
    latencyMs: Number(latencyMs || 0) || upstream.health?.latencyMs || 0,
    httpStatus: Number(httpStatus || 0) || 200,
    error: '',
    warning: protocol ? `verified by real ${protocol} traffic` : 'verified by real traffic',
    models,
    modelsCount: upstream.health?.modelsCount ?? models.length,
    keyLabel: key?.label || upstream.health?.keyLabel || null,
    probeModel: String(model || '')
  };
  upstream.health = health;
  if (key) {
    recordRepresentativeSuccessEvidence(key, protocol || 'responses', {
      model,
      source: 'real_traffic',
      checkedAt,
      httpStatus
    });
    key.health = {
      ...key.health,
      state: 'ok',
      source: 'real_traffic',
      checkedAt,
      latencyMs: health.latencyMs,
      httpStatus: health.httpStatus,
      error: '',
      warning: health.warning,
      probeModel: health.probeModel
    };
  }
}

function verifiedRealTrafficProtocolForModel(upstream, model) {
  const expectedModel = String(model || '').trim();
  if (!expectedModel) return '';
  const capabilities = normalizeProtocolCapabilities(upstream?.capabilities);
  for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
    const capability = capabilities[protocol];
    if (
      capability.status === 'verified' &&
      capability.source === 'real_traffic' &&
      capability.representative === true &&
      String(capability.model || '').trim() === expectedModel
    ) {
      return protocol;
    }
  }
  return '';
}

function healthProbeEffectiveState(health, expectedModel) {
  const state = health?.state || 'unknown';
  if (state === 'ok' && health?.source === 'real_traffic') return 'ok';
  if (state !== 'ok' || expectedModel === undefined) return state;
  const expected = normalizeProbeModel(expectedModel);
  // No model_override set (following client request) → use raw probe state.
  // The probe was run without a specific model target, so stale/missing
  // override checks are not applicable.
  if (!expected) return state;
  return healthMatchesProbeModel(health, expected) ? 'ok' : 'stale_model_override';
}

function healthProbeEffectiveError(health, expectedModel) {
  const state = healthProbeEffectiveState(health, expectedModel);
  if (state === 'stale_model_override') {
    const previous = normalizeProbeModel(health?.probeModel) || 'unknown';
    const current = normalizeProbeModel(expectedModel) || 'missing';
    return `Health Probe was last run for model_override ${previous}; current model_override is ${current}`;
  }
  // Only surface the missing_model_override error when the raw health state
  // itself is missing_model_override (i.e., no discovered models to probe),
  // not when the override is simply empty (following client request).
  const rawState = health?.state || 'unknown';
  if (state === 'missing_model_override' && rawState === 'missing_model_override') {
    return health?.error || 'Health Probe requires model_override so it can test the exact active model';
  }
  return health?.error || '';
}

function healthProbeOk(health, expectedModel = undefined) {
  return healthProbeEffectiveState(health, expectedModel) === 'ok';
}

function healthProbeStatus(health, expectedModel = undefined) {
  const state = healthProbeEffectiveState(health, expectedModel);
  if (healthProbeOk(health, expectedModel)) return 'ok';
  if (state === 'unknown' || state === 'disabled' || state === 'oauth_ready' || state === 'stale_model_override' || state === 'advanced_curl_required' || state === 'codex_forward_only' || state === 'inconclusive') return 'skipped';
  return 'failed';
}

function healthProbeSummary(upstreams = [], expectedModel = undefined) {
  const active = upstreams.filter((upstream) => upstream.enabled && !upstream.quarantined);
  const quarantined = upstreams.filter((upstream) => upstream.enabled && upstream.quarantined);
  const disabled = upstreams.filter((upstream) => !upstream.enabled);
  const stateCounts = {};
  let okCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const upstream of upstreams) {
    const state = healthProbeEffectiveState(upstream.health, expectedModel);
    const status = healthProbeStatus(upstream.health, expectedModel);
    stateCounts[state] = (stateCounts[state] || 0) + 1;
    if (!upstream.enabled) {
      skippedCount += 1;
      continue;
    }
    if (upstream.quarantined) continue;
    if (status === 'ok') okCount += 1;
    else if (status === 'skipped') skippedCount += 1;
    else failedCount += 1;
  }
  const probeStatus = active.length === 0
    ? 'skipped'
    : failedCount > 0
      ? 'failed'
      : okCount === active.length
        ? 'ok'
        : 'skipped';
  return {
    probe_ok: probeStatus === 'ok',
    probe_status: probeStatus,
    total_count: upstreams.length,
    enabled_count: active.length,
    active_count: active.length,
    quarantined_count: quarantined.length,
    disabled_count: disabled.length,
    ok_count: okCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    states: stateCounts
  };
}

function requestUpstream({ req, body, targetUrl, upstream, key, timeoutMs, allowRetry, retryableStatus, method, headers }) {
  if (upstream.codexOAuth && /^https:/i.test(targetUrl)) {
    return requestHttp2Upstream({ body, targetUrl, upstream, key, timeoutMs, allowRetry, retryableStatus, method: method || req.method, headers: headers || sanitizeRequestHeaders(req.headers, key.value, targetUrl) });
  }
  return new Promise((resolve) => {
    const startedAt = now();
    let settled = false;

    const requestHeaders = headers || sanitizeRequestHeaders(req.headers, key.value, targetUrl);
    requestHeaders['content-length'] = body.length;
    const request = requestOptionsForTarget(targetUrl, method || req.method, requestHeaders, timeoutMs, upstream.proxyUrl);

    const upstreamReq = request.client.request(
      request.target,
      request.options,
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 502;
        const retryAfter = upstreamRes.headers['retry-after'];

        if (allowRetry && retryableStatus.has(statusCode)) {
          const chunks = [];
          let total = 0;
          upstreamRes.on('data', (chunk) => {
            if (total >= 4096) return;
            const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const available = Math.max(0, 4096 - total);
            chunks.push(next.subarray(0, available));
            total += Math.min(next.length, available);
          });
          upstreamRes.on('end', () => {
            if (settled) return;
            settled = true;
            const bodyText = chunks.length ? Buffer.concat(chunks, total).toString('utf8').trim() : '';
            const reason = bodyText ? `HTTP ${statusCode}: ${bodyText.slice(0, 1000)}` : `HTTP ${statusCode}`;
            resolve({ type: 'retry', statusCode, retryAfter, headers: upstreamRes.headers, reason, startedAt });
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

async function requestTrackedUpstream(options) {
  const upstream = options.upstream;
  upstream.inFlight += 1;
  try {
    const result = await requestUpstream(options);
    if (result.type !== 'response') upstream.inFlight = Math.max(0, upstream.inFlight - 1);
    return result;
  } catch (error) {
    upstream.inFlight = Math.max(0, upstream.inFlight - 1);
    throw error;
  }
}

// ============================================================================
// DEBUG LOCK MODE - Request Execution
// ============================================================================

async function executeDebugLockedRequest(req, res, state, config, options) {
  const { pathname, clientProtocol, statsPath, maxBodyBytes } = options;
  const startTime = now();

  // Read request body
  const originalBody = await readBody(req, maxBodyBytes);
  const responsesJsonOptions = { inferJsonLike: pathname === '/v1/responses' };

  // Parse model
  const originalModel = modelFromBody(req, originalBody, responsesJsonOptions);

  // Apply model override if configured
  const shouldApplyOverride = state.debugLock.respect_model_override && state.modelOverride;
  const requestedModel = shouldApplyOverride ? state.modelOverride : originalModel;

  // Get locked upstream
  const upstream = state.upstreams.find(u => u.name === state.debugLock.upstream);
  if (!upstream) {
    return jsonResponse(res, 500, {
      error: {
        message: `Debug lock: upstream not found: ${state.debugLock.upstream}`,
        type: 'debug_lock_error',
        upstream: state.debugLock.upstream
      }
    });
  }

  // Get first valid key
  const key = (upstream.keys || []).find(k => k.value);
  if (!key) {
    return jsonResponse(res, 500, {
      error: {
        message: `Debug lock: no valid key for upstream: ${state.debugLock.upstream}`,
        type: 'debug_lock_error',
        upstream: state.debugLock.upstream
      }
    });
  }

  // Build protocol attempt sequence
  const sequence = buildProtocolAttemptSequence(clientProtocol);
  const attempts = [];
  let succeeded = false;
  let successResponse = null;

  // Try each protocol in sequence
  for (let i = 0; i < sequence.length; i++) {
    const { protocol, adapter } = sequence[i];
    const attemptStart = now();

    // Determine endpoint using smart path functions to avoid duplicate /v1
    const endpoint = protocol === 'responses'
      ? responsesPathForBaseUrl(upstream.baseUrl)
      : protocol === 'anthropic_messages'
      ? anthropicMessagesPathForBaseUrl(upstream.baseUrl)
      : chatCompletionsPathForBaseUrl(upstream.baseUrl);

    const targetUrl = joinUrlPath(upstream.baseUrl, endpoint);

    // Prepare request body (apply adapter if needed)
    let requestBody = originalBody;
    const adapterInfo = {
      conversions: [],
      stripped: []
    };

    if (adapter) {
      // Apply adapter conversion
      if (protocol === 'chat_completions') {
        // Convert Responses to Chat Completions
        const bodyWithModel = rewriteModelInBody(req, originalBody, requestedModel, responsesJsonOptions);
        requestBody = buildChatCompletionsPayload(bodyWithModel, requestedModel);
        adapterInfo.conversions.push('responses->chat_completions');
      } else if (protocol === 'anthropic_messages') {
        // Convert Responses to Anthropic Messages
        const bodyWithModel = rewriteModelInBody(req, originalBody, requestedModel, responsesJsonOptions);
        requestBody = buildAnthropicMessagesPayload(bodyWithModel, requestedModel);
        adapterInfo.conversions.push('responses->anthropic_messages');
      }
    } else if (protocol !== clientProtocol) {
      // Native protocol but different from client (shouldn't happen with current logic)
      const bodyWithModel = rewriteModelInBody(req, originalBody, requestedModel, responsesJsonOptions);
      requestBody = bodyWithModel;
    } else {
      // Native protocol, same as client
      const bodyWithModel = rewriteModelInBody(req, originalBody, requestedModel, responsesJsonOptions);
      requestBody = bodyWithModel;
    }

    // Check if adapter is enabled in production config
    const productionDisabled = adapter && !isAdapterEnabledInConfig(protocol, config);

    // Send request
    try {
      const result = await requestUpstream({
        req,
        body: requestBody,
        targetUrl,
        upstream,
        key,
        timeoutMs: config.server?.request_timeout_ms || 180000,
        allowRetry: false,  // No retry in debug mode
        retryableStatus: new Set(),
        method: 'POST',
        headers: null
      });

      const latencyMs = now() - attemptStart;

      if (result.type === 'response') {
        const { response, statusCode } = result;

        // Collect response body
        const chunks = [];
        let bodySize = 0;
        const maxBodySize = config.server?.max_body_bytes || 50 * 1024 * 1024;

        for await (const chunk of response) {
          if (bodySize < maxBodySize) {
            chunks.push(chunk);
            bodySize += chunk.length;
          }
        }

        const responseBody = bodySize < maxBodySize
          ? Buffer.concat(chunks, bodySize)
          : Buffer.concat(chunks.slice(0, 10), Math.min(bodySize, 10240)); // First 10KB for diagnostics

        const responseText = responseBody.toString('utf8');

        // Extract tokens if present
        let tokens = null;
        try {
          const parsed = JSON.parse(responseText);
          if (parsed.usage) {
            tokens = {
              prompt_tokens: parsed.usage.prompt_tokens || parsed.usage.input_tokens || 0,
              completion_tokens: parsed.usage.completion_tokens || parsed.usage.output_tokens || 0,
              total_tokens: parsed.usage.total_tokens || 0
            };
          }
        } catch {}

        // Record attempt
        attempts.push({
          sequence: i + 1,
          protocol,
          endpoint,
          adapter,
          adapter_conversions: adapterInfo.conversions,
          adapter_stripped: adapterInfo.stripped,
          production_disabled: productionDisabled,
          url: targetUrl,
          status: statusCode,
          error: statusCode >= 400 ? `HTTP ${statusCode}` : undefined,
          error_body: statusCode >= 400 ? responseText.slice(0, 1000) : undefined,
          latency_ms: latencyMs,
          tokens,
          streaming: response.headers['content-type']?.includes('stream')
        });

        // Check if successful
        if (statusCode >= 200 && statusCode < 300) {
          succeeded = true;
          successResponse = {
            statusCode,
            headers: response.headers,
            body: responseBody
          };
          break;
        }

        // Check if should fallback
        const { fallback, reason } = shouldFallbackToNextProtocol(statusCode, responseText);
        attempts[attempts.length - 1].fallback_reason = reason;

        if (!fallback || i === sequence.length - 1) {
          // Don't fallback or this is the last attempt
          break;
        }

        // Continue to next protocol
      } else {
        // type === 'retry' (network error, timeout, etc.)
        attempts.push({
          sequence: i + 1,
          protocol,
          endpoint,
          adapter,
          adapter_conversions: adapterInfo.conversions,
          adapter_stripped: adapterInfo.stripped,
          production_disabled: productionDisabled,
          url: targetUrl,
          status: result.statusCode || 0,
          error: result.reason || 'network error',
          latency_ms: latencyMs,
          fallback_reason: 'network_error'
        });

        // Network errors don't fallback
        break;
      }
    } catch (error) {
      attempts.push({
        sequence: i + 1,
        protocol,
        endpoint,
        adapter,
        url: targetUrl,
        status: 0,
        error: error.message,
        latency_ms: now() - attemptStart,
        fallback_reason: 'exception'
      });
      break;
    }
  }

  // Build diagnostics
  const diagnostics = buildDebugAttemptDiagnostics(
    attempts,
    state.debugLock,
    {
      protocol: clientProtocol,
      model: originalModel,
      model_sent: requestedModel
    }
  );

  // Save diagnostics to state for dashboard display
  // Always save diagnostics (success or failure) until explicitly unlocked
  state.debugLock.last_diagnostics = diagnostics;

  // Record to Recent Request Timeline
  rememberRequest(state, {
    method: 'POST',
    path: pathname,
    entry_protocol: clientProtocol,
    debug_lock: true,
    locked_upstream: state.debugLock.upstream,
    upstream: upstream.name,
    model: requestedModel,
    status: succeeded ? successResponse.statusCode : 502,
    succeeded,
    durationMs: now() - startTime,
    attempts: attempts.length,
    final_protocol: succeeded ? diagnostics.succeeded_with.protocol : null
  });

  // Return response
  if (succeeded) {
    // Add debug headers
    addDebugLockHeaders(res, diagnostics);

    // Forward successful response
    res.writeHead(successResponse.statusCode, successResponse.headers);
    res.end(successResponse.body);
    persistStats(state, statsPath);
    return;
  }

  // All attempts failed - return diagnostic response
  persistStats(state, statsPath);

  if (pathname === '/v1/messages') {
    // Anthropic error format
    return anthropicErrorResponse(
      res,
      502,
      'api_error',
      `Debug lock: all protocols failed for upstream '${state.debugLock.upstream}'`,
      { debug_diagnostics: diagnostics }
    );
  } else {
    // OpenAI error format
    return jsonResponse(res, 502, {
      error: {
        message: `Debug lock: all protocols failed for upstream '${state.debugLock.upstream}'`,
        type: 'debug_lock_all_failed',
        upstream: state.debugLock.upstream,
        ...diagnostics
      }
    });
  }
}

function isAdapterEnabledInConfig(protocol, config) {
  if (protocol === 'chat_completions') {
    return config.compatibility?.adapter_mode?.adapters?.chatCompletions === true;
  }
  if (protocol === 'anthropic_messages') {
    return config.compatibility?.adapter_mode?.adapters?.anthropicMessages === true;
  }
  return false;
}

function probeHttp(targetUrl, keyValue, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const startedAt = now();
    let settled = false;
    const chunks = [];
    let bodySize = 0;
    let bodyTooLarge = false;

    const headers = buildProbeHeaders(targetUrl, keyValue, options.authType, options.headers);
    const request = requestOptionsForTarget(targetUrl, 'GET', headers, timeoutMs, options.proxyUrl);

    const handleResponse = (probeRes) => {
      probeRes.on('data', (chunk) => {
        if (bodyTooLarge) return;
        bodySize += chunk.length;
        if (bodySize > 1024 * 1024) {
          bodyTooLarge = true;
          chunks.length = 0;
          bodySize = 0;
          return;
        }
        chunks.push(chunk);
      });
      probeRes.on('end', () => {
        if (settled) return;
        settled = true;
        const body = bodyTooLarge ? '' : decodeHttpBody(chunks, bodySize, probeRes.headers);
        resolve(probeResult(
          probeRes.statusCode || 0,
          now() - startedAt,
          body,
          bodyTooLarge ? 'response body too large' : '',
          probeRes.headers['retry-after'],
          probeRes.headers
        ));
      });
    };

    const probeReq = request.client.request(request.target, request.options, handleResponse);

    probeReq.on('timeout', () => {
      probeReq.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });

    probeReq.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve(probeResult(0, now() - startedAt, '', error.message, undefined, {}));
    });

    probeReq.end();
  });
}

function cleanDebugHeaderObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const headers = {};
  for (const [name, value] of Object.entries(input)) {
    const cleanName = String(name || '').trim();
    const lower = cleanName.toLowerCase();
    if (!cleanName || HOP_BY_HOP_HEADERS.has(lower) || lower === 'host' || lower === 'content-length') continue;
    if (value === undefined || value === null) continue;
    headers[cleanName] = String(value);
  }
  return headers;
}

function normalizeDebugRequestMethod(value) {
  const method = String(value || 'GET').trim().toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method) ? method : 'GET';
}

function joinDebugRequestUrl(baseUrl, pathSuffix) {
  const suffix = String(pathSuffix || '/v1/models').trim() || '/v1/models';
  if (/^https?:\/\//i.test(suffix)) return suffix;
  try {
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
    if (basePath.endsWith('/v1') && suffix.startsWith('/v1/')) {
      return joinUrlPath(baseUrl, suffix.slice('/v1'.length));
    }
  } catch {
    // URL validation happens in the caller.
  }
  return joinUrlPath(baseUrl, suffix);
}

function inferCurlProtocol(targetUrl) {
  try {
    const pathname = new URL(targetUrl).pathname;
    if (pathname.endsWith('/responses')) return 'responses';
    if (pathname.endsWith('/chat/completions')) return 'chat_completions';
    if (pathname.endsWith('/messages')) return 'anthropic';
  } catch {
    // URL validation happens before the request is sent.
  }
  return '';
}

function curlJudgement(result, targetUrl) {
  const statusCode = Number(result.statusCode || 0);
  const advancedCurlRequiredError = advancedCurlRequiredProbeError(result);
  if (advancedCurlRequiredError) {
    return {
      status: 'inconclusive',
      judgement_type: 'wrong_judgement',
      authoritative: false,
      representative: false,
      representative_reason: 'requires_advanced_curl_profile',
      representative_scope: 'none',
      reflects_real_request: false,
      available: null,
      blocks_dispatch: false,
      blocks_exact_request: true,
      blocks_upstream: false,
      evidence: 'advanced_curl_profile_required',
      decision: 'no_state_change',
      effect_scope: 'test_request_only',
      confidence: 'low',
      code: 'requires_advanced_curl_profile',
      scope: 'target_endpoint',
      message: advancedCurlRequiredError
    };
  }
  if (result.error) {
    return {
      status: 'inconclusive',
      judgement_type: 'unknown_judgement',
      authoritative: false,
      representative: null,
      representative_reason: 'no_http_response',
      representative_scope: 'unknown',
      reflects_real_request: false,
      available: null,
      blocks_dispatch: false,
      blocks_exact_request: false,
      blocks_upstream: false,
      evidence: /timeout/i.test(result.error) ? 'transport_timeout' : 'transport_error',
      decision: 'no_state_change',
      effect_scope: 'unknown',
      confidence: 'low',
      code: /timeout/i.test(result.error) ? 'transport_timeout' : 'transport_error',
      scope: 'target_endpoint',
      message: result.error
    };
  }
  if (statusCode >= 200 && statusCode < 300) {
    const protocol = inferCurlProtocol(targetUrl);
    const validationError = protocol ? modelProbeValidationError(result, protocol) : '';
    if (validationError) {
      return {
        status: 'failed',
        judgement_type: 'correct_judgement',
        authoritative: true,
        representative: true,
        representative_reason: 'http_response_matches_exact_request_shape',
        representative_scope: 'exact_request',
        reflects_real_request: true,
        available: false,
        blocks_dispatch: true,
        blocks_exact_request: true,
        blocks_upstream: false,
        evidence: 'invalid_response_shape',
        decision: 'mark_endpoint_unavailable',
        effect_scope: 'endpoint',
        confidence: 'high',
        code: 'invalid_response_shape',
        scope: 'target_endpoint',
        message: validationError
      };
    }
    return {
      status: 'ok',
      judgement_type: 'capability',
      authoritative: true,
      representative: true,
      representative_reason: 'valid_protocol_response',
      representative_scope: 'exact_request',
      reflects_real_request: true,
      available: true,
      blocks_dispatch: false,
      blocks_exact_request: false,
      blocks_upstream: false,
      evidence: 'valid_response_shape',
      decision: 'mark_available',
      effect_scope: 'exact_request',
      confidence: 'high',
      code: 'ok',
      scope: 'target_endpoint',
      message: 'Curl response is a valid result for this exact request shape.'
    };
  }
  if (statusCode === 401 || statusCode === 403) {
    if (responseLooksLikeBrowserChallenge(result) || !providerAuthError(result)) {
      return {
        status: 'inconclusive',
        judgement_type: 'unknown_judgement',
        authoritative: false,
        representative: null,
        representative_reason: responseLooksLikeBrowserChallenge(result) ? 'browser_or_edge_challenge' : 'unrecognized_auth_error_shape',
        representative_scope: 'unknown',
        reflects_real_request: false,
        available: null,
        blocks_dispatch: false,
        blocks_exact_request: false,
        blocks_upstream: false,
        evidence: responseLooksLikeBrowserChallenge(result) ? 'browser_or_edge_challenge' : 'unrecognized_auth_error',
        decision: 'no_state_change',
        effect_scope: 'unknown',
        confidence: 'low',
        code: responseLooksLikeBrowserChallenge(result) ? 'browser_or_edge_challenge' : 'unrecognized_auth_error',
        scope: 'target_endpoint',
        message: responseLooksLikeBrowserChallenge(result)
          ? `HTTP ${statusCode} looks like a browser/edge challenge, not a representative API response.`
          : `HTTP ${statusCode} did not include a recognized provider auth error shape.`
      };
    }
    return {
      status: 'failed',
      judgement_type: 'correct_judgement',
      authoritative: true,
      representative: true,
      representative_reason: 'provider_rejected_same_auth_shape',
      representative_scope: 'exact_request',
      reflects_real_request: true,
      available: false,
      blocks_dispatch: true,
      blocks_exact_request: true,
      blocks_upstream: true,
      evidence: 'auth_rejected',
      decision: 'mark_unavailable',
      effect_scope: 'upstream_auth',
      confidence: 'high',
      code: 'auth_error',
      scope: 'target_endpoint',
      message: `HTTP ${statusCode} authentication/authorization failure for this exact request shape.`
    };
  }
  if (statusCode === 429) {
    return {
      status: 'failed',
      judgement_type: 'correct_judgement',
      authoritative: true,
      representative: true,
      representative_reason: 'provider_rate_limited_same_request_shape',
      representative_scope: 'exact_request',
      reflects_real_request: true,
      available: false,
      blocks_dispatch: true,
      blocks_exact_request: true,
      blocks_upstream: false,
      evidence: 'rate_limited',
      decision: 'temporary_unavailable',
      effect_scope: 'rate_limit',
      confidence: 'high',
      temporary: true,
      code: 'rate_limited',
      scope: 'target_endpoint',
      message: 'The target endpoint is currently rate limited for this request shape.'
    };
  }
  if (statusCode >= 500) {
    return {
      status: 'failed',
      judgement_type: 'correct_judgement',
      authoritative: true,
      representative: true,
      representative_reason: 'provider_server_error_same_request_shape',
      representative_scope: 'exact_request',
      reflects_real_request: true,
      available: false,
      blocks_dispatch: true,
      blocks_exact_request: true,
      blocks_upstream: false,
      evidence: 'server_error',
      decision: 'temporary_unavailable',
      effect_scope: 'upstream_temporary',
      confidence: 'medium',
      temporary: true,
      code: 'server_error',
      scope: 'target_endpoint',
      message: `HTTP ${statusCode} server error for this exact request shape.`
    };
  }
  return {
    status: 'failed',
    judgement_type: 'correct_judgement',
    authoritative: true,
    representative: true,
    representative_reason: 'http_status_matches_exact_request_shape',
    representative_scope: 'exact_request',
    reflects_real_request: true,
    available: false,
    blocks_dispatch: true,
    blocks_exact_request: true,
    blocks_upstream: statusCode !== 404,
    evidence: statusCode === 404 ? 'not_found' : 'unexpected_status',
    decision: statusCode === 404 ? 'mark_endpoint_unavailable' : 'mark_unavailable',
    effect_scope: statusCode === 404 ? 'endpoint' : 'exact_request',
    confidence: 'medium',
    code: statusCode === 404 ? 'not_found' : 'unexpected_status',
    scope: 'target_endpoint',
    message: `HTTP ${statusCode} for this exact request shape.`
  };
}

function runCurlTest(payload = {}, config = {}) {
  return new Promise((resolve) => {
    const startedAt = now();
    const baseUrl = String(payload.base_url || payload.baseUrl || '').trim();
    if (!baseUrl) {
      resolve({ ok: false, error: 'base_url is required', statusCode: 0, latencyMs: 0, headers: {}, body: '' });
      return;
    }

    let targetUrl = '';
    try {
      targetUrl = joinDebugRequestUrl(baseUrl, payload.path || payload.url_path || '/v1/models');
      const parsed = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL protocol must be http or https');
    } catch (error) {
      resolve({ ok: false, error: `invalid target URL: ${error.message}`, statusCode: 0, latencyMs: now() - startedAt, headers: {}, body: '' });
      return;
    }

    const method = normalizeDebugRequestMethod(payload.method);
    const apiKey = String(payload.api_key || payload.apiKey || '').trim();
    const authType = String(payload.auth_type || payload.authType || 'bearer').trim().toLowerCase();
    const bodyText = method === 'GET' || method === 'HEAD'
      ? ''
      : typeof payload.body === 'string'
        ? payload.body
        : payload.body === undefined || payload.body === null
          ? ''
          : JSON.stringify(payload.body);
    const body = Buffer.from(bodyText);
    const timeoutMs = Math.max(1000, Math.min(300000, Number(payload.timeout_ms || payload.timeoutMs || config.server?.request_timeout_ms || 180000)));
    const responseLimitBytes = Math.max(1024, Number(config.server?.max_body_bytes || 50 * 1024 * 1024));
    const extraHeaders = cleanDebugHeaderObject(payload.headers);
    const useCodexCliHeaders = authType === 'codex' || authType === 'codex-cli' || authType === 'codex_cli';
    const headers = useCodexCliHeaders
      ? buildCodexOAuthRequestHeaders(targetUrl, apiKey, body.length > 0 ? { 'content-type': 'application/json' } : {}, extraHeaders)
      : {
          accept: '*/*',
          'user-agent': 'codex-api-pool-dashboard-curl-test/1.0',
          ...extraHeaders
        };
    if (!useCodexCliHeaders) {
      if (apiKey && authType === 'bearer' && !headers.authorization && !headers.Authorization) headers.authorization = `Bearer ${apiKey}`;
      if (apiKey && authType === 'x-api-key' && !headers['x-api-key'] && !headers['X-API-Key']) headers['x-api-key'] = apiKey;
      if (apiKey && authType === 'anthropic') {
        if (!headers['x-api-key'] && !headers['X-API-Key']) headers['x-api-key'] = apiKey;
        if (!headers['anthropic-version'] && !headers['Anthropic-Version']) headers['anthropic-version'] = '2023-06-01';
      }
      if (body.length > 0 && !headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
    }
    if (body.length > 0) headers['content-length'] = String(body.length);

    const request = requestOptionsForTarget(targetUrl, method, headers, timeoutMs);
    let settled = false;
    const chunks = [];
    let bodySize = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      const payload = {
        ok: !result.error && result.statusCode >= 200 && result.statusCode < 400,
        target_url: targetUrl,
        method,
        latency_ms: now() - startedAt,
        status_code: result.statusCode || 0,
        headers: result.headers || {},
        body: result.body || '',
        error: result.error || '',
        response_too_large: Boolean(result.responseTooLarge)
      };
      payload.judgement = curlJudgement({
        statusCode: payload.status_code,
        error: payload.error,
        body: payload.body,
        headers: payload.headers
      }, targetUrl);
      resolve(payload);
    };

    const debugReq = request.client.request(request.target, request.options, (debugRes) => {
      debugRes.on('data', (chunk) => {
        bodySize += chunk.length;
        if (bodySize <= responseLimitBytes) chunks.push(chunk);
      });
      debugRes.on('end', () => {
        const responseTooLarge = bodySize > responseLimitBytes;
        const body = responseTooLarge ? '' : decodeHttpBody(chunks, bodySize, debugRes.headers);
        finish({
          statusCode: debugRes.statusCode || 0,
          headers: debugRes.headers,
          body,
          responseTooLarge,
          error: responseTooLarge ? `response body too large: ${bodySize} > ${responseLimitBytes}` : ''
        });
      });
      debugRes.on('error', (error) => finish({
        statusCode: debugRes.statusCode || 0,
        headers: debugRes.headers,
        body: '',
        error: error.message
      }));
    });

    debugReq.on('timeout', () => {
      debugReq.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    debugReq.on('error', (error) => finish({ statusCode: 0, headers: {}, body: '', error: error.message }));
    debugReq.end(body);
  });
}

function probeChatCompletionsUpstream(upstream, key, config, model) {
  return new Promise((resolve) => {
    const timeoutMs = chatFallbackProbeTimeoutMs(config, Number(config.health?.timeout_ms || 10000));
    const targetUrl = joinUrlPath(upstream.baseUrl, chatCompletionsPathForBaseUrl(upstream.baseUrl));
    const forwardedModel = forwardModelForUpstream(upstream, model);
    const body = buildChatCompletionsPayload(Buffer.from(JSON.stringify({
      model: forwardedModel,
      input: 'ping',
      stream: false,
      max_output_tokens: 8
    })), forwardedModel);
    const headers = buildProbeHeaders(targetUrl, key.value, upstream.probeAuth, upstream.probeHeaders);
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
    const startedAt = now();
    let settled = false;
    const chunks = [];
    let bodySize = 0;
    let bodyTooLarge = false;
    const request = requestOptionsForTarget(targetUrl, 'POST', headers, timeoutMs, upstream.proxyUrl);

    const finish = (statusCode, responseHeaders = {}, error = '') => {
      if (settled) return;
      settled = true;
      const responseBody = bodyTooLarge ? '' : decodeHttpBody(chunks, bodySize, responseHeaders);
      resolve(probeResult(
        statusCode || 0,
        now() - startedAt,
        responseBody,
        bodyTooLarge ? 'response body too large' : error,
        responseHeaders['retry-after'],
        responseHeaders
      ));
    };

    const probeReq = request.client.request(request.target, request.options, (probeRes) => {
      probeRes.on('data', (chunk) => {
        if (bodyTooLarge) return;
        bodySize += chunk.length;
        if (bodySize > 128 * 1024) {
          bodyTooLarge = true;
          chunks.length = 0;
          bodySize = 0;
          return;
        }
        chunks.push(chunk);
      });
      probeRes.on('end', () => finish(probeRes.statusCode || 0, probeRes.headers));
      probeRes.on('error', (error) => finish(probeRes.statusCode || 0, probeRes.headers, error.message));
    });
    probeReq.on('timeout', () => {
      probeReq.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    probeReq.on('error', (error) => finish(0, {}, error.message));
    probeReq.end(body);
  });
}

function probeResponsesUpstream(upstream, key, config, model) {
  return new Promise((resolve) => {
    const timeoutMs = Number(config.health?.timeout_ms || 10000);
    const publicPrefix = normalizePrefix(config.server?.public_prefix || '/v1');
    // Probe the exact URL native Responses traffic forwards to (joinTargetUrl
    // strips public_prefix), so the health verdict matches real routing.
    const targetUrl = joinTargetUrl(upstream.baseUrl, `${publicPrefix}/responses`, publicPrefix);
    const forwardedModel = forwardModelForUpstream(upstream, model);
    const body = Buffer.from(JSON.stringify(codexResponsesProbePayload(forwardedModel)));
    const headers = buildJsonRequestHeaders(targetUrl, key.value, {
      ...codexResponsesProbeIncomingHeaders(),
      ...(upstream.probeHeaders || {})
    });
    headers['content-length'] = body.length;
    const startedAt = now();
    let settled = false;
    const chunks = [];
    let bodySize = 0;
    let bodyTooLarge = false;
    const request = requestOptionsForTarget(targetUrl, 'POST', headers, timeoutMs, upstream.proxyUrl);

    const finish = (statusCode, responseHeaders = {}, error = '') => {
      if (settled) return;
      settled = true;
      const responseBody = bodyTooLarge ? '' : decodeHttpBody(chunks, bodySize, responseHeaders);
      resolve(probeResult(
        statusCode || 0,
        now() - startedAt,
        responseBody,
        bodyTooLarge ? 'response body too large' : error,
        responseHeaders['retry-after'],
        responseHeaders
      ));
    };

    const probeReq = request.client.request(request.target, request.options, (probeRes) => {
      probeRes.on('data', (chunk) => {
        if (bodyTooLarge) return;
        bodySize += chunk.length;
        if (bodySize > 128 * 1024) {
          bodyTooLarge = true;
          chunks.length = 0;
          bodySize = 0;
          return;
        }
        chunks.push(chunk);
      });
      probeRes.on('end', () => finish(probeRes.statusCode || 0, probeRes.headers));
      probeRes.on('error', (error) => finish(probeRes.statusCode || 0, probeRes.headers, error.message));
    });
    probeReq.on('timeout', () => {
      probeReq.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    probeReq.on('error', (error) => finish(0, {}, error.message));
    probeReq.end(body);
  });
}

function probeAnthropicUpstream(upstream, key, config, model) {
  return new Promise((resolve) => {
    const timeoutMs = Number(config.health?.timeout_ms || 10000);
    const targetUrl = joinUrlPath(upstream.baseUrl, anthropicMessagesPathForBaseUrl(upstream.baseUrl));
    const forwardedModel = forwardModelForUpstream(upstream, model);
    const body = Buffer.from(JSON.stringify({
      model: forwardedModel,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 1,
      stream: false
    }));
    const headers = buildProbeHeaders(targetUrl, key.value, 'anthropic', upstream.probeHeaders);
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
    const startedAt = now();
    let settled = false;
    const chunks = [];
    let bodySize = 0;
    let bodyTooLarge = false;
    const request = requestOptionsForTarget(targetUrl, 'POST', headers, timeoutMs, upstream.proxyUrl);

    const finish = (statusCode, responseHeaders = {}, error = '') => {
      if (settled) return;
      settled = true;
      const responseBody = bodyTooLarge ? '' : decodeHttpBody(chunks, bodySize, responseHeaders);
      resolve(probeResult(
        statusCode || 0,
        now() - startedAt,
        responseBody,
        bodyTooLarge ? 'response body too large' : error,
        responseHeaders['retry-after'],
        responseHeaders
      ));
    };

    const probeReq = request.client.request(request.target, request.options, (probeRes) => {
      probeRes.on('data', (chunk) => {
        if (bodyTooLarge) return;
        bodySize += chunk.length;
        if (bodySize > 128 * 1024) {
          bodyTooLarge = true;
          chunks.length = 0;
          bodySize = 0;
          return;
        }
        chunks.push(chunk);
      });
      probeRes.on('end', () => finish(probeRes.statusCode || 0, probeRes.headers));
      probeRes.on('error', (error) => finish(probeRes.statusCode || 0, probeRes.headers, error.message));
    });
    probeReq.on('timeout', () => {
      probeReq.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    probeReq.on('error', (error) => finish(0, {}, error.message));
    probeReq.end(body);
  });
}

function codexOAuthProbePayload(model) {
  return Buffer.from(JSON.stringify({
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hi' }
        ]
      }
    ],
    instructions: CODEX_OAUTH_TEST_INSTRUCTIONS,
    stream: true,
    store: false
  }));
}

function codexOAuthCompactProbeModel(model) {
  const value = String(model || '').trim();
  return value;
}

function codexOAuthCompactProbePayload(model) {
  return Buffer.from(JSON.stringify({
    model: codexOAuthCompactProbeModel(model),
    instructions: 'You are a helpful coding assistant.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: 'Respond with OK.'
      }
    ]
  }));
}

function probeCodexOAuthRequest(upstream, targetUrl, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = now();
    let settled = false;
    const chunks = [];
    let bodySize = 0;
    let bodyTooLarge = false;
    if (/^https:/i.test(targetUrl)) {
      probeHttp2(targetUrl, body, headers, upstream, timeoutMs).then(resolve);
      return;
    }

    const request = requestOptionsForTarget(targetUrl, 'POST', headers, timeoutMs, upstream.proxyUrl);

    const finish = (statusCode, responseHeaders = {}, error = '') => {
      if (settled) return;
      settled = true;
      const responseBody = bodyTooLarge ? '' : decodeHttpBody(chunks, bodySize, responseHeaders);
      resolve(probeResult(
        statusCode || 0,
        now() - startedAt,
        responseBody,
        bodyTooLarge ? 'response body too large' : error,
        responseHeaders['retry-after'],
        responseHeaders
      ));
    };

    const probeReq = request.client.request(request.target, request.options, (probeRes) => {
      probeRes.on('data', (chunk) => {
        if (bodyTooLarge) return;
        bodySize += chunk.length;
        if (bodySize > 128 * 1024) {
          bodyTooLarge = true;
          chunks.length = 0;
          bodySize = 0;
          return;
        }
        chunks.push(chunk);
      });
      probeRes.on('end', () => finish(probeRes.statusCode || 0, probeRes.headers));
      probeRes.on('error', (error) => finish(probeRes.statusCode || 0, probeRes.headers, error.message));
    });

    probeReq.on('timeout', () => {
      probeReq.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });

    probeReq.on('error', (error) => {
      finish(0, {}, error.message);
    });

    probeReq.end(body);
  });
}

function codexOAuthProbeBodyMessage(result) {
  const body = String(result?.body || '').trim();
  if (!body) return '';
  try {
    const json = JSON.parse(body);
    return String(json.detail || json.error?.message || json.error || body).trim().slice(0, 1000);
  } catch {
    return body.slice(0, 1000);
  }
}

function codexOAuthDiagnosticMessage(diagnostics) {
  if (!diagnostics) return '';
  if (diagnostics.compactStatusCode >= 200 && diagnostics.compactStatusCode < 300) {
    const clientNote = diagnostics.oauthClientId && diagnostics.oauthClientId !== CODEX_OAUTH_CLIENT_ID
      ? ` token client_id=${diagnostics.oauthClientId}, expected Codex OAuth client_id=${CODEX_OAUTH_CLIENT_ID}.`
      : '';
    return `Codex /responses returned HTTP ${diagnostics.responsesStatusCode}, but /responses/compact returned HTTP ${diagnostics.compactStatusCode}.${clientNote} This looks like a ChatGPT Web-session token or compact-only token, not a full Codex OAuth upstream token.`;
  }
  if (diagnostics.compactStatusCode) {
    return `Codex /responses returned HTTP ${diagnostics.responsesStatusCode}; compact diagnostic returned HTTP ${diagnostics.compactStatusCode}: ${diagnostics.compactError || 'no compact body'}`;
  }
  return '';
}

async function probeCodexOAuthUpstream(upstream, key, config, model) {
  const timeoutMs = Number(config.health?.timeout_ms || 10000);
  const publicPrefix = normalizePrefix(config.server?.public_prefix || '/v1');
  const probeModel = String(model || config.model_override || '').trim();
  const targetUrl = codexOAuthTargetUrl(upstream.baseUrl, `${publicPrefix}/responses`, publicPrefix);
  const body = codexOAuthProbePayload(probeModel);
  const headers = buildCodexOAuthRequestHeaders(targetUrl, key.value, { 'content-type': 'application/json' }, codexOAuthExtraHeaders(upstream));
  headers['content-length'] = body.length;

  const result = await probeCodexOAuthRequest(upstream, targetUrl, body, headers, timeoutMs);
  if (![401, 403].includes(result.statusCode)) return result;

  const compactTargetUrl = codexOAuthTargetUrl(upstream.baseUrl, `${publicPrefix}/responses/compact`, publicPrefix);
  const compactBody = codexOAuthCompactProbePayload(probeModel);
  const compactHeaders = buildCodexOAuthRequestHeaders(
    compactTargetUrl,
    key.value,
    {
      accept: 'application/json',
      'content-type': 'application/json',
      session_id: 'probe_compact',
      conversation_id: 'probe_compact'
    },
    codexOAuthExtraHeaders(upstream)
  );
  compactHeaders['content-length'] = compactBody.length;
  const compactResult = await probeCodexOAuthRequest(upstream, compactTargetUrl, compactBody, compactHeaders, timeoutMs);
  const compactOk = compactResult.statusCode >= 200 && compactResult.statusCode < 300;
  result.diagnostics = {
    oauthClientId: upstream.oauthClientId || '',
    expectedCodexClientId: CODEX_OAUTH_CLIENT_ID,
    responsesPath: '/responses',
    responsesStatusCode: result.statusCode,
    responsesError: codexOAuthProbeBodyMessage(result),
    compactPath: '/responses/compact',
    compactModel: codexOAuthCompactProbeModel(probeModel),
    compactStatusCode: compactResult.statusCode,
    compactState: classifyHealth(compactResult.statusCode, compactResult.error),
    compactError: compactOk ? '' : compactResult.error || codexOAuthProbeBodyMessage(compactResult)
  };
  return result;
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

function billingConfiguredKey(billingConfig, fallbackKey) {
  if (billingConfig.keyValue) return { value: billingConfig.keyValue, label: 'billing.key' };
  if (billingConfig.keyEnv) return { value: process.env[billingConfig.keyEnv] || '', label: billingConfig.keyEnv };
  return fallbackKey;
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

function setBillingUnavailable(upstream, { checkedAt = new Date().toISOString(), error = 'billing unavailable', keyLabel = null } = {}) {
  upstream.billing = {
    ...emptyBillingState('unavailable', error),
    checkedAt,
    keyLabel
  };
  return upstream.billing;
}

function billingBlockedByHtml(result = {}) {
  const contentType = String(firstHeader(result.headers, ['content-type']) || '').toLowerCase();
  const body = String(result.body || '').slice(0, 12000);
  return (result.statusCode === 200 || result.statusCode === 401 || result.statusCode === 403) && (
    contentType.includes('text/html') ||
    /<html|<!doctype html|cloudflare|cf-ray|cdn-cgi|challenge-platform|just a moment|attention required|login|sign in|signin/i.test(body)
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
    return setBillingUnavailable(upstream, {
      checkedAt,
      error: 'billing key not configured',
      keyLabel: key?.label || null
    });
  }

  const at = now();
  const startDate = billingConfig.startDate || monthStartDateKey(at);
  const endDate = billingConfig.endDate || localDateKey(at);
  const timeoutMs = Number(config.billing?.timeout_ms || config.health?.timeout_ms || 10000);
  const requests = [];
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
    if (!key?.value) {
      return setBillingUnavailable(upstream, {
        checkedAt,
        error: `billing key not configured: ${key?.label || 'billing key'}`,
        keyLabel: key?.label || null
      });
    }
    const result = await probeHttp(request.url, key.value, timeoutMs, {
      authType: billingConfig.auth || upstream.probeAuth,
      headers: billingConfig.headers,
      proxyUrl: upstream.proxyUrl
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
  const firstResult = okResults[0]?.result || firstFailure?.result || results[0]?.result;
  const hasAnyAmount = [billing.balanceAmount, billing.usedAmount, billing.limitAmount].some((value) => value !== null);
  const parseError = parts.find((part) => part?.error)?.error || '';
  const blockedByHtml = !hasAnyAmount && okResults.length === 0 && billingBlockedByHtml(firstResult);
  const okButUnreadable = !hasAnyAmount && okResults.length > 0 && parseError;
  const blockedByOkHtml = okButUnreadable && okResults.some((item) => billingBlockedByHtml(item.result));
  const stateName = hasAnyAmount
    ? 'ok'
    : blockedByHtml || blockedByOkHtml
      ? 'blocked'
      : okButUnreadable
        ? 'unavailable'
        : okResults.length > 0
      ? 'no_amount'
        : billingHttpState(firstResult?.statusCode || 0, firstResult?.error || '');

  upstream.billing = {
    ...upstream.billing,
    state: stateName,
    checkedAt,
    latencyMs: now() - startedAt,
    httpStatus: firstResult?.statusCode || 0,
    error: hasAnyAmount
      ? ''
      : blockedByHtml || blockedByOkHtml
        ? 'billing endpoint returned a browser/Cloudflare challenge instead of API JSON'
        : okButUnreadable
          ? 'billing endpoint returned non-JSON data; balance hidden'
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

async function fetchSupplementalModels(upstream, config, key, timeoutMs, publicPrefix, pathSuffix) {
  let models = upstream.health?.models || [];
  try {
    const modelsUrl = upstream.healthPath
      ? joinDebugRequestUrl(upstream.baseUrl, pathSuffix)
      : joinTargetUrl(upstream.baseUrl, `${publicPrefix}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`, publicPrefix);
    const modelsResult = await probeHttp(modelsUrl, key.value, Math.min(timeoutMs, 5000), {
      authType: upstream.probeAuth,
      headers: upstream.probeHeaders,
      proxyUrl: upstream.proxyUrl
    });
    const extracted = normalizeDiscoveredModelsForUpstream(upstream, extractModels(modelsResult.body));
    if (extracted.length > 0) models = extracted;
  } catch {
    // Model list is supplementary; ignore errors.
  }
  return models;
}

async function safeProbeOneBilling(upstream, config, logger = console) {
  try {
    return await probeOneBilling(upstream, config);
  } catch (error) {
    logger.warn?.(`[billing:${upstream?.name || 'unknown'}] ${error.message}`);
    return setBillingUnavailable(upstream, {
      error: `billing probe failed: ${error.message}`,
      keyLabel: upstream?.keys?.find((item) => Boolean(item.value))?.label || upstream?.keys?.[0]?.label || null
    });
  }
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
  const configuredProbeModel = normalizeProbeModel(config.model_override);
  const probeModel = normalizeProbeModel(options.probeModel || configuredProbeModel);
  const persistHealth = options.persistHealth !== false && probeModel === configuredProbeModel;

  if (!upstream.enabled) {
    const health = { ...upstream.health, state: 'disabled', checkedAt, latencyMs: 0, httpStatus: 0, error: 'upstream disabled', models: upstream.health?.models || [], modelsCount: upstream.health?.modelsCount ?? 0, keyLabel: null, probeModel };
    if (persistHealth) upstream.health = health;
    return health;
  }

  if (!key || !key.value) {
    const health = { state: 'missing_key', checkedAt, latencyMs: 0, httpStatus: 0, error: 'no configured key', models: [], modelsCount: 0, keyLabel: key?.label || null, probeModel };
    if (persistHealth) upstream.health = health;
    return health;
  }

  // Fetch models list early for per-protocol model selection
  const models = await fetchSupplementalModels(upstream, config, key, timeoutMs, publicPrefix, pathSuffix);

  // Select representative model per protocol family
  const claudeModelsList = claudeModels(models);
  const nonClaudeModelsList = nonClaudeModels(models);
  const hasDiscoveredModels = models.length > 0;

  // For anthropic_messages: use probeModel if it's Claude; if models discovered and none are Claude, skip; else use first Claude from list
  const anthropicProbeModel = (probeModel && isClaudeModel(probeModel))
    ? probeModel
    : hasDiscoveredModels
      ? claudeModelsList[0] || ''
      : '';

  // For openai protocols: use probeModel if non-Claude; if models discovered and none are non-Claude, skip; else use first non-Claude from list
  const openaiProbeModel = (probeModel && !isClaudeModel(probeModel))
    ? probeModel
    : hasDiscoveredModels
      ? nonClaudeModelsList[0] || ''
      : '';

  // If no models available for any protocol, return missing_model_override
  if (!anthropicProbeModel && !openaiProbeModel) {
    const health = {
      state: 'missing_model_override',
      checkedAt,
      latencyMs: 0,
      httpStatus: 0,
      error: 'Health Probe requires model_override so it can test the exact active model',
      models,
      modelsCount: models.length,
      keyLabel: key.label,
      probeModel: ''
    };
    if (persistHealth) upstream.health = health;
    const keyHealth = {
      state: 'missing_model_override',
      checkedAt,
      latencyMs: 0,
      httpStatus: 0,
      error: health.error,
      probeModel: ''
    };
    if (persistHealth) key.health = keyHealth;
    return health;
  }

  if (upstream.codexOAuth) {
    const expired = codexOAuthExpired(upstream);
    let result = null;
    if (!expired && options.live === true) {
      result = await probeCodexOAuthUpstream(upstream, key, config, probeModel);
      if (persistHealth) applyQuota(upstream, key, result.headers || {});
    }
    const stateName = expired
      ? 'auth_error'
      : result
        ? classifyModelProbe(result, 'codex_oauth').state
        : 'oauth_ready';
    const bodyMessage = result?.body ? String(result.body).trim().slice(0, 1000) : '';
    const diagnosticMessage = codexOAuthDiagnosticMessage(result?.diagnostics);
    const validationMessage = result ? classifyModelProbe(result, 'codex_oauth').error : '';
    const error = expired
      ? `OAuth access token expired at ${upstream.oauthExpiresAt}`
      : result
        ? diagnosticMessage || validationMessage || result.error || (stateName === 'ok' ? '' : bodyMessage)
        : 'Codex OAuth upstream does not support /models probing; click Test to send a live probe';
    const health = {
      state: stateName,
      checkedAt,
      latencyMs: result?.latencyMs || 0,
      httpStatus: result?.statusCode || 0,
      error,
      diagnostics: result?.diagnostics || undefined,
      models: [],
      modelsCount: 0,
      keyLabel: key.label,
      probeModel: result ? probeModel : ''
    };
    const keyHealth = {
      state: stateName,
      checkedAt,
      latencyMs: result?.latencyMs || 0,
      httpStatus: result?.statusCode || 0,
      error,
      diagnostics: result?.diagnostics || undefined,
      probeModel: result ? probeModel : ''
    };
    if (persistHealth) {
      upstream.health = health;
      key.health = keyHealth;
    }
    if (persistHealth && result) {
      if (stateName === 'ok') {
        upstream.lastError = '';
        upstream.lastStatus = result.statusCode;
      } else {
        // Probe layer is advisory-only: a probe failure must NOT set a cooldown
        // or bump the failure count. Only real Model Interaction Request
        // outcomes gate Selection. Keep lastStatus for dashboard display.
        upstream.lastStatus = result.statusCode;
      }
    }
    return probeHealthDebugPayload(health, result);
  }

  // ── Real model request as primary health check ──
  // Determine probe strategy based on api configuration and existing capabilities
  const api = normalizeUpstreamApi(upstream?.api, upstream?.probe_auth);
  let healthResult = null;
  let stateName = '';
  let healthError = '';
  let healthWarning = '';
  let resolvedMode = '';
  let healthSource = 'probe';

  // Step 1: Progressive protocol discovery based on api configuration
  const shouldRecheckResponses = shouldRecheckProtocolCapability(upstream, 'responses');
  const shouldRecheckChat = shouldRecheckProtocolCapability(upstream, 'chat_completions');
  const shouldRecheckAnthropicMessages = shouldRecheckProtocolCapability(upstream, 'anthropic_messages');

  // Determine which protocols to probe based on configuration
  const shouldProbeOpenAi = api === 'openai' || api === 'both' || !api;
  const shouldProbeAnthropic = api === 'anthropic' || api === 'both';

  // Probe Anthropic Messages if we have a Claude model
  if (shouldProbeAnthropic && anthropicProbeModel) {
    if (shouldRecheckAnthropicMessages || upstream.capabilities?.anthropic_messages?.status !== 'unsupported') {
      const result = await probeAnthropicUpstream(upstream, key, config, anthropicProbeModel);
      if (persistHealth) applyQuota(upstream, key, result.headers || {});
      const classified = classifyModelProbe(result, 'anthropic');
      if (persistHealth) recordProtocolCapabilityProbe(upstream, 'anthropic_messages', result, classified, { checkedAt, model: anthropicProbeModel });
      // Use this for overall health if successful or if we don't have a result yet
      if (classified.state === 'ok' || !healthResult) {
        stateName = classified.state;
        healthResult = result;
        healthError = classified.error || result.error;
      }
    }
  }

  // Probe OpenAI protocols if we have a non-Claude model
  if (shouldProbeOpenAi && openaiProbeModel) {
    const shouldProbeChatOnly = upstream.requestMode === 'chat_completions' ||
      (
        upstream.resolvedRequestMode === 'chat_completions' &&
        !shouldRecheckResponses &&
        !canAttemptNativeResponses('/v1/responses', upstream, openaiProbeModel, {
          nativeResponsesRecheckMs: state.retry.nativeResponsesRecheckMs
        })
      );

    if (shouldProbeChatOnly) {
      if (shouldRecheckChat || upstream.capabilities?.chat_completions?.status !== 'unsupported') {
        const chatResult = await probeChatCompletionsUpstream(upstream, key, config, openaiProbeModel);
        if (persistHealth) applyQuota(upstream, key, chatResult.headers || {});
        const classified = classifyModelProbe(chatResult, 'chat_completions');
        if (persistHealth) recordProtocolCapabilityProbe(upstream, 'chat_completions', chatResult, classified, { checkedAt, model: openaiProbeModel });
        // Use this for overall health if successful or if we don't have a result yet
        if (classified.state === 'ok' || !healthResult) {
          if (classified.state === 'ok' && stateName !== 'ok') {
            stateName = classified.state;
            healthResult = chatResult;
            healthError = '';
            resolvedMode = 'chat_completions';
          } else if (!healthResult) {
            stateName = classified.state;
            healthResult = chatResult;
            healthError = classified.error || chatResult.error;
            resolvedMode = 'chat_completions';
          }
        }
      }
    } else {
      // Try /v1/responses first
      if (shouldRecheckResponses || upstream.capabilities?.responses?.status !== 'unsupported') {
        const responsesResult = await probeResponsesUpstream(upstream, key, config, openaiProbeModel);
        if (persistHealth) applyQuota(upstream, key, responsesResult.headers || {});
        const responsesClassification = classifyModelProbe(responsesResult, 'responses');
        if (persistHealth) recordProtocolCapabilityProbe(upstream, 'responses', responsesResult, responsesClassification, { checkedAt, model: openaiProbeModel });
        const responsesState = responsesClassification.state;

        if (responsesState === 'ok') {
          if (stateName !== 'ok') {
            stateName = 'ok';
            healthResult = responsesResult;
            healthError = '';
            resolvedMode = 'responses';
          }
        } else {
          // /responses failed → try /v1/chat/completions as fallback
          if (shouldRecheckChat || upstream.capabilities?.chat_completions?.status !== 'unsupported') {
            const chatResult = await probeChatCompletionsUpstream(upstream, key, config, openaiProbeModel);
            if (persistHealth) applyQuota(upstream, key, chatResult.headers || {});
            const chatClassification = classifyModelProbe(chatResult, 'chat_completions');
            if (persistHealth) recordProtocolCapabilityProbe(upstream, 'chat_completions', chatResult, chatClassification, { checkedAt, model: openaiProbeModel });
            const chatState = chatClassification.state;

            if (chatState === 'ok' && stateName !== 'ok') {
              stateName = 'ok';
              healthResult = chatResult;
              healthError = '';
              healthWarning = `responses probe ${responsesState}; chat_completions probe ok`;
              resolvedMode = 'chat_completions';
            } else if (!healthResult) {
              const decision = openAiProbeDecision({
                upstream,
                probeModel: openaiProbeModel,
                responsesResult,
                responsesClassification,
                chatResult,
                chatClassification
              });
              stateName = decision.stateName;
              healthResult = decision.healthResult;
              healthError = decision.healthError;
              healthWarning = decision.healthWarning || healthWarning;
              resolvedMode = decision.resolvedMode || resolvedMode;
            }
          } else if (!healthResult) {
            // No chat probe available, use responses result
            stateName = responsesState;
            healthResult = responsesResult;
            healthError = responsesClassification.error || responsesResult.error;
          }
        }
      } else {
        // Responses is unsupported and no recheck due, try chat directly
        if (shouldRecheckChat || upstream.capabilities?.chat_completions?.status !== 'unsupported') {
          const chatResult = await probeChatCompletionsUpstream(upstream, key, config, openaiProbeModel);
          if (persistHealth) applyQuota(upstream, key, chatResult.headers || {});
          const chatClassification = classifyModelProbe(chatResult, 'chat_completions');
          if (persistHealth) recordProtocolCapabilityProbe(upstream, 'chat_completions', chatResult, chatClassification, { checkedAt, model: openaiProbeModel });
          if (chatClassification.state === 'ok' && stateName !== 'ok') {
            stateName = chatClassification.state;
            healthResult = chatResult;
            healthError = '';
            resolvedMode = 'chat_completions';
          } else if (!healthResult) {
            stateName = chatClassification.state;
            healthResult = chatResult;
            healthError = chatClassification.error || chatResult.error;
            if (stateName === 'ok') resolvedMode = 'chat_completions';
          }
        }
      }
    }
  }

  // Fallback: if no real model probe succeeded
  if (!healthResult) {
    healthResult = probeResult(0, 0, '', 'no real model probe is configured for this upstream');
    stateName = 'unexpected_status';
    healthError = healthResult.error;
  }

  if (persistHealth && options.includeBilling) await safeProbeOneBilling(upstream, config);

  // Step 3: Apply resolved request mode
  if (persistHealth && resolvedMode) {
    upstream.resolvedRequestMode = resolvedMode;
  }
  // NOTE: a successful probe intentionally does NOT clear cooldown / failures.
  // Probes are advisory-only; only real Model Interaction Request outcomes
  // (recordSuccess / recordFailure in the proxy path) gate Selection.

  const health = {
    state: stateName,
    source: healthSource,
    checkedAt,
    latencyMs: healthResult.latencyMs,
    httpStatus: healthResult.statusCode,
    error: stateName === 'ok' ? '' : healthError,
    warning: healthWarning,
    models,
    modelsCount: models.length,
    keyLabel: key.label,
    probeModel
  };

  const keyHealth = {
    state: stateName,
    source: healthSource,
    checkedAt,
    latencyMs: healthResult.latencyMs,
    httpStatus: healthResult.statusCode,
    error: stateName === 'ok' ? '' : healthError,
    warning: healthWarning,
    probeModel
  };
  if (persistHealth) {
    upstream.health = health;
    key.health = keyHealth;
  }

  const returnedHealth = probeHealthDebugPayload(health, healthResult);

  if (stateName === 'ok' || stateName === 'models_unsupported' || stateName === 'unexpected_status' || stateName === 'advanced_curl_required' || stateName === 'codex_forward_only') {
    if (persistHealth) {
      upstream.lastError = '';
      upstream.lastStatus = healthResult.statusCode;
    }
    return returnedHealth;
  }

  // Probe layer is advisory-only: a probe failure must NOT set a cooldown or
  // bump the failure count. Only real Model Interaction Request outcomes gate
  // Selection. We keep lastStatus/lastError for dashboard display only.
  if (persistHealth && (stateName === 'auth_error' || stateName === 'rate_limited' || stateName === 'server_error' || stateName === 'network_error' || stateName === 'timeout')) {
    upstream.lastError = healthError || `health ${stateName}`;
    upstream.lastStatus = healthResult.statusCode;
  }

  return returnedHealth;
}

function hasClaudeModel(models) {
  return Array.isArray(models) && models.some((model) => isClaudeModel(model));
}

function mergeModels(...modelLists) {
  return [...new Set(modelLists.flat().filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function claudeModels(models) {
  return (Array.isArray(models) ? models : []).filter((model) => isClaudeModel(model));
}

function nonClaudeModels(models) {
  return (Array.isArray(models) ? models : []).filter((model) => !isClaudeModel(model));
}

function effectiveProbeModelForUpstream(upstream, requestedProbeModel = '', globalModel = '') {
  const explicit = normalizeProbeModel(requestedProbeModel);
  if (explicit) return explicit;
  const fallback = normalizeProbeModel(globalModel);
  if (upstream && isAnthropicUpstream(upstream) && (!fallback || !isClaudeModel(fallback))) {
    return claudeModels(upstream.health?.models || [])[0] || fallback;
  }
  return fallback;
}

async function probeModelsForProtocol(upstream, config, protocol) {
  const healthConfig = config.health || {};
  const publicPrefix = normalizePrefix(config.server?.public_prefix || '/v1');
  const pathSuffix = upstream.healthPath || healthConfig.path || '/models';
  const timeoutMs = Number(healthConfig.timeout_ms || 10000);
  const key = upstream.keys.find((item) => Boolean(item.value)) || upstream.keys[0];
  const checkedAt = new Date().toISOString();

  if (!key || !key.value) {
    return {
      state: 'missing_key',
      checkedAt,
      latencyMs: 0,
      httpStatus: 0,
      error: 'no configured key',
      models: [],
      modelsCount: 0,
      keyLabel: key?.label || null
    };
  }

  const targetUrl = protocol === 'anthropic'
    ? joinUrlPath(upstream.baseUrl, anthropicModelsPathForBaseUrl(upstream.baseUrl))
    : upstream.healthPath
      ? joinDebugRequestUrl(upstream.baseUrl, pathSuffix)
      : joinTargetUrl(upstream.baseUrl, `${publicPrefix}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`, publicPrefix);
  const result = await probeHttp(targetUrl, key.value, timeoutMs, {
    authType: protocol === 'anthropic'
      ? 'anthropic'
      : upstream.probeAuth === 'none'
        ? 'none'
        : 'bearer',
    headers: upstream.probeHeaders,
    proxyUrl: upstream.proxyUrl
  });
  const stateName = classifyHealth(result.statusCode, result.error);
  const rawModels = extractModels(result.body);
  const models = normalizeDiscoveredModelsForUpstream(upstream, rawModels);
  return {
    state: stateName,
    checkedAt,
    latencyMs: result.latencyMs,
    httpStatus: result.statusCode,
    error: result.error,
    models,
    modelsCount: models.length,
    keyLabel: key.label
  };
}

function claudeCheckHealthPayload(health) {
  return {
    state: health?.state || 'unknown',
    checked_at: health?.checkedAt || null,
    latency_ms: health?.latencyMs || 0,
    http_status: health?.httpStatus || 0,
    error: health?.error || '',
    warning: health?.warning || '',
    models: health?.models || [],
    models_count: health?.modelsCount || 0,
    key_label: health?.keyLabel || null
  };
}

function claudeCheckReason({ supportsClaude, claudeOnly, suggestedApi, openAiHealth, anthropicHealth, claude, nonClaude }) {
  if (supportsClaude && claudeOnly) {
    return `Anthropic /v1/models 可用，已发现 ${claude.length} 个 Claude 模型，未发现非 Claude 模型。`;
  }
  if (supportsClaude) {
    return `Anthropic /v1/models 可用，同时发现 ${nonClaude.length} 个非 Claude 模型，建议 api=${suggestedApi}。`;
  }
  if (hasClaudeModel(openAiHealth?.models || [])) {
    return 'OpenAI-compatible /models 列出了 Claude 模型，但 Anthropic /v1/models 未确认可用，未自动判定为 Claude 支持。';
  }
  return `未确认 Claude 支持；Anthropic 探测状态 ${anthropicHealth?.state || 'unknown'}，OpenAI 探测状态 ${openAiHealth?.state || 'unknown'}。`;
}

async function checkClaudeCapability(upstream, config) {
  const [openAiHealth, anthropicHealth] = await Promise.all([
    probeModelsForProtocol(upstream, config, 'openai'),
    probeModelsForProtocol(upstream, config, 'anthropic')
  ]);
  const openAiWorks = openAiHealth.state === 'ok';
  const supportsClaude = anthropicHealth.state === 'ok' && hasClaudeModel(anthropicHealth.models);
  const models = mergeModels(openAiHealth.models || [], anthropicHealth.models || []);
  const claude = claudeModels(models);
  const nonClaude = nonClaudeModels(models);
  const claudeOnly = supportsClaude && claude.length > 0 && nonClaude.length === 0;
  const suggestedApi = supportsClaude
    ? claudeOnly
      ? 'anthropic'
      : openAiWorks
        ? 'both'
        : 'anthropic'
    : openAiWorks
      ? 'openai'
      : null;
  return {
    supports_claude: supportsClaude,
    claude_only: claudeOnly,
    suggested_api: suggestedApi,
    models,
    claude_models: claude,
    non_claude_models: nonClaude,
    openai: claudeCheckHealthPayload(openAiHealth),
    anthropic: claudeCheckHealthPayload(anthropicHealth),
    reason: claudeCheckReason({
      supportsClaude,
      claudeOnly,
      suggestedApi,
      openAiHealth,
      anthropicHealth,
      claude,
      nonClaude
    })
  };
}

async function probeAnthropicModels(upstream, config) {
  if (!upstream.enabled) return null;
  const health = await probeModelsForProtocol(upstream, config, 'anthropic');
  if (health.state !== 'ok' || !hasClaudeModel(health.models)) return null;
  return health;
}

async function maybeAutoDetectApi(config, state, upstreamName, health, options, rebuildState = null) {
  const upstream = state.upstreams.find((item) => item.name === upstreamName);
  if (!upstream) return { health, detectedApi: null };

  const [openAiHealth, anthropicHealth] = await Promise.all([
    probeModelsForProtocol(upstream, config, 'openai'),
    probeModelsForProtocol(upstream, config, 'anthropic')
  ]);

  const openAiWorks = openAiHealth.state === 'ok';
  const supportsClaude = anthropicHealth.state === 'ok' && hasClaudeModel(anthropicHealth.models);
  if (!openAiWorks && !supportsClaude) return { health, detectedApi: null };

  const detectedModels = mergeModels(openAiHealth.models || [], anthropicHealth.models || [], health?.models || []);
  const detectedClaudeOnly = supportsClaude && claudeModels(detectedModels).length > 0 && nonClaudeModels(detectedModels).length === 0;
  const detectedApi = supportsClaude
    ? detectedClaudeOnly
      ? 'anthropic'
      : openAiWorks
        ? 'both'
        : 'anthropic'
    : 'openai';

  const configIndex = (config.upstreams || []).findIndex((item) => item.name === upstreamName);
  if (configIndex >= 0) {
    config.upstreams[configIndex] = {
      ...config.upstreams[configIndex],
      api: detectedApi,
      ...(detectedApi === 'anthropic'
        ? {
            probe_auth: 'anthropic',
            health_path: config.upstreams[configIndex].health_path || '/v1/models'
          }
        : {})
    };
    if (rebuildState) rebuildState();
    else rebuildUpstreams(state, config);
  }

  const detected = state.upstreams.find((item) => item.name === upstreamName);
  let detectedHealth = health;
  if (detected) {
    detectedHealth = await probeOneUpstream(state, detected, config);
    const models = mergeModels(detectedHealth?.models || [], detectedModels);
    detected.health = {
      ...detected.health,
      ...detectedHealth,
      models,
      modelsCount: models.length,
      warning: detectedHealth?.state === 'ok'
        ? detectedHealth.warning || ''
        : `api auto-detected from /models as ${detectedApi}; real model probe ${detectedHealth?.state || 'unknown'}`
    };
  }
  await saveConfig(config, options.configPath);
  return { health: detected?.health || detectedHealth, detectedApi };
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

async function runHealthChecks(state, config, logger = console, probeOptions = {}) {
  const live = probeOptions.live === true;
  if (state.probingPromise) {
    if (live && !state.probingLive) {
      if (!state.pendingLiveProbePromise) {
        const blockingPromise = state.probingPromise;
        const pendingLiveProbePromise = blockingPromise
          .catch(() => {})
          .then(() => {
            if (state.probingPromise === blockingPromise) {
              state.probingPromise = null;
              state.probing = false;
              state.probingLive = false;
            }
            if (state.probingPromise && state.probingLive) return state.probingPromise;
            return runHealthChecks(state, config, logger, probeOptions);
          })
          .finally(() => {
            if (state.pendingLiveProbePromise === pendingLiveProbePromise) state.pendingLiveProbePromise = null;
          });
        state.pendingLiveProbePromise = pendingLiveProbePromise;
      }
      await state.pendingLiveProbePromise;
      return state.lastProbeResults || [];
    }
    await state.probingPromise.catch(() => {});
    return state.lastProbeResults || [];
  }
  const probeResults = [];
  const probingPromise = (async () => {
    const concurrency = Math.max(1, Number(config.health?.concurrency || 4));
    const probeCandidates = state.upstreams.filter((upstream) => upstream.enabled && (live || !upstream.quarantined));
    await mapWithConcurrency(probeCandidates, concurrency, async (upstream) => {
      const health = await probeOneUpstream(state, upstream, config, probeOptions);
      probeResults.push({ upstream: upstream.name, health });
    });
  })();
  state.probingPromise = probingPromise;
  state.probing = true;
  state.probingLive = live;
  try {
    await probingPromise;
    state.lastProbeResults = probeResults;
    return probeResults;
  } catch (error) {
    logger.warn?.(`[health] ${error.message}`);
    state.lastProbeResults = probeResults;
    return probeResults;
  } finally {
    if (state.probingPromise === probingPromise) {
      state.probingPromise = null;
      state.probing = false;
      state.probingLive = false;
    }
  }
}

async function runBillingChecks(state, config, logger = console) {
  if (state.billingProbing) return;
  state.billingProbing = true;
  try {
    const concurrency = Math.max(1, Number(config.billing?.concurrency || 3));
    const upstreams = state.upstreams.filter((upstream) => upstream.enabled && !upstream.quarantined && upstream.billingConfig?.enabled !== false);
    await mapWithConcurrency(upstreams, concurrency, (upstream) => safeProbeOneBilling(upstream, config, logger));
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
  <title>Codex API Pool Console</title>
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
    .shell { position: relative; width: min(1440px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 48px; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: end; margin-bottom: 16px; }
    h1 { font-size: clamp(28px, 3.4vw, 42px); line-height: 1; margin: 0; letter-spacing: 0; }
    .lede { color: var(--muted); font-size: 14px; line-height: 1.6; max-width: 620px; }
    .eyebrow { color: var(--muted); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 8px; }
    .toolbar { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    button, input, select, textarea { font: inherit; }
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
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, .card:focus-visible, .site-link:focus-visible, .metric[role="button"]:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
    .ghost { color: var(--ink); background: transparent; }
    .ui-icon { width: 16px; height: 16px; flex: 0 0 16px; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; fill: none; opacity: .9; }
    button .ui-icon, .site-link .ui-icon { width: 15px; height: 15px; }
    .title-mark { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; margin-right: 8px; border: 1px solid var(--line); border-radius: 7px; color: var(--accent); background: rgba(255,255,255,.52); vertical-align: -7px; }
    .title-mark .ui-icon { width: 15px; height: 15px; }
    .metric-label { display: inline-flex; align-items: center; gap: 6px; }
    .metric-label .ui-icon { width: 14px; height: 14px; color: var(--accent); }
    .diagnostic-label[data-icon] { display: flex; align-items: center; gap: 6px; }
    .diagnostic-label .ui-icon { width: 13px; height: 13px; color: currentColor; }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      backdrop-filter: blur(12px);
      border-radius: 8px;
      box-shadow: 0 18px 48px rgba(31, 45, 39, .1);
    }
    .dashboard-region { margin-top: 12px; }
    .section-head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
    .section-head h2 { margin: 0; font-size: 16px; letter-spacing: 0; }
    .section-head p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.45; max-width: 560px; }
    .top-diagnostic { padding: 16px; }
    .diagnostic-strip { display: grid; grid-template-columns: minmax(168px, .65fr) minmax(260px, 1.35fr) minmax(330px, 1.25fr); gap: 12px; align-items: stretch; margin-bottom: 14px; }
    .diagnostic-strip > div { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.4); padding: 12px 14px; min-width: 0; }
    .diagnostic-state { border-left: 4px solid var(--cold) !important; }
    .diagnostic-strip[data-state="usable"] .diagnostic-state { border-left-color: var(--good) !important; background: rgba(22,136,90,.08); }
    .diagnostic-strip[data-state="degraded"] .diagnostic-state { border-left-color: var(--warn) !important; background: rgba(183,121,8,.1); }
    .diagnostic-strip[data-state="blocked"] .diagnostic-state { border-left-color: var(--bad) !important; background: rgba(180,59,50,.1); }
    .diagnostic-label { display: block; color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 6px; }
    .diagnostic-state b { display: block; font-size: 27px; line-height: 1.05; letter-spacing: 0; }
    .diagnostic-message strong { display: block; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
    .diagnostic-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .diagnostic-meta div { min-width: 0; }
    .diagnostic-meta strong { display: block; font-size: 13px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .summary { display: grid; grid-template-columns: repeat(6, minmax(118px, 1fr)); gap: 10px; }
    .metric { padding: 14px 16px; position: relative; overflow: hidden; border-left: 4px solid var(--accent); }
    .metric b { display: block; font-size: 28px; letter-spacing: 0; line-height: 1.05; }
    .metric span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    .metric[role="button"] { cursor: pointer; border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; background: rgba(255,255,255,.3); }
    .metric[role="button"]:hover { border-color: var(--line-strong); }
    .token-breakdown { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); display: grid; gap: 5px; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .token-breakdown[hidden] { display: none; }
    .token-breakdown div { display: flex; justify-content: space-between; gap: 10px; }
    .token-breakdown strong { color: var(--ink); font-size: 12px; line-height: 1.35; }
    .grid { display: grid; gap: 8px; }
    .workbench-list { display: grid; gap: 8px; }
    .workbench-list[hidden] { display: none; }
    .operations-grid { display: grid; grid-template-areas: "workbench" "tools"; gap: 12px; align-items: start; }
    .operations-main { grid-area: workbench; display: grid; gap: 12px; min-width: 0; align-content: start; }
    .operations-stack { grid-area: tools; display: grid; grid-template-columns: minmax(320px, .7fr) minmax(280px, .45fr) minmax(280px, .45fr); gap: 12px; min-width: 0; align-content: start; }
    .workbench-head, .workbench-row { display: grid; grid-template-columns: minmax(198px, 1.05fr) minmax(96px, .45fr) minmax(300px, 1.6fr) minmax(112px, .55fr) minmax(164px, .72fr) minmax(196px, .72fr); gap: 10px; align-items: center; }
    .workbench-head { padding: 0 12px 2px; color: var(--muted); font-size: 11px; letter-spacing: .11em; text-transform: uppercase; }
    .card { padding: 12px; min-height: 0; animation: rise .35s ease both; cursor: pointer; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
    .workbench-list.stable .card { animation: none; }
    .card:hover { transform: translateY(-1px); border-color: var(--line-strong); box-shadow: 0 16px 42px rgba(31, 45, 39, .13); }
    .card.editing { border-color: rgba(18, 128, 92, .62); box-shadow: 0 0 0 4px var(--glow), 0 18px 48px rgba(31, 45, 39, .1); }
    .card.paused { border-style: dashed; opacity: .76; }
    .card.quarantined { border-style: dashed; border-color: rgba(166,106,5,.42); background: rgba(255,251,239,.68); }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 14px; }
    .name { font-size: 17px; font-weight: 700; letter-spacing: 0; line-height: 1.12; word-break: break-word; }
    .url { color: var(--muted); font-size: 12px; word-break: break-all; margin-top: 5px; }
    .card-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
    .workbench-cell { min-width: 0; display: grid; gap: 5px; }
    .workbench-models-row { grid-column: 1 / -1; display: grid; grid-template-columns: 138px minmax(0, 1fr); gap: 10px; align-items: start; border-top: 1px dashed var(--line); padding-top: 10px; }
    .model-strip-label { color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; padding-top: 7px; }
    .workbench-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .workbench-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mini-line { color: var(--muted); font-size: 12px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mini-line strong { color: var(--ink); font-weight: 700; }
    .signin-state { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 1px; }
    .status-badge { display: inline-flex; align-items: center; gap: 5px; border: 1px solid currentColor; border-radius: 999px; padding: 5px 8px; font-size: 11px; line-height: 1; white-space: nowrap; }
    .status-badge::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; opacity: .72; }
    .availability-readout { display: grid; gap: 6px; margin-top: 2px; }
    .availability-score { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .availability-score strong { color: var(--ink); }
    .availability-bar { height: 7px; border: 1px solid var(--line); border-radius: 999px; background: rgba(23,33,29,.08); overflow: hidden; }
    .availability-bar span { display: block; width: 0; height: 100%; background: var(--good); transition: width .22s ease, background-color .22s ease; }
    .availability-bar.is-warn span { background: var(--warn); }
    .availability-bar.is-bad span { background: var(--bad); }
    .availability-bar.is-cold span { background: var(--cold); }
    .availability-samples { display: grid; grid-template-columns: repeat(25, 3px); grid-auto-flow: row; grid-auto-rows: 7px; gap: 2px; align-items: center; min-height: 16px; }
    .availability-dot { width: 3px; height: 7px; border-radius: 2px; background: var(--good); opacity: .9; }
    .availability-dot.is-failure { background: var(--bad); }
    .availability-dot.is-empty { background: rgba(23,33,29,.13); opacity: 1; }
    .billing-error strong { color: var(--warn); }
    .workbench-action-stack { display: grid; gap: 8px; align-self: stretch; align-content: start; }
    .workbench-confirmed-actions { display: grid; grid-template-columns: 1fr; gap: 8px; padding-bottom: 8px; border-bottom: 1px dashed rgba(166,106,5,.28); }
    .workbench-actions { display: grid; grid-template-columns: repeat(2, minmax(72px, 1fr)); gap: 7px; align-content: start; }
    .probe-model-control { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; align-items: center; }
    .probe-model-control input { min-height: 34px; padding: 7px 9px; font-size: 12px; background: rgba(255,255,255,.5); }
    .probe-model-control button { min-height: 34px; padding: 7px 9px; font-size: 12px; box-shadow: none; white-space: nowrap; }
    .pill { border-radius: 999px; border: 1px solid currentColor; padding: 6px 10px; font-size: 12px; white-space: nowrap; }
    .workbench-actions button, .workbench-actions .site-link, .workbench-confirmed-actions button { width: 100%; min-width: 0; min-height: 34px; padding: 7px 7px; font-size: 12px; box-shadow: none; }
    .workbench-actions .ui-icon, .workbench-confirmed-actions .ui-icon { width: 14px; height: 14px; flex-basis: 14px; }
    .site-link { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 7px 10px; font-size: 12px; text-decoration: none; white-space: nowrap; background: rgba(255,255,255,.46); min-width: 58px; text-align: center; }
    .site-link:hover { background: var(--ink); color: var(--paper); }
    .signin-action { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .signin-action.is-complete { color: var(--good); border-color: rgba(22,136,90,.42); background: rgba(22,136,90,.08); }
    .signin-action.is-off { color: var(--cold); border-color: rgba(49,95,125,.36); background: rgba(49,95,125,.08); }
    .signin-action[disabled] { cursor: default; opacity: .68; transform: none; }
    .signin-toolbar, .workbench-toolbar { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 10px; }
    .workbench-toolbar { align-items: flex-start; flex-wrap: wrap; }
    .workbench-filter-stack { display: grid; gap: 8px; }
    .workbench-filter-line { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .filter-label { color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; min-width: 74px; }
    .signin-filters, .verification-filters { display: flex; gap: 6px; flex-wrap: wrap; }
    .signin-filter, .verification-filter { min-height: 32px; padding: 6px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.32); }
    .signin-filter.active, .verification-filter.active { color: var(--paper); background: var(--ink); border-color: var(--ink); }
    .signin-count { color: var(--muted); font-size: 12px; line-height: 1.35; }
    .verification-dot { font-size: 12px; margin-right: 4px; vertical-align: middle; }
    .verification-dot[data-indicator="green"] { color: #16a34a; }
    .verification-dot[data-indicator="yellow"] { color: #ca8a04; }
    .verification-dot[data-indicator="blue"] { color: #2563eb; }
    .verification-dot[data-indicator="grey"] { color: #9ca3af; }
    .verification-dot[data-indicator="orange"] { color: #ea580c; }
    .verification-dot[data-indicator="red"] { color: #dc2626; }
    .verification-label { font-size: 11px; color: var(--muted); margin-right: 6px; vertical-align: middle; }
    .probe-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .probe-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .probe-inline { grid-column: 1 / -1; display: grid; gap: 8px; border-top: 1px dashed var(--line); padding-top: 10px; cursor: default; }
    .probe-inline[hidden] { display: none; }
    .probe-inline-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; }
    .probe-inline-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
    .probe-inline-title strong { font-size: 12px; line-height: 1.25; }
    .probe-inline-title time { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .probe-inline-grid { display: grid; grid-template-columns: repeat(6, minmax(76px, 1fr)); gap: 8px; }
    .probe-inline-item { border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,.42); padding: 8px 9px; min-width: 0; }
    .probe-inline-item small { display: block; color: var(--muted); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 2px; }
    .probe-inline-item strong { display: block; color: var(--ink); font-size: 13px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .probe-diagnostics { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; align-items: stretch; }
    .probe-diagnostic { border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,.42); padding: 9px 10px; min-width: 0; display: grid; gap: 5px; align-content: start; }
    .probe-diagnostic[data-kind="api"] { border-left: 3px solid var(--cold); }
    .probe-diagnostic[data-kind="upstream"] { border-left: 3px solid var(--warn); }
    .probe-diagnostic[data-kind="raw"] { border-left: 3px solid var(--accent); }
    .probe-diagnostic small { display: block; color: var(--muted); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
    .probe-diagnostic strong { display: block; color: var(--ink); font-size: 12px; line-height: 1.3; overflow-wrap: anywhere; }
    .probe-diagnostic code { display: block; color: var(--ink); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 130px; overflow: auto; border: 1px solid rgba(23,33,29,.08); border-radius: 5px; background: rgba(23,33,29,.035); padding: 7px; }
    .probe-diagnostic .probe-meta { color: var(--muted); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    .claude-site { min-width: 78px; padding: 7px 10px; font-size: 12px; box-shadow: none; color: var(--cold); border-color: rgba(49,95,125,.42); background: rgba(49,95,125,.08); }
    .claude-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .billing-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .billing-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .toggle-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .toggle-site::before { content: none; }
    .toggle-site.is-off { color: var(--paper); background: var(--ink); border-color: var(--ink); }
    .toggle-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .quarantine-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; color: var(--warn); border-color: rgba(166,106,5,.45); background: rgba(166,106,5,.08); }
    .quarantine-site.is-restore { color: var(--good); border-color: rgba(18,128,92,.45); background: rgba(18,128,92,.08); }
    .quarantine-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .quarantine-drawer .section-head { align-items: center; }
    .quarantine-drawer-toggle { min-width: 128px; justify-content: center; }
    .delete-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; color: var(--bad); border-color: rgba(180,59,50,.42); background: rgba(180,59,50,.07); }
    .delete-site:hover { color: var(--paper); background: var(--bad); border-color: var(--bad); }
    .delete-site[disabled] { cursor: wait; opacity: .68; transform: none; }
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
    .keys { display: flex; gap: 6px; flex-wrap: wrap; }
    .key { border: 1px dashed var(--line-strong); border-radius: 7px; padding: 6px 8px; color: var(--muted); font-size: 12px; }
    .key.ok { color: var(--good); background: rgba(22,136,90,.06); }
    .key.warn { color: var(--warn); background: rgba(183,121,8,.08); }
    .key.bad { color: var(--bad); background: rgba(180,59,50,.08); }
    .key.cold { color: var(--cold); background: rgba(49,95,125,.08); }
    .protocols { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 1px; }
    .protocol { border: 1px solid var(--line-strong); border-radius: 7px; padding: 5px 7px; color: var(--muted); font-size: 11px; line-height: 1; }
    .protocol.ok { color: var(--good); background: rgba(22,136,90,.06); }
    .protocol.warn { color: var(--warn); background: rgba(183,121,8,.08); }
    .protocol.bad { color: var(--bad); background: rgba(180,59,50,.08); }
    .protocol.cold { color: var(--cold); background: rgba(49,95,125,.08); }
    form { margin-top: 18px; padding: 18px; display: grid; grid-template-columns: 1fr 1.4fr 1.4fr .55fr .62fr .78fr 1fr 1fr 1fr auto auto; gap: 10px; align-items: end; }
    form .section-head { grid-column: 1 / -1; }
    .form-mode { grid-column: 1 / -1; color: var(--muted); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
    .claude-result { grid-column: 1 / -1; border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,.48); padding: 10px 12px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .claude-result[data-state="supported"] { color: var(--good); border-color: rgba(22,136,90,.34); background: rgba(22,136,90,.07); }
    .claude-result[data-state="only"] { color: var(--cold); border-color: rgba(49,95,125,.34); background: rgba(49,95,125,.08); }
    .claude-result[data-state="unsupported"] { color: var(--warn); border-color: rgba(183,121,8,.34); background: rgba(183,121,8,.08); }
    .claude-card-result { grid-column: 1 / -1; min-width: 0; padding: 7px 9px; text-align: left; overflow-wrap: anywhere; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
    input, select, textarea { width: 100%; min-height: 38px; border: 1px solid var(--line); background: rgba(255,255,255,.62); border-radius: 7px; padding: 9px 11px; color: var(--ink); outline: none; }
    textarea { min-height: 112px; resize: vertical; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-transform: none; letter-spacing: 0; }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
    .toggle-field input { width: 38px; justify-self: start; accent-color: var(--accent); }
    .token-input { width: 180px; }
    .model-panel { padding: 14px; display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 10px; align-items: end; }
    .model-panel label:first-child, .model-panel #modelReadout, .model-panel #compatReadout { grid-column: 1 / -1; }
    .model-readout { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .curl-panel { padding: 16px; display: grid; grid-template-columns: minmax(210px, .85fr) minmax(128px, .38fr) minmax(128px, .38fr) minmax(128px, .38fr); gap: 10px; align-items: end; }
    .curl-panel .section-head, .curl-panel summary, .curl-wide, .curl-result { grid-column: 1 / -1; }
    .curl-panel summary { cursor: pointer; list-style: none; display: flex; justify-content: space-between; gap: 12px; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 2px; }
    .curl-panel summary::-webkit-details-marker { display: none; }
    .curl-summary-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .curl-summary-title h2 { margin: 0; font-size: 16px; letter-spacing: 0; }
    .curl-summary-meta { color: var(--muted); font-size: 12px; line-height: 1.35; text-align: right; }
    .curl-panel[open] .curl-summary-meta { color: var(--accent); }
    .curl-body-grid { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
    .curl-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .curl-result { display: grid; gap: 10px; border-top: 1px solid var(--line); padding-top: 12px; }
    .curl-result[hidden] { display: none; }
    .curl-result-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
    .curl-result-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
    .curl-code { border: 1px solid var(--line); border-radius: 7px; background: rgba(23,33,29,.04); overflow: hidden; min-width: 0; }
    .curl-code strong { display: block; padding: 8px 10px; color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; border-bottom: 1px solid var(--line); }
    .curl-code pre { margin: 0; padding: 10px; max-height: 360px; overflow: auto; color: var(--ink); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .probe-results { padding: 14px; display: grid; gap: 12px; }
    .probe-results[hidden] { display: none; }
    .probe-results-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
    .probe-results-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .probe-results-title h2 { margin: 0; font-size: 15px; letter-spacing: 0; }
    .probe-results-title p { margin: 2px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
    .probe-results-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .probe-results-actions button { min-height: 32px; padding: 6px 9px; font-size: 12px; box-shadow: none; }
    .probe-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
    .probe-summary-item { border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,.46); padding: 8px 10px; min-width: 0; }
    .probe-summary-item span { display: block; color: var(--muted); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
    .probe-summary-item strong { display: block; font-size: 16px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .probe-result-list { display: grid; gap: 7px; max-height: 310px; overflow: auto; }
    .probe-result-row { display: grid; grid-template-columns: minmax(150px, 1fr) 88px repeat(3, minmax(72px, .45fr)); gap: 10px; align-items: start; border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,.42); padding: 9px 10px; font-size: 12px; }
    .probe-result-row strong { overflow-wrap: anywhere; }
    .probe-result-row small { display: block; color: var(--muted); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 2px; }
    .probe-state { display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; border: 1px solid currentColor; padding: 4px 7px; font-size: 11px; line-height: 1; white-space: nowrap; }
    .probe-raw { border: 1px solid var(--line); border-radius: 7px; background: rgba(23,33,29,.04); overflow: hidden; }
    .probe-raw summary { cursor: pointer; list-style: none; padding: 9px 10px; color: var(--muted); font-size: 12px; }
    .probe-raw summary::-webkit-details-marker { display: none; }
    .probe-raw pre { margin: 0; border-top: 1px solid var(--line); padding: 10px; max-height: 260px; overflow: auto; color: var(--ink); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .import-panel { padding: 18px; display: grid; grid-template-columns: minmax(220px, 1fr) minmax(150px, .45fr) minmax(150px, .45fr) auto; gap: 10px; align-items: end; }
    .import-panel .section-head { grid-column: 1 / -1; }
    .requests { padding: 18px; }
    .requests-head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
    .requests-head h2 { margin: 0; font-size: 16px; letter-spacing: 0; }
    .request-list { display: grid; gap: 8px; max-height: 300px; overflow: auto; }
    .request-row { display: grid; grid-template-columns: 1.1fr .9fr 1.2fr 1.2fr .6fr; gap: 10px; align-items: center; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: rgba(255,255,255,.48); font-size: 12px; }
    .request-row strong { font-size: 13px; overflow-wrap: anywhere; }
    .request-row small { color: var(--muted); display: block; letter-spacing: .08em; text-transform: uppercase; }
    .request-row.debug-lock-request { border-left: 3px solid var(--warn); background: rgba(166, 106, 5, 0.08); }
    .models { display: flex; gap: 7px; flex-wrap: wrap; max-height: 142px; overflow: auto; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.42); }
    .model-chip { color: var(--ink); background: rgba(255,255,255,.66); border-color: var(--line); box-shadow: none; padding: 7px 9px; font-size: 12px; line-height: 1.25; max-width: 260px; min-height: 30px; text-align: left; white-space: normal; overflow-wrap: anywhere; }
    .model-chip.active { color: var(--paper); background: var(--ink); border-color: var(--ink); }
    .usage-days { display: flex; gap: 8px; flex-wrap: wrap; max-height: 78px; overflow: auto; }
    .usage-day { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: rgba(255,255,255,.44); color: var(--muted); font-size: 12px; }
    .usage-day strong { color: var(--ink); margin-left: 6px; }
    .usage-history { padding: 18px; }
    .usage-history-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .usage-history-list { display: grid; gap: 8px; }
    .usage-history-day { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.46); overflow: hidden; }
    .usage-history-day summary { cursor: pointer; list-style: none; display: grid; grid-template-columns: minmax(110px, .7fr) repeat(3, minmax(90px, .5fr)) minmax(110px, .6fr); gap: 10px; align-items: center; padding: 11px 12px; }
    .usage-history-day summary::-webkit-details-marker { display: none; }
    .usage-history-day summary span { color: var(--muted); font-size: 12px; }
    .usage-history-day summary strong { display: block; color: var(--ink); font-size: 15px; font-variant-numeric: tabular-nums; }
    .usage-site-list { border-top: 1px solid var(--line); display: grid; gap: 0; }
    .usage-site-row { display: grid; grid-template-columns: minmax(120px, 1fr) repeat(3, minmax(90px, .5fr)); gap: 10px; padding: 8px 12px; border-top: 1px dashed rgba(23,33,29,.12); color: var(--muted); font-size: 12px; }
    .usage-site-row:first-child { border-top: 0; }
    .usage-site-row strong { color: var(--ink); font-variant-numeric: tabular-nums; }
    .statusbar { min-height: 24px; margin-top: 12px; display: flex; justify-content: space-between; gap: 16px; align-items: center; color: var(--muted); font-size: 13px; }
    .toast { min-width: 0; overflow-wrap: anywhere; }
    .last-refresh { flex: 0 0 auto; color: rgba(99,112,107,.82); }
    .empty { padding: 24px; color: var(--muted); }
    @media (max-width: 1240px) { .summary { grid-template-columns: repeat(3, minmax(128px, 1fr)); } .diagnostic-strip, .operations-stack, .probe-diagnostics { grid-template-columns: 1fr; } .workbench-head { display: none; } .workbench-row { grid-template-columns: minmax(210px, 1.2fr) minmax(100px, .5fr) minmax(260px, 1.3fr); } .workbench-action-stack { grid-column: 1 / -1; grid-template-columns: minmax(150px, .3fr) minmax(0, 1fr); align-items: start; } .workbench-confirmed-actions { padding: 0 8px 0 0; border-right: 1px dashed rgba(166,106,5,.28); border-bottom: 0; } .facts { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 760px) { .shell { width: min(100% - 20px, 1440px); padding-top: 16px; } header, .summary, .model-panel, .curl-panel, .curl-body-grid, .curl-result-body, .import-panel, .grid, .workbench-row, .workbench-models-row, .probe-inline-grid, form { grid-template-columns: 1fr; } .diagnostic-meta { grid-template-columns: 1fr; } .toolbar { justify-content: flex-start; } .token-input { width: 100%; } .section-head { align-items: flex-start; flex-direction: column; gap: 6px; } .curl-actions { justify-content: flex-start; } .model-strip-label { padding-top: 0; } .workbench-action-stack { grid-template-columns: 1fr; } .workbench-confirmed-actions { padding: 0 0 8px; border-right: 0; border-bottom: 1px dashed rgba(166,106,5,.28); } .workbench-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); } .usage-history-day summary, .usage-site-row { grid-template-columns: 1fr 1fr; } .request-row, .probe-result-row { grid-template-columns: 1fr; } .probe-results-head { flex-direction: column; } .probe-results-actions { justify-content: flex-start; } .statusbar { align-items: flex-start; flex-direction: column; gap: 6px; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <div class="eyebrow">Management Dashboard</div>
        <h1>Codex API Pool</h1>
        <p class="lede">本地 Operational Console，用于快速诊断 Codex 请求失败、查看 Upstream Runtime State，并执行安全的 Management API 操作。</p>
      </div>
      <div class="toolbar">
        <input id="adminToken" class="token-input" type="password" placeholder="Admin token" autocomplete="off" />
        <button id="refresh" data-icon="refresh">立即刷新</button>
        <button class="ghost" id="probeAll" data-icon="radar">重新探测全部</button>
        <button class="ghost" id="billingAll" data-icon="wallet">刷新余额</button>
      </div>
    </header>

    <section class="top-diagnostic panel dashboard-region" data-dashboard-region="top-diagnostic-bar" aria-labelledby="top-diagnostic-title">
      <div class="section-head">
        <h2 id="top-diagnostic-title"><span class="title-mark" data-icon="gauge"></span>Top Diagnostic Bar</h2>
        <p>API Pool 可用性、Selection 候选、Model Override 和请求失败诊断入口。</p>
      </div>
      <div class="diagnostic-strip" id="poolDiagnostic" data-state="blocked" aria-live="polite">
        <div class="diagnostic-state">
          <span class="diagnostic-label" data-icon="activity">Pool Usability</span>
          <b id="poolUsability">Checking</b>
        </div>
        <div class="diagnostic-message">
          <span class="diagnostic-label" data-icon="alert">Most Likely Reason</span>
          <strong id="diagnosticReason">等待 Management API 状态。</strong>
        </div>
        <div class="diagnostic-meta">
          <div>
            <span class="diagnostic-label" data-icon="route">Selection</span>
            <strong id="selectionCount">0 eligible</strong>
          </div>
          <div>
            <span class="diagnostic-label" data-icon="sliders">Model Override</span>
            <strong id="modelOverrideState">Following request</strong>
          </div>
          <div>
            <span class="diagnostic-label" data-icon="shield">Admin Token</span>
            <strong id="adminTokenState">Checking</strong>
          </div>
        </div>
      </div>
      <div class="summary">
        <div class="metric"><span class="metric-label" data-icon="server">Active</span><b id="total">0</b></div>
        <div class="metric"><span class="metric-label" data-icon="check">Available</span><b id="available">0</b></div>
        <div class="metric"><span class="metric-label" data-icon="heart">Healthy</span><b id="healthy">0</b></div>
        <div class="metric"><span class="metric-label" data-icon="timer">Cooling</span><b id="cooling">0</b></div>
        <div class="metric" id="signinPendingMetric" role="button" tabindex="0" aria-controls="cards">
          <span class="metric-label" data-icon="signin">未签到</span><b id="signinPendingCount">0</b>
        </div>
        <div class="metric" id="totalTokensMetric" role="button" tabindex="0" aria-expanded="false" aria-controls="totalTokenBreakdown">
          <span class="metric-label" data-icon="coins">Tokens</span><b id="totalTokens">0</b>
          <div class="token-breakdown" id="totalTokenBreakdown" hidden>
            <div><span>Input</span><strong id="inputTokens">0</strong></div>
            <div><span>Output</span><strong id="outputTokens">0</strong></div>
            <div><span>Unclassified</span><strong id="unknownTokens">0</strong></div>
          </div>
        </div>
      </div>
    </section>

    <!-- Debug Lock Diagnostics Panel -->
    <section id="debugLockDiagnostics" class="panel top-diagnostic dashboard-region" style="margin-top: 12px; display: none;">
      <div style="padding: 16px;">
        <div class="section-head" style="margin-bottom: 16px;">
          <h2 style="margin: 0; font-size: 16px;">🔒 Debug Lock 诊断信息</h2>
          <p style="margin: 0; color: var(--muted); font-size: 12px;">最近一次 Debug Lock 请求的详细协议尝试记录</p>
        </div>
        <div id="debugLockDiagnosticsContent"></div>
      </div>
    </section>

    <div class="operations-grid dashboard-region">
      <div class="operations-main">
        <section data-dashboard-region="upstream-workbench" aria-labelledby="upstream-workbench-title">
          <div class="section-head">
            <h2 id="upstream-workbench-title"><span class="title-mark" data-icon="server"></span>Upstream Workbench</h2>
            <p>扫描每个 Active Upstream 的 Health State、Cooldown、Usage、Billing、Quota 和安全操作。</p>
          </div>
          <div class="workbench-toolbar">
            <div class="workbench-filter-stack">
              <div class="workbench-filter-line">
                <span class="filter-label">验证层级</span>
                <div class="verification-filters" role="group" aria-label="验证层级筛选">
                  <button class="ghost verification-filter" type="button" data-verification-filter="all">全部</button>
                  <button class="ghost verification-filter" type="button" data-verification-filter="real_verified">真实请求验证</button>
                  <button class="ghost verification-filter" type="button" data-verification-filter="probe_only">一层检测通过</button>
                  <button class="ghost verification-filter" type="button" data-verification-filter="real_pending">可选待真实验证</button>
                  <button class="ghost verification-filter" type="button" data-verification-filter="unavailable">不可用</button>
                </div>
              </div>
              <div class="workbench-filter-line">
                <span class="filter-label">签到状态</span>
                <div class="signin-filters" role="group" aria-label="签到状态筛选">
                  <button class="ghost signin-filter" type="button" data-signin-filter="all">全部</button>
                  <button class="ghost signin-filter" type="button" data-signin-filter="pending">今日未签</button>
                  <button class="ghost signin-filter" type="button" data-signin-filter="completed">今日已签</button>
                  <button class="ghost signin-filter" type="button" data-signin-filter="not_required">无需签到</button>
                </div>
              </div>
            </div>
            <div class="signin-count" id="signinFilterCount"></div>
            <div class="signin-count" id="verificationFilterCount"></div>
          </div>
          <section id="cards" class="workbench-list" aria-label="Upstream Workbench rows"></section>
        </section>

        <section class="quarantine-drawer" data-dashboard-region="quarantine-box" aria-labelledby="quarantine-box-title">
          <div class="section-head">
            <div>
              <h2 id="quarantine-box-title"><span class="title-mark" data-icon="shield"></span>隔离区 <span id="quarantineCount" class="status-badge warn">0</span></h2>
              <p>Quarantined Upstreams 不参与 Selection；可手动测试、刷新余额，并在确认后恢复。</p>
            </div>
            <button id="quarantineToggle" class="ghost quarantine-drawer-toggle" type="button" aria-expanded="false" aria-controls="quarantineCards" data-icon="shield">打开隔离区</button>
          </div>
          <section id="quarantineCards" class="workbench-list" aria-label="Quarantined Upstream rows" hidden></section>
        </section>
      </div>

      <aside class="operations-stack" aria-label="辅助操作">
        <div class="model-panel panel">
          <label>当前模型<select id="modelSelect"><option value="">跟随 Codex 请求</option></select></label>
          <div class="model-readout" id="modelReadout">尚未完成模型探测。</div>
          <label class="toggle-field">Adapter 兼容<input id="compatStrip" type="checkbox" /></label>
          <label class="toggle-field">Anthropic<input id="compatAnthropic" type="checkbox" /></label>
          <label class="toggle-field">Chat<input id="compatChat" type="checkbox" /></label>
          <button class="ghost" id="clearModel" type="button" data-icon="x">清空覆盖</button>
          <div class="model-readout" id="compatReadout">兼容模式未加载。</div>
        </div>
        <section id="probeResults" class="probe-results panel" aria-live="polite" hidden>
          <div class="probe-results-head">
            <div class="probe-results-title">
              <span class="title-mark" data-icon="radar"></span>
              <div>
                <h2 id="probeResultsTitle">测试结果</h2>
                <p id="probeResultsMeta">等待测试完成。</p>
              </div>
            </div>
            <div class="probe-results-actions">
              <button class="ghost" id="copyProbeResults" type="button" data-icon="download">复制 JSON</button>
              <button class="ghost" id="clearProbeResults" type="button" data-icon="x">清空</button>
            </div>
          </div>
          <div id="probeResultsSummary" class="probe-summary"></div>
          <div id="probeResultsList" class="probe-result-list"></div>
          <details class="probe-raw">
            <summary>原始响应 JSON</summary>
            <pre id="probeResultsRaw"></pre>
          </details>
        </section>
        <details class="curl-panel panel" data-dashboard-region="curl-debugger" aria-labelledby="curl-debugger-title">
          <summary>
            <div class="curl-summary-title">
              <span class="title-mark" data-icon="activity"></span>
              <h2 id="curl-debugger-title">Curl Debugger</h2>
            </div>
            <div class="curl-summary-meta">高级原始请求</div>
          </summary>
          <div class="curl-actions">
            <button class="ghost" id="sendCurlTest" type="button" data-icon="play">发送请求</button>
            <button class="ghost" id="copyCurlResult" type="button" data-icon="download" disabled>复制结果</button>
          </div>
          <label>Base URL<input id="curlBaseUrl" placeholder="https://api.example.com" autocomplete="off" /></label>
          <label>Path<input id="curlPath" value="/v1/models" autocomplete="off" /></label>
          <label>Method<select id="curlMethod"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></label>
          <label>Auth<select id="curlAuthType"><option value="bearer">Bearer</option><option value="codex">Codex CLI</option><option value="x-api-key">X-API-Key</option><option value="anthropic">Anthropic</option><option value="none">None</option></select></label>
          <label class="curl-wide">API Key<input id="curlApiKey" type="password" placeholder="sk-..." autocomplete="off" /></label>
          <div class="curl-body-grid">
            <label>Headers JSON<textarea id="curlHeaders" spellcheck="false" placeholder='{"OpenAI-Beta":"responses=experimental"}'></textarea></label>
            <label>Body<textarea id="curlBody" spellcheck="false" placeholder='{"model":"gpt-5.5","input":"hello"}'></textarea></label>
          </div>
          <section id="curlResult" class="curl-result" aria-live="polite" hidden>
            <div id="curlResultSummary" class="curl-result-summary"></div>
            <div class="curl-result-body">
              <div class="curl-code"><strong>Response Headers</strong><pre id="curlResultHeaders"></pre></div>
              <div class="curl-code"><strong>Response Body</strong><pre id="curlResultBody"></pre></div>
            </div>
            <div class="curl-code"><strong>Full Debug JSON</strong><pre id="curlResultRaw"></pre></div>
          </section>
        </details>
      </aside>
    </div>

    <section class="usage-history panel dashboard-region" data-dashboard-region="daily-token-usage" aria-labelledby="daily-token-usage-title">
      <div class="section-head">
        <div>
          <h2 id="daily-token-usage-title"><span class="title-mark" data-icon="chart"></span>Daily Token Usage</h2>
          <p>最近 14 天按本机日期聚合的 input / output / total token，用于每日 0 点后的历史回看。</p>
        </div>
        <div class="usage-history-actions">
          <button class="ghost" id="downloadUsageCsv" type="button" data-icon="download">下载 CSV</button>
          <button class="ghost" id="downloadUsageJson" type="button" data-icon="download">下载 JSON</button>
        </div>
      </div>
      <div id="dailyUsageList" class="usage-history-list"></div>
    </section>

    <section class="requests panel dashboard-region" data-dashboard-region="recent-request-timeline" aria-labelledby="recent-request-timeline-title">
      <div class="requests-head">
        <h2 id="recent-request-timeline-title"><span class="title-mark" data-icon="timeline"></span>Recent Request Timeline</h2>
        <div class="model-readout">原模型 -> 实际模型 -> 上游</div>
      </div>
      <div id="requestList" class="request-list"></div>
    </section>

    <section class="import-panel panel dashboard-region" data-dashboard-region="upstream-importer" aria-labelledby="upstream-importer-title">
      <div class="section-head">
        <h2 id="upstream-importer-title"><span class="title-mark" data-icon="upload"></span>Upstream Importer</h2>
        <p>导入 sub2api、cpa 或通用 JSON，批量生成 Upstream Pool Configuration。</p>
      </div>
      <label>JSON 文件<input id="importFile" type="file" accept=".json,application/json" /></label>
      <label>重复项<select id="importReplace"><option value="false">跳过同名</option><option value="true">替换同名</option></select></label>
      <label>密钥<select id="importSecretMode"><option value="value">保存文件内 key</option><option value="env">只生成 Env</option></select></label>
      <button id="importUpstreams" type="button" data-icon="upload">导入 JSON</button>
    </section>

    <form id="addForm" class="panel dashboard-region" data-dashboard-region="upstream-editor" aria-labelledby="upstream-editor-title">
      <div class="section-head">
        <h2 id="upstream-editor-title"><span class="title-mark" data-icon="edit"></span>Upstream Editor</h2>
        <p>添加或编辑 Upstream Pool Configuration，同时保持 Request Failure Diagnosis 为主。</p>
      </div>
      <div class="form-mode" id="formMode">添加新站点</div>
      <label>名称<input name="name" placeholder="mysite" required /></label>
      <label>Base URL<input name="base_url" placeholder="https://example.com/v1" required /></label>
      <label>签到页<input name="site_url" placeholder="https://example.com" /></label>
      <label>权重<input name="weight" type="number" min="0.1" step="0.1" value="1" /></label>
      <label class="toggle-field">可签到<input name="signin_available" type="checkbox" /></label>
      <label>密钥模式<select name="key_mode"><option value="env">环境变量</option><option value="value">明文 Key</option></select></label>
      <label>Key Env<input name="key_env" placeholder="MYSITE_API_KEY" /></label>
      <label>明文 Key<input name="key_value" type="password" placeholder="sk-..." autocomplete="off" disabled /></label>
      <label>协议声明<select name="protocol_support"><option value="auto">自动判断</option><option value="responses">Responses</option><option value="chat_completions">Chat only</option><option value="anthropic_messages">Messages only</option><option value="responses_chat">Responses + Chat</option><option value="all">All protocols</option></select></label>
      <button class="ghost" id="checkClaude" type="button" data-icon="radar">检测 Claude</button>
      <button id="submitUpstream" type="submit" data-icon="plus">添加站点</button>
      <button class="ghost" id="cancelEdit" type="button" hidden data-icon="x">取消</button>
      <div id="claudeCheckResult" class="claude-result" hidden></div>
    </form>
    <div class="statusbar">
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
      <div id="lastRefresh" class="last-refresh"></div>
    </div>
  </main>

  <script>
    const cards = document.querySelector('#cards');
    const quarantineCards = document.querySelector('#quarantineCards');
    const quarantineCount = document.querySelector('#quarantineCount');
    const quarantineToggle = document.querySelector('#quarantineToggle');
    const toast = document.querySelector('#toast');
    const lastRefresh = document.querySelector('#lastRefresh');
    const modelSelect = document.querySelector('#modelSelect');
    const modelReadout = document.querySelector('#modelReadout');
    const compatStrip = document.querySelector('#compatStrip');
    const compatAnthropic = document.querySelector('#compatAnthropic');
    const compatChat = document.querySelector('#compatChat');
    const compatReadout = document.querySelector('#compatReadout');
    const requestList = document.querySelector('#requestList');
    const dailyUsageList = document.querySelector('#dailyUsageList');
    const adminTokenInput = document.querySelector('#adminToken');
    const upstreamForm = document.querySelector('#addForm');
    const importFile = document.querySelector('#importFile');
    const importReplace = document.querySelector('#importReplace');
    const importSecretMode = document.querySelector('#importSecretMode');
    const importUpstreams = document.querySelector('#importUpstreams');
    const formMode = document.querySelector('#formMode');
    const submitUpstream = document.querySelector('#submitUpstream');
    const cancelEdit = document.querySelector('#cancelEdit');
    const checkClaude = document.querySelector('#checkClaude');
    const claudeCheckResult = document.querySelector('#claudeCheckResult');
    const totalTokensMetric = document.querySelector('#totalTokensMetric');
    const totalTokenBreakdown = document.querySelector('#totalTokenBreakdown');
    const poolDiagnostic = document.querySelector('#poolDiagnostic');
    const poolUsability = document.querySelector('#poolUsability');
    const diagnosticReason = document.querySelector('#diagnosticReason');
    const selectionCount = document.querySelector('#selectionCount');
    const modelOverrideState = document.querySelector('#modelOverrideState');
    const adminTokenState = document.querySelector('#adminTokenState');
    const signinPendingMetric = document.querySelector('#signinPendingMetric');
    const signinPendingCount = document.querySelector('#signinPendingCount');
    const signinFilterCount = document.querySelector('#signinFilterCount');
    const signinFilterButtons = [...document.querySelectorAll('[data-signin-filter]')];
    const verificationFilterCount = document.querySelector('#verificationFilterCount');
    const verificationFilterButtons = [...document.querySelectorAll('[data-verification-filter]')];
    const probeResults = document.querySelector('#probeResults');
    const probeResultsTitle = document.querySelector('#probeResultsTitle');
    const probeResultsMeta = document.querySelector('#probeResultsMeta');
    const probeResultsSummary = document.querySelector('#probeResultsSummary');
    const probeResultsList = document.querySelector('#probeResultsList');
    const probeResultsRaw = document.querySelector('#probeResultsRaw');
    const copyProbeResults = document.querySelector('#copyProbeResults');
    const clearProbeResults = document.querySelector('#clearProbeResults');
    const sendCurlTest = document.querySelector('#sendCurlTest');
    const copyCurlResult = document.querySelector('#copyCurlResult');
    const curlBaseUrl = document.querySelector('#curlBaseUrl');
    const curlPath = document.querySelector('#curlPath');
    const curlMethod = document.querySelector('#curlMethod');
    const curlAuthType = document.querySelector('#curlAuthType');
    const curlApiKey = document.querySelector('#curlApiKey');
    const curlHeaders = document.querySelector('#curlHeaders');
    const curlBody = document.querySelector('#curlBody');
    const curlResult = document.querySelector('#curlResult');
    const curlResultSummary = document.querySelector('#curlResultSummary');
    const curlResultHeaders = document.querySelector('#curlResultHeaders');
    const curlResultBody = document.querySelector('#curlResultBody');
    const curlResultRaw = document.querySelector('#curlResultRaw');
    let editingName = '';
    let upstreamCache = new Map();
    let cardsSignature = null;
    let quarantineCardsSignature = null;
    let modelOptionsSignature = '';
    let latestStatus = null;
    let adminToken = localStorage.getItem('codexPoolAdminToken') || '';
    let signinFilter = localStorage.getItem('codexPoolSigninFilter') || 'all';
    let verificationFilter = localStorage.getItem('codexPoolVerificationFilter') || 'all';
    let quarantineDrawerOpen = localStorage.getItem('codexPoolQuarantineOpen') === 'true';
    let latestProbeResult = null;
    let latestCurlResult = null;
    const upstreamProbeResults = new Map();
    const upstreamProbeModels = new Map();
    const probingUpstreams = new Set();
    const claudeCheckingUpstreams = new Set();
    const claudeCheckResults = new Map();
    const billingUpstreams = new Set();
    const deletingUpstreams = new Set();
    let formClaudeCheck = null;
    adminTokenInput.value = adminToken;

    // Helper functions for usage data
    const today = () => new Date().toISOString().split('T')[0];
    const getTodayUsage = (usage) => {
      if (!usage || !usage.daily) return { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
      return usage.daily[today()] || { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
    };
    const dailyToByDay = (usage) => {
      if (!usage || !usage.daily) return {};
      return Object.fromEntries(
        Object.entries(usage.daily).map(([day, entry]) => [day, entry.total_tokens || 0])
      );
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Debug Lock Mode - Helper Functions
    // ═══════════════════════════════════════════════════════════════════════════

    function isDebugLockActive(status) {
      return Boolean(status?.debug_lock?.enabled);
    }

    function getDebugLockInfo(status) {
      if (!isDebugLockActive(status)) return null;
      const lock = status.debug_lock;
      return {
        upstream: lock.upstream,
        locked_at: lock.locked_at,
        locked_duration_seconds: lock.locked_duration_seconds,
        last_diagnostics: lock.last_diagnostics || null
      };
    }

    function formatDebugLockDuration(seconds) {
      if (seconds === 0) return '0秒';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      const parts = [];
      if (hours > 0) parts.push(\`\${hours}小时\`);
      if (minutes > 0) parts.push(\`\${minutes}分\`);
      if (secs > 0 && hours === 0) parts.push(\`\${secs}秒\`);
      return parts.join('');
    }

    function updateDebugLockDiagnostics(lockInfo) {
      const panel = document.getElementById('debugLockDiagnostics');
      const content = document.getElementById('debugLockDiagnosticsContent');

      if (!lockInfo.last_diagnostics) {
        panel.style.display = 'none';
        return;
      }

      panel.style.display = 'block';
      const diag = lockInfo.last_diagnostics;

      let html = '<div style="margin-bottom: 12px;">';
      html += \`<div style="margin-bottom: 8px; color: var(--muted); font-size: 13px;">\`;
      html += \`客户端协议: <strong>\${esc(diag.client_request?.protocol || 'N/A')}</strong> · \`;
      html += \`请求模型: <strong>\${esc(diag.client_request?.model || 'N/A')}</strong> · \`;
      html += \`发送模型: <strong>\${esc(diag.client_request?.model_sent || 'N/A')}</strong>\`;
      html += '</div>';

      if (diag.succeeded_with) {
        html += \`<div style="padding: 8px; background: rgba(18,128,92,0.1); border-left: 3px solid var(--good); border-radius: 4px;">\`;
        html += \`✅ 成功：协议 <strong>\${esc(diag.succeeded_with.protocol)}</strong>\`;
        if (diag.succeeded_with.adapter) {
          html += \` (使用适配器)\`;
        }
        html += \`</div>\`;
      } else {
        html += \`<div style="padding: 8px; background: rgba(180,59,50,0.1); border-left: 3px solid var(--bad); border-radius: 4px;">\`;
        html += \`❌ 所有协议尝试均失败\`;
        html += \`</div>\`;
      }
      html += '</div>';

      html += \`<div style="margin-bottom: 8px; color: var(--muted); font-size: 12px;">总尝试: \${diag.total_attempts} 次 · 总延迟: \${diag.total_latency_ms}ms</div>\`;

      html += '<div style="display: grid; gap: 8px;">';
      for (const attempt of diag.attempts || []) {
        const isSuccess = attempt.status >= 200 && attempt.status < 300;
        const borderColor = isSuccess ? 'var(--good)' : 'var(--bad)';
        const bgColor = isSuccess ? 'rgba(18,128,92,0.05)' : 'rgba(180,59,50,0.05)';

        html += \`<div style="border: 1px solid var(--line); border-left: 3px solid \${borderColor}; background: \${bgColor}; border-radius: 4px; padding: 12px; font-size: 13px;">\`;
        html += \`<div style="display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: baseline;">\`;

        html += \`<span style="color: var(--muted);">序号:</span><strong>#\${attempt.sequence}</strong>\`;
        html += \`<span style="color: var(--muted);">协议:</span><strong>\${esc(attempt.protocol)}</strong>\`;
        html += \`<span style="color: var(--muted);">端点:</span><code style="font-size: 11px;">\${esc(attempt.endpoint)}</code>\`;
        html += \`<span style="color: var(--muted);">状态:</span><strong style="color: \${isSuccess ? 'var(--good)' : 'var(--bad)'};">\${attempt.status}</strong>\`;
        html += \`<span style="color: var(--muted);">延迟:</span><span>\${attempt.latency_ms}ms</span>\`;

        if (attempt.adapter) {
          html += \`<span style="color: var(--muted);">适配器:</span><span>✅ 已使用\`;
          if (attempt.adapter_conversions?.length) {
            html += \` (\${attempt.adapter_conversions.join(', ')})\`;
          }
          html += '</span>';
        }

        if (attempt.production_disabled) {
          html += \`<span style="color: var(--muted);">生产配置:</span><span style="color: var(--warn);">⚠️ 未启用</span>\`;
        }

        if (attempt.error) {
          html += \`<span style="color: var(--muted);">错误:</span><strong style="color: var(--bad);">\${esc(attempt.error)}</strong>\`;
        }

        if (attempt.fallback_reason) {
          html += \`<span style="color: var(--muted);">回退原因:</span><span>\${esc(attempt.fallback_reason)}</span>\`;
        }

        html += '</div>';

        if (attempt.error_body && attempt.error_body.length > 0) {
          // Try to parse as JSON first
          let errorDisplay = attempt.error_body;
          try {
            const parsed = JSON.parse(attempt.error_body);
            errorDisplay = JSON.stringify(parsed, null, 2);
          } catch {
            // Not JSON, display as-is but truncate
            errorDisplay = attempt.error_body.length > 500 ? attempt.error_body.slice(0, 500) + '...' : attempt.error_body;
          }
          html += \`<details style="margin-top: 8px;"><summary style="cursor: pointer; color: var(--muted); font-size: 12px;">上游错误详情</summary>\`;
          html += \`<pre style="margin: 8px 0 0 0; padding: 8px; background: var(--paper); border-radius: 4px; font-size: 11px; overflow-x: auto; max-height: 300px;">\${esc(errorDisplay)}</pre>\`;
          html += '</details>';
        }

        html += '</div>';
      }
      html += '</div>';

      content.innerHTML = html;
    }

    function isDebugLockRequest(request) {
      return Boolean(request?.debug_lock);
    }

    async function unlockDebugLock() {
      try {
        const response = await fetch('/pool/debug-unlock', {
          method: 'POST',
          headers: authHeaders()
        });
        const result = await response.json();
        if (response.ok) {
          setToast('Debug Lock 已解除');
          await load();
        } else {
          setToast(\`解锁失败: \${result.error || response.status}\`);
        }
      } catch (error) {
        setToast(\`解锁失败: \${error.message}\`);
      }
    }

    function showLockDialog(upstreamName) {
      const confirmed = confirm(\`🔒 Debug Lock Mode\n\n确认将所有请求锁定到 "\${upstreamName}"？\n\n这将绕过正常的selection逻辑，强制路由所有请求到此upstream，用于诊断protocol支持问题。\n\n注意：这会影响所有客户端的请求。\`);
      if (confirmed) {
        lockToUpstream(upstreamName);
      }
    }

    async function lockToUpstream(upstreamName) {
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(upstreamName)}/debug-lock\`, {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({
            respect_model_override: true
          })
        });
        const result = await response.json();
        if (response.ok) {
          setToast(\`已锁定到 \${upstreamName}\`);
          await load();
        } else {
          setToast(\`锁定失败: \${result.error?.message || result.error || response.status}\`);
        }
      } catch (error) {
        setToast(\`锁定失败: \${error.message}\`);
      }
    }

    const authHeaders = () => adminToken ? { authorization: \`Bearer \${adminToken}\` } : {};
    const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    const ICON_PATHS = {
      activity: '<path d="M22 12h-4l-3 7-6-14-3 7H2"></path>',
      alert: '<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"></path>',
      chart: '<path d="M3 3v18h18"></path><path d="M7 15l4-4 3 3 5-7"></path>',
      check: '<path d="M20 6 9 17l-5-5"></path>',
      coins: '<ellipse cx="8" cy="6" rx="5" ry="3"></ellipse><path d="M3 6v6c0 1.7 2.2 3 5 3s5-1.3 5-3V6"></path><path d="M13 9c2.8.1 5 1.4 5 3v6c0 1.7-2.2 3-5 3-2.1 0-3.9-.8-4.6-1.9"></path>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path>',
      edit: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
      external: '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',
      gauge: '<path d="M21 12a9 9 0 1 0-18 0"></path><path d="M12 12l4-4"></path><path d="M8 21h8"></path>',
      heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"></path>',
      lock: '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>',
      pause: '<path d="M10 4H6v16h4V4Z"></path><path d="M18 4h-4v16h4V4Z"></path>',
      play: '<path d="m6 3 14 9-14 9V3Z"></path>',
      plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
      radar: '<path d="M19.1 4.9A10 10 0 1 1 4.9 19.1"></path><path d="M12 12 21 3"></path><path d="M12 8a4 4 0 1 0 4 4"></path><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="M2 12h2"></path><path d="M20 12h2"></path>',
      refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"></path><path d="M3 21v-5h5"></path><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"></path><path d="M21 3v5h-5"></path>',
      route: '<circle cx="6" cy="19" r="3"></circle><circle cx="18" cy="5" r="3"></circle><path d="M8.6 17.4 15.4 6.6"></path>',
      server: '<rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 8h.01"></path><path d="M7 17h.01"></path>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path>',
      signin: '<path d="M15 3h4a2 2 0 0 1 2 2v4"></path><path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path><path d="M21 15v4a2 2 0 0 1-2 2h-4"></path>',
      sliders: '<path d="M4 21v-7"></path><path d="M4 10V3"></path><path d="M12 21v-9"></path><path d="M12 8V3"></path><path d="M20 21v-5"></path><path d="M20 12V3"></path><path d="M2 14h4"></path><path d="M10 8h4"></path><path d="M18 16h4"></path>',
      timer: '<path d="M10 2h4"></path><path d="M12 14l3-3"></path><circle cx="12" cy="14" r="8"></circle>',
      timeline: '<path d="M4 19V5"></path><path d="M4 7h8"></path><path d="M4 12h14"></path><path d="M4 17h10"></path><circle cx="17" cy="7" r="2"></circle><circle cx="20" cy="12" r="2"></circle><circle cx="16" cy="17" r="2"></circle>',
      trash: '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>',
      upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M17 8l-5-5-5 5"></path><path d="M12 3v12"></path>',
      wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"></path><path d="M16 13h.01"></path>',
      x: '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'
    };
    function icon(name, label = '') {
      const path = ICON_PATHS[name] || ICON_PATHS.activity;
      const accessibility = label ? ' role="img" aria-label="' + esc(label) + '"' : ' aria-hidden="true"';
      return '<svg class="ui-icon" viewBox="0 0 24 24"' + accessibility + '>' + path + '</svg>';
    }
    function setButtonLabel(button, iconName, label) {
      if (!button) return;
      button.innerHTML = iconName ? icon(iconName) + esc(label) : esc(label);
    }
    function hydrateStaticIcons(root = document) {
      root.querySelectorAll('[data-icon]').forEach((node) => {
        if (node.firstElementChild?.classList.contains('ui-icon')) return;
        node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon, node.dataset.iconLabel || ''));
      });
    }
    hydrateStaticIcons();
    const setToast = (message) => { toast.textContent = message || ''; };
    const healthValue = (health, snakeName, camelName = snakeName) => health?.[snakeName] ?? health?.[camelName];
    function probeHealthFromResult(item) {
      return item?.health || item || {};
    }
    function probeResultState(result, health) {
      if (result?.probe_status === 'skipped') return 'skipped';
      if (result?.probe_ok === true) return 'ok';
      if (result?.ok === false) return 'failed';
      return health?.state || 'unknown';
    }
    function probeResultRows(payload, mode) {
      if (!payload) return [];
      if (mode === 'one') {
        const health = probeHealthFromResult(payload);
        return [{
          name: payload.upstream || payload.account || payload.name || '当前站点',
          status: probeResultState(payload, health),
          health
        }];
      }
      const upstreams = payload.probe_results || payload.upstreams || payload.result?.upstreams || [];
      return upstreams.map((upstream) => ({
        name: upstream.name || upstream.upstream || 'unknown',
        status: upstream.enabled === false ? 'skipped' : probeResultState(upstream, upstream.health),
        health: upstream.health || {},
        enabled: upstream.enabled
      }));
    }
    function probeDisplayStatus(status, state) {
      if (status === 'running') return '测试中';
      return status || state || 'unknown';
    }
    function probeStatusClass(status, state) {
      if (status === 'ok' || state === 'ok') return 'ok';
      if (status === 'skipped' || status === 'running' || state === 'running') return 'cold';
      return stateClass(state || status || 'unknown');
    }
    function compactProbeText(value, limit = 420) {
      const text = String(value || '').trim();
      if (!text) return '';
      return text.length > limit ? text.slice(0, limit - 1) + '...' : text;
    }
    function probeUpstreamBody(health) {
      const raw = health?.upstream_result?.body || '';
      if (!raw) return '';
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return String(raw);
      }
    }
    function probeUpstreamHeader(health, name) {
      const headers = health?.upstream_result?.headers || {};
      const target = String(name || '').toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === target) return value;
      }
      return '';
    }
    function probeDiagnosticCards(row, fallbackError = '') {
      const health = row?.health || {};
      const upstreamError = health.upstream_error || {};
      const upstreamResult = health.upstream_result || {};
      const apiPoolError = health.api_pool_error || health.error || fallbackError || '';
      const httpStatus = upstreamError.status_code || upstreamResult.status_code || healthValue(health, 'http_status', 'httpStatus');
      const hasUpstreamDiagnostics = upstreamError.message || upstreamError.code || upstreamError.transport_error || upstreamResult.status_code;
      const cards = [];
      if (apiPoolError || health.warning) {
        cards.push({
          kind: 'api',
          label: 'apiPool 错误',
          title: apiPoolError || health.warning,
          meta: health.state ? 'state=' + health.state : ''
        });
      }
      if (hasUpstreamDiagnostics) {
        cards.push({
          kind: 'upstream',
          label: '上游商家错误',
          title: [
            upstreamError.code ? '[' + upstreamError.code + ']' : '',
            upstreamError.message || upstreamError.transport_error || '未解析到上游错误正文'
          ].filter(Boolean).join(' '),
          meta: 'http=' + fmt(httpStatus)
        });
      }
      const body = probeUpstreamBody(health);
      if (body) {
        cards.push({
          kind: 'raw',
          label: '上游原始响应',
          code: compactProbeText(body, 700),
          meta: compactProbeText(probeUpstreamHeader(health, 'content-type'), 120)
        });
      }
      if (cards.length === 0) {
        cards.push({
          kind: 'api',
          label: '测试摘要',
          title: '未返回错误详情',
          meta: health.state ? 'state=' + health.state : ''
        });
      }
      return cards;
    }
    function probeDiagnosticsHtml(row, fallbackError = '') {
      return '<div class="probe-diagnostics">' + probeDiagnosticCards(row, fallbackError).map((card) =>
        '<div class="probe-diagnostic" data-kind="' + esc(card.kind) + '">'
          + '<small>' + esc(card.label) + '</small>'
          + (card.title ? '<strong title="' + esc(card.title) + '">' + esc(compactProbeText(card.title, 260)) + '</strong>' : '')
          + (card.code ? '<code>' + esc(card.code) + '</code>' : '')
          + (card.meta ? '<div class="probe-meta">' + esc(card.meta) + '</div>' : '')
        + '</div>'
      ).join('') + '</div>';
    }
    function rememberInlineProbeRows(rows, { mode, title, responseOk = true, error = '', at = new Date().toISOString() } = {}) {
      rows.forEach((row) => {
        if (!row?.name) return;
        upstreamProbeResults.set(row.name, { ...row, mode, title, responseOk, error, at });
        renderInlineProbeResult(row.name);
      });
    }
    function rememberInlineProbeRunning(name, { mode = 'one', title = '', skipped = false } = {}) {
      if (!name) return;
      const upstream = upstreamCache.get(name) || {};
      const health = {
        ...(upstream.health || {}),
        state: skipped ? 'disabled' : 'running',
        error: skipped ? '站点已停用，跳过测试。' : '测试中',
        warning: ''
      };
      upstreamProbeResults.set(name, {
        name,
        status: skipped ? 'skipped' : 'running',
        health,
        mode,
        title: title || \`\${name} 测试结果\`,
        responseOk: true,
        error: skipped ? '站点已停用，跳过测试。' : '',
        at: new Date().toISOString()
      });
      renderInlineProbeResult(name);
    }
    function rememberAllInlineProbeRunning() {
      upstreamCache.forEach((upstream, name) => {
        rememberInlineProbeRunning(name, {
          mode: 'all',
          title: '全部测试结果',
          skipped: upstream.enabled === false
        });
      });
    }
    function inlineProbeResultBodyHtml(result) {
      if (!result) return '';
      const health = result.health || {};
      const state = health?.state || result.status || 'unknown';
      const status = result.status || state;
      const statusClass = probeStatusClass(status, state);
      const at = result.at ? new Date(result.at).toLocaleTimeString() : '';
      const responseText = result.responseOk === false ? '请求失败' : status === 'running' ? '请求中' : '请求完成';
      return '<div class="probe-inline-head">'
        + '<div class="probe-inline-title"><span class="probe-state ' + statusClass + '">' + esc(probeDisplayStatus(status, state)) + '</span><strong>' + esc(result.title || '测试结果') + '</strong></div>'
        + '<time>' + esc(at ? at + ' · ' + responseText : responseText) + '</time>'
        + '</div>'
        + '<div class="probe-inline-grid">'
        + '<div class="probe-inline-item"><small>Result</small><strong title="' + esc(probeDisplayStatus(status, state)) + '">' + esc(probeDisplayStatus(status, state)) + '</strong></div>'
        + '<div class="probe-inline-item"><small>State</small><strong title="' + esc(state) + '">' + esc(state) + '</strong></div>'
        + '<div class="probe-inline-item"><small>Probe Model</small><strong title="' + esc(result.probe_model || healthValue(health, 'probe_model', 'probeModel') || '') + '">' + esc(result.probe_model || healthValue(health, 'probe_model', 'probeModel') || '') + '</strong></div>'
        + '<div class="probe-inline-item"><small>HTTP</small><strong>' + esc(fmt(healthValue(health, 'http_status', 'httpStatus'))) + '</strong></div>'
        + '<div class="probe-inline-item"><small>Latency</small><strong>' + esc(fmt(healthValue(health, 'latency_ms', 'latencyMs'), 'ms')) + '</strong></div>'
        + '<div class="probe-inline-item"><small>Models</small><strong>' + esc(fmt(healthValue(health, 'models_count', 'modelsCount'))) + '</strong></div>'
        + '</div>'
        + probeDiagnosticsHtml(result, result.error);
    }
    function inlineProbeResultHtml(name) {
      const result = upstreamProbeResults.get(name);
      return '<div class="probe-inline" data-probe-result="' + esc(name) + '"' + (result ? '' : ' hidden') + '>' + inlineProbeResultBodyHtml(result) + '</div>';
    }
    function renderInlineProbeResult(name) {
      const card = workbenchCard(name);
      const node = card?.querySelector('[data-probe-result]');
      if (!node) return;
      const result = upstreamProbeResults.get(name);
      node.hidden = !result;
      node.innerHTML = result ? inlineProbeResultBodyHtml(result) : '';
    }
    function clearInlineProbeResults() {
      upstreamProbeResults.clear();
      [cards, quarantineCards].forEach((container) => {
        container.querySelectorAll('[data-probe-result]').forEach((node) => {
          node.hidden = true;
          node.innerHTML = '';
        });
      });
    }
    function scrollInlineProbeResult(name) {
      const card = workbenchCard(name);
      const node = card?.querySelector('[data-probe-result]');
      if (node && !node.hidden) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function probeSummaryItems(payload, mode, responseOk) {
      if (!payload) return [];
      if (mode === 'one') {
        const health = probeHealthFromResult(payload);
        return [
          ['结果', responseOk ? probeStatusText(payload) : '失败'],
          ['状态', health?.state || 'unknown'],
          ['Probe Model', payload.probe_model || healthValue(health, 'probe_model', 'probeModel') || ''],
          ['HTTP', fmt(healthValue(health, 'http_status', 'httpStatus'))],
          ['延迟', fmt(healthValue(health, 'latency_ms', 'latencyMs'), 'ms')],
          ['模型', fmt(healthValue(health, 'models_count', 'modelsCount'))]
        ];
      }
      const summary = payload.summary || {};
      return [
        ['结果', responseOk ? probeStatusText(payload) : '失败'],
        ['可用', String(summary.ok_count ?? 0) + '/' + String(summary.enabled_count ?? summary.total_count ?? 0)],
        ['失败', fmt(summary.failed_count ?? 0)],
        ['跳过', fmt(summary.skipped_count ?? 0)],
        ['总数', fmt(summary.total_count ?? 0)]
      ];
    }
    function renderProbeResult(payload, { mode, title, responseOk = true, error = '' } = {}) {
      const at = new Date().toISOString();
      latestProbeResult = { mode, title, responseOk, error, payload, at };
      const rows = probeResultRows(payload, mode);
      rememberInlineProbeRows(rows, { mode, title, responseOk, error, at });
      if (mode === 'one') {
        if (rows[0]?.name) scrollInlineProbeResult(rows[0].name);
        return;
      }
      if (!probeResults) return;
      probeResults.hidden = false;
      probeResultsTitle.textContent = title || '测试结果';
      probeResultsMeta.textContent = new Date().toLocaleString() + ' · ' + (responseOk ? '请求完成' : '请求失败') + (error ? ' · ' + error : '');
      probeResultsSummary.innerHTML = probeSummaryItems(payload, mode, responseOk).map(([label, value]) =>
        '<div class="probe-summary-item"><span>' + esc(label) + '</span><strong title="' + esc(value) + '">' + esc(value) + '</strong></div>'
      ).join('');
      probeResultsList.innerHTML = rows.length ? rows.map((row) => {
        const health = row.health || {};
        const state = health?.state || row.status || 'unknown';
        const statusClass = probeStatusClass(row.status, state);
        return '<div class="probe-result-row">'
          + '<div><small>Upstream</small><strong>' + esc(row.name) + '</strong></div>'
          + '<div><small>Result</small><span class="probe-state ' + statusClass + '">' + esc(probeDisplayStatus(row.status, state)) + '</span></div>'
          + '<div><small>State</small><strong>' + esc(state) + '</strong></div>'
          + '<div><small>HTTP</small><strong>' + esc(fmt(healthValue(health, 'http_status', 'httpStatus'))) + '</strong></div>'
          + '<div><small>Latency</small><strong>' + esc(fmt(healthValue(health, 'latency_ms', 'latencyMs'), 'ms')) + '</strong></div>'
          + probeDiagnosticsHtml(row, error)
          + '</div>';
      }).join('') : '<div class="empty">暂无测试明细。</div>';
      probeResultsRaw.textContent = JSON.stringify(latestProbeResult, null, 2);
    }
    function clearProbeResult() {
      latestProbeResult = null;
      clearInlineProbeResults();
      if (!probeResults) return;
      probeResults.hidden = true;
      probeResultsSummary.innerHTML = '';
      probeResultsList.innerHTML = '';
      probeResultsRaw.textContent = '';
    }
    function claudeCheckSummary(result) {
      if (!result) return '';
      const modelCount = result.models?.length || 0;
      const claudeCount = result.claude_models?.length || 0;
      const nonClaudeCount = result.non_claude_models?.length || 0;
      if (result.supports_claude && result.claude_only) {
        return \`支持 Claude，仅发现 Claude 模型（\${claudeCount}/\${modelCount}），建议 api=\${result.suggested_api || 'anthropic'}。\`;
      }
      if (result.supports_claude) {
        return \`支持 Claude，混合模型：Claude \${claudeCount} 个 / 非 Claude \${nonClaudeCount} 个，建议 api=\${result.suggested_api || 'both'}。\`;
      }
      return \`未确认 Claude 支持：\${result.reason || 'Anthropic 探测未发现 Claude 模型。'}\`;
    }
    function renderClaudeCheckResult(result) {
      formClaudeCheck = result || null;
      if (!claudeCheckResult) return;
      if (!result) {
        claudeCheckResult.hidden = true;
        claudeCheckResult.textContent = '';
        claudeCheckResult.dataset.state = '';
        return;
      }
      claudeCheckResult.hidden = false;
      claudeCheckResult.dataset.state = result.supports_claude
        ? result.claude_only ? 'only' : 'supported'
        : 'unsupported';
      claudeCheckResult.textContent = claudeCheckSummary(result) + (result.reason ? \` \${result.reason}\` : '');
    }
    function renderCardClaudeCheck(card, result) {
      const node = card?.querySelector('[data-claude-result]');
      if (!node) return;
      if (!result) {
        node.hidden = true;
        node.textContent = '';
        node.dataset.state = '';
        node.title = '';
        return;
      }
      node.hidden = false;
      node.dataset.state = result.supports_claude
        ? result.claude_only ? 'only' : 'supported'
        : 'unsupported';
      node.textContent = claudeCheckSummary(result);
      node.title = result.reason || '';
    }
    function claudeCardResultHtml(name) {
      const result = claudeCheckResults.get(name);
      if (!result) return '<div class="claude-result claude-card-result" data-claude-result hidden></div>';
      const state = result.supports_claude
        ? result.claude_only ? 'only' : 'supported'
        : 'unsupported';
      return \`<div class="claude-result claude-card-result" data-claude-result data-state="\${state}" title="\${esc(result.reason || '')}">\${esc(claudeCheckSummary(result))}</div>\`;
    }
    function parseOptionalJson(text, label) {
      const raw = String(text || '').trim();
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(\`\${label} 不是合法 JSON：\${error.message}\`);
      }
    }
    function prettyBody(text) {
      const raw = String(text ?? '');
      if (!raw.trim()) return '';
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw;
      }
    }
    function curlSummaryItems(result = {}) {
      const judgement = result.judgement || {};
      return [
        ['HTTP', result.status_code || result.statusCode || 0],
        ['Verdict', judgement.status || (result.ok ? 'ok' : 'failed')],
        ['Judgement', judgement.judgement_type || 'unknown'],
        ['Represents', judgement.representative === false ? 'no' : judgement.representative === true ? 'yes' : 'unknown'],
        ['Evidence', judgement.evidence || 'unknown'],
        ['Decision', judgement.decision || 'unknown'],
        ['Scope', judgement.effect_scope || judgement.scope || 'unknown'],
        ['Authority', judgement.authoritative === false ? 'not authoritative' : 'authoritative'],
        ['Dispatch', judgement.blocks_dispatch ? 'block' : 'ignore'],
        ['Latency', fmt(result.latency_ms || result.latencyMs || 0, 'ms')],
        ['Method', result.method || curlMethod.value],
        ['Target', result.target_url || '—']
      ];
    }
    function renderCurlResult(result, responseOk = true) {
      latestCurlResult = result || null;
      if (!curlResult) return;
      const curlPanel = curlResult.closest('details');
      if (curlPanel) curlPanel.open = true;
      curlResult.hidden = false;
      copyCurlResult.disabled = !latestCurlResult;
      const error = result?.error || '';
      curlResultSummary.innerHTML = curlSummaryItems(result).map(([label, value]) =>
        '<div class="probe-summary-item"><span>' + esc(label) + '</span><strong title="' + esc(value) + '">' + esc(value) + '</strong></div>'
      ).join('') + (error
        ? '<div class="probe-summary-item"><span>Error</span><strong class="' + (responseOk ? 'warn' : 'bad') + '" title="' + esc(error) + '">' + esc(error) + '</strong></div>'
        : '');
      curlResultHeaders.textContent = JSON.stringify(result?.headers || {}, null, 2);
      curlResultBody.textContent = result?.response_too_large
        ? '[response body too large]'
        : prettyBody(result?.body || '');
      curlResultRaw.textContent = JSON.stringify(result || {}, null, 2);
      curlResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function curlPayload() {
      return {
        base_url: curlBaseUrl.value.trim(),
        path: curlPath.value.trim() || '/',
        method: curlMethod.value,
        auth_type: curlAuthType.value,
        api_key: curlApiKey.value.trim(),
        headers: parseOptionalJson(curlHeaders.value, 'Headers JSON'),
        body: curlBody.value
      };
    }
    async function runCurlDebugger() {
      if (!curlBaseUrl.value.trim()) {
        setToast('请填写 Base URL。');
        return;
      }
      let payload;
      try {
        payload = curlPayload();
      } catch (error) {
        renderCurlResult({ ok: false, error: error.message, status_code: 0, headers: {}, body: '' }, false);
        setToast(error.message);
        return;
      }
      sendCurlTest.disabled = true;
      setButtonLabel(sendCurlTest, 'play', '请求中');
      renderCurlResult({ ok: true, method: payload.method, target_url: payload.base_url + payload.path, latency_ms: 0, status_code: 0, headers: {}, body: '', error: '请求中' }, true);
      try {
        const response = await fetch('/pool/test-curl', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        renderCurlResult(result, response.ok);
        setToast(response.ok
          ? \`请求完成：HTTP \${result.status_code}，\${result.latency_ms}ms\`
          : \`请求失败：\${result.error || 'HTTP ' + result.status_code}\`);
      } catch (error) {
        renderCurlResult({ ok: false, error: error.message, status_code: 0, headers: {}, body: '' }, false);
        setToast(\`请求失败：\${error.message}\`);
      } finally {
        sendCurlTest.disabled = false;
        setButtonLabel(sendCurlTest, 'play', '发送请求');
      }
    }
    function formClaudePayload() {
      const form = new FormData(upstreamForm);
      const upstreamName = editingName || String(form.get('name') || '').trim();
      const payload = {
        name: upstreamName,
        base_url: form.get('base_url'),
        site_url: form.get('site_url'),
        weight: Number(form.get('weight') || 1),
        signin_available: Boolean(form.get('signin_available')),
        replace: Boolean(editingName)
      };
      const keyMode = String(form.get('key_mode') || 'env');
      const keyValue = String(form.get('key_value') || '').trim();
      const keyEnv = String(form.get('key_env') || '').trim();
      if (keyMode === 'value') {
        if (keyValue) payload.keys = [{ value: keyValue }];
      } else {
        payload.keys = [{ env: keyEnv || String(upstreamName).toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY' }];
      }
      const declaredCapabilities = declaredCapabilitiesForSupport(String(form.get('protocol_support') || 'auto'));
      if (declaredCapabilities) payload.protocol_capabilities = declaredCapabilities;
      return payload;
    }
    function applyClaudeSuggestion(payload) {
      if (!formClaudeCheck?.supports_claude || !formClaudeCheck.suggested_api) return payload;
      payload.api = formClaudeCheck.suggested_api;
      if (formClaudeCheck.suggested_api === 'anthropic') {
        payload.probe_auth = 'anthropic';
        payload.health_path = '/v1/models';
      }
      return payload;
    }
    function confirmAddUpstream(payload) {
      if (payload.replace) return true;
      const keyMode = payload.keys?.[0]?.value ? '明文 Key' : '环境变量';
      return window.confirm([
        '确认添加这个上游？',
        '',
        \`名称：\${payload.name}\`,
        \`Base URL：\${payload.base_url}\`,
        \`密钥模式：\${keyMode}\`,
        '确认后会写入 Upstream Pool Configuration，并立即执行探测。'
      ].join('\\n'));
    }
    function protocolSupportValue(upstream = {}) {
      const capabilities = upstream.capabilities || {};
      const assumed = (name) => capabilities[name]?.source === 'user_declared' && capabilities[name]?.status === 'assumed';
      const disabled = (name) => capabilities[name]?.source === 'user_declared' && capabilities[name]?.status === 'disabled';
      if (assumed('responses') && assumed('chat_completions') && assumed('anthropic_messages')) return 'all';
      if (assumed('responses') && assumed('chat_completions')) return 'responses_chat';
      if (assumed('responses') && disabled('chat_completions')) return 'responses';
      if (assumed('chat_completions') && disabled('responses')) return 'chat_completions';
      if (assumed('anthropic_messages') && disabled('responses') && disabled('chat_completions')) return 'anthropic_messages';
      return 'auto';
    }
    function declaredCapabilitiesForSupport(value) {
      if (value === 'responses') return { responses: 'assumed', chat_completions: 'disabled' };
      if (value === 'chat_completions') return { responses: 'disabled', chat_completions: 'assumed' };
      if (value === 'anthropic_messages') return { responses: 'disabled', chat_completions: 'disabled', anthropic_messages: 'assumed' };
      if (value === 'responses_chat') return { responses: 'assumed', chat_completions: 'assumed', anthropic_messages: 'disabled' };
      if (value === 'all') return { responses: 'assumed', chat_completions: 'assumed', anthropic_messages: 'assumed' };
      return null;
    }
    const stateClass = (state) => {
      if (state === 'ok') return 'ok';
      if (state === 'models_unsupported' || state === 'unexpected_status' || state === 'unsupported' || state === 'no_amount' || state === 'rate_limited' || state === 'blocked') return 'warn';
      if (state === 'unknown' || state === 'disabled' || state === 'advanced_curl_required' || state === 'codex_forward_only') return 'cold';
      return 'bad';
    };
    // Localized health-state label for the workbench pill. Keeps the raw
    // English state in tooltips/data-attributes for diagnostics while showing
    // a calm Chinese label to operators.
    const HEALTH_STATE_LABELS = {
      ok: '正常',
      missing_key: '缺 Key',
      missing_model_override: '缺 Model',
      stale_model_override: 'Model 过期',
      auth_error: '认证失败',
      rate_limited: '限流',
      server_error: '服务异常',
      network_error: '网络错误',
      timeout: '超时',
      disabled: '已禁用',
      oauth_ready: '待 OAuth',
      inconclusive: '不确定',
      models_unsupported: '模型不支持',
      unsupported: '不支持',
      advanced_curl_required: '需高级 curl',
      codex_forward_only: '仅 Codex',
      unexpected_status: '异常状态',
      blocked: '受限',
      no_amount: '无额度',
      unknown: '未知'
    };
    const healthStateLabel = (state) => HEALTH_STATE_LABELS[state] || state || '未知';
    const capabilityClass = (status) => {
      if (status === 'verified') return 'ok';
      if (status === 'assumed' || status === 'skipped') return 'warn';
      if (status === 'unknown' || status === 'disabled') return 'cold';
      return 'bad';
    };
    const capabilityLabels = {
      responses: 'Responses',
      chat_completions: 'Chat',
      anthropic_messages: 'Messages'
    };
    const capabilityOrder = ['responses', 'chat_completions', 'anthropic_messages'];
    function capabilityTitle(name, capability = {}) {
      const parts = [
        capabilityLabels[name] || name,
        capability.status || 'unknown',
        capability.source ? 'source=' + capability.source : '',
        capability.probe_type ? 'probe=' + capability.probe_type : '',
        capability.http_status ? 'HTTP ' + capability.http_status : '',
        capability.model ? 'model=' + capability.model : '',
        capability.reason || ''
      ].filter(Boolean);
      return parts.join(' · ');
    }
    // Distinguish evidence source so a probe-verified capability is not
    // confused with real-traffic verification. Mirrors the Verification Tier
    // split (一层检测通过 vs 真实请求验证).
    const capabilitySourceSuffix = (capability = {}) => {
      if (capability.status !== 'verified') return '';
      if (capability.source === 'probe') return ' (探针)';
      if (capability.source === 'real_traffic') return ' (真实)';
      return '';
    };
    function protocolCapabilitiesHtml(upstream) {
      const capabilities = upstream.capabilities || {};
      return '<div class="protocols" data-field="protocol_capabilities">'
        + capabilityOrder.map((name) => {
          const capability = capabilities[name] || {};
          const status = capability.status || 'unknown';
          const declaredTag = capability.source === 'user_declared' ? ' (声明)'
            : capability.source === 'config' ? ' (配置)' : '';
          return '<span class="protocol ' + capabilityClass(status) + '" title="' + esc(capabilityTitle(name, capability)) + '">'
            + esc(capabilityLabels[name] || name) + ': ' + esc(status) + esc(capabilitySourceSuffix(capability)) + esc(declaredTag)
            + '</span>';
        }).join('')
        + '</div>';
    }
    function requestProtocolLabel(item = {}) {
      return item.short_label || item.label || item.type || item.protocol || 'Unknown';
    }
    function requestInterfaceSupportsLabel(info = {}) {
      const supported = Array.isArray(info.supported) ? info.supported : [];
      if (supported.length > 0) return supported.map(requestProtocolLabel).join(', ');
      if (info.verified) return Object.values(info.verified).map(requestProtocolLabel).join(', ') || 'Pending Verification';
      return info.label && info.label !== 'Model Dependent' ? info.label : 'Pending Verification';
    }
    function requestInterfaceUsingLabel(info = {}) {
      return requestProtocolLabel(info.using || { label: 'Not Learned' });
    }
    function requestProtocolTitle(prefix, item = {}) {
      return [
        prefix + ' ' + (item.label || item.short_label || item.type || item.protocol || 'Unknown'),
        item.path || '',
        item.status ? 'status=' + item.status : '',
        item.source ? 'source=' + item.source : '',
        item.model ? 'model=' + item.model : '',
        item.http_status ? 'HTTP ' + item.http_status : '',
        item.checked_at ? 'checked=' + item.checked_at : '',
        item.reason || ''
      ].filter(Boolean).join(' ');
    }
    function requestInterfaceLabel(upstream) {
      const info = upstream?.request_interface || {};
      return 'Supports: ' + requestInterfaceSupportsLabel(info) + ' · Using: ' + requestInterfaceUsingLabel(info);
    }
    function requestInterfaceTitle(upstream) {
      const info = upstream?.request_interface || {};
      const supported = Array.isArray(info.supported)
        ? info.supported.map((item) => requestProtocolTitle('Supports', item)).join(' | ')
        : '';
      const using = info.using ? requestProtocolTitle('Using', info.using) : '';
      const verified = info.verified ? Object.values(info.verified).map((item) => requestProtocolTitle('Verified', item)).join(' | ') : '';
      return [
        info.label || 'Pending Verification',
        info.path || '',
        info.source ? 'source=' + info.source : '',
        info.configured_mode ? 'configured=' + info.configured_mode : '',
        info.resolved_mode ? 'resolved=' + info.resolved_mode : '',
        info.model ? 'model=' + info.model : '',
        info.http_status ? 'HTTP ' + info.http_status : '',
        info.checked_at ? 'checked=' + info.checked_at : '',
        supported,
        using,
        verified
      ].filter(Boolean).join(' · ');
    }
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
    function fmtToken(value) {
      return value === null || value === undefined || value === '' ? '—' : compactNumber(value);
    }
    function fullToken(value) {
      return value === null || value === undefined || value === '' ? '—' : fullNumber(value);
    }
    function tokenTitle(label, value) {
      return \`\${label}: \${fullToken(value)} tokens\`;
    }
    function tokenBreakdownText(usage = {}) {
      const total = Number(usage.total_tokens || usage.tokens || 0);
      const input = Number(usage.input_tokens || usage.inputTokens || 0);
      const output = Number(usage.output_tokens || usage.outputTokens || 0);
      const unknown = Math.max(0, total - input - output);
      return { total, input, output, unknown };
    }
    function updateTokenBreakdown(usage = {}) {
      const tokens = tokenBreakdownText(usage);
      document.querySelector('#totalTokens').textContent = fmtToken(tokens.total);
      document.querySelector('#inputTokens').textContent = fmtToken(tokens.input);
      document.querySelector('#outputTokens').textContent = fmtToken(tokens.output);
      document.querySelector('#unknownTokens').textContent = fmtToken(tokens.unknown);
      totalTokensMetric.title = \`Total \${fullToken(tokens.total)} · Input \${fullToken(tokens.input)} · Output \${fullToken(tokens.output)} · Unclassified \${fullToken(tokens.unknown)}\`;
    }
    function dailyEntry(usage = {}, day = '') {
      const entry = usage.daily?.[day];
      if (entry && typeof entry === 'object') {
        return {
          total: Number(entry.total_tokens || entry.totalTokens || 0),
          input: Number(entry.input_tokens || entry.inputTokens || 0),
          output: Number(entry.output_tokens || entry.outputTokens || 0)
        };
      }
      return {
        total: 0,
        input: 0,
        output: 0
      };
    }
    function dailyUsageRows(data = {}, ups = []) {
      const days = new Set(Object.keys(data.usage?.daily || {}));
      for (const upstream of ups) {
        Object.keys(upstream.usage?.daily || {}).forEach((day) => days.add(day));
      }
      return [...days].sort((a, b) => b.localeCompare(a)).slice(0, 14).map((day) => {
        const total = dailyEntry(data.usage || {}, day);
        const sites = ups.map((upstream) => ({
          name: upstream.name,
          ...dailyEntry(upstream.usage || {}, day)
        })).filter((site) => site.total || site.input || site.output)
          .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
        return { day, total, sites };
      }).filter((row) => row.total.total || row.sites.length);
    }
    function renderDailyUsage(data = {}, ups = []) {
      const rows = dailyUsageRows(data, ups);
      dailyUsageList.innerHTML = rows.length ? rows.map((row, index) => \`
        <details class="usage-history-day" \${index === 0 ? 'open' : ''}>
          <summary>
            <span>Date<strong>\${esc(row.day)}</strong></span>
            <span>Total<strong title="\${esc(tokenTitle('Total', row.total.total))}">\${fmtToken(row.total.total)}</strong></span>
            <span>Input<strong title="\${esc(tokenTitle('Input', row.total.input))}">\${fmtToken(row.total.input)}</strong></span>
            <span>Output<strong title="\${esc(tokenTitle('Output', row.total.output))}">\${fmtToken(row.total.output)}</strong></span>
            <span>Sites<strong>\${row.sites.length}</strong></span>
          </summary>
          <div class="usage-site-list">
            \${row.sites.map((site) => \`
              <div class="usage-site-row">
                <span>\${esc(site.name)}</span>
                <span>Total <strong title="\${esc(tokenTitle('Total', site.total))}">\${fmtToken(site.total)}</strong></span>
                <span>Input <strong title="\${esc(tokenTitle('Input', site.input))}">\${fmtToken(site.input)}</strong></span>
                <span>Output <strong title="\${esc(tokenTitle('Output', site.output))}">\${fmtToken(site.output)}</strong></span>
              </div>
            \`).join('')}
          </div>
        </details>
      \`).join('') : '<div class="empty">暂无每日 token 历史。</div>';
    }
    async function downloadUsage(format) {
      const endpoint = format === 'json' ? '/pool/usage/daily.json' : '/pool/usage/daily.csv';
      try {
        const response = await fetch(endpoint, { headers: authHeaders() });
        if (!response.ok) {
          const text = await response.text();
          setToast(\`下载失败：\${text || response.status}\`);
          return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = format === 'json' ? 'codex-api-pool-daily-usage.json' : 'codex-api-pool-daily-usage.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setToast(\`每日 token \${format.toUpperCase()} 已下载。\`);
      } catch (error) {
        setToast(\`下载失败：\${error.message}\`);
      }
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
    function billingAmountText(upstream, field) {
      return unlimitedBilling(upstream, field) ? '不限' : fmtMoney(upstream.billing?.[\`\${field}_amount\`], upstream.billing?.currency);
    }
    function billingAmountTitle(upstream, field) {
      return unlimitedBilling(upstream, field)
        ? '上游返回占位/不限额上限，无法计算精确余额'
        : fullMoney(upstream.billing?.[\`\${field}_amount\`], upstream.billing?.currency);
    }
    function billingAmountSize(upstream, field) {
      return unlimitedBilling(upstream, field) ? 'normal' : moneySize(upstream.billing?.[\`\${field}_amount\`], upstream.billing?.currency);
    }
    const quotaReqValue = (upstream) => upstream.quota?.requestsRemaining || upstream.quota?.quotaRemaining || '';
    const quotaTokValue = (upstream) => upstream.quota?.tokensRemaining || '';
    const canSignin = (upstream) => Boolean(upstream.signin_available);
    const signinCompleted = (upstream) => Boolean(upstream.signin_completed);
    const signinStatusValue = (upstream) => upstream.signin_status || (canSignin(upstream) ? (signinCompleted(upstream) ? 'completed' : 'pending') : 'not_required');
    const signinCompletedLabel = (upstream) => signinStatusValue(upstream) === 'completed' ? '今日已签到' : signinStatusValue(upstream) === 'pending' ? '今日未签到' : '无需签到';
    const signinCompletedClass = (upstream) => signinStatusValue(upstream) === 'completed' ? 'ok' : signinStatusValue(upstream) === 'pending' ? 'warn' : 'cold';
    const signinPending = (upstream) => signinStatusValue(upstream) === 'pending';
    const signinFilterLabels = {
      all: '全部',
      pending: '今日未签',
      completed: '今日已签',
      not_required: '无需签到'
    };
    const verificationTierLabels = {
      real_verified: '真实流量验证',
      probe_only: '探测验证',
      real_pending: '未验证',
      unavailable: '不可用'
    };
    const verificationFilterLabels = {
      all: '全部',
      real_verified: verificationTierLabels.real_verified,
      probe_only: verificationTierLabels.probe_only,
      real_pending: verificationTierLabels.real_pending,
      unavailable: verificationTierLabels.unavailable
    };
    if (!signinFilterLabels[signinFilter]) signinFilter = 'all';
    if (!verificationFilterLabels[verificationFilter]) verificationFilter = 'all';
    const signinFilterMatches = (upstream) => signinFilter === 'all' || signinStatusValue(upstream) === signinFilter;

    // Inline verification tier logic (from verification-tier.mjs)
    const PROTOCOL_CAPABILITY_NAMES = ['responses', 'chat_completions', 'anthropic_messages'];
    function deriveVerificationTier(upstream) {
      if (!upstream || !upstream.capabilities) {
        return 'not_verified';
      }

      const capabilities = upstream.capabilities;
      let hasProbeVerified = false;

      for (const protocol of PROTOCOL_CAPABILITY_NAMES) {
        const capability = capabilities[protocol];
        if (!capability || capability.status !== 'verified') {
          continue;
        }

        if (capability.source === 'real_traffic') {
          return 'proven_by_traffic';
        }

        if (capability.source === 'probe') {
          hasProbeVerified = true;
        }
      }

      return hasProbeVerified ? 'proven_by_probe' : 'not_verified';
    }

    // Map a verification detail tier to the 4 dashboard filter buckets.
    const VERIFICATION_TIER_TO_FILTER = {
      proven_by_traffic: 'real_verified',
      proven_by_probe: 'probe_only',
      real_pending: 'real_pending',
      unavailable: 'unavailable'
    };
    function verificationDetail(upstream) {
      // Prefer the server-precomputed detail (canonical decision flowchart).
      if (upstream?.verification_detail?.tier) return upstream.verification_detail;
      // Inline fallback (kept for back-compat if the field is absent).
      const tier = deriveVerificationTier(upstream);
      if (tier === 'proven_by_traffic') return { tier: 'proven_by_traffic', indicator: 'green', label: '真实请求验证' };
      if (tier === 'proven_by_probe') return { tier: 'proven_by_probe', indicator: 'yellow', label: '一层检测通过' };
      if (upstream?.enabled === false) return { tier: 'unavailable', indicator: 'grey', label: '已禁用' };
      if (upstream?.quarantined) return { tier: 'unavailable', indicator: 'orange', label: '已隔离' };
      return { tier: 'real_pending', indicator: 'blue', label: '待验证' };
    }
    function verificationTier(upstream) {
      return VERIFICATION_TIER_TO_FILTER[verificationDetail(upstream).tier] || 'real_pending';
    }
    const verificationFilterMatches = (upstream) => verificationFilter === 'all' || verificationTier(upstream) === verificationFilter;
    function setSigninFilter(nextFilter) {
      signinFilter = signinFilterLabels[nextFilter] ? nextFilter : 'all';
      localStorage.setItem('codexPoolSigninFilter', signinFilter);
      cardsSignature = null;
      load();
    }
    function setVerificationFilter(nextFilter) {
      verificationFilter = verificationFilterLabels[nextFilter] ? nextFilter : 'all';
      localStorage.setItem('codexPoolVerificationFilter', verificationFilter);
      cardsSignature = null;
      load();
    }
    function updateWorkbenchFilterControls(allItems = [], visibleItems = []) {
      const pendingCount = allItems.filter(signinPending).length;
      signinPendingCount.textContent = pendingCount;
      signinPendingMetric.title = pendingCount ? \`\${pendingCount} 个站点今日未签到\` : '今日没有待签到站点';
      signinFilterButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.signinFilter === signinFilter);
        button.setAttribute('aria-pressed', String(button.dataset.signinFilter === signinFilter));
      });
      verificationFilterButtons.forEach((button) => {
        const key = button.dataset.verificationFilter || 'all';
        const count = key === 'all' ? allItems.length : allItems.filter((upstream) => verificationTier(upstream) === key).length;
        button.classList.toggle('active', key === verificationFilter);
        button.setAttribute('aria-pressed', String(key === verificationFilter));
        button.title = key === 'all' ? \`全部 \${count} 个 Upstream\` : \`\${verificationFilterLabels[key]}：\${count} 个 Upstream\`;
      });
      const signinText = signinFilter === 'all' ? '签到：全部' : \`签到：\${signinFilterLabels[signinFilter]}\`;
      const verificationText = verificationFilter === 'all' ? '验证：全部' : \`验证：\${verificationFilterLabels[verificationFilter]}\`;
      signinFilterCount.textContent = \`\${verificationText}；\${signinText}\`;
      verificationFilterCount.textContent = \`显示 \${visibleItems.length} / \${allItems.length} 个 Upstream\`;
    }
    function signinBadgeHtml(upstream) {
      const available = canSignin(upstream);
      return \`
        <div class="signin-state">
          <span class="status-badge \${available ? 'ok' : 'cold'}" data-field="signin_available" title="\${available ? '配置标记为可签到' : '配置标记为不可签到'}">\${available ? '可签到' : '不可签到'}</span>
          <span class="status-badge \${signinCompletedClass(upstream)}" data-field="signin_completed" title="\${available ? '今日签到完成状态' : '该站点当前标记为不可签到'}">\${signinCompletedLabel(upstream)}</span>
        </div>\`;
    }
    function numeric(value, fallback = 0) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
      const fallbackNumber = Number(fallback);
      return Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
    }
    function enabledBucket(upstream) {
      return upstream.enabled ? 0 : 1;
    }
    function stableOrderIndex(upstream, fallback) {
      return numeric(upstream.config_index, fallback);
    }
    const sortedUpstreams = (items) => [...items]
      .map((upstream, index) => ({ upstream, index }))
      .sort((a, b) => (
        enabledBucket(a.upstream) - enabledBucket(b.upstream) ||
        stableOrderIndex(a.upstream, a.index) - stableOrderIndex(b.upstream, b.index) ||
        String(a.upstream.name).localeCompare(String(b.upstream.name))
      ))
      .map(({ upstream }) => upstream);
    function availabilityPercent(upstream) {
      const rate = upstream.availability?.rate;
      return Number.isFinite(rate) ? \`\${(rate * 100).toFixed(1)}%\` : '—';
    }
    function availabilityClass(upstream) {
      const rate = upstream.availability?.rate;
      const samples = Number(upstream.availability?.samples || 0);
      const minSamples = Number(upstream.availability?.min_samples || 10);
      if (!Number.isFinite(rate) || samples < minSamples) return 'is-cold';
      if (rate >= 0.9) return 'is-good';
      if (rate >= 0.75) return 'is-warn';
      return 'is-bad';
    }
    function availabilityTitle(upstream) {
      const availability = upstream.availability || {};
      return \`Recent availability: \${availabilityPercent(upstream)} · \${availability.successes || 0}/\${availability.samples || 0} successes · multiplier \${fmt(availability.multiplier)} · selection weight \${fmt(upstream.selection_weight)} · selection score \${fmt(upstream.selection_score)}\`;
    }
    function availabilityHtml(upstream) {
      const availability = upstream.availability || {};
      const samples = Number(availability.samples || 0);
      const windowSize = Number(availability.window_size || 50);
      const rate = Number.isFinite(availability.rate) ? availability.rate : 0;
      const percent = Math.max(0, Math.min(100, rate * 100));
      const history = typeof availability.recent === 'string'
        ? availability.recent.slice(-windowSize).split('').map(c => c === '1')
        : (Array.isArray(availability.recent) ? availability.recent.slice(-windowSize) : []);
      const emptyCount = Math.max(0, windowSize - history.length);
      const dots = [
        ...history.map((ok) => \`<span class="availability-dot \${ok ? 'is-success' : 'is-failure'}"></span>\`),
        ...Array.from({ length: emptyCount }, () => '<span class="availability-dot is-empty"></span>')
      ].join('');
      return \`
        <div class="availability-readout" title="\${esc(availabilityTitle(upstream))}">
          <div class="availability-score"><strong data-field="availability_rate">\${availabilityPercent(upstream)}</strong><span data-field="availability_samples">\${samples}/\${windowSize}</span></div>
          <div class="availability-bar \${availabilityClass(upstream)}" aria-hidden="true"><span data-field="availability_bar" style="width:\${percent}%"></span></div>
          <div class="availability-samples" data-field="availability_history" aria-hidden="true">\${dots}</div>
        </div>\`;
    }
    function representativeTemplateLabel(data) {
      const template = data?.representative_templates?.responses?.codex_desktop;
      if (!template) return 'missing';
      return template.fresh ? 'fresh' : 'stale';
    }
    const upstreamMatchesModelFamily = (upstream, model) => {
      if (!model) return true;
      const value = String(model || '').toLowerCase();
      const api = String(upstream.api || 'openai').toLowerCase();
      if (value.includes('claude')) return api === 'anthropic' || api === 'both';
      if (upstream.codex_oauth) return value.startsWith('gpt-');
      return api === 'openai' || api === 'both';
    };
    const hasConfiguredKey = (upstream) => (upstream.keys || []).some((key) => key.configured);
    const isHardHealthFailure = (upstream) => ['auth_error', 'rate_limited', 'server_error', 'network_error', 'timeout', 'missing_key', 'models_unsupported', 'unexpected_status'].includes(upstream.health?.state || '');
    function requestFailureText(request) {
      if (!request || request.outcome === 'ok') return '';
      if (request.error_display?.title || request.error_display?.message) {
        return [
          request.error_display.title || '',
          request.error_display.message || '',
          request.error_display.action || ''
        ].filter(Boolean).join(': ');
      }
      const upstream = request.upstream ? ' on ' + request.upstream : '';
      const status = request.status ? 'HTTP ' + request.status : 'request failed';
      const reason = request.reason ? ': ' + request.reason : '';
      return 'Latest request failed' + upstream + ': ' + status + reason;
    }
    function likelyDiagnosticReason(ups, activeModel, eligible, latestFailure) {
      const enabled = ups.filter((upstream) => upstream.enabled);
      const active = enabled.filter((upstream) => !upstream.quarantined);
      const quarantined = enabled.filter((upstream) => upstream.quarantined);
      const available = active.filter((upstream) => upstream.available);
      const cooling = active.filter((upstream) => upstream.cooldown_ms > 0);
      const missingKeys = active.filter((upstream) => !hasConfiguredKey(upstream));
      const disabled = ups.filter((upstream) => !upstream.enabled);
      const modelFamilyExcluded = activeModel
        ? available.filter((upstream) => !upstreamMatchesModelFamily(upstream, activeModel))
        : [];
      const hardFailures = active.filter(isHardHealthFailure);
      if (ups.length === 0) return 'Blocked: no Upstreams configured.';
      if (enabled.length === 0) return 'Blocked: all Upstreams are Disabled.';
      if (active.length === 0 && quarantined.length > 0) return 'Blocked: all Active Upstreams are in Quarantine.';
      if (eligible.length === 0 && missingKeys.length === active.length) return 'Blocked: no configured Upstream Keys are available.';
      if (eligible.length === 0 && modelFamilyExcluded.length > 0) return 'Blocked: Model Override ' + activeModel + ' is incompatible with available Upstream protocol families.';
      if (eligible.length === 0 && cooling.length > 0) return 'Blocked: all Selection candidates are in Cooldown.';
      if (eligible.length === 0) return 'Blocked: zero Upstreams can currently participate in Selection.';
      if (latestFailure) return latestFailure;
      if (quarantined.length > 0) return 'Degraded: ' + quarantined.length + ' Upstream' + (quarantined.length === 1 ? '' : 's') + ' in Quarantine.';
      if (disabled.length > 0) return 'Degraded: ' + disabled.length + ' Upstream' + (disabled.length === 1 ? '' : 's') + ' Disabled.';
      if (cooling.length > 0) return 'Degraded: ' + cooling.length + ' Upstream' + (cooling.length === 1 ? '' : 's') + ' in Cooldown.';
      if (missingKeys.length > 0) return 'Degraded: ' + missingKeys.length + ' enabled Upstream' + (missingKeys.length === 1 ? '' : 's') + ' missing configured Upstream Keys.';
      if (modelFamilyExcluded.length > 0) return 'Degraded: ' + modelFamilyExcluded.length + ' available Upstream' + (modelFamilyExcluded.length === 1 ? '' : 's') + ' outside the Model Override protocol family.';
      if (hardFailures.length > 0) return 'Degraded: ' + hardFailures.length + ' enabled Upstream' + (hardFailures.length === 1 ? '' : 's') + ' reporting hard Health State.';
      if (available.length < enabled.length) return 'Degraded: ' + available.length + ' of ' + enabled.length + ' enabled Upstreams are available.';
      return 'Usable: Selection has eligible Upstreams and no current blocking reason.';
    }
    function updateTopDiagnostic(data, ups, activeModel) {
      // Check for debug lock first
      const lockInfo = getDebugLockInfo(data);
      if (lockInfo) {
        poolDiagnostic.dataset.state = 'degraded';
        poolUsability.innerHTML = '<span style="color: var(--warn);">🔒 Debug Locked</span>';
        const duration = formatDebugLockDuration(lockInfo.locked_duration_seconds || 0);
        diagnosticReason.innerHTML = \`<strong style="color: var(--warn);">⚠️ Debug Lock Mode Active</strong><br>所有请求已锁定到 <code>\${esc(lockInfo.upstream)}</code> (已锁定 \${duration})。<button onclick="unlockDebugLock()" style="margin-left: 8px; padding: 4px 8px; font-size: 12px;">🔓 解锁</button>\`;
        selectionCount.textContent = '锁定模式';
        selectionCount.title = 'Debug Lock: All requests routed to ' + lockInfo.upstream;
        modelOverrideState.textContent = activeModel || 'Following request';
        modelOverrideState.title = activeModel ? 'Model Override: ' + activeModel : 'No Model Override; use Requested Model.';
        adminTokenState.textContent = adminToken ? 'Accepted' : 'Not required';

        // Show/update debug lock diagnostics panel
        updateDebugLockDiagnostics(lockInfo);
        return;
      }

      // Hide debug lock diagnostics panel when not locked
      document.getElementById('debugLockDiagnostics').style.display = 'none';

      // Normal diagnostic flow
      const eligible = ups.filter((upstream) => upstream.available && upstreamMatchesModelFamily(upstream, activeModel));
      const latestFailure = requestFailureText((data.recent_requests || [])[0]);
      const active = ups.filter((upstream) => upstream.enabled && !upstream.quarantined);
      const degraded = eligible.length > 0 && (
        eligible.length < active.length ||
        ups.some((upstream) => !upstream.enabled || upstream.quarantined || upstream.cooldown_ms > 0 || isHardHealthFailure(upstream)) ||
        Boolean(latestFailure)
      );
      const state = eligible.length === 0 ? 'blocked' : degraded ? 'degraded' : 'usable';
      poolDiagnostic.dataset.state = state;
      poolUsability.textContent = state[0].toUpperCase() + state.slice(1);
      selectionCount.textContent = eligible.length + ' / ' + ups.length + ' eligible';
      selectionCount.title = eligible.length + ' Upstreams can participate in Selection after protocol-family compatibility; Discovered Models are advisory evidence only. ' + ups.filter((upstream) => upstream.available).length + ' are currently available before that compatibility check.';
      modelOverrideState.textContent = activeModel || 'Following request';
      modelOverrideState.title = activeModel ? 'Model Override: ' + activeModel : 'No Model Override; use Requested Model.';
      adminTokenState.textContent = adminToken ? 'Accepted' : 'Not required';
      diagnosticReason.textContent = likelyDiagnosticReason(ups, activeModel, eligible, latestFailure);
    }
    function updateTopDiagnosticAuthBlocked() {
      poolDiagnostic.dataset.state = 'blocked';
      poolUsability.textContent = 'Blocked';
      diagnosticReason.textContent = 'Management API rejected the request: Admin Token is missing or invalid.';
      selectionCount.textContent = 'unknown';
      selectionCount.title = 'Selection state is unavailable until Management API authentication succeeds.';
      modelOverrideState.textContent = 'unknown';
      modelOverrideState.title = 'Model Override state is unavailable until Management API authentication succeeds.';
      adminTokenState.textContent = adminToken ? 'Invalid' : 'Required';
    }
    const cardSignature = (items, activeModel) => items.map((u) => [
      u.name,
      u.base_url,
      u.site_url || '',
      u.signin_available ? 'can-signin' : '',
      u.signin_status || '',
      u.signin_completed ? 'signed-in' : '',
      u.signin_completed_date || '',
      u.enabled,
      u.quarantined ? 'quarantined' : 'active',
      u.weight,
      getTodayUsage(u.usage).total_tokens,
      u.usage?.total_tokens || 0,
      u.usage?.input_tokens || 0,
      u.usage?.output_tokens || 0,
      JSON.stringify(dailyToByDay(u.usage)),
      u.billing?.state || '',
      u.billing?.balance_amount ?? '',
      u.billing?.used_amount ?? '',
      u.billing?.limit_amount ?? '',
      u.billing?.limit_placeholder ? 'placeholder' : '',
      u.billing?.currency || '',
      u.billing?.error || '',
      quotaReqValue(u),
      quotaTokValue(u),
      u.selection_weight ?? '',
      u.selection_score ?? '',
      u.availability?.samples || 0,
      u.availability?.successes || 0,
      u.availability?.failures || 0,
      u.availability?.rate ?? '',
      u.availability?.multiplier ?? '',
      typeof u.availability?.recent === 'string' ? u.availability.recent : ((u.availability?.recent || []).map((value) => value ? '1' : '0').join('')),
      (u.keys || []).map((k) => \`\${k.label}:\${k.configured}\`).join(','),
      (u.keys || []).map((k) => \`\${k.label}:\${k.health?.state || ''}:\${k.health?.error || ''}:\${k.health?.warning || ''}\`).join(','),
      JSON.stringify(u.capabilities || {}),
      JSON.stringify(u.request_interface || {}),
      u.health?.error || '',
      u.health?.warning || '',
      (u.health?.models || []).join(','),
      verificationTier(u),
      u.representative_availability?.state || '',
      u.representative_availability?.verified ? 'verified' : 'not-verified',
      activeModel,
      signinFilter,
      verificationFilter
    ].join('|')).join('||');
    function keySummaryHtml(upstream) {
      return (upstream.keys || []).map((key) => {
        const state = key.configured ? key.health?.state || 'ready' : 'missing';
        const className = key.configured ? stateClass(state === 'ready' ? 'ok' : state) : 'bad';
        const note = key.health?.error || key.health?.warning || '';
        const title = note ? \` title="\${esc(note)}"\` : '';
        return \`<span class="key \${className}"\${title}>\${esc(key.label)}: \${esc(state)}</span>\`;
      }).join('');
    }
    function usageDaysHtml(upstream) {
      const entries = Object.entries(upstream.usage?.daily || {})
        .map(([day, entry]) => [day, entry.total_tokens || 0])
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 14);
      return entries.length
        ? entries.map(([day, tokens]) => \`<span class="usage-day">\${esc(day)}<strong title="\${esc(tokenTitle(day, tokens))}">\${fmtToken(tokens)}</strong></span>\`).join('')
        : '<span class="key">暂无 token 记录</span>';
    }
    function quotaLineHtml(upstream) {
      const requestValue = quotaReqValue(upstream);
      const tokenValue = quotaTokValue(upstream);
      if (!requestValue && !tokenValue) return '';
      return \`<div class="mini-line">Rate Limit <strong data-field="req_left">\${fmt(requestValue)}</strong> req / <strong data-field="tok_left">\${fmt(tokenValue)}</strong> tok</div>\`;
    }
    function setText(root, selector, value) {
      const node = root.querySelector(selector);
      if (node) node.textContent = value;
    }
    function workbenchCard(name) {
      const selector = \`[data-upstream="\${CSS.escape(name)}"]\`;
      return cards.querySelector(selector) || quarantineCards.querySelector(selector);
    }
    function probeModelValue(name, activeModel = '') {
      return upstreamProbeModels.has(name) ? upstreamProbeModels.get(name) : (activeModel || '');
    }
    function syncProbeModelInput(name, model) {
      const card = workbenchCard(name);
      const input = card?.querySelector('[data-probe-model]');
      if (input) input.value = model || '';
      card?.querySelectorAll('[data-model]').forEach((button) => {
        button.classList.toggle('active', button.dataset.model === (model || ''));
      });
    }
    function setProbeModel(name, model) {
      upstreamProbeModels.set(name, model || '');
      syncProbeModelInput(name, model || '');
    }
    function billingErrorHtml(upstream) {
      const error = upstream.billing?.error || '';
      return error ? \`<div class="mini-line billing-error" title="\${esc(error)}">Reason <strong data-field="billing_error">\${esc(error)}</strong></div>\` : '';
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
      node.textContent = fmtMoney(value, currency);
      node.title = fullMoney(value, currency);
      node.dataset.size = moneySize(value, currency);
    }
    function updateCard(upstream, activeModel) {
      const card = workbenchCard(upstream.name);
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
      setText(card, '[data-field="representative_template"]', representativeTemplateLabel(latestStatus));
      setText(card, '[data-field="cooldown"]', \`\${Math.ceil((upstream.cooldown_ms || 0) / 1000)}s\`);
      setText(card, '[data-field="weight"]', upstream.weight);
      setText(card, '[data-field="selection_weight"]', fmt(upstream.selection_weight));
      setText(card, '[data-field="selection_score"]', fmt(upstream.selection_score));
      setText(card, '[data-field="availability_rate"]', availabilityPercent(upstream));
      setText(card, '[data-field="availability_samples"]', \`\${upstream.availability?.samples || 0}/\${upstream.availability?.window_size || 50}\`);
      const availabilityReadout = card.querySelector('.availability-readout');
      if (availabilityReadout) availabilityReadout.title = availabilityTitle(upstream);
      const availabilityBar = card.querySelector('.availability-bar');
      if (availabilityBar) availabilityBar.className = \`availability-bar \${availabilityClass(upstream)}\`;
      const availabilityBarFill = card.querySelector('[data-field="availability_bar"]');
      if (availabilityBarFill) {
        const rate = upstream.availability?.rate;
        availabilityBarFill.style.width = \`\${Number.isFinite(rate) ? Math.max(0, Math.min(100, rate * 100)) : 0}%\`;
      }
      const availabilityHistory = card.querySelector('[data-field="availability_history"]');
      if (availabilityHistory) {
        const historyNode = document.createElement('div');
        historyNode.innerHTML = availabilityHtml(upstream);
        availabilityHistory.innerHTML = historyNode.querySelector('[data-field="availability_history"]')?.innerHTML || '';
      }
      setText(card, '[data-field="failures"]', upstream.failures);
      setText(card, '[data-field="calls"]', upstream.attempts || 0);
      const todayUsage = getTodayUsage(upstream.usage);
      setText(card, '[data-field="today_tokens"]', fmtToken(todayUsage.total_tokens));
      setText(card, '[data-field="total_tokens"]', fmtToken(upstream.usage?.total_tokens));
      const todayTokenNode = card.querySelector('[data-field="today_tokens"]');
      if (todayTokenNode) todayTokenNode.title = tokenTitle('Today', todayUsage.total_tokens);
      const totalTokenNode = card.querySelector('[data-field="total_tokens"]');
      if (totalTokenNode) totalTokenNode.title = \`Total \${fullToken(upstream.usage?.total_tokens || 0)} · Input \${fullToken(upstream.usage?.input_tokens || 0)} · Output \${fullToken(upstream.usage?.output_tokens || 0)}\`;
      setText(card, '[data-field="billing_state"]', upstream.billing?.state || 'unknown');
      setText(card, '[data-field="billing_error"]', upstream.billing?.error || '');
      const billingFact = card.querySelector('[data-billing-fact]');
      if (billingFact) billingFact.title = upstream.billing?.error || '';
      const protocolCapabilities = card.querySelector('[data-field="protocol_capabilities"]');
      if (protocolCapabilities) {
        const fragment = document.createElement('div');
        fragment.innerHTML = protocolCapabilitiesHtml(upstream);
        protocolCapabilities.innerHTML = fragment.firstElementChild?.innerHTML || '';
      }
      const requestApi = card.querySelector('[data-field="request_interface"]');
      if (requestApi) {
        requestApi.textContent = requestInterfaceLabel(upstream);
        requestApi.title = requestInterfaceTitle(upstream);
      }
      setMoney(card, '[data-field="balance"]', upstream.billing?.balance_amount, upstream.billing?.currency);
      setMoney(card, '[data-field="spent"]', upstream.billing?.used_amount, upstream.billing?.currency);
      setMoney(card, '[data-field="limit"]', upstream.billing?.limit_amount, upstream.billing?.currency, { unlimited: unlimitedBilling(upstream, 'limit') });
      setText(card, '[data-field="req_left"]', fmt(quotaReqValue(upstream)));
      setText(card, '[data-field="tok_left"]', fmt(quotaTokValue(upstream)));
      const signinAvailableNode = card.querySelector('[data-field="signin_available"]');
      if (signinAvailableNode) {
        const available = canSignin(upstream);
        signinAvailableNode.textContent = available ? '可签到' : '不可签到';
        signinAvailableNode.className = \`status-badge \${available ? 'ok' : 'cold'}\`;
        signinAvailableNode.title = available ? '配置标记为可签到' : '配置标记为不可签到';
      }
      const signinCompletedNode = card.querySelector('[data-field="signin_completed"]');
      if (signinCompletedNode) {
        signinCompletedNode.textContent = signinCompletedLabel(upstream);
        signinCompletedNode.className = \`status-badge \${signinCompletedClass(upstream)}\`;
        signinCompletedNode.title = canSignin(upstream) ? '今日签到完成状态' : '该站点当前标记为不可签到';
      }
      const rowProbeModel = probeModelValue(upstream.name, activeModel);
      const probeModelInput = card.querySelector('[data-probe-model]');
      if (probeModelInput && document.activeElement !== probeModelInput) {
        probeModelInput.value = rowProbeModel;
        probeModelInput.placeholder = activeModel || 'Probe Model';
      }
      card.querySelectorAll('[data-model]').forEach((button) => {
        button.classList.toggle('active', button.dataset.model === rowProbeModel);
      });
      const probeButton = card.querySelector('[data-probe]');
      if (probeButton) {
        const probing = probingUpstreams.has(upstream.name);
        probeButton.disabled = probing || !upstream.enabled;
        setButtonLabel(probeButton, 'radar', !upstream.enabled ? '停用中' : probing ? '测试中' : '测试');
      }
      renderInlineProbeResult(upstream.name);
      const claudeButton = card.querySelector('[data-claude-check]');
      if (claudeButton) {
        const checking = claudeCheckingUpstreams.has(upstream.name);
        claudeButton.disabled = checking || !upstream.enabled;
        setButtonLabel(claudeButton, 'radar', !upstream.enabled ? '停用中' : checking ? '检测中' : 'Claude');
      }
      renderCardClaudeCheck(card, claudeCheckResults.get(upstream.name));
      const billingButton = card.querySelector('[data-billing]');
      if (billingButton) {
        const billing = billingUpstreams.has(upstream.name);
        billingButton.disabled = billing || !upstream.enabled;
        setButtonLabel(billingButton, 'wallet', !upstream.enabled ? '停用中' : billing ? '刷新中' : '余额');
      }
      const toggleButton = card.querySelector('[data-toggle]');
      if (toggleButton) {
        toggleButton.disabled = false;
        setButtonLabel(toggleButton, upstream.enabled ? 'pause' : 'play', upstream.enabled ? '停用' : '启用');
        toggleButton.className = \`ghost toggle-site \${upstream.enabled ? 'is-on' : 'is-off'}\`;
        toggleButton.setAttribute('aria-pressed', String(upstream.enabled));
      }
      const quarantineButton = card.querySelector('[data-quarantine]');
      if (quarantineButton) {
        quarantineButton.disabled = false;
        quarantineButton.dataset.quarantined = upstream.quarantined ? 'true' : 'false';
        setButtonLabel(quarantineButton, upstream.quarantined ? 'play' : 'shield', upstream.quarantined ? '恢复' : '隔离');
        quarantineButton.className = \`ghost quarantine-site \${upstream.quarantined ? 'is-restore' : ''}\`;
        quarantineButton.setAttribute('aria-pressed', String(upstream.quarantined));
      }
      const signinButton = card.querySelector('[data-signin-complete]');
      if (signinButton) {
        const available = canSignin(upstream);
        const completed = signinCompleted(upstream);
        signinButton.disabled = !available;
        setButtonLabel(signinButton, !available || completed ? 'x' : 'signin', !available ? '不可签' : completed ? '撤销' : '完成');
        signinButton.className = \`ghost signin-action \${!available ? 'is-off' : completed ? 'is-complete' : ''}\`;
      }
      const signinAvailableButton = card.querySelector('[data-signin-available]');
      if (signinAvailableButton) {
        const available = canSignin(upstream);
        signinAvailableButton.disabled = false;
        signinAvailableButton.dataset.available = available ? 'true' : 'false';
        setButtonLabel(signinAvailableButton, available ? 'x' : 'check', available ? '设不可签' : '设可签');
        signinAvailableButton.className = \`ghost signin-action \${available ? '' : 'is-off'}\`;
        signinAvailableButton.setAttribute('aria-pressed', String(available));
      }
      const deleteButton = card.querySelector('[data-delete]');
      if (deleteButton) {
        const deleting = deletingUpstreams.has(upstream.name);
        deleteButton.disabled = deleting;
        setButtonLabel(deleteButton, 'trash', deleting ? '删除中' : '删除');
      }
    }
    function workbenchCardHtml(u, activeModel, data, index) {
      const probeModel = probeModelValue(u.name, activeModel);
      return \`
        <article class="card workbench-row panel \${u.name === editingName ? 'editing' : ''} \${u.enabled ? '' : 'paused'} \${u.quarantined ? 'quarantined' : ''}" data-upstream="\${esc(u.name)}" data-verification-tier="\${verificationTier(u)}" data-verification-indicator="\${verificationDetail(u).indicator}" tabindex="0" role="button" aria-label="编辑站点 \${esc(u.name)}" style="animation-delay:\${index * 35}ms">
          <div class="workbench-cell">
            <div class="name"><span class="verification-dot" data-indicator="\${verificationDetail(u).indicator}" title="\${esc(verificationDetail(u).label)}: \${esc(verificationDetail(u).reason)}">●</span><span class="verification-label">\${esc(verificationDetail(u).label)}</span>\${esc(u.name)}</div>
            <div class="url">\${esc(u.base_url)}</div>
            <div class="keys">\${keySummaryHtml(u)}</div>
            \${protocolCapabilitiesHtml(u)}
            \${signinBadgeHtml(u)}
          </div>
          <div class="workbench-cell">
            <div class="workbench-main"><span class="pill \${stateClass(u.health?.state)}" data-field="state">\${esc(u.health?.state || 'unknown')}</span></div>
            <div class="mini-line">HTTP <strong data-field="http">\${fmt(u.health?.http_status)}</strong></div>
            <div class="mini-line">Latency <strong data-field="latency">\${fmt(u.health?.latency_ms, 'ms')}</strong></div>
          </div>
          <div class="workbench-cell">
            <div class="mini-line">Weight <strong data-field="weight">\${u.weight}</strong> -> <strong data-field="selection_weight">\${fmt(u.selection_weight)}</strong> · Score <strong data-field="selection_score">\${fmt(u.selection_score)}</strong></div>
            \${availabilityHtml(u)}
            <div class="mini-line">Models <strong data-field="models_count">\${fmt(u.health?.models_count)}</strong> · Active <strong>\${activeModel ? esc(activeModel) : 'Following request'}</strong></div>
            <div class="mini-line">Request API <strong data-field="request_interface" title="\${esc(requestInterfaceTitle(u))}">\${esc(requestInterfaceLabel(u))}</strong></div>
            <div class="mini-line">Codex Desktop Template <strong data-field="representative_template">\${representativeTemplateLabel(data)}</strong></div>
            <div class="mini-line">Cooldown <strong data-field="cooldown">\${Math.ceil((u.cooldown_ms || 0) / 1000)}s</strong></div>
            <div class="mini-line">Failures <strong data-field="failures">\${u.failures}</strong></div>
          </div>
          <div class="workbench-cell">
            <div class="mini-line">Calls <strong data-field="calls">\${u.attempts || 0}</strong></div>
            <div class="mini-line">Today <strong data-field="today_tokens" title="\${esc(tokenTitle('Today', getTodayUsage(u.usage).total_tokens))}">\${fmtToken(getTodayUsage(u.usage).total_tokens)}</strong></div>
            <div class="mini-line">Total <strong data-field="total_tokens" title="Total \${fullToken(u.usage?.total_tokens || 0)} · Input \${fullToken(u.usage?.input_tokens || 0)} · Output \${fullToken(u.usage?.output_tokens || 0)}">\${fmtToken(u.usage?.total_tokens)}</strong></div>
          </div>
          <div class="workbench-cell" data-billing-fact title="\${esc(u.billing?.error || '')}">
            <div class="mini-line">Billing <strong data-field="billing_state">\${esc(u.billing?.state || 'unknown')}</strong></div>
            <div class="mini-line">Balance <strong class="money" data-field="balance" data-size="\${billingAmountSize(u, 'balance')}" title="\${esc(billingAmountTitle(u, 'balance'))}">\${billingAmountText(u, 'balance')}</strong></div>
            <div class="mini-line">Limit <strong class="money" data-field="limit" data-size="\${billingAmountSize(u, 'limit')}" title="\${esc(billingAmountTitle(u, 'limit'))}">\${billingAmountText(u, 'limit')}</strong></div>
            <div class="mini-line">Spent <strong class="money" data-field="spent" data-size="\${moneySize(u.billing?.used_amount, u.billing?.currency)}" title="\${esc(fullMoney(u.billing?.used_amount, u.billing?.currency))}">\${fmtMoney(u.billing?.used_amount, u.billing?.currency)}</strong></div>
            \${billingErrorHtml(u)}
            \${quotaLineHtml(u)}
          </div>
          <div class="workbench-action-stack">
            <div class="workbench-confirmed-actions" data-action-group="confirmed">
              <button class="ghost toggle-site \${u.enabled ? 'is-on' : 'is-off'}" type="button" data-toggle="\${esc(u.name)}" data-enabled="\${u.enabled ? 'true' : 'false'}" aria-pressed="\${u.enabled ? 'true' : 'false'}">\${icon(u.enabled ? 'pause' : 'play')}\${u.enabled ? '停用' : '启用'}</button>
              <button class="ghost quarantine-site \${u.quarantined ? 'is-restore' : ''}" type="button" data-quarantine="\${esc(u.name)}" data-quarantined="\${u.quarantined ? 'true' : 'false'}" aria-pressed="\${u.quarantined ? 'true' : 'false'}">\${icon(u.quarantined ? 'play' : 'shield')}\${u.quarantined ? '恢复' : '隔离'}</button>
              <button class="ghost delete-site" type="button" data-delete="\${esc(u.name)}" \${deletingUpstreams.has(u.name) ? 'disabled' : ''} aria-label="删除站点 \${esc(u.name)}">\${icon('trash')}\${deletingUpstreams.has(u.name) ? '删除中' : '删除'}</button>
            </div>
            <div class="workbench-actions" data-action-group="safe">
              <div class="probe-model-control">
                <input data-probe-model="\${esc(u.name)}" value="\${esc(probeModel)}" placeholder="\${activeModel ? esc(activeModel) : 'Probe Model'}" autocomplete="off" aria-label="\${esc(u.name)} Probe Model" />
                <button class="ghost" type="button" data-probe-model-current="\${esc(u.name)}">当前</button>
              </div>
              <button class="ghost probe-site" type="button" data-probe="\${esc(u.name)}" \${probingUpstreams.has(u.name) || !u.enabled ? 'disabled' : ''}>\${icon('radar')}\${!u.enabled ? '停用中' : probingUpstreams.has(u.name) ? '测试中' : '测试'}</button>
              <button class="ghost claude-site" type="button" data-claude-check="\${esc(u.name)}" \${claudeCheckingUpstreams.has(u.name) || !u.enabled ? 'disabled' : ''}>\${icon('radar')}\${!u.enabled ? '停用中' : claudeCheckingUpstreams.has(u.name) ? '检测中' : 'Claude'}</button>
              <button class="ghost billing-site" type="button" data-billing="\${esc(u.name)}" \${billingUpstreams.has(u.name) || !u.enabled ? 'disabled' : ''}>\${icon('wallet')}\${!u.enabled ? '停用中' : billingUpstreams.has(u.name) ? '刷新中' : '余额'}</button>
              <button class="ghost lock-site" type="button" data-lock="\${esc(u.name)}" title="Lock all requests to this upstream for debugging">\${icon('lock')}Lock</button>
              \${u.site_url ? \`<a class="site-link" href="\${esc(u.site_url)}" target="_blank" rel="noopener noreferrer">\${icon('external')}签到</a>\` : ''}
              <button class="ghost signin-action \${canSignin(u) ? '' : 'is-off'}" type="button" data-signin-available="\${esc(u.name)}" data-available="\${canSignin(u) ? 'true' : 'false'}" aria-pressed="\${canSignin(u) ? 'true' : 'false'}">\${icon(canSignin(u) ? 'x' : 'check')}\${canSignin(u) ? '设不可签' : '设可签'}</button>
              <button class="ghost signin-action \${!canSignin(u) ? 'is-off' : signinCompleted(u) ? 'is-complete' : ''}" type="button" data-signin-complete="\${esc(u.name)}" \${!canSignin(u) ? 'disabled' : ''}>\${icon(!canSignin(u) || signinCompleted(u) ? 'x' : 'signin')}\${!canSignin(u) ? '不可签' : signinCompleted(u) ? '撤销' : '完成'}</button>
            </div>
            \${claudeCardResultHtml(u.name)}
          </div>
          <div class="workbench-models-row">
            <div class="model-strip-label">Discovered Models</div>
            <div class="models" aria-label="\${esc(u.name)} discovered models">\${(u.health?.models || []).length ? (u.health.models || []).map(model => \`<button class="model-chip \${model === probeModel ? 'active' : ''}" type="button" data-model="\${esc(model)}" data-model-upstream="\${esc(u.name)}" title="\${esc(model)}">\${esc(model)}</button>\`).join('') : '<span class="key">暂无模型列表</span>'}</div>
          </div>
          \${inlineProbeResultHtml(u.name)}
        </article>\`;
    }
    function workbenchRowsHtml(items, activeModel, data) {
      return items.map((upstream, index) => workbenchCardHtml(upstream, activeModel, data, index)).join('');
    }
    function renderRecentRequests(items) {
      const compatibilityText = (compatibility) => {
        if (!compatibility) return 'none';
        const bucketParts = (label, bucket = {}) => {
          const parts = [];
          if (bucket.tool_types?.length) parts.push('tools=' + bucket.tool_types.join(','));
          if (bucket.input_types?.length) parts.push('inputs=' + bucket.input_types.join(','));
          if (bucket.output_format_types?.length) parts.push('outputs=' + bucket.output_format_types.join(','));
          if (bucket.content_types?.length) parts.push('content=' + bucket.content_types.join(','));
          if (bucket.fields?.length) parts.push('fields=' + bucket.fields.join(','));
          return parts.length ? label + ':' + parts.join(';') : '';
        };
        const parts = [];
        for (const text of [
          bucketParts('converted', compatibility.converted),
          bucketParts('downgraded', compatibility.downgraded),
          bucketParts('stripped', compatibility.stripped)
        ]) {
          if (text) parts.push(text);
        }
        return \`\${compatibility.mode || 'adapter'} · \${compatibility.adapter || 'adapter'} · \${parts.join(' | ') || 'no changes'}\`;
      };
      requestList.innerHTML = items.length ? items.map((item) => {
        const isDebugLock = isDebugLockRequest(item);
        const debugLockIcon = isDebugLock ? '<span title="Debug Lock Request" style="margin-right: 4px;">🔒</span>' : '';
        return \`
        <div class="request-row \${isDebugLock ? 'debug-lock-request' : ''}">
          <div><small>Model</small><strong>\${debugLockIcon}\${esc(item.originalModel || 'none')} -> \${esc(item.actualModel || 'none')}</strong></div>
          <div><small>Upstream</small><strong>\${esc(item.upstream || 'unknown')}\${isDebugLock ? ' (locked)' : ''}</strong></div>
          <div><small>Status</small><strong title="\${esc(\`Tokens \${fullToken(item.tokens ?? 0)} · Input \${fullToken(item.inputTokens ?? 0)} · Output \${fullToken(item.outputTokens ?? 0)}\`)}">\${esc(item.outcome || '')} · \${esc(item.status ?? 0)} · \${esc(item.durationMs ?? 0)}ms · \${esc(fmtToken(item.tokens ?? 0))} tok · in \${esc(fmtToken(item.inputTokens ?? 0))} / out \${esc(fmtToken(item.outputTokens ?? 0))}</strong></div>
          <div><small>Compatibility</small><strong title="\${esc(compatibilityText(item.compatibility))}">\${esc(compatibilityText(item.compatibility))}</strong></div>
          <div><small>When</small><strong>\${new Date(item.at).toLocaleTimeString()}</strong></div>
        </div>\`;
      }).join('') : '<div class="empty">暂无请求记录。</div>';
    }
    function resetEdit(clearValues = true) {
      editingName = '';
      formMode.textContent = '添加新站点';
      setButtonLabel(submitUpstream, 'plus', '添加站点');
      cancelEdit.hidden = true;
      upstreamForm.elements.name.readOnly = false;
      renderClaudeCheckResult(null);
      if (clearValues) upstreamForm.reset();
      updateKeyModeFormState();
      updateSigninFormState();
      document.querySelectorAll('.card.editing').forEach((card) => card.classList.remove('editing'));
    }
    function updateKeyModeFormState() {
      const keyMode = upstreamForm.elements.key_mode?.value || 'env';
      const envInput = upstreamForm.elements.key_env;
      const valueInput = upstreamForm.elements.key_value;
      if (envInput) envInput.disabled = keyMode === 'value';
      if (valueInput) {
        valueInput.disabled = keyMode !== 'value';
        valueInput.placeholder = editingName && keyMode === 'value' ? '留空保留原 key' : 'sk-...';
      }
      return keyMode;
    }
    function formRequiresPlaintextKey() {
      return !editingName && upstreamForm.elements.key_mode?.value === 'value' && !upstreamForm.elements.key_value?.value.trim();
    }
    function updateSigninFormState() {
      return upstreamForm.elements.signin_available.checked;
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
      upstreamForm.elements.signin_available.checked = canSignin(upstream);
      const firstKey = upstream.keys?.[0] || {};
      const keySource = firstKey.source || 'env';
      upstreamForm.elements.key_mode.value = keySource === 'value' ? 'value' : 'env';
      upstreamForm.elements.key_env.value = keySource === 'env' ? firstKey.label || '' : '';
      upstreamForm.elements.key_value.value = '';
      upstreamForm.elements.protocol_support.value = protocolSupportValue(upstream);
      updateKeyModeFormState();
      updateSigninFormState();
      formMode.textContent = \`编辑站点：\${upstream.name}\`;
      setButtonLabel(submitUpstream, 'edit', '保存修改');
      cancelEdit.hidden = false;
      renderClaudeCheckResult(null);
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
    async function setCompatibilityFromControls() {
      const enabled = compatStrip.checked;
      const payload = {
        strip_responses_only_features: enabled,
        adapters: {
          anthropic_messages: enabled && compatAnthropic.checked,
          chat_completions: enabled && compatChat.checked
        }
      };
      const response = await fetch('/pool/compatibility', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      setToast(response.ok
        ? (enabled ? 'Adapter 兼容模式已更新。' : 'Adapter 兼容模式已关闭。')
        : \`兼容模式更新失败：\${result.error || response.status}\`);
      await load();
    }
    function updateQuarantineDrawerButton(count = 0) {
      quarantineCards.hidden = !quarantineDrawerOpen;
      quarantineToggle.setAttribute('aria-expanded', String(quarantineDrawerOpen));
      quarantineToggle.title = quarantineDrawerOpen
        ? '收起隔离区'
        : \`打开隔离区，查看 \${count} 个 Quarantined Upstream\`;
      setButtonLabel(quarantineToggle, quarantineDrawerOpen ? 'x' : 'shield', quarantineDrawerOpen ? '收起隔离区' : '打开隔离区');
    }
    function renderQuarantineDrawer(quarantinedUps, activeModel, data) {
      updateQuarantineDrawerButton(quarantinedUps.length);
      if (!quarantineDrawerOpen) {
        if (quarantineCards.innerHTML) quarantineCards.innerHTML = '';
        quarantineCardsSignature = null;
        return;
      }
      const nextQuarantineCardsSignature = cardSignature(quarantinedUps, activeModel);
      if (nextQuarantineCardsSignature !== quarantineCardsSignature) {
        quarantineCards.classList.toggle('stable', Boolean(quarantineCardsSignature));
        quarantineCards.innerHTML = quarantinedUps.length ? '<div class="workbench-head" aria-hidden="true"><span>Upstream</span><span>Health</span><span>Selection</span><span>Usage</span><span>Billing / Quota</span><span>Actions</span></div>' + workbenchRowsHtml(quarantinedUps, activeModel, data) : '<div class="empty panel">暂无 Quarantined Upstream。</div>';
        quarantineCardsSignature = nextQuarantineCardsSignature;
      } else {
        quarantinedUps.forEach((upstream) => updateCard(upstream, activeModel));
      }
    }
    async function load() {
      const response = await fetch('/pool/status', { headers: authHeaders() });
      if (response.status === 401) {
        updateTopDiagnosticAuthBlocked();
        setToast('管理接口需要 admin token。');
        lastRefresh.textContent = '鉴权失败';
        return;
      }
      const data = await response.json();
      latestStatus = data;
      const knownModels = data.model?.known || [];
      const activeModel = data.model?.override || '';
      const allUps = sortedUpstreams(data.upstreams || [], activeModel);
      const activeUps = allUps.filter((upstream) => !upstream.quarantined);
      const quarantinedUps = allUps.filter((upstream) => upstream.quarantined);
      const ups = activeUps.filter((upstream) => verificationFilterMatches(upstream) && signinFilterMatches(upstream));
      upstreamCache = new Map(allUps.map((upstream) => [upstream.name, upstream]));
      if (editingName && !upstreamCache.has(editingName)) resetEdit(false);
      const selectModels = activeModel && !knownModels.includes(activeModel) ? [activeModel, ...knownModels] : knownModels;
      updateTopDiagnostic(data, allUps, activeModel);
      document.querySelector('#total').textContent = activeUps.length;
      document.querySelector('#available').textContent = activeUps.filter(u => u.available).length;
      document.querySelector('#healthy').textContent = activeUps.filter(u => u.health?.state === 'ok').length;
      document.querySelector('#cooling').textContent = activeUps.filter(u => u.cooldown_ms > 0).length;
      quarantineCount.textContent = quarantinedUps.length;
      updateTokenBreakdown(data.usage || {});
      renderDailyUsage(data, allUps);
      updateWorkbenchFilterControls(activeUps, ups);
      const nextModelOptionsSignature = selectModels.join('|');
      if (nextModelOptionsSignature !== modelOptionsSignature) {
        modelSelect.innerHTML = '<option value="">跟随 Codex 请求</option>' + selectModels.map((model) => \`<option value="\${esc(model)}">\${esc(model)}</option>\`).join('');
        modelOptionsSignature = nextModelOptionsSignature;
      }
      modelSelect.value = activeModel;
      modelReadout.textContent = activeModel
        ? \`代理会把后续 JSON 请求中的 model 改写为 \${activeModel}。已探测到 \${knownModels.length} 个模型。\`
        : \`未设置模型覆盖；后续请求将使用 Codex 原始 model。已探测到 \${knownModels.length} 个模型。\`;
      const compatibility = data.compatibility?.adapter_mode || {};
      const compatEnabled = compatibility.strip_responses_only_features === true;
      compatStrip.checked = compatEnabled;
      compatAnthropic.checked = compatibility.adapters?.anthropic_messages === true;
      compatChat.checked = compatibility.adapters?.chat_completions === true;
      compatAnthropic.disabled = !compatEnabled;
      compatChat.disabled = !compatEnabled;
      compatReadout.textContent = compatEnabled
        ? \`非原生 adapter 可在无 Native Responses Route 时剔除 Responses-only Features；Anthropic \${compatAnthropic.checked ? '开' : '关'}，Chat \${compatChat.checked ? '开' : '关'}。\`
        : '严格模式：含 Responses-only Features 的请求需要 Native Responses Route。';
      renderRecentRequests(data.recent_requests || []);
      const nextCardsSignature = cardSignature(ups, activeModel);
      if (nextCardsSignature !== cardsSignature) {
        cards.classList.toggle('stable', Boolean(cardsSignature));
        cards.innerHTML = ups.length ? '<div class="workbench-head" aria-hidden="true"><span>Upstream</span><span>Health</span><span>Selection</span><span>Usage</span><span>Billing / Quota</span><span>Actions</span></div>' + workbenchRowsHtml(ups, activeModel, data) : \`<div class="empty panel">\${activeUps.length ? '暂无符合筛选的 Upstream。' : '暂无 Active Upstream。'}</div>\`;
        cardsSignature = nextCardsSignature;
      } else {
        ups.forEach((upstream) => updateCard(upstream, activeModel));
      }
      renderQuarantineDrawer(quarantinedUps, activeModel, data);
      lastRefresh.textContent = \`最后刷新：\${new Date().toLocaleTimeString()}\`;
      markEditingCard();
    }
    async function probeAll() {
      rememberAllInlineProbeRunning();
      renderProbeResult({ probe_status: 'running', summary: { total_count: upstreamCache.size, enabled_count: [...upstreamCache.values()].filter((upstream) => upstream.enabled && !upstream.quarantined).length, quarantined_count: [...upstreamCache.values()].filter((upstream) => upstream.enabled && upstream.quarantined).length } }, { mode: 'all', title: '全部测试结果', responseOk: true, error: '测试中' });
      try {
        const response = await fetch('/pool/probe', { method: 'POST', headers: authHeaders() });
        const result = await response.json();
        const enabledCount = result.summary?.enabled_count ?? result.summary?.total_count ?? 0;
        renderProbeResult(result, { mode: 'all', title: '全部测试结果', responseOk: response.ok, error: response.ok ? '' : result.error || String(response.status) });
        setToast(response.ok
          ? (result.probe_ok
            ? \`全部站点探测通过：\${result.summary?.ok_count ?? 0}/\${enabledCount}\`
            : \`全部站点探测完成：\${result.summary?.ok_count ?? 0}/\${enabledCount} 可用\`)
          : \`全部探测失败：\${result.error || response.status}\`);
      } catch (error) {
        renderProbeResult({ ok: false, error: error.message }, { mode: 'all', title: '全部测试结果', responseOk: false, error: error.message });
        setToast(\`全部探测失败：\${error.message}\`);
      }
      await load();
    }
    function probeStatusText(result) {
      if (result.probe_status === 'running') return '测试中';
      if (result.probe_status === 'skipped') return '待真实探测';
      return result.probe_ok ? '通过' : '未通过';
    }
    function probeStatusNote(result) {
      if (result.probe_status === 'skipped') return '，待真实探测';
      return \`，真实探测\${probeStatusText(result)}\`;
    }
    async function probeOne(name) {
      probingUpstreams.add(name);
      rememberInlineProbeRunning(name);
      const card = workbenchCard(name);
      const button = card?.querySelector('[data-probe]');
      const probeModel = card?.querySelector('[data-probe-model]')?.value.trim() || probeModelValue(name, latestStatus?.model?.override || '');
      setProbeModel(name, probeModel);
      if (button) {
        button.disabled = true;
        setButtonLabel(button, 'radar', '测试中');
      }
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/probe\`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify(probeModel ? { probe_model: probeModel } : {})
        });
        const result = await response.json();
        renderProbeResult(result, { mode: 'one', title: \`\${name} 测试结果\`, responseOk: response.ok, error: response.ok ? '' : result.error || String(response.status) });
        setToast(response.ok
          ? \`\${name} 测试\${probeStatusText(result)}：\${result.health?.state || 'unknown'}，Probe Model \${result.probe_model || probeModel || 'missing'}\`
          : \`\${name} 测试失败：\${result.error || response.status}\`);
      } catch (error) {
        renderProbeResult({ ok: false, upstream: name, error: error.message, health: { state: 'network_error', error: error.message } }, { mode: 'one', title: \`\${name} 测试结果\`, responseOk: false, error: error.message });
        setToast(\`\${name} 测试失败：\${error.message}\`);
      } finally {
        probingUpstreams.delete(name);
        await load();
      }
    }
    async function checkClaudeForForm() {
      const payload = formClaudePayload();
      if (!payload.name || !payload.base_url) {
        setToast('请先填写名称和 Base URL。');
        return;
      }
      if (formRequiresPlaintextKey()) {
        setToast('选择明文 Key 时，请填写 API key。');
        return;
      }
      checkClaude.disabled = true;
      setButtonLabel(checkClaude, 'radar', '检测中');
      renderClaudeCheckResult(null);
      try {
        const response = await fetch('/pool/claude-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || String(response.status));
        renderClaudeCheckResult(result.claude_check);
        setToast(\`\${payload.name} Claude 检测完成：\${claudeCheckSummary(result.claude_check)}\`);
      } catch (error) {
        setToast(\`Claude 检测失败：\${error.message}\`);
      } finally {
        checkClaude.disabled = false;
        setButtonLabel(checkClaude, 'radar', '检测 Claude');
      }
    }
    async function checkClaudeOne(name) {
      claudeCheckingUpstreams.add(name);
      const card = workbenchCard(name);
      const button = card?.querySelector('[data-claude-check]');
      if (button) {
        button.disabled = true;
        setButtonLabel(button, 'radar', '检测中');
      }
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/claude-check\`, { method: 'POST', headers: authHeaders() });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || String(response.status));
        const check = result.claude_check;
        claudeCheckResults.set(name, check);
        setToast(\`\${name} Claude 检测完成：\${claudeCheckSummary(check)}\`);
      } catch (error) {
        setToast(\`\${name} Claude 检测失败：\${error.message}\`);
      } finally {
        claudeCheckingUpstreams.delete(name);
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
      const card = workbenchCard(name);
      const button = card?.querySelector('[data-billing]');
      if (button) {
        button.disabled = true;
        setButtonLabel(button, 'wallet', '刷新中');
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
      const card = workbenchCard(name);
      const button = card?.querySelector('[data-toggle]');
      if (button) {
        button.disabled = true;
        setButtonLabel(button, enabled ? 'play' : 'pause', enabled ? '启用中' : '停用中');
      }
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/enabled\`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ enabled })
        });
        const result = await response.json();
        const probeNote = enabled ? probeStatusNote(result) : '';
        setToast(response.ok
          ? \`\${name} 已\${enabled ? '启用' : '停用'}，状态：\${result.health?.state || 'unknown'}\${probeNote}\`
          : \`\${name} 切换失败：\${result.error || response.status}\`);
      } catch (error) {
        setToast(\`\${name} 切换失败：\${error.message}\`);
      } finally {
        await load();
      }
    }
    async function setUpstreamQuarantine(name, quarantined) {
      if (!name) return;
      const confirmed = window.confirm(quarantined
        ? \`确认隔离 "\${name}"？它将停止参与 Selection，但仍可在隔离区测试。\`
        : \`确认恢复 "\${name}"？它将回到 Active Upstreams，并可再次参与 Selection。\`);
      if (!confirmed) return;
      const card = workbenchCard(name);
      const button = card?.querySelector('[data-quarantine]');
      if (button) {
        button.disabled = true;
        setButtonLabel(button, quarantined ? 'shield' : 'play', quarantined ? '隔离中' : '恢复中');
      }
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/quarantine\`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ quarantined })
        });
        const result = await response.json();
        const probeNote = quarantined ? '' : probeStatusNote(result);
        setToast(response.ok
          ? \`\${name} 已\${quarantined ? '隔离' : '恢复'}，状态：\${result.health?.state || 'unknown'}\${probeNote}\`
          : \`\${name} 隔离状态切换失败：\${result.error || response.status}\`);
      } catch (error) {
        setToast(\`\${name} 隔离状态切换失败：\${error.message}\`);
      } finally {
        await load();
      }
    }
    async function setSigninState(name, payload) {
      const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}/signin\`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || String(response.status));
      return result;
    }
    async function setSigninCompleted(name) {
      const upstream = upstreamCache.get(name);
      const completed = signinCompleted(upstream);
      const card = workbenchCard(name);
      const button = card?.querySelector('[data-signin-complete]');
      if (button) {
        button.disabled = true;
        setButtonLabel(button, 'signin', '写入中');
      }
      try {
        const result = await setSigninState(name, { signin_completed: !completed });
        setToast(result.signin_completed
          ? \`\${name} 今日已标记完成签到。\`
          : \`\${name} 已撤销今日签到。\`);
      } catch (error) {
        setToast(\`\${name} 更新签到失败：\${error.message}\`);
      } finally {
        await load();
      }
    }
    async function setSigninAvailable(name, available) {
      const card = workbenchCard(name);
      const button = card?.querySelector('[data-signin-available]');
      if (button) {
        button.disabled = true;
        setButtonLabel(button, 'sliders', '设置中');
      }
      try {
        const result = await setSigninState(name, { signin_available: available });
        setToast(\`\${name} 已设为\${result.signin_available ? '可签到' : '不可签到'}。\`);
      } catch (error) {
        setToast(\`\${name} 切换可签到失败：\${error.message}\`);
      } finally {
        await load();
      }
    }
    async function deleteUpstream(name) {
      if (!name) return;
      const confirmed = window.confirm(\`确认删除站点 "\${name}"？此操作会从配置中移除它。\`);
      if (!confirmed) return;
      deletingUpstreams.add(name);
      const card = workbenchCard(name);
      const button = card?.querySelector('[data-delete]');
      if (button) {
        button.disabled = true;
        setButtonLabel(button, 'trash', '删除中');
      }
      try {
        const response = await fetch(\`/pool/upstreams/\${encodeURIComponent(name)}\`, {
          method: 'DELETE',
          headers: authHeaders()
        });
        const result = await response.json();
        if (response.ok && editingName === name) resetEdit();
        setToast(response.ok
          ? \`\${name} 已删除。\`
          : \`\${name} 删除失败：\${result.error || response.status}\`);
      } catch (error) {
        setToast(\`\${name} 删除失败：\${error.message}\`);
      } finally {
        deletingUpstreams.delete(name);
        await load();
      }
    }
    async function importUpstreamsFromFile() {
      const file = importFile.files?.[0];
      if (!file) {
        setToast('请选择 JSON 文件。');
        return;
      }
      importUpstreams.disabled = true;
      setButtonLabel(importUpstreams, 'upload', '导入中');
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const params = new URLSearchParams({
          replace: importReplace.value,
          secret_mode: importSecretMode.value
        });
        const response = await fetch(\`/pool/import/upstreams?\${params}\`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        const warning = result.plaintext_key_warning ? \`；\${result.plaintext_key_warning}\` : '';
        const failure = result.error || result.results?.find((item) => item.action === 'failed')?.error || response.status;
        setToast(response.ok
          ? \`导入完成：新增 \${result.added || 0}，替换 \${result.replaced || 0}，跳过 \${result.skipped || 0}，失败 \${result.failed || 0}\${warning}\`
          : \`导入失败：\${failure}\`);
        await load();
      } catch (error) {
        setToast(\`导入失败：\${error.message}\`);
      } finally {
        importUpstreams.disabled = false;
        setButtonLabel(importUpstreams, 'upload', '导入 JSON');
      }
    }
    document.querySelector('#refresh').addEventListener('click', load);
    document.querySelector('#probeAll').addEventListener('click', probeAll);
    document.querySelector('#billingAll').addEventListener('click', probeBillingAll);
    clearProbeResults.addEventListener('click', clearProbeResult);
    copyProbeResults.addEventListener('click', async () => {
      if (!latestProbeResult) {
        setToast('暂无测试结果可复制。');
        return;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(latestProbeResult, null, 2));
        setToast('测试结果 JSON 已复制。');
      } catch (error) {
        setToast('复制失败：' + error.message);
      }
    });
    importUpstreams.addEventListener('click', importUpstreamsFromFile);
    checkClaude.addEventListener('click', checkClaudeForForm);
    document.querySelector('#downloadUsageCsv').addEventListener('click', () => downloadUsage('csv'));
    document.querySelector('#downloadUsageJson').addEventListener('click', () => downloadUsage('json'));
    sendCurlTest.addEventListener('click', runCurlDebugger);
    copyCurlResult.addEventListener('click', async () => {
      if (!latestCurlResult) return;
      await navigator.clipboard.writeText(JSON.stringify(latestCurlResult, null, 2));
      setToast('Curl 测试结果 JSON 已复制。');
    });
    curlMethod.addEventListener('change', () => {
      const noBody = curlMethod.value === 'GET' || curlMethod.value === 'HEAD';
      curlBody.disabled = noBody;
    });
    curlBody.disabled = curlMethod.value === 'GET' || curlMethod.value === 'HEAD';
    function toggleTokenBreakdown() {
      const hidden = totalTokenBreakdown.hasAttribute('hidden');
      totalTokenBreakdown.toggleAttribute('hidden', !hidden);
      totalTokensMetric.setAttribute('aria-expanded', String(hidden));
    }
    totalTokensMetric.addEventListener('click', toggleTokenBreakdown);
    totalTokensMetric.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleTokenBreakdown();
    });
    signinFilterButtons.forEach((button) => {
      button.addEventListener('click', () => setSigninFilter(button.dataset.signinFilter || 'all'));
    });
    verificationFilterButtons.forEach((button) => {
      button.addEventListener('click', () => setVerificationFilter(button.dataset.verificationFilter || 'all'));
    });
    function showPendingSignin() {
      setSigninFilter('pending');
    }
    signinPendingMetric.addEventListener('click', showPendingSignin);
    signinPendingMetric.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      showPendingSignin();
    });
    adminTokenInput.addEventListener('change', () => {
      adminToken = adminTokenInput.value.trim();
      if (adminToken) localStorage.setItem('codexPoolAdminToken', adminToken);
      else localStorage.removeItem('codexPoolAdminToken');
      load();
    });
    modelSelect.addEventListener('change', () => setModel(modelSelect.value));
    compatStrip.addEventListener('change', () => {
      if (compatStrip.checked && !compatAnthropic.checked && !compatChat.checked) {
        compatAnthropic.checked = true;
        compatChat.checked = true;
      }
      setCompatibilityFromControls();
    });
    compatAnthropic.addEventListener('change', setCompatibilityFromControls);
    compatChat.addEventListener('change', setCompatibilityFromControls);
    document.querySelector('#clearModel').addEventListener('click', () => setModel(''));
    quarantineToggle.addEventListener('click', () => {
      quarantineDrawerOpen = !quarantineDrawerOpen;
      localStorage.setItem('codexPoolQuarantineOpen', quarantineDrawerOpen ? 'true' : 'false');
      const data = latestStatus || { upstreams: [], model: {} };
      const activeModel = data.model?.override || '';
      const allUps = sortedUpstreams(data.upstreams || [], activeModel);
      renderQuarantineDrawer(allUps.filter((upstream) => upstream.quarantined), activeModel, data);
      markEditingCard();
    });
    function handleWorkbenchClick(event) {
      const toggleButton = event.target.closest('[data-toggle]');
      if (toggleButton) {
        const currentlyEnabled = toggleButton.dataset.enabled === 'true';
        setUpstreamEnabled(toggleButton.dataset.toggle || '', !currentlyEnabled);
        return;
      }
      const quarantineButton = event.target.closest('[data-quarantine]');
      if (quarantineButton) {
        const currentlyQuarantined = quarantineButton.dataset.quarantined === 'true';
        setUpstreamQuarantine(quarantineButton.dataset.quarantine || '', !currentlyQuarantined);
        return;
      }
      const currentProbeModelButton = event.target.closest('[data-probe-model-current]');
      if (currentProbeModelButton) {
        setProbeModel(currentProbeModelButton.dataset.probeModelCurrent || '', latestStatus?.model?.override || '');
        return;
      }
      const probeButton = event.target.closest('[data-probe]');
      if (probeButton) {
        probeOne(probeButton.dataset.probe || '');
        return;
      }
      const claudeButton = event.target.closest('[data-claude-check]');
      if (claudeButton) {
        checkClaudeOne(claudeButton.dataset.claudeCheck || '');
        return;
      }
      const billingButton = event.target.closest('[data-billing]');
      if (billingButton) {
        probeBillingOne(billingButton.dataset.billing || '');
        return;
      }
      const signinAvailableButton = event.target.closest('[data-signin-available]');
      if (signinAvailableButton) {
        const currentlyAvailable = signinAvailableButton.dataset.available === 'true';
        setSigninAvailable(signinAvailableButton.dataset.signinAvailable || '', !currentlyAvailable);
        return;
      }
      const signinCompleteButton = event.target.closest('[data-signin-complete]');
      if (signinCompleteButton) {
        setSigninCompleted(signinCompleteButton.dataset.signinComplete || '');
        return;
      }
      const deleteButton = event.target.closest('[data-delete]');
      if (deleteButton) {
        deleteUpstream(deleteButton.dataset.delete || '');
        return;
      }
      const lockButton = event.target.closest('[data-lock]');
      if (lockButton) {
        showLockDialog(lockButton.dataset.lock || '');
        return;
      }
      const button = event.target.closest('[data-model]');
      if (button) {
        const name = button.dataset.modelUpstream || button.closest('[data-upstream]')?.dataset.upstream || '';
        setProbeModel(name, button.dataset.model || '');
        return;
      }
      if (event.target.closest('a, button, input, select, label, .probe-inline')) return;
      const card = event.target.closest('[data-upstream]');
      if (!card) return;
      const upstream = upstreamCache.get(card.dataset.upstream);
      if (upstream) startEdit(upstream);
    }
    cards.addEventListener('click', handleWorkbenchClick);
    quarantineCards.addEventListener('click', handleWorkbenchClick);
    function handleWorkbenchInput(event) {
      const input = event.target.closest('[data-probe-model]');
      if (!input) return;
      setProbeModel(input.dataset.probeModel || '', input.value.trim());
    }
    cards.addEventListener('input', handleWorkbenchInput);
    quarantineCards.addEventListener('input', handleWorkbenchInput);
    function handleWorkbenchKeydown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('button, a, input, select, label, .probe-inline')) return;
      const card = event.target.closest('[data-upstream]');
      if (!card) return;
      const upstream = upstreamCache.get(card.dataset.upstream);
      if (!upstream) return;
      event.preventDefault();
      startEdit(upstream);
    }
    cards.addEventListener('keydown', handleWorkbenchKeydown);
    quarantineCards.addEventListener('keydown', handleWorkbenchKeydown);
    cancelEdit.addEventListener('click', () => resetEdit());
    upstreamForm.elements.key_mode.addEventListener('change', updateKeyModeFormState);
    upstreamForm.elements.signin_available.addEventListener('change', updateSigninFormState);
    upstreamForm.addEventListener('input', (event) => {
      if (event.target.closest('#checkClaude, #submitUpstream, #cancelEdit')) return;
      renderClaudeCheckResult(null);
    });
    upstreamForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (formRequiresPlaintextKey()) {
        setToast('选择明文 Key 时，请填写 API key。');
        return;
      }
      const payload = applyClaudeSuggestion(formClaudePayload());
      if (!confirmAddUpstream(payload)) return;
      const response = await fetch('/pool/upstreams', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      const apiNote = result.api_detected || payload.api ? \`，协议：\${result.api || payload.api}\` : '';
      const probeNote = response.ok ? probeStatusNote(result) : '';
      setToast(response.ok
        ? \`\${payload.replace ? '保存成功' : '添加成功'}：\${result.upstream}，探测状态：\${result.health?.state}\${probeNote}\${apiNote}\`
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
  return [...new Set(state.upstreams.filter((upstream) => upstream.enabled && !upstream.quarantined).flatMap((upstream) => upstream.health?.models || []))]
    .sort((a, b) => a.localeCompare(b));
}

function createKeyStatusView(key, state, at) {
  return {
    label: key.label,
    source: key.source,
    configured: Boolean(key.value),
    cooldown_ms: Math.max(0, key.cooldownUntil - at),
    failures: key.failures,
    availability: availabilitySummary(key.stats, state.availability),
    quota: key.quota,
    representative_evidence: representativeEvidencePayload(key.representativeEvidence || {}, at),
    health: {
      state: key.health.state,
      source: key.health.source || '',
      checked_at: key.health.checkedAt,
      latency_ms: key.health.latencyMs,
      http_status: key.health.httpStatus,
      error: key.health.error,
      warning: key.health.warning || ''
    }
  };
}

function createUpstreamStatusView(upstream, config, state, at, today) {
  const availability = availabilitySummary(upstream.stats, state.availability);
  const available = upstreamAvailable(upstream, at, state.modelOverride);
  const selectionWeight = upstreamSelectionWeight(upstream, availability, state.modelOverride, '', at);
  const effectiveHealthState = healthProbeEffectiveState(upstream.health, state.modelOverride);
  return {
    name: upstream.name,
    config_index: upstream.index,
    base_url: upstream.baseUrl,
    site_url: upstream.siteUrl,
    signin_available: upstream.signinAvailable,
    signin_status: signinStatus(upstream.signinAvailable, upstream.signinCompletedDate, today),
    signin_completed: upstream.signinAvailable && upstream.signinCompletedDate === today,
    signin_completed_date: visibleSigninCompletedDate(upstream.signinAvailable, upstream.signinCompletedDate, today),
    proxy_url: upstream.proxyUrl || undefined,
    codex_oauth: upstream.codexOAuth,
    request_mode: upstream.requestMode,
    resolved_request_mode: upstream.resolvedRequestMode || undefined,
    request_interface: requestInterfaceForUpstream(upstream, state.modelOverride),
    route_strategies: normalizeRouteStrategies(upstream.routeStrategies),
    oauth_expires_at: upstream.oauthExpiresAt || undefined,
    oauth_client_id: upstream.oauthClientId || undefined,
    oauth_email: upstream.oauthEmail || undefined,
    oauth_plan_type: upstream.oauthPlanType || undefined,
    chatgpt_account_id: upstream.chatGptAccountId || undefined,
    chatgpt_user_id: upstream.chatGptUserId || undefined,
    organization_id: upstream.organizationId || undefined,
    health_path: upstream.healthPath || config.health?.path || '/models',
    model_suffix_strip: upstream.modelSuffixStrip || undefined,
    probe_auth: upstream.probeAuth,
    api: upstream.api,
    capabilities: normalizeProtocolCapabilities(upstream.capabilities),
    verification_tier: deriveVerificationTier(upstream),
    verification_detail: deriveVerificationDetail(upstream, { now: at }),
    enabled: upstream.enabled,
    quarantined: upstream.quarantined === true,
    weight: upstream.weight,
    selection_weight: roundedSelectionValue(selectionWeight),
    selection_score: available ? roundedSelectionValue(upstreamSelectionScore(upstream, availability, state.modelOverride, '', at)) : 0,
    representative_availability: (() => {
      // Choose protocol based on upstream API type and available evidence
      if (upstream.api === 'anthropic') {
        return representativeAvailability(upstream, { model: state.modelOverride, protocol: 'anthropic_messages', at });
      }
      if (upstream.api === 'openai') {
        return representativeAvailability(upstream, { model: state.modelOverride, protocol: 'responses', at });
      }
      // For 'both', try both protocols and use the one with more evidence
      const responsesResult = representativeAvailability(upstream, { model: state.modelOverride, protocol: 'responses', at });
      const anthropicResult = representativeAvailability(upstream, { model: state.modelOverride, protocol: 'anthropic_messages', at });
      // Prefer verified over unverified, then fresh over stale, then higher evidence count
      if (anthropicResult.verified && !responsesResult.verified) return anthropicResult;
      if (responsesResult.verified && !anthropicResult.verified) return responsesResult;
      if (anthropicResult.fresh_evidence_count > responsesResult.fresh_evidence_count) return anthropicResult;
      if (responsesResult.fresh_evidence_count > anthropicResult.fresh_evidence_count) return responsesResult;
      return anthropicResult.evidence_count > responsesResult.evidence_count ? anthropicResult : responsesResult;
    })(),
    available,
    cooldown_ms: Math.max(0, upstream.cooldownUntil - at),
    in_flight: upstream.inFlight,
    attempts: upstream.stats.attempts,
    successes: upstream.successes,
    failures: upstream.failures,
    ewma_latency_ms: upstream.ewmaLatencyMs,
    last_status: upstream.lastStatus,
    last_error: upstream.lastError,
    availability,
    usage: usagePayload(upstream.stats, today),
    quota: upstream.quota,
    billing: billingPayload(upstream.billing, upstream.billingConfig),
    health: {
      state: effectiveHealthState,
      raw_state: upstream.health.state,
      source: upstream.health.source || '',
      checked_at: upstream.health.checkedAt,
      latency_ms: upstream.health.latencyMs,
      http_status: upstream.health.httpStatus,
      error: healthProbeEffectiveError(upstream.health, state.modelOverride),
      warning: upstream.health.warning || '',
      diagnostics: upstream.health.diagnostics || undefined,
      probe_model: upstream.health.probeModel || '',
      models: upstream.health.models || [],
      models_count: upstream.health.modelsCount,
      key_label: upstream.health.keyLabel
    },
    keys: upstream.keys.map((key) => createKeyStatusView(key, state, at))
  };
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
    compatibility: {
      adapter_mode: {
        strip_responses_only_features: state.compatibility?.adapterMode?.stripResponsesOnlyFeatures === true,
        adapters: {
          anthropic_messages: state.compatibility?.adapterMode?.adapters?.anthropicMessages === true,
          chat_completions: state.compatibility?.adapterMode?.adapters?.chatCompletions === true
        }
      }
    },
    debug_lock: getDebugLockState(state),
    representative_templates: representativeTemplatesPayload(state, at),
    recent_requests: config.debug?.capture_request_headers === true
      ? state.recentRequests
      : stripRequestDebugFields(state.recentRequests),
    health: {
      enabled: config.health?.enabled !== false,
      interval_ms: Number(config.health?.interval_ms || 60000),
      path: config.health?.path || '/models'
    },
    availability: {
      window_size: state.availability.windowSize,
      min_samples: state.availability.minSamples,
      boost_threshold: state.availability.boostThreshold,
      healthy_threshold: state.availability.healthyThreshold,
      degraded_threshold: state.availability.degradedThreshold,
      poor_threshold: state.availability.poorThreshold
    },
    usage: aggregateUsage(state.upstreams, today),
    billing: aggregateBilling(state.upstreams),
    upstreams: state.upstreams.map((upstream) => createUpstreamStatusView(upstream, config, state, at, today))
  };
}

function createCodexOAuthAccountsPayload(config, state, secrets = {}) {
  const accounts = Array.isArray(config.codex_oauth?.accounts) ? config.codex_oauth.accounts : [];
  return {
    ok: true,
    accounts: accounts.map((account) => {
      const credentialRef = account.credential_ref || `codex_oauth.${account.name}`;
      const secret = secrets[credentialRef] && typeof secrets[credentialRef] === 'object' && !Array.isArray(secrets[credentialRef])
        ? secrets[credentialRef]
        : {};
      const upstream = state.upstreams.find((item) => item.name === account.name);
      return {
        name: account.name,
        enabled: account.enabled !== false,
        quarantined: account.enabled !== false && account.quarantined === true,
        weight: Number(account.weight || 1),
        proxy_url: account.proxy_url || undefined,
        credential_ref: credentialRef,
        secret_configured: Boolean(secret.access_token),
        refresh_configured: Boolean(secret.refresh_token),
        base_url: account.base_url || CHATGPT_CODEX_BASE_URL,
        oauth_expires_at: account.oauth_expires_at || undefined,
        oauth_client_id: account.oauth_client_id || undefined,
        oauth_email: account.oauth_email || undefined,
        oauth_plan_type: account.oauth_plan_type || undefined,
        chatgpt_account_id: account.chatgpt_account_id || undefined,
        chatgpt_user_id: account.chatgpt_user_id || undefined,
        organization_id: account.organization_id || undefined,
        projected: Boolean(upstream),
        health: upstream ? {
          state: upstream.health.state,
          checked_at: upstream.health.checkedAt,
          latency_ms: upstream.health.latencyMs,
          http_status: upstream.health.httpStatus,
          error: upstream.health.error,
          warning: upstream.health.warning || '',
          diagnostics: upstream.health.diagnostics || undefined
        } : null
      };
    })
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
  const envName = config.server?.auth_token_env;
  if (!envName) return true;
  const expected = process.env[envName];
  if (!expected) return false;

  // Support both Authorization: Bearer and x-api-key headers
  const authorization = req.headers.authorization || '';
  const xApiKey = req.headers['x-api-key'] || '';

  return authorization === `Bearer ${expected}` || xApiKey === expected;
}

function isAdminAuthorized(req, config) {
  if (Object.prototype.hasOwnProperty.call(config.server || {}, 'admin_auth_token_env')) {
    return tokenMatches(req, config.server.admin_auth_token_env);
  }
  return isAuthorized(req, config);
}

function defaultBaseUrlForImportItem(item) {
  if (looksLikeChatGptAccountExport(item)) return CHATGPT_CODEX_BASE_URL;
  return '';
}

function importArrayFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of ['upstreams', 'sites', 'providers', 'endpoints', 'apis', 'proxies', 'nodes']) {
    if (Array.isArray(payload[key]) && payload[key].length > 0) return payload[key];
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
      return Object.entries(payload[key]).map(([name, value]) => (
        value && typeof value === 'object' && !Array.isArray(value)
          ? { name, ...value }
          : { name, value }
      ));
    }
  }
  if (Array.isArray(payload.accounts)) return payload.accounts;
  if (payload.accounts && typeof payload.accounts === 'object') {
    return Object.entries(payload.accounts).map(([name, value]) => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? { name, ...value }
        : { name, value }
    ));
  }

  if (payload.data && typeof payload.data === 'object') return importArrayFromPayload(payload.data);
  if (payload.config && typeof payload.config === 'object') return importArrayFromPayload(payload.config);
  if (payload.upstream && typeof payload.upstream === 'object') return [payload.upstream];
  return [payload];
}

function baseUrlFromImportItem(item) {
  return (firstString(
    item.base_url,
    item.baseUrl,
    item.api_base,
    item.apiBase,
    item.api_url,
    item.apiUrl,
    item.endpoint,
    item.url,
    item.base,
    item.host,
    item.server
  ) || defaultBaseUrlForImportItem(item)).replace(/\/$/, '');
}

function siteUrlFromImportItem(item, baseUrl) {
  return firstString(
    item.site_url,
    item.siteUrl,
    item.site,
    item.web_url,
    item.webUrl,
    item.homepage,
    item.dashboard_url,
    item.dashboardUrl,
    item.panel_url,
    item.panelUrl
  ) || deriveSiteUrl(baseUrl, '');
}

function keyEntriesFromImportItem(item, name, secretMode) {
  if (Array.isArray(item.keys) && item.keys.length > 0) return item.keys;
  const credentials = item.credentials && typeof item.credentials === 'object' && !Array.isArray(item.credentials)
    ? item.credentials
    : {};
  const env = firstString(
    item.env,
    item.key_env,
    item.keyEnv,
    item.api_key_env,
    item.apiKeyEnv,
    item.token_env,
    item.tokenEnv
  );
  if (env) return [{ env }];

  const value = firstString(
    credentials.api_key,
    credentials.apiKey,
    credentials.key,
    credentials.token,
    credentials.api_token,
    credentials.apiToken,
    credentials.auth_token,
    credentials.authToken,
    credentials.access_token,
    credentials.accessToken,
    item.api_key,
    item.apiKey,
    item.key,
    item.token,
    item.api_token,
    item.apiToken,
    item.auth_token,
    item.authToken,
    item.access_token,
    item.accessToken,
    item.experimental_bearer_token,
    item.experimentalBearerToken,
    item.bearer_token,
    item.bearerToken,
    item.value
  );
  if (!value) return [{ env: envNameForUpstream(name) }];
  if (secretMode === 'env') return [{ env: envNameForUpstream(name) }];
  return [{ value }];
}

function apiFromImportItem(item) {
  const platform = String(item.platform || item.extra?.auth_provider || '').toLowerCase();
  if (platform === 'openai') return 'openai';
  const value = firstString(item.api, item.protocol, item.wire_api, item.wireApi, item.type).toLowerCase();
  if (!value) return undefined;
  if (['anthropic', 'claude'].includes(value)) return 'anthropic';
  if (['both', 'dual'].includes(value)) return 'both';
  if (['openai', 'responses', 'chat_completions', 'chat-completions', 'sub2api', 'cpa'].includes(value)) return 'openai';
  return undefined;
}

function requestModeFromImportItem(item) {
  const value = firstString(item.request_mode, item.requestMode, item.wire_api, item.wireApi).toLowerCase();
  if (!value) return undefined;
  const mode = normalizeRequestMode(value);
  return ['responses', 'chat_completions', 'codex_oauth'].includes(mode) ? mode : undefined;
}

function oauthExtraFromImportItem(item) {
  const credentials = item.credentials && typeof item.credentials === 'object' && !Array.isArray(item.credentials)
    ? item.credentials
    : {};
  const accessToken = firstString(credentials.access_token, credentials.accessToken, item.access_token, item.accessToken);
  const tokenMetadata = codexOauthMetadataFromToken(accessToken);
  return {
    codex_oauth: true,
    request_mode: 'codex_oauth',
    oauth_expires_at: firstString(credentials.expires_at, credentials.expiresAt, item.expires_at, item.expiresAt, tokenMetadata.oauth_expires_at),
    oauth_client_id: firstString(credentials.client_id, credentials.clientId, item.client_id, item.clientId, tokenMetadata.oauth_client_id),
    oauth_email: firstString(credentials.email, item.email, tokenMetadata.oauth_email),
    oauth_plan_type: firstString(credentials.plan_type, credentials.planType, item.plan_type, item.planType, tokenMetadata.oauth_plan_type),
    chatgpt_account_id: firstString(credentials.chatgpt_account_id, credentials.chatgptAccountId, item.chatgpt_account_id, item.chatgptAccountId, tokenMetadata.chatgpt_account_id),
    chatgpt_user_id: firstString(credentials.chatgpt_user_id, credentials.chatgptUserId, item.chatgpt_user_id, item.chatgptUserId, tokenMetadata.chatgpt_user_id),
    organization_id: firstString(credentials.organization_id, credentials.organizationId, item.organization_id, item.organizationId, tokenMetadata.organization_id)
  };
}

function normalizeImportItem(item, index, options = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    const error = new Error('import item must be a JSON object');
    error.statusCode = 400;
    throw error;
  }
  const baseUrl = baseUrlFromImportItem(item);
  let fallbackName = `imported-${index + 1}`;
  try {
    fallbackName = new URL(baseUrl).hostname.split('.').filter(Boolean).slice(0, 2).join('-') || fallbackName;
  } catch {
    // Keep the stable imported-N fallback.
  }
  const name = cleanName(firstString(item.name, item.id, item.title, item.label, item.remark, item.provider), fallbackName);
  const probeAuth = firstString(item.probe_auth, item.probeAuth);
  const api = apiFromImportItem(item);
  const codexOAuth = looksLikeChatGptAccountExport(item);
  const oauthExtra = codexOAuth ? oauthExtraFromImportItem(item) : {};
  const proxyUrl = firstString(item.proxy_url, item.proxyUrl);
  const signinAvailable = signinAvailableValue(item);
  const signinCompleted = signinCompletedValue(item);
  const signinCompletedDate = signinCompletedDateValue(item);
  const hasQuarantined = Object.prototype.hasOwnProperty.call(item, 'quarantined');
  return {
    name,
    base_url: baseUrl,
    site_url: siteUrlFromImportItem(item, baseUrl),
    ...(signinAvailable === undefined ? {} : { signin_available: booleanOption(signinAvailable, false) }),
    ...(signinCompletedDate === undefined ? {} : { signin_completed_date: normalizeDateKey(signinCompletedDate) }),
    ...(signinCompleted === undefined ? {} : { signin_completed: booleanOption(signinCompleted, false) }),
    ...(proxyUrl ? { proxy_url: proxyUrl } : {}),
    health_path: codexOAuth ? '' : firstString(item.health_path, item.healthPath, item.models_path, item.modelsPath),
    probe_auth: codexOAuth ? 'none' : probeAuth,
    request_mode: codexOAuth ? 'codex_oauth' : requestModeFromImportItem(item),
    api: api || undefined,
    model_suffix_strip: firstString(item.model_suffix_strip, item.modelSuffixStrip, item.model_suffix),
    probe_headers: item.probe_headers || item.probeHeaders,
    protocol_capabilities: item.protocol_capabilities || item.protocolCapabilities,
    billing: item.billing,
    weight: Number(firstString(item.weight, item.priority) || 1),
    keys: keyEntriesFromImportItem(item, name, options.secretMode),
    enabled: item.enabled === undefined ? true : item.enabled !== false,
    ...(hasQuarantined ? { quarantined: item.quarantined === true } : {}),
    replace: options.replace,
    ...Object.fromEntries(Object.entries(oauthExtra).filter(([, value]) => value !== ''))
  };
}

function validateImportedUpstreamUrl(upstream) {
  try {
    const parsed = new URL(upstream.base_url);
    if (!isCodexOAuthConfig(upstream) && (parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.chatgpt.com'))) {
      const error = new Error('chatgpt.com Web session/back-end URLs are not supported as upstreams; import OpenAI-compatible API endpoints instead');
      error.statusCode = 400;
      throw error;
    }
  } catch (error) {
    if (error.statusCode) throw error;
  }
}

function importUpstreamsIntoConfig(payload, config, options = {}) {
  const replace = booleanOption(options.replace ?? payload?.replace ?? payload?.mode, false);
  const secretMode = firstString(options.secretMode, payload?.secret_mode, payload?.secretMode).toLowerCase() === 'env' ? 'env' : 'value';
  const items = importArrayFromPayload(payload);
  if (looksLikeChatGptWebSession(payload)) {
    const error = new Error('ChatGPT Web session JSON is not an upstream config. Import a sub2api account export or an OpenAI-compatible upstream JSON instead.');
    error.statusCode = 400;
    throw error;
  }
  if (!items.length) {
    const error = new Error('no importable upstreams found');
    error.statusCode = 400;
    throw error;
  }

  const results = [];
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  let failed = 0;
  let plaintextKeyCount = 0;
  if (!Array.isArray(config.upstreams)) config.upstreams = [];

  items.forEach((item, index) => {
    try {
      const imported = normalizeImportItem(item, index, { replace, secretMode });
      validateImportedUpstreamUrl(imported);
      const existingIndex = config.upstreams.findIndex((upstream) => upstream.name === imported.name);
      if (existingIndex >= 0 && !replace) {
        skipped += 1;
        results.push({ name: imported.name, action: 'skipped', reason: 'upstream already exists' });
        return;
      }
      const upstream = validateUpstreamPayload(imported, config);
      const writeIndex = config.upstreams.findIndex((entry) => entry.name === upstream.name);
      if (writeIndex >= 0) {
        config.upstreams.splice(writeIndex, 1, upstream);
        replaced += 1;
        results.push({ name: upstream.name, action: 'replaced', base_url: upstream.base_url, api: upstream.api });
      } else {
        config.upstreams.push(upstream);
        added += 1;
        results.push({ name: upstream.name, action: 'added', base_url: upstream.base_url, api: upstream.api });
      }
      plaintextKeyCount += upstream.keys.filter((key) => key.value).length;
    } catch (error) {
      failed += 1;
      results.push({ index, name: item?.name || item?.id || null, action: 'failed', error: error.message });
    }
  });

  return {
    added,
    replaced,
    skipped,
    failed,
    total: items.length,
    results,
    plaintextKeyCount
  };
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

  const explicitKeyEnv = firstString(
    payload.key_env,
    payload.keyEnv,
    payload.api_key_env,
    payload.apiKeyEnv,
    payload.token_env,
    payload.tokenEnv
  );
  const explicitKeyValue = firstString(
    payload.key_value,
    payload.keyValue,
    payload.api_key,
    payload.apiKey,
    payload.key,
    payload.token,
    payload.api_token,
    payload.apiToken,
    payload.auth_token,
    payload.authToken,
    payload.access_token,
    payload.accessToken,
    payload.experimental_bearer_token,
    payload.experimentalBearerToken,
    payload.bearer_token,
    payload.bearerToken
  );

  const keyInput = Array.isArray(payload.keys) && payload.keys.length > 0
    ? payload.keys
    : explicitKeyValue
      ? [{ value: explicitKeyValue, label: firstString(payload.key_label, payload.keyLabel) || undefined }]
      : explicitKeyEnv
        ? [{ env: explicitKeyEnv }]
        : payload.replace && Array.isArray(existing?.keys) && existing.keys.length > 0
          ? existing.keys
          : null;

  const keys = keyInput
    ? keyInput.map((entry) => {
      if (typeof entry === 'string') return { env: entry };
      if (entry && typeof entry === 'object' && entry.env) return { env: String(entry.env) };
      if (entry && typeof entry === 'object' && entry.value) return { value: String(entry.value), label: entry.label ? String(entry.label) : undefined };
      const entryValue = entry && typeof entry === 'object'
        ? firstString(
            entry.key_value,
            entry.keyValue,
            entry.api_key,
            entry.apiKey,
            entry.key,
            entry.token,
            entry.experimental_bearer_token,
            entry.experimentalBearerToken,
            entry.bearer_token,
            entry.bearerToken
          )
        : '';
      if (entryValue) return { value: entryValue, label: entry.label ? String(entry.label) : undefined };
      const error = new Error('each key must be an env name, {"env":"NAME"}, or {"value":"secret"}');
      error.statusCode = 400;
      throw error;
    })
    : [{ env: 'CODEX_CUSTOM_API_KEY' }];

  const siteUrlInput = hasOwn('site_url') ? payload.site_url : existing?.site_url;
  const siteUrl = deriveSiteUrl(baseUrl, siteUrlInput);
  const hasSigninAvailable = ['signin_available', 'sign_in_available', 'can_signin', 'canSignIn', 'checkin_available', 'check_in_available']
    .some((key) => hasOwn(key));
  const signinAvailableInput = hasSigninAvailable ? signinAvailableValue(payload) : signinAvailableValue(existing);
  const signinAvailable = booleanOption(signinAvailableInput, Boolean(siteUrl));
  const hasSigninCompletedDate = ['signin_completed_date', 'signinCompletedDate', 'sign_in_completed_date', 'signed_in_date', 'checkin_completed_date', 'check_in_completed_date']
    .some((key) => hasOwn(key));
  let signinCompletedDate = hasSigninCompletedDate
    ? normalizeDateKey(signinCompletedDateValue(payload))
    : signinCompletionDate(existing);
  const hasSigninCompleted = ['signin_completed', 'sign_in_completed', 'signed_in', 'signedIn', 'checkin_completed', 'check_in_completed']
    .some((key) => hasOwn(key));
  if (hasSigninCompleted) {
    signinCompletedDate = booleanOption(signinCompletedValue(payload), false) ? localDateKey() : '';
  }
  if (signinCompletedDate !== localDateKey()) signinCompletedDate = '';
  if (!signinAvailable) signinCompletedDate = '';
  const proxyUrlInput = hasOwn('proxy_url') ? payload.proxy_url : existing?.proxy_url;
  const codexOAuthInput = hasOwn('codex_oauth') ? payload.codex_oauth : existing?.codex_oauth;
  const requestModeInput = hasOwn('request_mode') ? payload.request_mode : existing?.request_mode;
  const requestMode = normalizeRequestMode(requestModeInput, codexOAuthInput === true);
  if (!['auto', 'responses', 'chat_completions', 'codex_oauth'].includes(requestMode)) {
    const error = new Error('request_mode must be "auto", "responses", "chat_completions", or "codex_oauth"');
    error.statusCode = 400;
    throw error;
  }
  const oauthExpiresAtInput = hasOwn('oauth_expires_at') ? payload.oauth_expires_at : existing?.oauth_expires_at;
  const oauthClientIdInput = hasOwn('oauth_client_id') ? payload.oauth_client_id : existing?.oauth_client_id;
  const oauthEmailInput = hasOwn('oauth_email') ? payload.oauth_email : existing?.oauth_email;
  const oauthPlanTypeInput = hasOwn('oauth_plan_type') ? payload.oauth_plan_type : existing?.oauth_plan_type;
  const chatGptAccountIdInput = hasOwn('chatgpt_account_id') ? payload.chatgpt_account_id : existing?.chatgpt_account_id;
  const chatGptUserIdInput = hasOwn('chatgpt_user_id') ? payload.chatgpt_user_id : existing?.chatgpt_user_id;
  const organizationIdInput = hasOwn('organization_id') ? payload.organization_id : existing?.organization_id;
  const healthPathInput = hasOwn('health_path') ? payload.health_path : existing?.health_path;
  const modelSuffixStripInput = hasOwn('model_suffix_strip')
    ? payload.model_suffix_strip
    : hasOwn('modelSuffixStrip')
      ? payload.modelSuffixStrip
      : hasOwn('model_suffix')
        ? payload.model_suffix
        : existing?.model_suffix_strip;
  const probeAuthInput = hasOwn('probe_auth') ? payload.probe_auth : existing?.probe_auth;
  const apiInput = hasOwn('api') ? payload.api : existing?.api;
  const api = normalizeUpstreamApi(apiInput, probeAuthInput);
  if (!['openai', 'anthropic', 'both'].includes(api)) {
    const error = new Error('api must be "openai", "anthropic", or "both"');
    error.statusCode = 400;
    throw error;
  }
  const probeHeadersInput = hasOwn('probe_headers') ? payload.probe_headers : existing?.probe_headers;
  const protocolCapabilitiesInput = hasOwn('protocol_capabilities')
    ? payload.protocol_capabilities
    : hasOwn('protocolCapabilities')
      ? payload.protocolCapabilities
      : existing?.protocol_capabilities;
  const billingInput = hasOwn('billing') ? payload.billing : existing?.billing;
  const declaredProtocolCapabilities = normalizeDeclaredProtocolCapabilities(protocolCapabilitiesInput);
  const enabled = hasOwn('enabled') ? payload.enabled !== false : existing?.enabled !== false;
  const quarantined = enabled && (hasOwn('quarantined') ? payload.quarantined === true : existing?.quarantined === true);

  return {
    name,
    base_url: baseUrl,
    site_url: siteUrl,
    signin_available: signinAvailable,
    signin_completed_date: signinCompletedDate,
    proxy_url: normalizeProxyUrl(proxyUrlInput) || undefined,
    codex_oauth: codexOAuthInput === true || requestMode === 'codex_oauth' || undefined,
    request_mode: requestMode === 'auto' ? undefined : requestMode,
    oauth_expires_at: typeof oauthExpiresAtInput === 'string'
      ? oauthExpiresAtInput.trim()
      : undefined,
    oauth_client_id: typeof oauthClientIdInput === 'string' ? oauthClientIdInput.trim() : undefined,
    oauth_email: typeof oauthEmailInput === 'string' ? oauthEmailInput.trim() : undefined,
    oauth_plan_type: typeof oauthPlanTypeInput === 'string' ? oauthPlanTypeInput.trim() : undefined,
    chatgpt_account_id: typeof chatGptAccountIdInput === 'string' ? chatGptAccountIdInput.trim() : undefined,
    chatgpt_user_id: typeof chatGptUserIdInput === 'string' ? chatGptUserIdInput.trim() : undefined,
    organization_id: typeof organizationIdInput === 'string' ? organizationIdInput.trim() : undefined,
    health_path: typeof healthPathInput === 'string'
      ? healthPathInput.trim()
      : undefined,
    model_suffix_strip: typeof modelSuffixStripInput === 'string'
      ? normalizeModelSuffix(modelSuffixStripInput) || undefined
      : undefined,
    probe_auth: typeof probeAuthInput === 'string'
      ? probeAuthInput.trim()
      : undefined,
    api,
    probe_headers: probeHeadersInput && typeof probeHeadersInput === 'object' && !Array.isArray(probeHeadersInput)
      ? Object.fromEntries(Object.entries(probeHeadersInput).map(([key, value]) => [key, String(value)]))
      : undefined,
    protocol_capabilities: Object.keys(declaredProtocolCapabilities).length > 0
      ? declaredProtocolCapabilities
      : undefined,
    billing: billingInput && typeof billingInput === 'object' && !Array.isArray(billingInput)
      ? { ...billingInput }
      : undefined,
    weight: Number(hasOwn('weight') ? payload.weight || 1 : existing?.weight || 1),
    keys,
    enabled,
    quarantined: quarantined || undefined
  };
}

async function saveConfig(config, configPath) {
  if (!configPath) return;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function deleteUpstreamFromConfig(config, secrets, name) {
  const targetName = String(name || '').trim();
  let removedUpstreams = 0;
  let removedAccounts = 0;
  let removedSecrets = 0;
  const removedCredentialRefs = [];

  if (Array.isArray(config.upstreams)) {
    const before = config.upstreams.length;
    config.upstreams = config.upstreams.filter((item) => item?.name !== targetName);
    removedUpstreams = before - config.upstreams.length;
  }

  if (Array.isArray(config.codex_oauth?.accounts)) {
    const accounts = config.codex_oauth.accounts;
    const keptAccounts = [];
    for (const account of accounts) {
      if (account?.name !== targetName) {
        keptAccounts.push(account);
        continue;
      }
      removedAccounts += 1;
      const credentialRef = String(account.credential_ref || `codex_oauth.${account.name}`).trim();
      if (credentialRef) removedCredentialRefs.push(credentialRef);
    }
    accounts.splice(0, accounts.length, ...keptAccounts);
  }

  if (removedAccounts > 0 && secrets && typeof secrets === 'object' && !Array.isArray(secrets)) {
    const remainingAccounts = Array.isArray(config.codex_oauth?.accounts) ? config.codex_oauth.accounts : [];
    for (const credentialRef of [...new Set(removedCredentialRefs)]) {
      const stillReferenced = remainingAccounts.some((account) => {
        const ref = String(account.credential_ref || `codex_oauth.${account.name}`).trim();
        return ref === credentialRef;
      });
      if (!stillReferenced && Object.prototype.hasOwnProperty.call(secrets, credentialRef)) {
        delete secrets[credentialRef];
        removedSecrets += 1;
      }
    }
  }

  return {
    found: removedUpstreams + removedAccounts > 0,
    removedUpstreams,
    removedAccounts,
    removedSecrets
  };
}

async function handlePoolApi(req, res, config, state, options, statsPath, runtime = {}) {
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
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      listen: `${config.server?.host || '127.0.0.1'}:${config.server?.port || 8787}`,
      upstreams: state.upstreams.length
    });
  }

  if (!isAdminAuthorized(req, config)) {
    return jsonResponse(res, 401, { error: 'unauthorized: invalid Codex API pool admin token' });
  }

  if (req.method === 'GET' && pathname === '/pool/debug-choose') {
    const at = now();
    const model = 'gpt-5.5';
    const log = [];

    let candidates = state.upstreams.filter((upstream) => {
      const isUpstreamAvail = upstreamAvailable(upstream, at);
      const keyAvail = upstream.keys.some((key) => keyAvailable(key, at));
      log.push({
        upstream: upstream.name,
        upstreamAvailable: isUpstreamAvail,
        enabled: upstream.enabled,
        hasBaseUrl: !!upstream.baseUrl,
        healthAllowsSelection: healthAllowsSelection(upstream, model),
        codexOAuthExpired: codexOAuthExpired(upstream, at),
        cooldownPass: upstream.cooldownUntil <= at,
        keyAvailable: keyAvail
      });
      return isUpstreamAvail && keyAvail;
    });

    const modelCandidates = candidates.filter((upstream) => upstreamSupportsModel(upstream, model));
    const knownModelCandidates = modelCandidates.filter((upstream) => upstreamHasKnownModel(upstream, model));

    return jsonResponse(res, 200, {
      log,
      candidates: candidates.map(c => c.name),
      modelCandidates: modelCandidates.map(c => c.name),
      knownModelCandidates: knownModelCandidates.map(c => c.name)
    });
  }

  if (req.method === 'GET' && (pathname === '/pool/status' || pathname === '/pool/upstreams')) {
    return jsonResponse(res, 200, createStatusPayload(config, state));
  }

  if (req.method === 'GET' && pathname === '/pool/codex-oauth/accounts') {
    return jsonResponse(res, 200, createCodexOAuthAccountsPayload(config, state, runtime.secrets || {}));
  }

  if (req.method === 'GET' && pathname === '/pool/usage/daily.json') {
    const payload = dailyUsageExportPayload(state);
    const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="codex-api-pool-daily-usage.json"',
      'content-length': body.length
    });
    return res.end(body);
  }

  if (req.method === 'GET' && pathname === '/pool/usage/daily.csv') {
    const payload = dailyUsageExportPayload(state);
    const body = Buffer.from(dailyUsageCsv(payload));
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="codex-api-pool-daily-usage.csv"',
      'content-length': body.length
    });
    return res.end(body);
  }

  if (req.method === 'POST' && pathname === '/pool/probe') {
    const probeResults = await runHealthChecks(state, config, console, { live: true });
    persistStats(state, statsPath);
    const summary = healthProbeSummary(state.upstreams, state.modelOverride);
    return jsonResponse(res, 200, {
      ok: true,
      probe_ok: summary.probe_ok,
      probe_status: summary.probe_status,
      summary,
      probe_results: probeResults,
      result: createStatusPayload(config, state)
    });
  }

  if (req.method === 'POST' && pathname === '/pool/claude-check') {
    const payload = await readJsonBody(req, maxBodyBytes);
    const payloadName = String(payload?.name || '').trim();
    const existingConfig = (config.upstreams || []).find((item) => item.name === payloadName);
    const upstreamConfig = validateUpstreamPayload({
      ...payload,
      enabled: true,
      replace: Boolean(existingConfig || payload?.replace)
    }, config);
    const upstream = createUpstreamState(upstreamConfig, -1);
    const claudeCheck = await checkClaudeCapability(upstream, config);
    return jsonResponse(res, 200, {
      ok: true,
      upstream: upstream.name,
      claude_check: claudeCheck
    });
  }

  if (req.method === 'POST' && pathname === '/pool/test-curl') {
    const payload = await readJsonBody(req, maxBodyBytes);
    const result = await runCurlTest(payload, config);
    return jsonResponse(res, 200, result);
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
    const previousModel = state.modelOverride;
    state.modelOverride = model;
    config.model_override = model;
    if (previousModel !== model) {
      invalidateHealthForModelChange(state, model);
      persistStats(state, statsPath);
    }
    await saveConfig(config, options.configPath);
    return jsonResponse(res, 200, { ok: true, model_override: model });
  }

  if (req.method === 'POST' && pathname === '/pool/compatibility') {
    const payload = await readJsonBody(req, maxBodyBytes);
    if (!config.compatibility || typeof config.compatibility !== 'object' || Array.isArray(config.compatibility)) {
      config.compatibility = {};
    }
    if (!config.compatibility.adapter_mode || typeof config.compatibility.adapter_mode !== 'object' || Array.isArray(config.compatibility.adapter_mode)) {
      config.compatibility.adapter_mode = {};
    }
    const adapterMode = config.compatibility.adapter_mode;
    if (Object.prototype.hasOwnProperty.call(payload, 'strip_responses_only_features')) {
      adapterMode.strip_responses_only_features = booleanOption(payload.strip_responses_only_features, false);
    }
    if (payload.adapters && typeof payload.adapters === 'object' && !Array.isArray(payload.adapters)) {
      adapterMode.adapters = {
        ...(adapterMode.adapters && typeof adapterMode.adapters === 'object' && !Array.isArray(adapterMode.adapters) ? adapterMode.adapters : {}),
        ...(Object.prototype.hasOwnProperty.call(payload.adapters, 'anthropic_messages')
          ? { anthropic_messages: booleanOption(payload.adapters.anthropic_messages, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload.adapters, 'chat_completions')
          ? { chat_completions: booleanOption(payload.adapters.chat_completions, false) }
          : {})
      };
    }
    state.compatibility = normalizeCompatibilityConfig(config.compatibility);
    await saveConfig(config, options.configPath);
    return jsonResponse(res, 200, { ok: true, compatibility: createStatusPayload(config, state).compatibility });
  }

  const debugLockMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/debug-lock$/);
  if (req.method === 'POST' && debugLockMatch) {
    const name = decodeURIComponent(debugLockMatch[1]);
    const payload = await readJsonBody(req, maxBodyBytes);
    const upstream = state.upstreams.find((item) => item.name === name);
    if (!upstream) {
      return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    }
    if (upstream.codexOAuth || upstream.api === 'codex-oauth') {
      return jsonResponse(res, 400, {
        error: `Codex OAuth upstreams cannot be locked (require per-request authentication): ${name}`
      });
    }
    const result = enableDebugLock(state, name, {
      respect_model_override: payload.respect_model_override
    });
    // Add advisory notes for quarantined/disabled/missing-key upstreams
    if (upstream.quarantined) {
      result.debug_lock.note = 'Upstream is quarantined but accessible in debug lock mode';
    } else if (upstream.disabled || upstream.enabled === false) {
      result.debug_lock.note = 'Upstream is disabled but accessible in debug lock mode';
    }
    const validKeys = (upstream.keys || []).filter((k) => k.env && process.env[k.env]);
    if (validKeys.length === 0) {
      result.debug_lock.warning = 'No valid upstream keys found. Requests will fail with auth error.';
    }
    return jsonResponse(res, 200, result);
  }

  if (req.method === 'POST' && pathname === '/pool/debug-unlock') {
    const result = disableDebugLock(state);
    if (!result.ok) {
      return jsonResponse(res, 400, result);
    }
    return jsonResponse(res, 200, result);
  }

  if (req.method === 'POST' && pathname === '/pool/codex-oauth/import') {
    const payload = await readJsonBody(req, maxBodyBytes);
    const importResult = importCodexOAuthAccountsIntoConfig(payload, config, runtime.secrets || {}, {
      replace: url.searchParams.get('replace') ?? undefined
    });
    if (importResult.added || importResult.replaced) {
      runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
      await saveConfig(config, options.configPath);
      await saveSecrets(runtime.secrets || {}, runtime.secretsPath);
      persistStats(state, statsPath);
    }
    const statusCode = importResult.added || importResult.replaced
      ? 201
      : importResult.failed && !importResult.skipped
        ? 400
        : 200;
    return jsonResponse(res, statusCode, {
      ok: Boolean(importResult.added || importResult.replaced || importResult.skipped),
      action: 'codex_oauth_imported',
      persisted: Boolean(options.configPath),
      secrets_persisted: Boolean(runtime.secretsPath),
      ...importResult
    });
  }

  const codexOauthEnabledMatch = pathname.match(/^\/pool\/codex-oauth\/accounts\/([^/]+)\/enabled$/);
  if (req.method === 'POST' && codexOauthEnabledMatch) {
    const name = decodeURIComponent(codexOauthEnabledMatch[1]);
    const payload = await readJsonBody(req, maxBodyBytes);
    if (typeof payload.enabled !== 'boolean') {
      return jsonResponse(res, 400, { error: 'enabled must be a boolean' });
    }
    const oauthConfig = ensureCodexOAuthConfig(config);
    const accountIndex = oauthConfig.accounts.findIndex((item) => item.name === name);
    if (accountIndex < 0) return jsonResponse(res, 404, { error: `codex oauth account not found: ${name}` });
    oauthConfig.accounts[accountIndex] = {
      ...oauthConfig.accounts[accountIndex],
      enabled: payload.enabled,
      quarantined: undefined
    };
    runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    const upstream = state.upstreams.find((item) => item.name === name);
    const health = upstream?.enabled ? await probeOneUpstream(state, upstream, config) : upstream?.health || null;
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, ...probeResultPayload(health, state.modelOverride), account: name, enabled: payload.enabled, health });
  }

  const codexOauthProbeMatch = pathname.match(/^\/pool\/codex-oauth\/accounts\/([^/]+)\/probe$/);
  if (req.method === 'POST' && codexOauthProbeMatch) {
    const name = decodeURIComponent(codexOauthProbeMatch[1]);
    const payload = await readJsonBody(req, maxBodyBytes);
    const probeModel = probeModelFromPayload(payload);
    if (probeModel.length > 200) {
      return jsonResponse(res, 400, { error: 'probe_model must be 200 chars or fewer' });
    }
    const effectiveProbeModel = probeModel || state.modelOverride;
    const diagnosticOnly = effectiveProbeModel !== state.modelOverride;
    const upstream = state.upstreams.find((item) => item.name === name && item.codexOAuth);
    if (!upstream) return jsonResponse(res, 404, { error: `codex oauth account not found: ${name}` });
    const health = await probeOneUpstream(state, upstream, config, { live: true, probeModel: effectiveProbeModel });
    if (!diagnosticOnly) persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, ...probeResultPayload(health, effectiveProbeModel), account: name, probe_model: effectiveProbeModel, diagnostic_only: diagnosticOnly, health });
  }

  const quarantineMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/quarantine$/);
  if (req.method === 'POST' && quarantineMatch) {
    const name = decodeURIComponent(quarantineMatch[1]);
    const payload = await readJsonBody(req, maxBodyBytes);
    if (typeof payload.quarantined !== 'boolean') {
      return jsonResponse(res, 400, { error: 'quarantined must be a boolean' });
    }
    const existingIndex = (config.upstreams || []).findIndex((item) => item.name === name);
    if (existingIndex >= 0) {
      config.upstreams[existingIndex] = {
        ...config.upstreams[existingIndex],
        enabled: true,
        quarantined: payload.quarantined || undefined
      };
    } else {
      const oauthConfig = ensureCodexOAuthConfig(config);
      const accountIndex = oauthConfig.accounts.findIndex((item) => item.name === name);
      if (accountIndex < 0) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
      oauthConfig.accounts[accountIndex] = {
        ...oauthConfig.accounts[accountIndex],
        enabled: true,
        quarantined: payload.quarantined || undefined
      };
    }
    runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    const upstream = state.upstreams.find((item) => item.name === name);
    const health = upstream && !payload.quarantined ? await probeOneUpstream(state, upstream, config, { live: true }) : upstream?.health || null;
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, ...probeResultPayload(health, state.modelOverride), upstream: name, quarantined: payload.quarantined, enabled: upstream?.enabled !== false, health });
  }

  const enabledMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/enabled$/);
  if (req.method === 'POST' && enabledMatch) {
    const name = decodeURIComponent(enabledMatch[1]);
    const payload = await readJsonBody(req, maxBodyBytes);
    if (typeof payload.enabled !== 'boolean') {
      return jsonResponse(res, 400, { error: 'enabled must be a boolean' });
    }
    const existingIndex = (config.upstreams || []).findIndex((item) => item.name === name);
    if (existingIndex >= 0) {
      config.upstreams[existingIndex] = {
        ...config.upstreams[existingIndex],
        enabled: payload.enabled,
        quarantined: undefined
      };
    } else {
      const oauthConfig = ensureCodexOAuthConfig(config);
      const accountIndex = oauthConfig.accounts.findIndex((item) => item.name === name);
      if (accountIndex < 0) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
      oauthConfig.accounts[accountIndex] = {
        ...oauthConfig.accounts[accountIndex],
        enabled: payload.enabled,
        quarantined: undefined
      };
    }
    runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    const upstream = state.upstreams.find((item) => item.name === name);
    const health = upstream?.enabled ? await probeOneUpstream(state, upstream, config) : upstream?.health || null;
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, ...probeResultPayload(health, state.modelOverride), upstream: name, enabled: payload.enabled, health });
  }

  const signinMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/signin$/);
  if (req.method === 'POST' && signinMatch) {
    const name = decodeURIComponent(signinMatch[1]);
    const payload = await readJsonBody(req, maxBodyBytes);
    if (payload.signin_available !== undefined && typeof payload.signin_available !== 'boolean') {
      return jsonResponse(res, 400, { error: 'signin_available must be a boolean' });
    }
    if (payload.signin_completed !== undefined && typeof payload.signin_completed !== 'boolean') {
      return jsonResponse(res, 400, { error: 'signin_completed must be a boolean' });
    }
    if (payload.signin_available === undefined && payload.signin_completed === undefined) {
      return jsonResponse(res, 400, { error: 'signin_available or signin_completed is required' });
    }

    const applySigninState = (entry, defaultAvailable) => {
      const currentAvailable = booleanOption(signinAvailableValue(entry), defaultAvailable);
      const signinAvailable = payload.signin_available === undefined ? currentAvailable : payload.signin_available;
      let signinCompletedDate = signinCompletionDate(entry);
      if (!signinAvailable && payload.signin_completed === true) {
        const error = new Error('upstream is currently marked as not sign-in available');
        error.statusCode = 400;
        throw error;
      }
      if (payload.signin_completed !== undefined) {
        signinCompletedDate = payload.signin_completed ? localDateKey() : '';
      }
      if (signinCompletedDate !== localDateKey()) signinCompletedDate = '';
      if (!signinAvailable) signinCompletedDate = '';
      entry.signin_available = signinAvailable;
      entry.signin_completed_date = signinCompletedDate;
      delete entry.signin_completed;
      return { signinAvailable, signinCompletedDate };
    };

    let signinState = null;
    const existingIndex = (config.upstreams || []).findIndex((item) => item.name === name);
    try {
      if (existingIndex >= 0) {
        const entry = config.upstreams[existingIndex];
        const siteUrl = deriveSiteUrl(entry.base_url, entry.site_url);
        signinState = applySigninState(entry, Boolean(siteUrl));
      } else {
        const oauthConfig = ensureCodexOAuthConfig(config);
        const accountIndex = oauthConfig.accounts.findIndex((item) => item.name === name);
        if (accountIndex < 0) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
        signinState = applySigninState(oauthConfig.accounts[accountIndex], true);
      }
    } catch (error) {
      if (error.statusCode) return jsonResponse(res, error.statusCode, { error: error.message });
      throw error;
    }

    runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    persistStats(state, statsPath);
    const today = localDateKey();
    return jsonResponse(res, 200, {
      ok: true,
      upstream: name,
      signin_available: signinState.signinAvailable,
      signin_status: signinStatus(signinState.signinAvailable, signinState.signinCompletedDate, today),
      signin_completed: signinState.signinAvailable && signinState.signinCompletedDate === today,
      signin_completed_date: visibleSigninCompletedDate(signinState.signinAvailable, signinState.signinCompletedDate, today),
      persisted: Boolean(options.configPath)
    });
  }

  const claudeCheckMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/claude-check$/);
  if (req.method === 'POST' && claudeCheckMatch) {
    const name = decodeURIComponent(claudeCheckMatch[1]);
    const upstream = state.upstreams.find((item) => item.name === name);
    if (!upstream) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    const claudeCheck = await checkClaudeCapability(upstream, config);
    return jsonResponse(res, 200, {
      ok: true,
      upstream: name,
      claude_check: claudeCheck
    });
  }

  const deleteMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const name = decodeURIComponent(deleteMatch[1]);
    const deleted = deleteUpstreamFromConfig(config, runtime.secrets || {}, name);
    if (!deleted.found) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    if (deleted.removedSecrets > 0) await saveSecrets(runtime.secrets || {}, runtime.secretsPath);
    persistStats(state, statsPath, { immediate: true });
    return jsonResponse(res, 200, {
      ok: true,
      action: 'deleted',
      upstream: name,
      persisted: Boolean(options.configPath),
      secrets_persisted: deleted.removedSecrets > 0 && Boolean(runtime.secretsPath),
      removed_upstreams: deleted.removedUpstreams,
      removed_accounts: deleted.removedAccounts,
      removed_secrets: deleted.removedSecrets
    });
  }

  if (req.method === 'POST' && pathname === '/pool/upstreams') {
    const payload = await readJsonBody(req, maxBodyBytes);
    const payloadName = String(payload?.name || '').trim();
    const existingConfig = (config.upstreams || []).find((item) => item.name === payloadName);
    const hasExplicitProtocol = Object.prototype.hasOwnProperty.call(payload || {}, 'api') || Object.prototype.hasOwnProperty.call(payload || {}, 'probe_auth');
    const canAutoDetectApi = !hasExplicitProtocol && !existingConfig?.api && !existingConfig?.probe_auth;
    const upstream = validateUpstreamPayload(payload, config);
    const existingIndex = (config.upstreams || []).findIndex((item) => item.name === upstream.name);
    if (!Array.isArray(config.upstreams)) config.upstreams = [];
    if (existingIndex >= 0) config.upstreams.splice(existingIndex, 1, upstream);
    else config.upstreams.push(upstream);
    runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    const added = state.upstreams.find((item) => item.name === upstream.name);
    let health = added ? await probeOneUpstream(state, added, config) : null;
    let detectedApi = null;
    if (canAutoDetectApi) {
      const detection = await maybeAutoDetectApi(config, state, upstream.name, health, options, runtime.rebuildRuntimeUpstreams);
      health = detection.health;
      detectedApi = detection.detectedApi;
    }
    persistStats(state, statsPath);
    return jsonResponse(res, existingIndex >= 0 ? 200 : 201, {
      ok: true,
      action: existingIndex >= 0 ? 'replaced' : 'added',
      upstream: upstream.name,
      api: config.upstreams.find((item) => item.name === upstream.name)?.api || upstream.api,
      api_detected: detectedApi,
      persisted: Boolean(options.configPath),
      plaintext_key_warning: upstream.keys.some((key) => key.value) ? 'one or more keys were saved as plaintext values' : null,
      ...probeResultPayload(health, state.modelOverride),
      capabilities: added ? normalizeProtocolCapabilities(added.capabilities) : undefined,
      health
    });
  }

  if (req.method === 'POST' && pathname === '/pool/import/upstreams') {
    const payload = await readJsonBody(req, maxBodyBytes);
    const importResult = shouldImportAsCodexOAuthAccounts(payload)
      ? importCodexOAuthAccountsIntoConfig(payload, config, runtime.secrets || {}, {
          replace: url.searchParams.get('replace') ?? undefined
        })
      : importUpstreamsIntoConfig(payload, config, {
          replace: url.searchParams.get('replace') ?? undefined,
          secretMode: url.searchParams.get('secret_mode') ?? undefined
        });
    if (importResult.added || importResult.replaced) {
      runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
      await saveConfig(config, options.configPath);
      if (shouldImportAsCodexOAuthAccounts(payload)) await saveSecrets(runtime.secrets || {}, runtime.secretsPath);
      persistStats(state, statsPath);
    }
    const statusCode = importResult.added || importResult.replaced
      ? 201
      : importResult.failed && !importResult.skipped
        ? 400
        : 200;
    return jsonResponse(res, statusCode, {
      ok: Boolean(importResult.added || importResult.replaced || importResult.skipped),
      action: 'imported',
      persisted: Boolean(options.configPath),
      ...importResult,
      plaintext_key_warning: importResult.plaintextKeyCount > 0
        ? `${importResult.plaintextKeyCount} key(s) were saved as plaintext values`
        : null
    });
  }

  const probeMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/probe$/);
  if (req.method === 'POST' && probeMatch) {
    const name = decodeURIComponent(probeMatch[1]);
    const payload = await readJsonBody(req, maxBodyBytes);
    const probeModel = probeModelFromPayload(payload);
    if (probeModel.length > 200) {
      return jsonResponse(res, 400, { error: 'probe_model must be 200 chars or fewer' });
    }
    const upstream = state.upstreams.find((item) => item.name === name);
    if (!upstream) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    const effectiveProbeModel = effectiveProbeModelForUpstream(upstream, probeModel, state.modelOverride);
    const diagnosticOnly = effectiveProbeModel !== state.modelOverride;
    const health = await probeOneUpstream(state, upstream, config, { live: true, probeModel: effectiveProbeModel });
    if (!diagnosticOnly) persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, ...probeResultPayload(health, effectiveProbeModel), upstream: name, probe_model: effectiveProbeModel, diagnostic_only: diagnosticOnly, health });
  }

  const billingMatch = pathname.match(/^\/pool\/upstreams\/([^/]+)\/billing$/);
  if (req.method === 'POST' && billingMatch) {
    const name = decodeURIComponent(billingMatch[1]);
    const upstream = state.upstreams.find((item) => item.name === name);
    if (!upstream) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    const billing = await safeProbeOneBilling(upstream, config);
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, upstream: name, billing: billingPayload(billing, upstream.billingConfig) });
  }

  return jsonResponse(res, 404, { error: 'pool API route not found' });
}

export function createPoolServer(config, options = {}) {
  const logger = options.logger || console;
  const serverConfig = config.server || {};
  const publicPrefix = normalizePrefix(serverConfig.public_prefix || '/v1');
  const maxBodyBytes = Number(serverConfig.max_body_bytes || 50 * 1024 * 1024);
  const timeoutMs = Number(serverConfig.request_timeout_ms || 180000);
  const statsPath = options.statsPath || path.resolve(path.dirname(options.configPath || DEFAULT_CONFIG_PATH), config.stats?.path || 'stats.local.json');
  const secretsPath = options.secretsPath || (options.configPath ? defaultSecretsPath(options.configPath, config) : '');
  const secrets = options.secrets && typeof options.secrets === 'object' && !Array.isArray(options.secrets)
    ? options.secrets
    : loadSecretsSync(secretsPath);
  const runtimeConfig = () => materializeRuntimeConfig(config, secrets);
  const rebuildRuntimeUpstreams = () => rebuildUpstreams(state, runtimeConfig());
  const state = buildState(runtimeConfig());
  restoreStats(state, statsPath);
  const healthTimer = startHealthLoop(state, config, logger);
  scheduleStartupProbe(state, config, statsPath, logger);
  const runtime = { secrets, secretsPath, rebuildRuntimeUpstreams };

  const server = http.createServer(async (req, res) => {
    let clientAborted = false;
    req.on('aborted', () => {
      clientAborted = true;
    });
    res.on('close', () => {
      if (!res.writableEnded) clientAborted = true;
    });
    try {
      const pathname = new URL(req.url || '/', 'http://codex-api-pool.local').pathname;

      if (pathname === '/health' || pathname.startsWith('/pool/')) {
        return await handlePoolApi(req, res, config, state, options, statsPath, runtime);
      }

      // Handle Messages API entry point
      if (pathname === '/v1/messages') {
        if (!isAuthorized(req, config)) {
          return anthropicErrorResponse(res, 401, 'authentication_error', 'unauthorized: invalid API pool token');
        }

        if (state.upstreams.length === 0) {
          return anthropicErrorResponse(res, 503, 'overloaded_error', 'no upstreams configured');
        }

        const originalBody = await readBody(req, maxBodyBytes);
        const incomingHeaderSample = captureIncomingRequestHeaders(config, req.headers);
        let payload;
        try {
          payload = JSON.parse(originalBody.toString('utf8') || '{}');
        } catch (error) {
          return anthropicErrorResponse(res, 400, 'invalid_request_error', `invalid JSON body: ${error.message}`);
        }

        // Validate required fields
        if (!payload.model || typeof payload.model !== 'string') {
          return anthropicErrorResponse(res, 400, 'invalid_request_error', 'missing required field: model');
        }
        if (!Array.isArray(payload.messages)) {
          return anthropicErrorResponse(res, 400, 'invalid_request_error', 'missing required field: messages');
        }
        if (typeof payload.max_tokens !== 'number' || payload.max_tokens <= 0) {
          return anthropicErrorResponse(res, 400, 'invalid_request_error', 'missing or invalid required field: max_tokens');
        }

        // Check for Messages-only Features when no Anthropic upstream is available
        const originalModel = payload.model;
        const requestedModel = state.modelOverride || originalModel;

        // Strict validation: Messages API only supports Claude models
        if (requestedModel && !isClaudeModel(requestedModel)) {
          return anthropicErrorResponse(
            res,
            400,
            'invalid_request_error',
            `Messages API does not support model "${requestedModel}". Use /v1/responses or /v1/chat/completions for GPT models.`
          );
        }

        // Check if we have any Anthropic-capable upstreams
        const hasAnthropicUpstream = state.upstreams.some(upstream => {
          if (!upstream.enabled || upstream.quarantined) return false;
          const api = upstream.api || 'openai';
          return api === 'anthropic' || api === 'both';
        });

        // Check for adapter mode configuration
        const adapterModeEnabled = Boolean(state.compatibility?.adapterMode?.adapters?.chatCompletions);
        const stripMessagesOnlyFeatures = Boolean(state.compatibility?.adapterMode?.stripMessagesOnlyFeatures);

        // Detect Messages-only features
        const messagesOnlyFeatures = messagesOnlyFeaturesFromBody(req, originalBody, { inferJsonLike: false });
        const hasMessagesOnlyFeatures = messagesOnlyFeatures.length > 0;

        // Decide routing strategy
        const canUseAdapter = !hasAnthropicUpstream && adapterModeEnabled;
        const needsAdapter = canUseAdapter || (hasMessagesOnlyFeatures && !hasAnthropicUpstream);

        // Block if we have Messages-only features but can't handle them
        if (hasMessagesOnlyFeatures && !hasAnthropicUpstream && !adapterModeEnabled) {
          const featureList = messagesOnlyFeatures.join(', ');
          return anthropicErrorResponse(
            res,
            422,
            'invalid_request_error',
            `Request contains Messages-only features that cannot be converted to available upstreams: ${featureList}. Enable adapter compatibility mode to strip these features.`
          );
        }

        if (hasMessagesOnlyFeatures && !hasAnthropicUpstream && !stripMessagesOnlyFeatures) {
          const featureList = messagesOnlyFeatures.join(', ');
          return anthropicErrorResponse(
            res,
            422,
            'invalid_request_error',
            `Request contains Messages-only features: ${featureList}. Enable strip_messages_only_features in compatibility mode.`
          );
        }

        const tried = new Set();
        const maxAttempts = Math.max(1, state.retry.maxAttempts);

        let networkAttempt = 1;
        while (networkAttempt <= maxAttempts) {
          const routingAt = now();

          // Select upstream based on routing strategy
          const candidate = chooseCandidate(state, tried, {
            preferredModel: requestedModel,
            preferredProtocol: 'anthropic_messages',
            targetProtocol: 'anthropic_messages',
            allowUnknownModelFallback: networkAttempt > 1,
            candidateFilter: canUseAdapter
              ? null  // Allow any upstream when using adapter
              : (upstream) => {
                  // Only select Anthropic-capable upstreams for native forwarding
                  const api = upstream.api || 'openai';
                  return api === 'anthropic' || api === 'both';
                }
          });

          if (!candidate) break;

          const { upstream, key } = candidate;
          tried.add(`${upstream.name}:${key.index}`);
          const forwardedModel = forwardModelForUpstream(upstream, requestedModel);

          const attempt = networkAttempt;
          networkAttempt += 1;
          const allowRetry = attempt < maxAttempts;

          // Determine if we need to use the adapter for this upstream
          const upstreamApi = upstream.api || 'openai';
          const useAdapter = upstreamApi === 'openai' || (upstreamApi === 'both' && canUseAdapter);
          // When the Messages→Chat adapter strips Messages-only features, surface
          // the conversion in the response header and Recent Request Timeline so
          // stripping is never silent (CORE_FEATURES §3, §11).
          const messagesAdapterCompatibility = useAdapter && stripMessagesOnlyFeatures
            ? buildMessagesAdapterCompatibility(originalBody)
            : null;
          const messagesProtocol = deriveRecordingProtocol({ pathname: '/v1/messages', useAdapter });
          const routeTrace = attachForwardedModelTrace(requestRouteTrace({ pathname }), requestedModel, forwardedModel);

          let targetUrl, requestBody, requestHeaders;

          if (useAdapter) {
            // Adapter path: Messages → Chat Completions
            targetUrl = joinUrlPath(upstream.baseUrl, chatCompletionsPathForBaseUrl(upstream.baseUrl));
            try {
              requestBody = buildChatCompletionsFromMessages(
                rewriteModelInBody(req, originalBody, forwardedModel, { inferJsonLike: false }),
                forwardedModel,
                { stripMessagesOnlyFeatures }
              );
            } catch (error) {
              recordFailure(state, upstream, key, `conversion error: ${error.message}`, 0, null);
              recordAvailabilityAttempt(upstream, messagesProtocol, false);
              if (!allowRetry) {
                persistStats(state, statsPath);
                return anthropicErrorResponse(res, 500, 'api_error', `Request conversion failed: ${error.message}`);
              }
              continue;
            }
            requestHeaders = buildJsonRequestHeaders(targetUrl, key.value, req.headers);
          } else {
            // Native path: Messages → Messages
            targetUrl = joinUrlPath(upstream.baseUrl, anthropicMessagesPathForBaseUrl(upstream.baseUrl));
            requestBody = rewriteModelInBody(req, originalBody, forwardedModel, { inferJsonLike: false });
            requestHeaders = buildAnthropicRequestHeaders(targetUrl, key.value, req.headers, upstream.probeHeaders);
          }

          try {
            // Choose http or https based on targetUrl protocol
            const protocol = new URL(targetUrl).protocol === 'https:' ? https : http;
            const upstreamReq = protocol.request(targetUrl, {
              method: 'POST',
              headers: requestHeaders,
              timeout: timeoutMs
            });

            const attemptStart = now();
            let streamingBoundaryReached = false;
            const isStreaming = payload.stream === true;

            upstreamReq.on('response', (response) => {
              const statusCode = response.statusCode || 500;

              if (statusCode >= 200 && statusCode < 300) {
                streamingBoundaryReached = true;
                recordSuccess(upstream, attemptStart, statusCode);
                recordAvailabilityAttempt(upstream, messagesProtocol, true);

                // Create usage capture for native forwarding
                const usageCapture = createUsageCapture(response.headers);

                // Handle response conversion if using adapter
                if (useAdapter) {
                  const contentType = response.headers['content-type'] || '';

                  if (isStreaming && contentType.includes('text/event-stream')) {
                    // Streaming adapter: Chat SSE → Messages SSE
                    const adapterHeaders = {
                      'content-type': 'text/event-stream',
                      'cache-control': 'no-cache',
                      'connection': 'keep-alive',
                      'x-codex-api-pool-upstream': upstream.name
                    };
                    if (messagesAdapterCompatibility) {
                      adapterHeaders['x-codex-api-pool-stripped'] = compatibilityStrippedHeader(messagesAdapterCompatibility.stripped);
                      adapterHeaders['x-codex-api-pool-compatibility'] = messagesAdapterCompatibility.mode;
                    }
                    res.writeHead(200, adapterHeaders);

                    const adapter = createChatToMessagesStreamAdapter(res, requestedModel);
                    response.on('data', (chunk) => {
                      usageCapture.push(chunk);
                      adapter.write(chunk);
                    });
                    response.on('end', () => {
                      adapter.end();
                      const capturedUsage = usageCapture.result();
                      const recordedTokens = recordTokenUsage(upstream, capturedUsage.tokens, attemptStart);

                      const routingStrategy = 'messages_to_chat_completions';
                      rememberRequest(state, {
                        method: 'POST',
                        path: '/v1/messages',
                        entry_protocol: 'messages',
                        ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
                        routing_strategy: routingStrategy,
                        upstream: upstream.name,
                        key: key.label,
                        model: requestedModel,
                        actualModel: requestedModel,
                        status: statusCode,
                        streaming: isStreaming,
                        retried: attempt > 1,
                        succeeded: true,
                        route: routeTrace,
                        tokens: recordedTokens.totalTokens,
                        inputTokens: recordedTokens.inputTokens,
                        outputTokens: recordedTokens.outputTokens,
                        durationMs: now() - attemptStart,
                        outcome: 'ok',
                        compatibility: messagesAdapterCompatibility ? compatibilitySummary(messagesAdapterCompatibility, routeTrace) : null
                      });
                      persistStats(state, statsPath);
                    });
                    response.on('error', (err) => {
                      console.error('Streaming adapter error:', err);
                      if (!res.writableEnded) res.end();
                    });
                  } else {
                    // JSON adapter: Chat JSON → Messages JSON
                    let responseBody = Buffer.alloc(0);
                    response.on('data', (chunk) => {
                      usageCapture.push(chunk);
                      responseBody = Buffer.concat([responseBody, chunk]);
                    });
                    response.on('end', () => {
                      try {
                        const convertedBody = chatCompletionToMessagesJson(responseBody, requestedModel);
                        const jsonAdapterHeaders = {
                          'content-type': 'application/json',
                          'content-length': convertedBody.length,
                          'x-codex-api-pool-upstream': upstream.name
                        };
                        if (messagesAdapterCompatibility) {
                          jsonAdapterHeaders['x-codex-api-pool-stripped'] = compatibilityStrippedHeader(messagesAdapterCompatibility.stripped);
                          jsonAdapterHeaders['x-codex-api-pool-compatibility'] = messagesAdapterCompatibility.mode;
                        }
                        res.writeHead(200, jsonAdapterHeaders);
                        res.end(convertedBody);

                        const capturedUsage = usageCapture.result();
                        const recordedTokens = recordTokenUsage(upstream, capturedUsage.tokens, attemptStart);

                        const routingStrategy = 'messages_to_chat_completions';
                        rememberRequest(state, {
                          method: 'POST',
                          path: '/v1/messages',
                          entry_protocol: 'messages',
                          ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
                          routing_strategy: routingStrategy,
                          upstream: upstream.name,
                          key: key.label,
                          model: requestedModel,
                          actualModel: requestedModel,
                          status: statusCode,
                          streaming: isStreaming,
                          retried: attempt > 1,
                          succeeded: true,
                          route: routeTrace,
                          tokens: recordedTokens.totalTokens,
                          inputTokens: recordedTokens.inputTokens,
                          outputTokens: recordedTokens.outputTokens,
                          durationMs: now() - attemptStart,
                          outcome: 'ok',
                          compatibility: messagesAdapterCompatibility ? compatibilitySummary(messagesAdapterCompatibility, routeTrace) : null
                        });
                        persistStats(state, statsPath);
                      } catch (error) {
                        console.error('Response conversion error:', error);
                        anthropicErrorResponse(res, 500, 'api_error', 'Response conversion failed');
                      }
                    });
                  }
                } else {
                  // Native forwarding: capture usage while forwarding
                  res.writeHead(statusCode, sanitizeResponseHeaders(response.headers, upstream.name));

                  response.on('data', (chunk) => {
                    usageCapture.push(chunk);
                    res.write(chunk);
                  });

                  response.on('end', () => {
                    res.end();

                    const capturedUsage = usageCapture.result();
                    const recordedTokens = recordTokenUsage(upstream, capturedUsage.tokens, attemptStart);

                    const routingStrategy = 'native_messages';
                    rememberRequest(state, {
                      method: 'POST',
                      path: '/v1/messages',
                      entry_protocol: 'messages',
                      ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
                      routing_strategy: routingStrategy,
                      upstream: upstream.name,
                      key: key.label,
                      model: requestedModel,
                      actualModel: requestedModel,
                      status: statusCode,
                      streaming: isStreaming,
                      retried: attempt > 1,
                      succeeded: true,
                      route: routeTrace,
                      tokens: recordedTokens.totalTokens,
                      inputTokens: recordedTokens.inputTokens,
                      outputTokens: recordedTokens.outputTokens,
                      durationMs: now() - attemptStart,
                      outcome: 'ok'
                    });
                    persistStats(state, statsPath);
                  });
                }
              } else {
                // Error response
                let errorBody = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { errorBody += chunk; });
                response.on('end', () => {
                  recordFailure(state, upstream, key, `HTTP ${statusCode}`, statusCode, response.headers['retry-after']);
                  recordAvailabilityAttempt(upstream, messagesProtocol, false);

                  // Record failed request for Dashboard (only if not retrying)
                  if (!allowRetry || streamingBoundaryReached) {
                    const routingStrategy = useAdapter
                      ? 'messages_to_chat_completions'
                      : 'native_messages';

                    rememberRequest(state, {
                      method: 'POST',
                      path: '/v1/messages',
                      entry_protocol: 'messages',
                      ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
                      routing_strategy: routingStrategy,
                      upstream: upstream.name,
                      key: key.label,
                      model: requestedModel,
                      actualModel: requestedModel,
                      status: statusCode,
                      streaming: isStreaming,
                      retried: attempt > 1,
                      succeeded: false,
                      reason: `HTTP ${statusCode}`,
                      route: routeTrace
                    });
                  }

                  if (allowRetry && !streamingBoundaryReached) {
                    return; // Will retry in next loop iteration
                  }

                  // Return error (convert if using adapter)
                  if (useAdapter) {
                    // Try to convert OpenAI error to Anthropic format
                    try {
                      const openaiError = JSON.parse(errorBody);
                      const message = openaiError.error?.message || errorBody;
                      anthropicErrorResponse(res, statusCode, 'api_error', message);
                    } catch {
                      res.writeHead(statusCode, { 'content-type': 'text/plain' });
                      res.end(errorBody);
                    }
                  } else {
                    res.writeHead(statusCode, response.headers);
                    res.end(errorBody);
                  }
                });
              }
            });

            upstreamReq.on('error', (error) => {
              if (!streamingBoundaryReached) {
                recordFailure(state, upstream, key, error.message, 0, null);
                recordAvailabilityAttempt(upstream, messagesProtocol, false);

                // Record failed request for Dashboard (only if not retrying)
                if (!allowRetry) {
                  const routingStrategy = useAdapter
                    ? 'messages_to_chat_completions'
                    : 'native_messages';

                  rememberRequest(state, {
                    method: 'POST',
                    path: '/v1/messages',
                    entry_protocol: 'messages',
                    ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
                    routing_strategy: routingStrategy,
                    upstream: upstream.name,
                    key: key.label,
                    model: requestedModel,
                    actualModel: requestedModel,
                    status: 0,
                    streaming: isStreaming,
                    retried: attempt > 1,
                    succeeded: false,
                    reason: error.message,
                    route: routeTrace
                  });
                }

                if (allowRetry) {
                  return; // Will retry in next loop iteration
                }
              }

              if (!res.headersSent) {
                return anthropicErrorResponse(res, 502, 'api_error', `upstream request failed: ${error.message}`);
              }
            });

            upstreamReq.on('timeout', () => {
              upstreamReq.destroy();
              if (!streamingBoundaryReached) {
                recordFailure(state, upstream, key, 'timeout', 0, null);
                recordAvailabilityAttempt(upstream, messagesProtocol, false);

                // Record timeout for Dashboard (only if not retrying)
                if (!allowRetry) {
                  const routingStrategy = useAdapter
                    ? 'messages_to_chat_completions'
                    : 'native_messages';

                  rememberRequest(state, {
                    method: 'POST',
                    path: '/v1/messages',
                    entry_protocol: 'messages',
                    ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
                    routing_strategy: routingStrategy,
                    upstream: upstream.name,
                    key: key.label,
                    model: requestedModel,
                    actualModel: requestedModel,
                    status: 504,
                    streaming: isStreaming,
                    retried: attempt > 1,
                    succeeded: false,
                    reason: 'timeout',
                    route: routeTrace
                  });
                }
              }
              if (!res.headersSent) {
                return anthropicErrorResponse(res, 504, 'timeout_error', 'upstream request timeout');
              }
            });

            upstreamReq.write(requestBody);
            upstreamReq.end();

            // Wait for response to complete
            await new Promise((resolve, reject) => {
              upstreamReq.on('error', reject);
              res.on('finish', resolve);
              res.on('error', reject);
            });

            persistStats(state, statsPath);
            return; // Success, exit handler
          } catch (error) {
            recordFailure(state, upstream, key, error.message, 0, null);
            recordAvailabilityAttempt(upstream, messagesProtocol, false);
            if (!allowRetry) {
              persistStats(state, statsPath);
              return anthropicErrorResponse(res, 502, 'api_error', `upstream request failed: ${error.message}`);
            }
            // Continue to next attempt
          }
        }

        // No candidates or all attempts failed
        rememberRequest(state, {
          method: 'POST',
          path: '/v1/messages',
          entry_protocol: 'messages',
          ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
          routing_strategy: hasAnthropicUpstream ? 'native_messages' : (adapterModeEnabled ? 'messages_to_chat_completions' : 'none'),
          upstream: null,
          key: null,
          model: requestedModel,
          status: 503,
          streaming: payload.stream === true,
          retried: networkAttempt > 1,
          succeeded: false,
          reason: 'no available upstreams'
        });
        persistStats(state, statsPath);
        return anthropicErrorResponse(res, 503, 'overloaded_error', 'no available upstreams for Messages API');
      }

      if (!isAuthorized(req, config)) {
        return jsonResponse(res, 401, { error: 'unauthorized: invalid Codex API pool token' });
      }

      if (state.upstreams.length === 0) {
        return jsonResponse(res, 503, { error: 'no upstreams configured', error_display: noUpstreamsConfiguredDisplay() });
      }

      // Check for Debug Lock Mode
      if (isDebugLockActive(state)) {
        const clientProtocol = pathname === '/v1/messages'
          ? 'anthropic_messages'
          : 'responses';

        return await executeDebugLockedRequest(req, res, state, config, {
          pathname,
          clientProtocol,
          statsPath,
          maxBodyBytes
        });
      }

      const originalBody = await readBody(req, maxBodyBytes);
      const incomingHeaderSample = captureIncomingRequestHeaders(config, req.headers);
      const responsesJsonOptions = { inferJsonLike: pathname === '/v1/responses' };
      const originalModel = modelFromBody(req, originalBody, responsesJsonOptions);
      const requestedModel = isClaudeModel(originalModel)
        ? originalModel
        : state.modelOverride || originalModel;
      const requestedAdapter = isClaudeModel(requestedModel) ? 'anthropic_messages' : 'chat_completions';
      const tried = new Set();
      const attempts = [];
      const maxAttempts = Math.max(1, state.retry.maxAttempts);
      const unsupportedToolTypes = pathname === '/v1/responses'
        ? unsupportedResponsesToolTypesFromBody(req, originalBody, responsesJsonOptions)
        : [];
      const hasUnsupportedResponsesTools = unsupportedToolTypes.length > 0;
      const unsupportedChatOutputFormatTypes = pathname === '/v1/responses'
        ? unconvertibleChatOutputFormatTypesFromBody(req, originalBody, responsesJsonOptions)
        : [];
      const hasUnsupportedChatOutputFormat = unsupportedChatOutputFormatTypes.length > 0;
      const unsupportedInputTypes = pathname === '/v1/responses'
        ? unsupportedResponsesInputTypesFromBody(req, originalBody, { ...responsesJsonOptions, targetAdapter: requestedAdapter })
        : [];
      const hasUnsupportedInputTypes = unsupportedInputTypes.length > 0;
      const unsupportedFieldTypes = pathname === '/v1/responses'
        ? unsupportedResponsesFieldTypesFromBody(req, originalBody, { ...responsesJsonOptions, targetAdapter: requestedAdapter })
        : [];
      const hasUnsupportedFieldTypes = unsupportedFieldTypes.length > 0;
      const requiresNativeResponses = hasUnsupportedResponsesTools || hasUnsupportedChatOutputFormat || hasUnsupportedInputTypes || hasUnsupportedFieldTypes;
      let activeRequiresNativeResponses = requiresNativeResponses;
      let activeBody = originalBody;
      let compatibilityPlan = null;
      const originalBodyIsJson = Boolean(jsonObjectFromRequestBody(req, originalBody, responsesJsonOptions));
      const modelInteractionRequest = isModelInteractionRequest(req.method, pathname);

      if (modelInteractionRequest) {
        captureRepresentativeRequestTemplate(state, {
          req,
          pathname,
          body: originalBody,
          model: requestedModel,
          options: responsesJsonOptions
        });
      }

      let networkAttempt = 1;
      while (networkAttempt <= maxAttempts) {
        const routingAt = now();
        const sharedTargetProtocol = deriveRecordingProtocol({ pathname, upstreamApi: 'passthrough' });
        const candidate = chooseCandidate(state, tried, {
          preferredModel: requestedModel,
          preferredProtocol: pathname === '/v1/responses' && !shouldUseAnthropicResponsesAdapter(pathname, requestedModel) ? 'responses' : '',
          targetProtocol: sharedTargetProtocol || '',
          allowUnknownModelFallback: networkAttempt > 1,
          candidateFilter: activeRequiresNativeResponses
            ? (upstream) => {
                if (canAttemptNativeResponses(pathname, upstream, requestedModel, {
                  at: routingAt,
                  nativeResponsesRecheckMs: state.retry.nativeResponsesRecheckMs
                })) return true;
                return routeStrategyUsesChatCompletions(routeStrategyForUpstream(upstream, requestedModel)) &&
                  compatibilityAdapterAllowed(state, requestedModel);
              }
            : null
        });
        if (!candidate && activeRequiresNativeResponses && !compatibilityPlan && pathname === '/v1/responses') {
          compatibilityPlan = buildAdapterCompatibilityPlan({
            req,
            body: originalBody,
            model: requestedModel,
            state,
            options: responsesJsonOptions
          });
          if (compatibilityPlan) {
            activeRequiresNativeResponses = false;
            activeBody = compatibilityPlan.strippedBody;
            tried.clear();
            continue;
          }
        }
        if (!candidate) break;

        const { upstream, key } = candidate;
        tried.add(`${upstream.name}:${key.index}`);

        // Codex OAuth: proactively refresh a (near-)expired access token before
        // forwarding (CORE_FEATURES §12). If refresh is unavailable or fails,
        // treat this upstream as not currently usable and retry/fallback.
        if (upstream.codexOAuth) {
          const refreshed = await ensureCodexOAuthFresh({ upstream, runtime, config });
          if (!refreshed) {
            recordFailure(state, upstream, key, 'oauth_refresh_failed', 0, null);
            continue;
          }
        }

        const attemptedModel = requestedModel;
        const forwardedModel = forwardModelForUpstream(upstream, attemptedModel);
        const learnedRouteStrategy = routeStrategyForUpstream(upstream, attemptedModel);
        const routePlan = planProtocolRoute({ pathname, upstream, model: attemptedModel, requiresNativeResponses: activeRequiresNativeResponses });
        const { useAnthropicAdapter, canUseChatAdapter, allowChatCompletionsAdapter, useCodexOAuth } = routePlan;
        const forceNativeResponses = routeStrategyUsesNativeResponses(learnedRouteStrategy);
        const nativeResponsesAttemptAllowed = canAttemptNativeResponses(pathname, upstream, attemptedModel, {
          at: routingAt,
          nativeResponsesRecheckMs: state.retry.nativeResponsesRecheckMs
        });
        const forceChatCompletions = !forceNativeResponses &&
          !nativeResponsesAttemptAllowed &&
          canUseChatAdapter &&
          routeStrategyUsesChatCompletions(learnedRouteStrategy);
        let { useChatCompletionsAdapter } = routePlan;
        if (nativeResponsesAttemptAllowed && canUseChatAdapter) {
          useChatCompletionsAdapter = false;
        }
        if (forceChatCompletions) {
          if (activeRequiresNativeResponses && !compatibilityPlan) {
            compatibilityPlan = buildAdapterCompatibilityPlan({
              req,
              body: originalBody,
              model: attemptedModel,
              state,
              options: responsesJsonOptions,
              trigger: 'learned_route_strategy'
            });
            if (compatibilityPlan) {
              activeRequiresNativeResponses = false;
              activeBody = compatibilityPlan.strippedBody;
            }
          }
          if (!activeRequiresNativeResponses) useChatCompletionsAdapter = true;
        } else if (forceNativeResponses) {
          useChatCompletionsAdapter = false;
        }

        const attempt = networkAttempt;
        networkAttempt += 1;
        const allowRetry = attempt < maxAttempts;
        let targetUrl = useAnthropicAdapter
          ? joinUrlPath(upstream.baseUrl, anthropicMessagesPathForBaseUrl(upstream.baseUrl))
          : useChatCompletionsAdapter
            ? joinUrlPath(upstream.baseUrl, chatCompletionsPathForBaseUrl(upstream.baseUrl))
            : useCodexOAuth
            ? codexOAuthTargetUrl(upstream.baseUrl, req.url || '/', publicPrefix)
            : joinTargetUrl(upstream.baseUrl, req.url || '/', publicPrefix);
        let body = useAnthropicAdapter
          ? buildAnthropicMessagesPayload(rewriteModelInBody(req, activeBody, forwardedModel, responsesJsonOptions), forwardedModel)
          : useChatCompletionsAdapter
            ? buildChatCompletionsPayload(rewriteModelInBody(req, activeBody, forwardedModel, responsesJsonOptions), forwardedModel)
          : rewriteModelInBody(req, activeBody, forwardedModel, responsesJsonOptions);
        const requestHeaders = useAnthropicAdapter
          ? buildAnthropicRequestHeaders(targetUrl, key.value, req.headers, upstream.probeHeaders)
          : useCodexOAuth
            ? buildCodexOAuthRequestHeaders(targetUrl, key.value, req.headers, codexOAuthExtraHeaders(upstream))
            : useChatCompletionsAdapter || originalBodyIsJson
              ? buildJsonRequestHeaders(targetUrl, key.value, req.headers)
              : undefined;
        let routeTrace = attachForwardedModelTrace(requestRouteTrace({
          pathname,
          useAnthropicAdapter,
          useChatCompletionsAdapter,
          useCodexOAuth,
          requiresNativeResponses: activeRequiresNativeResponses,
          unsupportedToolTypes,
          unsupportedOutputFormatTypes: unsupportedChatOutputFormatTypes,
          unsupportedInputTypes,
          unsupportedFieldTypes
        }), attemptedModel, forwardedModel);
        let compatibility = compatibilitySummary(compatibilityPlan, routeTrace);
        let requestHeadersForAttempt = requestHeaders;
        let requestMethod = useAnthropicAdapter || useChatCompletionsAdapter ? 'POST' : req.method;
        let attemptTimeoutMs = timeoutMs;
        if (
          allowChatCompletionsAdapter &&
          upstream.requestMode === 'auto' &&
          !upstream.resolvedRequestMode &&
          !useChatCompletionsAdapter
        ) {
          attemptTimeoutMs = chatFallbackProbeTimeoutMs(config, timeoutMs);
        }
        const chatFallbackAutoRetry = allowChatCompletionsAdapter &&
          !useChatCompletionsAdapter &&
          upstream.requestMode === 'auto';
        const retryableStatusForAttempt = activeRequiresNativeResponses
          ? retryableStatusWithNativeResponsesUnsupported(state.retry.retryableStatus)
          : state.retry.retryableStatus;
        if (modelInteractionRequest) recordAttempt(upstream, key);

        let result = await requestTrackedUpstream({
          req,
          body,
          targetUrl,
          upstream,
          key,
          timeoutMs: attemptTimeoutMs,
          allowRetry: allowRetry || chatFallbackAutoRetry || activeRequiresNativeResponses,
          retryableStatus: retryableStatusForAttempt,
          method: requestMethod,
          headers: requestHeadersForAttempt
        });
        if (
          result.type === 'retry' &&
          canUseChatAdapter &&
          !useChatCompletionsAdapter &&
          upstream.requestMode === 'auto'
        ) {
          if (activeRequiresNativeResponses && !compatibilityPlan) {
            compatibilityPlan = buildAdapterCompatibilityPlan({
              req,
              body: originalBody,
              model: attemptedModel,
              state,
              options: responsesJsonOptions,
              trigger: 'native_responses_failed'
            });
            if (compatibilityPlan) {
              activeRequiresNativeResponses = false;
              activeBody = compatibilityPlan.strippedBody;
            }
          }
          if (!activeRequiresNativeResponses) {
            useChatCompletionsAdapter = true;
            targetUrl = joinUrlPath(upstream.baseUrl, chatCompletionsPathForBaseUrl(upstream.baseUrl));
            body = buildChatCompletionsPayload(rewriteModelInBody(req, activeBody, forwardedModel, responsesJsonOptions), forwardedModel);
            requestHeadersForAttempt = buildJsonRequestHeaders(targetUrl, key.value, req.headers);
            requestMethod = 'POST';
            routeTrace = attachForwardedModelTrace(requestRouteTrace({
              pathname,
              useChatCompletionsAdapter: true,
              requiresNativeResponses: activeRequiresNativeResponses,
              unsupportedToolTypes,
              unsupportedOutputFormatTypes: unsupportedChatOutputFormatTypes,
              unsupportedInputTypes,
              unsupportedFieldTypes
            }), attemptedModel, forwardedModel);
            compatibility = compatibilitySummary(compatibilityPlan, routeTrace);
            result = await requestTrackedUpstream({
              req,
              body,
              targetUrl,
              upstream,
              key,
              timeoutMs,
              allowRetry,
              retryableStatus: state.retry.retryableStatus,
              method: requestMethod,
              headers: requestHeadersForAttempt
            });
          }
        }

        if (result.type === 'response') {
          applyQuota(upstream, key, result.response.headers);
          const usageCapture = createUsageCapture(result.response.headers);
          const isSuccessfulAnthropicAdapter = useAnthropicAdapter && result.statusCode >= 200 && result.statusCode < 300;
          const isSuccessfulChatAdapter = useChatCompletionsAdapter && result.statusCode >= 200 && result.statusCode < 300;
          const adaptAnthropicStream = isSuccessfulAnthropicAdapter && isEventStream(result.response.headers) && isUncompressedResponse(result.response.headers);
          const adaptAnthropicJson = isSuccessfulAnthropicAdapter && !isEventStream(result.response.headers) && isUncompressedResponse(result.response.headers);
          const adaptChatStream = isSuccessfulChatAdapter && isEventStream(result.response.headers) && isUncompressedResponse(result.response.headers);
          const adaptChatJson = isSuccessfulChatAdapter && !isEventStream(result.response.headers) && isUncompressedResponse(result.response.headers);
          const normalizeResponsesStream = !adaptAnthropicStream && !adaptChatStream && shouldNormalizeResponsesStream(pathname, result.response.headers);
          const headers = sanitizeResponseHeaders(result.response.headers, upstream.name);
          if (normalizeResponsesStream || adaptAnthropicStream || adaptAnthropicJson || adaptChatStream || adaptChatJson) deleteHeader(headers, 'content-length');
          if (adaptAnthropicStream) headers['content-type'] = 'text/event-stream; charset=utf-8';
          if (adaptAnthropicJson) headers['content-type'] = 'application/json; charset=utf-8';
          if (adaptChatStream) headers['content-type'] = 'text/event-stream; charset=utf-8';
          if (adaptChatJson) headers['content-type'] = 'application/json; charset=utf-8';
          addRouteTraceHeaders(headers, routeTrace);
          if (compatibility) {
            headers['x-codex-api-pool-compatibility'] = compatibility.mode;
            headers['x-codex-api-pool-compatibility-trigger'] = compatibility.trigger;
            headers['x-codex-api-pool-stripped'] = compatibilityStrippedHeader(compatibility.stripped);
            headers['x-codex-api-pool-converted'] = compatibilityBucketHeader(compatibility.converted);
            headers['x-codex-api-pool-downgraded'] = compatibilityBucketHeader(compatibility.downgraded);
          }
          res.writeHead(result.statusCode, headers);
          const anthropicStreamAdapter = adaptAnthropicStream
            ? createAnthropicResponsesStreamAdapter(res, attemptedModel)
            : null;
          const chatStreamAdapter = adaptChatStream
            ? createChatResponsesStreamAdapter(res, attemptedModel)
            : null;
          const responsesCompletionNormalizer = normalizeResponsesStream
            ? createResponsesCompletionNormalizer(res, attemptedModel)
            : null;
          const anthropicJsonChunks = adaptAnthropicJson ? [] : null;
          let anthropicJsonSize = 0;
          const chatJsonChunks = adaptChatJson ? [] : null;
          let chatJsonSize = 0;
          let upstreamStreamFinished = false;

          const handleUpstreamStreamFailure = (error) => {
            if (upstreamStreamFinished) return;
            upstreamStreamFinished = true;
            const errorMessage = error?.message || 'upstream stream closed before completion';
            const reason = result.statusCode >= 200 && result.statusCode < 400
              ? `upstream stream ended before completion after HTTP ${result.statusCode}: ${errorMessage}`
              : errorMessage;
            upstream.inFlight = Math.max(0, upstream.inFlight - 1);
            if (clientAborted) {
              if (modelInteractionRequest) {
                rememberRequest(state, {
                  method: req.method,
                  path: pathname,
                  entry_protocol: 'responses',
                  ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
                  upstream: upstream.name,
                  key: key.label,
                  originalModel: originalModel || null,
                  actualModel: attemptedModel || null,
                  status: 499,
                  durationMs: now() - result.startedAt,
                  retried: attempt > 1,
                  outcome: 'client_aborted',
                  reason: 'client disconnected before upstream stream completed',
                  route: routeTrace,
                  ...(compatibility ? { compatibility } : {})
                });
              }
              persistStats(state, statsPath);
              return;
            }
            if (modelInteractionRequest) {
              recordModelInteractionOutcome({
                state,
                upstream,
                key,
                statusCode: STREAM_ERROR_STATUS,
                startedAt: result.startedAt,
                retried: attempt > 1,
                succeeded: false,
                reason,
                protocol: deriveRecordingProtocol({ pathname, upstreamApi: routeTrace?.upstream_api })
              });
              rememberRequest(state, {
                method: req.method,
                path: pathname,
                entry_protocol: 'responses',
                ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
                upstream: upstream.name,
                key: key.label,
                originalModel: originalModel || null,
                actualModel: attemptedModel || null,
                status: STREAM_ERROR_STATUS,
                durationMs: now() - result.startedAt,
                retried: attempt > 1,
                outcome: 'stream_error',
                reason,
                route: routeTrace,
                ...(compatibility ? { compatibility } : {})
              });
            }
            persistStats(state, statsPath);
            if (!res.destroyed) res.destroy(error || new Error(reason));
          };

          result.response.on('data', (chunk) => {
            usageCapture.push(chunk);
            if (anthropicStreamAdapter) anthropicStreamAdapter.write(chunk);
            else if (chatStreamAdapter) chatStreamAdapter.write(chunk);
            else if (anthropicJsonChunks) {
              anthropicJsonSize += chunk.length;
              anthropicJsonChunks.push(chunk);
            } else if (chatJsonChunks) {
              chatJsonSize += chunk.length;
              chatJsonChunks.push(chunk);
            } else if (responsesCompletionNormalizer) responsesCompletionNormalizer.write(chunk);
            else res.write(chunk);
          });

          result.response.on('end', () => {
            if (upstreamStreamFinished) return;
            upstreamStreamFinished = true;
            if (anthropicStreamAdapter) anthropicStreamAdapter.end();
            else if (chatStreamAdapter) chatStreamAdapter.end();
            else if (anthropicJsonChunks) res.end(anthropicMessageToResponsesJson(Buffer.concat(anthropicJsonChunks, anthropicJsonSize), attemptedModel));
            else if (chatJsonChunks) res.end(chatCompletionToResponsesJson(Buffer.concat(chatJsonChunks, chatJsonSize), attemptedModel));
            else if (responsesCompletionNormalizer) responsesCompletionNormalizer.end();
            else res.end();
            upstream.inFlight = Math.max(0, upstream.inFlight - 1);
            const capturedUsage = usageCapture.result();
            const responseSucceeded = result.statusCode >= 200 &&
              result.statusCode < 400 &&
              capturedUsage.hasOutput &&
              !capturedUsage.hasExplicitZeroOutputTokens;
            if (modelInteractionRequest && responseSucceeded && routeTrace?.upstream_api) {
              const protocol = routeTrace.upstream_api === 'anthropic_messages'
                ? 'anthropic_messages'
                : routeTrace.upstream_api === 'chat_completions'
                  ? 'chat_completions'
                  : routeTrace.upstream_api === 'responses' || routeTrace.upstream_api === 'codex_oauth_responses'
                    ? 'responses'
                    : '';
              if (protocol) {
                if (upstream.requestMode === 'auto' && (protocol === 'chat_completions' || protocol === 'responses')) {
                  upstream.resolvedRequestMode = protocol;
                }
                const learnedStrategy = protocol === 'chat_completions'
                  ? compatibility
                    ? 'chat_completions_compatibility'
                    : 'chat_completions'
                  : protocol === 'responses'
                    ? 'responses'
                    : protocol === 'anthropic_messages'
                      ? compatibility
                        ? 'anthropic_messages_compatibility'
                        : 'anthropic_messages'
                      : protocol === 'codex_oauth_responses'
                        ? 'codex_oauth_responses'
                        : '';
                if (learnedStrategy) {
                  learnRouteStrategy(upstream, attemptedModel, learnedStrategy, {
                    source: 'real_traffic',
                    reason: routeTrace?.adapter || ''
                  });
                }
                upstream.cooldownUntil = 0;
                upstream.failures = 0;
                key.cooldownUntil = 0;
                key.failures = 0;
                const checkedAt = new Date().toISOString();
                recordProtocolCapabilityRealTraffic(upstream, protocol, {
                  checkedAt,
                  model: attemptedModel,
                  httpStatus: result.statusCode
                });
                updateHealthFromRealTraffic(upstream, key, {
                  checkedAt,
                  model: attemptedModel,
                  httpStatus: result.statusCode,
                  latencyMs: now() - result.startedAt,
                  protocol
                });
              }
            }
            const responseReason = responseSucceeded || result.statusCode >= 400
              ? `HTTP ${result.statusCode}`
              : capturedUsage.hasExplicitZeroOutputTokens
                ? `HTTP ${result.statusCode} with output tokens 0`
                : `HTTP ${result.statusCode} without concrete output`;
            if (modelInteractionRequest) {
              finishResponseAttempt({
                state,
                upstream,
                key,
                method: req.method,
                pathname,
                incomingHeaders: incomingHeaderSample,
                incomingBody: config.debug?.capture_request_headers === true ? originalBody : undefined,
                originalModel,
                attemptedModel,
                statusCode: result.statusCode,
                startedAt: result.startedAt,
                attempt,
                reason: responseReason,
                retryAfter: result.response.headers?.['retry-after'],
                tokenCount: capturedUsage.tokens,
                succeeded: responseSucceeded,
                routeTrace,
                compatibility,
                statsPath,
                protocol: deriveRecordingProtocol({ pathname, upstreamApi: routeTrace?.upstream_api })
              });
            } else {
              persistStats(state, statsPath);
            }
          });

          result.response.on('error', handleUpstreamStreamFailure);
          result.response.on('aborted', () => {
            handleUpstreamStreamFailure(new Error('upstream stream aborted before completion'));
          });
          result.response.on('close', () => {
            if (!result.response.complete) {
              handleUpstreamStreamFailure(new Error('upstream stream closed before completion'));
            }
          });
          return;
        }

        applyQuota(upstream, key, result.headers || {});
        const nativeResponsesUnsupported = activeRequiresNativeResponses && NATIVE_RESPONSES_UNSUPPORTED_ENDPOINT_STATUS.has(result.statusCode);
        if (modelInteractionRequest) {
          recordModelInteractionOutcome({
            state,
            upstream,
            key,
            statusCode: result.statusCode,
            startedAt: result.startedAt,
            retried: true,
            succeeded: false,
            reason: result.reason,
            retryAfter: result.retryAfter,
            applyFailure: !nativeResponsesUnsupported,
            protocol: deriveRecordingProtocol({ pathname, upstreamApi: routeTrace?.upstream_api })
          });
        }
        persistStats(state, statsPath);
        if (modelInteractionRequest) {
          rememberRequest(state, {
            method: req.method,
            path: pathname,
            entry_protocol: 'responses',
            ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
            upstream: upstream.name,
            key: key.label,
            originalModel: originalModel || null,
            actualModel: attemptedModel || null,
            status: result.statusCode,
            durationMs: now() - result.startedAt,
            retried: true,
            outcome: 'retry',
            reason: result.reason,
            route: routeTrace,
            ...(compatibility ? { compatibility } : {})
          });
          persistStats(state, statsPath);
        }
        attempts.push({
          upstream: upstream.name,
          key: key.label,
          model: attemptedModel || null,
          status: result.statusCode,
          reason: result.reason,
          route: routeTrace,
          ...(compatibility ? { compatibility } : {})
        });

        const smallBackoff = Math.min(1000, 100 * attempt);
        if (allowRetry) await sleep(smallBackoff);
      }

      const lastAttempt = attempts[attempts.length - 1] || null;
      const nativeResponsesFailure = activeRequiresNativeResponses && pathname === '/v1/responses';
      const failureStatus = nativeResponsesFailure ? 422 : 502;
      const failureReason = nativeResponsesFailure
          ? attempts.length
          ? nativeResponsesRequiredFailureMessage(unsupportedToolTypes, unsupportedChatOutputFormatTypes, unsupportedInputTypes, unsupportedFieldTypes)
          : noNativeResponsesCandidateMessage(unsupportedToolTypes, unsupportedChatOutputFormatTypes, unsupportedInputTypes, unsupportedFieldTypes)
        : attempts.length
          ? 'all upstream attempts failed'
          : 'no available upstream candidate';
      const failureRouteTrace = requestRouteTrace({
        pathname,
        requiresNativeResponses: activeRequiresNativeResponses,
        unsupportedToolTypes,
        unsupportedOutputFormatTypes: unsupportedChatOutputFormatTypes,
        unsupportedInputTypes,
        unsupportedFieldTypes
      });
      const failureDisplay = requestFailureDisplay({ attempts, nativeResponsesFailure });
      if (modelInteractionRequest) {
        rememberRequest(state, {
          method: req.method,
          path: pathname,
          entry_protocol: 'responses',
          ...requestDebugFields(incomingHeaderSample, config.debug?.capture_request_headers === true ? originalBody : undefined),
          upstream: lastAttempt?.upstream || null,
          key: lastAttempt?.key || null,
          originalModel: originalModel || null,
          actualModel: requestedModel || null,
          status: failureStatus,
          durationMs: null,
          retried: attempts.length > 1,
          outcome: 'failed',
          reason: failureReason,
          error_display: failureDisplay,
          route: failureRouteTrace,
          ...(compatibilityPlan ? { compatibility: compatibilitySummary(compatibilityPlan, failureRouteTrace) } : {})
        });
        persistStats(state, statsPath);
      }

      const failurePayload = {
        error: failureReason,
        error_display: failureDisplay,
        attempts
      };
      if (nativeResponsesFailure) {
        if (unsupportedToolTypes.length > 0) failurePayload.unsupported_tool_types = unsupportedToolTypes;
        if (unsupportedChatOutputFormatTypes.length > 0) failurePayload.unsupported_output_format_types = unsupportedChatOutputFormatTypes;
        if (unsupportedInputTypes.length > 0) failurePayload.unsupported_input_types = unsupportedInputTypes;
        if (unsupportedFieldTypes.length > 0) failurePayload.unsupported_field_types = unsupportedFieldTypes;
        failurePayload.incompatible_upstreams = nativeResponsesCandidateDiagnostics(state, pathname, requestedModel, tried);
        failurePayload.route = failureRouteTrace;
      }
      return jsonResponse(res, failureStatus, failurePayload);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      const payload = { error: error.message };
      if (Array.isArray(error.unsupportedToolTypes)) payload.unsupported_tool_types = error.unsupportedToolTypes;
      if (Array.isArray(error.unsupportedOutputFormatTypes)) payload.unsupported_output_format_types = error.unsupportedOutputFormatTypes;
      return jsonResponse(res, statusCode, payload);
    }
  });

  server.state = state;
  server.config = config;
  server.healthTimer = healthTimer;
  server.statsPath = statsPath;
  server.shuttingDown = false;

  server.on('close', () => {
    if (healthTimer) clearInterval(healthTimer);
    flushStats(state, statsPath);
  });

  server.on('clientError', (error, socket) => {
    logger.warn?.(`[client-error] ${error.message}`);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.shutdown = (shutdownOptions = {}) => new Promise((resolve) => {
    if (server.shuttingDown) {
      resolve({ alreadyShuttingDown: true });
      return;
    }
    server.shuttingDown = true;
    const graceMs = Math.max(1000, Number(
      shutdownOptions.timeoutMs
      || serverConfig.graceful_shutdown_ms
      || DEFAULT_GRACEFUL_SHUTDOWN_MS
    ));
    if (healthTimer) clearInterval(healthTimer);
    flushStats(state, statsPath);
    server.closeIdleConnections?.();
    const forceTimer = setTimeout(() => {
      logger.warn?.(`[shutdown] forcing open connections closed after ${graceMs}ms`);
      server.closeAllConnections?.();
    }, graceMs);
    forceTimer.unref?.();
    server.close((error) => {
      clearTimeout(forceTimer);
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') logger.warn?.(`[shutdown] ${error.message}`);
      flushStats(state, statsPath);
      resolve({ error });
    });
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

// Construct a ProtocolCapabilityManager wired with this server's real time and
// probe-classification dependencies. Manager state lives on upstream.capabilities,
// so a fresh instance per call is cheap and is never attached to the upstream
// (avoids circular references during stats serialization).
function capabilityManagerFor(upstream) {
  return new ProtocolCapabilityManager(upstream, { now, timestampMs, classifyModelProbe });
}

export const __testInternals = {
  openHttpProxyTunnel,
  guardHttp2SessionSocket,
  runCurlTest,
  classifyModelProbe,
  buildAnthropicRequestHeaders,
  buildProbeHeaders,
  effectiveProbeModelForUpstream,
  healthProbeOk,
  healthProbeStatus,
  buildChatCompletionsFromMessages,
  chatCompletionToMessagesJson,
  createChatToMessagesStreamAdapter,
  ProtocolCapabilityManager,
  capabilityManagerFor,
  normalizeProtocolCapabilities,
  initialProtocolCapabilities,
  recordProtocolCapabilityProbe,
  recordProtocolCapabilityRealTraffic,
  shouldRecheckProtocolCapability,
  joinUrlPath,
  joinTargetUrl,
  joinDebugRequestUrl,
  responsesPathForBaseUrl,
  chatCompletionsPathForBaseUrl,
  anthropicMessagesPathForBaseUrl,
  anthropicModelsPathForBaseUrl,
  // Exposed for the monitor-only-probe behavior tests (WS2).
  healthAllowsSelection,
  upstreamAvailable,
  chooseCandidate,
  representativeAvailability,
  representativeSelectionMultiplier,
  refreshCodexOAuthToken,
  ensureCodexOAuthFresh,
  codexOAuthNeedsRefresh
};

export async function start(configPath) {
  const loaded = await loadConfig(configPath);
  const config = loaded.config;
  const host = config.server?.host || '127.0.0.1';
  const port = Number(config.server?.port || 8787);
  const server = createPoolServer(config, {
    configPath: loaded.configPath,
    statsPath: path.resolve(path.dirname(loaded.configPath), config.stats?.path || 'stats.local.json')
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
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
      resolve();
    };
    server.once('error', onError);
    server.listen(port, host, onListening);
  });

  const shutdownMs = Number(config.server?.graceful_shutdown_ms || DEFAULT_GRACEFUL_SHUTDOWN_MS);
  let shutdownStarted = false;
  const shutdown = async (reason, exitCode = 0) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`[codex-api-pool] shutting down (${reason})`);
    const hardExitTimer = setTimeout(() => {
      console.error(`[codex-api-pool] shutdown exceeded ${shutdownMs}ms; exiting`);
      process.exit(exitCode);
    }, shutdownMs + 1000);
    hardExitTimer.unref?.();
    await server.shutdown({ timeoutMs: shutdownMs });
    clearTimeout(hardExitTimer);
    process.exit(exitCode);
  };
  process.once('SIGINT', () => shutdown('SIGINT', 0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));
  process.once('uncaughtException', (error) => {
    console.error(`[codex-api-pool] uncaught exception: ${error.stack || error.message}`);
    shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (reason) => {
    const message = reason?.stack || reason?.message || String(reason);
    console.error(`[codex-api-pool] unhandled rejection: ${message}`);
    shutdown('unhandledRejection', 1);
  });

  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start(process.argv[2]).catch((error) => {
    console.error(`[codex-api-pool] failed to start: ${error.stack || error.message}`);
    process.exit(1);
  });
}
