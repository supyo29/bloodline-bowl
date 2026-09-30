/**
 * Derived calibration ANALYSIS layer: joins a certified Phase-1 ledger case to its pre-game role forecast and the observed
 * role of the completed game. Does NOT duplicate ledger cases — it stores keys (case_id, evidence_digest) plus derived numbers.
 *
 * Exact decomposition of the fantasy projection error (points, one league scoring fingerprint):
 *   actual - baseline  =  (actual - xFP_actual_opp)          efficiency / touchdown / randomness
 *                       + (xFP_actual_opp - xFP_forecast)    ROLE / OPPORTUNITY forecast error, priced in points
 *                       + (xFP_forecast - baseline)          baseline-vs-role-forecast disagreement (non-role baseline error)
 */
import { createHash } from "node:crypto";
import { opportunityFromObserved, expectedPoints } from "./xfp";
import { shadowCandidate, type ShadowCandidate } from "./shadow";
import type { ObservedRow, YieldTable } from "./data";
import { METRICS_BY_POSITION, ROLE_CALIBRATION_ANALYSIS_VERSION, type ExpectedOpportunity, type RoleForecast, type RoleMetricName, type RolePosition } from "./types";

export interface CaseLike {
  case_id: string; evidence_digest: string; season: number; week: number; league_slug: string; scoring_fingerprint: string; provider: string;
  canonical_player_id: string; provider_player_ids: Record<string, string>; player_name: string | null; nfl_team: string | null; position: string | null;
  projected_points: number | null; actual_fantasy_points: number | null; evidence_status: string; participation_state: string;
  projection_artifact_id: string | null; projection_artifact_kind: string | null; kickoff_at: string;
}
export interface ExclusionEntry { season: number; week: number; gsis_id: string; reason: string; note: string }
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export interface MetricComparison { forecast: number | null; forecast_with_pressure: number | null; actual: number | null; error: number | null; naive_last_game: number | null; naive_season_mean: number | null; prior_season_only: boolean }
export interface RoleAnalysisRow {
  analysis_id: string; analysis_version: string;
  case_id: string; evidence_digest: string; forecast_id: string | null;
  season: number; week: number; league_slug: string; provider: string; scoring_fingerprint: string;
  position: RolePosition; canonical_player_id: string; gsis_id: string | null; sleeper_id: string | null; player_name: string | null; nfl_team: string | null;
  baseline_projection: number | null; actual_fantasy_points: number | null; projection_error: number | null;
  forecast_capture_kind: string | null; forecast_confidence: string | null; confidence_score: number | null;
  role: Partial<Record<RoleMetricName, MetricComparison>>;
  opportunity: { forecast: ExpectedOpportunity | null; forecast_no_pressure: ExpectedOpportunity | null; actual: ExpectedOpportunity | null };
  xfp: { forecast: number | null; forecast_no_pressure: number | null; actual_opportunity: number | null };
  decomposition: { total_error: number | null; efficiency_td_residual: number | null; role_error_points: number | null; baseline_vs_role_gap: number | null } | null;
  labels: { designation: string; expected_absent: boolean; participated: boolean | null; injury_contamination: string | null; teammate_absence: boolean; depth_starter: boolean | null; role_trend: "STABLE" | "CHANGING" | "UNKNOWN"; role_volatility: number | null };
  eval_populations: { projection_eval: boolean; role_accuracy: boolean };
  exclusion_reasons: string[];
  shadow: ShadowCandidate | null;
  stats_note: string;
}

export interface BuildAnalysisInput {
  cases: readonly CaseLike[];
  forecasts: readonly RoleForecast[];
  observed: readonly ObservedRow[];
  yields: YieldTable | null;
  rawScoringByFingerprint: ReadonlyMap<string, Record<string, number>>;
  /** operator/auditable exclusion list */
  exclusions: readonly ExclusionEntry[];
  /** POST-game designations (outcome-side labeling ONLY; never an input to a forecast): key gsis or sleeper id */
  postgameInjury: ReadonlyMap<string, string>;
}

const lastObserved = (rows: readonly ObservedRow[], gsis: string, season: number, week: number): ObservedRow | null => {
  const g = rows.filter((r) => r.gsis_id === gsis && (r.season < season || (r.season === season && r.week < week)) && (r.offensive_snaps ?? 0) > 0).sort((a, b) => a.season - b.season || a.week - b.week);
  return g[g.length - 1] ?? null;
};

