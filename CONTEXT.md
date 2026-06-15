# Codex API Pool

This context describes the local API pool used by Codex and Claude Desktop to reach multiple upstream services with failover, cooldown, and health awareness.

## Language

**API Pool**:
A local multi-protocol proxy that selects among multiple upstream services, retries eligible failures, cools down unhealthy options, and forwards requests from Codex and Claude Desktop. Supports Responses, Chat Completions, and Anthropic Messages as client entry protocols.
_Avoid_: proxy, router, gateway, key pool, site pool

**Upstream**:
An external API service that the API Pool can send model requests to. An Upstream has a base URL, weight, keys, health state, cooldown state, Protocol Capability evidence, and optional billing or quota information.
_Avoid_: provider, site, API site, station, vendor

**API Type Declaration**:
The user-configured `api` field in Pool Configuration that declares the expected protocol family for an Upstream (`openai`, `anthropic`, or `both`). It serves as the initial assumption for Health Probes but does not restrict runtime protocol selection—Protocol Capability evidence from probes takes precedence.
_Avoid_: protocol type, upstream type, API family, provider type

**Pool Token**:
The local Bearer token that Codex uses to access the API Pool. It authorizes entry to the local pool and is not forwarded to any Upstream.
_Avoid_: API key, upstream key, auth key, local key

**Upstream Key**:
The external API key that the API Pool uses when sending a request to an Upstream. It is normally referenced through an environment variable rather than stored as plaintext in configuration.
_Avoid_: pool token, local token, auth key, token

**Cooldown**:
A temporary period during which an Upstream or Upstream Key is skipped after failures, rate limits, authentication errors, or other retryable problems. Once the cooldown expires, it may participate in selection again.
_Avoid_: circuit breaker, fuse, disabled

**Disabled**:
A user-controlled state that keeps an Upstream out of request selection until it is explicitly enabled again.
_Avoid_: cooldown, failed, unavailable

**Active Upstream**:
An Upstream that is allowed to participate in Selection when its keys, Health State, cooldown, model support, and other eligibility checks also allow it.
_Avoid_: available upstream, healthy upstream, enabled site

**Quarantined Upstream**:
A user-isolated Upstream that is kept out of Selection until it is manually returned to active use, while remaining available for operational checks.
_Avoid_: disabled, inactive, boxed site, unstable site

**Health State**:
The API Pool's latest classification of an Upstream's observed availability, such as `ok`, `missing_key`, `rate_limited`, `server_error`, `network_error`, or `timeout`.
_Avoid_: status, state, result

**Availability**:
The recent success rate of Model Interaction Request attempts for an Upstream, calculated over a bounded rolling window and used as a Selection weight multiplier. Health Probes, model listing, Billing probes, and Management API requests do not count toward Availability.
_Avoid_: health, uptime, cumulative success rate

**Model Interaction Request**:
A client request that is expected to produce model output, such as a Responses, Chat Completions, or Anthropic Messages request. Metadata and operational requests such as model listing, Health Probes, Billing probes, and Management API calls are not Model Interaction Requests.
_Avoid_: request, API call, probe, model list

**Selection**:
The process of choosing an available Upstream and Upstream Key for a request. Selection prioritizes Protocol Matching over weight to enable lossless forwarding, then considers Availability, cooldown, health, in-flight requests, failure history, and model support.
_Avoid_: routing, dispatch, load balancing

**Protocol Matching**:
The Selection behavior that prioritizes Upstreams with verified Protocol Capability matching the client's request entry point. A Responses request prefers Upstreams with verified `responses` capability; a Messages request prefers Upstreams with verified `anthropic_messages` capability. Protocol Matching takes precedence over weight to avoid lossy protocol conversion when native routes exist.
_Avoid_: protocol preference, endpoint matching, native priority

**Retry**:
A subsequent attempt for the same client request after an eligible failure, retryable HTTP status, network error, or timeout.
_Avoid_: fallback, recovery, rerun

**Fallback**:
The observable switch from one Upstream candidate to another during Retry.
_Avoid_: retry, routing, failover

**Streaming Boundary**:
The point at which an Upstream has returned a successful response and the API Pool has begun forwarding the response stream. Before this boundary, the API Pool may Retry or Fallback; after it, the API Pool does not attempt lossless generation resume.
_Avoid_: stream retry, resume, continuation

