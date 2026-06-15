import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_ALIASES = {
  gpt: 'gpt-5.5',
  claude: 'claude-opus-4-8',
  off: ''
};

export function resolveModelArg(value) {
  const raw = String(value || '').trim();
  const alias = raw.toLowerCase();
  if (Object.hasOwn(MODEL_ALIASES, alias)) return MODEL_ALIASES[alias];
  return raw;
}

export function parseArgs(argv) {
  const flags = {
    poolUrl: process.env.CODEX_POOL_URL || 'http://127.0.0.1:8787',
    tokenEnv: process.env.CODEX_POOL_ADMIN_TOKEN_ENV || 'CODEX_POOL_API_KEY'
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pool-url') {
      flags.poolUrl = argv[++index] || flags.poolUrl;
      continue;
    }
    if (arg === '--token-env') {
      flags.tokenEnv = argv[++index] || flags.tokenEnv;
      continue;
    }
    positional.push(arg);
  }

  return { flags, positional };
}

function upstreamSupportsModel(upstream, model) {
  if (!model) return true;
  const isClaude = /^claude(?:-|$)/i.test(String(model || '').trim());
  const isAnthropic = upstream?.api === 'anthropic' || upstream?.api === 'both' || String(upstream?.probe_auth || '').trim().toLowerCase() === 'anthropic';
  const isOpenAi = upstream?.api === 'openai' || upstream?.api === 'both' || !upstream?.api;
  if (isClaude && !isAnthropic) return false;
  if (!isClaude && !isOpenAi) return false;
  return true;
}

export function summarizeStatus(status, model) {
  const upstreams = Array.isArray(status?.upstreams) ? status.upstreams : [];
  const available = upstreams.filter((upstream) => upstream.available);
  const matching = available.filter((upstream) => upstreamSupportsModel(upstream, model));
  return {
    override: status?.model?.override || '',
    availableCount: available.length,
    matchingCount: matching.length
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

function usage() {
  console.error('usage: node scripts/set-model.mjs <gpt|claude|off|model> [--pool-url URL] [--token-env ENV]');
  console.error('example: npm run model -- claude');
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const [modelArg] = positional;
  if (modelArg === undefined) {
    usage();
    return 2;
  }

  const model = resolveModelArg(modelArg);
  if (model.length > 200) {
    console.error('model must be 200 chars or fewer');
    return 2;
  }

  const token = flags.tokenEnv ? process.env[flags.tokenEnv] || '' : '';
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const poolUrl = flags.poolUrl.replace(/\/$/, '');
  const update = await requestJson(`${poolUrl}/pool/model`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model })
  });

  if (!update.response.ok) {
    console.error(update.text.trim() || `model switch failed: HTTP ${update.response.status}`);
    if (update.response.status === 401 && !token) {
      console.error(`set ${flags.tokenEnv} or pass --token-env with an environment variable that contains the admin token`);
    }
    return 1;
  }

  const status = await requestJson(`${poolUrl}/pool/status`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!status.response.ok) {
    console.log(`model override: ${model || 'off'}`);
    console.error(status.text.trim() || `status check failed: HTTP ${status.response.status}`);
    return 1;
  }

  const summary = summarizeStatus(status.json, model);
  console.log(`model override: ${summary.override || 'off'}`);
  console.log(`available upstreams: ${summary.availableCount}`);
  console.log(`protocol-compatible upstreams: ${summary.matchingCount}`);
  if (model && summary.matchingCount === 0) {
    console.warn(`warning: no currently available upstream is protocol-compatible with ${model}`);
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const exitCode = await main();
  process.exit(exitCode);
}
