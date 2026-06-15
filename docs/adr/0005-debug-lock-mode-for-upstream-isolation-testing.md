# Debug Lock Mode for Upstream Isolation Testing

## Context

When diagnosing failures in the API Pool, operators need to distinguish between:
1. Issues in the Pool's selection, retry, or adaptation logic
2. Issues in a specific Upstream's protocol support, authentication, or availability

Normal Pool operation involves Selection (choosing among multiple Upstreams), Health State checks, Cooldown, Availability scoring, and Retry/Fallback across candidates. This complexity makes it hard to isolate whether a failure is caused by Pool logic or by a specific Upstream.

Existing diagnostic tools:
- **Health Probes** use synthetic requests with browser-like User-Agent, which may not represent real client traffic
- **runCurlTest** bypasses the Pool entirely but doesn't use configured Upstreams or test protocol adaptation
- **Recent Request Timeline** shows outcomes but not what would have happened with other protocols

Operators need a way to **lock all requests to a single Upstream** and observe how it handles real client requests through different protocols, without the Pool's routing logic interfering.

## Decision

We introduce **Debug Lock Mode**: a temporary, session-only diagnostic state that:

### Core Behavior

1. **Forces all Model Interaction Requests to a specified Upstream**, bypassing:
   - Selection algorithm (weight, availability, in-flight count)
   - Health State checks (ok, rate_limited, server_error, etc.)
   - Cooldown timers (upstream-level and key-level)
   - Availability multipliers
   - Disabled/Quarantined state (allows locking even quarantined/disabled Upstreams)

2. **Tests protocols sequentially** according to client entry point:
   - **Responses requests**: native Responses → adapted Chat Completions → adapted Anthropic Messages
   - **Messages requests**: native Anthropic Messages only (no reverse adapters exist)

3. **Falls back conservatively** only on Endpoint Not Found Signal:
   - HTTP 404, 405, 501
   - HTTP 400 with explicit "unsupported endpoint"/"invalid path" language in error body
   - Does NOT fallback on: 401/403 (auth), 429 (rate limit), 500/502/503 (server error), timeouts, or ambiguous 400s
   - Rationale: Non-protocol errors should be exposed immediately for diagnosis

4. **Respects Streaming Boundary**: Once HTTP 200 and streaming starts, no protocol fallback (consistent with ADR-0001)

5. **Does NOT update Runtime State**:
   - Does NOT update: Availability, Health State, Cooldown, Protocol Capability, Usage
   - DOES record: Recent Request Timeline (with `debug_lock: true` marker)
   - Rationale: Debug traffic is forced routing, not representative of normal selection outcomes

6. **Session-only (not persisted)**:
   - Stored in `state.debugLock` (memory only)
   - Not written to `stats.local.json` or `config.local.json`
   - Cleared on Pool restart
   - Rationale: Prevents accidental production lockout if operator forgets to unlock

7. **Returns complete diagnostics**:
   - On success: Adds `X-Debug-Lock-*` response headers showing which protocols were tried
   - On failure: Returns synthesized 502 response with per-attempt details (sequence, protocol, adapter status, HTTP status, error body, latency, fallback reason)

### Configuration Options

When locking, operators can specify:
- `respect_model_override` (default: true): Whether to apply Pool's Model Override or use client's original model

### Adapter Behavior

Debug Lock **always tests all adapters** regardless of `config.compatibility.adapter_mode` settings, because:
- Normal adapter config controls production traffic (users may disable lossy adapters)
- Debug Lock's goal is exhaustive protocol testing
- Diagnostics mark which adapters are `production_disabled: true` so operators understand production vs debug behavior

### Key Selection

Uses the **first valid Upstream Key** (first `keys[]` entry whose `env` variable exists and is non-empty), ignoring key-level cooldown.

### Conflict Handling

- **Quarantined/Disabled Upstreams**: Allowed (debug purpose is isolated testing), returns note in lock response
- **Missing Upstream Keys**: Allowed with warning (requests will fail with auth error)
- **Codex OAuth Upstreams**: Rejected (per-request authentication flow incompatible with lock semantics)

### Management API

- Lock: `POST /pool/upstreams/{name}/debug-lock` with optional `{"respect_model_override": true}`
- Unlock: `POST /pool/debug-unlock`
- Query: `GET /pool/status` includes `debug_lock` object when active

### Dashboard UI

- **When locked**: Top Diagnostic Bar shows prominent warning with [Unlock] button
- **When unlocked**: Upstream Workbench rows show [🔒 Lock] button
- **Lock confirmation dialog**: Explains behavior and shows `respect_model_override` checkbox
- **Recent Request Timeline**: Marks debug requests with 🔒 icon and expandable per-attempt details

## Consequences

### Positive

- **Clear isolation**: Operators can definitively test "does this Upstream support this protocol?" without Pool logic interfering
- **Real client traffic**: Uses actual Codex/Claude Desktop requests, not synthetic probes
- **Exhaustive protocol testing**: Tries all adapter paths even if disabled in production
- **Safe by default**: Session-only, doesn't corrupt production state, auto-unlocks on restart
- **Rich diagnostics**: Complete visibility into what was attempted and why it failed/succeeded

### Negative

- **Manual workflow**: Requires operator to lock, test in client, unlock (not automated)
- **Global lock**: All clients affected during debug session (but this is the intent for focused diagnosis)
- **Code surface area**: Adds ~500-800 lines to server.mjs (concentrated in one region)

### Trade-offs

1. **No Runtime State updates** (chosen over "selective updates"):
   - Simpler mental model: debug traffic is completely isolated
   - Avoids contaminating Availability scores with non-representative forced routing
   - But: Operators must manually record findings (e.g., "this Upstream doesn't support Responses")

2. **Conservative fallback** (chosen over "aggressive fallback"):
   - Exposes real problems (auth errors, rate limits) immediately
   - Avoids masking Upstream issues by trying other protocols
   - But: Operator must manually retry if they want to see other protocol attempts after non-protocol errors

3. **Session-only** (chosen over "persistent"):
   - Safer: can't accidentally leave production traffic locked
   - But: Lost on restart (operator must re-lock if Pool crashes during diagnosis)

## Implementation Notes

Code will be organized in a single `// DEBUG LOCK MODE` section in `server.mjs`, between "Billing probe logic" and "Management API handlers", containing:
- `enableDebugLock(state, upstreamName, options)`
- `disableDebugLock(state)`
- `buildProtocolAttemptSequence(clientProtocol)`
- `shouldFallbackToNextProtocol(status, errorBody)`
- `executeDebugLockedRequest(req, res, state, config, clientProtocol)`
- `buildDebugAttemptDiagnostics(attempts, debugLockState, clientRequest)`

Main request handler checks `isDebugLockActive(state)` before Selection and routes to `executeDebugLockedRequest` if active.
