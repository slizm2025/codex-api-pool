# Codex API Pool

This context describes the local API pool used by Codex to reach OpenAI-compatible upstream services with failover, cooldown, and health awareness.

## Language

**API Pool**:
A local OpenAI-compatible proxy that selects among multiple upstream services, retries eligible failures, cools down unhealthy options, and forwards requests for Codex.
_Avoid_: proxy, router, gateway, key pool, site pool

**Upstream**:
An external OpenAI-compatible API service that the API Pool can send model requests to. An Upstream has a base URL, weight, keys, health state, cooldown state, and optional billing or quota information.
_Avoid_: provider, site, API site, station, vendor

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

**Health State**:
The API Pool's latest classification of an Upstream's observed availability, such as `ok`, `missing_key`, `rate_limited`, `server_error`, `network_error`, or `timeout`.
_Avoid_: status, state, result

**Availability**:
The recent success rate of real model request attempts for an Upstream, calculated over a bounded rolling window and used as a Selection weight multiplier. Health Probes do not count toward Availability.
_Avoid_: health, uptime, cumulative success rate

**Selection**:
The process of choosing an available Upstream and Upstream Key for a request. Selection considers weight, Availability, cooldown, health, in-flight requests, failure history, and model support.
_Avoid_: routing, dispatch, load balancing

**Retry**:
A subsequent attempt for the same client request after an eligible failure, retryable HTTP status, network error, or timeout.
_Avoid_: fallback, recovery, rerun

**Fallback**:
The observable switch from one Upstream candidate to another during Retry.
_Avoid_: retry, routing, failover

**Streaming Boundary**:
The point at which an Upstream has returned a successful response and the API Pool has begun forwarding the response stream. Before this boundary, the API Pool may Retry or Fallback; after it, the API Pool does not attempt lossless generation resume.
_Avoid_: stream retry, resume, continuation

**Management API**:
The API Pool's control interface for observing and changing pool state, including status, Upstream creation, health probes, enable toggles, and billing refreshes. It is separate from the OpenAI-compatible model request interface used by Codex.
_Avoid_: admin API, status API, pool API, dashboard API

**Admin Token**:
The Bearer token used to authorize access to the Management API. It may be configured with the same environment variable as the Pool Token, but it is a separate domain concept.
_Avoid_: pool token, upstream key, API key

**Health Probe**:
An availability check that the API Pool sends to an Upstream, usually against `/models` or a configured health path. A Health Probe updates Health State, latency, HTTP status, and discovered model information without representing a Codex model request.
_Avoid_: test, check, ping, health check

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
The Management Dashboard region that explains recent request outcomes, including selected Upstream, attempted model, status, duration, token count, Retry, and Fallback evidence.
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
A Management Dashboard action that should require explicit confirmation because it can affect Selection, Pool Configuration, or secret handling, such as disabling an Upstream, replacing existing Upstream configuration, or saving a plaintext Upstream Key.
_Avoid_: dangerous action, admin action, destructive action
