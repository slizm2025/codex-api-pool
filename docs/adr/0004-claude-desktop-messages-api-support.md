# Claude Desktop Messages API support

## Context

The API Pool was originally designed for Codex Desktop, which sends OpenAI Responses API requests to `/v1/responses`. Now we need to support Claude Desktop, which sends Anthropic Messages API requests to `/v1/messages`.

Supporting both clients means:
- Two distinct entry protocols (Responses and Messages)
- Multiple upstream protocols (OpenAI-compatible, Anthropic Messages, or both)
- Need for bidirectional protocol adaptation to maximize upstream pool utilization

## Decision

### Entry point

Add a new `/v1/messages` endpoint that accepts Anthropic Messages API requests from Claude Desktop, separate from the existing `/v1/responses` endpoint for Codex Desktop.

Both endpoints share the same Pool Token authentication (`server.auth_token_env`) and the same upstream pool, but differ in:
- Request format validation
- Protocol adaptation strategy
- Response format (including error responses)

### Protocol adaptation strategy

Implement **intelligent bidirectional adaptation** with the following routing priorities:

**For Messages entry (`/v1/messages`):**
1. Native Messages Route (forward to Anthropic upstreams without conversion)
2. Messages → Chat Completions adapter (convert to OpenAI Chat, then convert response back)
3. Messages → Responses adapter (convert to Responses, then convert response back)

**For Responses entry (`/v1/responses`):** (existing behavior, unchanged)
1. Native Responses Route
2. Responses → Chat Completions adapter
3. Responses → Anthropic Messages adapter

### Compatibility mode

Extend the existing `compatibility.adapter_mode` configuration to control Messages adaptation:

```json
{
  "compatibility": {
    "adapter_mode": {
      "strip_responses_only_features": false,
      "strip_messages_only_features": false,
      "adapters": {
        "responses_to_anthropic_messages": true,
        "responses_to_chat_completions": true,
        "messages_to_chat_completions": false,
        "messages_to_responses": false
      }
    }
  }
}
```

**Default behavior:**
- Messages-to-other adapters are **disabled by default**
- When a Messages request contains Messages-only Features and no native Anthropic upstream is available, return 422 with clear diagnostic information
- User must explicitly enable `strip_messages_only_features: true` and the specific adapter to allow lossy conversion

This matches the existing Responses adapter behavior and prevents silent feature degradation.

### Messages-only Features

Features that must be detected and stripped when converting Messages to Chat/Responses:

**System level:**
- `system` array entries with `cache_control` (Prompt Caching)
- `thinking` content blocks (Extended Thinking)

**Message level:**
- Message-level `cache_control`
- Tool definition `cache_control`

**Tools:**
- Computer Use tools (`computer_20241022`, `text_editor_20241022`, `bash_20241022`)
- Anthropic-specific tool parameter structures that don't map to OpenAI

**Output control:**
- Anthropic-specific `output_config` fields without Chat/Responses equivalents

When stripped, these features are reported via `x-codex-api-pool-stripped` response header and visible in Dashboard's Recent Request Timeline.

### Selection logic

Enhance Selection to consider entry protocol:

1. **Protocol-aware filtering:**
   - Messages entry prefers upstreams with `api: "anthropic"` or `api: "both"`
   - Only considers `api: "openai"` upstreams when adaptation is enabled and allowed

2. **Model-driven routing:**
   - Model Override applies globally regardless of entry protocol
   - If override creates protocol mismatch (e.g., GPT model with only Anthropic upstreams), Selection finds no candidates and returns 503

3. **Learned Forwarding Strategy:**
   - Track successful protocol routes per (upstream, model, entry_protocol) tuple
   - Reuse proven routes, with periodic Native Route rechecks

### Error responses

Return protocol-appropriate error format based on entry path:

- `/v1/messages` → Anthropic format: `{"type": "error", "error": {"type": "...", "message": "..."}}`
- `/v1/responses` → OpenAI format: `{"error": {"message": "...", "type": "...", "code": "..."}}`
- `/pool/*` → existing format (unchanged)

### Dashboard observability

