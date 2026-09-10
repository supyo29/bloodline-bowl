/**
 * Yahoo token stores.
 *
 *   SupabaseYahooTokenStore  — production. Row in `public.bridge_yahoo_connections`
 *                              (migration 20260910120000). access/refresh tokens
 *                              are AES-256-GCM ciphertext; the key lives only in
 *                              YAHOO_TOKEN_ENCRYPTION_KEY, never in the DB.
 *   InMemoryYahooTokenStore  — tests / local dev (re-exported from ./oauth).
 *
 * `resolveYahooTokenStore()` picks the store the environment can actually
 * support and reports why when it cannot, so routes never guess.
 */

import { loadSupabaseConfig } from "@/lib/persistence/supabase/rest";
import { SupabaseRest } from "@/lib/persistence/supabase/rest";
import { decryptToken, encryptToken, yahooCryptoStatus } from "./crypto";
import { InMemoryYahooTokenStore, type YahooToken, type YahooTokenStore } from "./oauth";

export { InMemoryYahooTokenStore } from "./oauth";

const TABLE = "bridge_yahoo_connections";

interface ConnectionRow {
  connection_id: string;
  yahoo_guid: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_type: string;
  scope: string | null;
  expires_at: string;
  refresh_seq: number;
}

export class SupabaseYahooTokenStore implements YahooTokenStore {
  readonly backend = "supabase";

  constructor(
    private readonly rest: SupabaseRest,
    private readonly connectionId = "primary",
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async get(): Promise<YahooToken | null> {
    const rows = await this.rest.select<ConnectionRow>(TABLE, {
      filter: { connection_id: `eq.${this.connectionId}` },
      limit: 1,
    });
    const row = rows[0];
    if (!row) return null;
    return {
      access_token: decryptToken(row.access_token_encrypted, this.env),
      refresh_token: decryptToken(row.refresh_token_encrypted, this.env),
      token_type: row.token_type,
      scope: row.scope,
      expires_at: new Date(row.expires_at).getTime(),
      yahoo_guid: row.yahoo_guid,
    };
  }

  async set(token: YahooToken): Promise<void> {
    const now = new Date().toISOString();
    const row = {
      connection_id: this.connectionId,
      yahoo_guid: token.yahoo_guid,
      access_token_encrypted: encryptToken(token.access_token, this.env),
      refresh_token_encrypted: encryptToken(token.refresh_token, this.env),
      token_type: token.token_type,
      scope: token.scope,
      expires_at: new Date(token.expires_at).toISOString(),
      updated_at: now,
      last_refreshed_at: now,
    };
    // Upsert on the primary key. One connection per connection_id.
    await this.rest.insertIgnoreDuplicates(TABLE, [row], ["connection_id"]).then(async (inserted) => {
      if ((inserted as unknown[]).length === 0) {
        await this.rest.update(TABLE, { connection_id: `eq.${this.connectionId}` }, row);
      }
    });
  }

  async clear(): Promise<void> {
    // No hard delete (repo convention: no destructive ops). Blank the row so the
    // connection reads as "not connected" but the audit trail (authorized_at)
    // survives. A re-auth overwrites it.
    await this.rest.update(
      TABLE,
      { connection_id: `eq.${this.connectionId}` },
      {
        access_token_encrypted: encryptToken("", this.env),
        refresh_token_encrypted: encryptToken("", this.env),
        expires_at: new Date(0).toISOString(),
        updated_at: new Date().toISOString(),
      },
    );
  }

  async markUsed(): Promise<void> {
    await this.rest
      .update(TABLE, { connection_id: `eq.${this.connectionId}` }, { last_used_at: new Date().toISOString() })
      .catch(() => {
        /* bookkeeping only */
      });
  }
}

export type YahooTokenStoreResolution =
  | { ok: true; store: YahooTokenStore; durable: boolean }
  | { ok: false; reason: string; missing: string[] };

/**
 * Pick the best available store. Durable (Supabase + encryption key) in
 * production; in-memory only when explicitly allowed for local dev.
 */
export function resolveYahooTokenStore(
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowMemoryFallback?: boolean } = {},
): YahooTokenStoreResolution {
  const supa = loadSupabaseConfig(env);
  const crypto = yahooCryptoStatus(env);

  if (supa.configured && crypto.configured && supa.config) {
    return { ok: true, store: new SupabaseYahooTokenStore(new SupabaseRest(supa.config), "primary", env), durable: true };
  }

  const missing = [...supa.missing, ...crypto.missing];
  if (opts.allowMemoryFallback || env.YAHOO_ALLOW_MEMORY_TOKEN_STORE === "1") {
    return { ok: true, store: new InMemoryYahooTokenStore(), durable: false };
  }
  return {
    ok: false,
    reason:
      "Durable Yahoo token storage is unavailable. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + YAHOO_TOKEN_ENCRYPTION_KEY, " +
      "or set YAHOO_ALLOW_MEMORY_TOKEN_STORE=1 for ephemeral local dev only.",
    missing,
  };
}
