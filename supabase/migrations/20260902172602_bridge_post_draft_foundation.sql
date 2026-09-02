-- Post-Draft Foundation: durable persistence for the League Intelligence Bridge.
--
-- Scope: this is a SMALL persistence subsystem for the bloodline-bowl-sleeper-bridge
-- app only. All objects are prefixed `bridge_` to stay clearly isolated from the
-- rest of this shared Roster Intel project. Rows are always scoped to a canonical
-- `league_slug` + `season`. Supabase is an implementation detail behind the
-- SnapshotStore / LedgerStore interfaces in lib/persistence/*.
--
-- Access model: server-side only, via the service-role key. RLS is enabled with
-- NO policies so anon / authenticated roles are denied entirely; the service role
-- bypasses RLS.
--
-- Applied to project ijpfjdzmaztofawhwepf ("Roster Intel") as migration
-- 20260902172602_bridge_post_draft_foundation. This file is the source of truth;
-- the live schema was verified to match it column-for-column, key-for-key.

create table if not exists public.bridge_capture_runs (
  id uuid primary key default gen_random_uuid(),
  league_slug text,
  run_type text not null check (run_type in ('SNAPSHOT', 'TRANSACTION_SYNC')),
  trigger text not null check (trigger in ('CLI', 'CRON', 'API', 'TEST')),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'OK', 'ERROR', 'PARTIAL')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  snapshots_written integer not null default 0,
  transactions_seen integer not null default 0,
  transactions_new integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists bridge_capture_runs_league_idx
  on public.bridge_capture_runs (league_slug, started_at desc);

-- Immutable, versioned historical league snapshots.
-- A later capture NEVER destroys an earlier one: identity includes capture_type
-- and content_hash, and the API chooses a "latest per week" while all captures
-- are retained.
create table if not exists public.bridge_league_snapshots (
  id uuid primary key default gen_random_uuid(),
  league_slug text not null,
  provider text not null,
  season integer not null,
  week integer not null check (week between 0 and 25),
  capture_type text not null default 'AD_HOC'
    check (capture_type in ('PRE_WEEK', 'MID_WEEK', 'FINAL', 'AD_HOC')),
  schema_version integer not null,
  captured_at timestamptz not null default now(),
  provider_synced_at timestamptz,
  content_hash text not null,
  payload jsonb not null,
  capture_run_id uuid references public.bridge_capture_runs (id) on delete set null,
  -- Re-capturing identical content for the same (league, season, week, type) is
  -- a no-op rather than a new row; genuinely changed content lands as a new row.
  unique (league_slug, season, week, capture_type, content_hash)
);

create index if not exists bridge_league_snapshots_lookup_idx
  on public.bridge_league_snapshots (league_slug, season, week, captured_at desc);

-- Block any UPDATE / DELETE: snapshots are write-once historical facts.
create or replace function public.bridge_snapshots_immutable()
  returns trigger language plpgsql as $$
begin
  raise exception 'bridge_league_snapshots rows are immutable (attempted %)', tg_op;
end;
$$;

drop trigger if exists bridge_league_snapshots_no_mutate on public.bridge_league_snapshots;
create trigger bridge_league_snapshots_no_mutate
  before update or delete on public.bridge_league_snapshots
  for each row execute function public.bridge_snapshots_immutable();

-- Append-only, idempotent normalized transaction ledger.
create table if not exists public.bridge_transaction_ledger (
  id uuid primary key default gen_random_uuid(),
  league_slug text not null,
  provider text not null,
  season integer not null,
  fantasy_week integer,
  provider_transaction_id text not null,
  canonical_transaction_id text not null,
  transaction_type text not null,
  status text,
  provider_timestamp timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  managers jsonb not null default '[]'::jsonb,
  players_added jsonb not null default '[]'::jsonb,
  players_dropped jsonb not null default '[]'::jsonb,
  players_traded jsonb not null default '[]'::jsonb,
  faab jsonb,
  payload jsonb not null,
  source_metadata jsonb not null default '{}'::jsonb,
  -- Idempotency: a provider transaction is recorded exactly once per league+season.
  unique (league_slug, season, provider, provider_transaction_id)
);

create index if not exists bridge_transaction_ledger_lookup_idx
  on public.bridge_transaction_ledger (league_slug, season, fantasy_week);
create index if not exists bridge_transaction_ledger_type_idx
  on public.bridge_transaction_ledger (league_slug, season, transaction_type);

-- RLS on, no policies: server/service-role only.
alter table public.bridge_capture_runs enable row level security;
alter table public.bridge_league_snapshots enable row level security;
alter table public.bridge_transaction_ledger enable row level security;

comment on table public.bridge_league_snapshots is
  'Immutable versioned historical league snapshots for the Sleeper/Yahoo bridge. Scoped by league_slug+season+week. Written server-side only.';
comment on table public.bridge_transaction_ledger is
  'Append-only idempotent normalized transaction ledger for the bridge. Unique on (league_slug, season, provider, provider_transaction_id).';
comment on table public.bridge_capture_runs is
  'Capture/sync run metadata for bridge snapshot + transaction jobs.';
