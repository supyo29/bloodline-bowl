-- W1.R1 real-Postgres compatibility assertions for the W1.P4 + W1.R1 migrations. Run by scripts/w1r1-pg-compat.sh against a THROWAWAY local cluster.
-- Every block raises (and psql exits non-zero, ON_ERROR_STOP) if reality disagrees with what the TypeScript stores assume.
\set ON_ERROR_STOP 1
\pset pager off
\pset tuples_only on

create or replace function pg_temp.expect_sqlstate(stmt text, expected text, label text) returns void language plpgsql as $$
declare got text;
begin
  begin execute stmt; got := 'NO_ERROR';
  exception when others then got := sqlstate; end;
  if got is distinct from expected then raise exception 'ASSERT FAILED [%]: expected SQLSTATE % but got % for: %', label, expected, got, left(stmt, 160); end if;
end $$;
create or replace function pg_temp.expect_rows(stmt text, expected int, label text) returns void language plpgsql as $$
declare n int;
begin execute 'with q as (' || stmt || ' returning 1) select count(*) from q' into n;
  if n <> expected then raise exception 'ASSERT FAILED [%]: expected % rows, got %', label, expected, n; end if; end $$;

-- ===== 0. idempotent re-apply is checked by the driver (migrations are applied twice) =====

-- ===== 1. final-pregame revisions: the database itself refuses hindsight =====
select pg_temp.expect_sqlstate(format($q$insert into bridge_final_pregame_revisions (forecast_id, league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, composed_at, content_signature, scoring_fingerprint, record)
  values (%L, 'rogers-park', 2026, 5, 'wr1', 'yahoo', %L, %L, %L, %L, 'fp-std', %L::jsonb)$q$, :'real_forecast_id', :'kickoff_at', :'obs_at', :'composed_at', :'real_signature', :'real_record'), 'NO_ERROR', 'a REAL production-built revision (forecast_id regex, jsonb) is accepted');
select pg_temp.expect_sqlstate(format($q$insert into bridge_final_pregame_revisions (forecast_id, league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, composed_at, content_signature, record)
  values ('fpf:%s', 'l', 2026, 5, 'p', 'y', %L, %L, %L, 's', '{}'::jsonb)$q$, repeat('a', 24), :'kickoff_at', :'obs_at', :'kickoff_at'), '23514', 'composition AT kickoff is refused (composed_at < kickoff_at)');
select pg_temp.expect_sqlstate(format($q$insert into bridge_final_pregame_revisions (forecast_id, league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, composed_at, content_signature, record)
  values ('fpf:%s', 'l', 2026, 5, 'p', 'y', %L, %L::timestamptz + interval '10 minutes', %L::timestamptz + interval '20 minutes', 's', '{}'::jsonb)$q$, repeat('b', 24), :'kickoff_at', :'kickoff_at', :'kickoff_at'), '23514', 'an observation after kickoff is refused');
select pg_temp.expect_sqlstate(format($q$insert into bridge_final_pregame_revisions (forecast_id, league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, composed_at, content_signature, record)
  values ('fpf:%s', 'l', 2026, 5, 'p', 'y', %L, %L::timestamptz - interval '5 minutes', %L::timestamptz - interval '10 minutes', 's', '{}'::jsonb)$q$, repeat('c', 24), :'kickoff_at', :'kickoff_at', :'kickoff_at'), '23514', 'an observation after the composition that used it is refused');
select pg_temp.expect_sqlstate($q$insert into bridge_final_pregame_revisions (forecast_id, league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, composed_at, content_signature, record)
  values ('not-an-fpf-id', 'l', 2026, 5, 'p', 'y', now(), now() - interval '2 hours', now() - interval '1 hour', 's', '{}'::jsonb)$q$, '23514', 'a malformed forecast_id is refused');
select pg_temp.expect_sqlstate($q$insert into bridge_final_pregame_revisions (forecast_id, league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, composed_at, content_signature, record)
  values ('fpf:dddddddddddddddddddddddd', 'l', 2026, 23, 'p', 'y', now(), now() - interval '2 hours', now() - interval '1 hour', 's', '{}'::jsonb)$q$, '23514', 'week outside 1..22 is refused');

-- ===== 2. immutability and idempotent (content-addressed) writes =====
select pg_temp.expect_sqlstate($q$update bridge_final_pregame_revisions set provider = 'x'$q$, 'P0001', 'UPDATE of a revision is blocked by the insert-only trigger');
select pg_temp.expect_sqlstate($q$delete from bridge_final_pregame_revisions$q$, 'P0001', 'DELETE of a revision is blocked');
select pg_temp.expect_rows(format($q$insert into bridge_final_pregame_revisions (forecast_id, league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, composed_at, content_signature, scoring_fingerprint, record)
  values (%L, 'rogers-park', 2026, 5, 'wr1', 'yahoo', %L, %L, %L, %L, 'fp-std', %L::jsonb) on conflict (forecast_id) do nothing$q$, :'real_forecast_id', :'kickoff_at', :'obs_at', :'composed_at', :'real_signature', :'real_record'), 0,
  'ON CONFLICT (forecast_id) DO NOTHING returns NO row for the existing id (what insertIgnoreDuplicates relies on)');
