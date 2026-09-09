/**
 * Competitive Trade Intelligence — opponent threat model (Checkpoint D).
 *
 * Forward-looking roster strength, NOT standings (§7, §23). At week 1 the
 * standings are 0-0 and contribute nothing; `results_weight` grows with weeks
 * played on a saturating curve (§8) and is capped so a hot record never fully
 * overrides projected strength (§43). Relative strength — how strong they are
 * vs US and the rest of the league — is exposed alongside the absolute band
 * (§10, §16).
 *
 *   threat = blend( projected_strength_z , results_strength_z ) − balance_penalty
 *   band   = LOW / MODERATE / HIGH / ELITE   (calibration_status: HEURISTIC)
 */

import type { TradeAnalysisContext } from "../context";
import type { CompetitiveDConfig } from "./config";
import { makeOwnerContextCache, type OwnerContext } from "./owner-context";
import type { OpponentThreat, ThreatBand } from "./schema";

const BASE_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const NEED_TARGET: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };

interface RawStrength {
  manager_id: string;
  optimal_total: number | null;
  starter_vor_sum: number;
  bench_vor_sum: number;
  balance_holes: number;
  games_played: number;
  win_pct: number | null;
  points_for: number | null;
}

function rawStrengthFor(ctx: TradeAnalysisContext, owner: OwnerContext): RawStrength {
  let starterVor = 0;
  let benchVor = 0;
  const startableByPos = new Map<string, number>();
  for (const pc of owner.by_player.values()) {
    if (["LOCKED_STARTER", "REGULAR_STARTER", "FLEX_STARTER"].includes(pc.starter_importance)) {
      starterVor += Math.max(0, pc.vor ?? 0);
    } else if (pc.starter_importance === "ROTATIONAL") {
      benchVor += Math.max(0, pc.vor ?? 0);
    }
    if ((pc.vor ?? -Infinity) >= 0.5 || ["LOCKED_STARTER", "REGULAR_STARTER", "FLEX_STARTER"].includes(pc.starter_importance)) {
      startableByPos.set(pc.position, (startableByPos.get(pc.position) ?? 0) + 1);
    }
  }
  let balanceHoles = 0;
  for (const pos of BASE_POSITIONS) {
    const have = startableByPos.get(pos) ?? 0;
    if (have < (NEED_TARGET[pos] ?? 1)) balanceHoles += (NEED_TARGET[pos] ?? 1) - have;
  }

  // standings
  const team = ctx.snapshot.teams.find((t) => t.canonical_manager_ids.includes(owner.manager_id));
  const standing = team ? ctx.snapshot.standings.find((s) => s.canonical_team_id === team.canonical_team_id) : undefined;
  const gp = standing?.games_played ?? Math.max(0, ctx.week - 1);
  const wins = standing?.wins ?? 0;
  const losses = standing?.losses ?? 0;
  const ties = standing?.ties ?? 0;
  const decided = wins + losses + ties;
  const winPct = decided > 0 ? (wins + 0.5 * ties) / decided : null;

  return {
    manager_id: owner.manager_id,
    optimal_total: owner.optimal_total,
    starter_vor_sum: starterVor,
    bench_vor_sum: benchVor,
    balance_holes: balanceHoles,
    games_played: gp,
    win_pct: winPct,
    points_for: standing?.points_for ?? null,
  };
}

function zscores(values: Array<number | null>): Array<number | null> {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  if (v.length < 2) return values.map((x) => (x == null || !Number.isFinite(x) ? null : 0));
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) || 1;
  return values.map((x) => (x == null || !Number.isFinite(x) ? null : round4((x - mean) / sd)));
}

export interface LeagueThreat {
  by_manager: Map<string, OpponentThreat>;
  my_blended_strength_z: number | null;
}

