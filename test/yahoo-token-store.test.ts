/**
 * SupabaseYahooTokenStore — deterministic, with a fake PostgREST layer.
 *
 * Verifies (without any live Yahoo connection or real DB):
 *   - tokens are written as AES-256-GCM ciphertext, never plaintext;
 *   - a round-trip through the store returns the original token;
 *   - a refresh that rotates the refresh_token is persisted (new ciphertext);
 *   - `last_refreshed_at` / `updated_at` bookkeeping is written.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SupabaseYahooTokenStore } from "../lib/providers/yahoo/token-store";
import type { YahooToken } from "../lib/providers/yahoo/oauth";
import type { SupabaseRest } from "../lib/persistence/supabase/rest";

const ENV = { YAHOO_TOKEN_ENCRYPTION_KEY: "f".repeat(64) } as unknown as NodeJS.ProcessEnv;

/** Minimal in-memory stand-in for the bits of SupabaseRest the store uses. */
class FakeRest {
  rows = new Map<string, Record<string, unknown>>();
  writes: Array<{ op: string; row: Record<string, unknown> }> = [];

  async select<T>(_table: string, opts: { filter?: Record<string, string> }): Promise<T[]> {
    const id = (opts.filter?.connection_id ?? "").replace(/^eq\./, "");
    const row = this.rows.get(id);
    return (row ? [row] : []) as T[];
  }
  async insertIgnoreDuplicates<T>(_t: string, rows: unknown[]): Promise<T[]> {
    const row = rows[0] as Record<string, unknown>;
    const id = row.connection_id as string;
    if (this.rows.has(id)) return [] as T[]; // conflict -> caller will UPDATE
    this.rows.set(id, { ...row });
    this.writes.push({ op: "insert", row });
    return [row] as T[];
  }
  async update(_t: string, filter: Record<string, string>, patch: unknown): Promise<void> {
    const id = (filter.connection_id ?? "").replace(/^eq\./, "");
    this.rows.set(id, { ...(this.rows.get(id) ?? {}), ...(patch as Record<string, unknown>) });
    this.writes.push({ op: "update", row: patch as Record<string, unknown> });
  }
}

function token(over: Partial<YahooToken> = {}): YahooToken {
  return {
    access_token: "PLAINTEXT-ACCESS",
    refresh_token: "PLAINTEXT-REFRESH",
    token_type: "bearer",
    scope: "fspt-r",
    expires_at: Date.now() + 3_600_000,
    yahoo_guid: "GUID",
    ...over,
  };
}

describe("SupabaseYahooTokenStore", () => {
  it("persists ciphertext, not plaintext, and round-trips", async () => {
    const rest = new FakeRest();
    const store = new SupabaseYahooTokenStore(rest as unknown as SupabaseRest, "primary", ENV);

    await store.set(token());

    const stored = rest.rows.get("primary")!;
    assert.ok(typeof stored.access_token_encrypted === "string");
    assert.ok(!(stored.access_token_encrypted as string).includes("PLAINTEXT-ACCESS"));
    assert.ok(!(stored.refresh_token_encrypted as string).includes("PLAINTEXT-REFRESH"));
    assert.equal((stored.access_token_encrypted as string).split(".").length, 3, "iv.tag.ct envelope");
    assert.ok(stored.last_refreshed_at, "bookkeeping written");
    assert.ok(stored.updated_at);

    const back = await store.get();
    assert.equal(back!.access_token, "PLAINTEXT-ACCESS");
    assert.equal(back!.refresh_token, "PLAINTEXT-REFRESH");
    assert.equal(back!.yahoo_guid, "GUID");
  });

  it("a rotated refresh_token is persisted as new ciphertext", async () => {
    const rest = new FakeRest();
    const store = new SupabaseYahooTokenStore(rest as unknown as SupabaseRest, "primary", ENV);
    await store.set(token());
    const first = rest.rows.get("primary")!.refresh_token_encrypted as string;

    await store.set(token({ access_token: "NEW-ACCESS", refresh_token: "ROTATED-REFRESH" }));
    const second = rest.rows.get("primary")!.refresh_token_encrypted as string;

    assert.notEqual(first, second);
    const back = await store.get();
    assert.equal(back!.refresh_token, "ROTATED-REFRESH");
    assert.equal(back!.access_token, "NEW-ACCESS");
  });

  it("clear() blanks the row without a hard delete (audit survivable)", async () => {
    const rest = new FakeRest();
    const store = new SupabaseYahooTokenStore(rest as unknown as SupabaseRest, "primary", ENV);
    await store.set(token());
    await store.clear();
    const back = await store.get();
    // Row still exists; token decrypts to empty; expiry in the past.
    assert.equal(back!.access_token, "");
    assert.ok(back!.expires_at <= Date.now());
    assert.ok(rest.rows.has("primary"));
  });
});
