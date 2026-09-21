-- Phase 4.5: durable, immutable, content-addressed MARKET-STATE snapshots (compact form).
--
-- bridge_market_state_snapshots : one row per artifact. Identity = artifact_id (deterministic hash of the compact snapshot, EXCLUDING
--   volatile fields such as request ids and read timestamps). INSERT-only: UPDATE/DELETE are rejected by trigger.
--   CHECK constraints make the store refuse untrustworthy history: only TRUE_AS_OF snapshots, only non-blocked markets.
--   Many artifacts may share a market_content_id (a winning claim changes FAAB budgets without changing who is available).
--
-- RLS on with NO policies (service-role only, like every bridge_* table); all privileges revoked from anon/authenticated.
-- Nothing reads this table on a ranking path. Purely additive.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (telemetry only -- safe):
--   drop table if exists public.bridge_market_state_snapshots;
--   drop function if exists public.bridge_market_state_immutable();
-- ---------------------------------------------------------------------------

create or replace function public.bridge_market_state_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'bridge_market_state_snapshots rows are immutable (% blocked)', tg_op;
end $$;

create table if not exists public.bridge_market_state_snapshots (
  artifact_id            text primary key,
  market_content_id      text        not null,
  acquisition_context_id text        not null,
  league_slug            text        not null,
  season                 integer     not null,
  week                   integer     not null,
  history_class          text        not null check (history_class = 'TRUE_AS_OF'),
  readiness_status       text        not null check (readiness_status in ('READY', 'PARTIAL')),
  scoring_fingerprint    text,
  market_state_version   text        not null,
  format                 integer     not null,
  snapshot               jsonb       not null,
  observed_at            timestamptz not null,
  recorded_at            timestamptz not null default now()
);
create index if not exists bridge_market_state_snapshots_scope_idx on public.bridge_market_state_snapshots (league_slug, season, week, observed_at);
create index if not exists bridge_market_state_snapshots_content_idx on public.bridge_market_state_snapshots (market_content_id);

drop trigger if exists bridge_market_state_snapshots_immutable on public.bridge_market_state_snapshots;
create trigger bridge_market_state_snapshots_immutable before update or delete on public.bridge_market_state_snapshots
  for each row execute function public.bridge_market_state_immutable();

alter table public.bridge_market_state_snapshots enable row level security;
revoke all on public.bridge_market_state_snapshots from anon, authenticated;
