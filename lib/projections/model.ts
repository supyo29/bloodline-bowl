/**
 * Roster Intel structural projection model (RI_STANDALONE).
 *
 * Opportunity first, efficiency second. Built ONLY from historical NFL
 * box-score actuals (Sleeper's stats feed) + depth-chart role + age curves.
 * No external projection (Sleeper/RotoWire) feeds the target — that is a
 * benchmark applied afterward (`lib/projections/compare.ts`).
 *
 * Flow, per NFL team:
 *   team environment (recency-weighted TEAM_* totals, regressed, transition-aware)
 *     -> position-group volume pools (pass attempts, target pool, carry pool)
 *       -> player opportunity shares (from weighted per-game history OR a
 *          depth-chart rookie prior), normalized to sum to 1 within the group
 *         -> player volume = share * pool
 *           -> efficiency (shrunk toward position baseline)
 *             -> yards
 *           -> touchdowns (from red-zone opportunity + team TD env + regressed
 *              conversion, then normalized so team TDs reconcile)
 *         -> games (availability model) -> season stat line
 */

import type { NormalizedPlayer } from "@/lib/sleeper/types";
import type { PlayerSeasonActual, SeasonActuals, TeamSeasonTotals } from "./actuals";
import {
  EMPTY_STATS,
  PROJECTION_MODEL_VERSION,
  PROJECTION_SCHEMA_VERSION,
  type FantasyPosition,
  type PlayerProjection,
  type ProjectedFootballStats,
  type ProjectionComponents,
} from "./schema";
import {
  CALIBRATION_V3,
  POSITION_BASELINES,
  REGULAR_SEASON_GAMES,
  SEASON_RECENCY_WEIGHTS,
  SHRINKAGE_K,
  TEAM_BASELINE,
  expectedSeasonGames,
  shrink,
  type CalibrationProfile,
} from "./baselines";
import { rookieOpportunityPrior } from "./rookie-model";

/* ------------------------------------------------------------- player history */

interface PlayerHistory {
  player_id: string;
  seasons: PlayerSeasonActual[];
  n_eff: number;
  games_pg_weight: number;
  /** per-game volumes (recency + games weighted) */
  targets_pg: number;
  carries_pg: number;
  rec_pg: number;
  pass_att_pg: number;
  rush_att_pg: number;
  rz_tgt_pg: number;
  rz_carry_pg: number;
  pass_rz_att_pg: number;
  snap_share: number;
  /** efficiency */
  ypt: number;
  ypc: number;
  catch_rate: number;
  cmp_pct: number;
  ypa: number;
  int_per_att: number;
  pass_yd_pg: number;
  /** availability */
  availability: number;
  /** kicking */
  fgm_pg: number;
  fga_pg: number;
  fgm_yds_pg: number;
  xpm_pg: number;
  /** defense */
  def_sack: number;
  def_int: number;
  def_fum_rec: number;
  def_td: number;
  def_safety: number;
}

function weightedRate(
  seasons: PlayerSeasonActual[],
  num: (s: PlayerSeasonActual) => number,
  den: (s: PlayerSeasonActual) => number,
): number {
  let wn = 0;
  let wd = 0;
  for (const s of seasons) {
    const w = SEASON_RECENCY_WEIGHTS[s.season] ?? 0;
    wn += w * num(s);
    wd += w * den(s);
  }
  return wd > 0 ? wn / wd : 0;
}

