/**
 * PHASE 6 §25/§26/§29/§31 — multi-round snake draft simulation.
 *
 *   npx tsx scripts/phase6-simulation.ts [--n 800]
 *
 * Simulates complete 12-team, 15-round Bloodline Bowl snake drafts against the
 * REAL live 2026 player pool + frozen ri-structural-2026.3 projections, for
 * one focal manager at a time, under 5 strategies:
 *
 *   D0  Sleeper search_rank best-player-available
 *   D1  RI projected-points BPA
 *   D2  RI VOR BPA
 *   D3  frozen Phase 4/5 recommendation engine (primary_recommendation each pick)
 *   D4  D3 + a bounded, roster-need-GATED multi-turn trajectory adjustment
 *       (research candidate — NOT wired into production unless promoted)
 *
 * Opponents are NOT deterministic BPA: each pick is sampled from a market-rank
 * softmax (Phase 5 `expected_pick`, falling back to search_rank) with a mild
 * roster-need multiplier (§28) and the same hard K/DST release gate as the
 * focal manager. Paired seeds (§31): for a given (slot, sim index) all 5
 * strategies see IDENTICAL opponent draws, so paired bootstrap comparison is
 * valid.
 *
 * Writes outputs/projections-2026/phase6_*.csv.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { buildBaseProjections, buildLeagueProjections } from "@/lib/projections/build";
import { loadLeagueConfig } from "@/lib/projections/service";
import { findLeagueTarget } from "@/lib/leagues/registry";
import { getPlayerIndex } from "@/lib/sleeper/client";
import type { FantasyPosition, LeagueProjection } from "@/lib/projections/schema";
import { overallPickNumber } from "@/lib/bridge/geometry";
import { recommendDraft, type CompletedPick, type EngineInput } from "@/lib/draft/engine";
import { buildMarketConsensusSnapshot, type MarketSnapshot } from "@/lib/draft/survival";
import { evaluateKdstGate, isKdst } from "@/lib/draft/kdst";
import {
  assignOptimalRoster,
  computeRosterUtility,
  leagueMedianStarterVor,
  starterSlotsOf,
  DEFAULT_ROSTER_UTILITY_WEIGHTS,
  type StarterSlots,
} from "@/lib/draft/roster-utility";
import { computeReplacementLevels, vorOf, type ReplacementLevels } from "@/lib/draft/replacement";
import type { DraftRecommendation } from "@/lib/draft/schema";

const OUT = join("outputs", "projections-2026");
const NUM_TEAMS = 12;
const ROUNDS = 15;
const SKILL: FantasyPosition[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

/* ------------------------------------------------------------ deterministic RNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------ CSV helper */
const csv = (rows: Array<Record<string, unknown>>): string => {
  if (rows.length === 0) return "\n";
  const keys = Object.keys(rows[0]!);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => {
    const v = r[k]; const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))].join("\n") + "\n";
};

/* ================================================================== setup */

export interface SimContext {
  pool: LeagueProjection[];
  rosterPositions: string[];
  numTeams: number;
  rounds: number;
  slots: StarterSlots;
  levels: ReplacementLevels;
  medianStarterVor: Partial<Record<FantasyPosition, number>>;
  market: MarketSnapshot;
  scoringHash: string;
  provenance: EngineInput["provenance"];
}

/**
 * DISCOVERED PHASE 6 DEFECT (documented in PHASE6_REPORT.md §critical defects):
 * `lib/projections/build.ts` only builds Layer-1 projections for the offensive
 * team-environment positions (`SKILL = [QB,RB,WR,TE]`) — K and DEF have ZERO
 * entries in `league.projections`, even though the Layer-2 scoring translation
 * (`league.ts`) already has K/DEF bucket-expansion logic ready for them. This
 * is a pre-existing Phase 1-3 projection-pool gap, NOT something Phase 4/5/6
 * introduced or is chartered to fix (§1: consume the frozen projection engine,
 * do not recalibrate it). The frozen `recommendDraft` engine degrades
 * correctly when this happens (readiness.degraded_reasons names it) — it
 * simply can never recommend a real K/DEF today.
 *
 * For Phase 6's roster-COMPLETION research question to be answerable at all,
 * the simulation needs SOME K/DEF entries in the pool. This injects real
 * Sleeper K/DEF players with a simple synthetic point curve (search_rank
 * order only — no opportunity model, explicitly not a production projection)
 * — RESEARCH-ONLY, confined to this simulation harness.
 */
