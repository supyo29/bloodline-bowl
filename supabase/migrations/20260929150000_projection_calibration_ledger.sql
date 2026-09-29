-- Projection Calibration Phase 1: durable, append-only calibration ledger.
--
-- Three tables, one concept each:
--   bridge_calibration_nfl_games         authoritative NFL game identity + kickoff (the player-level kickoff rule's clock).
--   bridge_calibration_football_outcomes ONE football reality per (season, week, canonical player): raw stat evidence,
--                                        league-independent. Never duplicated per fantasy league.
--   bridge_calibration_cases             one LEAGUE TRANSLATION per (game, player, league, scoring fingerprint): the exact
--                                        pre-kickoff projection artifact used, the fantasy actual under that league's
--                                        scoring, and the deterministic error. Append-only with explicit revisions.
--
-- Mutation policy: every table is INSERT-ONLY (trigger). A provider correction / late outcome produces a NEW revision of a
-- case (same case_id, new evidence_digest, revision = previous + 1, supersedes_evidence_digest set) -- never an UPDATE and
-- never a duplicate of an identical revision. bridge_calibration_cases_current exposes the latest revision per case_id.
-- Projection evidence is referenced by immutable artifact id + content hash; nothing here can rewrite a past projection.
--
-- RLS on, no policies -> service-role only (same as every bridge_* table). Purely additive; nothing on a production
-- recommendation path reads these tables.
--
-- ROLLBACK (evidence only):
--   drop view if exists public.bridge_calibration_cases_current;
--   drop table if exists public.bridge_calibration_cases;
--   drop table if exists public.bridge_calibration_football_outcomes;
--   drop table if exists public.bridge_calibration_nfl_games;
--   drop function if exists public.bridge_calibration_immutable();

create or replace function public.bridge_calibration_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'bridge_calibration_* rows are immutable (% blocked); corrections are new revisions', tg_op;
end $$;

create table if not exists public.bridge_calibration_nfl_games (
  nfl_game_id      text        not null check (char_length(nfl_game_id) > 0),
  season           integer     not null check (season between 2000 and 2100),
  week             integer     not null check (week between 1 and 22),
  home_team        text        not null,
  away_team        text        not null,
  kickoff_at       timestamptz not null,
  kickoff_source   text        not null,
  status           text        not null,
  provenance       jsonb       not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  observed_at      timestamptz not null default now(),
  primary key (nfl_game_id, kickoff_at, status)
);
create index if not exists bridge_calibration_nfl_games_week_idx on public.bridge_calibration_nfl_games (season, week);

create table if not exists public.bridge_calibration_football_outcomes (
  outcome_id           text primary key check (outcome_id ~ '^fo:[0-9a-f]{24}$'),
  season               integer not null check (season between 2000 and 2100),
  week                 integer not null check (week between 1 and 22),
  nfl_game_id          text,
  canonical_player_id  text not null check (char_length(canonical_player_id) > 0),
  provider_player_ids  jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_player_ids) = 'object'),
  nfl_team             text,
  stat_row_present     boolean not null,
  raw_stats            jsonb   not null default '{}'::jsonb check (jsonb_typeof(raw_stats) = 'object'),
  stats_digest         text    not null check (stats_digest ~ '^[0-9a-f]{16}$'),
  stats_source         text    not null,
  stats_fetched_at     timestamptz not null,
  recorded_at          timestamptz not null default now(),
  constraint bridge_calibration_football_outcomes_unique unique (season, week, canonical_player_id, stats_digest)
);
create index if not exists bridge_calibration_football_outcomes_scope_idx on public.bridge_calibration_football_outcomes (season, week, canonical_player_id);

