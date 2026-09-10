-- Yahoo Fantasy OAuth: durable, encrypted token storage for the bridge.
--
-- Scope: one more `bridge_`-prefixed table in the small bridge persistence
-- subsystem (see 20260902172602_bridge_post_draft_foundation.sql). Server-side
-- only, via the service-role key. RLS is enabled with NO policies, so anon /
-- authenticated roles are denied entirely; the service role bypasses RLS.
--
-- What is stored:
--   * access_token / refresh_token — AES-256-GCM ciphertext ONLY. The plaintext
--     never touches Postgres. Encryption/decryption happens in the app
--     (lib/providers/yahoo/crypto.ts) with YAHOO_TOKEN_ENCRYPTION_KEY, which is
--     NOT in the database. A database leak alone does not expose a usable token.
--   * yahoo_guid — the authorized Yahoo account's opaque id (not a secret, but
--     also not sensitive PII); used to key the connection and to attribute
--     discovered leagues.
--   * expiry + bookkeeping timestamps — non-secret operational metadata.
--
-- Model: ONE Yahoo connection per authorized account. `connection_id` is a
-- stable app-chosen slug (default 'primary') so a second Yahoo account can be
-- authorized later (Rogers Park vs a friend's Maclin-on-Chick's account) without
-- a schema change.
--
-- Applied to project ijpfjdzmaztofawhwepf ("Roster Intel").
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (safe — only the Yahoo OAuth flow reads this; Sleeper is untouched):
--   drop table if exists public.bridge_yahoo_connections;
-- ---------------------------------------------------------------------------

create table if not exists public.bridge_yahoo_connections (
  connection_id            text primary key default 'primary',
  yahoo_guid               text,
  -- AES-256-GCM. Format: base64(iv).base64(authTag).base64(ciphertext).
  access_token_encrypted   text not null,
  refresh_token_encrypted  text not null,
  token_type               text not null default 'bearer',
  scope                    text,
  -- When the access token expires. Refresh is triggered well before this.
  expires_at               timestamptz not null,
  -- Non-secret provenance.
  authorized_at            timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  last_refreshed_at        timestamptz,
  last_used_at             timestamptz,
  -- Optimistic-concurrency guard for token rotation across instances.
  refresh_seq              bigint not null default 0
);

comment on table public.bridge_yahoo_connections is
  'Yahoo Fantasy OAuth connections for the bridge. Tokens are AES-256-GCM ciphertext; the key (YAHOO_TOKEN_ENCRYPTION_KEY) lives only in the app env, never here. Service-role only.';

alter table public.bridge_yahoo_connections enable row level security;
