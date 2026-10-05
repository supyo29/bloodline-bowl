-- Projection Calibration Phase 3: game environment, weather, and player outcome distributions (additive, insert-only, SHADOW_ONLY).
--
--   bridge_game_weather_forecasts          point-in-time NWS forecast snapshots (retrieved strictly before kickoff; DB-enforced). The legacy
--                                          nfl_game_weather_snapshots table holds 0 pregame-valid rows and is left untouched.
--   bridge_game_environment_forecasts      per-game pregame environment: team volume distributions, script scenarios, FI context, regime flags, weather pointer.
--   bridge_player_distribution_forecasts   per player-game football-level outcome distribution (deterministic: model version + seed reproduce the simulation)
--                                          with fantasy-point distributions per known scoring fingerprint.
--   bridge_distribution_calibration_analysis  derived: Phase-1 ledger case x distributions (models A/B/C/D) x actual x proper scores; keys + derived numbers only.
--
-- DB-enforced point-in-time on every pregame table: as_of/retrieved/cutoff strictly before kickoff; a LIVE_CAPTURED row cannot be inserted at/after kickoff.
-- RLS on, no policies -> service-role only. Nothing on a production recommendation path reads these tables.
--
-- ROLLBACK:
--   drop view if exists public.bridge_distribution_calibration_current;
--   drop table if exists public.bridge_distribution_calibration_analysis, public.bridge_player_distribution_forecasts,
--                        public.bridge_game_environment_forecasts, public.bridge_game_weather_forecasts;
--   drop function if exists public.bridge_game_dist_immutable(); drop function if exists public.bridge_game_dist_pit_guard();

create or replace function public.bridge_game_dist_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'bridge game-distribution rows are immutable (% blocked); a new forecast/analysis is a new row', tg_op;
end $$;

create or replace function public.bridge_game_dist_pit_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'bridge_game_weather_forecasts' then
    if now() >= new.kickoff_at then raise exception 'weather snapshot rejected: recorded at/after kickoff (%)', new.kickoff_at; end if;
  elsif new.capture_kind = 'LIVE_CAPTURED' and now() >= new.kickoff_at then
    raise exception 'LIVE_CAPTURED forecast rejected: recorded at/after kickoff (%)', new.kickoff_at;
  end if;
  return new;
end $$;

create table if not exists public.bridge_game_weather_forecasts (
  snapshot_id          text primary key check (snapshot_id ~ '^gw:[0-9a-f]{24}$'),
  season               integer     not null check (season between 2000 and 2100),
  week                 integer     not null check (week between 1 and 22),
  nfl_game_id          text        not null,
  home_team            text        not null,
  away_team            text        not null,
  kickoff_at           timestamptz not null,
  stadium              text,
  latitude             numeric,
  longitude            numeric,
  roof_type            text        not null check (roof_type in ('dome','retractable','outdoor')),
  roof_status          text        check (roof_status is null or roof_status in ('open','closed')),
  source               text        not null,
  source_url           text,
  forecast_issued_at   timestamptz,
  retrieved_at         timestamptz not null,
  hours_to_kickoff     numeric     not null,
  temp_f               numeric,
  wind_mph             numeric,
  wind_gust_mph        numeric,
  precip_prob          numeric,
  precip_mm            numeric,
  short_forecast       text,
  risk_class           text        not null check (risk_class in ('DOME_CONTROLLED','LOW','MODERATE','HIGH','UNKNOWN')),
  risk_score           numeric,
  flags                jsonb       not null default '[]'::jsonb check (jsonb_typeof(flags) = 'array'),
  raw                  jsonb       not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),
  recorded_at          timestamptz not null default now(),
  constraint bridge_game_weather_retrieved_before_kickoff check (retrieved_at < kickoff_at),
  constraint bridge_game_weather_issued_before_kickoff check (forecast_issued_at is null or forecast_issued_at < kickoff_at)
);
create index if not exists bridge_game_weather_game_idx on public.bridge_game_weather_forecasts (nfl_game_id, retrieved_at desc);
create index if not exists bridge_game_weather_scope_idx on public.bridge_game_weather_forecasts (season, week);

