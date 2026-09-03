/**
 * Trade evaluation core — the marginal-utility engine.
 *
 * For every participant: reconstruct the before/after roster, then run the SAME
 * roster intelligence used everywhere else in Bloodline Bowl —
 * `buildOptimalLineup` (Hungarian slot assignment), `weeklyVOR` against the
 * league replacement frontier, and `computePositionalNeeds` — on BOTH states.
 * The value of an acquired player is the change it produces across the resulting
 * optimal lineup + usable depth + positional structure, never its standalone
 * projection.
 *
 * Deterministic: identical league state + projections + proposal + config ->
 * identical result. No randomness, no time-dependent branch.
 */

import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type {
  RosterConstraints,
  WeeklyProjectionBatch,
  WeeklyReplacement,
  PositionalNeed,
} from "@/lib/weekly/schema";
import { buildOptimalLineup } from "@/lib/weekly/lineup";
import { weeklyVOR } from "@/lib/weekly/replacement";
import { computePositionalNeeds } from "@/lib/weekly/context";

import type { TradeConfig } from "./config";
import { classifyAcceptance } from "./config";
import { reconstructRosters } from "./reconstruct";
import type {
  NormalizedProposal,
  ParticipantTradeResult,
  PositionalNeedChange,
  RosterSnapshotView,
  TradeDiagnostic,
  TradeParticipantInput,
  TradeSummary,
  TradeViability,
  LineupDisplacement,
} from "./schema";

export interface TradeEvaluationInput {
  normalized: NormalizedProposal;
  week: number;
  constraints: RosterConstraints;
  team_count: number;
  projections: WeeklyProjectionBatch;
  replacement: WeeklyReplacement;
  players_by_id: Map<string, CanonicalPlayer>;
  participants: TradeParticipantInput[];
  config: TradeConfig;
  /** projection quality carried through from context, for a top-level diagnostic */
  projections_status?: WeeklyProjectionBatch["status"];
}

