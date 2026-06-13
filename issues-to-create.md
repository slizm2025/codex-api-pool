# Issues to Create for Claude Desktop Messages API Support

Based on ADR-0004. Create these issues in dependency order.

---

## Issue 1: Messages 入口基础设施

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Add a new `/v1/messages` route handler that accepts Anthropic Messages API requests. This is the foundation for Claude Desktop support, establishing the entry point and authentication flow.

The endpoint should:
- Parse incoming POST requests to `/v1/messages`
- Validate the request has valid JSON body with required Messages API fields (`model`, `messages`, `max_tokens`)
- Authenticate using the existing Pool Token mechanism (`server.auth_token_env`)
- Return Anthropic-formatted errors (not OpenAI format) for authentication failures, invalid JSON, or missing required fields

Error format for Messages entry:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "..."
  }
}
```

At this stage, the handler only needs to validate and authenticate — actual forwarding comes in the next slice.

### Acceptance criteria

- [ ] `/v1/messages` route accepts POST requests
- [ ] Pool Token authentication works (401 if missing/invalid)
- [ ] Request body validation rejects malformed JSON or missing required fields
- [ ] Error responses use Anthropic Messages error format
- [ ] Existing `/v1/responses` endpoint continues to return OpenAI-formatted errors
- [ ] Smoke test verifies authentication and error format

### Blocked by

None - can start immediately

---

## Issue 2: 原生 Messages 转发

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Implement native Messages → Messages forwarding to Anthropic upstreams. This completes Phase 1, enabling Claude Desktop to use Anthropic-capable upstreams through the API Pool.

The forwarding path should:
- Select eligible Anthropic upstreams (those with `api: "anthropic"` or `api: "both"`)
- Forward the Messages request to the selected upstream without protocol conversion
- Stream the Messages API response back to Claude Desktop (both JSON and SSE formats)
- Capture usage, quota, and health state from the upstream response
- Apply Model Override if configured
- Handle retries and fallback within the Streaming Boundary (same as existing Responses logic)

### Acceptance criteria

- [ ] Selection filters for Anthropic-capable upstreams when entry is `/v1/messages`
- [ ] Messages requests forward to upstream `/v1/messages` endpoint
- [ ] Streaming responses (SSE) work end-to-end
- [ ] Non-streaming (JSON) responses work end-to-end
- [ ] Usage and quota captured from Anthropic response headers/body
- [ ] Model Override applies to Messages requests
- [ ] Retry and fallback work before Streaming Boundary
- [ ] Recent Request Timeline shows Messages entry protocol

### Blocked by

- Issue #1: Messages 入口基础设施

---

## Issue 3: Messages-only Features 检测器

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Implement complete detection of Messages-only Features that cannot be losslessly converted to Chat Completions or Responses. When detected and compatibility mode is disabled, return 422 with diagnostic information.

Detect these features:
- **System level**: `cache_control` in system blocks
- **Message level**: `cache_control` on messages or tools
- **Content blocks**: `thinking` type blocks
- **Tools**: Computer Use tools (`computer_20241022`, `text_editor_20241022`, `bash_20241022`)
- **Output config**: Anthropic-specific fields without Chat/Responses equivalents

Return 422 error format:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Request contains Messages-only features that cannot be converted to available upstreams. Enable adapter compatibility mode to strip these features: cache_control, thinking"
  }
}
```

### Acceptance criteria

- [ ] Detects all system-level cache_control
- [ ] Detects all message-level cache_control
- [ ] Detects thinking content blocks
- [ ] Detects Computer Use tools
- [ ] Returns 422 when Messages-only features detected and no native Anthropic upstream available
- [ ] 422 error lists which features were detected
- [ ] Detection respects `compatibility.adapter_mode.strip_messages_only_features` config
- [ ] Smoke test covers each feature type

### Blocked by

- Issue #1: Messages 入口基础设施

---

## Issue 4: Messages → Chat Completions 请求转换

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Implement the request adapter that converts Anthropic Messages format to OpenAI Chat Completions format. This enables Messages entry to use OpenAI-compatible upstreams.

Convert these fields:
- `messages` array → Chat messages (role, content, tool_calls, tool_call_id)
- `system` → Chat system message or top-level `system` parameter
- `tools` → Chat tools array
- `tool_choice` → Chat tool_choice
- `max_tokens` → `max_completion_tokens` or `max_tokens`
- `temperature`, `top_p`, `stop` → direct mapping
- `output_config.format` → `response_format`
- `metadata.user_id` → `user`

