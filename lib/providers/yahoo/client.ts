/**
 * YahooFantasyClient — the only thing that makes authenticated HTTP calls to the
 * Yahoo Fantasy Sports API. Route handlers and discovery helpers go through this.
 *
 * Responsibilities:
 *   - Bearer auth from a YahooTokenStore, with transparent refresh-then-retry
 *     ONCE on a 401 (never a refresh loop).
 *   - `?format=json` on every request (Yahoo defaults to XML).
 *   - A hard timeout per request.
 *   - Structured, classified errors (`YahooApiError`) — auth vs rate-limit vs
 *     not-found vs server vs malformed vs timeout — never a raw throw.
 *   - Diagnostic metadata (status, url path, request id) WITHOUT credentials.
 *
 * It does NOT normalize Yahoo's `fantasy_content` shape into canonical models —
 * that deliberate work is a later phase. This client returns parsed JSON.
 */

import { YAHOO_FANTASY_BASE_URL, type YahooConfig } from "./config";
import { getValidAccessToken, recordYahooAuthenticatedRead, type YahooTokenStore } from "./oauth";

export type YahooApiErrorKind =
  | "NOT_CONNECTED"
  | "AUTH" // 401 after a refresh attempt
  | "FORBIDDEN" // 403 — token valid but not entitled to this resource
  | "NOT_FOUND" // 404
  | "RATE_LIMITED" // 429 / 999
  | "SERVER" // 5xx
  | "MALFORMED" // 2xx body we cannot parse
  | "TIMEOUT"
  | "NETWORK"
  // strict read-only certification mode: the current access token is expired / rejected and refreshing is FORBIDDEN (a refresh would write a rotated token to the token store)
  | "AUTH_REFRESH_REQUIRED_READ_ONLY";

export class YahooApiError extends Error {
  constructor(
    readonly kind: YahooApiErrorKind,
    message: string,
    readonly httpStatus: number | null = null,
    readonly resourcePath: string | null = null,
    /** Yahoo's own error description (truncated, from the response body) when it sent one. */
    readonly yahooMessage: string | null = null,
    /** True when a forced token refresh + retry was attempted for this request. */
    readonly refreshAttempted: boolean = false,
  ) {
    super(message);
    this.name = "YahooApiError";
  }
}

/**
 * Pull Yahoo's error description out of a non-2xx body (JSON `{error:{description}}`
 * or XML `<description>`). Bounded + whitespace-collapsed; response bodies never
 * carry credentials, but we still cap the length.
 */
export function extractYahooErrorMessage(bodyText: string): string | null {
  if (!bodyText) return null;
  let msg: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { description?: unknown } | unknown };
    const err = parsed?.error as { description?: unknown } | string | undefined;
    if (typeof err === "string") msg = err;
    else if (err && typeof err.description === "string") msg = err.description;
  } catch {
    const m = /<description>([\s\S]*?)<\/description>/i.exec(bodyText);
    if (m?.[1]) msg = m[1];
  }
  if (!msg) return null;
  return msg.replace(/\s+/g, " ").trim().slice(0, 300) || null;
}

export interface YahooRequestMeta {
  resource_path: string;
  http_status: number;
  duration_ms: number;
  refreshed: boolean;
  /** Yahoo's `x-yahoo-request-id` / `x-request-id` when present — safe to log. */
  request_id: string | null;
}

export interface YahooResponse<T = unknown> {
  data: T;
  meta: YahooRequestMeta;
}

export interface YahooFantasyClientOptions {
  config: YahooConfig;
  store: YahooTokenStore;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /**
   * STRICT READ-ONLY / NO-REFRESH mode (live certification). The current access token may be used for GET requests; token refresh is impossible by construction: the refresh code
   * (`getValidAccessToken`, the token endpoint, `store.set`) is never reached. An expired token or a Yahoo 401 fails with `AUTH_REFRESH_REQUIRED_READ_ONLY`.
   */
  readOnly?: boolean;
}

/** an access token this close to expiry is treated as expired in read-only mode (it could lapse mid-request) */
export const READ_ONLY_EXPIRY_MARGIN_MS = 5_000;

export class YahooFantasyClient {
  #config: YahooConfig;
  #store: YahooTokenStore;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #base: string;
  #readOnly: boolean;

  constructor(opts: YahooFantasyClientOptions) {
    this.#readOnly = opts.readOnly === true;
    this.#config = opts.config;
    this.#store = opts.store;
    this.#timeoutMs = opts.timeoutMs ?? 12_000;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#base = (opts.baseUrl ?? YAHOO_FANTASY_BASE_URL).replace(/\/$/, "");
  }

  get tokenBackend(): string {
    return this.#store.backend;
  }

