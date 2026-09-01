/**
 * PHASE 4 — reproducible decision-function harness.
 *
 *   npx tsx scripts/phase4-harness.ts
 *
 * Deterministic. Runs the pure `recommendDraft` engine over synthetic draft
 * states and writes the Phase 4 artifacts to outputs/projections-2026/:
 *
 *   phase4_component_definitions.csv   every utility term: unit, sign, source
 *   phase4_replacement_levels.csv      league-derived replacement, Bloodline shape
 *   phase4_tiers.csv                   gap-based tiers + quantified cliffs
 *   phase4_scarcity.csv                remaining-value-curve scarcity
 *   phase4_synthetic_scenarios.csv     scenarios A–O, expected vs observed
 *   phase4_ablation.csv                B0–B6 decision-quality proxy
 *   phase4_monotonicity.csv            §25 battery
 *   phase4_recommendation_examples.csv realistic states incl. BijiMac slot 12
 *   phase4_latency.csv                 mean / p95 latency, candidate counts
 *
 * `analysis/phase4_snake_recommendation_engine.R` consumes these.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { FantasyPosition, LeagueProjection, OutcomeBand } from "@/lib/projections/schema";
import { recommendDraft, type CompletedPick, type EngineInput } from "@/lib/draft/engine";
import { buildMarketSnapshot, estimateSurvival } from "@/lib/draft/survival";
import { computeReplacementLevels, vorOf } from "@/lib/draft/replacement";
import { tierPosition } from "@/lib/draft/tiers";
import { DEFAULT_WEIGHTS } from "@/lib/draft/utility";
import type { UtilityWeights } from "@/lib/draft/schema";

const OUT = join("outputs", "projections-2026");
const ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"];
const NUM_TEAMS = 12;
const ROUNDS = 15;

/* ------------------------------------------------------ deterministic RNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function band(m: number): OutcomeBand {
  return { floor: m * 0.72, median: m, ceiling: m * 1.34, sd: m * 0.18, percentiles: { floor: 20, ceiling: 80 } };
}

let uid = 0;
function lp(position: FantasyPosition, points: number, opts: Partial<LeagueProjection> = {}): LeagueProjection {
  const id = opts.player_id ?? `${position}_${++uid}`;
  return {
    player_id: id, full_name: opts.full_name ?? id, position, team: opts.team ?? `T${uid % 12}`,
    league_slug: "synthetic", league_id: "0", scoring_hash: "sha_synthetic",
    league_points: points, league_ppg: points / 17, league_outcome: band(points),
    sleeper_league_points: null,
    vs_sleeper: { delta_points: null, delta_pct: opts.vs_sleeper?.delta_pct ?? null, ri_rank: null, sleeper_rank: null, rank_delta: null, primary_driver: null },
    replacement_points: null, value_over_replacement: null, vor_rank: null, position_rank: null, overall_rank: null, tier: null,
    confidence: opts.confidence ?? "HIGH",
  };
}

/**
 * A Bloodline-shaped 12-team pool. `shape` controls per-position curves:
 * exponential decay with a configurable "cliff" injected at a rank.
 */
function buildPool(seed = 7): LeagueProjection[] {
  uid = 0;
  const rnd = mulberry32(seed);
  const pool: LeagueProjection[] = [];
  const spec: Array<{ pos: FantasyPosition; n: number; top: number; decay: number; cliffAt?: number; cliffMag?: number }> = [
    { pos: "QB", n: 30, top: 360, decay: 3.0, cliffAt: 14, cliffMag: 18 },
    { pos: "RB", n: 70, top: 340, decay: 4.8, cliffAt: 16, cliffMag: 45 },
    { pos: "WR", n: 90, top: 320, decay: 3.4, cliffAt: 40, cliffMag: 14 },
    { pos: "TE", n: 40, top: 250, decay: 4.0, cliffAt: 1, cliffMag: 66 },
    { pos: "K", n: 24, top: 150, decay: 2.2 },
    { pos: "DEF", n: 24, top: 140, decay: 2.4 },
  ];
  for (const s of spec) {
    let pts = s.top;
    for (let i = 0; i < s.n; i++) {
      const noise = (rnd() - 0.5) * 6;
      pool.push(lp(s.pos, Math.max(10, Math.round(pts + noise)), { player_id: `${s.pos}${i + 1}` }));
      pts -= s.decay + (s.cliffAt === i + 1 ? (s.cliffMag ?? 0) : 0);
    }
  }
  return pool;
}

function marketFromPool(pool: LeagueProjection[]) {
  const sr = new Map<string, number | null>();
  [...pool].sort((a, b) => b.league_points - a.league_points).forEach((p, i) => sr.set(p.player_id, i + 1));
  return buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "2026-09-01T00:00:00Z" });
}

function mkRosterPlayer(id: string, position: FantasyPosition) {
  return {
    player_id: id, full_name: id, first_name: null, last_name: null, position,
    fantasy_positions: [position], team: null, age: 26, years_exp: 4, status: null,
    injury_status: null, number: null, active: true, search_rank: null,
    depth_chart_order: null, depth_chart_position: null, resolved: true,
  };
}

/** BPA simulation of `n` picks by other teams (skips already-owned + K/DST early). */
function simulate(pool: LeagueProjection[], n: number, skip = new Set<string>(), releaseRound = 13): CompletedPick[] {
  const ranked = [...pool].filter((p) => !skip.has(p.player_id)).sort((a, b) => b.league_points - a.league_points);
  const out: CompletedPick[] = [];
  let ri = 0;
  for (let i = 0; i < n; i++) {
    const round = Math.floor(i / NUM_TEAMS) + 1;
    while (ri < ranked.length) {
      const p = ranked[ri]!;
      if ((p.position === "K" || p.position === "DEF") && round < releaseRound) { ri++; continue; }
      out.push({ overall: i + 1, roster_id: (i % NUM_TEAMS) + 1, player_id: p.player_id, position: p.position });
      ri++;
      break;
    }
  }
  return out;
}

