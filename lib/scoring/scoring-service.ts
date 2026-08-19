/**
 * Orchestration for `GET /api/scoring`.
 *
 * Reuses the existing Sleeper client's cached `getLeague` call — scoring
 * settings change rarely, so there is no need for a dedicated fetch path or a
 * shorter TTL the way `/api/draft` needs for live picks.
 */

import { getLeague } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { buildArchetypeExamples } from "./archetypes";
import { buildDiagnostics } from "./diagnostics";
import {
  buildComparisons,
  buildDerivedBonuses,
  buildDerivedDefense,
  buildDerivedKicking,
  buildDerivedPassing,
  buildDerivedReceiving,
  buildDerivedRushing,
  buildDerivedTurnovers,
  buildNormalizedRules,
  classifyScoring,
} from "./normalize";
import { buildSensitivity } from "./sensitivity";
import type { ScoringResponse } from "./types";

export async function buildScoringBundle(): Promise<ScoringResponse> {
  const leagueId = resolveLeagueId();
  const league = await getLeague(leagueId);

  const raw = league.scoring_settings ?? {};
  const rosterPositions = league.roster_positions ?? [];

  const { rules: normalized, warnings } = buildNormalizedRules(raw);
  const archetypeExamples = buildArchetypeExamples(raw);

  return {
    generated_at: new Date().toISOString(),
    source: "Sleeper",
    league_id: leagueId,
    league: {
      name: league.name,
      season: league.season,
      roster_positions: rosterPositions,
    },
    scoring: { raw, normalized },
    derived: {
      passing: buildDerivedPassing(raw),
      rushing: buildDerivedRushing(raw),
      receiving: buildDerivedReceiving(raw),
      turnovers: buildDerivedTurnovers(raw),
      kicking: buildDerivedKicking(raw),
      defense: buildDerivedDefense(raw),
      bonuses: buildDerivedBonuses(raw),
    },
    comparisons: buildComparisons(raw),
    classification: classifyScoring(raw, rosterPositions),
    archetype_examples: archetypeExamples,
    sensitivity: buildSensitivity(raw, archetypeExamples),
    diagnostics: buildDiagnostics(raw),
    scoring_engine: {
      version: 1,
      rules: Object.fromEntries(
        normalized.map((rule) => [
          rule.key,
          { points: rule.points, category: rule.category },
        ]),
      ),
    },
    metadata: {
      rule_count: normalized.length,
      warnings,
    },
  };
}
