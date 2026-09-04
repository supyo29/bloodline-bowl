/**
 * Trade Engine — Phase 2C: usable depth and roster resilience.
 *
 * The Phase 1 audit flagged `bench_value` (Σ positive weekly VOR of non-starters)
 * as deliberately coarse — it counts a 5th WR the same as a genuine RB2 cover.
 * Phase 2C is a DETERMINISTIC STRUCTURAL model (no injury probabilities, no
 * simulation) of:
 *
 *   - usable depth per position: how many non-starters could actually plug a
 *     starting slot (slot-eligible AND at or above the league replacement line);
 *   - replacement cliff: the drop from a starter to the best realistic backup;
 *   - roster fragility: how fast projected utility collapses if one starting
 *     option becomes unavailable — a structural score, higher = more fragile;
 *   - redundant vs usable depth: excess backups at a deep position while another
 *     position is thin.
 *
 * Every component is returned separately (per the Phase 1 audit's transparency
 * requirement); fragility is never folded into one opaque number.
 *
 * Pure and deterministic.
 */

import type { CanonicalPlayer, CanonicalRoster } from "@/lib/canonical/schema";
import { slotEligiblePositions, isFlexSlot } from "@/lib/weekly/slots";
import type { TradeAnalysisContext } from "./context";
import type { TradeDiagnostic } from "./schema";

const BASE_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
const round2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};

/** Position importance weight for the aggregate scores (RB/WR carry FLEX load). */
const POS_WEIGHT: Record<string, number> = { RB: 1.4, WR: 1.4, TE: 1.0, QB: 1.0, K: 0.4, DEF: 0.4 };
/** Usable-backup credit is capped so hoarding one position cannot inflate depth. */
const USABLE_BACKUP_CAP = 3;
/** A cliff steeper than this at a position with no cover is a fragility driver. */
const STEEP_CLIFF = 5;

export interface PositionDepth {
  position: string;
  starting_requirement: number;
  /** active, slot-eligible players at/above the league replacement line */
  viable_starters: number;
  /** viable players beyond the starting requirement (capped in the score, not here) */
  usable_backups: number;
  /** non-viable bench bodies at this position (cannot realistically start) */
  nominal_backups: number;
  replacement_points: number | null;
  /** projected points of the marginal required starter (need-th best) */
  marginal_starter_points: number | null;
  /** best backup's projected points */
  best_backup_points: number | null;
  /** marginal_starter − best_backup (>=0); the immediate cost of losing that starter */
  replacement_cliff: number | null;
  /** viable_starters < requirement */
  understaffed: boolean;
  /** viable_starters === requirement and no usable backup */
  no_cover: boolean;
}

export interface RosterResilience {
  by_position: PositionDepth[];
  flex_pool: { flex_slots: number; flex_eligible_viable: number; surplus_over_slots: number; shallow: boolean };
  /** aggregate usable-depth score (higher = better real depth) */
  usable_depth_score: number;
  /** aggregate fragility score (higher = MORE fragile) */
  fragility_score: number;
  /** positions with excess viable depth while another position is understaffed/no-cover */
  redundant_depth_positions: string[];
}

export interface DepthParticipantResult {
  before: RosterResilience;
  after: RosterResilience;
  usable_depth_delta: number;
  /** before.fragility_score − after.fragility_score (positive = LESS fragile = better) */
  fragility_delta: number;
  /** fraction of outgoing weekly production the roster can realistically replace (bench/FA) */
  replacement_context_delta: number;
  /** per-position replacement-cliff change at positions the trade touched */
  cliff_changes: Array<{ position: string; before_cliff: number | null; after_cliff: number | null }>;
  diagnostics: TradeDiagnostic[];
}

/* --------------------------------------------------------------- computation */

function activePlayers(roster: CanonicalRoster, ctx: TradeAnalysisContext): CanonicalPlayer[] {
  const reserve = new Set([...roster.ir, ...roster.taxi]);
  return roster.all_players
    .filter((id) => !reserve.has(id))
    .map((id) => ctx.players_by_id.get(id))
    .filter((p): p is CanonicalPlayer => Boolean(p));
}