export function buildLeagueThreat(
  ctx: TradeAnalysisContext,
  config: CompetitiveDConfig,
  myManagerId: string,
  ownerCache?: (id: string) => OwnerContext,
): LeagueThreat {
  const cache = ownerCache ?? makeOwnerContextCache(ctx);
  const managerIds = [...ctx.rosters_by_manager.keys()];
  const raw = managerIds.map((id) => rawStrengthFor(ctx, cache(id)));

  // projected-strength composite, z-scored across the league
  const projComposite = raw.map(
    (s) =>
      (s.optimal_total ?? 0) +
      config.threat.starter_vor_weight * s.starter_vor_sum +
      config.threat.bench_vor_weight * s.bench_vor_sum,
  );
  const projZ = zscores(projComposite);
  const balancePenalty = raw.map((s) => s.balance_holes * config.threat.balance_penalty_per_hole);

  // results-strength composite (win% + points-for), z-scored — null before any games
  const anyGames = raw.some((s) => s.games_played > 0);
  const resultsComposite = raw.map((s) =>
    anyGames && s.games_played > 0 ? (s.win_pct ?? 0.5) * 2 + normalizePf(s.points_for, raw) : null,
  );
  const resultsZ = zscores(resultsComposite);

  const blended: Array<{ id: string; z: number }> = [];
  const byManager = new Map<string, OpponentThreat>();

  for (let i = 0; i < raw.length; i += 1) {
    const s = raw[i]!;
    const pZ = projZ[i] ?? 0;
    const rZ = resultsZ[i];
    const weeksPlayed = s.games_played;
    const resultsWeight =
      rZ == null ? 0 : Math.min(config.threat.results_weight_cap, 1 - Math.exp(-config.threat.results_maturity_lambda * weeksPlayed));
    const blendZ = round4((1 - resultsWeight) * pZ + resultsWeight * (rZ ?? 0) - balancePenalty[i]!);
    blended.push({ id: s.manager_id, z: blendZ });

    const reasons: string[] = [];
    if (weeksPlayed === 0) reasons.push("week 1 — 0-0 record contributes nothing; threat is projected roster strength only");
    else reasons.push(`results weight ${resultsWeight.toFixed(2)} (${weeksPlayed} weeks played), projected weight ${(1 - resultsWeight).toFixed(2)}`);
    if (balancePenalty[i]! > 0.05) reasons.push(`positional bottleneck: ${s.balance_holes} unfilled startable slot(s) → −${balancePenalty[i]!.toFixed(2)} z`);

    byManager.set(s.manager_id, {
      owner_manager_id: s.manager_id,
      score: blendZ,
      band: bandFor(blendZ, config),
      components: {
        projected_strength_z: pZ,
        results_strength_z: rZ ?? null,
        results_weight: round4(resultsWeight),
        blended_strength_z: blendZ,
        balance_penalty: round4(balancePenalty[i]!),
      },
      league_strength_percentile: null, // filled below
      relative_to_us: null, // filled below
      contender_band: "UNKNOWN",
      readiness: weeksPlayed === 0 ? "PARTIAL_COMPETITIVE_CONTEXT" : "FULL_COMPETITIVE_CONTEXT",
      calibration_status: "HEURISTIC",
      reasons,
    });
  }

  // percentiles + relative-to-us + contender band
  const sorted = [...blended].sort((a, b) => a.z - b.z);
  const myZ = byManager.get(myManagerId)?.components.blended_strength_z ?? null;
  for (const [id, t] of byManager) {
    const rank = sorted.findIndex((x) => x.id === id);
    const pct = blended.length > 1 ? round4(rank / (blended.length - 1)) : 0.5;
    t.league_strength_percentile = pct;
    t.relative_to_us = myZ == null ? null : round4(t.components.blended_strength_z - myZ);
    t.contender_band =
      pct >= config.threat.contender_thresholds.top
        ? "TOP_CONTENDER"
        : pct >= config.threat.contender_thresholds.contender
          ? "CONTENDER"
          : pct >= config.threat.contender_thresholds.mid
            ? "MID_TIER"
            : "BOTTOM_TIER";
  }

  return { by_manager: byManager, my_blended_strength_z: myZ };
}

function normalizePf(pf: number | null, raw: RawStrength[]): number {
  if (pf == null) return 0;
  const all = raw.map((s) => s.points_for).filter((x): x is number => x != null && x > 0);
  if (all.length < 2) return 0;
  const mean = all.reduce((s, x) => s + x, 0) / all.length;
  const sd = Math.sqrt(all.reduce((s, x) => s + (x - mean) ** 2, 0) / all.length) || 1;
  return (pf - mean) / sd;
}

function bandFor(z: number, config: CompetitiveDConfig): ThreatBand {
  const t = config.threat.band_thresholds;
  if (z >= t.elite) return "ELITE";
  if (z >= t.high) return "HIGH";
  if (z >= t.moderate) return "MODERATE";
  return "LOW";
}

function round4(v: number): number {
  const x = Math.round(v * 10000) / 10000;
  return x === 0 ? 0 : x;
}
