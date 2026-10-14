/**
 * Strict read-only certification credentials. A token store that CANNOT be written: `set` / `clear` throw and are counted, so a refresh that tried to persist a rotated token would
 * fail loudly instead of touching any token state. It holds only a current ACCESS token (no refresh token exists here to leak or rotate). The token is never logged or serialised.
 */
import type { YahooToken, YahooTokenStore } from "./oauth";

export class YahooReadOnlyViolation extends Error {
  constructor(readonly operation: "set" | "clear") { super(`TOKEN_STORE_WRITE_FORBIDDEN: ${operation}() is not allowed in strict read-only mode`); this.name = "YahooReadOnlyViolation"; }
}

export class NoRefreshTokenStore implements YahooTokenStore {
  readonly backend = "read-only-memory";
  #token: YahooToken;
  /** attempted writes (always 0 in a correct run; a non-zero value is a certification failure) */
  writeAttempts = 0;
  constructor(readonly connection_id: string, accessToken: string, expiresAtMs: number) {
    this.#token = { access_token: accessToken, refresh_token: "", token_type: "bearer", scope: "fspt-r", expires_at: expiresAtMs, yahoo_guid: null };
  }
  async get(): Promise<YahooToken | null> { return { ...this.#token }; }
  async set(): Promise<void> { this.writeAttempts += 1; throw new YahooReadOnlyViolation("set"); }
  async clear(): Promise<void> { this.writeAttempts += 1; throw new YahooReadOnlyViolation("clear"); }
  toJSON(): string { return "[NoRefreshTokenStore]"; }
}
