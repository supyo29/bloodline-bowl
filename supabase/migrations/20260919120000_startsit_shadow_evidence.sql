-- Phase 3.5A: durable, immutable evidence store for the Start/Sit Football-Intelligence SHADOW model.
--
-- bridge_startsit_shadow_captures : one row per material shadow decision. Identity = capture_id
--   (deterministic hash of the decision context + content + capture class). INSERT-only: UPDATE and
--   DELETE are rejected by trigger, so a captured pre-kickoff decision can never be rewritten.
-- bridge_startsit_shadow_outcomes : later enrichment (actual fantasy points), keyed to the capture,
--   also INSERT-only. Outcomes never touch the decision row.
--
-- RLS on, no policies -> service-role only (same as every other bridge_* table). Nothing reads these
-- tables on a hot path. Purely additive; no production recommendation depends on them.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (safe -- telemetry only):
--   drop table if exists public.bridge_startsit_shadow_outcomes;
--   drop table if exists public.bridge_startsit_shadow_captures;
--   drop function if exists public.bridge_startsit_shadow_immutable();
-- ---------------------------------------------------------------------------

create or replace function public.bridge_startsit_shadow_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'bridge_startsit_shadow_* rows are immutable (% blocked)', tg_op;
end $$;

create table if not exists public.bridge_startsit_shadow_captures (
  capture_id                   text primary key,
  capture_kind                 text        not null check (capture_kind in
    ('LIVE_CAPTURED', 'LIVE_POST_LOCK', 'LIVE_UNVERIFIED', 'HISTORICALLY_RECONSTRUCTED')),
  season                       integer     not null,
  week                         integer     not null,
  league_slug                  text        not null,
  manager_slug                 text        not null,
  scoring_fingerprint          text,
  start_sit_model_version      text        not null,
  football_intelligence_version text,
  baseline_projection_version  text        not null,
  decision_timestamp           timestamptz not null,
  content_hash                 text        not null,
  record_schema_version        integer     not null,
  lock_verdict                 text,
  record                       jsonb       not null,
  captured_at                  timestamptz not null default now()
);

create index if not exists bridge_startsit_shadow_captures_lookup_idx
  on public.bridge_startsit_shadow_captures (season, week, capture_kind);
create index if not exists bridge_startsit_shadow_captures_scope_idx
  on public.bridge_startsit_shadow_captures (league_slug, manager_slug, season, week);

create table if not exists public.bridge_startsit_shadow_outcomes (
  capture_id          text        not null references public.bridge_startsit_shadow_captures (capture_id),
  source              text        not null,
  scoring_fingerprint text,
  actual_fantasy_points jsonb     not null,
  recorded_at         timestamptz not null default now(),
  primary key (capture_id, source)
);

drop trigger if exists bridge_startsit_shadow_captures_immutable on public.bridge_startsit_shadow_captures;
create trigger bridge_startsit_shadow_captures_immutable
  before update or delete on public.bridge_startsit_shadow_captures
  for each row execute function public.bridge_startsit_shadow_immutable();

drop trigger if exists bridge_startsit_shadow_outcomes_immutable on public.bridge_startsit_shadow_outcomes;
create trigger bridge_startsit_shadow_outcomes_immutable
  before update or delete on public.bridge_startsit_shadow_outcomes
  for each row execute function public.bridge_startsit_shadow_immutable();

alter table public.bridge_startsit_shadow_captures enable row level security;
alter table public.bridge_startsit_shadow_outcomes enable row level security;

comment on table public.bridge_startsit_shadow_captures is
  'Phase 3.5A immutable Start/Sit FI shadow-decision evidence. INSERT-only (trigger). capture_kind separates verified pre-kickoff live evidence from post-lock / unverified / reconstructed.';
comment on table public.bridge_startsit_shadow_outcomes is
  'Phase 3.5A outcome enrichment for shadow captures. INSERT-only; never rewrites the decision.';
