/**
 * Yahoo OAuth 2.0 — design + token-store seam.
 *
 * FLOW (three-legged OAuth, read-only):
 *   1. /api/auth/yahoo/connect
 *        -> 302 to YAHOO_OAUTH_AUTHORIZE_URL with
 *           response_type=code, client_id, redirect_uri, scope=fspt-r, state=<csrf>
 *   2. user approves on Yahoo; Yahoo redirects to
 *        /api/auth/yahoo/callback?code=<code>&state=<csrf>
 *   3. callback exchanges `code` at YAHOO_OAUTH_TOKEN_URL for
 *        { access_token, refresh_token, expires_in } and persists via YahooTokenStore
 *   4. subsequent API calls use access_token; on 401 the refresh_token mints a
 *        new access_token (also persisted). refresh tokens are long-lived.
 *
 * SECURITY:
 *   - client secret only ever read from env, never logged, never sent to a client
 *   - tokens are stored server-side only (Supabase `yahoo_connections` or an
 *     injected store); never placed in a cookie readable by JS, never logged
 *   - `state` is a single-use CSRF nonce checked in the callback
 *
 * STATUS: the exchange/refresh functions below are written to spec but have NOT
 * been exercised against the live Yahoo API — no approved credentials exist yet.
 * They are guarded so they cannot run without configuration, and the provider
 * reports AUTH_REQUIRED / NOT_CONFIGURED until a real connection is established.
 */

import {
  YAHOO_OAUTH_AUTHORIZE_URL,
  YAHOO_OAUTH_TOKEN_URL,
  type YahooConfig,
} from "./config";

export interface YahooToken {
  access_token: string;
  refresh_token: string;
  /** Epoch ms when `access_token` expires. */
  expires_at: number;
  /** Yahoo GUID of the authorized user, when returned. */
  yahoo_guid: string | null;
}

/**
 * Where Yahoo tokens live. Production: a Supabase-backed store keyed by the
 * bridge deployment (there is exactly one Yahoo connection for now — the owner's
 * account used to read `Maclin on Chick's XVI`). Tests: an in-memory store.
 */
export interface YahooTokenStore {
  get(): Promise<YahooToken | null>;
  set(token: YahooToken): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryYahooTokenStore implements YahooTokenStore {
  #token: YahooToken | null = null;
  async get(): Promise<YahooToken | null> {
    return this.#token;
  }
  async set(token: YahooToken): Promise<void> {
    this.#token = token;
  }
  async clear(): Promise<void> {
    this.#token = null;
  }
}

/** Build the authorize-URL redirect target for /api/auth/yahoo/connect. */
export function buildAuthorizeUrl(config: YahooConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    response_type: "code",
    scope: config.scope,
    state,
  });
  return `${YAHOO_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  xoauth_yahoo_guid?: string;
  error?: string;
  error_description?: string;
}

async function postToken(config: YahooConfig, body: Record<string, string>): Promise<YahooToken> {
  const basic = Buffer.from(`${config.client_id}:${config.client_secret}`).toString("base64");
  const res = await fetch(YAHOO_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ redirect_uri: config.redirect_uri, ...body }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as RawTokenResponse;
  if (!res.ok || !json.access_token || !json.refresh_token) {
    throw new Error(
      `Yahoo token endpoint failed (${res.status}): ${json.error ?? "unknown"} ${json.error_description ?? ""}`.trim(),
    );
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    yahoo_guid: json.xoauth_yahoo_guid ?? null,
  };
}

/** Step 3: exchange an authorization code for tokens. UNVERIFIED against live Yahoo. */
export function exchangeCodeForToken(config: YahooConfig, code: string): Promise<YahooToken> {
  return postToken(config, { grant_type: "authorization_code", code });
}

/** Step 4: refresh an expired access token. UNVERIFIED against live Yahoo. */
export function refreshAccessToken(config: YahooConfig, refreshToken: string): Promise<YahooToken> {
  return postToken(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Return a still-valid access token, refreshing when within 60s of expiry. */
export async function getValidAccessToken(
  config: YahooConfig,
  store: YahooTokenStore,
): Promise<string | null> {
  const token = await store.get();
  if (!token) return null;
  if (token.expires_at - Date.now() > 60_000) return token.access_token;
  const refreshed = await refreshAccessToken(config, token.refresh_token);
  await store.set(refreshed);
  return refreshed.access_token;
}
