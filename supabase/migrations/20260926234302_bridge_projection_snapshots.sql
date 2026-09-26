-- Phase 5: canonical normalized weekly projection snapshots.
--
-- Immutable content-addressed artifacts + normalized player rows + a mutable
-- latest-observation pointer. Identical projection content is stored once;
-- freshness advances independently through bridge_projection_latest.
--
-- RLS enabled with no client policies; bridge server service-role access only.

create or replace function public.bridge_projection_snapshot_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'projection snapshot artifact rows are immutable (% blocked)', tg_op;
end
$$;

create table if not exists public.bridge_projection_snapshots (
  artifact_id          text primary key check (artifact_id ~ '^projsnap:[0-9a-f]{20}$'),
  content_hash         text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  league_slug          text not null check (char_length(league_slug) > 0),
  season               integer not null check (season between 2000 and 2100),
  week                 integer not null check (week between 1 and 22),
  scoring_fingerprint  text not null check (char_length(scoring_fingerprint) > 0),
  status               text not null check (status in ('READY','PROJECTIONS_PARTIAL','PROJECTIONS_UNAVAILABLE')),
  source               text not null check (char_length(source) > 0),
  model_version        text not null check (char_length(model_version) > 0),
  teams_with_games     jsonb not null default '[]'::jsonb check (jsonb_typeof(teams_with_games) = 'array'),
  warnings             jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  row_count            integer not null check (row_count >= 0),
  format               integer not null check (format = 1),
  recorded_at          timestamptz not null default now()
);

create index if not exists bridge_projection_snapshots_scope_idx
  on public.bridge_projection_snapshots
  (league_slug, season, week, scoring_fingerprint, recorded_at desc);

create table if not exists public.bridge_projection_snapshot_players (
  artifact_id          text not null references public.bridge_projection_snapshots(artifact_id),
  canonical_player_id  text not null check (char_length(canonical_player_id) > 0),
  projection           jsonb not null check (jsonb_typeof(projection) = 'object'),
  resolved_player      jsonb check (resolved_player is null or jsonb_typeof(resolved_player) = 'object'),
  recorded_at          timestamptz not null default now(),
  primary key (artifact_id, canonical_player_id)
);

create table if not exists public.bridge_projection_latest (
  league_slug          text not null,
  season               integer not null check (season between 2000 and 2100),
  week                 integer not null check (week between 1 and 22),
  scoring_fingerprint  text not null,
  artifact_id          text not null references public.bridge_projection_snapshots(artifact_id),
  observed_at          timestamptz not null,
  updated_at           timestamptz not null default now(),
  primary key (league_slug, season, week, scoring_fingerprint)
);

drop trigger if exists bridge_projection_snapshots_immutable on public.bridge_projection_snapshots;
create trigger bridge_projection_snapshots_immutable
before update or delete on public.bridge_projection_snapshots
for each row execute function public.bridge_projection_snapshot_immutable();

drop trigger if exists bridge_projection_snapshot_players_immutable on public.bridge_projection_snapshot_players;
create trigger bridge_projection_snapshot_players_immutable
before update or delete on public.bridge_projection_snapshot_players
for each row execute function public.bridge_projection_snapshot_immutable();

alter table public.bridge_projection_snapshots enable row level security;
alter table public.bridge_projection_snapshot_players enable row level security;
alter table public.bridge_projection_latest enable row level security;

revoke all on public.bridge_projection_snapshots from anon, authenticated;
revoke all on public.bridge_projection_snapshot_players from anon, authenticated;
revoke all on public.bridge_projection_latest from anon, authenticated;
