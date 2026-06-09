export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

export function decodeBase64UrlJson(segment) {
  try {
    const normalized = String(segment || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  return decodeBase64UrlJson(parts[1]);
}

export function codexOauthMetadataFromToken(token) {
  const claims = decodeJwtPayload(token);
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return {};
  const auth = claims['https://api.openai.com/auth'] && typeof claims['https://api.openai.com/auth'] === 'object'
    ? claims['https://api.openai.com/auth']
    : {};
  const profile = claims['https://api.openai.com/profile'] && typeof claims['https://api.openai.com/profile'] === 'object'
    ? claims['https://api.openai.com/profile']
    : {};
  const organization = firstString(
    auth.poid,
    Array.isArray(auth.organizations) ? auth.organizations.find((item) => item?.is_default)?.id : '',
    Array.isArray(auth.organizations) ? auth.organizations[0]?.id : ''
  );
  const expiresAt = Number.isFinite(Number(claims.exp))
    ? new Date(Number(claims.exp) * 1000).toISOString()
    : '';
  return {
    oauth_expires_at: expiresAt,
    oauth_client_id: firstString(claims.client_id),
    oauth_email: firstString(profile.email, claims.email),
    oauth_plan_type: firstString(auth.chatgpt_plan_type),
    chatgpt_account_id: firstString(auth.chatgpt_account_id),
    chatgpt_user_id: firstString(auth.chatgpt_account_user_id, auth.chatgpt_user_id, auth.user_id, claims.sub),
    organization_id: organization
  };
}