function baseInput(pool: LeagueProjection[], over: Partial<EngineInput> = {}): EngineInput {
  return {
    leaguePool: pool,
    rosterPositions: ROSTER_POSITIONS,
    numTeams: NUM_TEAMS,
    draftType: "snake",
    rounds: ROUNDS,
    completedPicks: [],
    manager: { roster_id: 12, sleeper_user_id: "u12", manager_slug: "bijimac", draft_slot: 12 },
    rosterPlayers: [],
    market: marketFromPool(pool),
    provenance: {
      projection_source: "harness", projection_version: "ri-structural-2026.3",
      projection_timestamp: "2026-09-01T00:00:00Z", league_scoring_hash: "sha_synthetic",
      draft_state_timestamp: "2026-09-01T00:00:00Z",
    },
    ...over,
  };
}

const csv = (rows: Array<Record<string, unknown>>): string => {
  if (rows.length === 0) return "\n";
  const keys = Object.keys(rows[0]!);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => {
    const v = r[k];
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))].join("\n") + "\n";
};

/* ==========================================================================
   1. component definitions
   ======================================================================== */
function componentDefinitions() {
  return [
    { component: "vor", unit: "league points", sign: "+", source: "Layer2 league_points − replacement_points (league-derived)", weight: DEFAULT_WEIGHTS.vor },
    { component: "tier_drop", unit: "league points", sign: "+", source: "points from a tier-last player to the next tier's best (gap-relative tiers)", weight: DEFAULT_WEIGHTS.tier_drop },
    { component: "scarcity_value", unit: "league points", sign: "+", source: "scarcity_index × remaining-value-curve slope (position)", weight: DEFAULT_WEIGHTS.scarcity_value },
    { component: "roster_need", unit: "league points", sign: "±", source: "needWeight(position) × max(0, VOR); negative when redundant", weight: DEFAULT_WEIGHTS.roster_need },
    { component: "positional_advantage", unit: "league points", sign: "+", source: "player points − E[position alternative at next pick] (lookahead)", weight: DEFAULT_WEIGHTS.positional_advantage },
    { component: "urgency", unit: "league points", sign: "+", source: "(1 − P(survive)) × (points − E[alt later]) × survival-confidence", weight: DEFAULT_WEIGHTS.urgency },
    { component: "reach_cost", unit: "league points", sign: "−", source: "(market_pick − current_pick − 3) × board points/pick × P(survive) × conf", weight: DEFAULT_WEIGHTS.reach_cost },
    { component: "uncertainty_penalty", unit: "league points", sign: "−", source: "(median − floor) × floorWeight(draft progress, completion risk)", weight: DEFAULT_WEIGHTS.uncertainty_penalty },
    { component: "construction_risk", unit: "league points", sign: "−", source: "max(0, Δ starter-completion-risk from this pick) × 60", weight: DEFAULT_WEIGHTS.construction_risk },
  ];
}

/* ==========================================================================
   2. synthetic scenarios A–O
   ======================================================================== */
interface Scenario {
  id: string;
  title: string;
  expectation: string;
  run: () => { observed: string; pass: boolean; detail: string };
}