**Native Responses Route**:
A Model Interaction Request path where the API Pool can forward a Responses request to an Upstream without translating it to another model API family. A Native Responses Route preserves Responses-only Features.
_Avoid_: native model, original model, full model

**Native Messages Route**:
A Model Interaction Request path where the API Pool can forward an Anthropic Messages request to an Upstream without translating it to another model API family. A Native Messages Route preserves Messages-only Features.
_Avoid_: native model, original model, full model

**Native Responses Recheck**:
A time-bounded recovery attempt that lets an Upstream with a learned non-native Forwarding Strategy try a Native Responses Route again for the same Requested Model, so temporary lack of native support does not become permanent.
_Avoid_: permanent retry, manual reset, endpoint polling

**Request Interface**:
The model API family that current evidence says an Upstream can successfully serve for a Requested Model, such as Responses, Chat Completions, Anthropic Messages, or Codex OAuth Responses. Once learned, it guides later Model Interaction Requests so the API Pool keeps using the interface that has been proven for that Upstream until stronger evidence changes it.
_Avoid_: endpoint guess, route preference, protocol hint

**Protocol Capability**:
Runtime evidence that an Upstream can or cannot serve a model API family (Responses, Chat Completions, or Anthropic Messages), gathered from Health Probes or real model traffic. Each capability has a status (`verified` from successful probes, `assumed` from API Type Declaration, `unsupported` from authoritative failures, or `unknown` before evidence). Protocol Capability takes precedence over API Type Declaration when selecting upstreams—a configured `api: "openai"` upstream that successfully probes `/v1/messages` will gain `anthropic_messages: verified` capability and become eligible for Claude model requests.
_Avoid_: request interface, forwarding strategy, current route, API type

**Forwarding Strategy**:
The learned way the API Pool sends future Model Interaction Requests for the same Upstream and Requested Model after real traffic succeeds, such as Native Responses, Chat Completions, or Chat Completions with Adapter Compatibility Mode. A non-native Forwarding Strategy can be superseded by stronger native evidence or a Native Responses Recheck.
_Avoid_: permanent model setting, global routing mode, provider type

**Responses-only Feature**:
A request feature that belongs to the Responses API shape and cannot be represented losslessly by a non-native adapter such as Chat Completions or Anthropic Messages.
_Avoid_: native tool call, unsupported tool, extra field

**Messages-only Feature**:
A request feature that belongs to the Anthropic Messages API shape and cannot be represented losslessly by a non-native adapter such as Responses or Chat Completions, such as cache_control, extended thinking blocks, or Anthropic-specific tool parameters.
_Avoid_: native tool call, unsupported tool, extra field

**Adapter Compatibility Mode**:
An opt-in Pool Configuration behavior that lets the API Pool use a non-native adapter when no Native Responses Route candidate is available by converting, downgrading, or removing Responses-only Features according to the target adapter's documented request fields.
_Avoid_: Claude mode, downgrade mode, tool disabling

**Compatibility Conversion**:
A documented field mapping from a Responses request shape to a non-native adapter shape, such as `input_image` to Chat `image_url` or Anthropic `image`, or `input_file` to Chat `file` / Anthropic `document` when the target API has a matching file source.
_Avoid_: stripping, cleanup, passthrough

**Compatibility Downgrade**:
A documented but not lossless field mapping where the target adapter has only a weaker or structurally different concept, such as Responses hosted web search to Chat `web_search_options`, or a preserved content block with target-unsupported subfields.
_Avoid_: conversion, fallback, approximate support

**Compatibility Stripping**:
The explicit removal of Responses-only Features only after checking that no documented target adapter field can represent them. Compatibility Stripping must be visible in request diagnostics.
_Avoid_: silent fallback, sanitization, cleanup

**Management API**:
The API Pool's control interface for observing and changing pool state, including status, Upstream creation, health probes, enable toggles, and billing refreshes. It is separate from the OpenAI-compatible model request interface used by Codex.
_Avoid_: admin API, status API, pool API, dashboard API

**Admin Token**:
The Bearer token used to authorize access to the Management API. It may be configured with the same environment variable as the Pool Token, but it is a separate domain concept.
_Avoid_: pool token, upstream key, API key

