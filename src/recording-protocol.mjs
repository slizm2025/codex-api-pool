// Recording Protocol Derivation
//
// Derives the protocol-family name used to bucket per-protocol availability.
// This exists because routeTrace.upstream_api is unreliable: for /v1/messages
// and /v1/chat/completions requests it returns 'passthrough' (the
// requestRouteTrace fallback), which does not identify the real protocol used.
//
// Mapping rules:
//   /v1/responses        — use upstreamApi (responses, codex_oauth_responses,
//                          chat_completions, anthropic_messages). 'passthrough'
//                          should never occur here; return null as a safe no-op.
//   /v1/chat/completions — always 'chat_completions'.
//   /v1/messages         — 'anthropic_messages' when native, 'chat_completions'
//                          when adapted (Messages -> Chat Completions adapter).
//   other                — null (no per-protocol recording).
//
// Returns null when the protocol cannot be determined, so callers can skip
// recording rather than guess.

import { PROTOCOL_CAPABILITY_NAMES } from './protocol-capability-manager.mjs';

export const RECORDING_PROTOCOLS = PROTOCOL_CAPABILITY_NAMES;

/**
 * Derive the recording protocol from entry-path context.
 *
 * @param {object|null} input - { pathname, upstreamApi, useAdapter }
 * @returns {string|null} - One of RECORDING_PROTOCOLS, or null if unknown.
 */
export function deriveRecordingProtocol(input) {
  if (!input || typeof input !== 'object') return null;

  const pathname = typeof input.pathname === 'string' ? input.pathname : '';
  const upstreamApi = typeof input.upstreamApi === 'string' ? input.upstreamApi : '';

  // /v1/responses — upstreamApi is authoritative here (requestRouteTrace sets it).
  if (pathname === '/v1/responses') {
    if (upstreamApi === 'responses' || upstreamApi === 'codex_oauth_responses') return 'responses';
    if (upstreamApi === 'chat_completions') return 'chat_completions';
    if (upstreamApi === 'anthropic_messages') return 'anthropic_messages';
    // passthrough / unknown on /v1/responses should not happen; return null.
    return null;
  }

  // /v1/chat/completions — routeTrace says 'passthrough'; entry path is the truth.
  if (pathname === '/v1/chat/completions') return 'chat_completions';

  // /v1/messages — native vs adapted is decided locally by the handler.
  if (pathname === '/v1/messages') {
    return input.useAdapter === true ? 'chat_completions' : 'anthropic_messages';
  }

  // Non-model-interaction path (models, embeddings, etc.).
  return null;
}