export function aggregateHistory(seasons: PlayerSeasonActual[]): PlayerHistory | null {
  const rel = seasons
    .filter((s) => s.gp > 0)
    .sort((a, b) => b.season - a.season)
    .slice(0, 4);
  if (rel.length === 0) return null;

  const g = (s: PlayerSeasonActual) => Math.min(s.gp, REGULAR_SEASON_GAMES);
  const nEff = rel.reduce(
    (a, s) => a + (SEASON_RECENCY_WEIGHTS[s.season] ?? 0) * g(s),
    0,
  );

  return {
    player_id: rel[0]!.player_id,
    seasons: rel,
    n_eff: nEff,
    games_pg_weight: rel.reduce(
      (a, s) => a + (SEASON_RECENCY_WEIGHTS[s.season] ?? 0),
      0,
    ),
    targets_pg: weightedRate(rel, (s) => s.targets, g),
    carries_pg: weightedRate(rel, (s) => s.rush_att, g),
    rec_pg: weightedRate(rel, (s) => s.rec, g),
    pass_att_pg: weightedRate(rel, (s) => s.pass_att, g),
    rush_att_pg: weightedRate(rel, (s) => s.rush_att, g),
    rz_tgt_pg: weightedRate(rel, (s) => s.rec_rz_tgt, g),
    rz_carry_pg: weightedRate(rel, (s) => s.rush_rz_att, g),
    pass_rz_att_pg: weightedRate(rel, (s) => s.pass_rz_att, g),
    snap_share: weightedRate(rel, (s) => s.off_snp, (s) => s.tm_off_snp || 1),
    ypt: weightedRate(rel, (s) => s.rec_yd, (s) => s.targets),
    ypc: weightedRate(rel, (s) => s.rush_yd, (s) => s.rush_att),
    catch_rate: weightedRate(rel, (s) => s.rec, (s) => s.targets),
    cmp_pct: weightedRate(rel, (s) => s.pass_cmp, (s) => s.pass_att),
    ypa: weightedRate(rel, (s) => s.pass_yd, (s) => s.pass_att),
    int_per_att: weightedRate(rel, (s) => s.pass_int, (s) => s.pass_att),
    pass_yd_pg: weightedRate(rel, (s) => s.pass_yd, g),
    availability: weightedRate(rel, g, () => REGULAR_SEASON_GAMES),
    fgm_pg: weightedRate(rel, (s) => s.fgm, g),
    fga_pg: weightedRate(rel, (s) => s.fga, g),
    fgm_yds_pg: weightedRate(rel, (s) => s.fgm_yds, g),
    xpm_pg: weightedRate(rel, (s) => s.xpm, g),
    def_sack: weightedRate(rel, (s) => s.def_sack, () => 1) * 0 + avgLast(rel, (s) => s.def_sack),
    def_int: avgLast(rel, (s) => s.def_int),
    def_fum_rec: avgLast(rel, (s) => s.def_fum_rec),
    def_td: avgLast(rel, (s) => s.def_td),
    def_safety: avgLast(rel, (s) => s.def_safety),
  };
}

function avgLast(seasons: PlayerSeasonActual[], f: (s: PlayerSeasonActual) => number): number {
  let wn = 0;
  let wd = 0;
  for (const s of seasons) {
    const w = SEASON_RECENCY_WEIGHTS[s.season] ?? 0;
    wn += w * f(s);
    wd += w;
  }
  return wd > 0 ? wn / wd : 0;
}

/* --------------------------------------------------------- team environment */

export interface TeamEnvironment {
  team: string;
  pass_att: number;
  rush_att: number;
  plays: number;
  pass_td: number;
  rush_td: number;
  /** target pool ≈ pass_att minus sacks/throwaways */
  target_pool: number;
  qb_transition: boolean;
  regression_weight: number; // 0..1 toward TEAM_BASELINE
}

export function buildTeamEnvironment(
  team: string,
  historicalSeasons: SeasonActuals[],
  qbTransition: boolean,
): TeamEnvironment {
  const rows: Array<{ w: number; t: TeamSeasonTotals }> = [];
  for (const s of historicalSeasons) {
    const t = s.team_totals.get(team);
    const w = SEASON_RECENCY_WEIGHTS[s.season] ?? 0;
    if (t && w > 0) rows.push({ w, t });
  }
  const wsum = rows.reduce((a, r) => a + r.w, 0) || 1;
  const wavg = (f: (t: TeamSeasonTotals) => number) =>
    rows.reduce((a, r) => a + r.w * f(r.t), 0) / wsum;

  // Thin history or QB transition -> regress harder to the league mean.
  const coverage = wsum / (SEASON_RECENCY_WEIGHTS[2025]! + SEASON_RECENCY_WEIGHTS[2024]! + SEASON_RECENCY_WEIGHTS[2023]!);
  let regW = Math.max(0.1, Math.min(0.45, 0.42 - 0.34 * coverage));
  // A QB change shifts team pass/rush *mix* and adds uncertainty, but a stable
  // roster keeps most of its volume — a modest nudge, not a gutting.
  if (qbTransition) regW = Math.min(0.4, regW + 0.08);

  const blend = (obs: number, base: number) => (1 - regW) * obs + regW * base;

  const passAtt = rows.length
    ? blend(wavg((t) => t.pass_att), TEAM_BASELINE.pass_att)
    : TEAM_BASELINE.pass_att;
  const rushAtt = rows.length
    ? blend(wavg((t) => t.rush_att), TEAM_BASELINE.rush_att)
    : TEAM_BASELINE.rush_att;
  const passTd = rows.length
    ? blend(wavg((t) => t.pass_td), TEAM_BASELINE.pass_td)
    : TEAM_BASELINE.pass_td;
  const rushTd = rows.length
    ? blend(wavg((t) => t.rush_td), TEAM_BASELINE.rush_td)
    : TEAM_BASELINE.rush_td;

  return {
    team,
    pass_att: passAtt,
    rush_att: rushAtt,
    plays: passAtt + rushAtt,
    pass_td: passTd,
    rush_td: rushTd,
    target_pool: passAtt * 0.98,
    qb_transition: qbTransition,
    regression_weight: regW,
  };
}

