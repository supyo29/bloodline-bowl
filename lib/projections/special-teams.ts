/**
 * K / DEF production projection coverage — `ri-kicker-2026.1` / `ri-defense-2026.1`.
 *
 * The frozen offensive structural model (`ri-structural-2026.3`) never covered
 * kickers or team defenses, which left the snake engine permanently `DEGRADED`.
 * This module adds first-class K/DEF `LeagueProjection` rows so every required
 * position group has real, scoring-config-driven coverage.
 *
 * Design:
 *   - Opportunity / accuracy / component rates come from a REPRODUCIBLE vendored
 *     snapshot (`data/special-teams-2026.json`), extracted from the Roster Intel
 *     R pipeline's Bloodline K/DST models (`k_rankings.csv` / `dst_rankings.csv`,
 *     model `bloodline_2026_phase3_enrichment_v1`, projections as-of 2026-08-26).
 *   - Points are (re)computed HERE from those component rates through the LIVE
 *     league `scoring_settings` using the SAME `calculateFantasyPoints` engine
 *     Layer 2 uses — no scoring math is duplicated, and a Bloodline scoring
 *     change flows straight through.
 *   - Kicker JOB SECURITY is a multi-signal gate against the LIVE Sleeper player
 *     index (current team, depth_chart_order, status) crossed with the snapshot.
 *     The snapshot's depth chart is months old; a kicker only enters the
 *     production pool when the CURRENT signals agree he holds the job.
 *
 * Nothing in the frozen offensive / market / survival / decision path is touched.
 */

import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

import type { LeagueScoringContext } from "./league";
import type { FantasyPosition, LeagueProjection, OutcomeBand, ProjectionConfidence } from "./schema";
import snapshot from "./data/special-teams-2026.json";

export const KICKER_MODEL_VERSION = "ri-kicker-2026.1";
export const DEFENSE_MODEL_VERSION = "ri-defense-2026.1";

/* ------------------------------------------------------------------ snapshot */

interface KickerRow {
  team: string;
  name: string;
  sleeper_id: string | null;
  depth_rank: number | null;
  depth_chart_role: string | null;
  role_confidence: string | null;
  projection_confidence: string | null;
  projection_tier: string | null;
  current_status: string | null;
  injury_status: string | null;
  fg_att: number | null;
  fg_made: number | null;
  fg_missed: number | null;
  xp_att: number | null;
  xp_made: number | null;
  xp_missed: number | null;
  projected_bloodline_points: number | null;
  floor_points: number | null;
  ceiling_points: number | null;
  replacement_points: number | null;
}
interface DefenseRow {
  team: string;
  name: string;
  projection_confidence: string | null;
  projection_tier: string | null;
  projected_bloodline_points: number | null;
  floor_points: number | null;
  ceiling_points: number | null;
  sacks: number | null;
  sack_yards: number | null;
  interceptions: number | null;
  interception_return_yards: number | null;
  forced_fumbles: number | null;
  fumble_recoveries: number | null;
  fumble_return_yards: number | null;
  safeties: number | null;
  blocked_kicks: number | null;
  blocked_kick_return_yards: number | null;
  defensive_touchdowns: number | null;
  special_teams_touchdowns: number | null;
  kickoff_return_yards: number | null;
  punt_return_yards: number | null;
  fourth_down_stops: number | null;
  forced_punts: number | null;
  points_allowed_points: number | null;
}
interface Snapshot {
  _meta: {
    model_version: string;
    scoring_version: string;
    projection_as_of: string;
    depth_chart_as_of: string;
    derived_at: string;
    season: number;
  };
  kickers: KickerRow[];
  defenses: DefenseRow[];
}
const SNAP = snapshot as unknown as Snapshot;

/** The 32 NFL team codes a canonical team-defense pool must cover. */
export const NFL_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB",
  "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
] as const;

/* ------------------------------------------------------------- kicker role */

export type KickerRoleConfidence = "HIGH" | "MEDIUM" | "LOW" | "INVALID";

const OUT_STATUSES = new Set(["Inactive", "Injured Reserve", "IR", "PUP", "Non Football Injury", "Suspended"]);
const OUT_INJURY = new Set(["IR", "Out", "Doubtful", "PUP", "Suspended"]);

export interface KickerRoleResult {
  confidence: KickerRoleConfidence;
  reasons: string[];
  live_team: string | null;
  live_depth_chart_order: number | null;
  snapshot_team: string;
  team_agrees: boolean;
}

