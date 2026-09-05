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

/**
 * Audit fix (§9, P1): the previous implementation returned `SURPLUS`
 * IMMEDIATELY for any non-starter, BEFORE ever checking `severityAfter` —
 * meaning a bench player who is the roster's ONLY viable backup at a thin
 * position (whose removal would spike that position's positional-need
 * severity to `weak`/`critical`, even though the CURRENT-WEEK optimal
 * lineup total is unaffected, since they weren't starting to begin with)
 * was always misclassified `SURPLUS`. Severity-after-removal now applies
 * REGARDLESS of starter status — "bench" and "replaceable" are not the same
 * claim. The starter-status shortcut to `SURPLUS` now fires only once BOTH
 * the marginal-impact AND the severity checks have already found nothing.
 */
function classify(impact: number | null, severityAfter: string | null, wasStarter: boolean): { dependency: DependencyClass; reasons: string[] } {
  const reasons: string[] = [];
  const abs = impact == null ? 0 : Math.abs(impact);

  if (abs >= DEPENDENCY_THRESHOLDS.core_min_impact || severityAfter === "critical") {
    reasons.push(`removing this player costs ${abs.toFixed(1)} projected points this week${severityAfter === "critical" ? " and creates a CRITICAL positional hole" : ""}`);
    return { dependency: "CORE", reasons };
  }
  if (abs >= DEPENDENCY_THRESHOLDS.important_min_impact || severityAfter === "weak") {
    reasons.push(`removing this player costs ${abs.toFixed(1)} projected points this week${severityAfter === "weak" ? " and leaves the position weak" : " even though they are not a current starter — no other viable backup exists"}`);
    return { dependency: "IMPORTANT", reasons };
  }
  if (!wasStarter && abs < DEPENDENCY_THRESHOLDS.replaceable_min_impact) {
    reasons.push("player is not a current starter, removing them barely changes the optimal lineup, and the position's severity is unaffected — a genuine surplus piece, not merely 'on the bench'");
    return { dependency: "SURPLUS", reasons };
  }
  if (abs >= DEPENDENCY_THRESHOLDS.replaceable_min_impact) {
    reasons.push(`removing this player costs only ${abs.toFixed(1)} projected points — a comparable replacement exists on the roster`);
    return { dependency: "REPLACEABLE", reasons };
  }
  reasons.push("removing this player has negligible impact on the optimal lineup and no positional-severity concern — pure roster surplus");
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
