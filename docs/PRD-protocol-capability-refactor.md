# PRD: Protocol Capability Detection System Refactor

## Problem Statement

The Protocol Capability detection system currently spans ~600 lines across initialization, health probing, and capability recording with scattered state management. Developers and AI assistants face several friction points:

1. **Scattered State Management**: Protocol Capability state is managed by 7+ separate functions that all directly mutate `upstream.capabilities`, with no clear module ownership. The invariants (e.g., "user declarations override probe failures unless endpoint is clearly unsupported") are duplicated across multiple locations.

2. **Untestable Decision Logic**: The 130-line probe decision tree is embedded inside the 325-line `probeOneUpstream` monolith. Testing "try responses → fallback to chat" logic requires full HTTP execution. There's no seam to inject fake probe results.

3. **Unclear State Machine Boundaries**: Health State and Protocol Capability are two parallel state machines updated together but with fuzzy boundaries. When debugging "why is this upstream not selected?", developers must reason about both, and it's unclear which state takes precedence.

4. **Recent Bug Evidence**: The `missing_model_override` confusion (discovered 2026-06-14) happened partly because Health State and Capability state are tangled—Dashboard fields like "HTTP 0", "Latency 0ms", "Responses: disabled" were all consequences of one missing config field affecting multiple state machines.

## Solution

Extract three focused modules with clear interfaces and test seams:

1. **ProtocolCapabilityManager**: Owns all Protocol Capability state transitions (verified/failed/unknown/assumed/disabled). Encapsulates priority rules: user-declared > real traffic > probe evidence.

2. **ProtocolProbeOrchestrator**: Owns multi-protocol probe strategy (which protocols to probe based on API Type Declaration, progressive fallback: responses → chat_completions). Delegates HTTP execution to ProbeExecutor interface.

3. **Explicit Health/Capability Relationship**: Document and centralize how probe results map to both Health State and Protocol Capability through a single `applyProbeResult()` function.

This refactor improves:
- **Testability**: Each module testable without HTTP mocks
- **Locality**: State machine rules concentrated in one place
- **AI Navigability**: Clear entry points for "how do capabilities work?"
- **Debugging**: Dashboard fields trace to owning modules

## User Stories

### Protocol Capability State Management

1. As a pool operator, I want Protocol Capability state transitions to follow documented priority rules, so that user declarations aren't overridden by transient probe failures.

2. As a pool operator, I want real traffic success to override probe failures for the same model, so that upstreams proven by actual Codex requests aren't incorrectly marked as unavailable.

3. As a pool operator, I want endpoint 404/405/501 errors to definitively mark a protocol as unsupported, so that user declarations don't keep trying clearly non-existent endpoints.

4. As a pool operator, I want failed protocol capabilities to be rechecked after 30 minutes, so that upstreams can recover when they add protocol support.

5. As a developer, I want to test priority rules (user-declared > real-traffic > probe) without running HTTP requests, so that unit tests run fast and reliably.

6. As a developer, I want to test recheck logic by passing a fixed timestamp, so that I don't need time manipulation in tests.

7. As a developer debugging capability state, I want one place to look for "why is this protocol marked as X?", so that I don't have to trace through 7 scattered functions.

8. As an AI assistant, I want a single entry point for Protocol Capability queries, so that I can answer "does this upstream support responses?" without reading multiple files.

### Protocol Probe Orchestration

9. As a pool operator, I want probes to respect API Type Declaration (openai/anthropic/both), so that the pool doesn't waste time probing anthropic_messages on OpenAI-only upstreams.

10. As a pool operator, I want responses probes to automatically fall back to chat_completions when they fail, so that I get comprehensive protocol coverage from one Health Probe.

11. As a pool operator, I want request_mode=chat_completions to skip responses probing, so that upstreams configured for chat-only don't see unnecessary probe traffic.

12. As a pool operator, I want probes to recheck previously failed protocols after 30 minutes, so that temporary outages don't permanently mark protocols as unsupported.

13. As a developer, I want to test "try responses → chat fallback" without real HTTP, so that I can verify fallback logic in milliseconds.

14. As a developer, I want to test different API Type Declarations in isolation, so that I can verify each strategy (openai/anthropic/both) independently.

15. As a developer, I want to inject fake probe results, so that I can test how the orchestrator handles different response patterns (200 success, 401 auth error, 404 not found, timeout).