function ptsOf(id: string, ctx: TradeAnalysisContext): number | null {
  return ctx.projections.by_player.get(id)?.projected_points ?? null;
}

export function rosterResilience(roster: CanonicalRoster, ctx: TradeAnalysisContext): RosterResilience {
  const players = activePlayers(roster, ctx);
  const flexSlots = ctx.constraints.starting_slots.filter((s) => isFlexSlot(s)).length;
  const flexEligPositions = new Set(
    ctx.constraints.starting_slots.filter((s) => isFlexSlot(s)).flatMap((s) => slotEligiblePositions(s)),
  );

  const by_position: PositionDepth[] = [];
  for (const pos of BASE_POSITIONS) {
    // PRIMARY position only. A player multi-eligible across base positions (a
    // real Sleeper case — e.g. a QB/TE-flagged player) must be attributed to
    // exactly one base-position bucket, or `usable_depth_score`/`fragility_score`
    // (which SUM across positions) would double-count them. Their extra
    // eligibility is still captured, once, by the separate FLEX-pool count below.
    const atPos = players.filter((p) => p.position === pos);
    const rep = ctx.replacement.by_position[pos]?.replacement_points ?? null;
    const req = ctx.constraints.slot_requirements[pos] ?? 0;

    const scored = atPos
      .map((p) => ({ id: p.canonical_player_id, pts: ptsOf(p.canonical_player_id, ctx) }))
      .filter((x): x is { id: string; pts: number } => x.pts != null)
      .sort((a, b) => b.pts - a.pts);

    const viable = rep == null ? scored : scored.filter((x) => x.pts >= rep);
    const viableStarters = viable.length;
    const usableBackups = Math.max(0, viableStarters - req);

    const marginalStarter = req > 0 ? scored[req - 1]?.pts ?? scored.at(-1)?.pts ?? null : scored[0]?.pts ?? null;
    const bestBackup = scored[req]?.pts ?? null;
    const cliff =
      marginalStarter != null && bestBackup != null ? round2(Math.max(0, marginalStarter - bestBackup)) : marginalStarter != null && bestBackup == null ? marginalStarter : null;

    by_position.push({
      position: pos,
      starting_requirement: req,
      viable_starters: viableStarters,
      usable_backups: usableBackups,
      nominal_backups: Math.max(0, atPos.length - Math.max(viableStarters, req)),
      replacement_points: rep,
      marginal_starter_points: marginalStarter,
      best_backup_points: bestBackup,
      replacement_cliff: cliff,
      understaffed: req > 0 && viableStarters < req,
      no_cover: req > 0 && viableStarters === req && usableBackups === 0,
    });
  }

  // FLEX pool: viable players beyond each base position's requirement that are flex-eligible
  const flexEligibleViable = players.filter((p) => {
    const elig = p.position && flexEligPositions.has(p.position);
    const eligAlt = p.eligible_positions.some((e) => flexEligPositions.has(e));
    if (!elig && !eligAlt) return false;
    const pts = ptsOf(p.canonical_player_id, ctx);
    const rep = ctx.replacement.by_position.FLEX?.replacement_points ?? null;
    return pts != null && (rep == null || pts >= rep);
  }).length;
  const baseFlexDemand = [...flexEligPositions].reduce((s, p) => s + (ctx.constraints.slot_requirements[p] ?? 0), 0);
  const flexSurplus = Math.max(0, flexEligibleViable - baseFlexDemand - flexSlots);
  const flex_pool = {
    flex_slots: flexSlots,
    flex_eligible_viable: flexEligibleViable,
    surplus_over_slots: flexSurplus,
    shallow: flexSlots > 0 && flexSurplus === 0,
  };

  // ---- aggregate scores
  let usable = 0;
  let fragility = 0;
  for (const d of by_position) {
    const w = POS_WEIGHT[d.position] ?? 1;
    usable += Math.min(d.usable_backups, USABLE_BACKUP_CAP) * w;
    if (d.understaffed) fragility += 4 * w;
    else if (d.no_cover) fragility += (1 + (d.replacement_cliff != null && d.replacement_cliff > STEEP_CLIFF ? 1.5 : 0.5)) * w;
    else if (d.usable_backups === 0 && d.starting_requirement > 0) fragility += 0.75 * w;
  }
  usable += Math.min(flexSurplus, USABLE_BACKUP_CAP) * 1.2;
  if (flex_pool.shallow) fragility += 1.5;

  // redundant depth: >=2 usable backups at a position while another is understaffed/no_cover
  const thin = by_position.some((d) => d.understaffed || d.no_cover);
  const redundant = thin ? by_position.filter((d) => d.usable_backups >= 2).map((d) => d.position) : [];

  return {
    by_position,
    flex_pool,
    usable_depth_score: round2(usable),
    fragility_score: round2(fragility),
    redundant_depth_positions: redundant,
  };
}

