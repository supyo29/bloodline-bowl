/**
 * Trade Engine — Phase 4B: roster search profiles (needs/surplus index).
 *
 * Needs come EXCLUSIVELY from the existing, frozen `computePositionalNeeds`
 * (`lib/weekly/context.ts`) — the same function Phase 1's trade evaluator and
 * the weekly start/sit engine already use. This module does not redefine
 * "need"; it adds a genuinely new, complementary concept ("surplus") that
 * Phase 1/2 never modeled, built ON TOP of the same needs data plus a plain
 * bench-depth count — never a second, conflicting need computation.
 *
 * Cheap by design: one `computePositionalNeeds` call and one `weeklyVOR` pass
 * per roster, no lineup re-optimization beyond what `computePositionalNeeds`
 * already does internally. This is the "cheap heuristic" layer the Phase 4
 * spec calls for — final trade value NEVER comes from here, only from
 * `evaluateTrade` (see `candidate-eval.ts`).
 */

import { computePositionalNeeds } from "@/lib/weekly/context";
import { weeklyVOR } from "@/lib/weekly/replacement";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { TradeAnalysisContext } from "../context";
import type { AssetValue, NeedSeverity, PositionalNeedProfile, PositionalSurplusProfile, TradeSearchProfile } from "./types";

const BASE_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** `computePositionalNeeds`'s 4-level severity mapped onto the Phase 4 spec's 5-level scale. `MODERATE` is reserved for a future finer split; not emitted by this mapping today — documented, not silently absent. */
function mapSeverity(s: "critical" | "weak" | "adequate" | "strong"): NeedSeverity {
  switch (s) {
    case "critical": return "CRITICAL";
    case "weak": return "HIGH";
    case "adequate": return "LOW";
    case "strong": return "NONE";
  }
}

export function buildTradeSearchProfile(managerId: string, managerSlug: string, ctx: TradeAnalysisContext): TradeSearchProfile {
  const roster = ctx.rosters_by_manager.get(managerId);
  if (!roster) {
    return { manager_id: managerId, manager_slug: managerSlug, needs: [], surpluses: [], premium_assets: [], expendable_assets: [], consolidation_candidate: false, fragility_sensitive: false };
  }

  const lookup = (ids: string[]): CanonicalPlayer[] => ids.map((id) => ctx.players_by_id.get(id)).filter((x): x is CanonicalPlayer => Boolean(x));
  const rawNeeds = computePositionalNeeds({ roster, constraints: ctx.constraints, teamCount: ctx.team_count, week: ctx.week, projections: ctx.projections, replacement: ctx.replacement, lookup })
    .filter((n) => BASE_POSITIONS.includes(n.position));

  const needs: PositionalNeedProfile[] = rawNeeds.map((n) => ({ position: n.position, severity: mapSeverity(n.severity) }));
  const needByPos = new Map(rawNeeds.map((n) => [n.position, n]));

  const reserve = new Set([...roster.ir, ...roster.taxi]);
  const activeIds = roster.all_players.filter((id) => !reserve.has(id));
  const starterSet = new Set(roster.starters);

  const assets: AssetValue[] = [];
  for (const id of activeIds) {
    const p = ctx.players_by_id.get(id);
    if (!p) continue;
    const pts = ctx.projections.by_player.get(id)?.projected_points ?? null;
    const v = weeklyVOR(id, p.position, pts, ctx.replacement);
    assets.push({ canonical_player_id: id, position: p.position, starter_vor: v.vor, projected_points: pts, is_current_starter: starterSet.has(id) });
  }

  // ---- surplus: for a LOW/NONE-severity position, how many active players beyond (starters + a 1-player safety buffer) exist?
  const surpluses: PositionalSurplusProfile[] = [];
  for (const pos of BASE_POSITIONS) {
    const need = needByPos.get(pos);
    const severity = need ? mapSeverity(need.severity) : "NONE";
    if (severity !== "LOW" && severity !== "NONE") continue;
    const atPos = assets.filter((a) => a.position === pos).length;
    const required = need?.need ?? 0;
    const extra = atPos - required - 1; // -1: keep one safety backup, never counted as surplus
    if (extra > 0) surpluses.push({ position: pos, surplus_count: extra });
  }

  const sortDesc = (a: AssetValue, b: AssetValue): number => (b.starter_vor ?? -Infinity) - (a.starter_vor ?? -Infinity) || a.canonical_player_id.localeCompare(b.canonical_player_id);
  const sortAsc = (a: AssetValue, b: AssetValue): number => (a.starter_vor ?? Infinity) - (b.starter_vor ?? Infinity) || a.canonical_player_id.localeCompare(b.canonical_player_id);

  const premium_assets = [...assets].sort(sortDesc).slice(0, 8);

  const surplusPositions = new Set(surpluses.map((s) => s.position));
  const expendable_assets = assets
    .filter((a) => !a.is_current_starter && surplusPositions.has(a.position))
    .sort(sortAsc)
    .slice(0, 8);

  const consolidation_candidate = surpluses.filter((s) => s.surplus_count >= 2).length >= 1;
  const fragility_sensitive = needs.filter((n) => n.severity === "CRITICAL" || n.severity === "HIGH").length >= 2;

  return { manager_id: managerId, manager_slug: managerSlug, needs, surpluses, premium_assets, expendable_assets, consolidation_candidate, fragility_sensitive };
}
