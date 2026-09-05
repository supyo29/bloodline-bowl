/**
 * Trade Engine — Phase 6: manager strategic profile orchestrator.
 *
 * Builds the season/standings/playoff/archetype/urgency stack ONCE per
 * manager, from the SAME `TradeAnalysisContext` snapshot every other phase
 * already reads — no second league-state read (spec's Performance section).
 * Callers (discovery/negotiation integration, the API route) should build
 * this once and reuse it across every candidate trade they assess.
 */

import type { TradeAnalysisContext } from "../context";
import type { ManagerStrategicProfile } from "./types";
import { buildLeagueSeasonContext } from "./season";
import { buildManagerStandings, classifyPlayoffStatus } from "./standings";
import { classifyArchetype } from "./archetype";
import { computeUrgency } from "./urgency";
import { HORIZON_WEIGHTS_BY_ARCHETYPE, preferredHorizonsFor } from "./config";

export function buildManagerStrategicProfile(ctx: TradeAnalysisContext, managerId: string, managerSlug: string): ManagerStrategicProfile {
  const diagnostics: string[] = [];
  const season = buildLeagueSeasonContext(ctx);
  const standings = buildManagerStandings(ctx, managerId);
  if (!standings.standings_available) diagnostics.push("STANDINGS_UNAVAILABLE");
  const playoff = classifyPlayoffStatus(ctx, standings, season);
  diagnostics.push(...playoff.diagnostics);
  const { archetype, reasons: archetypeReasons } = classifyArchetype(season, standings, playoff);
  const urgency = computeUrgency(season, playoff, standings.wins, standings.losses, standings.ties);
  const horizonWeights = HORIZON_WEIGHTS_BY_ARCHETYPE[archetype];
  const preferredHorizons = preferredHorizonsFor(horizonWeights);

  return {
    manager_id: managerId,
    manager_slug: managerSlug,
    season,
    standings,
    playoff,
    archetype,
    archetype_reasons: archetypeReasons,
    urgency,
    preferred_horizons: preferredHorizons,
    horizon_weights: horizonWeights,
    diagnostics: [...new Set(diagnostics)],
  };
}