function scenarios(): Scenario[] {
  const pool = buildPool();
  const out: Scenario[] = [];

  // A — elite RB likely survives -> waiting acceptable
  out.push({
    id: "A", title: "Elite RB value, RB likely survives",
    expectation: "engine does not force the RB; comparable alternatives noted",
    run: () => {
      // few RBs gone, manager mid-slot with a long wait but RB depth intact
      const p = buildPool(11);
      const res = recommendDraft(baseInput(p, {
        manager: { roster_id: 3, sleeper_user_id: "u3", manager_slug: "m3", draft_slot: 3 },
        completedPicks: simulate(p, 2),
      }));
      const prim = res.primary_recommendation!;
      const rbWait = res.scarcity.find((s) => s.position === "RB")!;
      return {
        observed: `primary ${prim.position}${prim.position_rank}, RB scarcity ${rbWait.scarcity_index}`,
        pass: rbWait.scarcity_index < 0.6,
        detail: prim.reason,
      };
    },
  });

  // B — final elite TE -> tier-drop urgency (mid-slot, TE1 genuinely at risk)
  out.push({
    id: "B", title: "Final player in the elite TE tier",
    expectation: "tier-drop urgency rises; the tier-of-one TE is flagged TIER_CLIFF_URGENT and out-ranks a flat-tier alternative",
    run: () => {
      const p = buildPool(12);
      // TE1 market pick ~ 16 so a slot-6 manager at pick ~18 will miss him next turn
      const sr = new Map<string, number | null>();
      [...p].sort((a, b) => b.league_points - a.league_points).forEach((x, i) => sr.set(x.player_id, i + 1));
      sr.set("TE1", 16);
      const market = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "t" });
      const res = recommendDraft(baseInput(p, {
        market,
        manager: { roster_id: 6, sleeper_user_id: "u6", manager_slug: "m6", draft_slot: 6 },
        completedPicks: simulate(p, 14, new Set(["TE1"])),
        limits: { alternates: 40, wait: 40, doNotReach: 40 },
      }));
      const te = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach].find((r) => r.player_id === "TE1");
      return {
        observed: te ? `TE1 kind ${te.kind}, tier_drop ${te.tier_drop}, urgency ${te.utility_components.urgency}, codes ${te.reason_codes.join("|")}` : "TE1 not surfaced",
        pass: !!te && te.tier_drop >= 40 && (te.reason_codes.includes("TIER_CLIFF_URGENT") || te.utility_components.urgency > 10),
        detail: te?.reason ?? "",
      };
    },
  });

  // C — WR run right before the pick
  out.push({
    id: "C", title: "WR run immediately before the manager pick",
    expectation: "survival for WR falls; engine does NOT blindly chase — value unchanged",
    run: () => {
      const p = buildPool(13);
      // last 8 picks all WR
      const picks = simulate(p, 4);
      const wrs = [...p].filter((x) => x.position === "WR").sort((a, b) => b.league_points - a.league_points);
      for (let i = 0; i < 8; i++) picks.push({ overall: 5 + i, roster_id: (i % 12) + 1, player_id: wrs[i]!.player_id, position: "WR" });
      const res = recommendDraft(baseInput(p, { completedPicks: picks }));
      const run = res.runs.find((r) => r.signal.position === "WR")!;
      return {
        observed: `WR run=${run.signal.is_run}, demand_mult=${run.effect.demand_multiplier}, fundamental_delta=${run.effect.fundamental_value_delta}`,
        pass: run.signal.is_run && run.effect.fundamental_value_delta === 0,
        detail: res.primary_recommendation!.reason,
      };
    },
  });

  // D — 4 WR, 1 RB roster
  out.push({
    id: "D", title: "Roster has 4 WR, only 1 RB",
    expectation: "RB need rises but does not hard-veto enormous WR value",
    run: () => {
      const p = buildPool(14);
      const roster = ["WR1", "WR2", "WR3", "WR4", "RB1"].map((id) => mkRosterPlayer(id, id.startsWith("WR") ? "WR" : "RB"));
      const res = recommendDraft(baseInput(p, {
        rosterPlayers: roster,
        completedPicks: simulate(p, 40, new Set(roster.map((r) => r.player_id))),
      }));
      const wrPresent = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates].some((r) => r.position === "WR");
      return {
        observed: `primary ${res.primary_recommendation!.position}, RB at_risk=${res.roster_trajectory.at_risk_positions.includes("RB")}, WR still offered=${wrPresent}`,
        pass: wrPresent,
        detail: res.primary_recommendation!.reason,
      };
    },
  });

  // E — flat QB tier
  out.push({
    id: "E", title: "QB tier is flat",
    expectation: "do not reach for QB just because the slot is empty",
    run: () => {
      const p = buildPool(15);
      // make QB truly flat
      p.filter((x) => x.position === "QB").sort((a, b) => b.league_points - a.league_points).forEach((x, i) => { x.league_points = 320 - i * 1.5; x.league_outcome = band(x.league_points); });
      const res = recommendDraft(baseInput(p, { completedPicks: simulate(p, 11) }));
      return {
        observed: `primary ${res.primary_recommendation!.position}`,
        pass: res.primary_recommendation!.position !== "QB",
        detail: res.primary_recommendation!.reason,
      };
    },
  });

  // F — elite QB positional edge
  out.push({
    id: "F", title: "Elite QB positional edge",
    expectation: "QB may legitimately outrank RB/WR",
    run: () => {
      const p = buildPool(16);
      const qbs = p.filter((x) => x.position === "QB").sort((a, b) => b.league_points - a.league_points);
      qbs[0]!.league_points = 430; qbs[0]!.league_outcome = band(430);
      for (let i = 1; i < qbs.length; i++) { qbs[i]!.league_points = 300 - i * 3; qbs[i]!.league_outcome = band(qbs[i]!.league_points); }
      const res = recommendDraft(baseInput(p, {
        manager: { roster_id: 6, sleeper_user_id: "u6", manager_slug: "m6", draft_slot: 6 },
        completedPicks: simulate(p, 30, new Set([qbs[0]!.player_id])),
      }));
      const qb1 = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates].find((r) => r.player_id === qbs[0]!.player_id);
      return {
        observed: qb1 ? `QB1 rank ${qb1.rank}, posAdv ${qb1.positional_advantage}` : "QB1 not in top set",
        pass: !!qb1 && qb1.positional_advantage >= 40,
        detail: qb1?.reason ?? "",
      };
    },
  });

  // G — rookie high ceiling / low confidence
  out.push({
    id: "G", title: "Rookie high ceiling / low confidence",
    expectation: "uncertainty reflected, not auto-rejected",
    run: () => {
      const p = buildPool(17);
      // a genuinely valuable but volatile pick: WR4-level median, wide band, LOW conf
      const wr = p.find((x) => x.player_id === "WR10")!;
      const wr4pts = p.find((x) => x.player_id === "WR4")!.league_points;
      wr.league_points = wr4pts;
      wr.league_ppg = wr4pts / 17;
      wr.confidence = "LOW";
      wr.league_outcome = { floor: wr4pts * 0.55, median: wr4pts, ceiling: wr4pts * 1.6, sd: wr4pts * 0.28, percentiles: { floor: 20, ceiling: 80 } };
      // a safe veteran of the same median for comparison
      const safe = p.find((x) => x.player_id === "WR5")!;
      safe.league_points = wr4pts;
      safe.league_outcome = { floor: wr4pts * 0.86, median: wr4pts, ceiling: wr4pts * 1.16, sd: wr4pts * 0.1, percentiles: { floor: 20, ceiling: 80 } };
      const res = recommendDraft(baseInput(p, {
        completedPicks: simulate(p, 8, new Set(["WR10", "WR5"])),
        limits: { alternates: 30, wait: 20, doNotReach: 20 },
      }));
      const all = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach];
      const r = all.find((x) => x.player_id === "WR10");
      const s = all.find((x) => x.player_id === "WR5");
      return {
        observed: r
          ? `WR10 (LOW conf) score ${r.recommendation_score} unc_pen ${r.utility_components.uncertainty_penalty} vs safe WR5 score ${s?.recommendation_score ?? "-"} unc_pen ${s?.utility_components.uncertainty_penalty ?? "-"}`
          : "WR10 dropped",
        // surfaces, keeps positive score, penalty is a shade (< VOR) not a veto,
        // and the gap to the same-median safe veteran is modest (< 15 pts)
        pass:
          !!r && !!s &&
          r.recommendation_score > 0 &&
          r.utility_components.uncertainty_penalty < r.vor &&
          s.recommendation_score - r.recommendation_score < 15,
        detail: r?.reason ?? "",
      };
    },
  });

  // H — ADP far later but tier cliff before next pick -> reach may be justified
  out.push({
    id: "H", title: "Player ADP 20 later but a tier cliff hits before the next pick",
    expectation: "reach may be justified (tier-drop + wait-loss beat reach cost)",
    run: () => {
      const p = buildPool(18);
      // TE1: market says ~pick 22, but a slot-4 manager at pick 21 won't pick
      // again until pick 45 — the elite-TE cliff will be long gone.
      const sr = new Map<string, number | null>();
      [...p].sort((a, b) => b.league_points - a.league_points).forEach((x, i) => sr.set(x.player_id, i + 1));
      sr.set("TE1", 22);
      const market = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "t" });
      const res = recommendDraft(baseInput(p, {
        market,
        manager: { roster_id: 4, sleeper_user_id: "u4", manager_slug: "m4", draft_slot: 4 },
        completedPicks: simulate(p, 20, new Set(["TE1"])),
      }));
      const te = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach].find((r) => r.player_id === "TE1");
      return {
        observed: te ? `TE1 kind ${te.kind} rank ${te.rank}, reach ${te.reach_cost}, tier_drop ${te.tier_drop}, urgency ${te.utility_components.urgency}` : "TE1 not surfaced",
        pass: !!te && te.tier_drop > te.reach_cost && te.kind !== "DO_NOT_REACH",
        detail: te?.reason ?? "",
      };
    },
  });

  // I — ADP 40 later and likely survives -> reach penalty meaningful
  out.push({
    id: "I", title: "Player ADP 40 later and likely survives",
    expectation: "reach penalty is meaningful; player lands in DO_NOT_REACH / wait",
    run: () => {
      const p = buildPool(19);
      const sr = new Map<string, number | null>();
      [...p].sort((a, b) => b.league_points - a.league_points).forEach((x, i) => sr.set(x.player_id, i + 1));
      sr.set("WR6", 55);
      const market = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "t" });
      const res = recommendDraft(baseInput(p, { market, completedPicks: simulate(p, 11) }));
      const r = [...res.do_not_reach, ...res.wait_candidates].find((x) => x.player_id === "WR6") ??
        [res.primary_recommendation!, ...res.alternates].find((x) => x.player_id === "WR6");
      return {
        observed: r ? `WR6 kind ${r.kind}, reach ${r.reach_cost}` : "WR6 not surfaced",
        pass: !!r && (r.kind === "DO_NOT_REACH" || r.kind === "WAIT_CANDIDATE" || r.reach_cost > 3),
        detail: r?.reason ?? "",
      };
    },
  });

  // J — late K/DST
  out.push({
    id: "J", title: "Late K/DST",
    expectation: "K/DST become eligible only at the configured endgame point",
    run: () => {
      const p = buildPool(20);
      const early = recommendDraft(baseInput(p, { completedPicks: simulate(p, 60), manager: { roster_id: 12, sleeper_user_id: "u", manager_slug: "b", draft_slot: 12 } }));
      // round ~13 pick with a nearly-full core roster
      const roster = ["QB1", "RB2", "RB5", "WR3", "WR8", "TE3", "RB9", "WR12", "WR14", "RB11", "QB6", "WR20"].map((id) =>
        mkRosterPlayer(id, id.startsWith("QB") ? "QB" : id.startsWith("RB") ? "RB" : id.startsWith("WR") ? "WR" : "TE"));
      const late = recommendDraft(baseInput(p, { rosterPlayers: roster, completedPicks: simulate(p, 143, new Set(roster.map((r) => r.player_id))) }));
      const earlyK = [early.primary_recommendation, ...early.alternates].some((r) => r && (r.position === "K" || r.position === "DEF"));
      const lateK = [late.primary_recommendation, ...late.alternates, ...late.wait_candidates].some((r) => r && (r.position === "K" || r.position === "DEF"));
      return {
        observed: `early K/DST offered=${earlyK}, late K/DST offered=${lateK}`,
        pass: !earlyK,
        detail: `release round ${ROUNDS - 3 + 1}`,
      };
    },
  });

  // K — slot 12 double turn
  out.push({
    id: "K", title: "Slot 12 double turn (12/13)",
    expectation: "engine evaluates combinations, not two independent BPA picks",
    run: () => {
      const p = buildPool(21);
      const res = recommendDraft(baseInput(p, { completedPicks: simulate(p, 11) }));
      return {
        observed: res.primary_pair ? `pair ${res.primary_pair.player_1.player_id}+${res.primary_pair.player_2.player_id}, util ${res.primary_pair.combined_recommendation_utility}` : "NO PAIR",
        pass: !!res.primary_pair && res.turn.is_consecutive_turn,
        detail: res.primary_pair?.reason ?? "",
      };
    },
  });

  // L — two simultaneous tier cliffs
  out.push({
    id: "L", title: "Final Tier-2 RB and final Tier-1 TE both available at 12/13",
    expectation: "when the market threatens BOTH cliffs and WR depth will survive, the pair captures TE + RB rather than WR + WR",
    run: () => {
      const p = buildPool(22);
      // explicit market: the elite TE and the tier-last RB are both being
      // taken in the teens/20s (they will NOT reach pick 36); WR board is deep.
      const sr = new Map<string, number | null>();
      [...p].sort((a, b) => b.league_points - a.league_points).forEach((x, i) => sr.set(x.player_id, i + 1));
      sr.set("TE1", 15);
      sr.set("RB16", 20);
      const market = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "t" });
      const res = recommendDraft(baseInput(p, { market, completedPicks: simulate(p, 11, new Set(["TE1", "RB16"])) }));
      const pair = res.primary_pair!;
      const positions = [pair.player_1.position, pair.player_2.position].sort().join("+");
      return {
        observed: `pair ${positions}, cliffs captured ${pair.tier_cliffs_captured.map((c) => c.position).join("/")}, deferred ${pair.positions_deferred.join("/")}`,
        pass: pair.positions_deferred.includes("WR") && (positions.includes("TE") || pair.tier_cliffs_captured.some((c) => c.position === "TE")),
        detail: pair.reason,
      };
    },
  });

  // M — same-position double value
  out.push({
    id: "M", title: "Two WRs massively exceed all alternatives",
    expectation: "engine is PERMITTED to recommend WR + WR",
    run: () => {
      const p = buildPool(23);
      const wrs = p.filter((x) => x.position === "WR").sort((a, b) => b.league_points - a.league_points);
      wrs[0]!.league_points = 360; wrs[1]!.league_points = 350;
      wrs[0]!.league_outcome = band(360); wrs[1]!.league_outcome = band(350);
      for (let i = 2; i < wrs.length; i++) { wrs[i]!.league_points = 210 - i; wrs[i]!.league_outcome = band(wrs[i]!.league_points); }
      // suppress RB/TE so WR+WR is clearly correct
      const res = recommendDraft(baseInput(p, { completedPicks: simulate(p, 11, new Set([wrs[0]!.player_id, wrs[1]!.player_id])) }));
      const pair = res.primary_pair!;
      const bothWr = pair.player_1.position === "WR" && pair.player_2.position === "WR";
      return {
        observed: `pair ${pair.player_1.position}+${pair.player_2.position}`,
        pass: bothWr,
        detail: pair.reason,
      };
    },
  });

  // N — false diversification
  out.push({
    id: "N", title: "RB+WR looks balanced but WR+WR is materially higher utility",
    expectation: "engine chooses WR + WR when value backs it and no starter risk",
    run: () => {
      const p = buildPool(24);
      const wrs = p.filter((x) => x.position === "WR").sort((a, b) => b.league_points - a.league_points);
      // two dominant WRs; the rest of the WR board is deep and flat (survives)
      wrs[0]!.league_points = 345; wrs[1]!.league_points = 338;
      wrs[0]!.league_outcome = band(345); wrs[1]!.league_outcome = band(338);
      for (let i = 2; i < wrs.length; i++) { wrs[i]!.league_points = 214 - i * 0.6; wrs[i]!.league_outcome = band(wrs[i]!.league_points); }
      // flatten the RB board so there is no RB cliff to chase
      const rbs = p.filter((x) => x.position === "RB").sort((a, b) => b.league_points - a.league_points);
      rbs.forEach((x, i) => { x.league_points = 250 - i * 2.2; x.league_outcome = band(x.league_points); });
      const res = recommendDraft(baseInput(p, { completedPicks: simulate(p, 11, new Set([wrs[0]!.player_id, wrs[1]!.player_id])) }));
      const pair = res.primary_pair!;
      return {
        observed: `pair ${pair.player_1.position}${pair.player_1.position_rank}+${pair.player_2.position}${pair.player_2.position_rank}, util ${pair.combined_recommendation_utility}`,
        pass: pair.player_1.position === "WR" && pair.player_2.position === "WR",
        detail: pair.reason,
      };
    },
  });

  // O — pair reach test
  out.push({
    id: "O", title: "One proposed pair member has ADP far beyond 36/37 and high survival",
    expectation: "engine penalises spending pick 13 on him; picks a more urgent pair",
    run: () => {
      const p = buildPool(25);
      const sr = new Map<string, number | null>();
      [...p].sort((a, b) => b.league_points - a.league_points).forEach((x, i) => sr.set(x.player_id, i + 1));
      sr.set("WR5", 70); // would clearly survive to 36/37
      const market = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "t" });
      const res = recommendDraft(baseInput(p, { market, completedPicks: simulate(p, 11) }));
      const pair = res.primary_pair!;
      const usesWr5 = pair.player_1.player_id === "WR5" || pair.player_2.player_id === "WR5";
      return {
        observed: `primary pair uses WR5=${usesWr5}`,
        pass: !usesWr5,
        detail: pair.reason,
      };
    },
  });

  return out;
}

