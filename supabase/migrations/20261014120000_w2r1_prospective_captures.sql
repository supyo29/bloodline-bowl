-- W2.R1 S8: durable immutable store for PROSPECTIVE pregame captures (D/ST + K component forecasts, TE/QB/RB upside rows, per-league/manager Dynamic-VOR state).
-- NOT APPLIED to any database by the S8 work (production migration requires explicit authorization); validated only on the throwaway local Docker staging Postgres.
--
-- bridge_w2r1_prospective_captures : one row per (season, week, kind, league, manager, payload hash). INSERT-only: UPDATE/DELETE rejected by trigger.
--   The DATABASE refuses late evidence on its own clock: a row whose first_kickoff_at is at/before now() is refused, and CHECK captured_at < first_kickoff_at.
--   The record must be a read-only CURRENT_INTELLIGENCE record (writes_to_providers = false). RLS on with NO policies (service-role only); privileges revoked from anon/authenticated.
--   Nothing reads this table on a ranking or decision path; the runtime works WITHOUT it (persistence is optional and fails soft).
-- ROLLBACK (research telemetry only):
--   drop table if exists public.bridge_w2r1_prospective_captures;
--   drop function if exists public.bridge_w2r1_capture_immutable();
--   drop function if exists public.bridge_w2r1_capture_not_late();

create or replace function public.bridge_w2r1_capture_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'bridge_w2r1_prospective_captures rows are immutable (% blocked)', tg_op;
end $$;

create or replace function public.bridge_w2r1_capture_not_late() returns trigger
language plpgsql as $$
begin
  if now() >= new.first_kickoff_at then
    raise exception 'w2r1 capture refused: database clock % is at/after first kickoff %', now(), new.first_kickoff_at using errcode = 'P0001';
  end if;
  return new;
end $$;

create table if not exists public.bridge_w2r1_prospective_captures (
  capture_id        text primary key check (capture_id ~ '^w2c:[0-9a-f]{16}$'),
  kind              text        not null check (kind in ('KDST_COMPONENTS', 'TE_UPSIDE', 'LEAGUE_MANAGER_STATE', 'QUALIFICATION_AND_TACTICAL')),
  season            integer     not null check (season between 2000 and 2100),
  week              integer     not null check (week between 1 and 22),
  league_slug       text        not null default '*',
  manager_slug      text        not null default '*',
  first_kickoff_at  timestamptz not null,
  captured_at       timestamptz not null,
  payload_sha256    text        not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  model_artifact_hashes jsonb   not null check (jsonb_typeof(model_artifact_hashes) = 'object'),
  qualification     jsonb       not null check (jsonb_typeof(qualification) = 'object'),
  record            jsonb       not null check (
    jsonb_typeof(record) = 'object'
    and (record->>'writes_to_providers') = 'false'
    and (record->>'mode') = 'CURRENT_INTELLIGENCE'
  ),
  recorded_at       timestamptz not null default now(),
  constraint bridge_w2r1_capture_is_pregame check (captured_at < first_kickoff_at),
  constraint bridge_w2r1_capture_unique unique (season, week, kind, league_slug, manager_slug, payload_sha256)
);
create index if not exists bridge_w2r1_captures_scope_idx on public.bridge_w2r1_prospective_captures (season, week, kind, league_slug);

drop trigger if exists bridge_w2r1_captures_not_late on public.bridge_w2r1_prospective_captures;
create trigger bridge_w2r1_captures_not_late before insert on public.bridge_w2r1_prospective_captures
  for each row execute function public.bridge_w2r1_capture_not_late();
drop trigger if exists bridge_w2r1_captures_immutable on public.bridge_w2r1_prospective_captures;
create trigger bridge_w2r1_captures_immutable before update or delete on public.bridge_w2r1_prospective_captures
  for each row execute function public.bridge_w2r1_capture_immutable();

alter table public.bridge_w2r1_prospective_captures enable row level security;
revoke all on public.bridge_w2r1_prospective_captures from anon, authenticated;
