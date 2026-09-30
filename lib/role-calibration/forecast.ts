/**
 * Pre-game role forecast. Deterministic, interpretable, point-in-time.
 *
 *   value        = the canonical Role Intelligence profile evaluated at a synthetic NA row for the target week
 *                  (analysis/role_calibration/export_role_inputs.R): EWMA (half-life 2 games) over strictly-earlier games with
 *                  the prior season included by recency weighting — early-season blending is the profile's own, never re-invented.
 *   pressure     = teammate-availability redistribution from the FROZEN Opportunity Propagation model
 *                  (`allocateHierarchical` + its inheritance priors), fed with as-of shares — never with any target-week outcome.
 *   volumes      = EWMA team pass/rush volume (game script is Phase 3).
 *   confidence   = falls with thin current-season samples, team/position discontinuity, layoffs; missing stays missing.
 *
 * Leakage contract (asserted by `assertPointInTime`): every input game is strictly earlier than the target week, the injury
 * designation is the official designation for that team-week, the depth chart is the latest snapshot strictly before kickoff,
 * and `data_cutoff_at`/`as_of_at` are strictly before kickoff.
 */
import { createHash } from "node:crypto";
import { allocateHierarchical, type CandidateInput } from "@/lib/opportunity-propagation-intelligence/model";
import type { OpportunityPropagationModel } from "@/lib/opportunity-propagation-intelligence/schema";
import type { DepthRow, InjuryRow, ObservedRow, ProfileMetricRow, ProfileRow } from "./data";
import { forecastQbVolume, forecastTeamVolume, latestUsedGame } from "./volume";
import {
  METRICS_BY_POSITION, ROLE_FORECAST_VERSION, type CaptureKind, type DepthState, type ExpectedOpportunity, type ForecastConfidence, type InjuryDesignation,
  type MetricForecast, type RoleForecast, type RoleMetricName, type RolePosition, type TeammateAbsence, type TeammatePressure,
} from "./types";

/** Hand-specified, unfitted expected-availability weights for a teammate's official designation. */
export const P_ABSENT: Record<InjuryDesignation, number> = { OUT: 1, DOUBTFUL: 0.75, QUESTIONABLE: 0.25, NONE: 0, UNKNOWN: 0 };
/** A completed game is treated as fully settled this long after kickoff when stating the data cutoff. */
export const GAME_SETTLE_MS = 4 * 3600_000;
const SUPPORTED_ABSENT = new Set(["RB", "WR", "TE"]);
const PRIMARY_METRICS: Record<RolePosition, readonly RoleMetricName[]> = { QB: ["snap_share"], RB: ["rush_share", "target_share"], WR: ["target_share"], TE: ["target_share"] };
const PRESSURE_DIMENSIONS: ReadonlySet<RoleMetricName> = new Set(["snap_share", "rush_share", "position_group_rush_share", "target_share", "position_group_target_share", "air_yards_share", "rz_carry_share", "rz_target_share"]);

export function designationOf(injuries: readonly InjuryRow[], season: number, week: number, gsis: string): InjuryDesignation {
  const weekRows = injuries.filter((r) => r.season === season && r.week === week);
  if (!weekRows.length) return "UNKNOWN"; // no official report exists yet for this week: unknown is NOT healthy
  const row = weekRows.find((r) => r.gsis_id === gsis);
  const s = (row?.report_status ?? "").trim().toLowerCase();
  if (!row) return "NONE";
  return s === "out" ? "OUT" : s === "doubtful" ? "DOUBTFUL" : s === "questionable" ? "QUESTIONABLE" : "NONE";
}

export function depthStateFor(depth: readonly DepthRow[], team: string, gsis: string, position: string, beforeIso: string | null): DepthState {
  const t = beforeIso ? Date.parse(beforeIso) : Infinity;
  const own = depth.filter((d) => d.gsis_id === gsis && d.team === team && d.pos_abb === position && Date.parse(d.dt) < t).sort((a, b) => Date.parse(b.dt) - Date.parse(a.dt));
  const hit = own[0];
  return hit ? { rank: hit.pos_rank, starter: hit.pos_rank == null ? null : hit.pos_rank === 1, snapshot_at: hit.dt } : { rank: null, starter: null, snapshot_at: null };
}