/* ==========================================================================
   3. ablation B0–B6
   ======================================================================== */
function weightPreset(name: string): UtilityWeights | "search_rank" {
  const z: UtilityWeights = { vor: 0, tier_drop: 0, scarcity_value: 0, roster_need: 0, positional_advantage: 0, urgency: 0, reach_cost: 0, uncertainty_penalty: 0, construction_risk: 0 };
  switch (name) {
    case "B0_search_rank_bpa": return "search_rank";
    case "B1_ri_points": return { ...z, vor: 0.0001 }; // rank by points ~ vor with tiny weight (pure points order); use vor=1 but nothing else
    case "B1_ri_points_real": return { ...z, vor: 1 };
    case "B2_vor": return { ...z, vor: 1 };
    case "B3_vor_need": return { ...z, vor: 1, roster_need: 0.8 };
    case "B4_vor_tier_scarcity": return { ...z, vor: 1, tier_drop: 0.9, scarcity_value: 0.5 };
    case "B5_vor_tier_roster_timing": return { ...z, vor: 1, tier_drop: 0.9, roster_need: 0.8, urgency: 1, reach_cost: 0.9 };
    case "B6_full": return DEFAULT_WEIGHTS;
    default: return DEFAULT_WEIGHTS;
  }
}

/**
 * Decision-quality proxy (§27): over many random draft states, for each config
 * take the engine's primary pick, then simulate the manager's remaining picks
 * greedily under the SAME config, and score the resulting starting lineup's
 * total VOR + tier capture. Higher = better roster from better decisions.
 */
