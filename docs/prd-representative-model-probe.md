## Problem Statement

Management Dashboard health actions use synthetic Health Probe request shapes that can differ from real Codex Desktop Model Interaction Requests. Some Upstreams, including `any`-style Codex-context-gated services, reject synthetic probes while accepting real Codex Desktop traffic. This can cause the API Pool to report a usable Upstream as unavailable, influence Selection incorrectly, and mislead operators.

Using an in-memory Representative Request Template as a Management API test request is also unreliable because captured templates may contain one-time fields such as attestation, nonce, turn state, signatures, or session-bound metadata. Replaying those fields can fail even when fresh real Codex traffic would work.

Model listing must remain discovery-only. `/models` can list models but cannot prove that a model can produce output for Codex Desktop. Availability must be proven by a valid model response from real Codex traffic, while synthetic Health Probes provide only first-layer diagnostic evidence.

## Solution

Management Dashboard testing uses two layers:

1. Synthetic Health Probe: run a controlled Responses/Chat/Anthropic model request for the active Model Override. Deterministic successes and deterministic authoritative failures can update Health State. Non-representative and inconclusive results must remain dispatchable and must not block Selection.
2. Real Codex request validation: the operator verifies true availability by sending real Codex traffic through the normal model request interface. The actual response determines whether representative success evidence is refreshed or a real-traffic failure is recorded.

Representative Request Template metadata is still captured from authenticated real Codex Desktop Responses Model Interaction Requests, but it is diagnostic metadata only. It stores freshness, model, and redacted replay-risk header names; it does not store a replayable request body or unmasked header values, and it is not used for Management API Health Probes.

Probe classification must distinguish successful synthetic evidence, authoritative failures, non-representative results, and inconclusive results. Only Authoritative Probe Failures can block Selection. Non-representative and inconclusive results remain visible in diagnostics but do not mark an Upstream unavailable by themselves.

Failure responses from the Management API testing module must include the full captured Upstream probe result for follow-up diagnosis: status, latency, response headers, response body, transport error, and retry-after when present.

Selection must preserve load balancing. Representative evidence changes effective selection probability through bounded multipliers and cooldowns; it must not create a fixed priority order where only freshly verified Upstreams receive traffic. Unknown, stale, and non-authoritatively degraded candidates must keep exploratory traffic unless user-disabled, missing keys, model/protocol incompatibility, active cooldown, or authoritative failure blocks them.

## User Stories

1. As an operator, I want the Health Probe button to run a synthetic first-layer check, so that deterministic failures are visible without pretending the check is real Codex traffic.
2. As an operator, I want a failed synthetic Health Probe to be labeled non-representative or inconclusive when it does not match Codex Desktop traffic, so that I do not disable a usable Upstream.
3. As an operator, I want failed tests to return the full captured Upstream error result, so that I can diagnose merchant-specific responses afterward.
4. As an operator, I want real Codex traffic to be the second-layer availability proof, so that one-time template fields are not replayed as a misleading test.
5. As an operator, I want `/models` to remain model discovery only, so that listed models are not mistaken for proven model availability.
6. As an operator, I want a synthetic Health Probe to require real output evidence, so that HTTP `2xx` without usable output does not count as healthy.
7. As an operator, I want the dashboard to show whether `ok` came from synthetic probe or real Codex traffic, so that I can judge confidence correctly.
8. As an operator, I want an Upstream that real Codex Desktop traffic has recently used successfully to remain selectable after a non-representative probe failure, so that management checks do not break real traffic.
9. As an operator, I want auth, quota, rate limit, network, TLS, timeout, clearly unsupported model/API, and invalid output shape failures to block or cool down when appropriate, so that truly unusable Upstreams are avoided.
10. As an operator, I want merchant-specific ambiguous `400`, `403`, `404`, and `5xx` errors to remain inconclusive unless they contain strong signals, so that vendor-specific wording does not create false negatives.
11. As an operator, I want `invalid_responses_request`, `invalid Codex request`, or `missing Codex context` from a synthetic probe to mean non-representative, so that Codex-context-gated Upstreams can still be tried by real Codex traffic.
12. As an operator, I want the same errors from real Codex traffic to be authoritative for that request shape, so that a real Codex rejection is treated seriously.
13. As an operator, I want Representative Request Template metadata to be memory-only and redacted, so that sensitive Codex context values are not retained.
14. As an operator, I want user prompt, conversation history, metadata, files, images, audio, cookies, authorization, and replayable request bodies to be excluded from template metadata, so that health probing does not retain user content or secrets.
15. As an operator, I want real Codex successes to refresh representative success evidence for a bounded time, so that recent availability influences Selection without becoming a permanent whitelist.
16. As an operator, I want authoritative failures to override fresh success evidence, so that an Upstream that becomes unavailable later is cooled down promptly.
17. As an operator, I want repeated non-authoritative real-traffic failures to trigger only a short operational cooldown, so that the system backs off without labeling unclear errors as authoritative failure.
18. As an operator, I want representative evidence scoped to Upstream Key, protocol, and model, so that one key's success does not overstate another key's health.
19. As an operator, I want unknown and stale candidates to receive some exploratory traffic, so that the pool can rediscover usable Upstreams.
20. As an operator, I want dashboard diagnostics to explain whether evidence is representative, non-representative, inconclusive, or authoritative, so that I can understand why Selection behaved as it did.