function metricForecast(pm: ProfileMetricRow | undefined, pos: RolePosition, metric: RoleMetricName): MetricForecast | null {
  if (!pm) return null;
  const value = pm.recent; // the canonical as-of EWMA (null when no evidence exists — never zero)
  const priorOnly = value != null && pm.n_games === 0;
  let confidence: ForecastConfidence = "INSUFFICIENT_SAMPLE";
  if (value != null) confidence = pm.n_games >= 3 && (pm.discontinuity ?? "NONE") === "NONE" && pm.conf === "MEDIUM" ? "MEDIUM" : "LOW";
  // routes: 2026 participation data is unpublished, so the value can only be prior-season evidence — never above LOW.
  if (metric === "route_participation" && confidence === "MEDIUM") confidence = "LOW";
  void pos;
  return { value, value_with_pressure: value, season_mean: pm.season, prior: pm.prior, n_games_season: pm.n_games, opportunity_total: pm.opp_total, prior_conf: pm.prior_conf, discontinuity: pm.discontinuity, confidence, prior_season_only: priorOnly };
}

export interface ForecastInput {
  season: number; week: number;
  profile: ProfileRow;
  teammates: readonly ProfileRow[];
  observed: readonly ObservedRow[];
  injuries: readonly InjuryRow[];
  depth: readonly DepthRow[];
  propagation: OpportunityPropagationModel | null;
  nflGameId: string | null; kickoffAt: string | null;
  asOfAt: string; captureKind: CaptureKind;
  /** kickoff instant of a completed earlier game (season, week, team) — used only to state the data cutoff */
  priorGameKickoff: (season: number, week: number, team: string) => string | null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const mul = (a: number | null | undefined, b: number | null | undefined): number | null => (a == null || b == null ? null : a * b);

export function opportunityFrom(pos: RolePosition, s: { rush_share?: number | null; rz_carry_share?: number | null; target_share?: number | null; rz_target_share?: number | null }, v: { team_pass_att: number | null; team_rush_att: number | null; team_rz_pass_att: number | null; team_rz_rush_att: number | null }, qb: { dropbacks: number | null; designed_rushes: number | null; scrambles: number | null } | null): ExpectedOpportunity {
  const empty: ExpectedOpportunity = { carries: null, rz_carries: null, targets: null, rz_targets: null, dropbacks: null, rz_dropbacks: null, designed_rushes: null, scrambles: null };
  if (pos === "QB") {
    const rzRatio = v.team_pass_att && v.team_rz_pass_att != null ? Math.min(1, v.team_rz_pass_att / v.team_pass_att) : null;
    return { ...empty, dropbacks: qb?.dropbacks ?? null, rz_dropbacks: mul(qb?.dropbacks, rzRatio), designed_rushes: qb?.designed_rushes ?? null, scrambles: qb?.scrambles ?? null };
  }
  const carries = pos === "RB" ? mul(s.rush_share, v.team_rush_att) : null; // WR/TE rushing is not modeled (identically on the actual side)
  const rzCarries = pos === "RB" ? mul(s.rz_carry_share, v.team_rz_rush_att) : null;
  const targets = mul(s.target_share, v.team_pass_att);
  const rzTargets = mul(s.rz_target_share, v.team_rz_pass_att);
  return { ...empty, carries, rz_carries: carries != null && rzCarries != null ? Math.min(rzCarries, carries) : rzCarries, targets, rz_targets: targets != null && rzTargets != null ? Math.min(rzTargets, targets) : rzTargets };
}

function overallConfidence(pos: RolePosition, metrics: Partial<Record<RoleMetricName, MetricForecast>>, profile: ProfileRow): { confidence: ForecastConfidence; score: number; reasons: string[] } {
  const reasons: string[] = [];
  const primary = PRIMARY_METRICS[pos].map((m) => metrics[m]);
  if (primary.some((m) => !m || m.value == null)) { reasons.push("PRIMARY_ROLE_METRIC_UNAVAILABLE"); return { confidence: "INSUFFICIENT_SAMPLE", score: 0, reasons }; }
  const n = profile.games_before_target_season;
  let score = n / (n + 3);
  if (n < 3) reasons.push("EARLY_SEASON_THIN_CURRENT_SAMPLE");
  if (n === 0) reasons.push("PRIOR_SEASON_ONLY");
  if (primary.some((m) => (m!.discontinuity ?? "NONE") !== "NONE")) { score *= 0.5; reasons.push("TEAM_OR_POSITION_DISCONTINUITY"); }
  const confidence: ForecastConfidence = primary.every((m) => m!.confidence === "MEDIUM") ? "MEDIUM" : "LOW";
  return { confidence, score: Math.round(score * 1000) / 1000, reasons };
}

export function buildRoleForecast(input: ForecastInput): RoleForecast {
  const { profile, season, week } = input;
  const pos = profile.position as RolePosition;
  const reasons: string[] = [];
  const designation = designationOf(input.injuries, season, week, profile.gsis_id);
  const p_absent = P_ABSENT[designation];
  if (designation === "UNKNOWN") reasons.push("NO_OFFICIAL_INJURY_REPORT_YET");

  const metrics: Partial<Record<RoleMetricName, MetricForecast>> = {};
  for (const m of METRICS_BY_POSITION[pos]) { const mf = metricForecast(profile.metrics[m], pos, m); if (mf) metrics[m] = mf; }

  // ---- teammate-availability pressure (frozen propagation model; as-of shares only) ------------------------------------
  let pressure: TeammatePressure | null = null;
  const selfAbsent = p_absent >= 0.75;
  // QBs are never a redistribution beneficiary here (the propagation model is a skill-position model; QB role is a different schema)
  if (input.propagation && !selfAbsent && pos !== "QB") {
    const mates = input.teammates.filter((t) => t.team === profile.team && t.gsis_id !== profile.gsis_id);
    const absent: TeammateAbsence[] = [];
    for (const t of mates) {
      const d = designationOf(input.injuries, season, week, t.gsis_id);
      if (P_ABSENT[d] > 0 && SUPPORTED_ABSENT.has(t.position)) absent.push({ gsis_id: t.gsis_id, position: t.position, designation: d, p_absent: P_ABSENT[d], prior_shares: Object.fromEntries(([...PRESSURE_DIMENSIONS] as RoleMetricName[]).map((m) => [m, t.metrics[m]?.recent ?? null])) });
    }
    if (absent.length) {
      const absentIds = new Set(absent.filter((a) => a.p_absent >= 0.75).map((a) => a.gsis_id));
      // beneficiary pool: healthy teammates who have actually played this season (stale/zero-game roster entries are never beneficiaries), plus this player
      const pool = [profile, ...mates.filter((t) => !absentIds.has(t.gsis_id) && t.games_before_target_season >= 1)];
      const deltas: Partial<Record<RoleMetricName, number>> = {};
      for (const m of Object.keys(metrics) as RoleMetricName[]) {
        if (!PRESSURE_DIMENSIONS.has(m) || metrics[m]!.value == null) continue;
        const dim = input.propagation.dimensions.find((d) => d.dimension === m);
        if (!dim) continue;
        let total = 0, hit = false;
        for (const a of absent) {
          if (!(dim.positions as string[]).includes(a.position)) continue;
          const vacated = a.prior_shares[m];
          if (vacated == null) continue; // unknown prior role: no fabricated redistribution
          const cands: CandidateInput[] = pool.filter((t) => (dim.positions as string[]).includes(t.position)).map((t) => ({ gsis_id: t.gsis_id, position: t.position, pre_event_recent: t.metrics[m]?.recent ?? null, pre_event_season: t.metrics[m]?.season ?? null }));
          const preds = allocateHierarchical(input.propagation, profile.team, a.position, m, vacated * a.p_absent, cands);
          const mine = preds.find((p) => p.gsis_id === profile.gsis_id);
          // An absence can only ADD opportunity for a healthy teammate; the model's share renormalization can push a delta negative when the pool's
          // pre-event shares already sum past 1 (a stale-pool artifact) — such reductions are suppressed, never applied.
          if (mine) { total += Math.max(0, mine.predicted_delta); hit = true; }
        }
        if (hit) deltas[m] = Math.round(total * 1e6) / 1e6;
      }
      pressure = { absent, support_level: absent.length === 1 ? "CALIBRATED" : "EXPERIMENTAL_MULTI_ABSENCE", deltas, source: `opportunity-propagation ${input.propagation.manifest.opportunity_propagation_version}` };
      const primaryDelta = PRIMARY_METRICS[pos].reduce((t, m) => t + Math.abs(deltas[m] ?? 0), 0);
      if (primaryDelta >= 0.01) reasons.push("TEAMMATE_ABSENCE_PRESSURE");
      for (const m of Object.keys(deltas) as RoleMetricName[]) { const mf = metrics[m]!; if (mf.value != null) mf.value_with_pressure = clamp01(mf.value + deltas[m]!); }
    }
  }

  // ---- volumes + expected opportunity -----------------------------------------------------------------------------
  const volumes = forecastTeamVolume(input.observed, profile.team, season, week);
  const qbVol = pos === "QB" ? forecastQbVolume(input.observed, profile.gsis_id, season, week) : null;
  const base = (m: RoleMetricName) => metrics[m]?.value ?? null;
  const withP = (m: RoleMetricName) => metrics[m]?.value_with_pressure ?? null;
  const opportunity_no_pressure = opportunityFrom(pos, { rush_share: base("rush_share"), rz_carry_share: base("rz_carry_share"), target_share: base("target_share"), rz_target_share: base("rz_target_share") }, volumes, qbVol);
  const opportunity = opportunityFrom(pos, { rush_share: withP("rush_share"), rz_carry_share: withP("rz_carry_share"), target_share: withP("target_share"), rz_target_share: withP("rz_target_share") }, volumes, qbVol);

  const depth = depthStateFor(input.depth, profile.team, profile.gsis_id, pos, input.kickoffAt ?? input.asOfAt);
  if (depth.snapshot_at == null) reasons.push("NO_DEPTH_CHART_SNAPSHOT");

  const conf = overallConfidence(pos, metrics, profile);
  reasons.push(...conf.reasons);
  if (designation === "OUT") reasons.push("EXPECTED_ABSENT_OFFICIAL_OUT");

  // ---- point-in-time cutoff ---------------------------------------------------------------------------------------
  const last = latestUsedGame(input.observed, season, week, profile.team, profile.gsis_id);
  const lastKick = last ? input.priorGameKickoff(last.season, last.week, profile.team) : null;
  const data_cutoff_at = lastKick ? new Date(Date.parse(lastKick) + GAME_SETTLE_MS).toISOString() : null;
  const priorSeasonOnly = Object.values(metrics).length > 0 && PRIMARY_METRICS[pos].every((m) => metrics[m]?.prior_season_only);

  const core = { v: ROLE_FORECAST_VERSION, season, week, key: profile.gsis_id, kind: input.captureKind, metrics: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, [m!.value, m!.value_with_pressure, m!.n_games_season, m!.confidence]])), vol: volumes, opp: opportunity, avail: [designation], depth: [depth.rank, depth.snapshot_at], pressure: pressure?.deltas ?? null, cutoff: last };
  const forecast_id = `rf:${createHash("sha256").update(JSON.stringify(core)).digest("hex").slice(0, 24)}`;

  return {
    forecast_id, forecast_version: ROLE_FORECAST_VERSION, season, week, gsis_id: profile.gsis_id, sleeper_id: profile.sleeper_id, player_name: profile.full_name, nfl_team: profile.team, position: pos,
    nfl_game_id: input.nflGameId, kickoff_at: input.kickoffAt, capture_kind: input.captureKind, as_of_at: input.asOfAt, data_cutoff_at, data_cutoff_week: last ? last.week : null,
    metrics, volumes, opportunity, opportunity_no_pressure, availability: { designation, p_absent, expected_absent: designation === "OUT" }, depth, teammate_pressure: pressure,
    confidence: conf.confidence, confidence_score: conf.score, prior_season_only: priorSeasonOnly, reason_codes: [...new Set(reasons)],
    provenance: { profile_source: "lib/role-calibration/data/role_profile_asof.csv (canonical analysis/player_role build_role_profile at a synthetic NA target-week row)", role_substrate: "analysis/player_role player_game_role (nflverse pbp + snap_counts)", injury_source: "nflverse team-week official designation", depth_source: "nflverse/ESPN depth chart snapshots (dt < kickoff)", route_note: "2026 route participation unpublished upstream; route metrics are prior-season evidence only", roster_team_source: profile.roster_team_source, last_game: last },
  };
}

/** The leakage contract, checkable on any forecast. Returns violations (empty = point-in-time valid). */
export function assertPointInTime(f: Pick<RoleForecast, "season" | "week" | "kickoff_at" | "as_of_at" | "data_cutoff_at" | "data_cutoff_week" | "provenance">): string[] {
  const v: string[] = [];
  const last = (f.provenance as { last_game?: { season: number; week: number } | null }).last_game;
  if (last && (last.season > f.season || (last.season === f.season && last.week >= f.week))) v.push(`input game ${last.season} wk${last.week} is not strictly before target wk${f.week}`);
  if (f.kickoff_at) {
    const ko = Date.parse(f.kickoff_at);
    if (!(Date.parse(f.as_of_at) < ko)) v.push("as_of_at is not strictly before kickoff");
    if (f.data_cutoff_at && !(Date.parse(f.data_cutoff_at) < ko)) v.push("data_cutoff_at is not strictly before kickoff");
  }
  return v;
}
