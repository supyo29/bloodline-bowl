-- W1.P4: projection freshness, source-observation history and final-pregame capture.
--
-- 1) bridge_projection_latest gains the SOURCE observation instant. observed_at keeps meaning "snapshot pointer written/confirmed";
--    source_observed_at means "Bloodline fetched the upstream source state at this instant". They are never interchangeable.
--    Both columns are nullable: legacy rows have no source time and are treated as UNKNOWN (never as the snapshot time).
-- 2) League-INDEPENDENT source observation history (change-only: FULL anchor + DELTA rows) and derived invalidation events.
-- 3) League-scoped final pregame forecasts (calibration evidence).
--
-- RLS enabled with no client policies; bridge server service-role access only.

alter table public.bridge_projection_latest add column if not exists source_observed_at timestamptz;
alter table public.bridge_projection_latest add column if not exists source_observation_id text;

create table if not exists public.bridge_projection_source_observations (
  observation_id       text primary key check (observation_id ~ '^srcobs:[0-9a-f]{20}$'),
  provider             text not null check (char_length(provider) > 0),
  season               integer not null check (season between 2000 and 2100),
  week                 integer not null check (week between 1 and 22),
  observed_at          timestamptz not null,
  content_hash         text not null,
  kind                 text not null check (kind in ('FULL','DELTA')),
  base_observation_id  text references public.bridge_projection_source_observations(observation_id),
  row_count            integer not null check (row_count >= 0),
  changed_count        integer not null check (changed_count >= 0),
  removed_count        integer not null check (removed_count >= 0),
  fetch_path           text not null check (fetch_path in ('LIVE_FETCH','PROCESS_CACHE','MIXED')),
  segments             jsonb not null default '{}'::jsonb,
  format               integer not null check (format = 1),
  recorded_at          timestamptz not null default now()
);
create index if not exists bridge_projection_source_observations_scope_idx
  on public.bridge_projection_source_observations (provider, season, week, observed_at);

create table if not exists public.bridge_projection_source_observation_rows (
  observation_id       text not null references public.bridge_projection_source_observations(observation_id),
  provider_player_id   text not null check (char_length(provider_player_id) > 0),
  player_hash          text not null,
  removed              boolean not null default false,
  row                  jsonb check (row is null or jsonb_typeof(row) = 'object'),
  primary key (observation_id, provider_player_id)
);

create table if not exists public.bridge_projection_source_latest (
  provider             text not null,
  season               integer not null,
  week                 integer not null,
  last_observation_id  text,
  last_observed_at     timestamptz not null,
  last_content_hash    text not null,
  last_full_at         timestamptz,
  updated_at           timestamptz not null default now(),
  primary key (provider, season, week)
);

create table if not exists public.bridge_projection_source_events (
  event_id             text primary key,
  provider             text not null,
  season               integer not null,
  week                 integer not null,
  observation_id       text references public.bridge_projection_source_observations(observation_id),
  type                 text not null,
  scope                jsonb not null,
  effective_at         timestamptz,
  known_at             timestamptz not null,
  source               text not null,
  authority            text not null,
  detail               jsonb not null default '{}'::jsonb
);
create index if not exists bridge_projection_source_events_scope_idx
  on public.bridge_projection_source_events (provider, season, week, known_at);

create table if not exists public.bridge_final_pregame_forecasts (
  league_slug          text not null,
  season               integer not null,
  week                 integer not null,
  canonical_player_id  text not null,
  provider             text not null,
  kickoff_at           timestamptz not null,
  source_observed_at   timestamptz not null,
  confirmed_through    timestamptz not null,
  record               jsonb not null check (jsonb_typeof(record) = 'object'),
  recorded_at          timestamptz not null default now(),
  primary key (league_slug, season, week, canonical_player_id),
  -- the database itself refuses a post-kickoff observation as a pregame forecast
  check (source_observed_at <= kickoff_at),
  check (confirmed_through <= kickoff_at),
  check (confirmed_through >= source_observed_at)
);

alter table public.bridge_projection_source_observations enable row level security;
alter table public.bridge_projection_source_observation_rows enable row level security;
alter table public.bridge_projection_source_latest enable row level security;
alter table public.bridge_projection_source_events enable row level security;
alter table public.bridge_final_pregame_forecasts enable row level security;