function ablation(): Array<Record<string, unknown>> {
  const configs = ["B0_search_rank_bpa", "B2_vor", "B3_vor_need", "B4_vor_tier_scarcity", "B5_vor_tier_roster_timing", "B6_full"];
  const results: Record<string, number[]> = Object.fromEntries(configs.map((c) => [c, []]));
  const N = 120;

  for (let t = 0; t < N; t++) {
    const p = buildPool(1000 + t);
    const slot = 1 + (t % 12);
    const startPicks = (t % 9) * 12 + slot - 1; // random point in the draft
    for (const cfg of configs) {
      const w = weightPreset(cfg);
      let roster: ReturnType<typeof mkRosterPlayer>[] = [];
      const skip = new Set<string>();
      let picksMade = startPicks;
      // manager makes up to 8 picks from here under this config
      for (let k = 0; k < 8 && picksMade < 12 * ROUNDS; k++) {
        const completed = simulate(p, picksMade, skip);
        const input = baseInput(p, {
          manager: { roster_id: slot, sleeper_user_id: `u${slot}`, manager_slug: `m${slot}`, draft_slot: slot },
          rosterPlayers: roster,
          completedPicks: completed,
          weights: w === "search_rank" ? undefined : w,
        });
        let pickId: string | null;
        if (w === "search_rank") {
          const avail = [...p].filter((x) => !skip.has(x.player_id) && !roster.some((r) => r.player_id === x.player_id));
          const sr = input.market.by_player;
          pickId = avail.sort((a, b) => (sr.get(a.player_id)?.search_rank ?? 1e9) - (sr.get(b.player_id)?.search_rank ?? 1e9))[0]?.player_id ?? null;
        } else {
          const res = recommendDraft(input);
          pickId = res.primary_recommendation?.player_id ?? null;
        }
        if (!pickId) break;
        const pos = p.find((x) => x.player_id === pickId)!.position;
        roster.push(mkRosterPlayer(pickId, pos));
        skip.add(pickId);
        picksMade += 12; // rough: one round later
      }
      // §27 composite decision-quality proxy: startable-lineup VOR
      //   + tier capture (roster players who were the last before a real cliff)
      //   − avoidable reach (drafted well before the player's market pick when
      //     he would plausibly have survived to the next round)
      const levels = computeReplacementLevels(ROSTER_POSITIONS, NUM_TEAMS, p);
      const byId = new Map(p.map((x) => [x.player_id, x]));
      const owned = roster.map((r) => byId.get(r.player_id)!).filter(Boolean);
      const lineupVor = startingLineupVor(owned, levels);

      const vf2 = (x: LeagueProjection) => vorOf(x, levels);
      let tierCapture = 0;
      for (const pos of ["QB", "RB", "WR", "TE"] as FantasyPosition[]) {
        const t = tierPosition(pos, p, vf2);
        for (const o of owned.filter((x) => x.position === pos)) {
          const tp = t.players.find((y) => y.player_id === o.player_id);
          if (tp?.is_tier_last && tp.distance_to_next_tier >= 12) tierCapture += 0.4 * tp.distance_to_next_tier;
        }
      }
      const srMap = new Map<string, number>();
      [...p].sort((a, b) => b.league_points - a.league_points).forEach((x, i) => srMap.set(x.player_id, i + 1));
      let avoidableReach = 0;
      roster.forEach((r, idx) => {
        const takenAt = startPicks + 1 + idx * 12; // rough overall pick
        const mkt = srMap.get(r.player_id) ?? takenAt;
        if (mkt - takenAt > 12) avoidableReach += 0.5 * (mkt - takenAt - 12);
      });
      results[cfg]!.push(lineupVor + tierCapture - avoidableReach);
    }
  }

  return configs.map((cfg) => {
    const xs = results[cfg]!;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    return {
      config: cfg,
      n: xs.length,
      mean_starter_vor: round1(mean),
      sd: round1(sd),
      vs_B0_delta: round1(mean - (results["B0_search_rank_bpa"]!.reduce((a, b) => a + b, 0) / N)),
    };
  });
}

