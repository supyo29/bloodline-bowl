/**
 * Yahoo OAuth 2.0 — Authorization Code flow (server-side, read-only).
 *
 * FLOW:
 *   1. GET /api/yahoo/auth/start
 *        -> 302 to YAHOO_OAUTH_AUTHORIZE_URL with
 *           response_type=code, client_id, redirect_uri, scope=fspt-r, state=<csrf>
 *        The `state` is a 32-byte random nonce, also set as an HttpOnly,
 *        SameSite=Lax cookie (sent back on Yahoo's top-level redirect).
 *   2. user approves on Yahoo; Yahoo redirects to
 *        GET /api/yahoo/oauth/callback?code=<code>&state=<csrf>
 *   3. callback constant-time-compares `state` vs the cookie, exchanges `code`
 *        at YAHOO_OAUTH_TOKEN_URL for { access_token, refresh_token, expires_in },
 *        and persists via a YahooTokenStore. The cookie is cleared.
 *   4. API calls use access_token; within `REFRESH_SKEW_MS` of expiry (or on a
 *        401) the refresh_token mints a new access_token, which is persisted.
 *
 * SECURITY:
 *   - client secret only ever read from env, never logged, never sent to a client
 *   - tokens are stored server-side only, encrypted at rest (see token-store.ts);
 *     never in a JS-readable cookie, never logged, never in a response body
 *   - the token endpoint is called with HTTP Basic auth (client_id:client_secret)
 *   - `state` is a single-use CSRF nonce, compared in constant time
 */

import { timingSafeEqual } from "node:crypto";
import {
  YAHOO_OAUTH_AUTHORIZE_URL,
  YAHOO_OAUTH_TOKEN_URL,
  type YahooConfig,
} from "./config";

/** Refresh this far ahead of the real expiry. */
export const REFRESH_SKEW_MS = 120_000;

export type YahooOAuthErrorKind =
  | "TOKEN_ENDPOINT_HTTP"
  | "TOKEN_ENDPOINT_MALFORMED"
  | "INVALID_GRANT"
  | "NETWORK";

export class YahooOAuthError extends Error {
  constructor(
    readonly kind: YahooOAuthErrorKind,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "YahooOAuthError";
  }
}

export interface YahooToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string | null;
  /** Epoch ms when `access_token` expires. */
  expires_at: number;
  /** Yahoo GUID of the authorized user, when returned. */
  yahoo_guid: string | null;
}

/**
 * Where Yahoo tokens live. Production: a Supabase-backed, encrypted store
 * (`SupabaseYahooTokenStore`). Tests / dev without a DB: `InMemoryYahooTokenStore`.
 */
export interface YahooTokenStore {
  get(): Promise<YahooToken | null>;
  set(token: YahooToken): Promise<void>;
  clear(): Promise<void>;
  /** Human-readable backend name for diagnostics ("supabase" | "memory" | "none"). */
  readonly backend: string;
}

