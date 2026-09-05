/**
 * Trade Engine — Phase 5A/5C: player dependency classification.
 *
 * "How painful is losing this player for the roster that owns them?" — used
 * for BOTH the target-owner side (§15, negotiating price) and the requester
 * side (§16, choosing safe concessions). Built entirely from the SAME
 * canonical mechanics Phase 1 already uses (`buildOptimalLineup`,
 * `computePositionalNeeds`) via a direct leave-one-out comparison — no new
 * valuation model, no fabricated "importance score."
 */

import { buildOptimalLineup } from "@/lib/weekly/lineup";
import { computePositionalNeeds } from "@/lib/weekly/context";
import type { CanonicalPlayer, CanonicalRoster } from "@/lib/canonical/schema";
import type { TradeAnalysisContext } from "../context";
import type { DependencyClass, PlayerDependency } from "./types";
import { DEPENDENCY_THRESHOLDS } from "./config";

const round2 = (v: number): number => Math.round(v * 100) / 100;

function classify(impact: number | null, severityAfter: string | null, wasStarter: boolean): { dependency: DependencyClass; reasons: string[] } {
  const reasons: string[] = [];
  if (!wasStarter && (impact == null || impact < DEPENDENCY_THRESHOLDS.replaceable_min_impact)) {
    reasons.push("player is not a current starter and removing them barely changes the optimal lineup");
    return { dependency: "SURPLUS", reasons };
  }
  const abs = impact == null ? 0 : Math.abs(impact);
  if (abs >= DEPENDENCY_THRESHOLDS.core_min_impact || severityAfter === "critical") {
    reasons.push(`removing this player costs ${abs.toFixed(1)} projected points this week${severityAfter === "critical" ? " and creates a CRITICAL positional hole" : ""}`);
    return { dependency: "CORE", reasons };
  }
  if (abs >= DEPENDENCY_THRESHOLDS.important_min_impact || severityAfter === "weak") {
    reasons.push(`removing this player costs ${abs.toFixed(1)} projected points this week${severityAfter === "weak" ? " and leaves the position weak" : ""}`);
    return { dependency: "IMPORTANT", reasons };
  }
  if (abs >= DEPENDENCY_THRESHOLDS.replaceable_min_impact) {
    reasons.push(`removing this player costs only ${abs.toFixed(1)} projected points — a comparable replacement exists on the roster`);
    return { dependency: "REPLACEABLE", reasons };
  }
  reasons.push("removing this player has negligible impact on the optimal lineup — pure roster surplus");
  return { dependency: "SURPLUS", reasons };
}

/**
 * Current-week leave-one-out dependency for `playerId` on `roster` (the
 * roster that currently owns them). Reuses the exact `buildOptimalLineup`
 * function Phase 1 uses for the trade evaluator itself — no re-derivation.
 */
export function computePlayerDependency(playerId: string, roster: CanonicalRoster, ctx: TradeAnalysisContext): PlayerDependency {
  const playerMap = new Map<string, CanonicalPlayer>();
  for (const id of roster.all_players) {
    const p = ctx.players_by_id.get(id);
    if (p) playerMap.set(id, p);
  }
  const isStarter = roster.starters.includes(playerId);

  const full = buildOptimalLineup({ week: ctx.week, roster, constraints: ctx.constraints, players: playerMap, projections: ctx.projections });
  const stripped: CanonicalRoster = {
    ...roster,
    all_players: roster.all_players.filter((id) => id !== playerId),
    starters: roster.starters.filter((id) => id !== playerId),
    bench: roster.bench.filter((id) => id !== playerId),
    slots: roster.slots.filter((s) => s.canonical_player_id !== playerId),
  };
  const without = buildOptimalLineup({ week: ctx.week, roster: stripped, constraints: ctx.constraints, players: playerMap, projections: ctx.projections });
  const impact = full.optimal_total != null && without.optimal_total != null ? round2(full.optimal_total - without.optimal_total) : null;

  const position = ctx.players_by_id.get(playerId)?.position;
  let severityAfter: PlayerDependency["severity_after_removal"] = null;
  if (position) {
    try {
      const lookup = (ids: string[]) => ids.map((id) => ctx.players_by_id.get(id)).filter((x): x is CanonicalPlayer => Boolean(x));
      const needsAfter = computePositionalNeeds({ roster: stripped, constraints: ctx.constraints, teamCount: ctx.team_count, week: ctx.week, projections: ctx.projections, replacement: ctx.replacement, lookup });
      severityAfter = needsAfter.find((n) => n.position === position)?.severity ?? null;
    } catch {
      severityAfter = null; // positional-need model degraded — dependency falls back to the marginal-impact number alone, never a fabricated severity
    }
  }

  const { dependency, reasons } = classify(impact, severityAfter, isStarter);
  return { canonical_player_id: playerId, dependency, marginal_starter_impact: impact, severity_after_removal: severityAfter, is_current_starter: isStarter, reasons };
}
