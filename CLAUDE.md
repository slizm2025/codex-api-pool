# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Codex API Pool is a local OpenAI-compatible API proxy that provides intelligent multi-upstream routing, failover, and protocol adaptation for Codex CLI and Claude Desktop. It sits between the client and multiple upstream API services, selecting the best available upstream based on health, availability, cooldown state, and model compatibility.

The pool supports three protocol families:
- **OpenAI Responses API** (native for Codex)
- **OpenAI Chat Completions API** (fallback adapter)
- **Anthropic Messages API** (for Claude models)

When a native protocol route is unavailable, the pool can translate requests between protocols with optional compatibility mode.

## Core Architecture

### Single-Process Multi-Layer Design

The entire system runs in one Node.js process (`src/server.mjs`, ~13.8k lines) that handles:

1. **Model API Layer** (`/v1/*`): OpenAI-compatible entry point for Codex/Claude Desktop
   - Request authentication via Pool Token
   - Upstream selection based on weight, availability, health, cooldown
   - Protocol detection and adaptation (Responses ↔ Chat Completions ↔ Messages)
   - Retry and fallback on eligible failures
   - Streaming response forwarding

2. **Management API Layer** (`/pool/*`): Control interface for operations
   - Status inspection, health probes, billing queries
   - Upstream CRUD operations, enable/disable toggles, quarantine management
   - Model override switching, compatibility mode configuration
   - JSON import (upstream providers, Codex OAuth accounts)

3. **Runtime State**: In-memory state persisted to `stats.local.json`
   - Usage tracking (token consumption per upstream)
   - Quota (rate limits from response headers)
   - Health state (ok, rate_limited, server_error, etc.)
   - Cooldown timers (after failures, auth errors, rate limits)
   - Availability scores (rolling window success rate)
   - Recent request timeline (for diagnostics)

### Selection Algorithm

Before each request, eligible upstreams are filtered by:
- Not disabled or quarantined
- Has valid upstream key
- Not in cooldown (upstream-level or key-level)
- Health state allows selection
- Supports requested model (GPT vs Claude)
- Supports required protocol capability

Remaining candidates are scored:
```
score = weight × availability_multiplier / (1 + in_flight + latency_penalty + health_penalty + failure_penalty)
```

Selection is probabilistic based on normalized scores.

### Retry and Fallback Boundary

The pool retries eligible failures (network errors, timeouts, specific HTTP status codes like 400/401/403/429/500/502/503) **only before the Streaming Boundary**—the point where an upstream returns HTTP 200 and begins sending response data.

Once streaming starts, the pool forwards the stream directly. If the stream breaks mid-response, the pool cannot resume generation losslessly, so the client request fails.

### Protocol Adaptation

When Codex sends a Responses request but no upstream has native Responses support:

- **Without Adapter Compatibility Mode**: Return 422 with diagnostic information
- **With Adapter Compatibility Mode enabled**: Convert to Chat Completions or Anthropic Messages
  - Documented field mappings (e.g., `input_image` → `image_url` or `image` block)
  - Downgrade fields where target has weaker support (logged in diagnostics)
  - Strip Responses-only features with no equivalent (must be visible in headers and timeline)

The adapter never silently drops user content—only features with no target API equivalent.

### Token Security Model

Three distinct token types:
- **Pool Token** (`server.auth_token_env`): Client → Pool authentication, never forwarded
- **Admin Token** (`server.admin_auth_token_env`): Management API authentication (optional)
- **Upstream Keys** (`upstreams[].keys[].env`): Pool → Upstream authentication

Keys should reference environment variables, not plaintext in config.

## File Structure

Core implementation:
- `src/server.mjs` — Main server (Model API + Management API + selection + retry + adapters + state)
- `src/codex-oauth/*.mjs` — Codex OAuth account import and token handling

Scripts:
- `scripts/add-upstream.mjs` — Add or replace upstream via Management API
- `scripts/set-model.mjs` — Set or clear model override via Management API
- `scripts/service.mjs` — Generate and manage macOS LaunchAgent plist

Configuration:
- `config.local.json` — Pool configuration (server, upstreams, retry, health, billing)
- `stats.local.json` — Runtime state (generated, persisted on changes)
- `secrets.local.json` — Codex OAuth secrets (generated if using OAuth accounts)

Documentation:
- `README.md` — Full user guide (Chinese)
- `CONTEXT.md` — Domain vocabulary and terminology
- `CHANGELOG.md` — Release history

Testing:
- `test/smoke-test.mjs` — End-to-end smoke test covering auth, fallback, availability, JSON import, model discovery, streaming errors, recent requests

## Development Commands

Start the pool:
```bash
npm start                           # Start with config.local.json
CODEX_POOL_CONFIG=path.json npm start  # Explicit config path
```

Run smoke tests:
```bash
npm run smoke
```

Add upstream:
```bash
npm run add -- <name> <base_url> <weight> <key_env> [options]
# Example: npm run add -- mysite https://api.example.com/v1 2 MYSITE_KEY
```

Switch model override:
```bash
npm run model -- gpt      # Set to gpt-5.5
npm run model -- claude   # Set to claude-opus-4-8
npm run model -- off      # Clear override
npm run model -- <model>  # Set to specific model
```

