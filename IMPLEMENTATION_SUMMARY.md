# Implementation Summary: Issues #22 and #23

## Completed Work

### Issue #22: Per-Protocol Representative Model Selection

**Problem**: When `model_override` was a GPT model and an upstream supported both GPT and Claude models, the probe would send the GPT model to `/v1/messages` (Anthropic endpoint), causing it to fail even though the upstream actually supported Claude models.

**Solution**: Select representative model **per protocol family** instead of using a single `probeModel` for all protocols:
- For `anthropic_messages`: Use `model_override` if it's Claude, otherwise first Claude from discovered models
- For `responses`/`chat_completions`: Use `model_override` if non-Claude, otherwise first non-Claude from discovered models
- Skip protocols gracefully when no representative model exists (no longer marks as failed)

**Key Changes**:
- Moved `/models` list fetch before protocol probes (`fetchSupplementalModels` runs early)
- Added per-protocol model selection: `anthropicProbeModel` and `openaiProbeModel`
- Preserved backward compatibility: single-family upstreams work exactly as before
- `health.probeModel` still stores configured `model_override` for staleness detection

**Test Coverage**:
- Dual-family upstream verifies both OpenAI and Anthropic protocols in one probe
- Claude-only upstream with Claude override skips OpenAI protocols without marking failed
- OpenAI-only upstream maintains backward compatible probe behavior

### Issue #23: Unify Protocol Capability Status Vocabulary

**Problem**: Protocol capability status terms were inconsistent. `protocolCapabilityStatusFromProbeState` returned `'failed'` but guards tested for `'unsupported'`, breaking the 30-minute recheck throttle. Hard failures (404) and transient failures (5xx) were treated the same.

**Solution**: Unified vocabulary with distinct handling:
- `verified` — proven by probe or real traffic
- `assumed` — from API Type Declaration / user declaration
- `unsupported` — hard negative evidence (404/405/501) → long recheck, throttled
- `unknown` — no evidence or transient failure (5xx/timeout/network) → short recheck, retried

**Key Changes**:
- Updated `protocolCapabilityStatusFromProbeState` to accept `statusCode` parameter
- Hard failures (404/405/501) → `unsupported` (not re-probed within interval)
- Transient failures (5xx/timeout/network) → `unknown` (retried on next probe)
- Removed `'failed'` status entirely
- Updated existing test to expect `'unsupported'` instead of `'failed'`

**Test Coverage**:
- Hard endpoint-unsupported (404) throttles recheck - second probe skips protocol
- Transient failure (500) maps to unknown and retries on next probe

## Code Quality Assessment

### What Works Well

1. **Minimal, targeted changes**: Both issues required surgical edits to specific functions without massive refactoring
2. **Backward compatibility preserved**: All existing tests pass, single-family upstreams work exactly as before
3. **Clear separation of concerns**: Model selection logic is separate from probe execution
4. **Test-driven**: RED-GREEN-REFACTOR cycle caught edge cases early

### Architecture Observations

The implementation is **合理** (reasonable) with these strengths:

1. **Per-protocol model selection is the right abstraction** - It matches the real-world constraint that Claude models only work with `/messages` and GPT models only work with `/responses`
2. **Early model list fetch is correct** - Fetching models before probing enables informed per-protocol decisions
3. **Status vocabulary unification fixes real bug** - The broken throttling was causing unnecessary probe traffic
4. **Graceful degradation** - When no representative model exists for a protocol, it skips rather than fails

### Potential Future Optimizations (Not Urgent)

1. **Model family detection could be cached** - `isClaudeModel()` is called multiple times per probe, though it's likely fast enough
2. **Model list fetch could be cached** - Currently fetches on every probe, could cache for a few seconds
3. **Protocol probe parallelization** - Currently probes sequentially; could probe all protocols in parallel for dual-family upstreams (but this would complicate the "stop on first success" logic)
4. **Recheck interval configuration** - Hard-coded 30-minute interval for unsupported protocols could be configurable

## Recommendations

### Immediate: None
Both implementations are production-ready. All tests pass, backward compatibility is preserved, and the code is clean.

### Future Considerations

1. **Monitor probe latency** - If the sequential probe pattern becomes a bottleneck, consider parallel probing
2. **Add metrics** - Track how often dual-family probes discover both families vs just one
3. **Document recheck intervals** - The 30-minute throttle for `unsupported` protocols should be documented in CONTEXT.md

## Test Coverage Summary

Both issues have comprehensive smoke test coverage:
- Issue #22: 3 tests (dual-family, claude-only, single-family backward compat)
- Issue #23: 2 tests (hard-unsupported throttling, transient-failure retry)
- All existing tests updated and passing
- Total: ~6700+ lines of smoke tests covering end-to-end behavior

## Conclusion

The implementation is **production-ready** and **合理**. The architecture decisions are sound, the code is clean, and the test coverage is strong. No immediate optimizations are needed, though the future optimizations listed above could be considered if probe latency becomes an issue at scale.
