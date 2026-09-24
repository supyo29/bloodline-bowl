/** Name of the HttpOnly cookie carrying the single-use OAuth CSRF `state`. */
export const YAHOO_STATE_COOKIE = "yahoo_oauth_state";

export interface YahooOAuthStatePayload {
  connection_id: string;
  league_slug: string | null;
  nonce: string;
}

/**
 * Bind the OAuth connection selection into the CSRF state itself. The browser
 * cookie and Yahoo callback must return this exact opaque value, so changing a
 * callback query parameter can never redirect Maclin credentials into primary
 * (Rogers Park), or vice versa.
 */
export function encodeYahooOAuthState(payload: YahooOAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeYahooOAuthState(state: string): YahooOAuthStatePayload | null {
  try {
    const raw = Buffer.from(state, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<YahooOAuthStatePayload>;
    if (
      typeof parsed.connection_id !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(parsed.connection_id) ||
      (parsed.league_slug !== null && typeof parsed.league_slug !== "string") ||
      typeof parsed.nonce !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.nonce)
    ) {
      return null;
    }
    return {
      connection_id: parsed.connection_id,
      league_slug: parsed.league_slug ?? null,
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
}
