-- Projection Calibration Phase 2: Role & Opportunity calibration evidence (additive, insert-only).
--
--   bridge_role_forecasts             frozen PRE-GAME role forecasts (one football forecast per player-game; league scoring is applied later).
--                                     DB-enforced point-in-time: as_of_at and data_cutoff_at must be strictly before kickoff, and a
--                                     LIVE_CAPTURED row cannot be inserted at/after kickoff. AS_OF_RECONSTRUCTION rows are labeled as such.
--   bridge_role_calibration_analysis  derived join: Phase-1 ledger case (case_id, evidence_digest) x forecast x observed role x exact
--                                     error decomposition x SHADOW_ONLY candidate. Stores keys + derived numbers; does NOT duplicate cases.
--
-- Observed role is not persisted separately: it is a deterministic function of the versioned, committed substrate export
-- (lib/role-calibration/data/observed_role_game.csv) and is embedded in each analysis row.
-- RLS on, no policies -> service-role only. Nothing on a production recommendation path reads these tables.
--
-- ROLLBACK:
--   drop view if exists public.bridge_role_calibration_current;
--   drop table if exists public.bridge_role_calibration_analysis;
--   drop table if exists public.bridge_role_forecasts;
--   drop function if exists public.bridge_role_calibration_immutable();
--   drop function if exists public.bridge_role_forecast_pit_guard();

create or replace function public.bridge_role_calibration_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'bridge_role_* rows are immutable (% blocked); a new forecast/analysis is a new row', tg_op;
end $$;

create table if not exists public.bridge_role_forecasts (
  forecast_id       text primary key check (forecast_id ~ '^rf:[0-9a-f]{24}$'),
  forecast_version  text        not null,
  season            integer     not null check (season between 2000 and 2100),
  week              integer     not null check (week between 1 and 22),
  gsis_id           text,
  sleeper_id        text,
  player_name       text,
  nfl_team          text,
  position          text        not null check (position in ('QB','RB','WR','TE')),
  nfl_game_id       text,
  kickoff_at        timestamptz,
  capture_kind      text        not null check (capture_kind in ('LIVE_CAPTURED','AS_OF_RECONSTRUCTION')),
  as_of_at          timestamptz not null,
  data_cutoff_at    timestamptz,
  data_cutoff_week  integer,
  confidence        text        not null check (confidence in ('MEDIUM','LOW','INSUFFICIENT_SAMPLE')),
  confidence_score  numeric     not null,
  record            jsonb       not null check (jsonb_typeof(record) = 'object' and record->>'forecast_id' = forecast_id),
  recorded_at       timestamptz not null default now(),
  constraint bridge_role_forecasts_key_present check (gsis_id is not null or sleeper_id is not null),
  constraint bridge_role_forecasts_as_of_before_kickoff check (kickoff_at is null or as_of_at < kickoff_at),
  constraint bridge_role_forecasts_cutoff_before_kickoff check (kickoff_at is null or data_cutoff_at is null or data_cutoff_at < kickoff_at)
);
create index if not exists bridge_role_forecasts_scope_idx on public.bridge_role_forecasts (season, week, gsis_id);
create index if not exists bridge_role_forecasts_sleeper_idx on public.bridge_role_forecasts (season, week, sleeper_id);

create or replace function public.bridge_role_forecast_pit_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.capture_kind = 'LIVE_CAPTURED' and new.kickoff_at is not null and now() >= new.kickoff_at then
    raise exception 'LIVE_CAPTURED role forecast rejected: recorded at/after kickoff (%)', new.kickoff_at;
  end if;
  return new;
end $$;
drop trigger if exists bridge_role_forecast_pit_guard on public.bridge_role_forecasts;
create trigger bridge_role_forecast_pit_guard before insert on public.bridge_role_forecasts
  for each row execute function public.bridge_role_forecast_pit_guard();

create table if not exists public.bridge_role_calibration_analysis (
  analysis_id           text primary key check (analysis_id ~ '^ra:[0-9a-f]{24}$'),
  analysis_version      text        not null,
  season                integer     not null check (season between 2000 and 2100),
  week                  integer     not null check (week between 1 and 22),
  case_id               text        not null check (case_id ~ '^cc:[0-9a-f]{24}$'),
  evidence_digest       text        not null,
  forecast_id           text        references public.bridge_role_forecasts(forecast_id),
  league_slug           text        not null,
  scoring_fingerprint   text        not null,
  position              text        not null check (position in ('QB','RB','WR','TE')),
  gsis_id               text,
  record                jsonb       not null check (jsonb_typeof(record) = 'object' and record->>'analysis_id' = analysis_id),
  generated_at          timestamptz not null default now()
);
create index if not exists bridge_role_calibration_analysis_scope_idx on public.bridge_role_calibration_analysis (season, week, league_slug);
create index if not exists bridge_role_calibration_analysis_case_idx on public.bridge_role_calibration_analysis (case_id, generated_at desc);

create or replace view public.bridge_role_calibration_current with (security_invoker = true) as
  select distinct on (case_id) * from public.bridge_role_calibration_analysis order by case_id, generated_at desc;

drop trigger if exists bridge_role_forecasts_immutable on public.bridge_role_forecasts;
create trigger bridge_role_forecasts_immutable before update or delete on public.bridge_role_forecasts
  for each row execute function public.bridge_role_calibration_immutable();
drop trigger if exists bridge_role_calibration_analysis_immutable on public.bridge_role_calibration_analysis;
create trigger bridge_role_calibration_analysis_immutable before update or delete on public.bridge_role_calibration_analysis
  for each row execute function public.bridge_role_calibration_immutable();

alter table public.bridge_role_forecasts enable row level security;
alter table public.bridge_role_calibration_analysis enable row level security;
revoke all on public.bridge_role_forecasts from anon, authenticated;
revoke all on public.bridge_role_calibration_analysis from anon, authenticated;
revoke all on public.bridge_role_calibration_current from anon, authenticated;