**Health Probe**:
An operational availability check that the API Pool sends to an Upstream from the Management API. A Health Probe may discover models and protocol behavior, but Health Probes are **advisory-only**: their results do NOT gate Selection. They surface Health State for the Management Dashboard, drive soft selection ranking via the health penalty, and record Protocol Capability evidence used for the dashboard's Verification Tier — but an Upstream is never excluded from Selection, never cooled down, and never has its failure count changed by a probe result. Only real Model Interaction Request outcomes gate Selection. Health Probes use a browser-like User-Agent to avoid client restrictions imposed by some Upstreams.
_Avoid_: test, check, ping, health check, real Codex check

**Representative Model Probe**:
A model availability check whose request shape is actual Codex-native model traffic closely enough that a successful model response can be used as evidence for Selection. In the current implementation, representative availability is proven by real Codex traffic rather than by replaying in-memory templates from the Management API.
_Avoid_: health check, model list, synthetic probe

**Representative Request Template**:
A redacted, time-limited request-shape metadata record captured from real Codex Model Interaction Requests for diagnostics. It is memory-only, does not retain a replayable request body or unmasked one-time context values, and is not used by the Management API to run Health Probes.
_Avoid_: saved prompt, cached request, dashboard request body, fixture

**Replay-risk Template Field**:
A redacted Representative Request Template field name whose original value may be bound to a single Codex turn, request, nonce, signature, attestation, or session. Replay-risk fields are why Management API tests do not replay Representative Request Templates.
_Avoid_: reusable template field, permanent credential, upstream key

**Representative Availability**:
A derived, non-persistent interpretation of recent real Codex success evidence for an Upstream, scoped by protocol and model. It reports whether evidence is fresh, stale, or missing, and may apply bounded Selection weighting without becoming a hard allowlist.
_Avoid_: whitelist, permanent health, model list availability

**Verification Tier**:
The Management Dashboard grouping that communicates the evidence level behind an Upstream's current usability: recently proven by real Codex traffic, proven only by first-layer probe evidence, or not currently verified as usable by either evidence layer.
_Avoid_: availability category, status group, priority queue

**Authoritative Probe Failure**:
A probe result that carries deterministic failure evidence (authentication failure, rate limiting, network failure, or a clearly unsupported model/API). Under the advisory-only Health Probe contract, an Authoritative Probe Failure no longer marks an Upstream or Upstream Key unavailable for Selection — it is surfaced as Health State for the Management Dashboard and feeds soft selection ranking, but only real Model Interaction Request failures gate Selection. Non-representative and inconclusive probe results are not Authoritative Probe Failures.
_Avoid_: failed test, bad response, inconclusive failure

**Non-representative Probe Result**:
A probe result whose request shape or returned error cannot reliably represent Codex-native model traffic. A Non-representative Probe Result may explain why a Health Probe is not authoritative, but it must not by itself prove that an Upstream is unavailable for real Codex traffic.
_Avoid_: unavailable, failed health check, model unsupported

**Usage**:
Token consumption observed by the API Pool from successful model responses, aggregated by Upstream and time period.
_Avoid_: billing, quota, balance

**Quota**:
Remaining request, token, or similar limit information exposed by an Upstream through response headers.
_Avoid_: usage, billing, balance

**Billing**:
Balance, spend, limit, currency, or billing-period information discovered by probing an Upstream's billing-related endpoints.
_Avoid_: usage, quota, stats

**Pool Configuration**:
The persistent API Pool settings stored in `config.local.json`, including listener settings, Retry rules, Upstreams, weights, Upstream Key environment-variable references, Health Probe configuration, and Billing probe configuration.
_Avoid_: config, settings, state, stats

**Runtime State**:
The changing state produced or restored while the API Pool runs, including cooldowns, Health State, Usage, Quota, Billing observations, failure counts, in-flight counts, and recent requests.
_Avoid_: configuration, settings, config

**Requested Model**:
The model name supplied by Codex in the original client request.
_Avoid_: model, active model, target model

**Model Override**:
The API Pool behavior that replaces the Requested Model in the outgoing request body before sending it to an Upstream.
_Avoid_: requested model, target model, override model

**Discovered Model**:
A model name learned from an Upstream's model listing during a Health Probe. Discovered Models can be used to decide whether an Upstream supports the Requested Model.
_Avoid_: model, active model, target model

**Upstream Model Suffix**:
A per-Upstream suffix that a non-standard Upstream appends to otherwise standard model names, such as `-cc` turning `claude-opus-4-8` into `claude-opus-4-8-cc`. The API Pool strips the Upstream Model Suffix from Discovered Models so Selection and diagnostics use the standard name, and reattaches it only to the model field of the request body sent to that Upstream. It does not change the Requested Model seen by clients, Recent Request Timeline, or availability statistics.
_Avoid_: model alias, model rename, model override, custom model name