macOS service management:
```bash
npm run service:install   # Create and load LaunchAgent
npm run service:status    # Check service status
npm run service:restart   # Restart service
npm run service:stop      # Stop service
npm run service:uninstall # Remove LaunchAgent
```

Health check:
```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/pool/status
```

## Working with This Codebase

### Running Tests

There is no test framework setup. The smoke test (`npm run smoke`) is the primary verification tool. It covers:
- Pool token authentication
- Upstream selection and fallback
- Enable/disable toggles
- Usage and availability tracking
- JSON import (upstreams and Codex OAuth accounts)
- Model discovery from health probes
- Model override switching
- Streaming error handling and cooldown
- HTTP 400/522 fallback behavior
- Recent request timeline

When making changes to selection logic, retry behavior, or protocol adapters, run the smoke test to verify correctness.

### Code Organization in server.mjs

The 13.8k-line `server.mjs` is organized by function groups:
- Utility functions (masking, URL joining, proxy handling)
- HTTP/2 and proxy tunnel helpers
- Upstream request execution (HTTP/1.1, HTTP/2, streaming)
- Protocol adapters (Responses ↔ Chat ↔ Messages)
- Selection and retry logic
- Health probe and billing probe logic
- Management API handlers
- Model API handlers
- Server bootstrap

When reading or modifying, search for function names or grep for key patterns like `function selectUpstream`, `function forwardRequest`, `convertResponsesToChatCompletions`, etc.

### Adding Protocol Features

When adding new protocol features (e.g., new Responses fields or Anthropic Messages capabilities):

1. Check if it's protocol-specific (Responses-only, Messages-only, or cross-compatible)
2. If protocol-specific and no native route exists, document conversion behavior in adapter or flag as strippable
3. Update diagnostics to report stripped/downgraded fields in `x-codex-api-pool-stripped` header and recent request timeline
4. Add smoke test coverage if the feature affects selection or fallback

### Modifying Selection Logic

Selection happens in the main request handler after filtering ineligible upstreams. Key factors:
- `weight` (user-configured base score)
- `availability_multiplier` (derived from recent success rate, see `DEFAULT_AVAILABILITY_*` constants)
- `in_flight` (concurrent requests to same upstream)
- Latency penalty (from recent request durations)
- Health penalty (from health state)
- Failure penalty (from recent failure count)

When changing selection weights or thresholds, verify with smoke test and check that degraded upstreams still get deprioritized correctly.

### Configuration Persistence

`config.local.json` holds user-managed configuration. Changes via Management API (add upstream, set model override, etc.) write back to this file.

`stats.local.json` holds runtime state. It persists usage, quota, health, cooldown, availability, and recent requests. The pool loads this on startup to restore state across restarts.

Never commit `config.local.json`, `stats.local.json`, `secrets.local.json`, or `*.log` files—they contain secrets and operational data.

## Key Concepts (from CONTEXT.md)

- **Upstream**: An external API service the pool routes to
- **Selection**: Choosing which upstream to use for a request
- **Cooldown**: Temporary exclusion after failures
- **Availability**: Rolling window success rate (last 50 attempts, min 10 samples)
- **Health State**: Latest observed state (ok, missing_key, rate_limited, etc.)
- **Streaming Boundary**: Point after which retry/fallback is no longer possible
- **Native Responses Route**: Path that preserves full Responses semantics
- **Adapter Compatibility Mode**: Opt-in translation to Chat/Messages when no native route exists
- **Quarantined Upstream**: User-isolated upstream excluded from selection but kept for manual testing
- **Model Override**: Pool-level model substitution (e.g., force all requests to use claude-opus-4-8)

## Important Constraints

- The pool only retries **before** the streaming boundary. Once HTTP 200 and streaming starts, errors fail the client turn.
- Adapter Compatibility Mode must never silently drop user text or images—only Responses-specific features with no target equivalent.
- Pool Token and Upstream Keys are separate. Pool Token never reaches upstreams.
- Health probes use the current `model_override`. If no override is set, probes show `missing_model_override`.
- Native Responses Recheck: After falling back to Chat Completions, the pool eventually retries native Responses to detect if support was temporarily unavailable (configurable via `retry.native_responses_recheck_ms`, default 30 minutes).

## Common Patterns

### Adding a New Upstream via Management API
```bash
curl -X POST http://127.0.0.1:8787/pool/upstreams \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "mysite",
    "api": "openai",
    "base_url": "https://api.example.com/v1",
    "weight": 2,
    "keys": [{"env": "MYSITE_API_KEY"}]
  }'
```

### Triggering Health Probe
```bash
# Probe all active upstreams
curl -X POST http://127.0.0.1:8787/pool/probe \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"

# Probe specific upstream
curl -X POST http://127.0.0.1:8787/pool/upstreams/rawchat/probe \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"
```

### Checking Recent Requests
Visit `http://127.0.0.1:8787/pool/dashboard` or:
```bash
curl -s http://127.0.0.1:8787/pool/status | jq '.recent_requests'
```

### Enabling Adapter Compatibility Mode
```bash
curl -X POST http://127.0.0.1:8787/pool/compatibility \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "adapter_mode": {
      "strip_responses_only_features": true,
      "adapters": {
        "anthropic_messages": true,
        "chat_completions": true
      }
    }
  }'
```
