-- Bridge Real-Time State (Stage E): publication-attempt audit trail.
--
-- One row per attempt to publish a certified snapshot (via POST /api/refresh or
-- the /api/cron/publish scheduler). NOT on any read path — deep health and
-- operators read the latest / recent rows to answer "can I trust the published
-- snapshot right now, and what happened on the last refresh?".
--
-- Append-only in practice (the store has no UPDATE path). RLS on, no policies —
-- service-role only, same as every other bridge_* table.
--
-- Applied to project ijpfjdzmaztofawhwepf.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (safe — nothing reads this table on a hot path):
--   drop table if exists public.bridge_publication_audit;
-- ---------------------------------------------------------------------------

create table if not exists public.bridge_publication_audit (
  id                     uuid primary key default gen_random_uuid(),
  league_slug            text    not null,
  season                 integer not null,
  trigger                text    not null check (trigger in ('API', 'CRON', 'CLI', 'TEST')),
  attempted_at           timestamptz not null default now(),
  finished_at            timestamptz,
  duration_ms            integer,
  outcome                text    not null,
  ok                     boolean not null,
  candidate_snapshot_id  text,
  candidate_content_hash text,
  prior_pointer_seq      bigint,
  resulting_pointer_seq  bigint,
  pointer_advanced       boolean not null default false,
  snapshot_persisted     text    not null default 'not_attempted'
    check (snapshot_persisted in ('created', 'duplicate', 'error', 'skipped', 'not_attempted')),
  integrity              text    check (integrity in ('CERTIFIED', 'REJECTED')),
  validation_detail      text,
  source_status          text,
  error_category         text,
  error                  text
);

create index if not exists bridge_publication_audit_lookup_idx
  on public.bridge_publication_audit (league_slug, season, attempted_at desc);

alter table public.bridge_publication_audit enable row level security;

comment on table public.bridge_publication_audit is
  'Stage E publication-attempt audit trail: what was tried, whether it certified, whether the pointer advanced, and why not when it did not. Append-only, service-role only, off the read path.';
