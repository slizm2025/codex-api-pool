function parseArgs(argv) {
  const flags = {
    replace: false,
    poolUrl: process.env.CODEX_POOL_URL || 'http://127.0.0.1:8787',
    tokenEnv: process.env.CODEX_POOL_ADMIN_TOKEN_ENV || 'CODEX_POOL_API_KEY',
    siteUrl: '',
    hasSiteUrl: false,
    api: ''
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--replace') {
      flags.replace = true;
      continue;
    }
    if (arg === '--site-url') {
      flags.siteUrl = argv[++index] || '';
      flags.hasSiteUrl = true;
      continue;
    }
    if (arg === '--pool-url') {
      flags.poolUrl = argv[++index] || flags.poolUrl;
      continue;
    }
    if (arg === '--token-env') {
      flags.tokenEnv = argv[++index] || flags.tokenEnv;
      continue;
    }
    if (arg === '--api') {
      flags.api = argv[++index] || '';
      continue;
    }
    positional.push(arg);
  }

  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const [name, baseUrl, weightArg, keyEnvArg] = positional;
const defaultKeyEnv = name ? `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY` : '';
const keyEnv = keyEnvArg || (!flags.replace ? defaultKeyEnv : '');

if (!name || !baseUrl) {
  console.error('usage: node scripts/add-upstream.mjs <name> <base_url> [weight] [key_env] [--site-url URL] [--api openai|anthropic|both] [--replace] [--pool-url URL] [--token-env ENV]');
  console.error('example: node scripts/add-upstream.mjs mysite https://example.com/v1 2 MY_SITE_API_KEY --site-url https://example.com --api openai --replace');
  process.exit(2);
}

const payload = {
  name,
  base_url: baseUrl,
  replace: flags.replace
};
if (flags.hasSiteUrl) payload.site_url = flags.siteUrl;
if (flags.api) payload.api = flags.api;
if (weightArg !== undefined || !flags.replace) payload.weight = Number(weightArg || 1);
if (keyEnv) payload.keys = [{ env: keyEnv }];

const token = flags.tokenEnv ? process.env[flags.tokenEnv] || '' : '';
const headers = { 'content-type': 'application/json' };
if (token) headers.authorization = `Bearer ${token}`;

const poolUrl = flags.poolUrl.replace(/\/$/, '');
const response = await fetch(`${poolUrl}/pool/upstreams`, {
  method: 'POST',
  headers,
  body: JSON.stringify(payload)
});

const text = await response.text();
console.log(text.trim());
if (!response.ok) process.exit(1);
