/**
 * W2.R1 S8 live D/ST and K outputs from a FROZEN PREGAME CAPTURE (lib/w2r1/data/prospective/wkNN/kdst_components.json, produced before kickoff by the frozen S4 models).
 * Exact league scoring is applied in TypeScript with lib/w2r1/kdst.ts (golden-tested against R). SHADOW ONLY; production never imports this module.
 * No silent fallback: a league whose D/ST state is not QUALIFIED_SHADOW is shown with its true state and is never fed to Dynamic VOR as if qualified.
 */
import regimesJson from "../../scripts/w2r1/s4_regimes.json";
import { dWeights, expectedDstPoints, expectedKPoints, paScore, type DComponents, type KComponents, type Provider, type Scoring } from "./kdst";
import { dstQualification, kQualification, labelForecast, type LeagueSlug, type Qualification } from "./qualification";
import type { RosterAsset, MarketCandidate, WeekValue } from "./evidence";

export interface RegimeDef { provider: Provider; has_K: boolean; scoring: Scoring }
export const REGIMES = (regimesJson as { regimes: Record<string, RegimeDef> }).regimes;
export interface TeamCapture { team: string; opp: string; game_id: string; gameday: string; available: boolean; inputs: Record<string, number | boolean | null>; dst: DComponents & { pa_mean: number }; k: KComponents & { kicker_ratio: number; prev_kicker: string | null } }
export interface KdstCapture { meta: { schema: string; target_week: number; season: number; generated_at: string; data_through_week: number; frozen_models: Record<string, unknown>; weather_note: string; git_head: string }; teams: Record<string, TeamCapture> }

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** exact-scoring points by component group (sums to expectedDstPoints) */
export function dstBreakdown(c: DComponents, s: Scoring, p: Provider) {
  const d = dWeights(s, p); let epa = 0; for (let k = 0; k < c.pa_pmf.length; k++) epa += c.pa_pmf[k]! * paScore(k, d);
  const parts = {
    sacks: c.e_sacks * (d.sacks + d.sack_yd * c.mean_yds.sack_yd), interceptions: c.e_ints * (d.ints + d.int_ret_yd * c.mean_yds.int_ret_yd),
    fumble_recoveries: c.e_fr * (d.fumrec_def + d.fum_ret_yd * c.mean_yds.fum_ret_yd) + c.r_fumrec_st * d.fumrec_st, forced_fumbles: c.r_ff_def * d.ff_def + c.r_ff_st * d.ff_st,
    touchdowns: c.r_def_td * d.def_td + c.r_st_td * d.st_td + c.r_blk_td * d.blk_td, safeties: c.r_safeties * d.safeties, blocked_kicks: c.r_blk * d.blk,
    fourth_down_stops_and_forced_punts: c.r_stops4 * d.stops4 + c.r_forced_punts * d.forced_punts, return_yards: c.r_kr_yd * d.kr_yd + c.r_pr_yd * d.pr_yd, two_point_returns: c.r_def2pt * d.def2pt, points_allowed: epa,
  };
  return { parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

/** Approximate sd: independent Poisson event counts (value per event held at its mean) + the exact variance of the points-allowed score. A normal interval from it is APPROXIMATE (documented, MC-tested). */
export function dstUncertainty(c: DComponents, s: Scoring, p: Provider): { sd: number; interval_80: [number, number]; method: string } {
  const d = dWeights(s, p); const m = expectedDstPoints(c, s, p);
  const ev = (lam: number, v: number) => lam * v * v;
  let varc = ev(c.e_sacks, d.sacks + d.sack_yd * c.mean_yds.sack_yd) + ev(c.e_ints, d.ints + d.int_ret_yd * c.mean_yds.int_ret_yd) + ev(c.e_fr, d.fumrec_def + d.fum_ret_yd * c.mean_yds.fum_ret_yd)
    + ev(c.r_fumrec_st, d.fumrec_st) + ev(c.r_ff_def, d.ff_def) + ev(c.r_ff_st, d.ff_st) + ev(c.r_def_td, d.def_td) + ev(c.r_st_td, d.st_td) + ev(c.r_blk_td, d.blk_td) + ev(c.r_safeties, d.safeties) + ev(c.r_blk, d.blk)
    + ev(c.r_stops4, d.stops4) + ev(c.r_forced_punts, d.forced_punts) + ev(c.r_def2pt, d.def2pt);
  let ep = 0, ep2 = 0; for (let k = 0; k < c.pa_pmf.length; k++) { const v = paScore(k, d); ep += c.pa_pmf[k]! * v; ep2 += c.pa_pmf[k]! * v * v; }
  varc += ep2 - ep * ep; const sd = Math.sqrt(varc);
  return { sd: r2(sd), interval_80: [r2(m - 1.2816 * sd), r2(m + 1.2816 * sd)], method: "normal approximation from independent Poisson components + exact points-allowed variance (approximate)" };
}

export interface DstLive {
  league: string; team: string; week: number; opponent: string; gameday: string;
  qualification: Qualification; forecast_label: ReturnType<typeof labelForecast>;
  expected_points: number; reconstructed_exact_league_score: { provider: Provider; regime: string; scoring_keys: Record<string, number>; note: string };
  component_expected_points: Record<string, number>;
  expectations: { sacks: number; interceptions: number; fumble_recoveries_defense: number; fumble_recoveries_special_teams: number; defensive_td: number; special_teams_td: number; blocked_kick_td: number; safeties: number; points_allowed_mean: number };
  points_allowed_distribution: { p0: number; p1_6: number; p7_13: number; p14_20: number; p21_27: number; p28_34: number; p35_plus: number };
  uncertainty: { sd: number; interval_80: [number, number]; method: string };
  evidence_timestamp: string; data_through_week: number; model_version: string; frozen_model_hashes: Record<string, unknown>; caveats: string[];
}
const PA_BINS: Array<[keyof DstLive["points_allowed_distribution"], number, number]> = [["p0", 0, 0], ["p1_6", 1, 6], ["p7_13", 7, 13], ["p14_20", 14, 20], ["p21_27", 21, 27], ["p28_34", 28, 34], ["p35_plus", 35, 70]];

export const DST_MODEL_VERSION = "w2r1-s4-dst-components-frozen-2026.0";
export function dstForTeam(cap: KdstCapture, league: string, team: string, source: "W2R1_COMPONENT_MODEL" | "INHERITED_GENERIC" = "W2R1_COMPONENT_MODEL"): DstLive | { unavailable: true; reason: string; qualification: Qualification } {
  const q = dstQualification(league); const reg = REGIMES[league];
  if (!reg) return { unavailable: true, reason: "no registered W2.R1 scoring regime for this league", qualification: q };
  const t = cap.teams[team];
  if (!t) return { unavailable: true, reason: `team ${team} has no game in week ${cap.meta.target_week} capture (bye or unknown)`, qualification: q };
  if (!t.available) return { unavailable: true, reason: "pregame inputs missing (e.g. schedule line not posted); never defaulted", qualification: { ...q, state: "UNAVAILABLE" } };
  const c = t.dst; const bd = dstBreakdown(c, reg.scoring, reg.provider); const total = expectedDstPoints(c, reg.scoring, reg.provider);
  const dist = Object.fromEntries(PA_BINS.map(([k, lo, hi]) => [k, c.pa_pmf.slice(lo, hi + 1).reduce((a, b) => a + b, 0)])) as DstLive["points_allowed_distribution"];
  return {
    league, team, week: cap.meta.target_week, opponent: t.opp, gameday: t.gameday, qualification: q, forecast_label: labelForecast(source, q),
    expected_points: r2(total), reconstructed_exact_league_score: { provider: reg.provider, regime: league, scoring_keys: reg.scoring, note: "exact league scoring keys; provider-specific D/ST semantics (see s7 adjudication D)" },
    component_expected_points: Object.fromEntries(Object.entries(bd.parts).map(([k, v]) => [k, r2(v)])),
    expectations: { sacks: r2(c.e_sacks), interceptions: r2(c.e_ints), fumble_recoveries_defense: r2(c.e_fr), fumble_recoveries_special_teams: r2(c.r_fumrec_st), defensive_td: r4(c.r_def_td), special_teams_td: r4(c.r_st_td), blocked_kick_td: r4(c.r_blk_td), safeties: r4(c.r_safeties), points_allowed_mean: r2(c.pa_mean) },
    points_allowed_distribution: Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) as DstLive["points_allowed_distribution"],
    uncertainty: dstUncertainty(c, reg.scoring, reg.provider), evidence_timestamp: cap.meta.generated_at, data_through_week: cap.meta.data_through_week, model_version: DST_MODEL_VERSION, frozen_model_hashes: cap.meta.frozen_models, caveats: q.caveats,
  };
}

export function kForTeam(cap: KdstCapture, league: string, team: string) {
  const q = kQualification(league); const reg = REGIMES[league]; const t = cap.teams[team];
  if (!reg || !reg.has_K) return { unavailable: true as const, reason: "no kicker slot / regime for this league", qualification: q };
  if (!t || !t.available) return { unavailable: true as const, reason: t ? "pregame inputs missing" : "no game this week", qualification: { ...q, state: "UNAVAILABLE" as const } };
  return { league, team, week: cap.meta.target_week, qualification: q, forecast_label: labelForecast("W2R1_COMPONENT_MODEL", q), expected_points: r2(expectedKPoints(t.k, reg.scoring)), expected_fg_attempts: r2(t.k.e_fg), expected_xp_attempts: r2(t.k.e_xp), evidence_timestamp: cap.meta.generated_at, model_version: "w2r1-s4-k-components-frozen-2026.0", note: "DIAGNOSTIC_ONLY — not W2.R1-qualified; prospective component predictions are being collected" };
}

/**
 * Dynamic-VOR integration: ONLY for QUALIFIED_SHADOW leagues, replace the CURRENT-WEEK value of D/ST assets with the W2.R1 component forecast.
 * Future weeks keep the inherited generic value and are labelled as such (no qualified future-week D/ST model exists). Returns copies; inputs are never mutated.
 */
export function applyQualifiedDst<T extends RosterAsset | MarketCandidate>(assets: readonly T[], cap: KdstCapture, league: string, week: number): { assets: T[]; replaced: Array<{ player_id: string; team: string; value: number }>; state: Qualification["state"] } {
  const q = dstQualification(league);
  if (q.state !== "QUALIFIED_SHADOW" || cap.meta.target_week !== week) return { assets: assets.map((a) => a), replaced: [], state: q.state };
  const replaced: Array<{ player_id: string; team: string; value: number }> = [];
  const out = assets.map((a) => {
    if (a.position !== "DEF" || !a.team) return a;
    const live = dstForTeam(cap, league, a.team); const cur = a.weeks[week];
    if ("unavailable" in live || !cur || cur.state === "BYE") return a;
    const wv: WeekValue = { state: "ACTIVE", lineup: live.expected_points, underlying: live.expected_points };
    replaced.push({ player_id: a.player_id, team: a.team, value: live.expected_points });
    return { ...a, weeks: { ...a.weeks, [week]: wv }, confidence: "MEDIUM" as const, missing_evidence: [...a.missing_evidence, "future weeks: inherited generic D/ST forecast (not W2.R1-qualified)"], provenance: { ...a.provenance, source: `${a.provenance.source}+W2R1_DST_COMPONENT_MODEL(current week only)`, version: DST_MODEL_VERSION } };
  });
  return { assets: out as T[], replaced, state: q.state };
}
export type { LeagueSlug };