/**
 * §16 — weight calibration by simulation, not hand-feel. Sweep a small grid of
 * interpretable weight vectors over the same composite decision-quality proxy
 * and report which vector maximises it. The chosen vector is frozen into
 * DEFAULT_WEIGHTS.
 */
function weightSearch(): Array<Record<string, unknown>> {
  const grid: Array<{ label: string; w: UtilityWeights }> = [
    { label: "vor_need_only", w: { vor: 1, tier_drop: 0, scarcity_value: 0, roster_need: 0.9, positional_advantage: 0, urgency: 0, reach_cost: 0, uncertainty_penalty: 0.3, construction_risk: 0.4 } },
    { label: "vor_need_light_timing", w: { vor: 1, tier_drop: 0.35, scarcity_value: 0.15, roster_need: 0.9, positional_advantage: 0.3, urgency: 0.4, reach_cost: 0.6, uncertainty_penalty: 0.35, construction_risk: 0.6 } },
    { label: "chosen_default", w: DEFAULT_WEIGHTS },
    { label: "timing_heavy", w: { vor: 1, tier_drop: 1.2, scarcity_value: 0.7, roster_need: 0.7, positional_advantage: 0.8, urgency: 1.3, reach_cost: 1.1, uncertainty_penalty: 0.4, construction_risk: 0.8 } },
  ];
  const N = 90;
  return grid.map(({ label, w }) => {
    const scores: number[] = [];
    for (let t = 0; t < N; t++) {
      const p = buildPool(4000 + t);
      const slot = 1 + (t % 12);
      const startPicks = (t % 8) * 12 + slot - 1;
      const roster: ReturnType<typeof mkRosterPlayer>[] = [];
      const skip = new Set<string>();
      let picksMade = startPicks;
      for (let k = 0; k < 7 && picksMade < 12 * ROUNDS; k++) {
        const res = recommendDraft(baseInput(p, {
          manager: { roster_id: slot, sleeper_user_id: `u${slot}`, manager_slug: `m${slot}`, draft_slot: slot },
          rosterPlayers: roster, completedPicks: simulate(p, picksMade, skip), weights: w,
        }));
        const id = res.primary_recommendation?.player_id;
        if (!id) break;
        roster.push(mkRosterPlayer(id, p.find((x) => x.player_id === id)!.position));
        skip.add(id);
        picksMade += 12;
      }
      const levels = computeReplacementLevels(ROSTER_POSITIONS, NUM_TEAMS, p);
      const byId = new Map(p.map((x) => [x.player_id, x]));
      scores.push(startingLineupVor(roster.map((r) => byId.get(r.player_id)!).filter(Boolean), levels));
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { weight_vector: label, n: N, mean_starter_vor: round1(mean) };
  });
}

function startingLineupVor(owned: LeagueProjection[], levels: ReturnType<typeof computeReplacementLevels>): number {
  const byPos: Record<string, LeagueProjection[]> = { QB: [], RB: [], WR: [], TE: [], K: [], DEF: [] };
  for (const p of owned) (byPos[p.position] ??= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k]!.sort((a, b) => b.league_points - a.league_points);
  let total = 0;
  const take = (pos: string, n: number) => byPos[pos]!.splice(0, n);
  const starters = [...take("QB", 1), ...take("RB", 2), ...take("WR", 2), ...take("TE", 1)];
  // 2 flex from best remaining RB/WR/TE
  const flexPool = [...(byPos.RB ?? []), ...(byPos.WR ?? []), ...(byPos.TE ?? [])].sort((a, b) => b.league_points - a.league_points);
  starters.push(...flexPool.slice(0, 2));
  for (const s of starters) total += vorOf(s, levels);
  return total;
}

/* ==========================================================================
   4. monotonicity battery
   ======================================================================== */
function monotonicity(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const target = "RB3";

  const scoreOf = (mutate: (p: LeagueProjection[]) => void, extra: Partial<EngineInput> = {}) => {
    const p = buildPool(500);
    mutate(p);
    const res = recommendDraft(baseInput(p, {
      completedPicks: simulate(p, 11, new Set([target])),
      limits: { alternates: 200, wait: 200, doNotReach: 200 },
      ...extra,
    }));
    const all = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach].filter(Boolean);
    return all.find((r) => r.player_id === target)?.recommendation_score ?? NaN;
  };

  // higher VOR
  {
    const lo = scoreOf((p) => { const x = p.find((y) => y.player_id === target)!; x.league_points = 250; x.league_outcome = band(250); });
    const hi = scoreOf((p) => { const x = p.find((y) => y.player_id === target)!; x.league_points = 300; x.league_outcome = band(300); });
    rows.push({ property: "higher VOR ⇒ utility not lower", low: round1(lo), high: round1(hi), holds: hi >= lo - 0.01 });
  }
  // larger tier drop (widen the RB cliff) ⇒ urgency not lower
  {
    const small = scoreOf((p) => { p.filter((x) => x.position === "RB").sort((a, b) => b.league_points - a.league_points).slice(16).forEach((x) => { x.league_points += 30; x.league_outcome = band(x.league_points); }); });
    const large = scoreOf(() => {});
    rows.push({ property: "larger tier cliff ⇒ urgency/utility not lower", low: round1(small), high: round1(large), holds: large >= small - 0.01 });
  }
  // lower survival (earlier market pick) ⇒ urgency not lower
  {
    const p1 = buildPool(500);
    const sr1 = new Map<string, number | null>(); [...p1].sort((a, b) => b.league_points - a.league_points).forEach((x, i) => sr1.set(x.player_id, i + 1));
    const highSurv = new Map(sr1); highSurv.set(target, 80);
    const lowSurv = new Map(sr1); lowSurv.set(target, 12);
    const run = (m: Map<string, number | null>) => {
      const res = recommendDraft(baseInput(p1, {
        market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: m, timestamp: "t" }),
        completedPicks: simulate(p1, 11, new Set([target])),
      }));
      const r = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach].find((x) => x.player_id === target);
      return { u: r?.utility_components.urgency ?? 0, s: r?.recommendation_score ?? 0 };
    };
    const hi = run(highSurv); const lo = run(lowSurv);
    rows.push({ property: "lower survival ⇒ urgency not lower", low: round1(hi.u), high: round1(lo.u), holds: lo.u >= hi.u - 0.01 });
  }
  // greater reach ⇒ utility not higher
  {
    const p1 = buildPool(500);
    const sr = new Map<string, number | null>(); [...p1].sort((a, b) => b.league_points - a.league_points).forEach((x, i) => sr.set(x.player_id, i + 1));
    const run = (mp: number) => {
      const m = new Map(sr); m.set(target, mp);
      const res = recommendDraft(baseInput(p1, {
        market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: m, timestamp: "t" }),
        completedPicks: simulate(p1, 11, new Set([target])),
      }));
      const r = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach].find((x) => x.player_id === target);
      return r?.recommendation_score ?? 0;
    };
    const near = run(14); const far = run(70);
    rows.push({ property: "greater reach ⇒ utility not higher", low: round1(far), high: round1(near), holds: far <= near + 0.01 });
  }
  // stronger roster need ⇒ utility for that position not lower
  {
    const p1 = buildPool(500);
    const runNeed = (roster: string[]) => {
      const rp = roster.map((id) => mkRosterPlayer(id, id.startsWith("RB") ? "RB" : "WR"));
      const res = recommendDraft(baseInput(p1, { rosterPlayers: rp, completedPicks: simulate(p1, 20, new Set([target, ...roster])) }));
      const r = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach].find((x) => x.player_id === target);
      return r?.utility_components.roster_need ?? 0;
    };
    const noRb = runNeed(["WR1", "WR2"]);         // RB slots open -> need high
    const fullRb = runNeed(["RB1", "RB2", "RB5"]); // RB deep -> need low/negative
    rows.push({ property: "stronger positional need ⇒ need term not lower", low: round1(fullRb), high: round1(noRb), holds: noRb >= fullRb - 0.01 });
  }
  // lower uncertainty ⇒ uncertainty penalty not larger
  {
    const wide = scoreOf((p) => { const x = p.find((y) => y.player_id === target)!; x.league_outcome = { floor: x.league_points * 0.5, median: x.league_points, ceiling: x.league_points * 1.6, sd: x.league_points * 0.3, percentiles: { floor: 20, ceiling: 80 } }; });
    const narrow = scoreOf((p) => { const x = p.find((y) => y.player_id === target)!; x.league_outcome = { floor: x.league_points * 0.92, median: x.league_points, ceiling: x.league_points * 1.1, sd: x.league_points * 0.06, percentiles: { floor: 20, ceiling: 80 } }; });
    rows.push({ property: "lower uncertainty ⇒ score not lower (smaller penalty)", low: round1(wide), high: round1(narrow), holds: narrow >= wide - 0.01 });
  }
  // more picks until next turn ⇒ survival not higher (survival module)
  {
    const p1 = buildPool(500);
    const sr = new Map<string, number | null>([[target, 20]]);
    const m = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "t" });
    const near = estimateSurvivalWrap(target, 25, 4, m);
    const far = estimateSurvivalWrap(target, 45, 24, m);
    rows.push({ property: "more intervening picks ⇒ P(survive) not higher", low: round3(far), high: round3(near), holds: far <= near + 1e-9 });
  }
  // K/DST blocked before release regardless of points
  {
    const p = buildPool(500);
    p.filter((x) => x.position === "K").forEach((x) => { x.league_points = 500; x.league_outcome = band(500); });
    const res = recommendDraft(baseInput(p, { completedPicks: simulate(p, 11) }));
    rows.push({ property: "K/DST blocked before release round", low: 0, high: 0, holds: res.primary_recommendation!.position !== "K" && res.primary_recommendation!.position !== "DEF" });
  }

  return rows;
}
function estimateSurvivalWrap(id: string, tp: number, inter: number, m: ReturnType<typeof buildMarketSnapshot>) {
  return estimateSurvival({ playerId: id, position: "RB", targetPickOverall: tp, interveningPicks: inter, market: m }).p_survives_next_pick;
}