Strip Messages-only features according to compatibility mode configuration. Report stripped features in internal diagnostics (not yet in response headers — that comes in slice 6).

### Acceptance criteria

- [ ] Messages array converts to Chat messages format
- [ ] System prompts map correctly
- [ ] Tool definitions convert (both client and Anthropic-specific)
- [ ] Tool choice converts (auto/any/required/none/specific)
- [ ] Output format (json_schema) maps to response_format
- [ ] Messages-only features stripped when compatibility enabled
- [ ] Conversion preserves multi-turn conversation state
- [ ] Unit tests cover all field mappings

### Blocked by

- Issue #3: Messages-only Features 检测器

---

## Issue 5: Chat Completions → Messages 响应转换

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Implement the response adapter that converts OpenAI Chat Completions responses back to Anthropic Messages format. This completes the Messages → Chat round-trip.

Convert both formats:
- **JSON responses**: `choices[0].message` → Messages content blocks
- **SSE streams**: Chat delta events → Messages SSE events

Map these elements:
- Chat content → Messages text/image/tool_use blocks
- Chat tool_calls → Messages tool_use blocks
- Chat finish_reason → Messages stop_reason
- Chat usage → Messages usage
- Chat function_call (legacy) → Messages tool_use

Preserve:
- Request ID mapping
- Model name
- Stop sequences
- Usage tokens

### Acceptance criteria

- [ ] Chat JSON responses convert to Messages format
- [ ] Chat SSE streams convert to Messages SSE events
- [ ] Tool calls map to tool_use blocks with correct IDs
- [ ] Finish reasons map correctly (stop, length, tool_calls, content_filter)
- [ ] Usage tokens preserved (input_tokens, output_tokens)
- [ ] Streaming maintains event order and boundaries
- [ ] Error responses during streaming handled gracefully
- [ ] Unit tests cover JSON and SSE formats

### Blocked by

- Issue #4: Messages → Chat Completions 请求转换

---

## Issue 6: Messages → Chat 端到端集成

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Integrate Messages ↔ Chat conversion into Selection, Forwarding Strategy, and diagnostics. This completes Phase 2, enabling Messages entry to use OpenAI-compatible upstreams with full observability.

Add to Selection logic:
- Prioritize native Anthropic upstreams for Messages entry
- Allow OpenAI upstreams when `compatibility.adapter_mode.adapters.messages_to_chat_completions` is enabled
- Track learned Forwarding Strategy per (upstream, model, entry_protocol)

Add diagnostics:
- `x-codex-api-pool-adapter` header (e.g., "messages_to_chat_completions")
- `x-codex-api-pool-converted` header (list of converted fields)
- `x-codex-api-pool-downgraded` header (fields with partial conversion)
- `x-codex-api-pool-stripped` header (Messages-only features removed)

Extend config schema:
```json
{
  "compatibility": {
    "adapter_mode": {
      "strip_messages_only_features": false,
      "adapters": {
        "messages_to_chat_completions": false
      }
    }
  }
}
```

### Acceptance criteria

- [ ] Selection prioritizes Anthropic upstreams for Messages entry
- [ ] Selection falls back to OpenAI upstreams when adapter enabled
- [ ] Forwarding Strategy learned per entry protocol
- [ ] Diagnostic headers present in adapted responses
- [ ] Config validation rejects invalid adapter names
- [ ] Native Responses Recheck pattern applies to Messages routes
- [ ] End-to-end smoke test: Messages → Chat → Messages
- [ ] Recent Request Timeline shows adapter used

### Blocked by

- Issue #2: 原生 Messages 转发
- Issue #5: Chat Completions → Messages 响应转换

---

## Issue 7: Messages → Responses 双向转换

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Implement Messages ↔ Responses bidirectional conversion to enable Messages entry to use Responses-capable upstreams. This completes Phase 3, maximizing upstream pool utilization.

Leverage existing Responses ↔ Anthropic Messages adapters:
- Reuse `responsesInputToAnthropicMessages` for Responses → Messages
- Reuse `anthropicMessageToResponsesJson` for Messages → Responses
- Create thin wrapper for Messages entry → Responses request
- Create thin wrapper for Responses response → Messages entry

Add config:
```json
{
  "compatibility": {
    "adapter_mode": {
      "adapters": {
        "messages_to_responses": false
      }
    }
  }
}
```

Selection priority for Messages entry:
1. Native Anthropic Messages
2. Chat Completions (if enabled)
3. Responses (if enabled)