async function syntheticKdstPool(numTeams: number): Promise<LeagueProjection[]> {
  const idx = await getPlayerIndex();
  const rows: LeagueProjection[] = [];
  for (const pos of ["K", "DEF"] as const) {
    const players = [...idx.values()]
      .filter((p) => p.position === pos && p.active !== false && p.team)
      .sort((a, b) => (a.search_rank ?? 9999) - (b.search_rank ?? 9999))
      .slice(0, Math.max(24, numTeams * 2));
    players.forEach((p, i) => {
      const points = pos === "K" ? Math.max(60, 130 - i * 2.2) : Math.max(50, 120 - i * 2.4);
      rows.push({
        player_id: p.player_id, full_name: p.full_name, position: pos, team: p.team,
        league_slug: "phase6-synthetic", league_id: "0", scoring_hash: "sha_synthetic_kdst",
        league_points: round2(points), league_ppg: round2(points / 17),
        league_outcome: { floor: points * 0.75, median: points, ceiling: points * 1.25, sd: points * 0.15, percentiles: { floor: 20, ceiling: 80 } },
        sleeper_league_points: null,
        vs_sleeper: { delta_points: null, delta_pct: null, ri_rank: null, sleeper_rank: null, rank_delta: null, primary_driver: null },
        replacement_points: null, value_over_replacement: null, vor_rank: null, position_rank: null, overall_rank: null, tier: null,
        confidence: "LOW",
      });
    });
  }
  return rows;
}

export async function buildContext(): Promise<SimContext> {
  const target = findLeagueTarget("bloodline-bowl")!;
  const cfg = await loadLeagueConfig("bloodline-bowl", target.league_id);
  const base = await buildBaseProjections({ season: 2026 });
  const league = buildLeagueProjections(base, cfg);
  const kdst = await syntheticKdstPool(cfg.num_teams);
  const pool = [...league.projections, ...kdst];
  const slots = starterSlotsOf(cfg.roster_positions);
  const levels = computeReplacementLevels(cfg.roster_positions, cfg.num_teams, pool);
  const medianStarterVor = leagueMedianStarterVor(pool, slots, cfg.num_teams, levels);
  const searchRankByPlayer = new Map<string, number | null>();
  // pull search_rank straight off the projections' comparison-free path: use league pool ids with
  // whatever the market table already carries (build once, reused for every simulated draft)
  const market = buildMarketConsensusSnapshot({ searchRankByPlayer: new Map(pool.map((p) => [p.player_id, null])) });
  return {
    pool,
    rosterPositions: cfg.roster_positions,
    numTeams: cfg.num_teams,
    rounds: ROUNDS,
    slots,
    levels,
    medianStarterVor,
    market,
    scoringHash: league.scoring_hash,
    provenance: {
      projection_source: "phase6-sim",
      projection_version: base.model_version,
      projection_timestamp: base.generated_at,
      league_scoring_hash: league.scoring_hash,
      draft_state_timestamp: new Date().toISOString(),
    },
  };
}

/* ================================================================== opponent model */

const kdstReleaseOK = (round: number, roster: LeagueProjection[], rounds: number, rosterPositions: string[], slots: StarterSlots): boolean => {
  const bySlots = starterSlotsOf(rosterPositions);
  const have: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const p of roster) if (p.position in have) have[p.position]! += 1;
  const openCore =
    Math.max(0, bySlots.QB - have.QB!) + Math.max(0, bySlots.RB - have.RB!) +
    Math.max(0, bySlots.WR - have.WR!) + Math.max(0, bySlots.TE - have.TE!);
  const flexPool = (["RB", "WR", "TE"] as const).reduce((a, p) => a + Math.max(0, have[p]! - bySlots[p]), 0);
  const openFlex = Math.max(0, bySlots.FLEX - flexPool);
  const benchSlots = rosterPositions.filter((s) => s === "BN").length;
  const openBench = Math.max(0, benchSlots - Math.max(0, roster.length - (bySlots.QB + bySlots.RB + bySlots.WR + bySlots.TE + bySlots.FLEX + bySlots.K + bySlots.DEF)));
  return evaluateKdstGate({ totalRounds: rounds, currentRound: round, openCoreStarters: openCore, openFlex, openBench }).released;
};