export interface TradeEvaluationOutput {
  participants: Record<string, ParticipantTradeResult>;
  trade_summary: TradeSummary;
  diagnostics: TradeDiagnostic[];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const SEVERITY_RANK: Record<string, number> = { critical: 0, weak: 1, adequate: 2, strong: 3, absent: 2 };
const SEVERITY_PRESSURE: Record<string, number> = { critical: 3, weak: 1.25, adequate: 0, strong: -0.75 };
/**
 * The composite's positional term sums pressure over the SIX base positions
 * only. `computePositionalNeeds` also emits per-flex-label and a STRUCTURAL
 * entry, which overlap the base entries for the same shortage (an unfilled RB
 * slot shows up as RB + FLEX + STRUCTURAL); summing all of them would triple-
 * count one hole. The full need list (incl. flex/STRUCTURAL) is still surfaced
 * in `positional_need_changes` for transparency.
 */
const PRESSURE_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

export function evaluateTrade(input: TradeEvaluationInput): TradeEvaluationOutput {
  const { normalized, week, constraints, projections, replacement, players_by_id, config } = input;
  const diagnostics: TradeDiagnostic[] = [];

  if (input.projections_status && input.projections_status !== "READY") {
    diagnostics.push({
      code: "PROJECTIONS_PARTIAL",
      message: `Trade analysis is running on ${input.projections_status} projections — deltas that depend on a missing projection are returned unresolved, not zeroed.`,
      severity: "warning",
    });
  }

  const rosterByManager = new Map(input.participants.map((p) => [p.manager.canonical_manager_id, p.roster]));
  const recon = reconstructRosters(normalized, rosterByManager);

  const proj = (id: string): number | null => projections.by_player.get(id)?.projected_points ?? null;
  const posOf = (id: string): string => players_by_id.get(id)?.position ?? projections.by_player.get(id)?.position ?? "UNKNOWN";

  const results: ParticipantTradeResult[] = [];

  for (const p of input.participants) {
    const mid = p.manager.canonical_manager_id;
    const reconEntry = recon.by_manager.get(mid);
    if (!reconEntry) {
      diagnostics.push({
        code: "TRADE_ANALYSIS_DEGRADED",
        message: `Participant ${p.manager.manager_slug} is in the participant list but not in the normalized proposal — skipped.`,
        severity: "error",
      });
      continue;
    }
    const { before, after } = reconEntry;
    const incoming = recon.incoming_by_manager.get(mid) ?? [];
    const outgoing = recon.outgoing_by_manager.get(mid) ?? [];
    const pDiag: TradeDiagnostic[] = [];

    const playerMap = new Map<string, CanonicalPlayer>();
    for (const id of new Set([...before.all_players, ...after.all_players])) {
      const resolved = players_by_id.get(id) ?? projections.resolved_players.get(id);
      if (resolved) playerMap.set(id, resolved);
      else pDiag.push({ code: "ROSTER_UNKNOWN_PLAYER", message: `Player ${id} on a reconstructed roster has no canonical metadata — excluded from lineup construction.`, severity: "warning" });
    }

    const lineupBefore = buildOptimalLineup({ week, roster: before, constraints, players: playerMap, projections });
    const lineupAfter = buildOptimalLineup({ week, roster: after, constraints, players: playerMap, projections });

    if (lineupBefore.optimality_status === "PROVISIONAL" || lineupAfter.optimality_status === "PROVISIONAL") {
      pDiag.push({
        code: "LINEUP_PROVISIONAL",
        message: "An optimal lineup is PROVISIONAL (a rostered, slot-eligible player has no weekly projection) — the starter-points delta may be revised when projections complete.",
        severity: "info",
      });
    }

    const viewBefore = toView(lineupBefore, before, incoming, outgoing, proj, posOf, replacement);
    const viewAfter = toView(lineupAfter, after, incoming, outgoing, proj, posOf, replacement);

    // ---- starter projection delta (recomputed from scratch, not summed values)
    let starterPointsDelta: number | null = null;
    let starterPointsStatus: "RESOLVED" | "UNRESOLVED" = "UNRESOLVED";
    if (viewBefore.optimal_starter_points != null && viewAfter.optimal_starter_points != null) {
      starterPointsDelta = round2(viewAfter.optimal_starter_points - viewBefore.optimal_starter_points);
      starterPointsStatus = "RESOLVED";
    } else {
      pDiag.push({
        code: "STARTER_PROJECTION_UNAVAILABLE",
        message: "An optimal starting lineup total is unavailable (an UNKNOWN player would start) — the starter-points delta is unresolved. VOR, depth and positional components still apply.",
        severity: "warning",
      });
    }

    // ---- starter VOR delta
    const starterVorDelta =
      viewBefore.starter_vor != null && viewAfter.starter_vor != null
        ? round2(viewAfter.starter_vor - viewBefore.starter_vor)
        : null;
    if (starterVorDelta == null) {
      pDiag.push({ code: "VOR_FALLBACK_USED", message: "Starter VOR could not be fully computed (a replacement level or projection was missing at a starting position).", severity: "info" });
    }

    const benchValueDelta = round2(viewAfter.bench_value - viewBefore.bench_value);

    // ---- positional needs before/after
    const lookup = (ids: string[]): CanonicalPlayer[] =>
      ids.map((id) => playerMap.get(id)).filter((x): x is CanonicalPlayer => Boolean(x));
    let needsBefore: PositionalNeed[] = [];
    let needsAfter: PositionalNeed[] = [];
    try {
      needsBefore = computePositionalNeeds({ roster: before, constraints, teamCount: input.team_count, week, projections, replacement, lookup });
      needsAfter = computePositionalNeeds({ roster: after, constraints, teamCount: input.team_count, week, projections, replacement, lookup });
    } catch {
      pDiag.push({ code: "POSITIONAL_NEED_MODEL_UNAVAILABLE", message: "The positional-need model threw for this roster — positional need change is reported as empty and contributes 0 to utility.", severity: "warning" });
    }
    const needChanges = diffNeeds(needsBefore, needsAfter);
    const pressure = (ns: PositionalNeed[]): number =>
      ns.reduce((s, n) => s + (PRESSURE_POSITIONS.has(n.position) ? SEVERITY_PRESSURE[n.severity] ?? 0 : 0), 0);
    const positionalNeedComponent = clamp(round2(pressure(needsBefore) - pressure(needsAfter)), -4, 4);

    // ---- composite utility (components kept individually)
    const w = config.weights;
    const cStarter = starterPointsDelta ?? 0;
    const cVor = starterVorDelta ?? 0;
    const components = {
      starter_points: round2(cStarter),
      starter_vor: round2(cVor),
      bench_value: benchValueDelta,
      positional_need: positionalNeedComponent,
    };
    const rosterUtilityDelta = round2(
      w.starter_points * cStarter +
        w.starter_vor * cVor +
        w.bench_value * benchValueDelta +
        w.positional_need * positionalNeedComponent,
    );

    const displacement = computeDisplacement(
      viewBefore.optimal_starters,
      viewAfter.optimal_starters,
      before.all_players,
      after.all_players,
    );

    const acceptance = classifyAcceptance(rosterUtilityDelta, config);
    const aboveFloor = rosterUtilityDelta >= config.acceptance_floor;

    if (pDiag.some((d) => d.severity === "warning")) {
      pDiag.unshift({ code: "TRADE_ANALYSIS_DEGRADED", message: "One or more inputs for this participant were degraded — see the diagnostics below. No optimistic default was substituted.", severity: "warning" });
    }

    results.push({
      manager_id: p.manager.manager_slug,
      manager_slug: p.manager.manager_slug,
      canonical_team_id: p.team.canonical_team_id,
      before: viewBefore,
      after: viewAfter,
      starter_points_delta: starterPointsDelta,
      starter_points_delta_status: starterPointsStatus,
      starter_vor_delta: starterVorDelta,
      bench_value_delta: benchValueDelta,
      roster_utility_delta: rosterUtilityDelta,
      roster_utility_components: components,
      positional_need_changes: needChanges,
      lineup_displacement: displacement,
      acceptance,
      above_acceptance_floor: aboveFloor,
      diagnostics: pDiag,
    });
  }

  for (const r of results) for (const d of r.diagnostics) if (d.code === "TRADE_ANALYSIS_DEGRADED") {
    diagnostics.push({ code: "TRADE_ANALYSIS_DEGRADED", message: `Participant ${r.manager_slug}: degraded inputs — result is still roster-specific and non-optimistic.`, severity: "warning" });
  }

  const trade_summary = summarize(results, input.config);

  const bySlug: Record<string, ParticipantTradeResult> = {};
  for (const r of results) bySlug[r.manager_slug] = r;
  return { participants: bySlug, trade_summary, diagnostics };
}

/* ------------------------------------------------------------------ helpers */

function toView(
  lineup: ReturnType<typeof buildOptimalLineup>,
  roster: { all_players: string[]; ir: string[]; taxi: string[] },
  incoming: string[],
  outgoing: string[],
  proj: (id: string) => number | null,
  posOf: (id: string) => string,
  replacement: WeeklyReplacement,
): RosterSnapshotView {
  const optimalStarters = [
    ...new Set(lineup.slots.map((s) => s.recommended_player_id).filter((x): x is string => Boolean(x))),
  ];
  const starterSet = new Set(optimalStarters);
  const reserve = new Set([...roster.ir, ...roster.taxi]);

  let starterVor: number | null = 0;
  for (const id of optimalStarters) {
    const pts = proj(id);
    if (pts == null) {
      // an UNKNOWN starter — starter VOR cannot be totalled honestly
      starterVor = null;
      break;
    }
    const v = weeklyVOR(id, posOf(id), pts, replacement);
    if (v.vor != null && starterVor != null) starterVor += Math.max(0, v.vor);
  }

  let benchValue = 0;
  for (const id of roster.all_players) {
    if (starterSet.has(id) || reserve.has(id)) continue;
    const v = weeklyVOR(id, posOf(id), proj(id), replacement);
    if (v.vor != null) benchValue += Math.max(0, v.vor);
  }

  return {
    optimal_starters: optimalStarters,
    optimal_starter_points: lineup.optimal_total,
    starter_vor: starterVor == null ? null : round2(starterVor),
    bench_value: round2(benchValue),
    all_player_ids: [...roster.all_players],
    incoming_player_ids: [...incoming],
    outgoing_player_ids: [...outgoing],
    fieldable: lineup.empty_slots.length === 0,
    roster_size: roster.all_players.length,
  };
}

function diffNeeds(before: PositionalNeed[], after: PositionalNeed[]): PositionalNeedChange[] {
  const b = new Map(before.map((n) => [n.position, n.severity]));
  const a = new Map(after.map((n) => [n.position, n.severity]));
  const positions = [...new Set([...b.keys(), ...a.keys()])];
  const out: PositionalNeedChange[] = [];
  for (const position of positions) {
    const bs = b.get(position) ?? "absent";
    const as = a.get(position) ?? "absent";
    const br = SEVERITY_RANK[bs] ?? 2;
    const ar = SEVERITY_RANK[as] ?? 2;
    let kind: PositionalNeedChange["kind"];
    if (ar > br) kind = "IMPROVES_NEED";
    else if (ar < br) {
      const wasFine = bs === "adequate" || bs === "strong" || bs === "absent";
      const nowBad = as === "critical" || as === "weak";
      kind = wasFine && nowBad ? "CREATES_NEW_WEAKNESS" : "WORSENS_POSITION";
    } else kind = "NEUTRAL";
    if (kind === "NEUTRAL" && as !== "critical" && as !== "weak") continue;
    out.push({ position, before_severity: bs as PositionalNeedChange["before_severity"], after_severity: as as PositionalNeedChange["after_severity"], kind });
  }
  return out;
}

function computeDisplacement(
  beforeStarters: string[],
  afterStarters: string[],
  beforeRoster: string[],
  afterRoster: string[],
): LineupDisplacement {
  const bs = new Set(beforeStarters);
  const as = new Set(afterStarters);
  const beforeSet = new Set(beforeRoster);
  const afterSet = new Set(afterRoster);
  const keptBoth = (id: string): boolean => beforeSet.has(id) && afterSet.has(id);

  return {
    entered_starting_lineup: afterStarters.filter((id) => !bs.has(id)),
    left_starting_lineup: beforeStarters.filter((id) => !as.has(id)),
    moved_to_bench: beforeStarters.filter((id) => !as.has(id) && keptBoth(id)),
    bench_promotions: afterStarters.filter((id) => !bs.has(id) && keptBoth(id)),
  };
}

export function classifyViability(results: ParticipantTradeResult[], cfg: TradeConfig): TradeViability {
  if (results.length === 0) return "NON_VIABLE";
  const deltas = results.map((r) => r.roster_utility_delta);
  const min = Math.min(...deltas);
  const anyHardReject = results.some((r) => r.acceptance === "HARD_REJECT" || r.acceptance === "REJECT");
  // any participant materially worse off (below the RELUCTANT band) sinks the trade
  if (anyHardReject || min < cfg.thresholds.reluctant_floor) return "NON_VIABLE";
  if (deltas.every((d) => d >= cfg.viability.high_min_participant_delta)) return "HIGH";
  if (deltas.every((d) => d >= cfg.viability.moderate_min_participant_delta)) return "MODERATE";
  return "LOW";
}

function summarize(results: ParticipantTradeResult[], cfg: TradeConfig): TradeSummary {
  const deltas = results.map((r) => r.roster_utility_delta);
  const n = deltas.length || 1;
  const mean = deltas.reduce((s, d) => s + d, 0) / n;
  const variance = round2(deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / n);
  const spread = round2(Math.max(...deltas) - Math.min(...deltas));

  // Deterministic + participant-order invariant: ties broken by manager_slug.
  const byBest = [...results].sort(
    (a, b) => b.roster_utility_delta - a.roster_utility_delta || a.manager_slug.localeCompare(b.manager_slug),
  );
  const largestBeneficiary = byBest.length > 0 ? byBest[0]!.manager_slug : null;
  const worst = byBest.length > 0 ? byBest[byBest.length - 1]! : null;
  const largestNegative = worst && worst.roster_utility_delta < 0 ? worst.manager_slug : null;

  const rationalCount = results.filter((r) => r.roster_utility_delta > 0).length;
  const sumAbs = deltas.reduce((s, d) => s + Math.abs(d), 0);
  const imbalance = sumAbs > 0 ? round2(spread / sumAbs) : 0;

  return {
    all_teams_improve: results.length > 0 && results.every((r) => r.roster_utility_delta > 0),
    all_teams_above_acceptance_floor: results.length > 0 && results.every((r) => r.above_acceptance_floor),
    largest_beneficiary: largestBeneficiary,
    largest_negative: largestNegative,
    utility_gain_variance: variance,
    utility_gain_spread: spread,
    trade_viability: classifyViability(results, cfg),
    rationality: {
      every_participant_rational: results.length > 0 && rationalCount === results.length,
      rational_count: rationalCount,
      participant_count: results.length,
    },
    fairness: {
      imbalance_index: imbalance,
      note:
        imbalance < 0.34
          ? "Gains are distributed relatively evenly across participants."
          : imbalance < 0.67
            ? "One participant benefits noticeably more than the others, though the deal may still be rational for all."
            : "Gains are highly concentrated — check whether every participant clears their acceptance floor.",
    },
  };
}
