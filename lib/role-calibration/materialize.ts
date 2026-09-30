/**
 * Role calibration materializer: (1) freeze pre-game role forecasts, (2) after games finalize, join forecast x observed role x ledger case.
 * Reuses the Phase-1 ledger read path and week/game closure; adds no scheduler of its own beyond one cron route.
 */
import { getPlayerIndex } from "@/lib/sleeper/client";
import { defaultWeeklyAuditRest } from "@/lib/persistence/supabase/weekly-audit-store";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import { readCurrentCases } from "@/lib/calibration/store";
import type { LeagueScoringInput } from "@/lib/calibration/case-builder";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadObservedRoleGames, loadPositionYields } from "./data";
import { buildWeekForecasts } from "./forecast-week";
import { buildRoleAnalysis, type CaseLike, type ExclusionEntry, type RoleAnalysisRow } from "./analysis";
import { readForecasts, writeAnalysis, writeForecasts, type WriteCounts } from "./store";
import type { CaptureKind, RoleForecast } from "./types";

export function loadExclusions(): ExclusionEntry[] {
  const p = join(process.cwd(), "lib", "role-calibration", "data", "role_eval_exclusions.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { entries: ExclusionEntry[] }).entries : [];
}

export interface CaptureSummary { season: number; week: number; kind: CaptureKind; built: number; skipped: { no_game: number; kickoff_passed: number; not_skill: number }; write: WriteCounts | null }
export async function captureRoleForecasts(args: { season: number; week: number; kind: CaptureKind; rest?: SupabaseRest | null; write: boolean }): Promise<{ summary: CaptureSummary; forecasts: RoleForecast[] }> {
  const r = await buildWeekForecasts({ season: args.season, week: args.week, captureKind: args.kind });
  let write: WriteCounts | null = null;
  if (args.write) { const rest = args.rest ?? defaultWeeklyAuditRest(); if (!rest) throw new Error("role calibration requires Supabase configuration"); write = await writeForecasts(rest, r.forecasts); }
  return { summary: { season: args.season, week: args.week, kind: args.kind, built: r.forecasts.length, skipped: r.skipped, write }, forecasts: r.forecasts };
}

/** POST-game designations (outcome-side labeling only): Sleeper's current injury_status per player, keyed by sleeper id AND gsis id when known. */
export async function loadPostgameInjury(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const idx = await getPlayerIndex().catch(() => null);
  if (!idx) return m;
  for (const [sid, p] of idx) { const s = (p as { injury_status?: string | null }).injury_status; if (s) m.set(sid, s); }
  return m;
}

export interface AnalysisSummary { season: number; week: number; cases_considered: number; rows_built: number; with_forecast: number; write: WriteCounts | null }
/**
 * Pre-game forecasts for a COMPLETED week. Persisted forecasts (LIVE first) are used as-is; any skill player with no persisted forecast gets an
 * AS_OF_RECONSTRUCTION (inputs strictly before kickoff; labeled) so a week that ran before this system existed can still be evaluated honestly.
 * Reconstructions are never presented as live captures.
 */
export async function forecastsForWeek(rest: SupabaseRest, season: number, week: number): Promise<{ forecasts: RoleForecast[]; persisted: number; reconstructed: number }> {
  const persisted = await readForecasts(rest, season, week).catch(() => [] as RoleForecast[]);
  const have = new Set(persisted.map((f) => f.gsis_id).filter(Boolean));
  const recon = (await buildWeekForecasts({ season, week, captureKind: "AS_OF_RECONSTRUCTION" })).forecasts.filter((f) => !have.has(f.gsis_id));
  return { forecasts: [...persisted, ...recon], persisted: persisted.length, reconstructed: recon.length };
}

export async function materializeRoleAnalysis(args: { season: number; week: number; leagues: readonly LeagueScoringInput[]; rest?: SupabaseRest | null; write: boolean; forecasts?: readonly RoleForecast[]; reconstructMissing?: boolean }): Promise<{ summary: AnalysisSummary; rows: RoleAnalysisRow[] }> {
  const rest = args.rest ?? defaultWeeklyAuditRest();
  if (!rest) throw new Error("role calibration requires Supabase configuration");
  const cases = (await readCurrentCases(rest, { season: args.season, week: args.week })) as unknown as CaseLike[];
  let forecasts: readonly RoleForecast[];
  if (args.forecasts) forecasts = args.forecasts;
  else if (args.reconstructMissing) {
    const fw = await forecastsForWeek(rest, args.season, args.week);
    forecasts = fw.forecasts;
    // persist the labeled reconstructions so the analysis row's forecast_id foreign key is satisfied and the evidence is auditable
    if (args.write) { const fresh = fw.forecasts.filter((f) => f.capture_kind === "AS_OF_RECONSTRUCTION"); if (fresh.length) await writeForecasts(rest, fresh); }
  } else forecasts = await readForecasts(rest, args.season, args.week);
  const raw = new Map(args.leagues.filter((l) => l.scoring_fingerprint && l.raw_scoring).map((l) => [l.scoring_fingerprint!, l.raw_scoring!]));
  const rows = buildRoleAnalysis({ cases, forecasts, observed: loadObservedRoleGames(), yields: loadPositionYields(args.season - 1), rawScoringByFingerprint: raw, exclusions: loadExclusions(), postgameInjury: await loadPostgameInjury() });
  let write: WriteCounts | null = null;
  if (args.write) write = await writeAnalysis(rest, rows);
  return { summary: { season: args.season, week: args.week, cases_considered: cases.length, rows_built: rows.length, with_forecast: rows.filter((r) => r.forecast_id).length, write }, rows };
}
