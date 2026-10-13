-- W2.P2: durable immutable evidence store for PROSPECTIVE Role Shadow captures (challenger / Role-free control vs the production champion).
--
-- bridge_role_shadow_captures : one row per capture. Identity = capture_id (content hash of the DECISION: champion numbers, source observation,
--   Role forecast content, scoring, model versions + config hashes; capture/composition times and provenance are excluded, so re-capturing
--   identical evidence is a no-op and any change in evidence or model version is a NEW row).
--   INSERT-only: UPDATE and DELETE are rejected by trigger (an existing observation can never be overwritten or silently replaced).
--   The database refuses late evidence on ITS OWN clock:
--     * CHECK  LIVE_CAPTURED requires captured_at < kickoff_at AND source_observed_at < kickoff_at;
--     * TRIGGER LIVE_CAPTURED insert is refused when now() >= kickoff_at (evidence that ARRIVES after kickoff is never pregame information);
--     * CHECK  HISTORICALLY_RECONSTRUCTED can never be eligible;
--     * CHECK  the record must be SHADOW_ONLY and may not influence production.
--
-- RLS on with NO policies (service-role only, like every bridge_* table); all privileges revoked from anon/authenticated.
-- Nothing reads this table on a ranking or decision path. Purely additive: no existing table or function is touched.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (research telemetry only -- safe; no production behavior depends on it):
--   drop table if exists public.bridge_role_shadow_captures;
--   drop function if exists public.bridge_role_shadow_immutable();
--   drop function if exists public.bridge_role_shadow_not_late();
-- ---------------------------------------------------------------------------

create or replace function public.bridge_role_shadow_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'bridge_role_shadow_captures rows are immutable (% blocked)', tg_op;
end $$;

create or replace function public.bridge_role_shadow_not_late() returns trigger
language plpgsql as $$
begin
  if new.capture_class = 'LIVE_CAPTURED' and now() >= new.kickoff_at then
    raise exception 'role shadow LIVE_CAPTURED insert refused: database clock % is at/after kickoff %', now(), new.kickoff_at
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create table if not exists public.bridge_role_shadow_captures (
  capture_id             text primary key check (capture_id ~ '^rsc:[0-9a-f]{16}$'),
  capture_class          text        not null check (capture_class in ('LIVE_CAPTURED', 'HISTORICALLY_RECONSTRUCTED')),
  season                 integer     not null check (season between 2000 and 2100),
  week                   integer     not null check (week between 1 and 22),
  league_slug            text        not null check (char_length(league_slug) > 0),
  provider               text        not null,
  canonical_player_id    text        not null check (char_length(canonical_player_id) > 0),
  gsis_id                text        not null,
  position               text        not null check (position in ('QB', 'RB', 'WR', 'TE')),
  challenger_model_id    text        not null,
  challenger_config_hash text        not null check (challenger_config_hash ~ '^[0-9a-f]{32}$'),
  control_config_hash    text        not null check (control_config_hash ~ '^[0-9a-f]{32}$'),
  scoring_fingerprint    text,
  scoring_compatibility  text        not null,
  kickoff_at             timestamptz not null,
  captured_at            timestamptz not null,
  source_observed_at     timestamptz,
  eligible               boolean     not null,
  content_hash           text        not null check (content_hash ~ '^[0-9a-f]{32}$'),
  record_schema_version  integer     not null,
  record                 jsonb       not null check (
    jsonb_typeof(record) = 'object'
    and record->>'capture_id' = capture_id
    and (record->>'may_influence_production') = 'false'
    and (record->>'lifecycle_state') = 'SHADOW_ONLY'
  ),
  recorded_at            timestamptz not null default now(),
  constraint bridge_role_shadow_live_is_pregame check
    (capture_class <> 'LIVE_CAPTURED' or (captured_at < kickoff_at and source_observed_at is not null and source_observed_at < kickoff_at)),
  constraint bridge_role_shadow_reconstructed_never_eligible check
    (capture_class <> 'HISTORICALLY_RECONSTRUCTED' or eligible = false)
);
create index if not exists bridge_role_shadow_captures_scope_idx on public.bridge_role_shadow_captures (season, week, league_slug);
create index if not exists bridge_role_shadow_captures_player_idx on public.bridge_role_shadow_captures (gsis_id, season, week);
create index if not exists bridge_role_shadow_captures_model_idx on public.bridge_role_shadow_captures (challenger_config_hash, capture_class);

drop trigger if exists bridge_role_shadow_captures_not_late on public.bridge_role_shadow_captures;
create trigger bridge_role_shadow_captures_not_late before insert on public.bridge_role_shadow_captures
  for each row execute function public.bridge_role_shadow_not_late();
drop trigger if exists bridge_role_shadow_captures_immutable on public.bridge_role_shadow_captures;
create trigger bridge_role_shadow_captures_immutable before update or delete on public.bridge_role_shadow_captures
  for each row execute function public.bridge_role_shadow_immutable();

alter table public.bridge_role_shadow_captures enable row level security;
revoke all on public.bridge_role_shadow_captures from anon, authenticated;
