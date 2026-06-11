# Representative Probe Prototype Notes

PROTOTYPE - delete this note with `prototype-representative-probe*.mjs` after the decision is absorbed.

## Question

Can a short-lived in-memory template captured from real Codex traffic make a Management API-triggered model probe representative enough to avoid false unavailable judgements for Codex-context-gated Upstreams?

## Demo Result

The prototype says yes, with constraints:

- A synthetic Health Probe against an any-like Upstream returns `400 invalid_responses_request` and must be treated as non-representative, not unavailable.
- Capturing a real Codex `/v1/responses` request template lets a later Representative Model Probe preserve required Codex context headers while replacing user input with a health-check prompt.
- The template must not keep `authorization`, cookies, user input, or arbitrary request `metadata`.
- Template expiry should block a new Representative Model Probe, but it should not erase a previous representative success from Health State.

## Candidate Decision

Use Health Probe for operational/synthetic checks and Representative Model Probe for Codex-native availability evidence. The Representative Model Probe can use an in-memory, TTL-limited request template captured from real traffic.