create table if not exists public.bridge_calibration_cases (
  case_id                     text        not null check (case_id ~ '^cc:[0-9a-f]{24}$'),
  evidence_digest             text        not null check (evidence_digest ~ '^[0-9a-f]{16}$'),
  revision                    integer     not null check (revision >= 1),
  supersedes_evidence_digest  text,
  ledger_version              integer     not null,
  -- identity
  season                      integer     not null check (season between 2000 and 2100),
  week                        integer     not null check (week between 1 and 22),
  nfl_game_id                 text        not null,
  kickoff_at                  timestamptz not null,
  kickoff_source              text        not null,
  canonical_player_id         text        not null check (char_length(canonical_player_id) > 0),
  provider_player_ids         jsonb       not null default '{}'::jsonb,
  player_name                 text,
  nfl_team                    text,
  opponent                    text,
  position                    text,
  league_slug                 text        not null check (char_length(league_slug) > 0),
  provider                    text        not null,
  scoring_fingerprint         text        not null check (char_length(scoring_fingerprint) > 0),
  -- pre-kickoff projection evidence (exact artifact)
  projection_artifact_kind    text        check (projection_artifact_kind in ('PROJECTION_SNAPSHOT', 'STARTSIT_CAPTURE')),
  projection_artifact_id      text,
  projection_content_hash     text,
  projection_request_fingerprint text,
  projection_recorded_at      timestamptz,
  projection_source           text,
  projection_model_version    text,
  projected_points            numeric,
  projected_floor             numeric,
  projected_ceiling           numeric,
  projected_std_dev           numeric,
  expected_availability       numeric,
  injury_status_at_projection text,
  projection_warnings         jsonb       not null default '[]'::jsonb check (jsonb_typeof(projection_warnings) = 'array'),
  projection_scoring_exactness text       check (projection_scoring_exactness in ('LEAGUE_EXACT', 'PROVIDER_STANDARD_APPROXIMATION', 'LEAGUE_EXACT_WITH_UNMAPPED_STATS')),
  projection_selection        jsonb       not null default '{}'::jsonb check (jsonb_typeof(projection_selection) = 'object'),
  -- weather (point-in-time, pre-kickoff only; null when none existed)
  weather_snapshot_id         text,
  weather_evidence            jsonb,
  -- football reality + league translation
  football_outcome_id         text,
  stats_digest                text,
  participation_state         text        not null check (participation_state in
    ('PLAYED_NORMAL', 'PLAYED_LOW_SNAP_SHARE', 'PLAYED_PARTIAL_EXIT', 'DID_NOT_PLAY', 'INACTIVE', 'GAME_POSTPONED_OR_CANCELLED', 'UNKNOWN')),
  actual_fantasy_points       numeric,
  actual_scoring_basis        text,
  actual_scoring_exactness    text        check (actual_scoring_exactness in ('LEAGUE_EXACT', 'PROVIDER_STANDARD_APPROXIMATION', 'LEAGUE_EXACT_WITH_UNMAPPED_STATS')),
  actual_warnings             jsonb       not null default '[]'::jsonb check (jsonb_typeof(actual_warnings) = 'array'),
  -- deterministic calibration math (continuous; no thresholds)
  error                       numeric,
  abs_error                   numeric,
  squared_error               numeric,
  range_status                text        not null check (range_status in ('BELOW_FLOOR', 'INSIDE_RANGE', 'ABOVE_CEILING', 'RANGE_UNAVAILABLE', 'NOT_EVALUATED')),
  below_floor                 boolean,
  inside_projected_range      boolean,
  above_ceiling               boolean,
  -- certification
  evidence_status             text        not null check (evidence_status in
    ('CERTIFIED', 'CERTIFIED_APPROXIMATE_SCORING', 'NO_PREKICKOFF_PROJECTION', 'UNRESOLVED_IDENTITY', 'ACTUAL_SCORING_UNAVAILABLE', 'SCORING_FINGERPRINT_MISMATCH', 'GAME_NOT_PLAYED')),
  evidence_notes              jsonb       not null default '[]'::jsonb check (jsonb_typeof(evidence_notes) = 'array'),
  generated_at                timestamptz not null default now(),
  primary key (case_id, evidence_digest),
  constraint bridge_calibration_cases_revision_unique unique (case_id, revision)
);
create index if not exists bridge_calibration_cases_scope_idx on public.bridge_calibration_cases (season, week, league_slug);
create index if not exists bridge_calibration_cases_player_idx on public.bridge_calibration_cases (canonical_player_id, season, week);
create index if not exists bridge_calibration_cases_artifact_idx on public.bridge_calibration_cases (projection_artifact_id);

create or replace view public.bridge_calibration_cases_current with (security_invoker = true) as
  select distinct on (case_id) *
  from public.bridge_calibration_cases
  order by case_id, revision desc;

drop trigger if exists bridge_calibration_nfl_games_immutable on public.bridge_calibration_nfl_games;
create trigger bridge_calibration_nfl_games_immutable before update or delete on public.bridge_calibration_nfl_games
  for each row execute function public.bridge_calibration_immutable();
drop trigger if exists bridge_calibration_football_outcomes_immutable on public.bridge_calibration_football_outcomes;
create trigger bridge_calibration_football_outcomes_immutable before update or delete on public.bridge_calibration_football_outcomes
  for each row execute function public.bridge_calibration_immutable();
drop trigger if exists bridge_calibration_cases_immutable on public.bridge_calibration_cases;
create trigger bridge_calibration_cases_immutable before update or delete on public.bridge_calibration_cases
  for each row execute function public.bridge_calibration_immutable();

alter table public.bridge_calibration_nfl_games enable row level security;
alter table public.bridge_calibration_football_outcomes enable row level security;
alter table public.bridge_calibration_cases enable row level security;
revoke all on public.bridge_calibration_nfl_games from anon, authenticated;
revoke all on public.bridge_calibration_football_outcomes from anon, authenticated;
revoke all on public.bridge_calibration_cases from anon, authenticated;
revoke all on public.bridge_calibration_cases_current from anon, authenticated;
