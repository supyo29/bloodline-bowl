-- W1.R1: calibration-grade final-pregame evidence (immutable revisions), hindsight-proof constraints, calibration kind.
--
-- Additive FOLLOW-ON to 20261008120000 (that migration is left byte-for-byte untouched: this repository cannot prove it has not been applied
-- somewhere, and an edited-in-place migration would make history ambiguous).
--
-- 1) bridge_final_pregame_revisions: IMMUTABLE append-only revisions. One row per distinct pre-kickoff forecast CONTENT, holding the complete
--    canonical forecast as composed (contribution ledger, injury semantics, shadow components, bye state, K/DST certification, provenance).
--    The database refuses a post-kickoff composition or observation, and refuses UPDATE/DELETE.
-- 2) bridge_final_pregame_forecasts stays the per-league/week/player final POINTER and gains forecast_id + composed_at.
-- 3) The calibration ledger may now reference a FINAL_PREGAME_FORECAST as its evidence artifact.
-- 4) Privilege hygiene: the W1.P4 + W1.R1 tables are revoked from anon/authenticated (RLS already denies; this removes the default grants).

create table if not exists public.bridge_final_pregame_revisions (
  forecast_id          text primary key check (forecast_id ~ '^fpf:[0-9a-f]{24}$'),
  league_slug          text not null check (char_length(league_slug) > 0),
  season               integer not null check (season between 2000 and 2100),
  week                 integer not null check (week between 1 and 22),
  canonical_player_id  text not null check (char_length(canonical_player_id) > 0),
  provider             text not null,
  kickoff_at           timestamptz not null,
  source_observed_at   timestamptz not null,
  composed_at          timestamptz not null,
  content_signature    text not null check (char_length(content_signature) > 0),
  scoring_fingerprint  text,
  record               jsonb not null check (jsonb_typeof(record) = 'object'),
  recorded_at          timestamptz not null default now(),
  -- no hindsight, enforced by the database: neither the observation nor the COMPOSITION may be at/after kickoff, and the observation
  -- cannot be newer than the composition that used it
  check (source_observed_at <= kickoff_at),
  check (composed_at < kickoff_at),
  check (source_observed_at <= composed_at)
);
-- NOTE: forecast_id is the content address (league/season/week/player/observation/scoring/content), so "the same belief stored once" is the
-- PRIMARY KEY's job. A second UNIQUE index here would be a trap: PostgREST `on_conflict=forecast_id` + ignore-duplicates only suppresses a
-- conflict on THAT target, so a different forecast_id colliding on another unique index would fail the whole insert chunk. This one is lookup-only.
create index if not exists bridge_final_pregame_revisions_belief_idx
  on public.bridge_final_pregame_revisions (league_slug, season, week, canonical_player_id, source_observed_at, content_signature);
create index if not exists bridge_final_pregame_revisions_scope_idx
  on public.bridge_final_pregame_revisions (league_slug, season, week, canonical_player_id, source_observed_at, composed_at);

create or replace function public.bridge_final_pregame_immutable() returns trigger
  language plpgsql as $$
begin
  raise exception 'bridge_final_pregame_revisions rows are immutable (% blocked); a new belief is a new revision', tg_op;
end;
$$;
drop trigger if exists bridge_final_pregame_revisions_immutable on public.bridge_final_pregame_revisions;
create trigger bridge_final_pregame_revisions_immutable before update or delete on public.bridge_final_pregame_revisions
  for each row execute function public.bridge_final_pregame_immutable();

alter table public.bridge_final_pregame_forecasts add column if not exists forecast_id text;
alter table public.bridge_final_pregame_forecasts add column if not exists composed_at timestamptz;
-- rows written before this migration: derive the composition time from the stored record (conservatively: never later than the observation window)
update public.bridge_final_pregame_forecasts
   set composed_at = coalesce(nullif(record->>'recorded_at', '')::timestamptz, confirmed_through)
 where composed_at is null;
-- NOT VALID: pre-existing rows are not retro-checked, every NEW row is
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bridge_final_pregame_forecasts_composed_before_kickoff') then
    alter table public.bridge_final_pregame_forecasts
      add constraint bridge_final_pregame_forecasts_composed_before_kickoff check (composed_at is null or composed_at < kickoff_at) not valid;
  end if;
end $$;

-- calibration ledger: allow the final canonical forecast as the evidence artifact kind
do $$
declare c text;
begin
  if to_regclass('public.bridge_calibration_cases') is not null then
    for c in select conname from pg_constraint
              where conrelid = 'public.bridge_calibration_cases'::regclass and contype = 'c'
                and pg_get_constraintdef(oid) like '%projection_artifact_kind%'
    loop
      execute format('alter table public.bridge_calibration_cases drop constraint %I', c);
    end loop;
    alter table public.bridge_calibration_cases
      add constraint bridge_calibration_cases_projection_artifact_kind_check
      check (projection_artifact_kind in ('PROJECTION_SNAPSHOT', 'STARTSIT_CAPTURE', 'FINAL_PREGAME_FORECAST'));
  end if;
end $$;

alter table public.bridge_final_pregame_revisions enable row level security;
revoke all on table public.bridge_final_pregame_revisions from anon, authenticated;
revoke all on table public.bridge_projection_source_observations from anon, authenticated;
revoke all on table public.bridge_projection_source_observation_rows from anon, authenticated;
revoke all on table public.bridge_projection_source_latest from anon, authenticated;
revoke all on table public.bridge_projection_source_events from anon, authenticated;
revoke all on table public.bridge_final_pregame_forecasts from anon, authenticated;