-- the hazard the migration removed: a DIFFERENT forecast_id with the same (league,week,player,observation,signature) must NOT fail the insert
select pg_temp.expect_sqlstate(format($q$insert into bridge_final_pregame_revisions (forecast_id, league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, composed_at, content_signature, scoring_fingerprint, record)
  values ('fpf:%s', 'rogers-park', 2026, 5, 'wr1', 'yahoo', %L, %L, %L, %L, 'fp-DIFFERENT', '{}'::jsonb) on conflict (forecast_id) do nothing$q$, repeat('e', 24), :'kickoff_at', :'obs_at', :'composed_at', :'real_signature'), 'NO_ERROR',
  'a second belief row sharing observation+signature but another scoring fingerprint is NOT rejected by another unique index');

-- ===== 3. the final POINTER table: guards the TypeScript relies on =====
insert into bridge_final_pregame_forecasts (league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, confirmed_through, forecast_id, composed_at, record)
  values ('rogers-park', 2026, 5, 'wr1', 'yahoo', :'kickoff_at', :'obs_at', :'obs_at', :'real_forecast_id', :'composed_at', :'real_thin_record'::jsonb);
select pg_temp.expect_sqlstate($q$insert into bridge_final_pregame_forecasts (league_slug, season, week, canonical_player_id, provider, kickoff_at, source_observed_at, confirmed_through, composed_at, record)
  values ('l', 2026, 5, 'p', 'y', now(), now() - interval '1 hour', now() - interval '1 hour', now(), '{}'::jsonb)$q$, '23514', 'a NEW pointer row composed at/after kickoff is refused (NOT VALID constraint still checks new rows)');
select pg_temp.expect_sqlstate(format($q$update bridge_final_pregame_forecasts set confirmed_through = %L::timestamptz + interval '1 minute' where canonical_player_id = 'wr1'$q$, :'kickoff_at'), '23514', 'a CONFIRM past kickoff is refused (confirmed_through <= kickoff_at)');
-- the monotonic pointer guards: lte filters on a timestamptz column compared with ISO strings
select pg_temp.expect_rows(format($q$update bridge_final_pregame_forecasts set forecast_id = 'fpf:%s' where canonical_player_id = 'wr1' and confirmed_through <= %L::timestamptz - interval '1 hour' and composed_at <= %L::timestamptz - interval '1 hour'$q$, repeat('0', 24), :'obs_at', :'composed_at'), 0, 'a stale writer (older observation/composition) moves NOTHING');
select pg_temp.expect_rows(format($q$update bridge_final_pregame_forecasts set forecast_id = 'fpf:%s' where canonical_player_id = 'wr1' and confirmed_through <= %L::timestamptz + interval '5 minutes' and composed_at <= %L::timestamptz + interval '5 minutes'$q$, repeat('1', 24), :'obs_at', :'composed_at'), 1, 'a forward writer moves the pointer');
select pg_temp.expect_rows($q$update bridge_final_pregame_forecasts set forecast_id = forecast_id where canonical_player_id = 'wr1' and composed_at is null$q$, 0, 'IS NULL guard (legacy upgrade path) matches only legacy rows');

-- ===== 4. source-observation tables: FK order, enums, ids, composite-PK conflict semantics =====
select pg_temp.expect_sqlstate(format($q$insert into bridge_projection_source_observation_rows (observation_id, provider_player_id, player_hash, removed, row) values (%L, 'wr1', 'h', false, '{}'::jsonb)$q$, :'real_srcobs'), '23503', 'rows BEFORE their header violate the FK (append() must insert header first)');
select pg_temp.expect_sqlstate(format($q$insert into bridge_projection_source_observations (observation_id, provider, season, week, observed_at, content_hash, kind, row_count, changed_count, removed_count, fetch_path, segments, format)
  values (%L, 'sleeper', 2026, 5, %L, 'h', 'FULL', 1, 1, 0, 'LIVE_FETCH', '{}'::jsonb, 1)$q$, :'real_srcobs', :'obs_at'), 'NO_ERROR', 'a REAL srcobs id produced by the provider code satisfies the id regex');