16. As an AI assistant, I want the probe strategy separated from probe execution, so that I can reason about "what gets probed" without understanding HTTP mechanics.

### Health vs Capability State Relationship

17. As a pool operator, I want to understand why an upstream is not selected, so that I can see if it's blocked by Health State (missing_model_override, auth_error) or Capability (no verified protocol).

18. As a developer, I want one probe result to deterministically update both Health State and Protocol Capability, so that the two state machines stay synchronized.

19. As a developer debugging dashboard field issues, I want each field (HTTP status, latency, protocol status) to trace to one owning module, so that I know where to look when values are incorrect.

20. As an AI assistant, I want documented rules for how probe classification maps to Health State and Capability Status, so that I can explain "why did this probe mark the upstream as auth_error?"

### Testing & Verification

21. As a developer, I want unit tests for Protocol Capability priority rules, so that I can verify user-declared > real-traffic > probe without full integration tests.

22. As a developer, I want unit tests for probe strategy planning, so that I can verify which protocols get probed under different configurations.

23. As a developer, I want unit tests for probe fallback logic, so that I can verify responses → chat progression independently.

24. As a developer, I want existing smoke tests to continue passing, so that I can verify the refactor doesn't break real-world behavior.

25. As a developer, I want to run capability tests in <100ms, so that test-driven development remains fast.

### Migration & Compatibility

26. As a developer, I want the refactor to happen incrementally, so that I can verify each step without breaking the running pool.

27. As a pool operator, I want existing config.local.json and stats.local.json to keep working, so that my pool doesn't lose state during the refactor.

28. As a developer, I want backward-compatible migration, so that old code paths keep working during the transition period.

29. As a developer, I want clear migration markers, so that I know which call sites have been migrated and which remain.

## Implementation Decisions

### Module Structure

**ProtocolCapabilityManager** (new file: `src/protocol-capability-manager.mjs`)
- Owns `upstream.capabilities` state
- Interface:
  - `initialize(config, restoredCapabilities)` — merge config + restored state
  - `recordProbe(protocol, probeResult, classified, options)` — update from probe
  - `recordRealTraffic(protocol, model, httpStatus, options)` — update from real traffic
  - `getStatus(protocol)` — query current status
  - `hasVerified(protocol)` — check if verified
  - `hasUserDeclared(protocol, status)` — check user declarations
  - `shouldRecheck(protocol, now)` — recheck decision
  - `toJSON()` — serialize for persistence
- Encapsulates priority rules:
  1. User declarations override probe failures (unless endpoint 404/405/501)
  2. Real traffic for same model overrides probe failures
  3. Probe evidence for different model overwrites real traffic
  4. Endpoint 404/405/501 overrides everything
- Migrated functions (from server.mjs):
  - `emptyProtocolCapability` (line 1560)
  - `normalizeProtocolCapabilities` (line 1573)
  - `normalizeDeclaredProtocolCapabilities` (line 1628)
  - `initialProtocolCapabilities` (line 1682)
  - `mergeRestoredProtocolCapabilities` (line 1614)
  - `recordProtocolCapabilityProbe` (line 7258)
  - `recordProtocolCapabilityRealTraffic` (line 7328)
  - `shouldRecheckProtocolCapability` (line 1876)
  - `upstreamHasVerifiedProtocolCapability` (line 1872)
  - `upstreamHasUserDeclaredProtocolCapability` (line 1892)

**ProbeExecutor Interface** (new file: `src/protocol-probe-executor.mjs`)
- Abstract interface for HTTP probe execution
- Implementations:
  - `HttpProbeExecutor` — delegates to existing probe functions
  - `FakeProbeExecutor` — test double that returns preset results
- Interface:
  - `async probeResponses(upstream, key, config, model)`
  - `async probeChatCompletions(upstream, key, config, model)`
  - `async probeAnthropicMessages(upstream, key, config, model)`
- Decision: Keep existing probe functions (`probeResponsesUpstream`, etc.) as implementation details called by `HttpProbeExecutor`, don't expose them directly

**ProtocolProbeOrchestrator** (new file: `src/protocol-probe-orchestrator.mjs`)
- Owns probe strategy and fallback logic
- Dependencies: `ProtocolCapabilityManager`, `ProbeExecutor`
- Interface:
  - `planProbes(upstream, models, now)` — returns probe plan object
  - `async executeProbes(upstream, key, config, plan, checkedAt)` — executes plan with fallback