**Debug Lock Mode**:
A temporary diagnostic state where the API Pool bypasses Selection and forces all Model Interaction Requests to a specific Upstream, testing native and adapted protocols sequentially to isolate whether failures originate from the Pool's routing logic or the Upstream itself. Debug Lock is session-only (not persisted), does not update Runtime State (except Recent Request Timeline), and returns detailed protocol attempt diagnostics.
_Avoid_: test mode, upstream pinning, direct routing, bypass mode

**Locked Upstream**:
The Upstream that Debug Lock Mode forces all requests to, ignoring Health State, Cooldown, Availability, and Selection weights until the lock is released.
_Avoid_: pinned upstream, target upstream, fixed upstream

**Protocol Attempt Sequence**:
The ordered list of protocol and adapter combinations that Debug Lock Mode tests when the client request arrives. For Responses requests: native Responses, adapted Chat Completions, adapted Anthropic Messages. For Messages requests: native Anthropic Messages only. Each attempt proceeds only if the previous one failed with an Endpoint Not Found Signal.
_Avoid_: protocol fallback chain, adapter cascade, protocol retry list

**Endpoint Not Found Signal**:
A response pattern (HTTP 404/405/501, or HTTP 400 with explicit unsupported-endpoint language in the error body) that Debug Lock Mode interprets as authoritative evidence that the Upstream does not support the attempted protocol, triggering fallback to the next protocol in the Protocol Attempt Sequence.
_Avoid_: protocol unsupported, endpoint failure, not found error

**Debug Attempt Diagnostics**:
The comprehensive per-attempt metadata that Debug Lock Mode returns when all protocols fail, including sequence number, protocol, endpoint URL, adapter status, HTTP status, error body, latency, fallback reason, and whether the adapter is disabled in production configuration.
_Avoid_: debug log, attempt history, test results

**Management Dashboard**:
The local operations interface for the API Pool, used to understand Upstream availability, explain why Codex requests may fail, and perform safe Management API actions such as Health Probes, Billing refreshes, Upstream enable toggles, Model Override changes, and Upstream creation.
_Avoid_: marketing page, monitoring wallboard, status page, admin system

**Request Failure Diagnosis**:
The primary Management Dashboard workflow for explaining why Codex cannot complete a model request through the API Pool. It focuses on pool availability, eligible Upstreams, Health State, Cooldown, missing Upstream Keys, Disabled Upstreams, recent request outcomes, and model compatibility.
_Avoid_: monitoring, analytics, configuration, troubleshooting page

**Top Diagnostic Bar**:
The first Management Dashboard region, summarizing whether the API Pool is usable, degraded, or blocked and highlighting the most likely reason.
_Avoid_: hero, header, summary cards

**Upstream Workbench**:
The primary Management Dashboard region for scanning and operating on Upstreams, with dense rows or compact cards for availability, Health State, Cooldown, latency, models, Usage, Billing, and actions.
_Avoid_: card grid, gallery, status wall

**Recent Request Timeline**:
The Management Dashboard region that explains recent Model Interaction Request outcomes, including selected Upstream, attempted model, status, duration, token count, Retry, and Fallback evidence.
_Avoid_: request log, activity feed, history

**Upstream Editor**:
The Management Dashboard form used to create or edit Upstream Pool Configuration without distracting from Request Failure Diagnosis.
_Avoid_: add form, config panel, settings

**Operational Console**:
The visual posture of the Management Dashboard: compact, calm, high-signal, low-decoration, and optimized for repeated local operations rather than presentation.
_Avoid_: hero page, monitoring wallboard, marketing UI, decorative dashboard

**Safe Dashboard Action**:
A Management Dashboard action that is low-risk or easily reversible, such as refreshing status, running a Health Probe, refreshing Billing, setting Model Override, clearing Model Override, or opening an Upstream site URL.
_Avoid_: harmless action, button action, quick action

**Confirmed Dashboard Action**:
A Management Dashboard action that should require explicit confirmation because it can affect Selection, Pool Configuration, or secret handling, such as disabling an Upstream, moving an Upstream into or out of Quarantine, replacing existing Upstream configuration, or saving a plaintext Upstream Key.
_Avoid_: dangerous action, admin action, destructive action