/**
 * Multi-signal job-security check. `livePlayer` is the CURRENT Sleeper record;
 * `teamStarterExists` is true when another kicker on the live team is
 * depth_chart_order 1. `depth_chart_order === 1` alone is NOT sufficient and
 * `=== 1` alone is NOT required — the signals must agree.
 */
export function resolveKickerRole(
  snap: KickerRow,
  livePlayer: NormalizedPlayer | undefined,
  teamStarterExists: boolean,
): KickerRoleResult {
  const reasons: string[] = [];
  const liveTeam = livePlayer?.team ?? null;
  const dco = livePlayer?.depth_chart_order ?? null;
  const teamAgrees = liveTeam != null && liveTeam === snap.team;

  const base: Omit<KickerRoleResult, "confidence"> = {
    reasons,
    live_team: liveTeam,
    live_depth_chart_order: dco,
    snapshot_team: snap.team,
    team_agrees: teamAgrees,
  };

  // ---- hard INVALID ----------------------------------------------------
  if (!livePlayer || !livePlayer.player_id) {
    reasons.push("no live Sleeper record");
    return { ...base, confidence: "INVALID" };
  }
  if (!liveTeam) {
    reasons.push("no current NFL team");
    return { ...base, confidence: "INVALID" };
  }
  if (livePlayer.active === false) {
    reasons.push("not active");
    return { ...base, confidence: "INVALID" };
  }
  if (livePlayer.status && OUT_STATUSES.has(livePlayer.status)) {
    reasons.push(`roster status ${livePlayer.status}`);
    return { ...base, confidence: "INVALID" };
  }
  if (livePlayer.injury_status && OUT_INJURY.has(livePlayer.injury_status)) {
    reasons.push(`injury status ${livePlayer.injury_status}`);
    return { ...base, confidence: "INVALID" };
  }
  if (typeof dco === "number" && dco >= 2) {
    reasons.push(`live depth_chart_order ${dco} — behind the starter`);
    return { ...base, confidence: "INVALID" };
  }
  if (dco == null && teamStarterExists) {
    reasons.push("no live depth_chart_order and another kicker on the team is depth 1");
    return { ...base, confidence: "LOW" };
  }
  if (snap.projection_tier === "TIER_D_UNIVERSE_ONLY") {
    reasons.push("no projection in the model universe");
    return { ...base, confidence: "LOW" };
  }

  const starterByDepth = dco === 1;
  const soleKicker = dco == null && !teamStarterExists;
  const tierA = snap.projection_tier === "TIER_A_CURRENT_DIRECT";
  const roleHigh = (snap.role_confidence ?? "").toUpperCase() === "HIGH";

  // ---- HIGH ----------------------------------------------------------
  if (starterByDepth && teamAgrees && (tierA || roleHigh)) {
    reasons.push("live depth-1 on the projected team with a current direct projection");
    return { ...base, confidence: "HIGH" };
  }
  // ---- MEDIUM ------------------------------------------------------
  if (starterByDepth || soleKicker) {
    if (!teamAgrees) reasons.push(`live team ${liveTeam} differs from the snapshot team ${snap.team} — team-neutral value`);
    if (!tierA && !roleHigh) reasons.push("projection is modeled / single-input, not multi-source current");
    if (soleKicker) reasons.push("sole active kicker on the team, no depth chart");
    return { ...base, confidence: "MEDIUM" };
  }
  reasons.push("job security not corroborated by current signals");
  return { ...base, confidence: "LOW" };
}

/* ----------------------------------------------------------- point scoring */

/** K season stat line -> the key space `calculateFantasyPoints` expects. */
function kickerStatLine(k: KickerRow): Record<string, number> {
  return {
    fgm: k.fg_made ?? 0,
    fgmiss: k.fg_missed ?? 0,
    xpm: k.xp_made ?? 0,
    xpmiss: k.xp_missed ?? 0,
  };
}

/** DEF season stat line -> the same key space. `pts_allow` is the season TOTAL
 *  points allowed (backed out of the snapshot's already-scored contribution). */