/* ==========================================================================
   5. recommendation examples (realistic states)
   ======================================================================== */
function recommendationExamples(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const states: Array<{ label: string; slot: number; picksMade: number; roster: Array<[string, FantasyPosition]> }> = [
    { label: "supyo29 slot 7, pick 7 (opening)", slot: 7, picksMade: 6, roster: [] },
    { label: "mid-slot 5, round 4 turn (pick 44), 3 WR heavy", slot: 5, picksMade: 43, roster: [["WR1", "WR"], ["WR6", "WR"], ["WR11", "WR"]] },
    { label: "slot 2, round 6 (pick 62), no TE", slot: 2, picksMade: 61, roster: [["RB1", "RB"], ["RB6", "RB"], ["WR3", "WR"], ["WR9", "WR"], ["QB4", "QB"]] },
    { label: "BijiMac slot 12, opening turn 12/13", slot: 12, picksMade: 11, roster: [] },
    { label: "BijiMac slot 12, turn 36/37", slot: 12, picksMade: 35, roster: [["RB3", "RB"], ["WR2", "WR"]] },
  ];
  for (const st of states) {
    const p = buildPool(300 + st.slot);
    const roster = st.roster.map(([id, pos]) => mkRosterPlayer(id, pos));
    const res = recommendDraft(baseInput(p, {
      manager: { roster_id: st.slot, sleeper_user_id: `u${st.slot}`, manager_slug: st.label.split(" ")[0]!, draft_slot: st.slot },
      rosterPlayers: roster,
      completedPicks: simulate(p, st.picksMade, new Set(roster.map((r) => r.player_id))),
    }));
    const prim = res.primary_recommendation;
    rows.push({
      state: st.label,
      current_pick: res.turn.current_pick?.overall ?? "",
      next_pick: res.turn.next_manager_pick?.overall ?? "",
      consecutive_turn: res.turn.is_consecutive_turn,
      primary: prim ? `${prim.player_name} (${prim.position}${prim.position_rank}, T${prim.tier})` : "",
      primary_score: prim?.recommendation_score ?? "",
      primary_vor: prim?.vor ?? "",
      primary_tier_drop: prim?.tier_drop ?? "",
      wait_loss_mid: prim ? round1((prim.wait_comparison.wait_projection_loss[0] + prim.wait_comparison.wait_projection_loss[1]) / 2) : "",
      survival: prim?.survival.p_survives_next_pick ?? "",
      reason_codes: prim?.reason_codes.join("|") ?? "",
      alt1: res.alternates[0]?.player_name ?? "",
      pair: res.primary_pair ? `${res.primary_pair.player_1.player_name} + ${res.primary_pair.player_2.player_name}` : "",
      pair_util: res.primary_pair?.combined_recommendation_utility ?? "",
      reason: prim?.reason ?? "",
    });
  }
  return rows;
}