/* ------------------------------------------------------- rookie role priors */

/** Fraction-of-team opportunity a rookie at a given depth-chart slot gets. */
function rookieRolePrior(
  position: FantasyPosition,
  depthOrder: number | null,
): { target_pg: number; carry_pg: number; snap_share: number } {
  const d = depthOrder ?? 3;
  if (position === "RB") {
    const carry = d === 1 ? 12 : d === 2 ? 5.5 : 2;
    return { target_pg: d === 1 ? 2.6 : 1.4, carry_pg: carry, snap_share: d === 1 ? 0.52 : d === 2 ? 0.3 : 0.14 };
  }
  if (position === "WR") {
    const tgt = d === 1 ? 6.0 : d === 2 ? 4.3 : d === 3 ? 2.6 : 1.2;
    return { target_pg: tgt, carry_pg: 0.3, snap_share: d === 1 ? 0.72 : d === 2 ? 0.58 : d === 3 ? 0.38 : 0.18 };
  }
  if (position === "TE") {
    const tgt = d === 1 ? 4.2 : d === 2 ? 2.0 : 0.9;
    return { target_pg: tgt, carry_pg: 0, snap_share: d === 1 ? 0.66 : 0.34 };
  }
  if (position === "QB") {
    return { target_pg: 0, carry_pg: d === 1 ? 4.5 : 0.5, snap_share: d === 1 ? 0.98 : 0.05 };
  }
  return { target_pg: 0, carry_pg: 0, snap_share: 0 };
}

/* --------------------------------------------------------- team projection */

export interface TeamProjectionInput {
  team: string;
  players: NormalizedPlayer[];
  historyByPlayer: Map<string, PlayerHistory>;
  historicalSeasons: SeasonActuals[];
  season: number;
  dataAsOf: string;
  /** Defaults to the live (v2) calibration; only the v1↔v2 audit overrides it. */
  calibration?: CalibrationProfile;
}

const RELEVANT = new Set<FantasyPosition>(["QB", "RB", "WR", "TE"]);