### Acceptance criteria

- [ ] Messages → Responses request conversion works
- [ ] Responses → Messages response conversion works
- [ ] Both JSON and SSE formats supported
- [ ] Selection considers Responses upstreams when adapter enabled
- [ ] Diagnostic headers show messages_to_responses adapter
- [ ] Config schema includes messages_to_responses toggle
- [ ] End-to-end smoke test: Messages → Responses → Messages
- [ ] Forwarding Strategy tracks Messages → Responses routes

### Blocked by

- Issue #6: Messages → Chat 端到端集成

---

## Issue 8: Dashboard Messages 可观测性

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Enhance Management Dashboard to display Messages entry protocol information without creating separate views. Maintain the single-pane Operational Console design.

Add to Recent Request Timeline:
- "Entry Protocol" column showing "Responses" or "Messages"
- Adapter information in existing "Route" column (e.g., "Messages → Chat")

Add to Upstream cards:
- Display supported protocols based on `api` field
  - `api: "openai"` → show "OpenAI-compatible"
  - `api: "anthropic"` → show "Anthropic Messages"
  - `api: "both"` → show both

Enhance Forwarding Strategy display:
- Show entry protocol in strategy labels
- Example: "Messages → Chat adapter (learned)" vs "Responses → Chat adapter (learned)"

Update Top Diagnostic Bar:
- Consider both entry protocols when computing pool availability
- Show "Messages entry blocked" if only Responses upstreams available and adapters disabled

### Acceptance criteria

- [ ] Recent Request Timeline shows entry protocol column
- [ ] Timeline adapter column distinguishes Messages vs Responses routes
- [ ] Upstream cards display protocol support badges
- [ ] Forwarding Strategy shows entry protocol context
- [ ] Top Diagnostic Bar considers both entry protocols
- [ ] No new tabs or separate views added
- [ ] Dashboard loads without errors for existing deployments
- [ ] Visual density remains compact (Operational Console style)

### Blocked by

- Issue #6: Messages → Chat 端到端集成

---

## Issue 9: 兼容模式配置 UI

**Labels**: `ready-for-agent`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Add Messages adapter configuration controls to the Management Dashboard settings panel. Mirror the existing Responses compatibility mode UI.

Add to configuration panel (same area as existing adapter toggles):
- Checkbox: "Strip Messages-only features when adapting"
  - Controls `compatibility.adapter_mode.strip_messages_only_features`
  - Disabled when no Messages adapters are enabled
- Checkbox: "Messages → Chat Completions adapter"
  - Controls `compatibility.adapter_mode.adapters.messages_to_chat_completions`
  - Disabled when strip_messages_only_features is false
- Checkbox: "Messages → Responses adapter"
  - Controls `compatibility.adapter_mode.adapters.messages_to_responses`
  - Disabled when strip_messages_only_features is false

Add help text explaining:
- Default (unchecked): Returns 422 when Messages-only features detected
- Checked: Strips incompatible features and adapts to available upstreams

Update Management API endpoint:
- `POST /pool/compatibility` accepts new fields
- Validates adapter names
- Persists to config.local.json

### Acceptance criteria

- [ ] Dashboard shows Messages adapter toggles in config panel
- [ ] Toggles enable/disable correctly based on parent setting
- [ ] Help text explains trade-offs clearly
- [ ] POST /pool/compatibility updates Messages adapter config
- [ ] Config changes persist to config.local.json
- [ ] Invalid adapter names rejected with clear error
- [ ] Existing Responses adapter UI unchanged
- [ ] Works with both admin token and no-auth modes

### Blocked by

- Issue #8: Dashboard Messages 可观测性

---

## Issue 10: 文档与迁移指南

**Labels**: `ready-for-human`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### What to build

Update project documentation to guide users through Claude Desktop integration. Create a complete reference for configuring, enabling, and troubleshooting the Messages entry point.

Update README.md:
- Add "Claude Desktop 配置" section after "Codex 配置"
- Show Claude Desktop custom model provider config example
- Explain how to point `base_url` at API Pool
- Document the two entry points: `/v1/responses` and `/v1/messages`

Add configuration examples:
- Minimal config (Messages → Messages only)
- Full config (all adapters enabled)
- Hybrid deployment (both Codex and Claude Desktop)

Add troubleshooting section:
- "422 Messages-only features" → how to enable compatibility mode
- "No Anthropic upstreams available" → how to add one or enable adapters
- "Authentication failed" → Pool Token setup
- "Responses vs Messages entry" → which client uses which

