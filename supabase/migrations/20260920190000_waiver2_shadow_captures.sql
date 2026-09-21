-- Phase 4: durable immutable evidence store for Waiver Intelligence 2.0 prospective SHADOW captures (record schema v2).
--
-- bridge_waiver2_shadow_captures : one row per capture. Identity = capture_id (deterministic content hash).
--   INSERT-only: UPDATE and DELETE are rejected by trigger, so a captured decision can never be rewritten.
--   CHECK constraints make the store itself refuse inconsistent evidence classes:
--     * a LIVE_* class requires a CERTIFIED pool (an uncertified pool can only be NOT_ACTIONABLE / ILLUSTRATIVE);
--     * POOL_READINESS_BLOCKED rows must be NOT_ACTIONABLE; NOT_ACTIONABLE rows must be POOL_READINESS_BLOCKED;
--     * LIVE_CAPTURED requires a PRE_KICKOFF_VERIFIED lock; the lifecycle state may never be recorded as PRODUCTION_ACTIVE here.
-- bridge_waiver2_shadow_outcomes : later outcomes, keyed to a capture (FK => an orphan outcome is rejected), also INSERT-only.
--
-- RLS on with NO policies (service-role only, like every bridge_* table) and all privileges revoked from anon/authenticated.
-- Nothing reads these tables on a ranking path. Purely additive; no production recommendation depends on them.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (telemetry only -- safe):
--   drop table if exists public.bridge_waiver2_shadow_outcomes;
--   drop table if exists public.bridge_waiver2_shadow_captures;
--   drop function if exists public.bridge_waiver2_shadow_immutable();
-- ---------------------------------------------------------------------------

create or replace function public.bridge_waiver2_shadow_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'bridge_waiver2_shadow_* rows are immutable (% blocked)', tg_op;
end $$;

create table if not exists public.bridge_waiver2_shadow_captures (
  capture_id            text primary key,
  capture_class         text        not null check (capture_class in
    ('LIVE_CAPTURED', 'LIVE_POST_LOCK', 'LIVE_UNVERIFIED', 'HISTORICALLY_RECONSTRUCTED', 'ILLUSTRATIVE', 'NOT_ACTIONABLE')),
  record_type           text        not null check (record_type in ('RANKED_ACTIONS', 'POOL_READINESS_BLOCKED')),
  season                integer     not null,
  week                  integer     not null,
  league_slug           text        not null,
  manager_slug          text        not null,
  scoring_fingerprint   text,
  model_version         text        not null,
  lifecycle_state       text        not null check (lifecycle_state in
    ('SHADOW_ONLY', 'RESEARCH_ELIGIBLE', 'CERTIFICATION_PASSED', 'PRODUCTION_ELIGIBLE', 'SUSPENDED_ROLLED_BACK')),
  params_hash           text        not null,
  snapshot_id           text,
  pool_certification    text        not null,
  lock_verdict          text,
  content_hash          text        not null,
  record_schema_version integer     not null,
  record                jsonb       not null,
  captured_at           timestamptz not null default now(),
  constraint bridge_waiver2_live_requires_certified_pool check
    (capture_class not in ('LIVE_CAPTURED', 'LIVE_POST_LOCK', 'LIVE_UNVERIFIED') or pool_certification = 'CERTIFIED'),
  constraint bridge_waiver2_blocked_is_not_actionable check
    ((record_type = 'POOL_READINESS_BLOCKED') = (capture_class = 'NOT_ACTIONABLE')),
  constraint bridge_waiver2_live_captured_requires_lock check
    (capture_class <> 'LIVE_CAPTURED' or lock_verdict = 'PRE_KICKOFF_VERIFIED')
);
create index if not exists bridge_waiver2_shadow_captures_scope_idx on public.bridge_waiver2_shadow_captures (league_slug, manager_slug, season, week);
create index if not exists bridge_waiver2_shadow_captures_class_idx on public.bridge_waiver2_shadow_captures (capture_class, season, week);

create table if not exists public.bridge_waiver2_shadow_outcomes (
  capture_id   text        not null references public.bridge_waiver2_shadow_captures (capture_id),
  source       text        not null,
  outcome      jsonb       not null,
  recorded_at  timestamptz not null default now(),
  primary key (capture_id, source)
);

drop trigger if exists bridge_waiver2_shadow_captures_immutable on public.bridge_waiver2_shadow_captures;
create trigger bridge_waiver2_shadow_captures_immutable before update or delete on public.bridge_waiver2_shadow_captures
  for each row execute function public.bridge_waiver2_shadow_immutable();
drop trigger if exists bridge_waiver2_shadow_outcomes_immutable on public.bridge_waiver2_shadow_outcomes;
create trigger bridge_waiver2_shadow_outcomes_immutable before update or delete on public.bridge_waiver2_shadow_outcomes
  for each row execute function public.bridge_waiver2_shadow_immutable();

alter table public.bridge_waiver2_shadow_captures enable row level security;
alter table public.bridge_waiver2_shadow_outcomes enable row level security;
revoke all on public.bridge_waiver2_shadow_captures from anon, authenticated;
revoke all on public.bridge_waiver2_shadow_outcomes from anon, authenticated;