## Implementation Decisions

- Keep an in-memory Representative Request Template metadata store keyed by `protocol + client_family`, initially `responses + codex_desktop`.
- Do not persist Representative Request Template metadata to Pool Configuration, Runtime State snapshots, logs, or raw dashboard output.
- Capture template metadata only from authenticated real Codex Desktop Responses Model Interaction Requests at the model request interface, after Pool Token authorization and before upstream forwarding.
- Store only redacted header names, model, captured time, expiry, and replay-risk field names. Do not store template bodies or unmasked header values.
- Manual Management Dashboard health actions do not replay Representative Request Templates. They run ordinary synthetic Health Probes.
- Scheduled background Health Probes also do not replay Representative Request Templates.
- Synthetic Health Probe target model comes from Model Override. `/models` is never used to choose a supposedly available model.
- Synthetic Health Probe success requires a valid model response shape, not merely HTTP success.
- Probe classification returns a richer outcome: `ok`, `authoritative_failure`, `non_representative`, or `inconclusive`.
- Only `authoritative_failure` can mark an Upstream or Upstream Key unavailable for Selection.
- Strong authoritative signals include recognized auth/key rejection, quota/rate-limit exhaustion, network/TLS/socket/timeout failure, clearly unsupported model/API, and target-protocol `2xx` with invalid output shape.
- Ambiguous merchant-specific HTTP errors default to `inconclusive` or `non_representative`.
- `invalid_responses_request`, `invalid Codex request`, `codex_access_restricted`, or `missing Codex context` from a synthetic Health Probe is non-representative unless accompanied by a strong authoritative signal. The same error from real Codex traffic is authoritative for that represented request shape.
- Direct and batch Management API probe responses include `upstream_result` for failed probe health results, containing status, latency, response headers, body, transport error, and retry-after when present.
- Representative success evidence is scoped to Upstream Key, protocol, and model, with 30-minute freshness.
- Selection remains weighted random. Representative evidence applies bounded multipliers and never creates a hard priority queue.
- Unknown, stale, and non-authoritatively degraded candidates keep a minimum effective weight floor unless blocked by user-disabled state, missing key, active cooldown, or clear model/protocol incompatibility.
- Three consecutive non-authoritative real-traffic failures may trigger a short operational cooldown, but repetition alone does not turn them into Authoritative Probe Failures.
- Health State `ok` must keep source and scope. Synthetic probe success and real Codex traffic success must remain distinguishable in dashboard and status payloads.

## Testing Decisions

- Test at the highest existing seam: instantiate the API Pool server with fake local Upstreams, exercise HTTP model routes and Management API routes, then assert externally visible status, health, selection, forwarded request behavior, and probe response payloads.
- Extend existing smoke tests that already cover synthetic invalid Codex request behavior, real Codex request recovery, `/models` not proving availability, and real-traffic health updates.
- Add fake Codex-context-gated Upstreams that reject synthetic Health Probe requests but accept real Codex Desktop-shaped requests with required context headers.
- Verify synthetic manual health action remains non-representative and does not block Selection.
- Verify authenticated real Codex Desktop request captures only redacted template metadata and does not persist user content, authorization, or replayable body data.
- Verify manual health action after template metadata capture remains synthetic and does not replay one-time headers such as attestation.
- Verify failed synthetic probe responses include full captured Upstream result details.
- Verify real Codex request success marks Health State `ok` with `source = real_traffic` and refreshes representative success evidence.
- Verify synthetic probe requires output evidence, not only HTTP `2xx`.
- Verify ambiguous merchant-specific errors do not mark an Upstream unavailable.
- Verify authoritative auth/quota/rate/network/timeout/unsupported/invalid-output failures still cool down or block as designed.
- Verify Selection remains weighted random and does not starve unknown or stale candidates solely because another candidate is fresh verified.
- Verify Runtime State persistence does not include Representative Request Template metadata or probe `upstream_result` bodies.

## Out of Scope

- Automatic scheduled Representative Model Probes.
- Persistent storage of Representative Request Templates.
- Full Codex CLI client-family support.
- Dashboard manual selection of client family.
- Using `/models` as availability proof.
- Replaying user prompts, conversation history, files, images, audio, metadata, cookies, authorization, attestation, nonce, turn state, signatures, or other one-time fields.
- A permanent whitelist for any Upstream.
- Replacing existing weighted random Selection with a fixed priority queue.
- Building a new standalone probe service.

## Further Notes

- This PRD follows the project glossary terms: Health Probe, Representative Request Template, Authoritative Probe Failure, Non-representative Probe Result, Model Interaction Request, Selection, Runtime State, and Management Dashboard.
- ADR-0003 records the decision that non-authoritative probes do not block Selection and that Management API tests must not replay in-memory templates.
- Main operational principle: model availability is proven by real output from a real model request, not by model listing and not by replaying captured template data.