create table if not exists public.bridge_game_environment_forecasts (
  env_id               text primary key check (env_id ~ '^ge:[0-9a-f]{24}$'),
  model_version        text        not null,
  season               integer     not null check (season between 2000 and 2100),
  week                 integer     not null check (week between 1 and 22),
  nfl_game_id          text        not null,
  home_team            text        not null,
  away_team            text        not null,
  kickoff_at           timestamptz not null,
  capture_kind         text        not null check (capture_kind in ('LIVE_CAPTURED','AS_OF_RECONSTRUCTION')),
  as_of_at             timestamptz not null,
  data_cutoff_at       timestamptz,
  weather_snapshot_id  text        references public.bridge_game_weather_forecasts(snapshot_id),
  confidence           text        not null check (confidence in ('MEDIUM','LOW','INSUFFICIENT_SAMPLE')),
  record               jsonb       not null check (jsonb_typeof(record) = 'object' and record->>'env_id' = env_id),
  recorded_at          timestamptz not null default now(),
  constraint bridge_game_env_as_of_before_kickoff check (as_of_at < kickoff_at),
  constraint bridge_game_env_cutoff_before_kickoff check (data_cutoff_at is null or data_cutoff_at < kickoff_at)
);
create index if not exists bridge_game_env_scope_idx on public.bridge_game_environment_forecasts (season, week, nfl_game_id);

create table if not exists public.bridge_player_distribution_forecasts (
  pd_id                text primary key check (pd_id ~ '^pd:[0-9a-f]{24}$'),
  model_version        text        not null,
  season               integer     not null check (season between 2000 and 2100),
  week                 integer     not null check (week between 1 and 22),
  gsis_id              text,
  sleeper_id           text,
  position             text        not null check (position in ('QB','RB','WR','TE')),
  nfl_game_id          text        not null,
  kickoff_at           timestamptz not null,
  capture_kind         text        not null check (capture_kind in ('LIVE_CAPTURED','AS_OF_RECONSTRUCTION')),
  as_of_at             timestamptz not null,
  role_forecast_id     text        references public.bridge_role_forecasts(forecast_id),
  env_id               text        references public.bridge_game_environment_forecasts(env_id),
  confidence           text        not null check (confidence in ('MEDIUM','LOW','INSUFFICIENT_SAMPLE')),
  sims                 integer     not null check (sims > 0),
  seed                 bigint      not null,
  record               jsonb       not null check (jsonb_typeof(record) = 'object' and record->>'pd_id' = pd_id),
  recorded_at          timestamptz not null default now(),
  constraint bridge_player_dist_key_present check (gsis_id is not null or sleeper_id is not null),
  constraint bridge_player_dist_as_of_before_kickoff check (as_of_at < kickoff_at)
);
create index if not exists bridge_player_dist_scope_idx on public.bridge_player_distribution_forecasts (season, week, gsis_id);
create index if not exists bridge_player_dist_sleeper_idx on public.bridge_player_distribution_forecasts (season, week, sleeper_id);

create table if not exists public.bridge_distribution_calibration_analysis (
  da_id                text primary key check (da_id ~ '^da:[0-9a-f]{24}$'),
  model_version        text        not null,
  season               integer     not null check (season between 2000 and 2100),
  week                 integer     not null check (week between 1 and 22),
  case_id              text        not null check (case_id ~ '^cc:[0-9a-f]{24}$'),
  evidence_digest      text        not null,
  pd_id                text        references public.bridge_player_distribution_forecasts(pd_id),
  league_slug          text        not null,
  scoring_fingerprint  text        not null,
  position             text        not null check (position in ('QB','RB','WR','TE')),
  gsis_id              text,
  record               jsonb       not null check (jsonb_typeof(record) = 'object' and record->>'da_id' = da_id),
  generated_at         timestamptz not null default now()
);
create index if not exists bridge_dist_analysis_scope_idx on public.bridge_distribution_calibration_analysis (season, week, league_slug);
create index if not exists bridge_dist_analysis_case_idx on public.bridge_distribution_calibration_analysis (case_id, generated_at desc);
create or replace view public.bridge_distribution_calibration_current with (security_invoker = true) as
  select distinct on (case_id) * from public.bridge_distribution_calibration_analysis order by case_id, generated_at desc;

do $$ declare t text; begin
  foreach t in array array['bridge_game_weather_forecasts','bridge_game_environment_forecasts','bridge_player_distribution_forecasts','bridge_distribution_calibration_analysis'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_immutable', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.bridge_game_dist_immutable()', t || '_immutable', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  foreach t in array array['bridge_game_weather_forecasts','bridge_game_environment_forecasts','bridge_player_distribution_forecasts'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_pit_guard', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.bridge_game_dist_pit_guard()', t || '_pit_guard', t);
  end loop;
end $$;
revoke all on public.bridge_distribution_calibration_current from anon, authenticated;