function defenseStatLine(d: DefenseRow, ptsAllowRate: number): Record<string, number> {
  const ptsAllowTotal = ptsAllowRate !== 0 ? (d.points_allowed_points ?? 0) / ptsAllowRate : 0;
  return {
    sack: d.sacks ?? 0,
    sack_yd: d.sack_yards ?? 0,
    int: d.interceptions ?? 0,
    int_ret_yd: d.interception_return_yards ?? 0,
    ff: d.forced_fumbles ?? 0,
    fum_rec: d.fumble_recoveries ?? 0,
    fum_ret_yd: d.fumble_return_yards ?? 0,
    safe: d.safeties ?? 0,
    blk_kick: d.blocked_kicks ?? 0,
    blk_kick_ret_yd: d.blocked_kick_return_yards ?? 0,
    def_td: d.defensive_touchdowns ?? 0,
    st_td: d.special_teams_touchdowns ?? 0,
    def_kr_yd: d.kickoff_return_yards ?? 0,
    def_pr_yd: d.punt_return_yards ?? 0,
    def_4_and_stop: d.fourth_down_stops ?? 0,
    def_forced_punts: d.forced_punts ?? 0,
    pts_allow: ptsAllowTotal,
  };
}

const CONF_MAP: Record<string, ProjectionConfidence> = {
  HIGH: "HIGH",
  MODERATE: "MEDIUM",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
};
function projConfidence(raw: string | null | undefined): ProjectionConfidence {
  return CONF_MAP[(raw ?? "").toUpperCase()] ?? "VERY_LOW";
}

function band(median: number, floor: number, ceiling: number): OutcomeBand {
  const lo = Math.min(floor, median, ceiling);
  const hi = Math.max(floor, median, ceiling);
  return {
    floor: round1(lo),
    median: round1(median),
    ceiling: round1(hi),
    // P20..P80 spans ~1.683 sd for a normal; widen a touch for rare-event skew.
    sd: round1(Math.max(1, (hi - lo) / 1.6)),
    percentiles: { floor: 20, ceiling: 80 },
  };
}

function emptyLeagueRow(
  ctx: LeagueScoringContext,
  id: string,
  name: string,
  position: FantasyPosition,
  team: string | null,
  points: number,
  outcome: OutcomeBand,
  confidence: ProjectionConfidence,
): LeagueProjection {
  return {
    player_id: id,
    full_name: name,
    position,
    team,
    league_slug: ctx.league_slug,
    league_id: ctx.league_id,
    scoring_hash: ctx.scoring_hash,
    league_points: round2(points),
    league_ppg: round2(points / 17),
    league_outcome: outcome,
    sleeper_league_points: null,
    vs_sleeper: {
      delta_points: null,
      delta_pct: null,
      ri_rank: null,
      sleeper_rank: null,
      rank_delta: null,
      primary_driver: null,
    },
    replacement_points: null,
    value_over_replacement: null,
    vor_rank: null,
    position_rank: null,
    overall_rank: null,
    tier: null,
    confidence,
  };
}

/* --------------------------------------------------------------- coverage */

export interface PositionCoverage {
  version: string | null;
  status: "VALID" | "DEGRADED";
  produced: number;
  reasons: string[];
}
export interface SpecialTeamsResult {
  kickers: LeagueProjection[];
  defenses: LeagueProjection[];
  kicker_roles: Array<{ player_id: string; name: string; team: string | null; confidence: KickerRoleConfidence; reasons: string[] }>;
  coverage: { K: PositionCoverage; DEF: PositionCoverage };
  snapshot_meta: Snapshot["_meta"];
}

/* ------------------------------------------------------------------ kickers */

/** League-average kicker season points (K replacement ~ 14th kicker) + sane band. */
const K_NEUTRAL_POINTS = 116;
const K_MIN = 88;
const K_MAX = 182;
const clampK = (v: number): number => Math.min(K_MAX, Math.max(K_MIN, v));