/** Latest forecast strictly frozen before this player's kickoff (same player-level rule as the Phase-1 ledger). LIVE wins over reconstruction only by being later/equal — ties: LIVE first. */
export function selectForecast(forecasts: readonly RoleForecast[], gsis: string | null, sleeper: string | null, season: number, week: number, kickoffIso: string): RoleForecast | null {
  const ko = Date.parse(kickoffIso);
  const mine = forecasts.filter((f) => f.season === season && f.week === week && ((gsis && f.gsis_id === gsis) || (sleeper && f.sleeper_id === sleeper)) && Date.parse(f.as_of_at) < ko);
  mine.sort((a, b) => Date.parse(b.as_of_at) - Date.parse(a.as_of_at) || (a.capture_kind === b.capture_kind ? 0 : a.capture_kind === "LIVE_CAPTURED" ? -1 : 1) || (a.forecast_id < b.forecast_id ? -1 : 1));
  return mine[0] ?? null;
}

export function buildRoleAnalysis(input: BuildAnalysisInput): RoleAnalysisRow[] {
  const bySleeper = new Map<string, ObservedRow[]>(), byGsis = new Map<string, ObservedRow[]>();
  for (const o of input.observed) { (byGsis.get(o.gsis_id) ?? byGsis.set(o.gsis_id, []).get(o.gsis_id)!).push(o); if (o.sleeper_id) (bySleeper.get(o.sleeper_id) ?? bySleeper.set(o.sleeper_id, []).get(o.sleeper_id)!).push(o); }
  const excl = new Map(input.exclusions.map((e) => [`${e.season}|${e.week}|${e.gsis_id}`, e]));
  const out: RoleAnalysisRow[] = [];
  for (const c of input.cases) {
    const pos = c.position as RolePosition;
    if (!["QB", "RB", "WR", "TE"].includes(pos)) continue;
    if (c.evidence_status !== "CERTIFIED" && c.evidence_status !== "CERTIFIED_APPROXIMATE_SCORING") continue;
    const sid = c.provider_player_ids?.sleeper_id ?? null;
    let gsis = c.provider_player_ids?.gsis_id ?? null;
    const sidRows = sid ? bySleeper.get(sid) : undefined;
    if (!gsis && sidRows?.[0]) gsis = sidRows[0].gsis_id;
    if (!gsis) { const m = /^player:gsis:(.+)$/.exec(c.canonical_player_id); if (m) gsis = m[1]!; }
    const f = selectForecast(input.forecasts, gsis, sid, c.season, c.week, c.kickoff_at);
    const rows = gsis ? byGsis.get(gsis) ?? [] : sidRows ?? [];
    const actualRow = rows.find((r) => r.season === c.season && r.week === c.week) ?? null;
    const lastGame = gsis ? lastObserved(input.observed, gsis, c.season, c.week) : null;
    const rawScoring = input.rawScoringByFingerprint.get(c.scoring_fingerprint) ?? null;
    const reasons: string[] = [];

    const role: RoleAnalysisRow["role"] = {};
    for (const m of METRICS_BY_POSITION[pos]) {
      const mf = f?.metrics[m];
      const actual = actualRow ? (m === "snap_share" ? actualRow.snap_share : (actualRow[m as keyof ObservedRow] as number | null)) : null;
      const last = lastGame ? (m === "snap_share" ? lastGame.snap_share : (lastGame[m as keyof ObservedRow] as number | null)) : null;
      role[m] = { forecast: mf?.value ?? null, forecast_with_pressure: mf?.value_with_pressure ?? null, actual: actual ?? null, error: mf?.value != null && actual != null ? r4(actual - mf.value) : null, naive_last_game: last ?? null, naive_season_mean: mf?.season_mean ?? null, prior_season_only: mf?.prior_season_only ?? false };
    }

    const actualOpp = actualRow ? opportunityFromObserved(pos, actualRow) : null;
    let xf: number | null = null, xfn: number | null = null, xa: number | null = null;
    if (rawScoring && input.yields) {
      if (f && f.confidence !== "INSUFFICIENT_SAMPLE") { xf = expectedPoints(pos, f.opportunity, input.yields, rawScoring); xfn = expectedPoints(pos, f.opportunity_no_pressure, input.yields, rawScoring); }
      if (actualOpp) xa = expectedPoints(pos, actualOpp, input.yields, rawScoring);
    }
    const base = c.projected_points, act = c.actual_fantasy_points;
    const decomposition = base != null && act != null && xf != null && xa != null
      ? { total_error: r4(act - base), efficiency_td_residual: r4(act - xa), role_error_points: r4(xa - xf), baseline_vs_role_gap: r4(xf - base) } : null;

    // ---- participation + injury labeling (§16) ---------------------------------------------------------------------
    const designation = f?.availability.designation ?? "UNKNOWN";
    const participated = actualRow ? (actualRow.offensive_snaps ?? 0) > 0 : (c.participation_state === "PLAYED_NORMAL" || c.participation_state === "PLAYED_LOW_SNAP_SHARE" ? true : false);
    let contamination: string | null = null;
    const manual = gsis ? excl.get(`${c.season}|${c.week}|${gsis}`) : undefined;
    if (manual) contamination = manual.reason;
    else if (participated && actualRow && f?.metrics.snap_share?.value != null && f.metrics.snap_share.value >= 0.3) {
      const post = (gsis && input.postgameInjury.get(gsis)) || (sid && input.postgameInjury.get(sid)) || null;
      if (post && (actualRow.snap_share ?? 1) < 0.6 * f.metrics.snap_share.value) contamination = "POSSIBLE_IN_GAME_INJURY";
    }
    const snapTrend = f?.metrics.snap_share, tgt = f?.metrics.target_share ?? f?.metrics.rush_share;
    const vol = tgt?.season_mean != null && tgt.value != null ? Math.abs(tgt.value - tgt.season_mean) : null;
    const roleTrend: RoleAnalysisRow["labels"]["role_trend"] = !tgt || tgt.value == null || tgt.season_mean == null ? "UNKNOWN" : Math.abs(tgt.value - tgt.season_mean) >= 0.08 ? "CHANGING" : "STABLE";
    void snapTrend;

    const expectedAbsent = f?.availability.expected_absent ?? false;
    if (!f) reasons.push("NO_PREGAME_ROLE_FORECAST");
    else if (f.confidence === "INSUFFICIENT_SAMPLE") reasons.push("ROLE_FORECAST_INSUFFICIENT_SAMPLE");
    if (expectedAbsent) reasons.push("EXPECTED_ABSENT_OFFICIAL_OUT");
    if (!participated) reasons.push("DID_NOT_PLAY");
    if (contamination) reasons.push(contamination);
    if (!actualRow) reasons.push("NO_OBSERVED_ROLE_ROW");
    // projection-level shadow evaluation keeps DNPs (a fantasy outcome) but drops injury-contaminated cases; role accuracy needs a forecast, an observed game, participation and no contamination
    const projectionEval = !!f && base != null && act != null && !contamination && xf != null;
    const roleAccuracy = !!f && f.confidence !== "INSUFFICIENT_SAMPLE" && !!actualRow && participated && !expectedAbsent && !contamination;

    let shadow: ShadowCandidate | null = null;
    if (f && base != null && xf != null && xfn != null) shadow = shadowCandidate({ baseline: base, xfp_forecast: xf, xfp_no_pressure: xfn, p_absent: f.availability.p_absent, confidence: f.confidence });

    const analysis_id = `ra:${createHash("sha256").update(JSON.stringify([ROLE_CALIBRATION_ANALYSIS_VERSION, c.case_id, c.evidence_digest, f?.forecast_id ?? null, actualRow ? [actualRow.season, actualRow.week, actualRow.carries, actualRow.targets, actualRow.offensive_snaps] : null, shadow?.candidate_projection ?? null, contamination])).digest("hex").slice(0, 24)}`;
    out.push({
      analysis_id, analysis_version: ROLE_CALIBRATION_ANALYSIS_VERSION, case_id: c.case_id, evidence_digest: c.evidence_digest, forecast_id: f?.forecast_id ?? null,
      season: c.season, week: c.week, league_slug: c.league_slug, provider: c.provider, scoring_fingerprint: c.scoring_fingerprint, position: pos, canonical_player_id: c.canonical_player_id, gsis_id: gsis, sleeper_id: sid, player_name: c.player_name, nfl_team: c.nfl_team,
      baseline_projection: base, actual_fantasy_points: act, projection_error: base != null && act != null ? r4(act - base) : null,
      forecast_capture_kind: f?.capture_kind ?? null, forecast_confidence: f?.confidence ?? null, confidence_score: f?.confidence_score ?? null,
      role, opportunity: { forecast: f?.opportunity ?? null, forecast_no_pressure: f?.opportunity_no_pressure ?? null, actual: actualOpp }, xfp: { forecast: xf, forecast_no_pressure: xfn, actual_opportunity: xa }, decomposition,
      labels: { designation, expected_absent: expectedAbsent, participated, injury_contamination: contamination, teammate_absence: !!f?.teammate_pressure && f.teammate_pressure.absent.some((a) => a.p_absent >= 0.75), depth_starter: f?.depth.starter ?? null, role_trend: roleTrend, role_volatility: vol },
      eval_populations: { projection_eval: projectionEval, role_accuracy: roleAccuracy }, exclusion_reasons: reasons, shadow,
      stats_note: "xFP uses prior-season league-wide yields per opportunity; threshold bonuses, 2-pt and WR/TE rushing are unmodeled on both sides",
    });
  }
  return out;
}