  /**
   * GET a Yahoo Fantasy resource path (e.g. `/users;use_login=1/games` or
   * `/game/nfl`). Leading slash optional. Always JSON.
   */
  async get<T = unknown>(resourcePath: string): Promise<YahooResponse<T>> {
    const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.#base}${path}${sep}format=json`;

    if (this.#readOnly) return this.#getReadOnly<T>(url, path);

    const first = await getValidAccessToken(this.#config, this.#store, { fetchImpl: this.#fetch });
    if (first.status === "NOT_CONNECTED") {
      throw new YahooApiError("NOT_CONNECTED", "No Yahoo account is connected.", null, path);
    }
    if (first.status === "REFRESH_FAILED" || !first.access_token) {
      throw new YahooApiError(
        "AUTH",
        `Yahoo token unavailable: ${first.detail ?? "refresh failed"}`,
        null,
        path,
      );
    }

    let refreshed = false;
    let attempt = await this.#send<T>(url, first.access_token, path, false);
    if (attempt.retryableAuth) {
      // Exactly one forced-refresh retry.
      const second = await getValidAccessToken(this.#config, this.#store, {
        forceRefresh: true,
        rejectedAccessToken: first.access_token,
        fetchImpl: this.#fetch,
      });
      if (second.status !== "OK" || !second.access_token) {
        throw new YahooApiError(
          "AUTH",
          `Yahoo returned 401 and the refresh retry failed: ${second.detail ?? second.status}`,
          401,
          path,
          null,
          true,
        );
      }
      refreshed = true;
      attempt = await this.#send<T>(url, second.access_token, path, true);
      if (attempt.retryableAuth) {
        throw new YahooApiError("AUTH", "Yahoo returned 401 even after a token refresh.", 401, path, null, true);
      }
    }

    if (attempt.error) {
      throw refreshed && !attempt.error.refreshAttempted
        ? new YahooApiError(
            attempt.error.kind,
            attempt.error.message,
            attempt.error.httpStatus,
            attempt.error.resourcePath,
            attempt.error.yahooMessage,
            true,
          )
        : attempt.error;
    }
    recordYahooAuthenticatedRead(this.#store.connection_id ?? "default");
    return { data: attempt.data as T, meta: { ...attempt.meta!, refreshed } };
  }

  /** The ONLY read-only path: current token, one GET, no refresh, no store write. */
  async #getReadOnly<T>(url: string, path: string): Promise<YahooResponse<T>> {
    let token;
    try { token = await this.#store.get(); } catch { throw new YahooApiError("AUTH", "Yahoo token store read failed (read-only mode).", null, path); }
    if (!token) throw new YahooApiError("NOT_CONNECTED", "No Yahoo access token is available (read-only mode).", null, path);
    if (token.expires_at - Date.now() <= READ_ONLY_EXPIRY_MARGIN_MS) {
      throw new YahooApiError("AUTH_REFRESH_REQUIRED_READ_ONLY", "AUTH_REFRESH_REQUIRED_READ_ONLY: the access token is expired and token refresh is forbidden in strict read-only mode.", null, path);
    }
    const attempt = await this.#send<T>(url, token.access_token, path, false, true);
    if (attempt.error) {
      if (attempt.error.httpStatus === 401) throw new YahooApiError("AUTH_REFRESH_REQUIRED_READ_ONLY", "AUTH_REFRESH_REQUIRED_READ_ONLY: Yahoo rejected the access token (401) and token refresh is forbidden in strict read-only mode.", 401, path);
      throw attempt.error;
    }
    return { data: attempt.data as T, meta: { ...attempt.meta!, refreshed: false } };
  }

  async #send<T>(
    url: string,
    accessToken: string,
    path: string,
    isRetry: boolean,
    noAuthRetry = false,
  ): Promise<{
    retryableAuth: boolean;
    data?: T;
    error?: YahooApiError;
    meta?: YahooRequestMeta;
  }> {
    const start = Date.now();
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const timeout =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        retryableAuth: false,
        error: new YahooApiError(
          timeout ? "TIMEOUT" : "NETWORK",
          `Yahoo request ${timeout ? "timed out" : "failed"}: ${err instanceof Error ? err.message : String(err)}`,
          null,
          path,
        ),
      };
    }

    const duration_ms = Date.now() - start;
    const request_id =
      res.headers.get("x-yahoo-request-id") ?? res.headers.get("x-request-id") ?? null;
    const meta: YahooRequestMeta = {
      resource_path: path,
      http_status: res.status,
      duration_ms,
      refreshed: isRetry,
      request_id,
    };
    const bodyText = await res.text().catch(() => "");

    if (res.status === 401 && !isRetry && !noAuthRetry) return { retryableAuth: true };

    if (!res.ok) {
      const kind: YahooApiErrorKind =
        res.status === 401
          ? "AUTH"
          : res.status === 403
            ? "FORBIDDEN"
            : res.status === 404
              ? "NOT_FOUND"
              : res.status === 429 || res.status === 999
                ? "RATE_LIMITED"
                : res.status >= 500
                  ? "SERVER"
                  : "SERVER";
      return {
        retryableAuth: false,
        meta,
        error: new YahooApiError(
          kind,
          `Yahoo ${path} -> HTTP ${res.status}${request_id ? ` (req ${request_id})` : ""}`,
          res.status,
          path,
          extractYahooErrorMessage(bodyText),
        ),
      };
    }

    try {
      const data = bodyText ? (JSON.parse(bodyText) as T) : ({} as T);
      return { retryableAuth: false, data, meta };
    } catch {
      return {
        retryableAuth: false,
        meta,
        error: new YahooApiError(
          "MALFORMED",
          `Yahoo ${path} returned HTTP ${res.status} with a non-JSON body.`,
          res.status,
          path,
        ),
      };
    }
  }
}