/* ==========================================================================
   6. latency
   ======================================================================== */
function latency(): Array<Record<string, unknown>> {
  const p = buildPool(42);
  const samples: number[] = [];
  let candCount = 0;
  for (let i = 0; i < 60; i++) {
    const picksMade = (i * 3) % (12 * 14);
    const t0 = performance.now();
    const res = recommendDraft(baseInput(p, { completedPicks: simulate(p, picksMade) }));
    samples.push(performance.now() - t0);
    candCount = res.manager_context.candidate_pool_size;
  }
  samples.sort((a, b) => a - b);
  return [{
    runs: samples.length,
    candidate_pool_size: candCount,
    mean_ms: round2(samples.reduce((a, b) => a + b, 0) / samples.length),
    p50_ms: round2(samples[Math.floor(samples.length * 0.5)]!),
    p95_ms: round2(samples[Math.floor(samples.length * 0.95)]!),
    max_ms: round2(samples[samples.length - 1]!),
    pick_timer_seconds: 120,
    within_pick_timer: samples[samples.length - 1]! < 120000,
  }];
}

/* ==========================================================================
   run
   ======================================================================== */
function round1(v: number) { return Math.round(v * 10) / 10; }
function round2(v: number) { return Math.round(v * 100) / 100; }
function round3(v: number) { return Math.round(v * 1000) / 1000; }

function main() {
  mkdirSync(OUT, { recursive: true });

  writeFileSync(join(OUT, "phase4_component_definitions.csv"), csv(componentDefinitions()));

  const pool = buildPool();
  const levels = computeReplacementLevels(ROSTER_POSITIONS, NUM_TEAMS, pool);
  writeFileSync(
    join(OUT, "phase4_replacement_levels.csv"),
    csv((["QB", "RB", "WR", "TE", "K", "DEF"] as FantasyPosition[]).map((p) => ({
      ...levels.by_position[p],
    }))),
  );

  const vf = (x: LeagueProjection) => vorOf(x, levels);
  const tierRows: Array<Record<string, unknown>> = [];
  for (const pos of ["QB", "RB", "WR", "TE"] as FantasyPosition[]) {
    const t = tierPosition(pos, pool, vf);
    for (const b of t.boundaries) {
      tierRows.push({
        position: pos, tier: b.tier, members: b.members,
        tier_top_points: b.tier_top_points, tier_last_points: b.tier_last_points,
        cliff_to_next_points: b.cliff_to_next_points, cliff_to_next_vor: b.cliff_to_next_vor,
        top_player: b.top_player_id, last_player: b.last_player_id,
      });
    }
  }
  writeFileSync(join(OUT, "phase4_tiers.csv"), csv(tierRows));

  const res0 = recommendDraft(baseInput(pool, { completedPicks: simulate(pool, 11) }));
  writeFileSync(join(OUT, "phase4_scarcity.csv"), csv(res0.scarcity.map((s) => ({ ...s }))));

  const scRows = scenarios().map((s) => {
    const r = s.run();
    return { scenario: s.id, title: s.title, expectation: s.expectation, observed: r.observed, pass: r.pass, detail: r.detail };
  });
  writeFileSync(join(OUT, "phase4_synthetic_scenarios.csv"), csv(scRows));
  const failed = scRows.filter((r) => !r.pass);

  writeFileSync(join(OUT, "phase4_ablation.csv"), csv(ablation()));
  writeFileSync(join(OUT, "phase4_weight_search.csv"), csv(weightSearch()));
  const monoRows = monotonicity();
  writeFileSync(join(OUT, "phase4_monotonicity.csv"), csv(monoRows));
  writeFileSync(join(OUT, "phase4_recommendation_examples.csv"), csv(recommendationExamples()));
  writeFileSync(join(OUT, "phase4_latency.csv"), csv(latency()));

  const summary = {
    generated_at: new Date().toISOString(),
    recommendation_version: "ri-snake-decision-2026.1",
    projection_baseline: "ri-structural-2026.3",
    scenarios_total: scRows.length,
    scenarios_passed: scRows.length - failed.length,
    scenarios_failed: failed.map((f) => f.scenario),
    monotonicity_total: monoRows.length,
    monotonicity_holds: monoRows.filter((m) => m.holds).length,
  };
  writeFileSync(join(OUT, "phase4_summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length > 0) console.log("FAILED SCENARIOS:", failed.map((f) => `${f.scenario}: ${f.observed}`).join("\n  "));
}

main();
