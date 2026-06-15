#!/usr/bin/env node

/**
 * Test script to diagnose why claude models don't show in available tiers
 *
 * Issue: When filtering "all models", claude upstreams that pass verification
 * should appear in available tiers, but they don't.
 *
 * Hypothesis: upstreamAvailable() is being called with a specific model
 * (state.modelOverride), but when user clicks "filter all", we might still
 * be passing the last active model instead of undefined/empty.
 */

// Mock the key functions from server.mjs
function healthAllowsSelection(upstream, expectedModel) {
  const state = upstream.health?.state || 'unknown';
  return ['ok', 'unknown', 'oauth_ready', 'stale_model_override', 'missing_model_override',
          'advanced_curl_required', 'codex_forward_only', 'inconclusive'].includes(state);
}

function modelRequiresProtocol(model) {
  const normalized = String(model || '').trim();
  if (!normalized) return null;
  if (normalized.startsWith('claude-')) return 'anthropic_messages';
  return 'openai';
}

function isAnthropicUpstream(upstream) {
  return upstream?.api === 'anthropic' || upstream?.api === 'both';
}

function isOpenAiUpstream(upstream) {
  return upstream?.api === 'openai' || upstream?.api === 'both' || !upstream?.api;
}

function upstreamSupportsModel(upstream, model) {
  if (!model) return true;

  const requiredProtocol = modelRequiresProtocol(model);
  if (requiredProtocol === 'anthropic_messages') {
    if (!isAnthropicUpstream(upstream)) return false;
  } else if (requiredProtocol === 'openai') {
    if (!isOpenAiUpstream(upstream)) return false;
  }

  const models = upstream.health?.models || [];
  return models.length === 0 || models.includes(model);
}

function upstreamAvailable(upstream, expectedModel) {
  return upstream.enabled
    && !upstream.quarantined
    && upstream.baseUrl
    && healthAllowsSelection(upstream, expectedModel)
    && !upstream.codexOAuthExpired
    && upstream.cooldownUntil === 0
    && upstream.keys.some(key => key.available);
}

function verificationTier(upstream) {
  if (upstream.available && upstream.representative_availability?.verified === true) return 'real_verified';
  if (upstream.available && upstream.health?.state === 'ok') return 'probe_only';
  if (upstream.available) return 'real_pending';
  return 'unavailable';
}

// Test scenarios
const testScenarios = [
  {
    name: 'Scenario 1: GPT-5.5 model override active',
    modelOverride: 'gpt-5.5',
    upstreams: [
      {
        name: 'claude-upstream',
        api: 'anthropic',
        enabled: true,
        quarantined: false,
        baseUrl: 'https://api.anthropic.com',
        codexOAuthExpired: false,
        cooldownUntil: 0,
        keys: [{ available: true }],
        health: { state: 'ok', models: ['claude-opus-4-8'] },
        representative_availability: { verified: true }
      },
      {
        name: 'gpt-upstream',
        api: 'openai',
        enabled: true,
        quarantined: false,
        baseUrl: 'https://api.openai.com/v1',
        codexOAuthExpired: false,
        cooldownUntil: 0,
        keys: [{ available: true }],
        health: { state: 'ok', models: ['gpt-5.5'] },
        representative_availability: { verified: true }
      }
    ]
  },
  {
    name: 'Scenario 2: No model override (filter all)',
    modelOverride: '',
    upstreams: [
      {
        name: 'claude-upstream',
        api: 'anthropic',
        enabled: true,
        quarantined: false,
        baseUrl: 'https://api.anthropic.com',
        codexOAuthExpired: false,
        cooldownUntil: 0,
        keys: [{ available: true }],
        health: { state: 'ok', models: ['claude-opus-4-8'] },
        representative_availability: { verified: true }
      },
      {
        name: 'gpt-upstream',
        api: 'openai',
        enabled: true,
        quarantined: false,
        baseUrl: 'https://api.openai.com/v1',
        codexOAuthExpired: false,
        cooldownUntil: 0,
        keys: [{ available: true }],
        health: { state: 'ok', models: ['gpt-5.5'] },
        representative_availability: { verified: true }
      }
    ]
  }
];

console.log('=== Verification Tier Diagnosis ===\n');

testScenarios.forEach(scenario => {
  console.log(`\n${scenario.name}`);
  console.log(`Model Override: ${scenario.modelOverride || '(none)'}`);
  console.log('---');

  scenario.upstreams.forEach(upstream => {
    // This is what createUpstreamStatusView does at line 11578
    const available = upstreamAvailable(upstream, scenario.modelOverride);
    upstream.available = available;

    const supportsModel = upstreamSupportsModel(upstream, scenario.modelOverride);
    const tier = verificationTier(upstream);

    console.log(`\n  ${upstream.name}:`);
    console.log(`    api: ${upstream.api}`);
    console.log(`    health.models: [${upstream.health.models.join(', ')}]`);
    console.log(`    upstreamSupportsModel(${scenario.modelOverride || 'empty'}): ${supportsModel}`);
    console.log(`    upstreamAvailable: ${available}`);
    console.log(`    => verification_tier: ${tier}`);

    if (!available && scenario.modelOverride && !supportsModel) {
      console.log(`    ⚠️  ISSUE: upstream is unavailable because it doesn't support model "${scenario.modelOverride}"`);
    }
  });
});

console.log('\n\n=== ROOT CAUSE ANALYSIS ===');
console.log(`
The issue is in createUpstreamStatusView() at line 11578:

  const available = upstreamAvailable(upstream, at, state.modelOverride);

When modelOverride is set to 'gpt-5.5', upstreamAvailable() is called with that model.
However, upstreamAvailable() itself doesn't filter by model - it just checks basic availability.

The model filtering happens later in:
1. chooseCandidate() during actual request routing (line 4875)
2. Dashboard display filtering (line 10496)

But the 'available' field in the status view is set WITHOUT considering model compatibility!

EXPECTED BEHAVIOR when "filter all models":
- Both GPT and Claude upstreams should show as available
- Model filtering should be UI-side only, not affecting the 'available' field

ACTUAL BEHAVIOR:
- The 'available' field is correctly set (no model filtering)
- BUT the verification tier logic depends on 'available' being true

The problem might be elsewhere - let's check if healthAllowsSelection is filtering by model...
`);
