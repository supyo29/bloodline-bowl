-- Phase 4 (PREPARED, NOT APPLIED): durable immutable evidence store for Waiver Intelligence 2.0 SHADOW captures.
-- Applying this migration to a database is a separate, explicitly-approved step; Phase 4 certification is read-only.
-- Same integrity philosophy as Phase 3.5A (bridge_startsit_shadow_*): INSERT-only, service-role only, additive, no hot-path reader.
--
-- ROLLBACK (telemetry only):
--   drop table if exists public.bridge_waiver2_shadow_outcomes;
--   drop table if exists public.bridge_waiver2_shadow_captures;
--   drop function if exists public.bridge_waiver2_shadow_immutable();

create or replace function public.bridge_waiver2_shadow_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'bridge_waiver2_shadow_* rows are immutable (% blocked)', tg_op;
end $$;

create table if not exists public.bridge_waiver2_shadow_captures (
  capture_id           text primary key,
  capture_kind         text        not null check (capture_kind in ('LIVE_CAPTURED', 'LIVE_POST_LOCK', 'LIVE_UNVERIFIED', 'HISTORICALLY_RECONSTRUCTED')),
  season               integer     not null,
  week                 integer     not null,
  league_slug          text        not null,
  manager_slug         text        not null,
  scoring_fingerprint  text,
  model_version        text        not null,
  params_hash          text        not null,
  content_hash         text        not null,
  record_schema_version integer    not null,
  record               jsonb       not null,
  captured_at          timestamptz not null default now()
);
create index if not exists bridge_waiver2_shadow_captures_scope_idx on public.bridge_waiver2_shadow_captures (league_slug, manager_slug, season, week);

create table if not exists public.bridge_waiver2_shadow_outcomes (
  capture_id   text        not null references public.bridge_waiver2_shadow_captures (capture_id),
  source       text        not null,
  outcome      jsonb       not null,
  recorded_at  timestamptz not null default now(),
  primary key (capture_id, source)
);

drop trigger if exists bridge_waiver2_shadow_captures_immutable on public.bridge_waiver2_shadow_captures;
create trigger bridge_waiver2_shadow_captures_immutable before update or delete on public.bridge_waiver2_shadow_captures for each row execute function public.bridge_waiver2_shadow_immutable();
drop trigger if exists bridge_waiver2_shadow_outcomes_immutable on public.bridge_waiver2_shadow_outcomes;
create trigger bridge_waiver2_shadow_outcomes_immutable before update or delete on public.bridge_waiver2_shadow_outcomes for each row execute function public.bridge_waiver2_shadow_immutable();

alter table public.bridge_waiver2_shadow_captures enable row level security;
alter table public.bridge_waiver2_shadow_outcomes enable row level security;
