## Problem Statement

Management Dashboard health actions currently use synthetic Health Probe request shapes that can differ from real Codex Desktop Model Interaction Requests. Some Upstreams, including `any`-style Codex-context-gated services, reject synthetic probes while accepting real Codex Desktop traffic. This causes the API Pool to report a usable Upstream as unavailable, which can incorrectly influence Selection and mislead operators.

Model listing must remain discovery-only. `/models` can list models but cannot prove that a model can produce output for Codex Desktop. Availability must be proven by a real model response result from real Codex traffic or from a Representative Model Probe whose request shape comes from real Codex Desktop traffic.

## Solution

Capture a sanitized, memory-only Codex Desktop Representative Request Template from authenticated real Responses Model Interaction Requests. When an operator manually runs a Management Dashboard health action, prefer a Representative Model Probe if a fresh template exists. If no fresh template exists, run the ordinary Health Probe but label its result as non-representative of Codex Desktop availability.

Probe classification must distinguish successful representative evidence from authoritative failures, non-representative results, and inconclusive results. Only Authoritative Probe Failures can block Selection. Non-representative and inconclusive results remain visible in diagnostics but do not mark an Upstream unavailable by themselves.

Selection must preserve load balancing. Representative evidence changes effective selection probability through bounded multipliers and cooldowns; it must not create a fixed priority order where only freshly verified Upstreams receive traffic. Unknown, stale, and non-authoritatively degraded candidates must keep exploratory traffic unless user-disabled, missing keys, model/protocol incompatibility, active cooldown, or authoritative failure blocks them.

## User Stories

1. As an operator, I want the Health Probe button to use a Codex Desktop-shaped request when available, so that its result reflects real Codex availability.
2. As an operator, I want a failed synthetic Health Probe to be labeled non-representative when it does not match Codex Desktop traffic, so that I do not disable a usable Upstream.
3. As an operator, I want `/models` to remain model discovery only, so that listed models are not mistaken for proven model availability.
4. As an operator, I want a Representative Model Probe to require real model output, so that HTTP `2xx` without usable output does not count as healthy.
5. As an operator, I want the dashboard to show whether `ok` came from synthetic probe, representative probe, or real Codex traffic, so that I can judge confidence correctly.
6. As an operator, I want an Upstream that real Codex Desktop traffic has recently used successfully to remain selectable after a non-representative probe failure, so that management checks do not break real traffic.
7. As an operator, I want an Upstream with no fresh representative template to show "not representative-verified" rather than "unavailable", so that missing evidence is not confused with failure evidence.
8. As an operator, I want auth, quota, rate limit, network, TLS, timeout, clearly unsupported model/API, and invalid output shape failures to block or cool down when appropriate, so that truly unusable Upstreams are avoided.
9. As an operator, I want merchant-specific ambiguous `400`, `403`, `404`, and `5xx` errors to remain inconclusive unless they contain strong signals, so that vendor-specific wording does not create false negatives.
10. As an operator, I want `invalid_responses_request` from a synthetic probe to mean non-representative, so that `any`-style Upstreams can still be tried by real Codex traffic.
11. As an operator, I want the same `invalid_responses_request` from a Representative Model Probe or real Codex request to be authoritative for that request shape, so that a real Codex rejection is treated seriously.
12. As an operator, I want Representative Request Templates to be memory-only, so that sensitive Codex context headers are not persisted.
13. As an operator, I want sensitive-but-required Codex context headers to be retained only while fresh and masked everywhere, so that representative probing can work without leaking secrets.
14. As an operator, I want user prompt, conversation history, metadata, files, images, audio, cookies, and authorization to be excluded from templates, so that health probing does not retain user content or secrets.
15. As an operator, I want Representative Model Probes to preserve stream vs non-stream request type, so that probes do not drift back into synthetic request shapes.
16. As an operator, I want Representative Model Probes to replace user semantic input with minimal harmless probe content, so that the request shape is preserved without replaying user content.
17. As an operator, I want real Codex successes to refresh representative success evidence for a bounded time, so that recent availability influences Selection without becoming a permanent whitelist.
18. As an operator, I want authoritative failures to override fresh success evidence, so that an Upstream that becomes unavailable later is cooled down promptly.
19. As an operator, I want repeated non-authoritative real-traffic failures to trigger only a short operational cooldown, so that the system backs off without labeling unclear errors as authoritative failure.
20. As an operator, I want representative evidence scoped to Upstream Key, protocol, and model, so that one key's success does not overstate another key's health.
21. As an operator, I want Upstream-level display summaries, so that I can scan health quickly while Selection still uses key-level evidence.
22. As an operator, I want multiple fresh verified Upstreams to continue sharing traffic by configured weight and Availability, so that load balancing remains effective.
23. As an operator, I want unknown and stale candidates to receive some exploratory traffic, so that the pool can rediscover usable Upstreams.
24. As an operator, I want manually triggered health actions to use representative templates, so that explicit tests are high-confidence.
25. As an operator, I do not want scheduled background Health Probes to replay sensitive representative templates in the first implementation, so that unattended probes stay low-risk.
26. As an operator, I want Codex Desktop templates separated by client family, so that future Codex CLI request shapes do not silently share Desktop templates.
27. As an operator, I want template capture to happen only after Pool Token authorization, so that unauthenticated traffic cannot seed representative probes.
28. As an operator, I want a failed real Codex request to refresh the request-shape template but not success evidence, so that shape capture and availability evidence remain separate.
29. As an operator, I want Representative Model Probes to target the current Model Override first, so that health testing matches the model Selection will use.
30. As an operator, I want dashboard diagnostics to explain whether evidence is representative, non-representative, inconclusive, or authoritative, so that I can understand why Selection behaved as it did.