/** market-rank softmax with a mild roster-need multiplier + K/DST gate + legality. */
export function sampleOpponentPick(
  available: LeagueProjection[],
  ctx: SimContext,
  roster: LeagueProjection[],
  round: number,
  rng: () => number,
): LeagueProjection {
  const have: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const p of roster) if (p.position in have) have[p.position]! += 1;
  const needMult = (pos: FantasyPosition): number => {
    const base: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };
    const short = Math.max(0, (base[pos] ?? 1) - (have[pos] ?? 0));
    return short > 0 ? 1.25 : 0.85;
  };
  // K/DST: gated by release round, AND a real 12-team draft never sees a team
  // roster a 2nd kicker/defense (bench K/DST has ~zero redraft value) — a
  // per-team need multiplier alone was too soft and let the pool exhaust
  // before some teams' turn arrived. Hard-exclude once a team already has one.
  const legal = available.filter((p) => {
    if (!isKdst(p.position)) return true;
    if ((have[p.position] ?? 0) >= 1) return false;
    return kdstReleaseOK(round, roster, ctx.rounds, ctx.rosterPositions, ctx.slots);
  });
  const pool = legal.length > 0 ? legal : available;

  const scored = pool.map((p) => {
    const mkt = ctx.market.by_player.get(p.player_id);
    const rank = mkt?.expected_pick ?? mkt?.search_rank ?? 250;
    // softmax over -rank (lower expected pick = more likely), tempered
    return { p, w: Math.exp(-rank / 22) * needMult(p.position) };
  });
  const total = scored.reduce((a, s) => a + s.w, 0) || 1;
  let r = rng() * total;
  for (const s of scored) {
    r -= s.w;
    if (r <= 0) return s.p;
  }
  return scored[scored.length - 1]!.p;
}

/* ================================================================== strategies */

export type Strategy = "D0_search_rank_bpa" | "D1_ri_points_bpa" | "D2_ri_vor_bpa" | "D3_frozen_engine" | "D4_trajectory";

/** naive BPA for D0/D1/D2, respecting roster legality + the K/DST gate. */
export function pickBpa(
  available: LeagueProjection[],
  ctx: SimContext,
  roster: LeagueProjection[],
  round: number,
  metric: (p: LeagueProjection) => number,
): LeagueProjection {
  const have: Record<string, number> = { K: 0, DEF: 0 };
  for (const p of roster) if (p.position === "K" || p.position === "DEF") have[p.position]! += 1;
  const legal = available.filter((p) => {
    if (!isKdst(p.position)) return true;
    if ((have[p.position] ?? 0) >= 1) return false;
    return kdstReleaseOK(round, roster, ctx.rounds, ctx.rosterPositions, ctx.slots);
  });
  const pool = legal.length > 0 ? legal : available;
  return pool.reduce((best, p) => (metric(p) > metric(best) ? p : best));
}

/** §33 bounded, roster-need-GATED trajectory adjustment on top of the frozen D3 ranking. */
const TRAJ_CAP = 35;
const DELTA_URGENCY = 0.45; // multi-turn-style urgency, but gated on genuine roster NEED (D3's urgency is not need-gated)
const DELTA_RELIEF = 0.5;   // starter-completion-risk relief, gated on need
const DELTA_RISK = 0.6;     // penalize a pick that *raises* completion risk

export function trajectoryAdjustment(r: DraftRecommendation): number {
  const needGate = r.roster_need > 0 ? 1 : 0;
  const urgency = needGate * r.tier_drop * (1 - r.tier_survival.p_tier_survives_next_pick);
  const relief = needGate * Math.max(0, r.construction_effect.starter_completion_risk_before - r.construction_effect.starter_completion_risk_after) * 60;
  const riskUp = Math.max(0, r.construction_effect.starter_completion_risk_after - r.construction_effect.starter_completion_risk_before) * 60;
  const raw = DELTA_URGENCY * urgency + DELTA_RELIEF * relief - DELTA_RISK * riskUp;
  return Math.max(-TRAJ_CAP, Math.min(TRAJ_CAP, raw));
}

