/**
 * Yahoo access-state taxonomy.
 *
 * Two independent things can be wrong, and the diagnostics must never conflate
 * them:
 *
 *   (A) the OAuth CONNECTION  — do we hold a usable token for a Yahoo account?
 *   (B) the FANTASY API GRANT — will Yahoo's Fantasy Sports API actually answer
 *                               requests from this Client ID?
 *
 * A perfectly valid token (A ok) can still get HTTP 403 from every Fantasy
 * endpoint (B not yet provisioned). That situation is `FANTASY_API_FORBIDDEN`,
 * NOT "OAuth failed" / "token invalid" / "not connected".
 */

import { YahooApiError } from "./client";
import type { YahooSession } from "./session";

export type YahooAccessState =
  | "NOT_CONFIGURED" // OAuth app env vars missing
  | "STORAGE_UNAVAILABLE" // configured, but no durable token store
  | "NOT_CONNECTED" // configured + storage ok, no account authorized
  | "TOKEN_EXPIRED_OR_INVALID" // had a token, cannot present/refresh a valid one
  | "CONNECTED" // OAuth good; Fantasy API not probed, or probe succeeded
  | "FANTASY_API_FORBIDDEN" // OAuth good; Fantasy API returned HTTP 403
  | "RATE_LIMITED" // OAuth good; Fantasy API returned 429 / 999
  | "NETWORK_ERROR" // OAuth good; transport failure / timeout / Yahoo 5xx
  | "MALFORMED_RESPONSE"; // OAuth good; Fantasy API returned an unparseable body

export const YAHOO_ACCESS_STATES: readonly YahooAccessState[] = [
  "NOT_CONFIGURED",
  "STORAGE_UNAVAILABLE",
  "NOT_CONNECTED",
  "TOKEN_EXPIRED_OR_INVALID",
  "CONNECTED",
  "FANTASY_API_FORBIDDEN",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "MALFORMED_RESPONSE",
];

/** True when the OAuth connection itself is healthy, regardless of API grant. */
export function isConnected(state: YahooAccessState): boolean {
  return (
    state === "CONNECTED" ||
    state === "FANTASY_API_FORBIDDEN" ||
    state === "RATE_LIMITED" ||
    state === "NETWORK_ERROR" ||
    state === "MALFORMED_RESPONSE"
  );
}

/** Sanitized, user-facing sentence for a state. Never contains tokens. */
export function describeAccessState(state: YahooAccessState, extra?: string): string {
  const base: Record<YahooAccessState, string> = {
    NOT_CONFIGURED: "Yahoo OAuth is not configured (missing environment variables).",
    STORAGE_UNAVAILABLE:
      "Yahoo OAuth is configured but there is no durable, encrypted token store available.",
    NOT_CONNECTED: "Yahoo OAuth is configured but no Yahoo account has been authorized yet.",
    TOKEN_EXPIRED_OR_INVALID:
      "A Yahoo account was authorized but its token could not be presented or refreshed; re-authorization is required.",
    CONNECTED: "Yahoo OAuth is connected and the token is healthy.",
    FANTASY_API_FORBIDDEN:
      "Yahoo OAuth is connected, but the Fantasy Sports API returned HTTP 403. Application-level Fantasy API access may not yet be provisioned for this Client ID.",
    RATE_LIMITED:
      "Yahoo OAuth is connected, but the Fantasy Sports API is rate-limiting requests (HTTP 429/999). Retry later.",
    NETWORK_ERROR:
      "Yahoo OAuth is connected, but the Fantasy Sports API could not be reached (timeout, transport error, or Yahoo 5xx).",
    MALFORMED_RESPONSE:
      "Yahoo OAuth is connected, but the Fantasy Sports API returned a response that could not be parsed.",
  };
  return extra ? `${base[state]} ${extra}` : base[state];
}

/**
 * Map a failed Fantasy API call to a taxonomy state. Only meaningful once the
 * OAuth connection is known-good (caller must have a healthy session).
 */
export function classifyFantasyApiError(err: unknown): {
  state: YahooAccessState;
  detail: string;
} {
  if (err instanceof YahooApiError) {
    switch (err.kind) {
      case "FORBIDDEN":
        return {
          state: "FANTASY_API_FORBIDDEN",
          detail: sanitize(err),
        };
      case "RATE_LIMITED":
        return { state: "RATE_LIMITED", detail: sanitize(err) };
      case "TIMEOUT":
      case "NETWORK":
      case "SERVER":
        return { state: "NETWORK_ERROR", detail: sanitize(err) };
      case "MALFORMED":
      case "NOT_FOUND":
        return { state: "MALFORMED_RESPONSE", detail: sanitize(err) };
      case "AUTH":
        return { state: "TOKEN_EXPIRED_OR_INVALID", detail: sanitize(err) };
      case "NOT_CONNECTED":
        return { state: "NOT_CONNECTED", detail: sanitize(err) };
    }
  }
  return {
    state: "NETWORK_ERROR",
    detail: `Unexpected Yahoo Fantasy API failure: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** Error text with the resource path + HTTP status only — never a token/header. */
function sanitize(err: YahooApiError): string {
  const parts = [`Yahoo Fantasy API ${err.kind}`];
  if (err.httpStatus != null) parts.push(`(HTTP ${err.httpStatus})`);
  if (err.resourcePath) parts.push(`on ${err.resourcePath}`);
  return parts.join(" ") + ".";
}

/**
 * The connection-level state from a `YahooSession`. Does NOT probe the Fantasy
 * API — the result is `CONNECTED` whenever OAuth is healthy. Callers that want
 * the Fantasy-grant distinction pass a probe error to
 * {@link refineWithFantasyProbe}.
 */
export function accessStateFromSession(session: YahooSession): {
  state: YahooAccessState;
  detail: string;
} {
  switch (session.state) {
    case "NOT_CONFIGURED":
      return { state: "NOT_CONFIGURED", detail: describeAccessState("NOT_CONFIGURED") };
    case "STORAGE_UNAVAILABLE":
      return { state: "STORAGE_UNAVAILABLE", detail: session.detail };
    case "NOT_CONNECTED":
      return { state: "NOT_CONNECTED", detail: describeAccessState("NOT_CONNECTED") };
    case "TOKEN_UNHEALTHY":
      return {
        state: "TOKEN_EXPIRED_OR_INVALID",
        detail: describeAccessState("TOKEN_EXPIRED_OR_INVALID"),
      };
    case "READY":
      return { state: "CONNECTED", detail: describeAccessState("CONNECTED") };
  }
}

/**
 * Combine a connection-level state with the outcome of a Fantasy API probe.
 * `probeError === null` means the probe succeeded.
 */
export function refineWithFantasyProbe(
  connection: { state: YahooAccessState; detail: string },
  probeError: unknown | null,
): { state: YahooAccessState; detail: string } {
  if (!isConnected(connection.state)) return connection; // OAuth not healthy — probe is moot
  if (probeError === null) return { state: "CONNECTED", detail: describeAccessState("CONNECTED") };
  const c = classifyFantasyApiError(probeError);
  return { state: c.state, detail: describeAccessState(c.state, c.detail) };
}