export function buildKickerLeagueProjections(params: {
  ctx: LeagueScoringContext;
  playerIndex: ReadonlyMap<string, NormalizedPlayer>;
}): { projections: LeagueProjection[]; roles: SpecialTeamsResult["kicker_roles"]; coverage: PositionCoverage } {
  const { ctx, playerIndex } = params;

  // live team -> the current depth-1 kicker (job-security spine)
  const liveStarterByTeam = new Map<string, NormalizedPlayer>();
  const teamHasStarter = new Map<string, boolean>();
  for (const [, p] of playerIndex) {
    if (p.position !== "K" || !p.team || p.active === false) continue;
    if (p.depth_chart_order === 1) {
      teamHasStarter.set(p.team, true);
      if (!liveStarterByTeam.has(p.team)) liveStarterByTeam.set(p.team, p);
    }
  }
  const snapBySleeper = new Map<string, KickerRow>();
  for (const k of SNAP.kickers) if (k.sleeper_id) snapBySleeper.set(k.sleeper_id, k);

  const rows: LeagueProjection[] = [];
  const roles: SpecialTeamsResult["kicker_roles"] = [];
  const reasons: string[] = [];
  const coveredTeams = new Set<string>();

  const push = (
    id: string,
    name: string,
    team: string,
    points: number,
    floor: number,
    ceiling: number,
    conf: ProjectionConfidence,
  ) => {
    const p = clampK(points);
    rows.push(emptyLeagueRow(ctx, id, name, "K", team, p, band(p, clampK(floor), clampK(ceiling)), conf));
    coveredTeams.add(team);
  };

  // ---- Pass 1: snapshot kickers, gated by CURRENT job security ----------
  for (const k of SNAP.kickers) {
    const live = k.sleeper_id ? playerIndex.get(k.sleeper_id) : undefined;
    const teamStarterExists =
      !!live?.team && teamHasStarter.get(live.team) === true && live.depth_chart_order !== 1;
    const role = resolveKickerRole(k, live, teamStarterExists);
    const id = k.sleeper_id ?? `k-${k.team}-${k.name.replace(/\W+/g, "")}`;
    roles.push({ player_id: id, name: k.name, team: role.live_team ?? k.team, confidence: role.confidence, reasons: role.reasons });
    if (role.confidence === "LOW" || role.confidence === "INVALID") continue;

    const cleanCurrent =
      role.team_agrees && k.depth_rank === 1 && k.projection_tier === "TIER_A_CURRENT_DIRECT";

    let points: number;
    let floor: number;
    let ceiling: number;
    if (cleanCurrent && k.projected_bloodline_points != null) {
      // score from the current multi-source component rates through the live config
      points = calculateFantasyPoints(kickerStatLine(k), ctx.scoring_settings).fantasy_points;
      floor = k.floor_points ?? points * 0.82;
      ceiling = k.ceiling_points ?? points * 1.18;
    } else {
      // stale / modeled / team-mismatch snapshot -> team-neutral, wide band
      points = K_NEUTRAL_POINTS;
      floor = points * 0.78;
      ceiling = points * 1.22;
      if (!role.reasons.some((r) => /team-neutral/.test(r))) role.reasons.push("team-neutral value (no current direct projection)");
    }

    let conf = projConfidence(k.projection_confidence);
    if (role.confidence === "MEDIUM") conf = conf === "HIGH" ? "MEDIUM" : conf;
    if (!cleanCurrent && (conf === "HIGH" || conf === "MEDIUM")) conf = "LOW";
    push(id, k.name, role.live_team ?? k.team, points, floor, ceiling, conf);
  }

  // ---- Pass 2: live depth-1 kickers whose team is still uncovered -------
  // (mid-year kicker changes / rookies not in the March snapshot)
  for (const [team, p] of liveStarterByTeam) {
    if (coveredTeams.has(team)) continue;
    if (p.status && OUT_STATUSES.has(p.status)) continue;
    if (p.injury_status && OUT_INJURY.has(p.injury_status)) continue;
    const rookie = (p.years_exp ?? 9) <= 1;
    const points = rookie ? K_NEUTRAL_POINTS - 4 : K_NEUTRAL_POINTS;
    roles.push({
      player_id: p.player_id,
      name: p.full_name,
      team,
      confidence: "MEDIUM",
      reasons: ["live depth-1 kicker not in the projection snapshot — team-neutral value", rookie ? "rookie" : "veteran"],
    });
    push(p.player_id, p.full_name, team, points, points * 0.75, points * 1.25, rookie ? "LOW" : "LOW");
  }

  // ---- coverage + integrity -------------------------------------------
  const highMed = roles.filter((r) => r.confidence === "HIGH" || r.confidence === "MEDIUM").length;
  const missingTeams = NFL_TEAMS.filter((t) => !coveredTeams.has(t));
  if (missingTeams.length) reasons.push(`no production kicker for: ${missingTeams.join(", ")} (unsettled job)`);
  const byTeam = new Map<string, number>();
  for (const r of rows) if (r.team) byTeam.set(r.team, (byTeam.get(r.team) ?? 0) + 1);
  const dupes = [...byTeam.entries()].filter(([, n]) => n > 1).map(([t]) => t);
  if (dupes.length) reasons.push(`multiple production kickers on the same team: ${dupes.join(", ")}`);

  const status: PositionCoverage["status"] =
    rows.length >= 24 && highMed >= 20 && dupes.length === 0 ? "VALID" : "DEGRADED";

  return { projections: rows, roles, coverage: { version: KICKER_MODEL_VERSION, status, produced: rows.length, reasons } };
}