- Probe planning rules:
  - `api=openai` or `api=both`: probe responses (with chat fallback) or chat_completions (based on request_mode)
  - `api=anthropic` or `api=both`: probe anthropic_messages
  - Skip protocols marked `unsupported` unless 30min recheck due
  - Select representative models: Claude models for anthropic_messages, non-Claude for OpenAI protocols
- Fallback logic:
  - If `requestMode !== 'chat_completions'`: try responses first, fallback to chat on failure
  - If `requestMode === 'chat_completions'`: only probe chat
  - Fallback only happens if responses probe fails (not ok)
- Extracts 130 lines (lines 8660-8791) from `probeOneUpstream`

**Probe Result Applicator** (new file: `src/probe-result-applicator.mjs`)
- Clarifies Health State vs Protocol Capability relationship
- Interface:
  - `applyProbeResult(upstream, key, protocol, probeResult, classified, options)` — updates both states
  - `deriveHealthFromProbe(classified, probeResult)` — maps probe classification to health state
- Decision: Single function that:
  1. Calls `capabilityManager.recordProbe()`
  2. Updates `upstream.health` based on classification
  3. Returns `{ shouldCooldown, cooldownReason }` for caller to apply
- Mapping rules documented:
  - `ok` → health=ok, capability=verified
  - `auth_error` → health=auth_error, capability=failed
  - `network_error` / `timeout` → health={same}, capability=unknown
  - `inconclusive` → health=inconclusive, capability=unknown
  - `models_unsupported` → health=models_unsupported, capability=failed

### Migration Strategy

**Phase 1: Bootstrap Period**
- Add `ensureCapabilityManager(upstream)` helper in server.mjs
- Helper creates `upstream._capabilityManager` lazily on first access
- Keep old functions in server.mjs but deprecate them

**Phase 2: Dual Write Period**
- New code calls manager methods
- Manager updates internal state AND syncs back to `upstream.capabilities` for backward compat
- Old code continues to work reading `upstream.capabilities`

**Phase 3: Call Site Migration**
- Migrate 7 primary call sites one by one:
  - Line 8714, 8730, 8675: `recordProtocolCapabilityProbe` calls
  - Line 13941: `recordProtocolCapabilityRealTraffic` call
  - Lines 8661, 8671, 8696: `shouldRecheckProtocolCapability` calls
- Verify smoke test passes after each migration
- Run new unit tests after each migration

**Phase 4: Cleanup**
- Remove old functions from server.mjs
- Remove backward-compat sync in manager
- Remove `ensureCapabilityManager` helper, use direct construction

### Data Structure Changes

**No breaking changes to persisted format**
- `stats.local.json` continues to store `upstream.capabilities` in same shape
- Manager's `toJSON()` produces identical structure to current format
- Restoration logic (`mergeRestoredProtocolCapabilities`) moved into `initialize()`

**Internal representation**
- Manager stores capabilities in `this._capabilities` private field
- Exposes `get capabilities()` getter for transition period
- After migration complete, remove getter and force access through methods

### Integration Points

**probeOneUpstream refactor**
- Before: 325 lines handling model selection, probe execution, capability recording, health update, cooldown
- After: ~100 lines:
  1. Pre-flight checks (enabled, key, model override)
  2. Fetch models list
  3. Create orchestrator with HttpProbeExecutor
  4. Call `orchestrator.planProbes()` and `orchestrator.executeProbes()`
  5. Derive health from probe results via `applyProbeResult()`
  6. Apply cooldown if needed
- Decision: Keep health state derivation in `probeOneUpstream` (not moved to orchestrator), only capability recording delegated

**Real traffic recording** (line 13937-13948)
- Currently calls three separate functions
- After refactor: calls `capabilityManager.recordRealTraffic()` and `updateHealthFromRealTraffic()` and `recordRepresentativeSuccessEvidence()`
- Decision: Keep three separate concerns (capability, health, representative evidence), don't merge

**Selection filtering** (lines 5031-5048)
- Currently calls `upstreamSupportsModel()` which checks capabilities
- After refactor: calls `capabilityManager.hasVerified(protocol)`
- Decision: Keep `upstreamSupportsModel()` as wrapper for backward compat during migration

## Testing Decisions

### What Makes a Good Test

**Test external behavior, not implementation details**
- Test state transitions through interface methods, not internal fields
- Test probe planning produces correct protocol list, not how it's computed
- Test fallback executes chat after responses failure, not the intermediate variables
- Don't test private methods or internal data structures