export function projectTeamOffense(input: TeamProjectionInput): PlayerProjection[] {
  const { team, players, historyByPlayer, historicalSeasons, season, dataAsOf } = input;
  const calibration = input.calibration ?? CALIBRATION_V3;
  const ageMul_ = calibration.ageMultiplier;
  const oppShade_ = calibration.opportunityShade;
  const now = new Date().toISOString();

  const skill = players.filter(
    (p): p is NormalizedPlayer & { position: FantasyPosition } =>
      RELEVANT.has((p.position ?? "") as FantasyPosition),
  );

  // QB-transition: is the depth-1 QB's recent passing history thin?
  const qb1 = skill
    .filter((p) => p.position === "QB")
    .sort((a, b) => (a.depth_chart_order ?? 9) - (b.depth_chart_order ?? 9))[0];
  const qb1Hist = qb1 ? historyByPlayer.get(qb1.player_id) : undefined;
  const qbTransition =
    !qb1Hist || qb1Hist.pass_att_pg * qb1Hist.games_pg_weight < 8 ||
    (qb1?.years_exp ?? 0) === 0;

  const env = buildTeamEnvironment(team, historicalSeasons, qbTransition);

  interface Raw {
    p: NormalizedPlayer & { position: FantasyPosition };
    h: PlayerHistory | null;
    isRookie: boolean;
    fromDraftPrior: boolean;
    ageMul: number;
    raw_target_pg: number;
    raw_carry_pg: number;
    raw_pass_pg: number;
    raw_snap: number;
    raw_rz_tgt_pg: number;
    raw_rz_carry_pg: number;
    raw_pass_rz_pg: number;
  }

  const raws: Raw[] = skill.map((p) => {
    const h = historyByPlayer.get(p.player_id) ?? null;
    const isRookie = (p.years_exp ?? 0) === 0 || h === null;
    const ageMul = ageMul_(p.position, p.age);
    if (isRookie || !h) {
      // Phase 3 (holdout-validated, `ri-structural-2026.3`): a WR/RB/TE rookie's
      // opportunity is projected from NFL draft position (a large, robust
      // improvement over the depth-chart-slot lookup; college data adds nothing).
      // QB and players with no draft record fall back to `rookieRolePrior`.
      const draft = calibration.rookieDraftFor(p.player_id);
      const dc = draft && p.position !== "QB" ? rookieOpportunityPrior(p.position, draft) : null;
      const prior = dc
        ? { target_pg: dc.target_pg, carry_pg: dc.carry_pg, snap_share: dc.snap_share }
        : rookieRolePrior(p.position, p.depth_chart_order ?? null);
      return {
        p, h, isRookie: true, fromDraftPrior: !!dc, ageMul,
        raw_target_pg: prior.target_pg,
        raw_carry_pg: prior.carry_pg,
        raw_pass_pg: p.position === "QB" && (p.depth_chart_order ?? 9) === 1 ? env.pass_att / REGULAR_SEASON_GAMES : 0,
        raw_snap: prior.snap_share,
        raw_rz_tgt_pg: prior.target_pg * 0.11,
        raw_rz_carry_pg: prior.carry_pg * 0.16,
        raw_pass_rz_pg: p.position === "QB" && (p.depth_chart_order ?? 9) === 1 ? 3.6 : 0,
      };
    }
    // veteran: demonstrated per-game volume. Phase 2 (holdout-validated):
    // aging shows up in usage — shade opportunity for skill players 30+
    // (opportunityAgeShade); a no-op below 30 and for QBs.
    const oppAge = oppShade_(p.position, p.age);
    return {
      p, h, isRookie: false, fromDraftPrior: false, ageMul,
      raw_target_pg: h.targets_pg * oppAge,
      raw_carry_pg: h.carries_pg * oppAge,
      raw_pass_pg: h.pass_att_pg,
      raw_snap: h.snap_share,
      raw_rz_tgt_pg: h.rz_tgt_pg,
      raw_rz_carry_pg: h.rz_carry_pg * oppAge,
      raw_pass_rz_pg: h.pass_rz_att_pg,
    };
  });

  // ---- normalize opportunity shares within the team ----
  // Raw per-game history + rookie priors under-concentrate volume: real offenses
  // funnel targets/carries to their top 2-3 options harder than a linear share of
  // historical averages implies (deep bench + rookie priors dilute the pool).
  // A mild power (>1) re-concentrates on the top options before renormalizing.
  const TGT_CONC = 1.28;
  const CARRY_CONC = 1.5;
  const conc = (v: number, k: number) => Math.pow(Math.max(0, v), k);

  // Only the top few options in a group meaningfully share the volume pool; a
  // team's WR6 / third TE / practice-squad RB take scraps. Cap the "committee"
  // so deep filler with a thin rookie prior cannot dilute the WR1's share.
  const topByRaw = (list: Raw[], key: (r: Raw) => number, keep: number) => {
    const sorted = [...list].sort((a, b) => key(b) - key(a));
    const cutoff = sorted[keep - 1] ? key(sorted[keep - 1]!) : 0;
    return (r: Raw) => (key(r) >= cutoff && key(r) > 0 ? key(r) : key(r) * 0.12);
  };

  // RB receiving is its own pool (~18% of team targets), split among RBs. RBs
  // do NOT compete in the WR/TE top-N cut — a pass-catching back would lose the
  // slot to a WR3 and get zeroed.
  const RB_TARGET_FRACTION = 0.18;
  const receiverGroup = raws.filter((r) => r.p.position === "WR" || r.p.position === "TE");
  const rbGroup = raws.filter((r) => r.p.position === "RB");

  // Phase 3 (§26) role-aware redistribution constraint. The draft-capital rookie
  // prior is *additive* information about a genuinely new roster spot. Without
  // this guard, a drafted rookie who edges past the receiver-group top-N cutoff
  // evicts the displaced incumbent to filler weight (0.12) — a 33-target TE2
  // collapsing to ~2 purely because a 3rd-round rookie joined the room (the
  // "Isaiah Likely" edge case). Teams that spend real draft capital on a pass
  // catcher expand the rotation; they do not bench a productive incumbent
  // outright. So widen the receiver keep-window by one slot per drafted rookie
  // that lands inside it — the rookie takes his calibrated share, the incumbent
  // keeps starter-tier weight, and the team pool still renormalises to the same
  // total. (RB carries are a smaller, higher-conviction pool — left unchanged.)
  const draftedRookieReceiversInTopN = [...receiverGroup]
    .sort((a, b) => b.raw_target_pg - a.raw_target_pg)
    .slice(0, 6)
    .filter((r) => r.fromDraftPrior).length;
  const RECEIVER_KEEP = 6 + draftedRookieReceiversInTopN;
  const tgtEff = topByRaw(receiverGroup, (r) => r.raw_target_pg, RECEIVER_KEEP);
  const sumRecTgt = receiverGroup.reduce((a, r) => a + conc(tgtEff(r), TGT_CONC), 0) || 1;
  const sumRbTgt = rbGroup.reduce((a, r) => a + conc(r.raw_target_pg, 1.2), 0) || 1;
  const passCatchers = raws.filter((r) => r.p.position !== "QB");
  const sumRzTgt = passCatchers.reduce((a, r) => a + r.raw_rz_tgt_pg, 0) || 1;
  const qbs = raws.filter((r) => r.p.position === "QB");
  const sumPassRz = qbs.reduce((a, r) => a + r.raw_pass_rz_pg, 0) || 1;

  // Rank QBs to find the starter: depth chart first, then demonstrated passing
  // volume, then experience / Sleeper relevance. Preseason depth_chart_order is
  // frequently missing, so we cannot rely on it alone.
  const qbRanked = qbs
    .slice()
    .sort((a, b) => {
      const da = a.p.depth_chart_order ?? 99;
      const db = b.p.depth_chart_order ?? 99;
      if (da !== db) return da - db;
      const va = (a.h?.pass_att_pg ?? 0) * (a.h?.games_pg_weight ?? 0);
      const vb = (b.h?.pass_att_pg ?? 0) * (b.h?.games_pg_weight ?? 0);
      if (Math.abs(va - vb) > 2) return vb - va;
      const sa = a.p.search_rank ?? 9999;
      const sb = b.p.search_rank ?? 9999;
      return sa - sb;
    });
  const qbPassShare = new Map<string, number>();
  qbRanked.forEach((r, i) => {
    qbPassShare.set(r.p.player_id, i === 0 ? 0.93 : i === 1 ? 0.07 : 0);
  });

  // QB rushing is its own pool; the RB committee splits what's left of the team
  // rush total after QB carries (and a small WR/TE end-around allowance).
  const qbCarrySeason = qbRanked.slice(0, 1).reduce((a, r) => a + Math.min(r.raw_carry_pg, 12) * REGULAR_SEASON_GAMES, 0);
  const rbCarryPool = Math.max(env.rush_att * 0.55, env.rush_att - qbCarrySeason - env.rush_att * 0.04);
  const rbs = raws.filter((r) => r.p.position === "RB");
  const carryEff = topByRaw(rbs, (r) => r.raw_carry_pg, 3);
  const sumRbCarry = rbs.reduce((a, r) => a + conc(carryEff(r), CARRY_CONC), 0) || 1;
  const sumRzCarry =
    (rbs.reduce((a, r) => a + r.raw_rz_carry_pg, 0) || 0) +
    (qbs.reduce((a, r) => a + r.raw_carry_pg * 0.16, 0) || 0) || 1;

  // Phase 3 (§26): the draft-capital rookie prior is calibrated to realised
  // year-1 per-game usage, but the team-pool normalisation can still hand a
  // highly-drafted rookie an implausible SHARE when the model's view of the
  // incumbent room is thin. Cap a rookie's normalised share at the historical
  // year-1 ceiling (WR/TE target share P99 ≈ 0.26, all-time max 0.31; RB carry
  // share P95 ≈ 0.62) and redistribute the excess to non-capped teammates.
  const ROOKIE_REC_TGT_SHARE_CEIL = 0.28;
  const ROOKIE_RB_CARRY_SHARE_CEIL = 0.62;
  const recShareOf = (r: Raw) => conc(tgtEff(r), TGT_CONC) / sumRecTgt;
  const rbCarryShareOf = (r: Raw) => conc(carryEff(r), CARRY_CONC) / sumRbCarry;
  const capShares = (
    group: Raw[],
    shareOf: (r: Raw) => number,
    ceil: number,
  ): Map<string, number> => {
    const base = new Map(group.map((r) => [r.p.player_id, shareOf(r)]));
    let excess = 0;
    let openWeight = 0;
    for (const r of group) {
      const s = base.get(r.p.player_id)!;
      if (r.isRookie && s > ceil) {
        excess += s - ceil;
        base.set(r.p.player_id, ceil);
      } else {
        openWeight += s;
      }
    }
    if (excess > 1e-6 && openWeight > 1e-6) {
      for (const r of group) {
        if (r.isRookie && shareOf(r) > ceil) continue;
        base.set(r.p.player_id, base.get(r.p.player_id)! * (1 + excess / openWeight));
      }
    }
    return base;
  };
  const recShareAdj = capShares(receiverGroup, recShareOf, ROOKIE_REC_TGT_SHARE_CEIL);
  const rbCarryShareAdj = capShares(rbs, rbCarryShareOf, ROOKIE_RB_CARRY_SHARE_CEIL);

  const results: PlayerProjection[] = [];

  for (const r of raws) {
    const { p, h } = r;
    const pos = p.position;
    const base = POSITION_BASELINES[pos];
    const nEff = h?.n_eff ?? 0;

    const targetShare =
      pos === "QB"
        ? 0
        : pos === "RB"
          ? (conc(r.raw_target_pg, 1.2) / sumRbTgt) * RB_TARGET_FRACTION
          : (recShareAdj.get(p.player_id) ?? recShareOf(r)) * (1 - RB_TARGET_FRACTION);
    const carryShare =
      pos === "WR" || pos === "TE"
        ? smallWrCarryShare(r)
        : pos === "RB"
          ? (rbCarryShareAdj.get(p.player_id) ?? rbCarryShareOf(r))
          : 0; // QB handled separately
    const rzTgtShare = pos === "QB" ? 0 : r.raw_rz_tgt_pg / sumRzTgt;
    const rzCarryShare = pos === "WR" || pos === "TE" ? 0 : r.raw_rz_carry_pg / sumRzCarry;

    const gamesIfHealthy = REGULAR_SEASON_GAMES;
    const availability = clamp(
      shrink(h?.availability ?? base.availability, base.availability, nEff, SHRINKAGE_K.availability),
      calibration.availabilityFloor, 0.985,
    );
    const rbAgePenalty = pos === "RB" && (p.age ?? 25) >= 29 ? 0.04 : 0;
    // Phase 2 (holdout-validated): expected games = 17*availability minus the
    // preseason-unforeseeable attrition allowance. See expectedSeasonGames.
    const expectedGames = round1(expectedSeasonGames(availability, calibration, rbAgePenalty));

    // ---- volume ----
    let targets: number | null = null;
    let rec: number | null = null;
    let recYd: number | null = null;
    let recTd: number | null = null;
    let carries: number | null = null;
    let rushYd: number | null = null;
    let rushTd: number | null = null;
    let passAtt: number | null = null;
    let passCmp: number | null = null;
    let passYd: number | null = null;
    let passTd: number | null = null;
    let passInt: number | null = null;

    if (pos !== "QB") {
      targets = round1(targetShare * env.target_pool);
      const cr = clamp(shrink(h?.catch_rate || base.catch_rate, base.catch_rate, nEff, SHRINKAGE_K.catch_rate), 0.4, 0.82) * (0.99 + 0.01 * r.ageMul);
      rec = round1((targets ?? 0) * cr);
      const ypt = clamp(shrink(h?.ypt || base.yards_per_target, base.yards_per_target, nEff, SHRINKAGE_K.yards_per_target), pos === "RB" ? 3 : 5.5, pos === "RB" ? 10 : 12.5) * r.ageMul;
      recYd = round1((targets ?? 0) * ypt);
      const rzTgt = rzTgtShare * env.pass_td * 2.6; // ~2.6 RZ targets per team pass TD
      const tdPerRz = clamp(shrink(h ? safeDiv(sum(h.seasons, (s) => s.rec_td), sum(h.seasons, (s) => s.rec_rz_tgt)) : base.rec_td_per_rz_target, base.rec_td_per_rz_target, nEff, SHRINKAGE_K.rec_td_rate), 0.06, 0.42);
      recTd = round1(rzTgt * tdPerRz + (targets ?? 0) * 0.006);
    }

    if (pos === "RB" || pos === "QB" || pos === "WR" || pos === "TE") {
      // All volume is built at a full (healthy) 17-game season here; the single
      // games-played discount is applied once, later, via `gf`.
      carries =
        pos === "QB"
          ? round1(clamp(r.raw_carry_pg, 0, 12) * gamesIfHealthy)
          : pos === "RB"
            ? round1(carryShare * rbCarryPool)
            : round1(carryShare * env.rush_att);
      const ypc = clamp(shrink(h?.ypc || base.yards_per_carry, base.yards_per_carry, nEff, SHRINKAGE_K.yards_per_carry), pos === "QB" ? 3 : 3.3, pos === "QB" ? 8 : 5.6) * (pos === "RB" ? r.ageMul : 1);
      rushYd = round1((carries ?? 0) * ypc);
      const rzC =
        pos === "QB"
          ? clamp(r.raw_carry_pg * 0.16 * gamesIfHealthy, 0, 55)
          : rzCarryShare * env.rush_td * 3.6;
      const rushTdPerRz = clamp(shrink(h ? safeDiv(sum(h.seasons, (s) => s.rush_td), sum(h.seasons, (s) => s.rush_rz_att)) : base.rush_td_per_rz_carry, base.rush_td_per_rz_carry, nEff, SHRINKAGE_K.rush_td_rate), 0.06, 0.34);
      rushTd = round1(rzC * rushTdPerRz + (carries ?? 0) * 0.004);
    }

    if (pos === "QB") {
      const passShare = qbs.length === 1 ? 1 : qbPassShare.get(p.player_id) ?? 0;
      passAtt = round1(passShare * env.pass_att);
      const cmp = clamp(shrink(h?.cmp_pct || base.cmp_pct, base.cmp_pct, nEff, SHRINKAGE_K.cmp_pct), 0.55, 0.72);
      passCmp = round1((passAtt ?? 0) * cmp);
      const ypa = clamp(shrink(h?.ypa || base.yards_per_att, base.yards_per_att, nEff, SHRINKAGE_K.yards_per_att), 5.6, 8.6) * (0.98 + 0.02 * r.ageMul);
      passYd = round1((passAtt ?? 0) * ypa);
      const passRz = (r.raw_pass_rz_pg / sumPassRz) * env.pass_td * 2.6;
      const tdPerRz = clamp(shrink(h ? safeDiv(sum(h.seasons, (s) => s.pass_td), sum(h.seasons, (s) => s.pass_rz_att)) : base.pass_td_per_rz_att, base.pass_td_per_rz_att, nEff, SHRINKAGE_K.pass_td_rate), 0.22, 0.52);
      passTd = round1(Math.max(passRz * tdPerRz, (passAtt ?? 0) * 0.038));
      passInt = round1((passAtt ?? 0) * clamp(shrink(h?.int_per_att || base.int_per_att, base.int_per_att, nEff, SHRINKAGE_K.int_rate), 0.014, 0.04));
    }

    const stats: ProjectedFootballStats = {
      ...EMPTY_STATS,
      pass_att: passAtt, pass_cmp: passCmp,
      cmp_pct: passAtt ? round3(safeDiv(passCmp ?? 0, passAtt)) : null,
      pass_yd: passYd, pass_ypa: passAtt ? round2(safeDiv(passYd ?? 0, passAtt)) : null,
      pass_td: passTd, pass_int: passInt,
      pass_2pt: pos === "QB" ? 0.6 : null,
      rush_att: carries, rush_yd: rushYd,
      rush_ypa: carries ? round2(safeDiv(rushYd ?? 0, carries)) : null,
      rush_td: rushTd, rush_2pt: carries ? round2((carries ?? 0) * 0.0015) : null,
      targets, rec,
      catch_rate: targets ? round3(safeDiv(rec ?? 0, targets)) : null,
      rec_yd: recYd,
      yprr: null,
      yptarget: targets ? round2(safeDiv(recYd ?? 0, targets)) : null,
      rec_td: recTd, rec_2pt: targets ? round2((targets ?? 0) * 0.0016) : null,
      fum_lost: round2(((carries ?? 0) + (rec ?? 0) + (passAtt ?? 0)) * base.fum_lost_per_touch),
    };

    // The Layer-1 stat line stays at FULL (healthy, 17-game) pace so it compares
    // apples-to-apples with Sleeper's ~17-game projection and so per-game talent
    // is never diluted by injury risk. The availability haircut is applied ONLY
    // to season points: season = ppg * expected_games (spec: keep per-game
    // performance and availability separate).
    const gf = expectedGames / gamesIfHealthy;
    const fullPacePoints = pprPoints(stats);
    const neutralPoints = fullPacePoints * gf;
    const components: ProjectionComponents = {
      snap_share: round3(clamp(r.raw_snap, 0, 1)),
      target_share: pos === "QB" ? null : round3(targetShare),
      carry_share: pos === "WR" || pos === "TE" ? null : round3(carryShare),
      rz_target_share: pos === "QB" ? null : round3(rzTgtShare),
      goal_line_share: pos === "WR" || pos === "TE" ? null : round3(rzCarryShare),
      team_pass_att: round1(env.pass_att),
      team_rush_att: round1(env.rush_att),
      team_plays: round1(env.plays),
      team_pass_td: round1(env.pass_td),
      team_rush_td: round1(env.rush_td),
      volume_component: round1(pprVolume(stats) * gf),
      efficiency_component: round1(pprYards(stats) * gf),
      td_component: round1(pprTd(stats) * gf),
      availability_component: round1(fullPacePoints * (1 - gf)),
      rookie_prior_weight: r.isRookie ? 1 : round3(clamp(1 - nEff / (nEff + 6), 0, 1)),
      age_multiplier: round3(r.ageMul),
    };

    results.push({
      schema_version: PROJECTION_SCHEMA_VERSION,
      model_version: PROJECTION_MODEL_VERSION,
      season,
      generated_at: now,
      data_as_of: dataAsOf,
      player_id: p.player_id,
      sleeper_player_id: p.player_id,
      full_name: p.full_name,
      position: pos,
      team: p.team ?? team,
      age: p.age,
      years_exp: p.years_exp,
      stats,
      components,
      availability: {
        games_if_healthy: gamesIfHealthy,
        expected_games: expectedGames,
        availability_probability: round3(availability),
        note:
          expectedGames < gamesIfHealthy - 1.5
            ? `Recent availability ${Math.round((h?.availability ?? base.availability) * 100)}%${rbAgePenalty ? " + age" : ""}`
            : null,
      },
      neutral_points: round1(neutralPoints),
      neutral_ppg: round2(safeDiv(neutralPoints, expectedGames)),
      outcome: { floor: 0, median: round1(neutralPoints), ceiling: 0, sd: 0, percentiles: { floor: 20, ceiling: 80 } },
      confidence: {
        bucket: "MEDIUM", score: 0.5, reasons: [], sample_seasons: h?.seasons.length ?? 0,
        is_rookie: r.isRookie, team_changed: false, injury_flagged: !!p.injury_status,
      },
      sources: {},
      warnings: [],
    });
  }

  return results;
}

