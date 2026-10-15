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
  /** Stable non-secret slot id used to isolate concurrent token refreshes. */
  readonly connection_id?: string;
  get(): Promise<YahooToken | null>;
  set(token: YahooToken): Promise<void>;
  clear(): Promise<void>;
  /** Token + rotation counter + non-secret bookkeeping, read in ONE query. Stores without it fall back to `get()`. */
  getVersioned?(): Promise<YahooVersionedToken | null>;
  /**
   * Compare-and-swap rotation: persists `token` (both tokens, ONE row, ONE statement) only if the stored `refresh_seq` still equals `expectedSeq`,
   * and bumps it. `CONFLICT` = another instance rotated first; the caller must adopt the stored token, never overwrite it.
   */
  rotate?(expectedSeq: number, token: YahooToken): Promise<{ ok: true; seq: number } | { ok: false; reason: "CONFLICT" }>;
  /** Non-secret bookkeeping: last authenticated Yahoo read. Never throws. */
  markUsed?(): Promise<void>;
  /** Human-readable backend name for diagnostics ("supabase" | "memory" | "none"). */
  readonly backend: string;
}

export interface YahooVersionedToken { token: YahooToken; seq: number; last_refreshed_at: number | null; last_used_at: number | null }

export class InMemoryYahooTokenStore implements YahooTokenStore {
  readonly backend = "memory";
  #token: YahooToken | null = null;
  #seq = 0;
  #refreshedAt: number | null = null;
  #usedAt: number | null = null;
  async getVersioned(): Promise<YahooVersionedToken | null> {
    return this.#token ? { token: { ...this.#token }, seq: this.#seq, last_refreshed_at: this.#refreshedAt, last_used_at: this.#usedAt } : null;
  }
  async rotate(expectedSeq: number, token: YahooToken): Promise<{ ok: true; seq: number } | { ok: false; reason: "CONFLICT" }> {
    if (!this.#token || this.#seq !== expectedSeq) return { ok: false, reason: "CONFLICT" };
    this.#token = { ...token }; this.#seq += 1; this.#refreshedAt = Date.now();
    return { ok: true, seq: this.#seq };
  }
  async markUsed(): Promise<void> { this.#usedAt = Date.now(); }

  constructor(readonly connection_id = "memory") {}
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
 * TOKEN LIFECYCLE (permanent production capability; no manual token maintenance).
 *
 * 1. In-process: concurrent callers for one connection share ONE refresh (single-flight, keyed by client + connection + guid).
 * 2. Cross-instance: rotation is a compare-and-swap on `refresh_seq` (ONE atomic row update holding BOTH new encrypted tokens).
 *    The instance that loses the race (CONFLICT) ADOPTS the stored token; it never overwrites a newer rotation.
 * 3. Yahoo may invalidate the old refresh token on first use. A loser that gets `invalid_grant` therefore re-reads the store (bounded polling):
 *    if the seq advanced, a sibling rotated first and its token is adopted; only a refresh token that is still the stored one AND is rejected
 *    is a genuine `reauthorization_required`.
 * 4. After Yahoo has rotated, the new tokens are the only copy: persistence is retried, and if the store stays down the rotation is held in
 *    memory (`pendingRotation`) and re-persisted on the next call BEFORE any further Yahoo refresh.
 * 5. A 401 forces ONE refresh retry; if the store already holds a different, still-fresh access token (a sibling refreshed) that token is adopted
 *    instead of burning another rotation.
 * Failures are typed and recorded (non-secret) in the health registry; a failed refresh never yields an access token (no stale-as-live).
 */
const inflight = new Map<string, Promise<RefreshOutcome>>();
const pendingRotation = new Map<string, { token: YahooToken; baseSeq: number }>();

export type YahooFailureKind = "INVALID_GRANT" | "NETWORK" | "TOKEN_ENDPOINT_HTTP" | "TOKEN_ENDPOINT_MALFORMED" | "STORE_READ" | "STORE_WRITE";

export interface YahooConnectionLifecycleRecord {
  last_refresh_ok_at: number | null;
  last_refresh_failure_at: number | null;
  last_refresh_failure_kind: YahooFailureKind | null;
  reauthorization_required: boolean;
  persist_pending: boolean;
  last_authenticated_read_at: number | null;
}
const lifecycle = new Map<string, YahooConnectionLifecycleRecord>();
const blank = (): YahooConnectionLifecycleRecord => ({ last_refresh_ok_at: null, last_refresh_failure_at: null, last_refresh_failure_kind: null, reauthorization_required: false, persist_pending: false, last_authenticated_read_at: null });
const rec = (id: string): YahooConnectionLifecycleRecord => { let r = lifecycle.get(id); if (!r) { r = blank(); lifecycle.set(id, r); } return r; };
export function getYahooLifecycleRecord(connectionId: string): YahooConnectionLifecycleRecord { return { ...(lifecycle.get(connectionId) ?? blank()) }; }
export function recordYahooAuthenticatedRead(connectionId: string, at = Date.now()): void { rec(connectionId).last_authenticated_read_at = at; }
export function __resetYahooLifecycle(): void { lifecycle.clear(); pendingRotation.clear(); inflight.clear(); }

export interface GetAccessTokenResult {
  status: "OK" | "NOT_CONNECTED" | "REFRESH_FAILED";
  access_token: string | null;
  token: YahooToken | null;
  detail?: string;
  /** True only when Yahoo itself rejected a refresh token that is still the stored one (genuine reauthorization). */
  reauthorization_required?: boolean;
  failure_kind?: YahooFailureKind;
  /** True when this call performed (or adopted a sibling's) rotation rather than reusing a fresh stored token. */
  rotated?: boolean;
}

type RefreshOutcome = { ok: true; token: YahooToken; adopted: boolean } | { ok: false; kind: YahooFailureKind; detail: string; reauth: boolean };

export interface GetAccessTokenOptions {
  forceRefresh?: boolean;
  /** The access token Yahoo just rejected (401). If the store already holds a different fresh one, adopt it instead of rotating again. */
  rejectedAccessToken?: string;
  /** Refresh when within this many ms of expiry (default REFRESH_SKEW_MS). The health job uses a wider window. */
  skewMs?: number;
  now?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: simulate a separate server instance (own in-process single-flight map). */
  inflightMap?: Map<string, Promise<RefreshOutcome>>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PERSIST_ATTEMPTS = 3;
const ADOPT_POLLS = 4;

async function readVersioned(store: YahooTokenStore): Promise<YahooVersionedToken | null> {
  if (store.getVersioned) return store.getVersioned();
  const t = await store.get();
  return t ? { token: t, seq: 0, last_refreshed_at: null, last_used_at: null } : null;
}

async function persistRotation(store: YahooTokenStore, baseSeq: number, token: YahooToken, sleep: (ms: number) => Promise<void>): Promise<"OK" | "CONFLICT" | "FAILED"> {
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt++) {
    try {
      if (store.rotate) {
        const r = await store.rotate(baseSeq, token);
        return r.ok ? "OK" : "CONFLICT";
      }
      await store.set(token); // stores without CAS (legacy / tests): last-writer-wins
      return "OK";
    } catch {
      if (attempt < PERSIST_ATTEMPTS - 1) await sleep(250 * (attempt + 1));
    }
  }
  return "FAILED";
}

async function doRefresh(config: YahooConfig, store: YahooTokenStore, key: string, connId: string, token: YahooToken, seq: number, opts: GetAccessTokenOptions): Promise<RefreshOutcome> {
  const sleep = opts.sleep ?? defaultSleep; const now = () => opts.now ?? Date.now();
  // (4) a rotation Yahoo already issued but we could not persist is the ONLY valid credential: persist it first, never refresh over it.
  const pending = pendingRotation.get(key);
  if (pending) {
    const r = await persistRotation(store, pending.baseSeq, pending.token, sleep);
    if (r === "OK") { pendingRotation.delete(key); rec(connId).persist_pending = false; return { ok: true, token: pending.token, adopted: false }; }
    if (r === "CONFLICT") { pendingRotation.delete(key); rec(connId).persist_pending = false; }
    else return { ok: true, token: pending.token, adopted: false }; // still cannot persist: keep serving the held rotation
  }
  let fresh: YahooToken;
  try {
    fresh = await refreshAccessToken(config, token, opts.fetchImpl);
  } catch (err) {
    const e = err instanceof YahooOAuthError ? err : null;
    if (e?.kind === "INVALID_GRANT") {
      // (3) did a sibling instance rotate first? Poll the store briefly for a newer seq / different refresh token.
      for (let i = 0; i < ADOPT_POLLS; i++) {
        try {
          const cur = await readVersioned(store);
          if (cur && (cur.seq > seq || cur.token.refresh_token !== token.refresh_token) && cur.token.expires_at - now() > 0) return { ok: true, token: cur.token, adopted: true };
        } catch { /* keep polling */ }
        await sleep(300 * (i + 1));
      }
      return { ok: false, kind: "INVALID_GRANT", detail: "Yahoo rejected the stored refresh token (invalid_grant) and no sibling rotation was found.", reauth: true };
    }
    return { ok: false, kind: (e?.kind ?? "NETWORK") as YahooFailureKind, detail: e ? e.message : "Yahoo token refresh failed.", reauth: false };
  }
  const persisted = await persistRotation(store, seq, fresh, sleep);
  if (persisted === "OK") return { ok: true, token: fresh, adopted: false };
  if (persisted === "CONFLICT") {
    // (2) a sibling won the CAS: ITS rotation is the stored truth; ours is discarded.
    try { const cur = await readVersioned(store); if (cur) return { ok: true, token: cur.token, adopted: true }; } catch { /* fall through */ }
    return { ok: false, kind: "STORE_READ", detail: "Lost the rotation race and could not re-read the stored token.", reauth: false };
  }
  // Yahoo rotated but the store is down: hold the rotation in memory (never lose the new refresh token), serve this request, retry next call.
  pendingRotation.set(key, { token: fresh, baseSeq: seq }); rec(connId).persist_pending = true;
  rec(connId).last_refresh_failure_at = now(); rec(connId).last_refresh_failure_kind = "STORE_WRITE";
  return { ok: true, token: fresh, adopted: false };
}

/**
 * Return a still-valid access token, refreshing when within the skew of expiry (or on a 401 retry). Never throws; typed result, fail-closed:
 * a failed refresh NEVER returns an access token.
 */
export async function getValidAccessToken(
  config: YahooConfig,
  store: YahooTokenStore,
  opts: GetAccessTokenOptions = {},
): Promise<GetAccessTokenResult> {
  const now = opts.now ?? Date.now();
  const connId = store.connection_id ?? "default";
  let cur: YahooVersionedToken | null;
  try {
    cur = await readVersioned(store);
  } catch (err) {
    rec(connId).last_refresh_failure_at = now; rec(connId).last_refresh_failure_kind = "STORE_READ";
    return { status: "REFRESH_FAILED", access_token: null, token: null, failure_kind: "STORE_READ", detail: `Token store read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!cur) return { status: "NOT_CONNECTED", access_token: null, token: null };
  const token = cur.token; const skew = opts.skewMs ?? REFRESH_SKEW_MS;
  const key = `${config.client_id}:${connId}:${token.yahoo_guid ?? "no-guid"}`;

  const stillFresh = token.expires_at - now > skew;
  const rejected = opts.rejectedAccessToken !== undefined && token.access_token === opts.rejectedAccessToken;
  // (5) 401 retry: the store already holds a different fresh token -> a sibling refreshed; adopt, do not rotate again.
  if (opts.rejectedAccessToken !== undefined && !rejected && token.expires_at - now > REFRESH_SKEW_MS && !pendingRotation.has(key)) return { status: "OK", access_token: token.access_token, token, rotated: true };
  if (!opts.forceRefresh && stillFresh && !pendingRotation.has(key)) return { status: "OK", access_token: token.access_token, token };

  const map = opts.inflightMap ?? inflight;
  let p = map.get(key);
  if (!p) { p = doRefresh(config, store, key, connId, token, cur.seq, opts).finally(() => map.delete(key)); map.set(key, p); }
  const out = await p;
  if (!out.ok) {
    const r = rec(connId); r.last_refresh_failure_at = now; r.last_refresh_failure_kind = out.kind; if (out.reauth) r.reauthorization_required = true;
    return { status: "REFRESH_FAILED", access_token: null, token, detail: out.detail, failure_kind: out.kind, reauthorization_required: out.reauth };
  }
  const r = rec(connId); r.last_refresh_ok_at = now; r.reauthorization_required = false;
  return { status: "OK", access_token: out.token.access_token, token: out.token, rotated: true };
}