**Test at the highest seam possible**
- Prefer testing `ProtocolProbeOrchestrator.executeProbes()` over testing `planProbes()` + manual probe calls
- Prefer testing `ProtocolCapabilityManager.recordProbe()` over testing internal priority logic functions
- Use unit tests for module interfaces, integration tests for multi-module flows, e2e tests for full probe cycle

### Modules to Test

**ProtocolCapabilityManager** (`test/protocol-capability-manager.test.mjs`)
- Test initialization from different API Type Declarations (openai/anthropic/both)
- Test initialization with user declarations
- Test merging restored capabilities with config
- Test priority rules:
  - User declaration preserved on probe failure (non-endpoint-unsupported)
  - Endpoint 404/405/501 overrides user declaration
  - Real traffic overrides probe failure for same model
  - Probe overwrites real traffic for different model
- Test state transitions (probe classification → capability status)
- Test recheck logic (30min interval for failed/unsupported)
- Test edge cases (null upstream, missing protocol, invalid inputs)

**ProtocolProbeOrchestrator** (`test/protocol-probe-orchestrator.test.mjs`)
- Test probe planning:
  - `api=openai` plans responses + chat fallback
  - `api=anthropic` plans only anthropic_messages
  - `api=both` plans all three protocols
  - `request_mode=chat_completions` skips responses
  - Recheck triggers for failed capabilities after 30min
  - Unsupported capabilities not planned (unless recheck due)
- Test probe execution with FakeProbeExecutor:
  - Responses success → no chat fallback
  - Responses failure → chat fallback executed
  - Anthropic probe calls capability manager
  - All probes record results correctly
- Test combined scenarios:
  - `api=both`: anthropic success + responses failure + chat success
  - Recheck after 30min: previously failed protocol gets re-planned

**ProbeResultApplicator** (`test/probe-result-applicator.test.mjs`)
- Test dual state update:
  - `ok` probe → health=ok, capability=verified
  - `auth_error` probe → health=auth_error, capability=failed
  - `network_error` probe → health=network_error, capability=unknown
  - `timeout` probe → health=timeout, capability=unknown
  - `inconclusive` probe → health=inconclusive, capability=unknown
- Test cooldown decision:
  - Auth error, rate limit, server error, network error, timeout → shouldCooldown=true
  - Ok, inconclusive → shouldCooldown=false
- Test that both Health State and Capability get updated in one call

**Integration Tests** (`test/protocol-probe-integration.test.mjs`)
- Test probeOneUpstream with HttpProbeExecutor (real probe functions)
- Test full cycle: plan → execute → record → health update → cooldown
- Test that capability manager and health state stay synchronized

**Smoke Tests** (existing `test/smoke-test.mjs`)
- No changes needed
- Verify existing scenarios continue to work:
  - Pool token authentication
  - Upstream selection and fallback
  - Protocol capability discovery
  - Model override switching
  - Streaming error handling

### Prior Art

**Existing test patterns in codebase**
- `test/smoke-test.mjs`: End-to-end tests using real HTTP to localhost pool
- Test structure: arrange → act → assert with clear error messages
- Use of helper functions to reduce duplication
- Testing style: functional/imperative, not framework-driven

**New test patterns to introduce**
- Use `FakeProbeExecutor` for orchestrator tests (no HTTP)
- Use fixed timestamps for recheck tests (no time manipulation library)
- Use simple assertions (`if (!condition) throw new Error(...)`) matching smoke test style
- Keep tests fast (<100ms per test) by avoiding I/O

**Test file organization**
- One test file per module
- Group related tests with comments (e.g., `// Initialization tests`, `// Priority rules tests`)
- Test file names match module names (protocol-capability-manager.test.mjs)

## Out of Scope

**Not included in this refactor:**

1. **Health State extraction into its own manager**: Health State remains managed by direct `upstream.health` mutation in `probeOneUpstream`. Only the Capability state gets a manager. Rationale: Health State is simpler (no priority rules), and extracting it would expand scope significantly.

2. **Real traffic recording consolidation**: The three separate concerns (Protocol Capability, Health State, Representative Evidence) remain separate functions. They're called together but not merged. Rationale: Each has different data structures and lifecycles.

3. **Route strategy management**: `routeStrategyForUpstream()` and `learnRouteStrategy()` remain unchanged. They're related to capabilities but serve a different purpose (learning from successful traffic vs. probe evidence).