Update CHANGELOG.md:
- Document breaking changes (none expected)
- List new features
- Note default-disabled behavior

Create migration checklist for existing users:
- [ ] No action required if only using Codex Desktop
- [ ] To add Claude Desktop: configure custom model provider
- [ ] To enable adapters: update config.local.json compatibility section
- [ ] Test with Dashboard to verify both entry protocols

### Acceptance criteria

- [ ] README has clear Claude Desktop section with config example
- [ ] Configuration examples cover common scenarios
- [ ] Troubleshooting section addresses likely issues
- [ ] CHANGELOG documents all changes
- [ ] Migration checklist is actionable
- [ ] Documentation uses domain glossary terms (API Pool, Upstream, Pool Token, etc.)
- [ ] All links and references are accurate
- [ ] Human reviewer approves documentation quality

### Blocked by

- Issue #9: 兼容模式配置 UI

---

## Issue 11: Dashboard Claude 测试应使用 Claude 模型与正确协议

**Labels**: `ready-for-agent`, `bug`

### Parent

Related to ADR-0004: Claude Desktop Messages API support

### Problem

Management Dashboard 中 Upstream 行的“测试”按钮会默认使用全局 `model_override` 作为 Probe Model。当前全局模型可能是非 Claude 模型（例如 `gpt-5.5`），导致 Claude-only Upstream 被错误测试为不可用。

已复现的具体表现：
- `Mint_claude` 的 `/pool/upstreams/Mint_claude/claude-check` 能发现 Claude 模型：`claude-opus-4-6-cc`、`claude-opus-4-8-cc`、`claude-sonnet-4-6-cc`
- 但 `/pool/upstreams/Mint_claude/probe` 不指定 `probe_model` 时会回落到全局 `gpt-5.5`
- 上游返回 `model_not_found: No available channel for model gpt-5.5`
- 手动指定 `{"probe_model":"claude-opus-4-6-cc"}` 后测试通过

另一个误导点：`checkClaudeCapability()` 在只发现 Claude 模型时，如果 OpenAI-style `/models` 也返回 200，会给出 `suggested_api: "both"`，与 `claude_only: true` 的语义冲突，容易把 Claude-only Upstream 保存成 `api: "both"` 或保持 `api: "openai"`。

### What to build

Improve the Dashboard Claude testing workflow so that Claude-capable Upstreams are tested with an actual Claude model and an Anthropic-capable request path.

Expected behavior:
- When Claude detection succeeds and returns `claude_models`, set the row Probe Model input to the first Claude model if the current value is empty or is a non-Claude global override.
- For `claude_only: true`, prefer `suggested_api: "anthropic"` even if OpenAI-style `/models` also returns 200.
- Make the UI text distinguish “Claude detection” from “model probe”, so operators understand that the generic “测试” button tests the selected Probe Model, not automatically “Claude availability”.
- Preserve manual override: if the operator explicitly selects or types a model, do not silently replace it on refresh.

### Acceptance criteria

- [ ] Claude-only Upstream detection suggests `api=anthropic`
- [ ] After successful Claude detection, the row Probe Model defaults to a discovered Claude model when the current value is missing or non-Claude
- [ ] Clicking “测试” after Claude detection probes the selected Claude model and succeeds against a fake Anthropic-compatible test Upstream
- [ ] A non-Claude global `model_override` no longer causes Claude-only Upstreams to appear unavailable immediately after Claude detection
- [ ] Manual Probe Model edits are preserved across dashboard refresh/load
- [ ] Regression test covers `claude_only: true` with OpenAI-style `/models` returning 200 and only Claude model IDs

### Blocked by

None - can start immediately

---

# Summary

**Total slices**: 11 (10 AFK + 1 HITL)

**Dependency chain**:
```
Issue 1 (Messages entry) ─┬─→ Issue 2 (Native forwarding) ───────┐
                          └─→ Issue 3 (Feature detection) ─→ ... ─┤
                                                                   ├─→ Issue 6 (Integration) ─→ ...
                                                                   │   ├─→ Issue 7 (Responses adapter)
                                                                   │   └─→ Issue 8 (Dashboard)
                                                                   │           └─→ Issue 9 (Config UI)
                                                                   │                   └─→ Issue 10 (Docs)
```

**Recommended order**: Create issues 1-10 in numerical order, as each references its blockers. Issue 11 is independent and can start immediately.
