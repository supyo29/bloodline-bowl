-- Phase 9: durable, immutable/append-only evidence stores for the weekly model audit / calibration feedback loop.
--
-- bridge_weekly_model_audit          : one row per (season, week, audit_schema_version, evidence_digest). Identity = audit_id, a
--   deterministic hash of season/week/schema version/evidence digest -- NEVER a wall-clock timestamp. INSERT-only (trigger):
--   a later re-run over unchanged evidence is idempotent (same audit_id, insertIgnoreDuplicates no-op); a re-run after NEW
--   evidence (e.g. a corrected outcome) produces an ADDITIVE new row with a different evidence_digest, never a mutation of the
--   old one. The full typed WeeklyModelAudit contract is the source of truth; the promoted columns are for narrow, indexed reads.
-- bridge_intelligence_freshness_history : append-only compact snapshot of assessIntelligenceFreshness()/family availability for a
--   (season, week). Not a duplicate of any recommendation payload -- version identifiers and per-family status only.
--
-- RLS on, no policies -> service-role only (same as every other bridge_* table). Nothing reads these tables on a
-- production recommendation path (Book-Ready evidence reads only). Purely additive.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (safe -- telemetry/evidence only):
--   drop table if exists public.bridge_intelligence_freshness_history;
--   drop table if exists public.bridge_weekly_model_audit;
--   drop function if exists public.bridge_weekly_model_audit_immutable();
-- ---------------------------------------------------------------------------

create or replace function public.bridge_weekly_model_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'bridge_weekly_model_audit / bridge_intelligence_freshness_history rows are immutable (% blocked)', tg_op;
end $$;

create table if not exists public.bridge_weekly_model_audit (
  audit_id              text primary key check (audit_id ~ '^wa:[0-9]{4}:[0-9]{1,2}:v[0-9]+:[0-9a-f]{16}$'),
  season                integer     not null,
  week                  integer     not null,
  audit_schema_version  integer     not null,
  evidence_digest       text        not null,
  status                text        not null check (status in
    ('WEEK_IN_PROGRESS', 'WEEK_COMPLETE', 'WEEK_INCOMPLETE_SOURCE_CONFLICT', 'WEEK_COMPLETE_WITH_MISSING_OUTCOMES')),
  severity              text        not null check (severity in ('INFO', 'WATCH', 'INVESTIGATE', 'BLOCKING_DATA_QUALITY')),
  record                jsonb       not null check (jsonb_typeof(record) = 'object' and record->>'audit_id' = audit_id),
  generated_at          timestamptz not null default now()
);
create index if not exists bridge_weekly_model_audit_scope_idx on public.bridge_weekly_model_audit (season, week, generated_at desc);

create table if not exists public.bridge_intelligence_freshness_history (
  id                bigint generated always as identity primary key,
  season            integer     not null,
  week              integer     not null,
  fi_version        text,
  overall_status    text        not null,
  family_statuses   jsonb       not null,
  nfl_reality       jsonb,
  source            text        not null default 'weekly_audit',
  captured_at       timestamptz not null default now(),
  constraint bridge_intelligence_freshness_history_dedupe unique (season, week, fi_version, overall_status)
);
create index if not exists bridge_intelligence_freshness_history_scope_idx on public.bridge_intelligence_freshness_history (season, week, captured_at desc);

drop trigger if exists bridge_weekly_model_audit_immutable on public.bridge_weekly_model_audit;
create trigger bridge_weekly_model_audit_immutable before update or delete on public.bridge_weekly_model_audit
  for each row execute function public.bridge_weekly_model_audit_immutable();
drop trigger if exists bridge_intelligence_freshness_history_immutable on public.bridge_intelligence_freshness_history;
create trigger bridge_intelligence_freshness_history_immutable before update or delete on public.bridge_intelligence_freshness_history
  for each row execute function public.bridge_weekly_model_audit_immutable();

alter table public.bridge_weekly_model_audit enable row level security;
alter table public.bridge_intelligence_freshness_history enable row level security;
revoke all on public.bridge_weekly_model_audit from anon, authenticated;
revoke all on public.bridge_intelligence_freshness_history from anon, authenticated;
