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
import { getValidAccessToken, type YahooTokenStore } from "./oauth";

export type YahooApiErrorKind =
  | "NOT_CONNECTED"
  | "AUTH" // 401 after a refresh attempt
  | "FORBIDDEN" // 403 — token valid but not entitled to this resource
  | "NOT_FOUND" // 404
  | "RATE_LIMITED" // 429 / 999
  | "SERVER" // 5xx
  | "MALFORMED" // 2xx body we cannot parse
  | "TIMEOUT"
  | "NETWORK";

export class YahooApiError extends Error {
  constructor(
    readonly kind: YahooApiErrorKind,
    message: string,
    readonly httpStatus: number | null = null,
    readonly resourcePath: string | null = null,
  ) {
    super(message);
    this.name = "YahooApiError";
  }
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
}

export class YahooFantasyClient {
  #config: YahooConfig;
  #store: YahooTokenStore;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #base: string;

  constructor(opts: YahooFantasyClientOptions) {
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
        fetchImpl: this.#fetch,
      });
      if (second.status !== "OK" || !second.access_token) {
        throw new YahooApiError(
          "AUTH",
          `Yahoo returned 401 and the refresh retry failed: ${second.detail ?? second.status}`,
          401,
          path,
        );
      }
      refreshed = true;
      attempt = await this.#send<T>(url, second.access_token, path, true);
      if (attempt.retryableAuth) {
        throw new YahooApiError("AUTH", "Yahoo returned 401 even after a token refresh.", 401, path);
      }
    }

    if (attempt.error) throw attempt.error;
    return { data: attempt.data as T, meta: { ...attempt.meta!, refreshed } };
  }

  async #send<T>(
    url: string,
    accessToken: string,
    path: string,
    isRetry: boolean,
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

    if (res.status === 401 && !isRetry) return { retryableAuth: true };

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
