-- Phase 5: durable immutable evidence store for Matchup Intelligence 2.0 prospective SHADOW captures (record schema v1).
--
-- bridge_matchup2_shadow_captures : one row per capture. Identity = capture_id (deterministic content hash of the DECISION context; read times,
--   provenance and request ids are excluded). INSERT-only: UPDATE and DELETE are rejected by trigger.
--   CHECK constraints make the store itself refuse inconsistent evidence classes:
--     * LIVE_CAPTURED requires a PRE_KICKOFF_VERIFIED lock AND a baseline projection;
--     * LIVE_POST_LOCK requires a POST_LOCK verdict; ILLUSTRATIVE is never storable;
--     * the record must be SHADOW_ONLY and may not influence production.
-- bridge_matchup2_shadow_outcomes : later outcomes keyed to a capture (FK => an orphan outcome is rejected), also INSERT-only.
--
-- RLS on with NO policies (service-role only, like every bridge_* table); all privileges revoked from anon/authenticated.
-- Nothing reads these tables on a ranking path. Purely additive.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (telemetry only -- safe):
--   drop table if exists public.bridge_matchup2_shadow_outcomes;
--   drop table if exists public.bridge_matchup2_shadow_captures;
--   drop function if exists public.bridge_matchup2_shadow_immutable();
-- ---------------------------------------------------------------------------

create or replace function public.bridge_matchup2_shadow_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'bridge_matchup2_shadow_* rows are immutable (% blocked)', tg_op;
end $$;

create table if not exists public.bridge_matchup2_shadow_captures (
  capture_id            text primary key check (capture_id ~ '^m2cap:[0-9a-f]{16}$'),
  capture_class         text        not null check (capture_class in
    ('LIVE_CAPTURED', 'LIVE_POST_LOCK', 'LIVE_UNVERIFIED', 'HISTORICALLY_RECONSTRUCTED')),
  season                integer     not null,
  week                  integer     not null,
  player_gsis_id        text        not null,
  position              text        not null check (position in ('QB', 'RB', 'WR', 'TE')),
  offense_team          text,
  defense_team          text        not null,
  model_version         text        not null,
  lifecycle_state       text        not null check (lifecycle_state = 'SHADOW_ONLY'),
  context_identity      text        not null,
  scoring_fingerprint   text,
  has_baseline          boolean     not null,
  lock_verdict          text,
  content_hash          text        not null,
  record_schema_version integer     not null,
  record                jsonb       not null check (jsonb_typeof(record) = 'object' and record->>'capture_id' = capture_id and (record->>'may_influence_production') = 'false'),
  captured_at           timestamptz not null default now(),
  constraint bridge_matchup2_live_captured_requires_lock_and_baseline check
    (capture_class <> 'LIVE_CAPTURED' or (lock_verdict = 'PRE_KICKOFF_VERIFIED' and has_baseline)),
  constraint bridge_matchup2_post_lock_requires_verdict check
    (capture_class <> 'LIVE_POST_LOCK' or lock_verdict = 'POST_LOCK')
);
create index if not exists bridge_matchup2_shadow_captures_scope_idx on public.bridge_matchup2_shadow_captures (season, week, player_gsis_id);
create index if not exists bridge_matchup2_shadow_captures_class_idx on public.bridge_matchup2_shadow_captures (capture_class, season, week);

create table if not exists public.bridge_matchup2_shadow_outcomes (
  capture_id   text        not null references public.bridge_matchup2_shadow_captures (capture_id),
  source       text        not null,
  outcome      jsonb       not null,
  recorded_at  timestamptz not null default now(),
  primary key (capture_id, source)
);

drop trigger if exists bridge_matchup2_shadow_captures_immutable on public.bridge_matchup2_shadow_captures;
create trigger bridge_matchup2_shadow_captures_immutable before update or delete on public.bridge_matchup2_shadow_captures
  for each row execute function public.bridge_matchup2_shadow_immutable();
drop trigger if exists bridge_matchup2_shadow_outcomes_immutable on public.bridge_matchup2_shadow_outcomes;
create trigger bridge_matchup2_shadow_outcomes_immutable before update or delete on public.bridge_matchup2_shadow_outcomes
  for each row execute function public.bridge_matchup2_shadow_immutable();

alter table public.bridge_matchup2_shadow_captures enable row level security;
alter table public.bridge_matchup2_shadow_outcomes enable row level security;
revoke all on public.bridge_matchup2_shadow_captures from anon, authenticated;
revoke all on public.bridge_matchup2_shadow_outcomes from anon, authenticated;