4. **Native Responses recheck logic refactor**: The complex logic in `canAttemptNativeResponses()` (lines 1904-1926) remains in server.mjs. Rationale: It depends on both capabilities and route strategies; moving it requires understanding the full routing subsystem.

5. **Dashboard field rendering optimization**: The HTML generation code (lines 10300+) remains unchanged. The refactor improves the backend data structure; dashboard changes are a separate effort.

6. **Changing persisted data format**: `stats.local.json` structure stays identical. The manager adapts to existing format rather than introducing a new schema.

7. **Performance optimization**: This is a structural refactor for testability and maintainability, not a performance improvement. Probe execution time remains the same.

8. **Probe execution logic changes**: The actual HTTP probing functions (`probeResponsesUpstream`, `probeChatCompletionsUpstream`, `probeAnthropicUpstream`) are not modified. They become implementation details behind ProbeExecutor interface but their logic doesn't change.

## Further Notes

### Why This Refactor Matters

This refactor directly addresses the debugging friction experienced during the 2026-06-14 incident:
- The `missing_model_override` confusion showed how tangled Health State and Capability state block understanding
- Dashboard fields (`HTTP 0`, `Latency 0ms`, `Responses: disabled`) all traced to scattered state updates
- No single place to understand "why is this upstream showing these values?"

After this refactor:
- `missing_model_override` (Health State) vs `disabled` (Capability) are clearly separate
- Each Dashboard field traces to one owning module
- Tests can verify each state machine independently

### Architectural Philosophy

This refactor follows these principles from the architecture review:

**Deletion Test**: If you deleted the scattered capability functions today, the priority logic (user-declared > real-traffic > probe) would reappear at 4+ call sites. That complexity is earning its keep—it just needs a home.

**Leverage**: Small interfaces (`recordProbe()`, `recordRealTraffic()`) hide complex priority rules. Callers say "record this evidence" without knowing the state machine internals.

**Locality**: All state transition rules in one module. One place to understand "why is this capability marked as X?"

**Seams for Testing**: `ProbeExecutor` interface lets tests inject fake results. `ProtocolCapabilityManager` lets tests verify state transitions without HTTP.

### Migration Risk Mitigation

**Incremental approach**: Each phase is independently verifiable
- Phase 1: Bootstrap (manager created but old code still works)
- Phase 2: Dual write (new code runs but old code still reads)
- Phase 3: Migration (call sites moved one by one, smoke test after each)
- Phase 4: Cleanup (old code removed only after all migrations verified)

**Rollback strategy**: If any phase fails smoke tests, rollback is straightforward:
- Phase 1-2: Simply don't proceed to next phase
- Phase 3: Revert specific call site migration that broke
- Phase 4: Keep old functions longer if needed

**Validation at each step**: Run both smoke test and new unit tests after each call site migration to catch regressions immediately.

### Timeline Estimate

Based on implementation decisions:
- **Phase 1 (ProtocolCapabilityManager)**: 11-14 hours
  - 3-4h: Create class structure
  - 2-3h: Create test suite
  - 4-5h: Migrate call sites
  - 2h: Validation
- **Phase 2 (ProtocolProbeOrchestrator)**: 13-17 hours
  - 1-2h: Define ProbeExecutor interface
  - 4-5h: Create orchestrator class
  - 3-4h: Create test suite
  - 5-6h: Refactor probeOneUpstream
- **Phase 3 (ProbeResultApplicator)**: 5-6 hours
  - 2-3h: Create applicator function
  - 2h: Integrate into orchestrator
  - 1h: Document relationship

**Total**: 29-37 hours (approximately 4-5 work days)

**Recommended approach**: Complete Phase 1 first, verify in production, then decide whether to proceed with Phase 2 and 3. Phase 1 alone delivers significant value (testable state management, clear ownership).

### Success Metrics

**Code quality**:
- Protocol Capability state management concentrated in <200 lines (currently scattered across 600+ lines)
- `probeOneUpstream` reduced from 325 lines to ~100 lines
- 7 scattered functions replaced by 3 focused modules

**Test coverage**:
- Unit tests for all priority rules (user-declared > real-traffic > probe)
- Unit tests for probe planning under all API Type Declarations
- Unit tests for fallback logic (responses → chat)
- All tests run in <100ms (no HTTP)

**Debugging improvement**:
- One entry point for "how do capabilities work?"
- Dashboard fields trace to owning modules
- Clear separation of Health State vs Protocol Capability concerns