select pg_temp.expect_sqlstate(format($q$insert into bridge_projection_source_observation_rows (observation_id, provider_player_id, player_hash, removed, row) values (%L, 'wr1', 'h', false, '{}'::jsonb)$q$, :'real_srcobs'), 'NO_ERROR', 'rows after the header are accepted');
select pg_temp.expect_rows(format($q$insert into bridge_projection_source_observation_rows (observation_id, provider_player_id, player_hash, removed, row) values (%L, 'wr1', 'h', false, '{}'::jsonb) on conflict (observation_id, provider_player_id) do nothing$q$, :'real_srcobs'), 0, 'composite-PK ON CONFLICT DO NOTHING: idempotent row insert');
select pg_temp.expect_sqlstate($q$insert into bridge_projection_source_observations (observation_id, provider, season, week, observed_at, content_hash, kind, row_count, changed_count, removed_count, fetch_path, segments, format)
  values ('srcobs:00000000000000000001', 'sleeper', 2026, 5, now(), 'h', 'PARTIAL', 1, 1, 0, 'LIVE_FETCH', '{}'::jsonb, 1)$q$, '23514', 'kind enum');
select pg_temp.expect_sqlstate($q$insert into bridge_projection_source_observations (observation_id, provider, season, week, observed_at, content_hash, kind, row_count, changed_count, removed_count, fetch_path, segments, format)
  values ('srcobs:00000000000000000002', 'sleeper', 2026, 5, now(), 'h', 'FULL', 1, 1, 0, 'SNAPSHOT', '{}'::jsonb, 1)$q$, '23514', 'fetch_path enum (SNAPSHOT is a batch label, never a recorded observation)');
select pg_temp.expect_sqlstate($q$insert into bridge_projection_source_observations (observation_id, provider, season, week, observed_at, content_hash, kind, row_count, changed_count, removed_count, fetch_path, segments, format)
  values ('srcobs:00000000000000000003', 'sleeper', 2026, 0, now(), 'h', 'FULL', 1, 1, 0, 'LIVE_FETCH', '{}'::jsonb, 1)$q$, '23514', 'week 0 is refused (every recorder write for week 0 would fail)');

-- ===== 5. snapshot pointer columns (W1.P4) and the guarded advance semantics =====
insert into bridge_projection_snapshots (artifact_id, content_hash, league_slug, season, week, scoring_fingerprint, request_fingerprint, status, source, model_version, teams_with_games, warnings, row_count, format)
  select 'projsnap:' || repeat('a', 20), repeat('b', 64), 'l', 2026, 5, 'fp', 'rq', 'READY', 's', 'm', '[]'::jsonb, '[]'::jsonb, 0, 1 where not exists (select 1 from bridge_projection_snapshots where artifact_id = 'projsnap:' || repeat('a', 20));
insert into bridge_projection_latest (league_slug, season, week, scoring_fingerprint, request_fingerprint, artifact_id, observed_at) values ('l', 2026, 5, 'fp', 'rq', 'projsnap:' || repeat('a', 20), now());
select pg_temp.expect_rows($q$update bridge_projection_latest set source_observed_at = now() where source_observed_at < now() + interval '1 hour'$q$, 0, 'lt against a NULL source_observed_at never matches (legacy rows are not silently advanced)');
select pg_temp.expect_rows($q$update bridge_projection_latest set source_observed_at = now() where source_observed_at is null$q$, 1, 'the is.null upgrade matches the legacy row exactly once');
select pg_temp.expect_rows($q$update bridge_projection_latest set source_observed_at = now() - interval '1 hour' where source_observed_at < now() - interval '2 hours'$q$, 0, 'an OLDER source time can never move the pointer backwards');

-- ===== 6. calibration ledger accepts the final canonical forecast as an evidence kind =====
do $$ begin
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'bridge_calibration_cases_projection_artifact_kind_check')) not like '%FINAL_PREGAME_FORECAST%' then raise exception 'ASSERT FAILED: calibration kind constraint lacks FINAL_PREGAME_FORECAST'; end if;
end $$;

-- ===== 7. wire-format facts the TypeScript depends on =====
do $$ declare r text; begin
  select to_json('2026-10-11T17:00:00.500Z'::timestamptz)::text into r;
  if r <> '"2026-10-11T17:00:00.5+00:00"' then raise exception 'ASSERT FAILED: timestamptz JSON rendering is %, expected "2026-10-11T17:00:00.5+00:00" (offset form, trailing zeros dropped)', r; end if;
end $$;
do $$ declare r text; begin
  select string_agg(x::text, ',' order by x nulls last) into r from (values (2), (null::int), (1)) v(x);
  if r <> '1,2' then raise exception 'ASSERT FAILED: ascending NULLS LAST ordering expected, got %', r; end if;
end $$;

-- ===== 8. privilege hygiene =====
do $$ declare t text; begin
  foreach t in array array['bridge_final_pregame_revisions','bridge_final_pregame_forecasts','bridge_projection_source_observations','bridge_projection_source_observation_rows','bridge_projection_source_latest','bridge_projection_source_events'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'insert') then raise exception 'ASSERT FAILED: anon/authenticated still hold privileges on %', t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'ASSERT FAILED: RLS not enabled on %', t; end if;
  end loop;
end $$;
select 'ALL POSTGRES COMPATIBILITY ASSERTIONS PASSED';
