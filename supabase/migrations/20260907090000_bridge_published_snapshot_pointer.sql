-- Bridge Real-Time State (Stage B): authoritative published-snapshot pointer.
--
-- Scope: ONE row per (league_slug, season) naming the immutable
-- bridge_league_snapshots row that has been CERTIFIED and PUBLISHED as the
-- current league reality. This table does NOT duplicate the snapshot payload —
-- bridge_league_snapshots remains the source of truth for content.
--
-- Why a durable table and not just Next.js tagged caching: on Vercel's
-- multi-instance serverless model, `revalidateTag` purges cache entries but
-- offers no compare-and-set and no gate on what repopulates them. "Never advance
-- the pointer before certification succeeds" and "concurrent publishers must not
-- corrupt the pointer" require an atomic conditional UPDATE, which Postgres
-- provides directly. The app reads this pointer through a short per-instance
-- cache; authority always lives in this row.
--
-- Atomicity: lib/persistence/supabase/published-pointer.ts advances the pointer
-- with a single filtered PATCH
--   UPDATE bridge_published_snapshot
--      SET ..., published_seq = published_seq + 1
--    WHERE league_slug = $1 AND season = $2 AND published_seq = $observed;
-- Exactly one concurrent writer matches the row; the loser updates zero rows and
-- reports `raced`. First publication is a conflict-safe insert on the PK.
--
-- Access model: RLS enabled, NO policies — service-role only, same as the other
-- bridge_* tables.
--
-- Applied to project ijpfjdzmaztofawhwepf ("Roster Intel").
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (safe — no other object depends on this table; unset
-- BRIDGE_PUBLISHED_SNAPSHOT first so nothing reads the pointer):
--   drop table if exists public.bridge_published_snapshot;
-- ---------------------------------------------------------------------------

create table if not exists public.bridge_published_snapshot (
  league_slug               text    not null,
  season                    integer not null,
  -- FK to the immutable snapshot this pointer certifies as current.
  snapshot_id               uuid    not null
    references public.bridge_league_snapshots (id) on delete restrict,
  -- Deterministic content-addressed id (snap:<slug>:<season>:wNN:<hash16>).
  league_snapshot_id        text    not null,
  content_hash              text    not null,
  week                      integer not null check (week between 0 and 25),
  -- Monotonic guard for atomic advance. Starts at 1 on first publication.
  published_seq             bigint  not null default 1 check (published_seq > 0),
  -- Always true: the pointer is only ever moved past a passing certification.
  certified                 boolean not null default true,
  source_provider_synced_at timestamptz,
  published_at              timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  schema_version            integer not null,
  primary key (league_slug, season)
);

create index if not exists bridge_published_snapshot_snapshot_idx
  on public.bridge_published_snapshot (snapshot_id);

alter table public.bridge_published_snapshot enable row level security;

comment on table public.bridge_published_snapshot is
  'Authoritative pointer: which certified bridge_league_snapshots row is the currently published league reality, one per (league_slug, season). Advanced atomically via a published_seq-guarded UPDATE. Not a payload copy.';
