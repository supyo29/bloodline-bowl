-- Phase 7: projection snapshot request-variant isolation.
--
-- Phase 5 scoped latest pointers by league/season/week/scoring only. That is
-- insufficient because normalized projection output can also differ when ROS,
-- return-game enrichment, or crosswalk inputs differ. Keep legacy rows for
-- history, but put every new read/write behind a deterministic
-- request_fingerprint.

alter table public.bridge_projection_snapshots
  add column if not exists request_fingerprint text not null default 'legacy:v0';

alter table public.bridge_projection_latest
  add column if not exists request_fingerprint text not null default 'legacy:v0';

alter table public.bridge_projection_latest
  drop constraint if exists bridge_projection_latest_pkey;

alter table public.bridge_projection_latest
  add constraint bridge_projection_latest_pkey
  primary key (league_slug, season, week, scoring_fingerprint, request_fingerprint);

drop index if exists public.bridge_projection_snapshots_scope_idx;

create index if not exists bridge_projection_snapshots_scope_idx
  on public.bridge_projection_snapshots
  (league_slug, season, week, scoring_fingerprint, request_fingerprint, recorded_at desc);