export function pickD3orD4(response: ReturnType<typeof recommendDraft>, useTrajectory: boolean): DraftRecommendation | null {
  const all = [response.primary_recommendation, ...response.alternates, ...response.wait_candidates, ...response.do_not_reach]
    .filter((x): x is DraftRecommendation => !!x);
  if (all.length === 0) return null;
  if (!useTrajectory) return response.primary_recommendation ?? all[0]!;
  let best = all[0]!;
  let bestScore = best.recommendation_score + trajectoryAdjustment(best);
  for (const r of all.slice(1)) {
    const s = r.recommendation_score + trajectoryAdjustment(r);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return best;
}

/* ================================================================== simulate one draft */

export interface DraftResult {
  slot: number;
  strategy: Strategy | string;
  sim: number;
  picks_by_position: Record<string, number>;
  pick_sequence: string; // e.g. "WR,WR,RB,RB,TE,..."
  utility: ReturnType<typeof computeRosterUtility>;
  starter_points: number;
  flex_points: number;
  open_starter_slots: number;
  duration_ms: number;
  snapshots?: Record<number, { pick_sequence: string; utility: number; open_starter_slots: number }>;
}

export interface SimulateOptions {
  /** force the focal manager's picks at these overall pick numbers to these player_ids (§13/§38 pair-forcing) */
  forcedPicks?: Map<number, string>;
  /** force the focal manager's pick at this overall pick to the best-VOR player of this position (§17/§18/§19/§20 timing experiments) */
  forcedPositions?: Map<number, FantasyPosition>;
  /** record the focal roster's partial-utility snapshot right after these overall picks complete */
  snapshotAtOverall?: number[];
}

export function simulateDraft(
  ctx: SimContext,
  slot: number,
  strategy: Strategy | string,
  seed: number,
  opts: SimulateOptions = {},
): DraftResult {
  const t0 = performance.now();
  const rng = mulberry32(seed);
  const taken = new Set<string>();
  const rostersByTeam = new Map<number, LeagueProjection[]>();
  for (let t = 1; t <= ctx.numTeams; t++) rostersByTeam.set(t, []);
  const completedPicks: CompletedPick[] = [];
  const focalRosterId = slot; // treat draft slot == roster_id for the simulation (identity mapping)
  const snapshots: DraftResult["snapshots"] = {};
  const snapAt = new Set(opts.snapshotAtOverall ?? []);

  for (let round = 1; round <= ctx.rounds; round++) {
    for (let teamSlot = 1; teamSlot <= ctx.numTeams; teamSlot++) {
      const overall = overallPickNumber(teamSlot, round, ctx.numTeams, "snake");
      const roster = rostersByTeam.get(teamSlot)!;
      const available = ctx.pool.filter((p) => !taken.has(p.player_id));
      let chosen: LeagueProjection;

      const forced = teamSlot === focalRosterId ? opts.forcedPicks?.get(overall) : undefined;
      const forcedPos = teamSlot === focalRosterId ? opts.forcedPositions?.get(overall) : undefined;
      if (forced && available.some((p) => p.player_id === forced)) {
        chosen = available.find((p) => p.player_id === forced)!;
      } else if (forcedPos) {
        const inPos = available.filter((p) => p.position === forcedPos);
        chosen = (inPos.length > 0 ? inPos : available).reduce((best, p) => (vorOf(p, ctx.levels) > vorOf(best, ctx.levels) ? p : best));
      } else if (teamSlot === focalRosterId) {
        if (strategy === "D0_search_rank_bpa") {
          chosen = pickBpa(available, ctx, roster, round, (p) => -(ctx.market.by_player.get(p.player_id)?.search_rank ?? 9999));
        } else if (strategy === "D1_ri_points_bpa") {
          chosen = pickBpa(available, ctx, roster, round, (p) => p.league_points);
        } else if (strategy === "D2_ri_vor_bpa") {
          chosen = pickBpa(available, ctx, roster, round, (p) => vorOf(p, ctx.levels));
        } else {
          const engineInput: EngineInput = {
            leaguePool: available,
            rosterPositions: ctx.rosterPositions,
            numTeams: ctx.numTeams,
            draftType: "snake",
            rounds: ctx.rounds,
            completedPicks,
            manager: { roster_id: focalRosterId, sleeper_user_id: `sim${slot}`, manager_slug: `slot${slot}`, draft_slot: slot },
            rosterPlayers: roster.map((p) => toRosterPlayer(p)),
            market: ctx.market,
            provenance: ctx.provenance,
          };
          const res = recommendDraft(engineInput);
          const picked = pickD3orD4(res, strategy === "D4_trajectory");
          const foundChosen = picked ? available.find((p) => p.player_id === picked.player_id) : undefined;
          chosen = foundChosen ?? pickBpa(available, ctx, roster, round, (p) => vorOf(p, ctx.levels));
        }
      } else {
        chosen = sampleOpponentPick(available, ctx, roster, round, rng);
      }

      taken.add(chosen.player_id);
      roster.push(chosen);
      completedPicks.push({ overall, roster_id: teamSlot, player_id: chosen.player_id, position: chosen.position });

      if (teamSlot === focalRosterId && snapAt.has(overall)) {
        const partial = assignOptimalRoster(roster, ctx.slots);
        const u = computeRosterUtility(partial, ctx.levels, ctx.medianStarterVor, DEFAULT_ROSTER_UTILITY_WEIGHTS, 0);
        snapshots[overall] = { pick_sequence: roster.map((p) => p.position).join(","), utility: u.utility, open_starter_slots: u.open_starter_slots };
      }
    }
  }

  const focalRoster = rostersByTeam.get(focalRosterId)!;
  const assignment = assignOptimalRoster(focalRoster, ctx.slots);
  const utility = computeRosterUtility(assignment, ctx.levels, ctx.medianStarterVor, DEFAULT_ROSTER_UTILITY_WEIGHTS, 0);
  const byPos: Record<string, number> = {};
  for (const p of focalRoster) byPos[p.position] = (byPos[p.position] ?? 0) + 1;

  return {
    slot, strategy, sim: seed,
    picks_by_position: byPos,
    pick_sequence: focalRoster.map((p) => p.position).join(","),
    utility,
    starter_points: utility.starter_points + utility.flex_points,
    flex_points: utility.flex_points,
    open_starter_slots: utility.open_starter_slots,
    duration_ms: round2(performance.now() - t0),
    snapshots: Object.keys(snapshots).length ? snapshots : undefined,
  };
}

export function toRosterPlayer(p: LeagueProjection) {
  return {
    player_id: p.player_id, full_name: p.full_name, first_name: null, last_name: null,
    position: p.position, fantasy_positions: [p.position], team: p.team, age: null, years_exp: null,
    status: null, injury_status: null, number: null, active: true, search_rank: null,
    depth_chart_order: null, depth_chart_position: null, resolved: true,
  };
}

/* ================================================================== run */

export function round2(v: number): number { return Math.round(v * 100) / 100; }

async function main(): Promise<void> {
  const nArg = process.argv.find((a) => a.startsWith("--n"));
  const N = nArg ? Number(nArg.split("=")[1] ?? process.argv[process.argv.indexOf(nArg) + 1]) : 400;
  mkdirSync(OUT, { recursive: true });

  console.log("Building simulation context from the LIVE 2026 Bloodline pool…");
  const ctx = await buildContext();
  console.log(`  pool: ${ctx.pool.length} players, ${ctx.numTeams} teams x ${ctx.rounds} rounds`);

  const SLOTS = [1, 7, 12]; // slot 1 (early), slot 7 (Supyo29's real slot), slot 12 (BijiMac's real slot)
  const STRATS: Strategy[] = ["D0_search_rank_bpa", "D1_ri_points_bpa", "D2_ri_vor_bpa", "D3_frozen_engine", "D4_trajectory"];

  const rows: DraftResult[] = [];
  const convergence: Array<{ slot: number; strategy: string; n: number; running_mean_utility: number }> = [];

  for (const slot of SLOTS) {
    for (const strat of STRATS) {
      const utils: number[] = [];
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        // PAIRED seed: same opponent-random draw across all 5 strategies at this (slot, i)
        const seed = 900000 + slot * 100000 + i;
        const r = simulateDraft(ctx, slot, strat, seed);
        rows.push(r);
        utils.push(r.utility.utility);
        if ((i + 1) % Math.max(1, Math.floor(N / 8)) === 0 || i === N - 1) {
          convergence.push({ slot, strategy: strat, n: i + 1, running_mean_utility: round2(mean(utils)) });
        }
      }
      console.log(`  slot ${slot} ${strat}: ${N} sims in ${round2(performance.now() - t0)}ms, mean utility ${round2(mean(utils))}`);
    }
  }

  writeFileSync(join(OUT, "phase6_simulation_raw.csv"), csv(rows.map((r) => ({
    slot: r.slot, strategy: r.strategy, sim: r.sim,
    utility: r.utility.utility, starter_vor: r.utility.starter_vor, flex_vor: r.utility.flex_vor,
    bench_vor_discounted: r.utility.bench_vor_discounted, positional_advantage: r.utility.positional_advantage,
    starter_completion_penalty: r.utility.starter_completion_penalty, open_starter_slots: r.utility.open_starter_slots,
    starter_points: r.starter_points,
    QB: r.picks_by_position.QB ?? 0, RB: r.picks_by_position.RB ?? 0, WR: r.picks_by_position.WR ?? 0,
    TE: r.picks_by_position.TE ?? 0, K: r.picks_by_position.K ?? 0, DEF: r.picks_by_position.DEF ?? 0,
    pick_sequence: r.pick_sequence, duration_ms: r.duration_ms,
  }))));
  writeFileSync(join(OUT, "phase6_convergence.csv"), csv(convergence));

  console.log(`\nwrote phase6_simulation_raw.csv (${rows.length} rows), phase6_convergence.csv`);
}

export function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); }

// only run when this file is the actual entry point — other phase6-*.ts
// scripts import this module for its exports and must NOT trigger the full
// D0-D4 sweep as a side effect of that import. Compare resolved file URLs
// (not raw strings) so spaces/special characters in the repo path don't break
// the check (import.meta.url percent-encodes them; process.argv[1] does not).
const isEntryPoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
