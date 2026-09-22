/**
 * Phase 9 — read/write adapter for the weekly audit's evidence tables. READ-ONLY against the three capture tables
 * (never writes a capture); WRITE (insert-only, idempotent) against the three outcome tables plus the two new
 * Phase 9 tables (`bridge_weekly_model_audit`, `bridge_intelligence_freshness_history`). Every write uses
 * `insertIgnoreDuplicates` with the table's real unique constraint as the conflict target, so a re-run over
 * unchanged evidence is a no-op (`INSERTED` count 0) — never a duplicate row, never an error (Step 45).
 */
import { loadSupabaseConfig, SupabaseRest } from "./rest";
import type { ShadowOutcomeRecord } from "@/lib/weekly/start-sit-fi/capture";
import type { Matchup2Outcome } from "@/lib/matchup2/capture";
import type { WaiverOutcome } from "@/lib/waiver2/capture";
import type { WeeklyModelAudit } from "@/lib/weekly-audit/contract";

export function defaultWeeklyAuditRest(env: NodeJS.ProcessEnv = process.env): SupabaseRest | null {
  const c = loadSupabaseConfig(env);
  return c.configured && c.config ? new SupabaseRest(c.config) : null;
}

/* ---------------------------------------------------------------- readers (captures; never mutated) ---------------------------------------------------------------- */
export async function readStartSitCaptures(rest: SupabaseRest, season: number, week: number): Promise<Array<Record<string, unknown>>> {
  return rest.select("bridge_startsit_shadow_captures", { filter: { season: `eq.${season}`, week: `eq.${week}` }, order: "capture_id.asc", limit: 5000 });
}
export async function readMatchup2Captures(rest: SupabaseRest, season: number, week: number): Promise<Array<Record<string, unknown>>> {
  return rest.select("bridge_matchup2_shadow_captures", { filter: { season: `eq.${season}`, week: `eq.${week}` }, order: "capture_id.asc", limit: 5000 });
}
export async function readWaiver2Captures(rest: SupabaseRest, season: number, week: number): Promise<Array<Record<string, unknown>>> {
  return rest.select("bridge_waiver2_shadow_captures", { filter: { season: `eq.${season}`, week: `eq.${week}` }, order: "capture_id.asc", limit: 5000 });
}
export async function readStartSitOutcomes(rest: SupabaseRest, captureIds: readonly string[]): Promise<Array<{ capture_id: string; source: string }>> {
  if (!captureIds.length) return [];
  return rest.select("bridge_startsit_shadow_outcomes", { filter: { capture_id: `in.(${captureIds.join(",")})` }, select: "capture_id,source", limit: 5000 });
}
export async function readMatchup2Outcomes(rest: SupabaseRest, captureIds: readonly string[]): Promise<Array<{ capture_id: string; source: string }>> {
  if (!captureIds.length) return [];
  return rest.select("bridge_matchup2_shadow_outcomes", { filter: { capture_id: `in.(${captureIds.join(",")})` }, select: "capture_id,source", limit: 5000 });
}
export async function readWaiver2Outcomes(rest: SupabaseRest, captureIds: readonly string[]): Promise<Array<{ capture_id: string; source: string }>> {
  if (!captureIds.length) return [];
  return rest.select("bridge_waiver2_shadow_outcomes", { filter: { capture_id: `in.(${captureIds.join(",")})` }, select: "capture_id,source", limit: 5000 });
}

/* ---------------------------------------------------------------- writers (outcomes; insert-only, idempotent) ---------------------------------------------------------------- */
export interface WriteSummary { attempted: number; inserted: number; duplicate: number }
async function writeRows<T extends { capture_id: string; source: string }>(rest: SupabaseRest, table: string, rows: readonly T[], toRow: (r: T) => Record<string, unknown>): Promise<WriteSummary> {
  if (!rows.length) return { attempted: 0, inserted: 0, duplicate: 0 };
  const ins = await rest.insertIgnoreDuplicates<{ capture_id: string }>(table, rows.map(toRow), ["capture_id", "source"]);
  return { attempted: rows.length, inserted: ins.length, duplicate: rows.length - ins.length };
}
export const writeStartSitOutcomes = (rest: SupabaseRest, rows: readonly ShadowOutcomeRecord[]) =>
  writeRows(rest, "bridge_startsit_shadow_outcomes", rows, (o) => ({ capture_id: o.capture_id, source: o.source, scoring_fingerprint: o.scoring_fingerprint, actual_fantasy_points: o.actual_fantasy_points, recorded_at: o.recorded_at }));
export const writeMatchup2Outcomes = (rest: SupabaseRest, rows: readonly Matchup2Outcome[]) =>
  writeRows(rest, "bridge_matchup2_shadow_outcomes", rows, (o) => ({ capture_id: o.capture_id, source: o.source, outcome: o, recorded_at: o.recorded_at }));
export const writeWaiver2Outcomes = (rest: SupabaseRest, rows: readonly WaiverOutcome[]) =>
  writeRows(rest, "bridge_waiver2_shadow_outcomes", rows, (o) => ({ capture_id: o.capture_id, source: o.source, outcome: o, recorded_at: o.recorded_at }));

/* ---------------------------------------------------------------- Phase 9 tables ---------------------------------------------------------------- */
export async function writeWeeklyModelAudit(rest: SupabaseRest, audit: WeeklyModelAudit): Promise<WriteSummary> {
  const row = { audit_id: audit.audit_id, season: audit.season, week: audit.week, audit_schema_version: audit.audit_schema_version, evidence_digest: audit.evidence_digest, status: audit.status, severity: audit.severity, record: audit, generated_at: audit.generated_at };
  const ins = await rest.insertIgnoreDuplicates<{ audit_id: string }>("bridge_weekly_model_audit", [row], ["audit_id"]);
  return { attempted: 1, inserted: ins.length, duplicate: 1 - ins.length };
}
export async function readLatestWeeklyAudit(rest: SupabaseRest, season: number, week: number): Promise<WeeklyModelAudit | null> {
  const rows = await rest.select<{ record: WeeklyModelAudit }>("bridge_weekly_model_audit", { filter: { season: `eq.${season}`, week: `eq.${week}` }, order: "generated_at.desc", limit: 1, select: "record" });
  return rows[0]?.record ?? null;
}
export interface FreshnessHistoryRow { season: number; week: number; fi_version: string | null; overall_status: string; family_statuses: unknown; nfl_reality: unknown; source?: string }
export async function writeFreshnessHistory(rest: SupabaseRest, row: FreshnessHistoryRow): Promise<WriteSummary> {
  const ins = await rest.insertIgnoreDuplicates<{ id: number }>("bridge_intelligence_freshness_history", [{ ...row, source: row.source ?? "weekly_audit" }], ["season", "week", "fi_version", "overall_status"]);
  return { attempted: 1, inserted: ins.length, duplicate: 1 - ins.length };
}