/* -------------------------------------------------------------- small helpers */

function smallWrCarryShare(r: { raw_carry_pg: number }): number {
  return Math.min(0.03, r.raw_carry_pg / 400);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function safeDiv(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}
function sum(seasons: PlayerSeasonActual[], f: (s: PlayerSeasonActual) => number): number {
  return seasons.reduce((a, s) => a + f(s), 0);
}
function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }

/** PPR-neutral scoring for the Layer-1 reference number (not a league). */
export function pprPoints(s: ProjectedFootballStats): number {
  return pprVolume(s) + pprYards(s) + pprTd(s);
}
function pprVolume(s: ProjectedFootballStats): number {
  return (s.rec ?? 0) * 1 + (s.pass_int ?? 0) * -1 + (s.fum_lost ?? 0) * -2 + (s.pass_2pt ?? 0) * 2 + (s.rush_2pt ?? 0) * 2 + (s.rec_2pt ?? 0) * 2;
}
function pprYards(s: ProjectedFootballStats): number {
  return (s.pass_yd ?? 0) * 0.04 + (s.rush_yd ?? 0) * 0.1 + (s.rec_yd ?? 0) * 0.1;
}
function pprTd(s: ProjectedFootballStats): number {
  return (s.pass_td ?? 0) * 4 + (s.rush_td ?? 0) * 6 + (s.rec_td ?? 0) * 6;
}