Enhance Dashboard with minimal UI changes:

- **Recent Request Timeline:** Add "Entry Protocol" column (Responses / Messages)
- **Upstream cards:** Display supported protocols (based on `api` field)
- **Forwarding Strategy display:** Show entry protocol in adapter labels (e.g., "Messages → Chat adapter")
- **Top Diagnostic Bar:** Consider both entry protocols when assessing pool availability

No separate tabs or views; keep the single-pane-of-glass Operational Console design.

### Health Probe

Reuse existing protocol detection logic:

- Upstreams marked `api: "anthropic"` or `api: "both"` are assumed to support Messages
- No separate "Messages Probe" at launch
- True Messages capability is confirmed through real traffic (Representative Availability pattern)
- Health Probe uses current Model Override; if override is a Claude model, probe Anthropic-capable upstreams with Messages format when beneficial

### Implementation phases

**Phase 1: Native Messages forwarding**
- `/v1/messages` endpoint with authentication
- Native Messages → Messages forwarding to Anthropic upstreams only
- Anthropic error format responses
- Basic Dashboard integration (show entry protocol in timeline)

**Phase 2: Messages → Chat Completions**
- Request adapter: Messages → Chat Completions
- Response adapter: Chat Completions → Messages
- Messages-only Features detection and compatibility mode
- Selection enhancement for protocol-aware routing

**Phase 3: Messages → Responses**
- Request adapter: Messages → Responses
- Response adapter: Responses → Messages
- Full adapter coverage

**Phase 4: Dashboard and configuration polish**
- Complete Dashboard observability enhancements
- Configuration UI for new adapter toggles
- Documentation and migration guide

## Consequences

### Positive

- **Multi-client support:** Both Codex Desktop and Claude Desktop can use the same API Pool
- **Maximum upstream utilization:** Protocol adaptation ensures requests can use any compatible upstream, not just native ones
- **Explicit degradation:** 422 errors prevent silent feature loss; users opt into lossy conversion
- **Unified configuration:** Single pool token, single upstream pool, single Model Override
- **Backward compatible:** Existing Codex-only deployments unaffected; new features default to disabled

### Negative

- **Increased complexity:** More protocol adapters to maintain, more conversion edge cases
- **Testing surface:** Need to test all adapter combinations (6 directions: Responses↔Messages, Responses↔Chat, Messages↔Chat)
- **Performance overhead:** Protocol conversion adds latency (though typically < 10ms for non-streaming request transformation)
- **Feature parity challenge:** Anthropic and OpenAI APIs evolve independently; new features require adapter updates

### Trade-offs

**Why not keep Responses-only?**
Claude Desktop natively speaks Messages API and cannot be configured to use Responses. Supporting Messages is the only way to give Claude Desktop users the benefits of API Pool (failover, cooldown, multi-upstream selection).

**Why bidirectional adaptation instead of native-only?**
Native-only (Messages → Messages, Responses → Responses) would fragment the upstream pool. A user with 5 OpenAI upstreams and 1 Anthropic upstream would see Codex use all 6, but Claude Desktop use only 1, eliminating the failover benefit. Adaptation maximizes the working pool for both clients.

**Why default adapters to disabled?**
Matches the existing Responses adapter philosophy (ADR-0002). Silent feature stripping is surprising and hard to debug. Requiring opt-in makes the trade-off visible and controllable.

**Why share Pool Token instead of separate tokens?**
Both clients connect to the same local service for the same purpose (reach multiple upstreams). Separate tokens would add configuration complexity without security benefit in a localhost-only deployment. Management API can use a separate Admin Token if needed.

**Why not separate `/messages/*` and `/responses/*` services?**
Would duplicate Selection logic, Runtime State, Health Probes, Billing, Dashboard, and configuration. The core value—intelligent upstream selection and failover—is identical for both entry protocols.

## Related

- ADR-0001: Streaming Boundary applies to both entry protocols
- ADR-0002: Adapter Compatibility Mode pattern extended to Messages entry
- ADR-0003: Non-authoritative Probes pattern applies to Messages protocol detection