/* -------------------------------------------------- per-participant evaluation */

export interface DepthEvalInput {
  ctx: TradeAnalysisContext;
  before: CanonicalRoster;
  after: CanonicalRoster;
  incoming_ids: string[];
  outgoing_ids: string[];
}

export function evaluateDepthParticipant(input: DepthEvalInput): DepthParticipantResult {
  const { ctx, before, after, incoming_ids, outgoing_ids } = input;
  const diagnostics: TradeDiagnostic[] = [];

  const repMissing = BASE_POSITIONS.filter((p) => ctx.replacement.by_position[p]?.replacement_points == null);
  if (repMissing.length > 0) {
    diagnostics.push({
      code: "REPLACEMENT_POOL_DEGRADED",
      message: `No replacement level at: ${repMissing.join(", ")} — usable-depth and cliff for those positions fall back to raw counts.`,
      severity: "info",
    });
  }

  const beforeR = rosterResilience(before, ctx);
  const afterR = rosterResilience(after, ctx);

  // replacement context: for each outgoing player, how much of their weekly
  // production is realistically replaced (by a same-position viable backup on the
  // post-trade roster, or a free agent at/above replacement).
  let outProd = 0;
  let replaced = 0;
  for (const id of outgoing_ids) {
    const meta = ctx.players_by_id.get(id);
    const pts = ctx.projections.by_player.get(id)?.projected_points ?? null;
    if (!meta || pts == null) continue;
    outProd += pts;
    const rep = ctx.replacement.by_position[meta.position]?.replacement_points ?? null;
    const afterBackups = afterR.by_position.find((d) => d.position === meta.position);
    const bestAfter = afterBackups?.best_backup_points ?? afterBackups?.marginal_starter_points ?? null;
    const realistic = Math.max(bestAfter ?? 0, rep ?? 0);
    replaced += Math.min(pts, Math.max(0, realistic));
  }
  const replacement_context_delta = outProd > 0 ? round2(replaced - outProd) : 0; // <=0 : net production lost after replacement

  const touched = new Set<string>();
  for (const id of [...incoming_ids, ...outgoing_ids]) {
    const p = ctx.players_by_id.get(id);
    if (p) {
      touched.add(p.position);
      for (const e of p.eligible_positions) touched.add(e);
    }
  }
  const cliff_changes = [...touched]
    .filter((pos) => (BASE_POSITIONS as readonly string[]).includes(pos))
    .map((pos) => ({
      position: pos,
      before_cliff: beforeR.by_position.find((d) => d.position === pos)?.replacement_cliff ?? null,
      after_cliff: afterR.by_position.find((d) => d.position === pos)?.replacement_cliff ?? null,
    }));

  return {
    before: beforeR,
    after: afterR,
    usable_depth_delta: round2(afterR.usable_depth_score - beforeR.usable_depth_score),
    fragility_delta: round2(beforeR.fragility_score - afterR.fragility_score),
    replacement_context_delta,
    cliff_changes,
    diagnostics,
  };
}
