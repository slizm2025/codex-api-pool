import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CHATGPT_CODEX_BASE_URL } from './constants.mjs';
import { extractCodexOAuthAccountItems, looksLikeChatGptWebSession, normalizeCodexOAuthAccount } from './account-import.mjs';

export function defaultSecretsPath(configPath, config = {}) {
  const configured = typeof config.secrets?.path === 'string' ? config.secrets.path.trim() : '';
  const baseDir = path.dirname(configPath || path.resolve('config.local.json'));
  return configured ? path.resolve(baseDir, configured) : path.resolve(baseDir, 'secrets.local.json');
}

export function loadSecretsSync(secretsPath) {
  if (!secretsPath || !existsSync(secretsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(secretsPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveSecrets(secrets, secretsPath) {
  if (!secretsPath) return;
  await writeFile(secretsPath, `${JSON.stringify(secrets || {}, null, 2)}\n`);
}

export function ensureCodexOAuthConfig(config) {
  if (!config.codex_oauth || typeof config.codex_oauth !== 'object' || Array.isArray(config.codex_oauth)) {
    config.codex_oauth = {};
  }
  if (!Array.isArray(config.codex_oauth.accounts)) config.codex_oauth.accounts = [];
  return config.codex_oauth;
}

export function credentialSecret(secrets, credentialRef) {
  const value = secrets?.[credentialRef];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function projectCodexOAuthAccount(account, secrets = {}) {
  const credentialRef = String(account.credential_ref || `codex_oauth.${account.name}`).trim();
  const secret = credentialSecret(secrets, credentialRef);
  return {
    name: account.name,
    base_url: String(account.base_url || CHATGPT_CODEX_BASE_URL).trim().replace(/\/$/, ''),
    site_url: 'https://chatgpt.com',
    signin_available: account.signin_available,
    signin_completed_date: account.signin_completed_date,
    proxy_url: account.proxy_url || undefined,
    codex_oauth: true,
    request_mode: 'codex_oauth',
    credential_ref: credentialRef,
    oauth_expires_at: account.oauth_expires_at || undefined,
    oauth_client_id: account.oauth_client_id || undefined,
    oauth_email: account.oauth_email || undefined,
    oauth_plan_type: account.oauth_plan_type || undefined,
    chatgpt_account_id: account.chatgpt_account_id || undefined,
    chatgpt_user_id: account.chatgpt_user_id || undefined,
    organization_id: account.organization_id || undefined,
    health_path: '',
    probe_auth: 'none',
    api: 'openai',
    weight: Number(account.weight || 1),
    keys: [{ label: credentialRef, value: secret.access_token || '' }],
    enabled: account.enabled !== false,
    _codex_oauth_account: true
  };
}

export function materializeRuntimeConfig(config, secrets = {}) {
  const upstreams = Array.isArray(config.upstreams) ? [...config.upstreams] : [];
  const names = new Set(upstreams.map((upstream) => upstream?.name).filter(Boolean));
  const accounts = Array.isArray(config.codex_oauth?.accounts) ? config.codex_oauth.accounts : [];
  for (const account of accounts) {
    if (!account?.name || names.has(account.name)) continue;
    upstreams.push(projectCodexOAuthAccount(account, secrets));
    names.add(account.name);
  }
  return { ...config, upstreams };
}

function isLegacyCodexOAuthUpstream(upstream) {
  return upstream?.codex_oauth === true || String(upstream?.request_mode || '').trim().toLowerCase() === 'codex_oauth';
}

export function importCodexOAuthAccountsIntoConfig(payload, config, secrets, options = {}) {
  if (looksLikeChatGptWebSession(payload)) {
    const error = new Error('ChatGPT Web session JSON is not a Codex OAuth account export. Use sub2api/Codex OAuth export with accounts[].credentials access/refresh tokens.');
    error.statusCode = 400;
    throw error;
  }
  const replace = options.replace === true || String(options.replace || '').trim().toLowerCase() === 'true';
  const items = extractCodexOAuthAccountItems(payload);
  if (!items.length) {
    const error = new Error('no Codex OAuth accounts found in import payload');
    error.statusCode = 400;
    throw error;
  }

  const oauthConfig = ensureCodexOAuthConfig(config);
  if (!Array.isArray(config.upstreams)) config.upstreams = [];
  const results = [];
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  let failed = 0;
  let secretCount = 0;

  items.forEach((item, index) => {
    try {
      const existingIndex = oauthConfig.accounts.findIndex((account) => account.name === item.name);
      const existingByName = existingIndex >= 0 ? oauthConfig.accounts[existingIndex] : null;
      const legacy = config.upstreams.find((upstream) => upstream.name === item.name && isLegacyCodexOAuthUpstream(upstream));
      const normalized = normalizeCodexOAuthAccount(item, index, {
        existingAccount: existingByName,
        existingLegacyUpstream: legacy
      });
      const currentIndex = oauthConfig.accounts.findIndex((account) => account.name === normalized.account.name);
      const currentAccount = currentIndex >= 0 ? oauthConfig.accounts[currentIndex] : null;
      const legacyByNormalizedName = config.upstreams.find((upstream) => upstream.name === normalized.account.name && isLegacyCodexOAuthUpstream(upstream));
      if (!normalized.account.proxy_url && (currentAccount?.proxy_url || legacyByNormalizedName?.proxy_url)) {
        normalized.account.proxy_url = currentAccount?.proxy_url || legacyByNormalizedName?.proxy_url;
      }
      if (currentIndex >= 0 && !replace) {
        skipped += 1;
        results.push({ name: normalized.account.name, action: 'skipped', reason: 'codex oauth account already exists' });
        return;
      }

      if (currentIndex >= 0) {
        oauthConfig.accounts.splice(currentIndex, 1, normalized.account);
        replaced += 1;
        results.push({ name: normalized.account.name, action: 'replaced', credential_ref: normalized.account.credential_ref });
      } else {
        oauthConfig.accounts.push(normalized.account);
        added += 1;
        results.push({ name: normalized.account.name, action: 'added', credential_ref: normalized.account.credential_ref });
      }

      if (Object.keys(normalized.secrets).length > 0) {
        secrets[normalized.account.credential_ref] = {
          ...(secrets[normalized.account.credential_ref] && typeof secrets[normalized.account.credential_ref] === 'object'
            ? secrets[normalized.account.credential_ref]
            : {}),
          ...normalized.secrets
        };
        secretCount += Object.keys(normalized.secrets).length;
      }

      config.upstreams = config.upstreams.filter((upstream) => !(upstream.name === normalized.account.name && isLegacyCodexOAuthUpstream(upstream)));
    } catch (error) {
      failed += 1;
      results.push({ index, name: item?.name || item?.id || null, action: 'failed', error: error.message });
    }
  });

  return {
    added,
    replaced,
    skipped,
    failed,
    total: items.length,
    results,
    secretCount,
    plaintextKeyCount: 0
  };
}