export class InMemoryYahooTokenStore implements YahooTokenStore {
  readonly backend = "memory";
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

/** Build the authorize-URL redirect target for /api/yahoo/auth/start. */
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

/** Constant-time string compare for the CSRF `state` nonce. */
export function statesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  xoauth_yahoo_guid?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  config: YahooConfig,
  body: Record<string, string>,
  previous?: YahooToken,
  fetchImpl: typeof fetch = fetch,
): Promise<YahooToken> {
  const basic = Buffer.from(`${config.client_id}:${config.client_secret}`).toString("base64");
  let res: Response;
  try {
    res = await fetchImpl(YAHOO_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ redirect_uri: config.redirect_uri, ...body }).toString(),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    throw new YahooOAuthError(
      "NETWORK",
      `Could not reach Yahoo token endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const raw = await res.text();
  let json: RawTokenResponse;
  try {
    json = raw ? (JSON.parse(raw) as RawTokenResponse) : {};
  } catch {
    throw new YahooOAuthError(
      "TOKEN_ENDPOINT_MALFORMED",
      `Yahoo token endpoint returned non-JSON (HTTP ${res.status}).`,
      res.status,
    );
  }

  if (!res.ok) {
    const kind: YahooOAuthErrorKind =
      json.error === "invalid_grant" ? "INVALID_GRANT" : "TOKEN_ENDPOINT_HTTP";
    throw new YahooOAuthError(
      kind,
      `Yahoo token endpoint failed (HTTP ${res.status}): ${json.error ?? "unknown"}${
        json.error_description ? ` — ${json.error_description}` : ""
      }`,
      res.status,
    );
  }

  // `access_token` is always required. `refresh_token` is required on the
  // initial code exchange; on a refresh Yahoo may omit it and we keep the prior.
  if (!json.access_token || (!json.refresh_token && !previous?.refresh_token)) {
    throw new YahooOAuthError(
      "TOKEN_ENDPOINT_MALFORMED",
      "Yahoo token endpoint returned HTTP 200 without a usable access_token/refresh_token.",
      res.status,
    );
  }

  return {
    access_token: json.access_token,
    // Yahoo usually returns the same refresh_token; keep the previous one if it
    // is ever omitted so a refresh never loses the ability to refresh again.
    refresh_token: json.refresh_token ?? previous?.refresh_token ?? "",
    token_type: json.token_type ?? previous?.token_type ?? "bearer",
    scope: json.scope ?? previous?.scope ?? null,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    yahoo_guid: json.xoauth_yahoo_guid ?? previous?.yahoo_guid ?? null,
  };
}

/** Step 3: exchange an authorization code for tokens. */
export function exchangeCodeForToken(
  config: YahooConfig,
  code: string,
  fetchImpl?: typeof fetch,
): Promise<YahooToken> {
  return postToken(config, { grant_type: "authorization_code", code }, undefined, fetchImpl);
}

/** Step 4: refresh an expired access token. */
export function refreshAccessToken(
  config: YahooConfig,
  previous: YahooToken,
  fetchImpl?: typeof fetch,
): Promise<YahooToken> {
  return postToken(
    config,
    { grant_type: "refresh_token", refresh_token: previous.refresh_token },
    previous,
    fetchImpl,
  );
}

/**
 * In-process de-dupe of concurrent refreshes. Two requests on the same warm
 * instance that both find the token expiring share ONE network refresh + ONE
 * store write. Across instances, both may refresh; Yahoo keeps the prior refresh
 * token valid and the store write is last-writer-wins on a still-valid token, so
 * there is no torn state (documented in YAHOO_BRIDGE_PHASE_1.md).
 */
const inflight = new Map<string, Promise<YahooToken>>();

export interface GetAccessTokenResult {
  status: "OK" | "NOT_CONNECTED" | "REFRESH_FAILED";
  access_token: string | null;
  token: YahooToken | null;
  detail?: string;
}

/**
 * Return a still-valid access token, refreshing when within `REFRESH_SKEW_MS` of
 * expiry. Never throws — returns a typed result so callers stay on the
 * fail-closed contract.
 */
export async function getValidAccessToken(
  config: YahooConfig,
  store: YahooTokenStore,
  opts: { forceRefresh?: boolean; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<GetAccessTokenResult> {
  const now = opts.now ?? Date.now();
  let token: YahooToken | null;
  try {
    token = await store.get();
  } catch (err) {
    return {
      status: "REFRESH_FAILED",
      access_token: null,
      token: null,
      detail: `Token store read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!token) return { status: "NOT_CONNECTED", access_token: null, token: null };

  const fresh = !opts.forceRefresh && token.expires_at - now > REFRESH_SKEW_MS;
  if (fresh) return { status: "OK", access_token: token.access_token, token };

  const key = `${config.client_id}:${token.yahoo_guid ?? "primary"}`;
  let refreshed: YahooToken;
  try {
    const existing = inflight.get(key);
    if (existing) {
      refreshed = await existing;
    } else {
      const p = refreshAccessToken(config, token, opts.fetchImpl).finally(() => inflight.delete(key));
      inflight.set(key, p);
      refreshed = await p;
      await store.set(refreshed);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "REFRESH_FAILED", access_token: null, token, detail };
  }
  return { status: "OK", access_token: refreshed.access_token, token: refreshed };
}
