import { CHATGPT_CODEX_BASE_URL } from './constants.mjs';
import { codexOauthMetadataFromToken, firstString } from './jwt.mjs';

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input || {}, key);
}

function cleanName(value, fallback = 'codex-oauth') {
  const raw = String(value || '').trim();
  const cleaned = raw
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function credentialsOf(item) {
  return item?.credentials && typeof item.credentials === 'object' && !Array.isArray(item.credentials)
    ? item.credentials
    : {};
}

export function looksLikeChatGptWebSession(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const hasSessionShape = Boolean(input.user && input.expires);
  const hasWebToken = ['accessToken', 'access_token', 'idToken', 'id_token', 'refreshToken', 'refresh_token']
    .some((key) => hasOwn(input, key));
  return hasSessionShape && hasWebToken;
}

export function looksLikeChatGptAccountExport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const credentials = credentialsOf(input);
  const platform = String(input.platform || input.extra?.auth_provider || '').toLowerCase();
  const type = String(input.type || '').toLowerCase();
  const source = String(input.source || input.extra?.source || '').toLowerCase();
  const hasOauthToken = Boolean(credentials.access_token || credentials.refresh_token || input.access_token || input.accessToken);
  return hasOauthToken && (
    source === 'chatgpt_web_session'
    || (platform === 'openai' && type === 'oauth')
    || Boolean(credentials.chatgpt_account_id || credentials.chatgpt_user_id)
  );
}

export function containsChatGptAccountExport(input) {
  if (looksLikeChatGptWebSession(input) || looksLikeChatGptAccountExport(input)) return true;
  if (Array.isArray(input)) return input.some((item) => containsChatGptAccountExport(item));
  if (!input || typeof input !== 'object') return false;
  for (const value of Object.values(input)) {
    if (containsChatGptAccountExport(value)) return true;
  }
  return false;
}

export function extractCodexOAuthAccountItems(payload) {
  if (looksLikeChatGptWebSession(payload)) return [];
  if (looksLikeChatGptAccountExport(payload)) return [payload];
  if (Array.isArray(payload)) return payload.filter(looksLikeChatGptAccountExport);
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.accounts)) return payload.accounts.filter(looksLikeChatGptAccountExport);
  if (payload.accounts && typeof payload.accounts === 'object') {
    return Object.entries(payload.accounts)
      .map(([name, value]) => (value && typeof value === 'object' && !Array.isArray(value) ? { name, ...value } : { name, value }))
      .filter(looksLikeChatGptAccountExport);
  }
  if (payload.data && typeof payload.data === 'object') return extractCodexOAuthAccountItems(payload.data);
  if (payload.config && typeof payload.config === 'object') return extractCodexOAuthAccountItems(payload.config);
  return [];
}

export function shouldImportAsCodexOAuthAccounts(payload) {
  if (looksLikeChatGptWebSession(payload)) return true;
  if (!payload || typeof payload !== 'object') return false;
  if (Array.isArray(payload)) return payload.length > 0 && payload.every((item) => looksLikeChatGptAccountExport(item));
  if (Array.isArray(payload.proxies) && payload.proxies.length > 0) return false;
  return extractCodexOAuthAccountItems(payload).length > 0;
}

export function codexOAuthSecretsFromImportItem(item) {
  const credentials = credentialsOf(item);
  return Object.fromEntries(Object.entries({
    access_token: firstString(credentials.access_token, credentials.accessToken, item.access_token, item.accessToken),
    refresh_token: firstString(credentials.refresh_token, credentials.refreshToken, item.refresh_token, item.refreshToken),
    id_token: firstString(credentials.id_token, credentials.idToken, item.id_token, item.idToken)
  }).filter(([, value]) => value));
}

export function normalizeCodexOAuthAccount(item, index, options = {}) {
  if (!looksLikeChatGptAccountExport(item)) {
    const error = new Error('codex oauth import item must be an OpenAI OAuth account export');
    error.statusCode = 400;
    throw error;
  }
  const credentials = credentialsOf(item);
  const secrets = codexOAuthSecretsFromImportItem(item);
  const tokenMetadata = codexOauthMetadataFromToken(secrets.access_token);
  const email = firstString(credentials.email, item.email, tokenMetadata.oauth_email);
  const fallbackName = email || `codex-oauth-${index + 1}`;
  const name = cleanName(firstString(item.name, item.id, item.title, item.label, email), fallbackName);
  const credentialRef = firstString(item.credential_ref, item.credentialRef, credentials.credential_ref, credentials.credentialRef, `codex_oauth.${name}`);
  const proxyUrl = firstString(item.proxy_url, item.proxyUrl, credentials.proxy_url, credentials.proxyUrl, options.existingAccount?.proxy_url, options.existingLegacyUpstream?.proxy_url);

  return {
    account: {
      name,
      enabled: item.enabled === undefined ? options.existingAccount?.enabled !== false : item.enabled !== false,
      weight: Number(firstString(item.weight, item.priority, options.existingAccount?.weight) || 1),
      proxy_url: proxyUrl || undefined,
      credential_ref: credentialRef,
      base_url: firstString(item.base_url, item.baseUrl, credentials.base_url, credentials.baseUrl, options.existingAccount?.base_url, CHATGPT_CODEX_BASE_URL).replace(/\/$/, ''),
      oauth_expires_at: firstString(credentials.expires_at, credentials.expiresAt, item.expires_at, item.expiresAt, tokenMetadata.oauth_expires_at, options.existingAccount?.oauth_expires_at),
      oauth_client_id: firstString(credentials.client_id, credentials.clientId, item.client_id, item.clientId, tokenMetadata.oauth_client_id, options.existingAccount?.oauth_client_id),
      oauth_email: email || undefined,
      oauth_plan_type: firstString(credentials.plan_type, credentials.planType, item.plan_type, item.planType, tokenMetadata.oauth_plan_type, options.existingAccount?.oauth_plan_type),
      chatgpt_account_id: firstString(credentials.chatgpt_account_id, credentials.chatgptAccountId, item.chatgpt_account_id, item.chatgptAccountId, tokenMetadata.chatgpt_account_id, options.existingAccount?.chatgpt_account_id),
      chatgpt_user_id: firstString(credentials.chatgpt_user_id, credentials.chatgptUserId, item.chatgpt_user_id, item.chatgptUserId, tokenMetadata.chatgpt_user_id, options.existingAccount?.chatgpt_user_id),
      organization_id: firstString(credentials.organization_id, credentials.organizationId, item.organization_id, item.organizationId, tokenMetadata.organization_id, options.existingAccount?.organization_id)
    },
    secrets
  };
}