## Implementation Decisions

- Add an in-memory Representative Request Template store to Runtime State. It is keyed by `protocol + client_family`, initially `responses + codex_desktop`.
- Do not persist Representative Request Templates to Pool Configuration, Runtime State snapshots, logs, or dashboard payloads.
- Capture templates only from authenticated real Codex Desktop Responses Model Interaction Requests at the model request interface, after Pool Token authorization and before upstream forwarding.
- Sanitize captured headers through an allowlist. Keep only request-shape and required Codex context headers. Never keep pool `authorization`, Upstream Key, cookies, arbitrary user metadata, or unmasked sensitive values in dashboard/status output.
- Sanitize captured body through structural allowlisting. Keep request-shape fields such as model position, tools, tool choice, parallel tool calls, store, reasoning, text config, stream mode, and minimal Responses shell. Drop user input, prompt text, conversation history, file/image/audio payloads, previous response IDs, arbitrary metadata, and user/session/project identifiers.
- Manual Management Dashboard health actions call Representative Model Probe first when a fresh Codex Desktop template exists for Responses. Without a fresh template, they fall back to ordinary Health Probe and label the result as not representative of Codex Desktop.
- Scheduled background Health Probes do not replay Representative Request Templates in the first implementation.
- Representative Model Probe target model is chosen from Model Override first, then captured template model, then explicit operator choice if added later. `/models` is never used to choose a supposedly available model.
- Representative Model Probe preserves captured native request type, including streaming vs non-streaming.
- Representative Model Probe replaces user semantic content with minimal harmless probe content such as `Respond with OK.` while preserving request shape.
- Probe classification returns a richer outcome: `ok`, `authoritative_failure`, `non_representative`, or `inconclusive`.
- Only `authoritative_failure` can mark an Upstream or Upstream Key unavailable for Selection.
- Strong authoritative signals include recognized auth/key rejection, quota/rate-limit exhaustion, network/TLS/socket/timeout failure, clearly unsupported model/API, and target-protocol `2xx` with invalid output shape.
- Ambiguous merchant-specific HTTP errors default to `inconclusive` or `non_representative`.
- `invalid_responses_request` or `invalid Codex request` from synthetic Health Probe is non-representative. The same error from Representative Model Probe or real Codex traffic is authoritative for that represented request shape.
- Representative success evidence is scoped to Upstream Key, protocol, and model, with 30-minute freshness.
- Representative success may be restored as Runtime State only with timestamps and freshness data. Representative Request Templates are never restored because they are memory-only.
- Selection remains weighted random. Representative evidence applies bounded multipliers and never creates a hard priority queue.
- Unknown, stale, and non-authoritatively degraded candidates keep a minimum effective weight floor unless blocked by user-disabled state, missing key, active cooldown, or clear model/protocol incompatibility.
- Three consecutive non-authoritative real-traffic failures may trigger a short operational cooldown, but repetition alone does not turn them into Authoritative Probe Failures.
- Health State `ok` must keep source and scope. Synthetic probe success, representative probe success, and real Codex traffic success must remain distinguishable in dashboard and status payloads.

## Testing Decisions

- Test at the highest existing seam: instantiate the API Pool server with fake local Upstreams, exercise HTTP model routes and Management API routes, then assert externally visible status, health, selection, and forwarded request behavior.
- Extend existing smoke tests that already cover synthetic invalid Codex request behavior, real Codex request recovery, `/models` not proving availability, and real-traffic health updates.
- Add a fake `any`-style Upstream that rejects synthetic Health Probe requests with `invalid_responses_request` but accepts Codex Desktop-shaped requests with required context headers.
- Verify no-template manual health action remains non-representative and does not block Selection.
- Verify authenticated real Codex Desktop request captures a template without persisting user content or authorization.
- Verify manual health action after template capture sends a Representative Model Probe preserving Codex Desktop headers and native stream mode.
- Verify Representative Model Probe success marks Health State `ok` with `source = representative_probe`.
- Verify Representative Model Probe requires output evidence, not only HTTP `2xx`.
- Verify ambiguous merchant-specific errors do not mark an Upstream unavailable.
- Verify authoritative auth/quota/rate/network/timeout/unsupported/invalid-output failures still cool down or block as designed.
- Verify Selection remains weighted random and does not starve unknown or stale candidates solely because another candidate is fresh verified.
- Verify `/pool/status` masks sensitive template evidence and never exposes raw sensitive headers.
- Verify Runtime State persistence does not include Representative Request Templates.

## Out of Scope

- Automatic scheduled Representative Model Probes.
- Persistent storage of Representative Request Templates.
- Full Codex CLI client-family support.
- Dashboard manual selection of client family.
- Using `/models` as availability proof.
- Replaying user prompts, conversation history, files, images, audio, metadata, cookies, or authorization.
- A permanent whitelist for any Upstream.
- Replacing existing weighted random Selection with a fixed priority queue.
- Building a new standalone probe service.

## Further Notes

- This PRD follows the project glossary terms: Health Probe, Representative Model Probe, Representative Request Template, Authoritative Probe Failure, Non-representative Probe Result, Model Interaction Request, Selection, Runtime State, and Management Dashboard.
- ADR-0003 records the decision that non-authoritative probes do not block Selection.
- Prototype results showed the core feasibility: a synthetic probe can fail against an `any`-like Upstream while a representative Codex-shaped request succeeds.
- Main operational principle: model availability is proven by real output from a representative model request, not by model listing and not by synthetic request success alone.
