/**
 * Phase 9 Steps 7-9 — Start/Sit outcome ingestion. Pure functions only; the DB write lives in
 * `lib/persistence/supabase/weekly-audit-store.ts`. Only `LIVE_CAPTURED` decisions are PRISTINE prospective evidence
 * (Step 9): `LIVE_POST_LOCK` / `LIVE_UNVERIFIED` / `HISTORICALLY_RECONSTRUCTED` are scored too (for the record) but
 * reported in a separate diagnostic bucket and never mixed into the primary calibration numbers.
 */
import type { ShadowOutcomeRecord } from "@/lib/weekly/start-sit-fi/capture";
import { actualPointsFor, sleeperIdFromCanonical, type WeekActuals } from "./scoring-actuals";
import type { StartSitDecisionOutcome, StartSitCalibration } from "./contract";

export interface StartSitCaptureRow {
  capture_id: string; capture_kind: "LIVE_CAPTURED" | "LIVE_POST_LOCK" | "LIVE_UNVERIFIED" | "HISTORICALLY_RECONSTRUCTED";
  season: number; week: number; league_slug: string; manager_slug: string; scoring_fingerprint: string | null;
  record: { decisions: Array<{ slot: string; baseline_start: string; fi_start: string; baseline_edge: number; fi_edge: number; reversal: boolean }>;
    adjustments: Array<{ canonical_player_id: string; position: string; contributions: Array<{ family: string; points_contribution: number }> }> };
}

const SEVERE_MISS_POINTS = 8; // pre-registered (Step 24), matches Phase 8's own severe-miss concept; audited, not chosen after seeing results.

/** Actual points for one canonical player id, from an already-loaded `WeekActuals` + a league's raw_scoring. Position comes from the capture's own `adjustments` row (never inferred). */
function actualFor(canonicalId: string, position: string, actuals: WeekActuals, rawScoring: Record<string, number>): number | null {
  const sid = sleeperIdFromCanonical(canonicalId);
  if (!sid) return null;
  const rawKey = position === "K" || position === "DEF" ? sid.toUpperCase() : sid;
  const r = actualPointsFor(position, actuals.clean.get(sid), actuals.raw.get(rawKey), rawScoring);
  return r.points;
}

/**
 * Builds outcome rows (one `ShadowOutcomeRecord` per capture, `actual_fantasy_points` keyed by every canonical id
 * the decisions reference) AND the decision-level evaluation. A capture whose scoring_fingerprint or raw_scoring is
 * unavailable, or whose players cannot be resolved to a stat row, is marked UNEVALUABLE rather than defaulted to 0.
 */
export function buildStartSitOutcomes(
  captures: readonly StartSitCaptureRow[],
  actuals: WeekActuals,
  rawScoringByFingerprint: ReadonlyMap<string, Record<string, number>>,
  source = "sleeper-stats:v1",
): { outcomeRows: ShadowOutcomeRecord[]; decisions: StartSitDecisionOutcome[] } {
  const outcomeRows: ShadowOutcomeRecord[] = [];
  const decisions: StartSitDecisionOutcome[] = [];
  for (const cap of captures) {
    const rawScoring = cap.scoring_fingerprint ? rawScoringByFingerprint.get(cap.scoring_fingerprint) : undefined;
    const posOf = new Map(cap.record.adjustments.map((a) => [a.canonical_player_id, a.position]));
    const pointsByPlayer: Record<string, number> = {};
    if (rawScoring) {
      for (const a of cap.record.adjustments) {
        const pts = actualFor(a.canonical_player_id, a.position, actuals, rawScoring);
        if (pts != null) pointsByPlayer[a.canonical_player_id] = pts;
      }
      if (Object.keys(pointsByPlayer).length) {
        outcomeRows.push({ capture_id: cap.capture_id, source, recorded_at: new Date().toISOString(), scoring_fingerprint: cap.scoring_fingerprint, actual_fantasy_points: pointsByPlayer });
      }
    }
    for (const d of cap.record.decisions) {
      const posB = posOf.get(d.baseline_start), posF = posOf.get(d.fi_start);
      const ab = rawScoring && posB ? actualFor(d.baseline_start, posB, actuals, rawScoring) : null;
      const af = rawScoring && posF ? actualFor(d.fi_start, posF, actuals, rawScoring) : null;
      if (ab == null || af == null) {
        decisions.push({ capture_id: cap.capture_id, league_slug: cap.league_slug, manager_slug: cap.manager_slug, slot: d.slot, baseline_player: d.baseline_start, fi_player: d.fi_start, reversal: d.reversal,
          actual_baseline_points: ab, actual_fi_points: af, winner: "UNEVALUABLE", realized_margin: null, baseline_regret: null, fi_regret: null, severe_miss: false, reason: !rawScoring ? "scoring settings unavailable for this league's fingerprint" : "one or both players' actual points could not be resolved (no stat row / unsupported identity)" });
        continue;
      }
      const best = Math.max(ab, af);
      const margin = af - ab;
      decisions.push({ capture_id: cap.capture_id, league_slug: cap.league_slug, manager_slug: cap.manager_slug, slot: d.slot, baseline_player: d.baseline_start, fi_player: d.fi_start, reversal: d.reversal,
        actual_baseline_points: ab, actual_fi_points: af, winner: ab === af ? "TIE" : af > ab ? "FI" : "BASELINE", realized_margin: Math.round(margin * 100) / 100,
        baseline_regret: Math.round((best - ab) * 100) / 100, fi_regret: Math.round((best - af) * 100) / 100, severe_miss: Math.abs(margin) >= SEVERE_MISS_POINTS });
    }
  }
  return { outcomeRows, decisions };
}