/* ----------------------------------------------------------------- defense */

export function buildDefenseLeagueProjections(params: {
  ctx: LeagueScoringContext;
  playerIndex: ReadonlyMap<string, NormalizedPlayer>;
}): { projections: LeagueProjection[]; coverage: PositionCoverage } {
  const { ctx, playerIndex } = params;
  const ptsAllowRate = ctx.scoring_settings["pts_allow"] ?? -0.3;
  const reasons: string[] = [];

  // Sleeper's canonical team-defense rows: player_id === team code, position DEF.
  const liveDef = new Map<string, NormalizedPlayer>();
  for (const [pid, p] of playerIndex) if (p.position === "DEF") liveDef.set(pid, p);

  const rows: LeagueProjection[] = [];
  const seen = new Set<string>();
  for (const d of SNAP.defenses) {
    const team = d.team;
    if (seen.has(team)) {
      reasons.push(`duplicate franchise row: ${team}`);
      continue;
    }
    seen.add(team);
    const line = defenseStatLine(d, ptsAllowRate);
    if (Object.values(line).some((v) => !Number.isFinite(v))) {
      reasons.push(`${team}: non-finite scoring input`);
      continue;
    }
    const points = calculateFantasyPoints(line, ctx.scoring_settings).fantasy_points;
    const b = band(points, d.floor_points ?? points * 0.75, d.ceiling_points ?? points * 1.3);
    // DEF projections are intrinsically wide; the calibrated model is MEDIUM, not LOW.
    const conf: ProjectionConfidence = projConfidence(d.projection_confidence) === "VERY_LOW" ? "LOW" : "MEDIUM";
    const id = liveDef.has(team) ? team : team;
    rows.push(emptyLeagueRow(ctx, id, `${team} D/ST`, "DEF", team, points, b, conf));
  }

  const missing = NFL_TEAMS.filter((t) => !seen.has(t));
  if (missing.length) reasons.push(`missing team defenses: ${missing.join(", ")}`);
  const extra = [...seen].filter((t) => !(NFL_TEAMS as readonly string[]).includes(t));
  if (extra.length) reasons.push(`non-NFL team-defense rows: ${extra.join(", ")}`);

  const status: PositionCoverage["status"] = rows.length === 32 && missing.length === 0 ? "VALID" : "DEGRADED";
  return { projections: rows, coverage: { version: DEFENSE_MODEL_VERSION, status, produced: rows.length, reasons } };
}

/* --------------------------------------------------------------- combined */

export function buildSpecialTeamsProjections(params: {
  ctx: LeagueScoringContext;
  playerIndex: ReadonlyMap<string, NormalizedPlayer>;
}): SpecialTeamsResult {
  const k = buildKickerLeagueProjections(params);
  const d = buildDefenseLeagueProjections(params);
  return {
    kickers: k.projections,
    defenses: d.projections,
    kicker_roles: k.roles,
    coverage: { K: k.coverage, DEF: d.coverage },
    snapshot_meta: SNAP._meta,
  };
}

/**
 * "One K, one DEF" — Phase 7 K/DST policy. Once a manager rosters a kicker or a
 * team defense, remove that whole position group from the candidate pool so a
 * SECOND can never be surfaced (they are streamed, never benched in pairs). The
 * frozen round-13 hard gate still governs the first one. Orchestration-level —
 * no frozen decision logic is involved.
 */
export function withoutRosteredSpecialTeams(
  pool: LeagueProjection[],
  rosterPlayers: Array<{ position?: string | null }>,
): LeagueProjection[] {
  const hasK = rosterPlayers.some((p) => p.position === "K");
  const hasDef = rosterPlayers.some((p) => p.position === "DEF");
  if (!hasK && !hasDef) return pool;
  return pool.filter((p) => !(p.position === "K" && hasK) && !(p.position === "DEF" && hasDef));
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
