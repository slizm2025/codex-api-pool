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

const DEFAULT_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.local.json');
const DEFAULT_RETRYABLE_STATUS = [400, 401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524];
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
const MAX_USAGE_CAPTURE_BYTES = 50 * 1024 * 1024;
const DEFAULT_BILLING_LARGE_LIMIT_THRESHOLD = 10_000_000;
const DEFAULT_AVAILABILITY_WINDOW_SIZE = 50;
const DEFAULT_AVAILABILITY_MIN_SAMPLES = 10;
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
    if (lower === 'host') continue;
    if (lower === 'authorization') continue;
    out[name] = value;
  }
  out.host = target.host;
  if (upstreamKey) out.authorization = `Bearer ${upstreamKey}`;
  return out;
}

function isCodexCliUserAgent(value) {
  return /\bcodex_cli(?:_rs)?\//i.test(String(value || ''));
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
      tlsSocket.once('secureConnect', () => resolve(tlsSocket));
      tlsSocket.once('error', reject);
    });

  });
}

function createHttpProxyTunnel(proxyUrl, timeoutMs) {
  return (connectOptions, callback) => {
    openHttpProxyTunnel(
      proxyUrl,
      connectOptions.hostname || connectOptions.host,
      connectOptions.port || 443,
      timeoutMs
    ).then((socket) => callback(null, socket), callback);
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
    return http2.connect(origin);
  }
  const socket = await openHttpProxyTunnel(normalizedProxy, target.hostname, target.port || 443, timeoutMs);
  return http2.connect(origin, {
    createConnection: () => socket
  });
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

function normalizeUpstreamApi(value, probeAuth = '') {
  const api = String(value || '').trim().toLowerCase();
  if (api) return api;
  return String(probeAuth || '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

function isAnthropicUpstream(upstream) {
  return upstream?.api === 'anthropic' || upstream?.api === 'both' || String(upstream?.probeAuth || '').trim().toLowerCase() === 'anthropic';
}

function isOpenAiUpstream(upstream) {
  return upstream?.api === 'openai' || upstream?.api === 'both' || !upstream?.api;
}

function isCodexOAuthModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return value === '' || value.startsWith('gpt-') || value.startsWith('codex');
}

function isCodexOAuthConfig(input) {
  return input?.codex_oauth === true || String(input?.request_mode || '').trim().toLowerCase() === 'codex_oauth';
}

function codexOAuthExpired(upstream, at = Date.now()) {
  if (!upstream?.codexOAuth || !upstream.oauthExpiresAt) return false;
  const expiresMs = Date.parse(upstream.oauthExpiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= at;
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
      quota: {}
    };
  });
  const siteUrl = deriveSiteUrl(upstream.base_url, upstream.site_url);

  return {
    index,
    name: upstream.name || `upstream-${index + 1}`,
    enabled: upstream.enabled !== false,
    baseUrl: upstream.base_url,
    siteUrl,
    signinAvailable: booleanOption(signinAvailableValue(upstream), Boolean(siteUrl)),
    signinCompletedDate: signinCompletionDate(upstream),
    proxyUrl: normalizeProxyUrl(upstream.proxy_url || upstream.proxyUrl),
    codexOAuth: isCodexOAuthConfig(upstream),
    oauthExpiresAt: typeof upstream.oauth_expires_at === 'string' ? upstream.oauth_expires_at : '',
    oauthClientId: typeof upstream.oauth_client_id === 'string' ? upstream.oauth_client_id : '',
    oauthPlanType: typeof upstream.oauth_plan_type === 'string' ? upstream.oauth_plan_type : '',
    oauthEmail: typeof upstream.oauth_email === 'string' ? upstream.oauth_email : '',
    chatGptAccountId: typeof upstream.chatgpt_account_id === 'string' ? upstream.chatgpt_account_id : '',
    chatGptUserId: typeof upstream.chatgpt_user_id === 'string' ? upstream.chatgpt_user_id : '',
    organizationId: typeof upstream.organization_id === 'string' ? upstream.organization_id : '',
    healthPath: typeof upstream.health_path === 'string' ? upstream.health_path : '',
    probeAuth: typeof upstream.probe_auth === 'string' ? upstream.probe_auth : 'bearer',
    api: normalizeUpstreamApi(upstream.api, upstream.probe_auth),
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
  const availability = normalizeAvailabilityConfig(config.availability);

  const upstreams = (config.upstreams || [])
    .map((upstream, index) => createUpstreamState(upstream, index));

  return {
    retry,
    availability,
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
    recent: samples.map(Boolean)
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

function upstreamSelectionWeight(upstream, availability) {
  return upstream.weight * availability.multiplier;
}

function upstreamSelectionScore(upstream, availability) {
  return upstreamSelectionWeight(upstream, availability) / (
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

function recordAvailability(upstream, key, succeeded, availabilityConfig) {
  const value = succeeded ? 1 : 0;
  for (const stats of [upstream.stats, key.stats]) {
    const availability = ensureAvailability(stats, availabilityConfig);
    availability.samples.push(value);
    if (availability.samples.length > availabilityConfig.windowSize) {
      availability.samples.splice(0, availability.samples.length - availabilityConfig.windowSize);
    }
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
    ensureAvailability(key.stats, availabilityConfig);
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
    copyRuntimeState(upstream, old, { preserveHealth: old.baseUrl === upstream.baseUrl, availabilityConfig: state.availability });
  }
  state.upstreams.splice(0, state.upstreams.length, ...rebuilt.upstreams);
}

function keyAvailable(keyState, at) {
  return Boolean(keyState.value) && keyState.cooldownUntil <= at;
}

function upstreamAvailable(upstream, at) {
  return upstream.enabled && upstream.baseUrl && !codexOAuthExpired(upstream, at) && upstream.cooldownUntil <= at && upstream.keys.some((key) => keyAvailable(key, at));
}

function upstreamSupportsModel(upstream, model) {
  if (!model) return true;
  if (isClaudeModel(model) && !isAnthropicUpstream(upstream)) return false;
  if (!isClaudeModel(model) && !isOpenAiUpstream(upstream)) return false;
  if (upstream.codexOAuth && !isCodexOAuthModel(model)) return false;
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
    const unavailableModelCandidateExists = state.upstreams.some((upstream) => (
      upstream.enabled &&
      upstream.baseUrl &&
      upstreamSupportsModel(upstream, preferredModel) &&
      !upstreamAvailable(upstream, at)
    ));
    if (modelCandidates.length > 0 || (!options.allowUnknownModelFallback && !unavailableModelCandidateExists)) {
      candidates = modelCandidates;
    }
  }

  if (candidates.length === 0) return null;

  let total = 0;
  const weighted = candidates.map((upstream) => {
    const availability = availabilitySummary(upstream.stats, state.availability);
    const score = upstreamSelectionScore(upstream, availability);
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
  for (const key of ['response', 'data', 'result']) {
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

function extractTokenUsageFromBody(body) {
  if (!body || body.length === 0) return emptyTokenUsage();
  const text = body.toString('utf8');
  try {
    return extractTokenUsageFromJson(JSON.parse(text));
  } catch {
    return extractTokenUsageFromSse(text);
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
      const bodyUsage = extractTokenUsageFromBody(Buffer.concat(chunks, size));
      return hasTokenUsage(bodyUsage) ? bodyUsage : extractTokenUsageFromHeaders(headers);
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
    const finalItem = messageItem('completed');
    res.write(responseOutputItemEvent('response.output_item.done', finalItem, outputIndex));
    res.write(completedResponsesEvent(model, {
      id: responseId,
      model: responseModel,
      output: outputText ? [finalItem] : [],
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
  const todayEntry = tokenDailyEntry(usage, today);
  return {
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    today_tokens: todayEntry.total_tokens,
    today_input_tokens: todayEntry.input_tokens,
    today_output_tokens: todayEntry.output_tokens,
    by_day: { ...usage.byDay },
    daily: tokenDailyPayload(usage)
  };
}

function aggregateUsage(upstreams, today = localDateKey()) {
  const byDay = {};
  const daily = {};
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const upstream of upstreams) {
    const usage = ensureTokenUsage(upstream.stats);
    totalTokens += usage.totalTokens;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    for (const [day, value] of Object.entries(usage.byDay)) {
      byDay[day] = numberFromUnknown(byDay[day]) + numberFromUnknown(value);
    }
    for (const day of new Set([...Object.keys(usage.byDay || {}), ...Object.keys(usage.daily || {})])) {
      const entry = tokenDailyEntry(usage, day);
      const target = daily[day] || { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
      target.total_tokens += entry.total_tokens;
      target.input_tokens += entry.input_tokens;
      target.output_tokens += entry.output_tokens;
      daily[day] = target;
    }
  }
  const todayEntry = daily[today] || { total_tokens: numberFromUnknown(byDay[today]), input_tokens: 0, output_tokens: 0 };
  return {
    total_tokens: totalTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    today_tokens: todayEntry.total_tokens,
    today_input_tokens: todayEntry.input_tokens,
    today_output_tokens: todayEntry.output_tokens,
    by_day: byDay,
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

function recordAttemptOutcome(state, upstream, key, statusCode) {
  recordAvailability(upstream, key, statusCode >= 200 && statusCode < 400, state.availability);
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

  if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
    key.cooldownUntil = now() + cooldownMs;
  }

  if (upstream.failures >= state.retry.failureThreshold || statusCode === 0 || statusCode === 429 || state.retry.retryableStatus.has(statusCode)) {
    upstream.cooldownUntil = now() + cooldownMs;
  }
}

function finishResponseAttempt({ state, upstream, key, method, pathname, originalModel, attemptedModel, statusCode, startedAt, attempt, reason = '', retryAfter, tokenCount = 0, statsPath }) {
  recordAttemptOutcome(state, upstream, key, statusCode);
  const recordedTokens = statusCode >= 200 && statusCode < 400 ? recordTokenUsage(upstream, tokenCount, startedAt) : emptyTokenUsage();
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

function codexOAuthProbePayload(model) {
  return Buffer.from(JSON.stringify({
    model: model || 'gpt-5.5',
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
  if (value && !value.toLowerCase().includes('codex')) return value;
  return 'gpt-5.5';
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

async function probeCodexOAuthUpstream(upstream, key, config) {
  const timeoutMs = Number(config.health?.timeout_ms || 10000);
  const publicPrefix = normalizePrefix(config.server?.public_prefix || '/v1');
  const model = config.model_override || 'gpt-5.5';
  const targetUrl = codexOAuthTargetUrl(upstream.baseUrl, `${publicPrefix}/responses`, publicPrefix);
  const body = codexOAuthProbePayload(model);
  const headers = buildCodexOAuthRequestHeaders(targetUrl, key.value, { 'content-type': 'application/json' }, codexOAuthExtraHeaders(upstream));
  headers['content-length'] = body.length;

  const result = await probeCodexOAuthRequest(upstream, targetUrl, body, headers, timeoutMs);
  if (![401, 403].includes(result.statusCode)) return result;

  const compactTargetUrl = codexOAuthTargetUrl(upstream.baseUrl, `${publicPrefix}/responses/compact`, publicPrefix);
  const compactBody = codexOAuthCompactProbePayload(model);
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
    compactModel: codexOAuthCompactProbeModel(model),
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

  if (!upstream.enabled) {
    upstream.health = { ...upstream.health, state: 'disabled', checkedAt, latencyMs: 0, httpStatus: 0, error: 'upstream disabled', models: upstream.health?.models || [], modelsCount: upstream.health?.modelsCount ?? 0, keyLabel: null };
    return upstream.health;
  }

  if (!key || !key.value) {
    upstream.health = { state: 'missing_key', checkedAt, latencyMs: 0, httpStatus: 0, error: 'no configured key', models: [], modelsCount: 0, keyLabel: key?.label || null };
    return upstream.health;
  }

  if (upstream.codexOAuth) {
    const expired = codexOAuthExpired(upstream);
    let result = null;
    if (!expired && options.live === true) {
      result = await probeCodexOAuthUpstream(upstream, key, config);
      applyQuota(upstream, key, result.headers || {});
    }
    const stateName = expired
      ? 'auth_error'
      : result
        ? classifyHealth(result.statusCode, result.error)
        : 'oauth_ready';
    const bodyMessage = result?.body ? String(result.body).trim().slice(0, 1000) : '';
    const diagnosticMessage = codexOAuthDiagnosticMessage(result?.diagnostics);
    const error = expired
      ? `OAuth access token expired at ${upstream.oauthExpiresAt}`
      : result
        ? diagnosticMessage || result.error || (stateName === 'ok' ? '' : bodyMessage)
        : 'Codex OAuth upstream does not support /models probing; click Test to send a live probe';
    upstream.health = {
      state: stateName,
      checkedAt,
      latencyMs: result?.latencyMs || 0,
      httpStatus: result?.statusCode || 0,
      error,
      diagnostics: result?.diagnostics || undefined,
      models: [],
      modelsCount: 0,
      keyLabel: key.label
    };
    key.health = {
      state: stateName,
      checkedAt,
      latencyMs: result?.latencyMs || 0,
      httpStatus: result?.statusCode || 0,
      error,
      diagnostics: result?.diagnostics || undefined
    };
    if (result) {
      if (stateName === 'ok') {
        upstream.lastError = '';
        upstream.lastStatus = result.statusCode;
      } else if (['auth_error', 'rate_limited', 'server_error', 'network_error', 'timeout'].includes(stateName)) {
        recordFailure(state, upstream, key, error || `health ${stateName}`, result.statusCode, result.retryAfter);
      }
    }
    return upstream.health;
  }

  const targetUrl = upstream.healthPath
    ? joinUrlPath(upstream.baseUrl, pathSuffix)
    : joinTargetUrl(upstream.baseUrl, `${publicPrefix}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`, publicPrefix);
  const result = await probeHttp(targetUrl, key.value, timeoutMs, {
    authType: upstream.probeAuth,
    headers: upstream.probeHeaders,
    proxyUrl: upstream.proxyUrl
  });
  const stateName = classifyHealth(result.statusCode, result.error);
  const models = extractModels(result.body);
  applyQuota(upstream, key, result.headers || {});
  if (options.includeBilling) await safeProbeOneBilling(upstream, config);

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
      ? joinUrlPath(upstream.baseUrl, pathSuffix)
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
  const models = extractModels(result.body);
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
  const suggestedApi = supportsClaude ? (openAiWorks ? 'both' : 'anthropic') : openAiWorks ? 'openai' : null;
  const claudeOnly = supportsClaude && claude.length > 0 && nonClaude.length === 0;
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

  const anthropicHealth = await probeAnthropicModels(upstream, config);
  if (!anthropicHealth) return { health, detectedApi: null };

  const openAiWorks = health?.state === 'ok';
  const detectedApi = openAiWorks ? 'both' : 'anthropic';
  const mergedHealth = openAiWorks
    ? {
        ...health,
        models: mergeModels(health.models || [], anthropicHealth.models || []),
        modelsCount: mergeModels(health.models || [], anthropicHealth.models || []).length
      }
    : anthropicHealth;

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
  if (detected) {
    detected.health = mergedHealth;
    detected.cooldownUntil = 0;
    detected.lastError = '';
    detected.lastStatus = mergedHealth.httpStatus || 200;
  }
  await saveConfig(config, options.configPath);
  return { health: mergedHealth, detectedApi };
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
    .shell { position: relative; width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: end; margin-bottom: 16px; }
    h1 { font-size: clamp(28px, 3.4vw, 42px); line-height: 1; margin: 0; letter-spacing: 0; }
    .lede { color: var(--muted); font-size: 14px; line-height: 1.6; max-width: 620px; }
    .eyebrow { color: var(--muted); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 8px; }
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
    button:focus-visible, input:focus-visible, select:focus-visible, .card:focus-visible, .site-link:focus-visible, .metric[role="button"]:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
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
    .dashboard-region { margin-top: 14px; }
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
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 12px; margin-bottom: 14px; }
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
    .workbench-head, .workbench-row { display: grid; grid-template-columns: minmax(180px, 1.2fr) 112px minmax(180px, .95fr) minmax(135px, .75fr) minmax(140px, .75fr) minmax(165px, .9fr) 238px; gap: 10px; align-items: center; }
    .workbench-head { padding: 0 12px 2px; color: var(--muted); font-size: 11px; letter-spacing: .11em; text-transform: uppercase; }
    .card { padding: 12px; min-height: 0; animation: rise .35s ease both; cursor: pointer; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
    .workbench-list.stable .card { animation: none; }
    .card:hover { transform: translateY(-1px); border-color: var(--line-strong); box-shadow: 0 16px 42px rgba(31, 45, 39, .13); }
    .card.editing { border-color: rgba(18, 128, 92, .62); box-shadow: 0 0 0 4px var(--glow), 0 18px 48px rgba(31, 45, 39, .1); }
    .card.paused { border-style: dashed; opacity: .76; }
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
    .workbench-actions { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
    .pill { border-radius: 999px; border: 1px solid currentColor; padding: 6px 10px; font-size: 12px; white-space: nowrap; }
    .site-link { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 7px 10px; font-size: 12px; text-decoration: none; white-space: nowrap; background: rgba(255,255,255,.46); min-width: 58px; text-align: center; }
    .site-link:hover { background: var(--ink); color: var(--paper); }
    .signin-action { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .signin-action.is-complete { color: var(--good); border-color: rgba(22,136,90,.42); background: rgba(22,136,90,.08); }
    .signin-action.is-off { color: var(--cold); border-color: rgba(49,95,125,.36); background: rgba(49,95,125,.08); }
    .signin-action[disabled] { cursor: default; opacity: .68; transform: none; }
    .signin-toolbar { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 10px; }
    .signin-filters { display: flex; gap: 6px; flex-wrap: wrap; }
    .signin-filter { min-height: 32px; padding: 6px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.32); }
    .signin-filter.active { color: var(--paper); background: var(--ink); border-color: var(--ink); }
    .signin-count { color: var(--muted); font-size: 12px; line-height: 1.35; }
    .probe-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .probe-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .claude-site { min-width: 78px; padding: 7px 10px; font-size: 12px; box-shadow: none; color: var(--cold); border-color: rgba(49,95,125,.42); background: rgba(49,95,125,.08); }
    .claude-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .billing-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .billing-site[disabled] { cursor: wait; opacity: .68; transform: none; }
    .toggle-site { min-width: 58px; padding: 7px 10px; font-size: 12px; box-shadow: none; background: rgba(255,255,255,.28); }
    .toggle-site::before { content: none; }
    .toggle-site.is-off { color: var(--paper); background: var(--ink); border-color: var(--ink); }
    .toggle-site[disabled] { cursor: wait; opacity: .68; transform: none; }
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
    form { margin-top: 18px; padding: 18px; display: grid; grid-template-columns: 1fr 1.4fr 1.4fr .55fr .62fr .78fr 1fr 1fr auto auto; gap: 10px; align-items: end; }
    form .section-head { grid-column: 1 / -1; }
    .form-mode { grid-column: 1 / -1; color: var(--muted); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
    .claude-result { grid-column: 1 / -1; border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,.48); padding: 10px 12px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .claude-result[data-state="supported"] { color: var(--good); border-color: rgba(22,136,90,.34); background: rgba(22,136,90,.07); }
    .claude-result[data-state="only"] { color: var(--cold); border-color: rgba(49,95,125,.34); background: rgba(49,95,125,.08); }
    .claude-result[data-state="unsupported"] { color: var(--warn); border-color: rgba(183,121,8,.34); background: rgba(183,121,8,.08); }
    .claude-card-result { flex: 1 0 100%; min-width: 0; padding: 7px 9px; text-align: left; overflow-wrap: anywhere; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
    input, select { width: 100%; min-height: 38px; border: 1px solid var(--line); background: rgba(255,255,255,.62); border-radius: 7px; padding: 9px 11px; color: var(--ink); outline: none; }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
    .toggle-field input { width: 38px; justify-self: start; accent-color: var(--accent); }
    .token-input { width: 180px; }
    .model-panel { padding: 14px; display: grid; grid-template-columns: minmax(220px, .8fr) 1.2fr auto; gap: 14px; align-items: end; }
    .model-readout { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .import-panel { padding: 18px; display: grid; grid-template-columns: minmax(220px, 1fr) minmax(150px, .45fr) minmax(150px, .45fr) auto; gap: 10px; align-items: end; }
    .import-panel .section-head { grid-column: 1 / -1; }
    .requests { padding: 18px; }
    .requests-head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
    .requests-head h2 { margin: 0; font-family: Didot, Bodoni 72, Georgia, serif; font-size: 28px; letter-spacing: 0; }
    .request-list { display: grid; gap: 8px; max-height: 300px; overflow: auto; }
    .request-row { display: grid; grid-template-columns: 1.2fr 1fr 1fr .6fr; gap: 10px; align-items: center; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: rgba(255,255,255,.48); font-size: 12px; }
    .request-row strong { font-size: 13px; overflow-wrap: anywhere; }
    .request-row small { color: var(--muted); display: block; letter-spacing: .08em; text-transform: uppercase; }
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
    @media (max-width: 1100px) { .diagnostic-strip { grid-template-columns: 1fr; } .workbench-head { display: none; } .workbench-row { grid-template-columns: minmax(180px, 1.2fr) repeat(2, minmax(120px, 1fr)); } .facts { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 760px) { header, .summary, .model-panel, .import-panel, .grid, .workbench-row, .workbench-models-row, form { grid-template-columns: 1fr; } .diagnostic-meta { grid-template-columns: 1fr; } .toolbar { justify-content: flex-start; } .token-input { width: 100%; } .section-head { align-items: flex-start; flex-direction: column; gap: 6px; } .model-strip-label { padding-top: 0; } .workbench-actions { justify-content: flex-start; } .usage-history-day summary, .usage-site-row { grid-template-columns: 1fr 1fr; } .request-row { grid-template-columns: 1fr; } .statusbar { align-items: flex-start; flex-direction: column; gap: 6px; } }
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
        <div class="metric"><span class="metric-label" data-icon="server">Upstreams</span><b id="total">0</b></div>
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
      <div class="model-panel panel">
        <label>当前模型<select id="modelSelect"><option value="">跟随 Codex 请求</option></select></label>
        <div class="model-readout" id="modelReadout">尚未完成模型探测。</div>
        <button class="ghost" id="clearModel" type="button" data-icon="x">清空覆盖</button>
      </div>
    </section>

    <section class="dashboard-region" data-dashboard-region="upstream-workbench" aria-labelledby="upstream-workbench-title">
      <div class="section-head">
        <h2 id="upstream-workbench-title"><span class="title-mark" data-icon="server"></span>Upstream Workbench</h2>
        <p>扫描每个 Upstream 的 Health State、Cooldown、Usage、Billing、Quota 和安全操作。</p>
      </div>
      <div class="signin-toolbar">
        <div class="signin-filters" role="group" aria-label="签到状态筛选">
          <button class="ghost signin-filter" type="button" data-signin-filter="all">全部</button>
          <button class="ghost signin-filter" type="button" data-signin-filter="pending">今日未签</button>
          <button class="ghost signin-filter" type="button" data-signin-filter="completed">今日已签</button>
          <button class="ghost signin-filter" type="button" data-signin-filter="not_required">无需签到</button>
        </div>
        <div class="signin-count" id="signinFilterCount"></div>
      </div>
      <section id="cards" class="workbench-list" aria-label="Upstream Workbench rows"></section>
    </section>

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
    const toast = document.querySelector('#toast');
    const lastRefresh = document.querySelector('#lastRefresh');
    const modelSelect = document.querySelector('#modelSelect');
    const modelReadout = document.querySelector('#modelReadout');
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
    let editingName = '';
    let upstreamCache = new Map();
    let cardsSignature = '';
    let modelOptionsSignature = '';
    let adminToken = localStorage.getItem('codexPoolAdminToken') || '';
    let signinFilter = localStorage.getItem('codexPoolSigninFilter') || 'all';
    const probingUpstreams = new Set();
    const claudeCheckingUpstreams = new Set();
    const claudeCheckResults = new Map();
    const billingUpstreams = new Set();
    const deletingUpstreams = new Set();
    let formClaudeCheck = null;
    adminTokenInput.value = adminToken;
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
        total: Number(usage.by_day?.[day] || 0),
        input: 0,
        output: 0
      };
    }
    function dailyUsageRows(data = {}, ups = []) {
      const days = new Set(Object.keys(data.usage?.daily || {}).concat(Object.keys(data.usage?.by_day || {})));
      for (const upstream of ups) {
        Object.keys(upstream.usage?.daily || {}).forEach((day) => days.add(day));
        Object.keys(upstream.usage?.by_day || {}).forEach((day) => days.add(day));
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
    if (!signinFilterLabels[signinFilter]) signinFilter = 'all';
    const signinFilterMatches = (upstream) => signinFilter === 'all' || signinStatusValue(upstream) === signinFilter;
    function setSigninFilter(nextFilter) {
      signinFilter = signinFilterLabels[nextFilter] ? nextFilter : 'all';
      localStorage.setItem('codexPoolSigninFilter', signinFilter);
      cardsSignature = '';
      load();
    }
    function updateSigninFilterControls(allItems = [], visibleItems = []) {
      const pendingCount = allItems.filter(signinPending).length;
      signinPendingCount.textContent = pendingCount;
      signinPendingMetric.title = pendingCount ? \`\${pendingCount} 个站点今日未签到\` : '今日没有待签到站点';
      signinFilterButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.signinFilter === signinFilter);
        button.setAttribute('aria-pressed', String(button.dataset.signinFilter === signinFilter));
      });
      signinFilterCount.textContent = signinFilter === 'all'
        ? \`显示全部 \${allItems.length} 个站点\`
        : \`\${signinFilterLabels[signinFilter]}：\${visibleItems.length} / \${allItems.length} 个站点\`;
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
    function sortBucket(upstream, activeModel) {
      if (upstream.available && upstreamSupportsModel(upstream, activeModel)) return 0;
      if (upstream.available) return 1;
      if (upstream.enabled && numeric(upstream.cooldown_ms) > 0) return 2;
      if (upstream.enabled) return 3;
      return 4;
    }
    function signinSortBucket(upstream) {
      const status = signinStatusValue(upstream);
      if (status === 'pending') return 0;
      if (status === 'completed') return 1;
      return 2;
    }
    const sortedUpstreams = (items, activeModel = '') => [...items].sort((a, b) => (
      signinSortBucket(a) - signinSortBucket(b) ||
      sortBucket(a, activeModel) - sortBucket(b, activeModel) ||
      numeric(b.selection_score, numeric(b.selection_weight, b.weight)) - numeric(a.selection_score, numeric(a.selection_weight, a.weight)) ||
      numeric(b.selection_weight, b.weight) - numeric(a.selection_weight, a.weight) ||
      numeric(b.availability?.rate, -1) - numeric(a.availability?.rate, -1) ||
      numeric(a.failures) - numeric(b.failures) ||
      numeric(a.ewma_latency_ms, Number.MAX_SAFE_INTEGER) - numeric(b.ewma_latency_ms, Number.MAX_SAFE_INTEGER) ||
      String(a.name).localeCompare(String(b.name))
    ));
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
      const history = Array.isArray(availability.recent) ? availability.recent.slice(-windowSize) : [];
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
    const upstreamSupportsModel = (upstream, model) => {
      if (!model) return true;
      const models = upstream.health?.models || [];
      return models.length === 0 || models.includes(model);
    };
    const hasConfiguredKey = (upstream) => (upstream.keys || []).some((key) => key.configured);
    const isHardHealthFailure = (upstream) => ['auth_error', 'rate_limited', 'server_error', 'network_error', 'timeout', 'missing_key'].includes(upstream.health?.state || '');
    function requestFailureText(request) {
      if (!request || request.outcome === 'ok') return '';
      const upstream = request.upstream ? ' on ' + request.upstream : '';
      const status = request.status ? 'HTTP ' + request.status : 'request failed';
      const reason = request.reason ? ': ' + request.reason : '';
      return 'Latest request failed' + upstream + ': ' + status + reason;
    }
    function likelyDiagnosticReason(ups, activeModel, eligible, latestFailure) {
      const enabled = ups.filter((upstream) => upstream.enabled);
      const available = ups.filter((upstream) => upstream.available);
      const cooling = enabled.filter((upstream) => upstream.cooldown_ms > 0);
      const missingKeys = enabled.filter((upstream) => !hasConfiguredKey(upstream));
      const disabled = ups.filter((upstream) => !upstream.enabled);
      const modelExcluded = activeModel
        ? available.filter((upstream) => {
          const models = upstream.health?.models || [];
          return models.length > 0 && !models.includes(activeModel);
        })
        : [];
      const hardFailures = enabled.filter(isHardHealthFailure);
      if (ups.length === 0) return 'Blocked: no Upstreams configured.';
      if (enabled.length === 0) return 'Blocked: all Upstreams are Disabled.';
      if (eligible.length === 0 && missingKeys.length === enabled.length) return 'Blocked: no configured Upstream Keys are available.';
      if (eligible.length === 0 && modelExcluded.length > 0) return 'Blocked: Model Override ' + activeModel + ' is not a Discovered Model on any available Upstream.';
      if (eligible.length === 0 && cooling.length > 0) return 'Blocked: all Selection candidates are in Cooldown.';
      if (eligible.length === 0) return 'Blocked: zero Upstreams can currently participate in Selection.';
      if (latestFailure) return latestFailure;
      if (disabled.length > 0) return 'Degraded: ' + disabled.length + ' Upstream' + (disabled.length === 1 ? '' : 's') + ' Disabled.';
      if (cooling.length > 0) return 'Degraded: ' + cooling.length + ' Upstream' + (cooling.length === 1 ? '' : 's') + ' in Cooldown.';
      if (missingKeys.length > 0) return 'Degraded: ' + missingKeys.length + ' enabled Upstream' + (missingKeys.length === 1 ? '' : 's') + ' missing configured Upstream Keys.';
      if (modelExcluded.length > 0) return 'Degraded: ' + modelExcluded.length + ' available Upstream' + (modelExcluded.length === 1 ? '' : 's') + ' excluded by Model Override.';
      if (hardFailures.length > 0) return 'Degraded: ' + hardFailures.length + ' enabled Upstream' + (hardFailures.length === 1 ? '' : 's') + ' reporting hard Health State.';
      if (available.length < enabled.length) return 'Degraded: ' + available.length + ' of ' + enabled.length + ' enabled Upstreams are available.';
      return 'Usable: Selection has eligible Upstreams and no current blocking reason.';
    }
    function updateTopDiagnostic(data, ups, activeModel) {
      const eligible = ups.filter((upstream) => upstream.available && upstreamSupportsModel(upstream, activeModel));
      const latestFailure = requestFailureText((data.recent_requests || [])[0]);
      const enabled = ups.filter((upstream) => upstream.enabled);
      const degraded = eligible.length > 0 && (
        eligible.length < enabled.length ||
        ups.some((upstream) => !upstream.enabled || upstream.cooldown_ms > 0 || isHardHealthFailure(upstream)) ||
        Boolean(latestFailure)
      );
      const state = eligible.length === 0 ? 'blocked' : degraded ? 'degraded' : 'usable';
      poolDiagnostic.dataset.state = state;
      poolUsability.textContent = state[0].toUpperCase() + state.slice(1);
      selectionCount.textContent = eligible.length + ' / ' + ups.length + ' eligible';
      selectionCount.title = eligible.length + ' Upstreams can participate in Selection; ' + ups.filter((upstream) => upstream.available).length + ' are currently available before Model Override filtering.';
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
      u.weight,
      u.usage?.today_tokens || 0,
      u.usage?.total_tokens || 0,
      u.usage?.input_tokens || 0,
      u.usage?.output_tokens || 0,
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
      u.selection_weight ?? '',
      u.selection_score ?? '',
      u.availability?.samples || 0,
      u.availability?.successes || 0,
      u.availability?.failures || 0,
      u.availability?.rate ?? '',
      u.availability?.multiplier ?? '',
      (u.availability?.recent || []).map((value) => value ? '1' : '0').join(''),
      (u.keys || []).map((k) => \`\${k.label}:\${k.configured}\`).join(','),
      (u.keys || []).map((k) => \`\${k.label}:\${k.health?.state || ''}:\${k.health?.error || ''}\`).join(','),
      (u.health?.models || []).join(','),
      activeModel,
      signinFilter
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
      setText(card, '[data-field="calls"]', upstream.stats?.attempts || 0);
      setText(card, '[data-field="today_tokens"]', fmtToken(upstream.usage?.today_tokens));
      setText(card, '[data-field="total_tokens"]', fmtToken(upstream.usage?.total_tokens));
      const todayTokenNode = card.querySelector('[data-field="today_tokens"]');
      if (todayTokenNode) todayTokenNode.title = tokenTitle('Today', upstream.usage?.today_tokens);
      const totalTokenNode = card.querySelector('[data-field="total_tokens"]');
      if (totalTokenNode) totalTokenNode.title = \`Total \${fullToken(upstream.usage?.total_tokens || 0)} · Input \${fullToken(upstream.usage?.input_tokens || 0)} · Output \${fullToken(upstream.usage?.output_tokens || 0)}\`;
      setText(card, '[data-field="billing_state"]', upstream.billing?.state || 'unknown');
      setText(card, '[data-field="billing_error"]', upstream.billing?.error || '');
      const billingFact = card.querySelector('[data-billing-fact]');
      if (billingFact) billingFact.title = upstream.billing?.error || '';
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
      card.querySelectorAll('[data-model]').forEach((button) => {
        button.classList.toggle('active', button.dataset.model === activeModel);
      });
      const probeButton = card.querySelector('[data-probe]');
      if (probeButton) {
        const probing = probingUpstreams.has(upstream.name);
        probeButton.disabled = probing || !upstream.enabled;
        setButtonLabel(probeButton, 'radar', !upstream.enabled ? '停用中' : probing ? '测试中' : '测试');
      }
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
    function renderRecentRequests(items) {
      requestList.innerHTML = items.length ? items.map((item) => \`
        <div class="request-row">
          <div><small>Model</small><strong>\${esc(item.originalModel || 'none')} -> \${esc(item.actualModel || 'none')}</strong></div>
          <div><small>Upstream</small><strong>\${esc(item.upstream || 'unknown')}</strong></div>
          <div><small>Status</small><strong title="\${esc(\`Tokens \${fullToken(item.tokens ?? 0)} · Input \${fullToken(item.inputTokens ?? 0)} · Output \${fullToken(item.outputTokens ?? 0)}\`)}">\${esc(item.outcome || '')} · \${esc(item.status ?? 0)} · \${esc(item.durationMs ?? 0)}ms · \${esc(fmtToken(item.tokens ?? 0))} tok · in \${esc(fmtToken(item.inputTokens ?? 0))} / out \${esc(fmtToken(item.outputTokens ?? 0))}</strong></div>
          <div><small>When</small><strong>\${new Date(item.at).toLocaleTimeString()}</strong></div>
        </div>\`).join('') : '<div class="empty">暂无请求记录。</div>';
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
    async function load() {
      const response = await fetch('/pool/status', { headers: authHeaders() });
      if (response.status === 401) {
        updateTopDiagnosticAuthBlocked();
        setToast('管理接口需要 admin token。');
        lastRefresh.textContent = '鉴权失败';
        return;
      }
      const data = await response.json();
      const knownModels = data.model?.known || [];
      const activeModel = data.model?.override || '';
      const allUps = sortedUpstreams(data.upstreams || [], activeModel);
      const ups = allUps.filter(signinFilterMatches);
      upstreamCache = new Map(allUps.map((upstream) => [upstream.name, upstream]));
      if (editingName && !upstreamCache.has(editingName)) resetEdit(false);
      const selectModels = activeModel && !knownModels.includes(activeModel) ? [activeModel, ...knownModels] : knownModels;
      updateTopDiagnostic(data, allUps, activeModel);
      document.querySelector('#total').textContent = allUps.length;
      document.querySelector('#available').textContent = allUps.filter(u => u.available).length;
      document.querySelector('#healthy').textContent = allUps.filter(u => u.health?.state === 'ok').length;
      document.querySelector('#cooling').textContent = allUps.filter(u => u.cooldown_ms > 0).length;
      updateTokenBreakdown(data.usage || {});
      renderDailyUsage(data, allUps);
      updateSigninFilterControls(allUps, ups);
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
        cards.innerHTML = ups.length ? '<div class="workbench-head" aria-hidden="true"><span>Upstream</span><span>Health</span><span>Selection</span><span>Models</span><span>Usage</span><span>Billing / Quota</span><span>Actions</span></div>' + ups.map((u, index) => \`
        <article class="card workbench-row panel \${u.name === editingName ? 'editing' : ''} \${u.enabled ? '' : 'paused'}" data-upstream="\${esc(u.name)}" tabindex="0" role="button" aria-label="编辑站点 \${esc(u.name)}" style="animation-delay:\${index * 35}ms">
          <div class="workbench-cell">
            <div class="name">\${esc(u.name)}</div>
            <div class="url">\${esc(u.base_url)}</div>
            <div class="keys">\${keySummaryHtml(u)}</div>
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
            <div class="mini-line">Cooldown <strong data-field="cooldown">\${Math.ceil((u.cooldown_ms || 0) / 1000)}s</strong></div>
            <div class="mini-line">Failures <strong data-field="failures">\${u.failures}</strong></div>
          </div>
          <div class="workbench-cell">
            <div class="mini-line">Discovered <strong data-field="models_count">\${fmt(u.health?.models_count)}</strong></div>
            <div class="mini-line">Active <strong>\${activeModel ? esc(activeModel) : 'Following request'}</strong></div>
          </div>
          <div class="workbench-cell">
            <div class="mini-line">Calls <strong data-field="calls">\${u.stats?.attempts || 0}</strong></div>
            <div class="mini-line">Today <strong data-field="today_tokens" title="\${esc(tokenTitle('Today', u.usage?.today_tokens))}">\${fmtToken(u.usage?.today_tokens)}</strong></div>
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
          <div class="workbench-actions">
            <button class="ghost toggle-site \${u.enabled ? 'is-on' : 'is-off'}" type="button" data-toggle="\${esc(u.name)}" data-enabled="\${u.enabled ? 'true' : 'false'}" aria-pressed="\${u.enabled ? 'true' : 'false'}">\${icon(u.enabled ? 'pause' : 'play')}\${u.enabled ? '停用' : '启用'}</button>
            <button class="ghost probe-site" type="button" data-probe="\${esc(u.name)}" \${probingUpstreams.has(u.name) || !u.enabled ? 'disabled' : ''}>\${icon('radar')}\${!u.enabled ? '停用中' : probingUpstreams.has(u.name) ? '测试中' : '测试'}</button>
            <button class="ghost claude-site" type="button" data-claude-check="\${esc(u.name)}" \${claudeCheckingUpstreams.has(u.name) || !u.enabled ? 'disabled' : ''}>\${icon('radar')}\${!u.enabled ? '停用中' : claudeCheckingUpstreams.has(u.name) ? '检测中' : 'Claude'}</button>
            <button class="ghost billing-site" type="button" data-billing="\${esc(u.name)}" \${billingUpstreams.has(u.name) || !u.enabled ? 'disabled' : ''}>\${icon('wallet')}\${!u.enabled ? '停用中' : billingUpstreams.has(u.name) ? '刷新中' : '余额'}</button>
            \${u.site_url ? \`<a class="site-link" href="\${esc(u.site_url)}" target="_blank" rel="noopener noreferrer">\${icon('external')}签到</a>\` : ''}
            <button class="ghost signin-action \${canSignin(u) ? '' : 'is-off'}" type="button" data-signin-available="\${esc(u.name)}" data-available="\${canSignin(u) ? 'true' : 'false'}" aria-pressed="\${canSignin(u) ? 'true' : 'false'}">\${icon(canSignin(u) ? 'x' : 'check')}\${canSignin(u) ? '设不可签' : '设可签'}</button>
            <button class="ghost signin-action \${!canSignin(u) ? 'is-off' : signinCompleted(u) ? 'is-complete' : ''}" type="button" data-signin-complete="\${esc(u.name)}" \${!canSignin(u) ? 'disabled' : ''}>\${icon(!canSignin(u) || signinCompleted(u) ? 'x' : 'signin')}\${!canSignin(u) ? '不可签' : signinCompleted(u) ? '撤销' : '完成'}</button>
            <button class="ghost delete-site" type="button" data-delete="\${esc(u.name)}" \${deletingUpstreams.has(u.name) ? 'disabled' : ''} aria-label="删除站点 \${esc(u.name)}">\${icon('trash')}\${deletingUpstreams.has(u.name) ? '删除中' : '删除'}</button>
            \${claudeCardResultHtml(u.name)}
          </div>
          <div class="workbench-models-row">
            <div class="model-strip-label">Discovered Models</div>
            <div class="models" aria-label="\${esc(u.name)} discovered models">\${(u.health?.models || []).length ? (u.health.models || []).map(model => \`<button class="model-chip \${model === activeModel ? 'active' : ''}" type="button" data-model="\${esc(model)}" title="\${esc(model)}">\${esc(model)}</button>\`).join('') : '<span class="key">暂无模型列表</span>'}</div>
          </div>
        </article>\`).join('') : \`<div class="empty panel">\${allUps.length ? '暂无符合筛选的站点。' : '暂无站点。'}</div>\`;
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
        setButtonLabel(button, 'radar', '测试中');
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
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
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
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
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
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
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
        setToast(response.ok
          ? \`\${name} 已\${enabled ? '启用' : '停用'}，状态：\${result.health?.state || 'unknown'}\`
          : \`\${name} 切换失败：\${result.error || response.status}\`);
      } catch (error) {
        setToast(\`\${name} 切换失败：\${error.message}\`);
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
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
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
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
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
      const card = cards.querySelector(\`[data-upstream="\${CSS.escape(name)}"]\`);
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
    importUpstreams.addEventListener('click', importUpstreamsFromFile);
    checkClaude.addEventListener('click', checkClaudeForForm);
    document.querySelector('#downloadUsageCsv').addEventListener('click', () => downloadUsage('csv'));
    document.querySelector('#downloadUsageJson').addEventListener('click', () => downloadUsage('json'));
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
      const response = await fetch('/pool/upstreams', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      const apiNote = result.api_detected || payload.api ? \`，协议：\${result.api || payload.api}\` : '';
      setToast(response.ok
        ? \`\${payload.replace ? '已保存' : '已添加'}：\${result.upstream}，探测状态：\${result.health?.state}\${apiNote}\`
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
    upstreams: state.upstreams.map((upstream) => {
      const availability = availabilitySummary(upstream.stats, state.availability);
      const available = upstreamAvailable(upstream, at);
      const selectionWeight = upstreamSelectionWeight(upstream, availability);
      return {
        name: upstream.name,
        base_url: upstream.baseUrl,
        site_url: upstream.siteUrl,
        signin_available: upstream.signinAvailable,
        signin_status: signinStatus(upstream.signinAvailable, upstream.signinCompletedDate, today),
        signin_completed: upstream.signinAvailable && upstream.signinCompletedDate === today,
        signin_completed_date: visibleSigninCompletedDate(upstream.signinAvailable, upstream.signinCompletedDate, today),
        proxy_url: upstream.proxyUrl || undefined,
        codex_oauth: upstream.codexOAuth,
        request_mode: upstream.codexOAuth ? 'codex_oauth' : undefined,
        oauth_expires_at: upstream.oauthExpiresAt || undefined,
        oauth_client_id: upstream.oauthClientId || undefined,
        oauth_email: upstream.oauthEmail || undefined,
        oauth_plan_type: upstream.oauthPlanType || undefined,
        chatgpt_account_id: upstream.chatGptAccountId || undefined,
        chatgpt_user_id: upstream.chatGptUserId || undefined,
        organization_id: upstream.organizationId || undefined,
        health_path: upstream.healthPath || config.health?.path || '/models',
        probe_auth: upstream.probeAuth,
        api: upstream.api,
        enabled: upstream.enabled,
        weight: upstream.weight,
        selection_weight: roundedSelectionValue(selectionWeight),
        selection_score: available ? roundedSelectionValue(upstreamSelectionScore(upstream, availability)) : 0,
        available,
        cooldown_ms: Math.max(0, upstream.cooldownUntil - at),
        in_flight: upstream.inFlight,
        successes: upstream.successes,
        failures: upstream.failures,
        ewma_latency_ms: upstream.ewmaLatencyMs,
        last_status: upstream.lastStatus,
        last_error: upstream.lastError,
        stats: upstream.stats,
        availability,
        usage: usagePayload(upstream.stats, today),
        quota: upstream.quota,
        billing: billingPayload(upstream.billing, upstream.billingConfig),
        health: {
          state: upstream.health.state,
          checked_at: upstream.health.checkedAt,
          latency_ms: upstream.health.latencyMs,
          http_status: upstream.health.httpStatus,
          error: upstream.health.error,
          diagnostics: upstream.health.diagnostics || undefined,
          models: upstream.health.models || [],
          models_count: upstream.health.modelsCount,
          key_label: upstream.health.keyLabel
        },
        keys: upstream.keys.map((key) => ({
          label: key.label,
          source: key.source,
          configured: Boolean(key.value),
          cooldown_ms: Math.max(0, key.cooldownUntil - at),
          failures: key.failures,
          stats: key.stats,
          availability: availabilitySummary(key.stats, state.availability),
          quota: key.quota,
          health: {
            state: key.health.state,
            checked_at: key.health.checkedAt,
            latency_ms: key.health.latencyMs,
            http_status: key.health.httpStatus,
            error: key.health.error
          }
        }))
      };
    })
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
  return tokenMatches(req, config.server?.auth_token_env);
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
    api: api || undefined,
    probe_headers: item.probe_headers || item.probeHeaders,
    billing: item.billing,
    weight: Number(firstString(item.weight, item.priority) || 1),
    keys: keyEntriesFromImportItem(item, name, options.secretMode),
    enabled: item.enabled === undefined ? true : item.enabled !== false,
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
  const oauthExpiresAtInput = hasOwn('oauth_expires_at') ? payload.oauth_expires_at : existing?.oauth_expires_at;
  const oauthClientIdInput = hasOwn('oauth_client_id') ? payload.oauth_client_id : existing?.oauth_client_id;
  const oauthEmailInput = hasOwn('oauth_email') ? payload.oauth_email : existing?.oauth_email;
  const oauthPlanTypeInput = hasOwn('oauth_plan_type') ? payload.oauth_plan_type : existing?.oauth_plan_type;
  const chatGptAccountIdInput = hasOwn('chatgpt_account_id') ? payload.chatgpt_account_id : existing?.chatgpt_account_id;
  const chatGptUserIdInput = hasOwn('chatgpt_user_id') ? payload.chatgpt_user_id : existing?.chatgpt_user_id;
  const organizationIdInput = hasOwn('organization_id') ? payload.organization_id : existing?.organization_id;
  const healthPathInput = hasOwn('health_path') ? payload.health_path : existing?.health_path;
  const probeAuthInput = hasOwn('probe_auth') ? payload.probe_auth : existing?.probe_auth;
  const apiInput = hasOwn('api') ? payload.api : existing?.api;
  const api = normalizeUpstreamApi(apiInput, probeAuthInput);
  if (!['openai', 'anthropic', 'both'].includes(api)) {
    const error = new Error('api must be "openai", "anthropic", or "both"');
    error.statusCode = 400;
    throw error;
  }
  const probeHeadersInput = hasOwn('probe_headers') ? payload.probe_headers : existing?.probe_headers;
  const billingInput = hasOwn('billing') ? payload.billing : existing?.billing;

  return {
    name,
    base_url: baseUrl,
    site_url: siteUrl,
    signin_available: signinAvailable,
    signin_completed_date: signinCompletedDate,
    proxy_url: normalizeProxyUrl(proxyUrlInput) || undefined,
    codex_oauth: codexOAuthInput === true || String(requestModeInput || '').trim().toLowerCase() === 'codex_oauth' || undefined,
    request_mode: String(requestModeInput || '').trim().toLowerCase() === 'codex_oauth' || codexOAuthInput === true ? 'codex_oauth' : undefined,
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
    probe_auth: typeof probeAuthInput === 'string'
      ? probeAuthInput.trim()
      : undefined,
    api,
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
    await runHealthChecks(state, config);
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, result: createStatusPayload(config, state) });
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
      enabled: payload.enabled
    };
    runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    const upstream = state.upstreams.find((item) => item.name === name);
    const health = upstream?.enabled ? await probeOneUpstream(state, upstream, config) : upstream?.health || null;
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, account: name, enabled: payload.enabled, health });
  }

  const codexOauthProbeMatch = pathname.match(/^\/pool\/codex-oauth\/accounts\/([^/]+)\/probe$/);
  if (req.method === 'POST' && codexOauthProbeMatch) {
    const name = decodeURIComponent(codexOauthProbeMatch[1]);
    const upstream = state.upstreams.find((item) => item.name === name && item.codexOAuth);
    if (!upstream) return jsonResponse(res, 404, { error: `codex oauth account not found: ${name}` });
    const health = await probeOneUpstream(state, upstream, config, { live: true });
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, account: name, health });
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
        enabled: payload.enabled
      };
    } else {
      const oauthConfig = ensureCodexOAuthConfig(config);
      const accountIndex = oauthConfig.accounts.findIndex((item) => item.name === name);
      if (accountIndex < 0) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
      oauthConfig.accounts[accountIndex] = {
        ...oauthConfig.accounts[accountIndex],
        enabled: payload.enabled
      };
    }
    runtime.rebuildRuntimeUpstreams ? runtime.rebuildRuntimeUpstreams() : rebuildUpstreams(state, config);
    await saveConfig(config, options.configPath);
    const upstream = state.upstreams.find((item) => item.name === name);
    const health = upstream?.enabled ? await probeOneUpstream(state, upstream, config) : upstream?.health || null;
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, upstream: name, enabled: payload.enabled, health });
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
    const upstream = state.upstreams.find((item) => item.name === name);
    if (!upstream) return jsonResponse(res, 404, { error: `upstream not found: ${name}` });
    const health = await probeOneUpstream(state, upstream, config, { live: true });
    persistStats(state, statsPath);
    return jsonResponse(res, 200, { ok: true, upstream: name, health });
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

      if (!isAuthorized(req, config)) {
        return jsonResponse(res, 401, { error: 'unauthorized: invalid Codex API pool token' });
      }

      if (state.upstreams.length === 0) {
        return jsonResponse(res, 503, { error: 'no upstreams configured' });
      }

      const originalBody = await readBody(req, maxBodyBytes);
      const originalModel = modelFromBody(req, originalBody);
      const requestedModel = isClaudeModel(originalModel)
        ? originalModel
        : state.modelOverride || originalModel;
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
        const useAnthropicAdapter = shouldUseAnthropicResponsesAdapter(pathname, attemptedModel);
        const useCodexOAuth = !useAnthropicAdapter && upstream.codexOAuth;
        const targetUrl = useAnthropicAdapter
          ? joinUrlPath(upstream.baseUrl, anthropicMessagesPathForBaseUrl(upstream.baseUrl))
          : useCodexOAuth
            ? codexOAuthTargetUrl(upstream.baseUrl, req.url || '/', publicPrefix)
            : joinTargetUrl(upstream.baseUrl, req.url || '/', publicPrefix);
        const body = useAnthropicAdapter
          ? buildAnthropicMessagesPayload(rewriteModelInBody(req, originalBody, attemptedModel), attemptedModel)
          : rewriteModelInBody(req, originalBody, attemptedModel);
        const requestHeaders = useAnthropicAdapter
          ? buildAnthropicRequestHeaders(targetUrl, key.value, req.headers, upstream.probeHeaders)
          : useCodexOAuth
            ? buildCodexOAuthRequestHeaders(targetUrl, key.value, req.headers, codexOAuthExtraHeaders(upstream))
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
              rememberRequest(state, {
                method: req.method,
                path: pathname,
                upstream: upstream.name,
                key: key.label,
                originalModel: originalModel || null,
                actualModel: attemptedModel || null,
                status: 499,
                durationMs: now() - result.startedAt,
                retried: attempt > 1,
                outcome: 'client_aborted',
                reason: 'client disconnected before upstream stream completed'
              });
              persistStats(state, statsPath);
              return;
            }
            recordResponseStats(upstream, key, STREAM_ERROR_STATUS, false);
            recordAttemptOutcome(state, upstream, key, STREAM_ERROR_STATUS);
            recordFailure(state, upstream, key, reason, STREAM_ERROR_STATUS, undefined);
            rememberRequest(state, {
              method: req.method,
              path: pathname,
              upstream: upstream.name,
              key: key.label,
              originalModel: originalModel || null,
              actualModel: attemptedModel || null,
              status: STREAM_ERROR_STATUS,
              durationMs: now() - result.startedAt,
              retried: attempt > 1,
              outcome: 'stream_error',
              reason
            });
            persistStats(state, statsPath);
            if (!res.destroyed) res.destroy(error || new Error(reason));
          };

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
            if (upstreamStreamFinished) return;
            upstreamStreamFinished = true;
            if (anthropicStreamAdapter) anthropicStreamAdapter.end();
            else if (anthropicJsonChunks) res.end(anthropicMessageToResponsesJson(Buffer.concat(anthropicJsonChunks, anthropicJsonSize), attemptedModel));
            else if (responsesCompletionNormalizer) responsesCompletionNormalizer.end();
            else res.end();
            upstream.inFlight = Math.max(0, upstream.inFlight - 1);
            recordResponseStats(upstream, key, result.statusCode, false);
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

        upstream.inFlight = Math.max(0, upstream.inFlight - 1);
        applyQuota(upstream, key, result.headers || {});
        recordResponseStats(upstream, key, result.statusCode, true);
        recordAttemptOutcome(state, upstream, key, result.statusCode);
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