/** Primary calibration uses ONLY `LIVE_CAPTURED` decisions (Step 9). Pass the capture_kind alongside each decision via `kindOf`. */
export function calibrateStartSit(decisions: readonly StartSitDecisionOutcome[], kindOf: (captureId: string) => StartSitCaptureRow["capture_kind"], contributionsByCapture: ReadonlyMap<string, StartSitCaptureRow["record"]["adjustments"]>): StartSitCalibration {
  const pristine = decisions.filter((d) => kindOf(d.capture_id) === "LIVE_CAPTURED");
  const evaluable = pristine.filter((d) => d.winner !== "UNEVALUABLE");
  const reversals = evaluable.filter((d) => d.reversal);
  const helped = reversals.filter((d) => d.winner === "FI");
  const hurt = reversals.filter((d) => d.winner === "BASELINE");
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000 : null);
  const byFamily: StartSitCalibration["by_family"] = {};
  for (const d of pristine) {
    const adjs = contributionsByCapture.get(d.capture_id) ?? [];
    const row = adjs.find((a) => a.canonical_player_id === d.fi_player) ?? adjs.find((a) => a.canonical_player_id === d.baseline_player);
    for (const c of row?.contributions ?? []) {
      const f = (byFamily[c.family] ??= { adjustment_count: 0, reversal_count: 0, mean_delta_regret: null });
      if (c.points_contribution !== 0) f.adjustment_count += 1;
      if (d.reversal) f.reversal_count += 1;
    }
  }
  for (const [fam, agg] of Object.entries(byFamily)) {
    const deltas = pristine.filter((d) => d.reversal && d.winner !== "UNEVALUABLE" && (contributionsByCapture.get(d.capture_id) ?? []).some((a) => a.contributions.some((c) => c.family === fam && c.points_contribution !== 0))).map((d) => (d.baseline_regret! - d.fi_regret!));
    agg.mean_delta_regret = mean(deltas);
  }
  return {
    evidence_class: "LIVE_CAPTURED", decisions_evaluated: evaluable.length, decisions_unevaluable: pristine.length - evaluable.length,
    reversals: reversals.length, reversals_helped: helped.length, reversals_hurt: hurt.length,
    mean_baseline_regret: mean(evaluable.map((d) => d.baseline_regret!)), mean_fi_regret: mean(evaluable.map((d) => d.fi_regret!)),
    by_family: byFamily,
    diagnostic_post_lock_decisions: decisions.filter((d) => kindOf(d.capture_id) === "LIVE_POST_LOCK").length,
    diagnostic_reconstructed_decisions: decisions.filter((d) => kindOf(d.capture_id) === "HISTORICALLY_RECONSTRUCTED" || kindOf(d.capture_id) === "LIVE_UNVERIFIED").length,
  };
}

export type { ShadowOutcomeRecord };
