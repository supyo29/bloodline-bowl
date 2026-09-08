/**
 * Orchestration for the scoring surface.
 *
 * Phase 1B.2: the league scoring facts now come from the ONE canonical live
 * read (`buildCanonicalLeagueState` -> `canonicalScoringInputs`) instead of a
 * separate `getLeague()`, so `/api/scoring` and `/api/league/:slug/state` can
 * never disagree about a league's scoring settings or roster configuration. The
 * scoring ANALYSIS below is unchanged.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { readLeagueState } from "@/lib/canonical/read";
import { resolveLeagueForQuery } from "@/lib/leagues/resolve";
import {
  canonicalScoringInputs,
  type LegacyScoringInputs,
} from "@/lib/canonical/compat/scoring-inputs";
import type { CanonicalLeagueSnapshot } from "@/lib/canonical/schema";
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

/**
 * Resolve the scoring inputs from ONE canonical live read.
 *
 * @param input `undefined` -> the default league; a `?league=` selector
 *   (registry slug or raw numeric Sleeper id); or an already-built
 *   `CanonicalLeagueSnapshot` (so `buildSnapshot` can thread its single read).
 *   An empty/absent selector falls back to the default league exactly as the
 *   old `resolveLeagueId()` did.
 */
export async function resolveScoringInputs(
  input?: string | { snapshot: CanonicalLeagueSnapshot },
): Promise<LegacyScoringInputs> {
  if (input && typeof input === "object") return canonicalScoringInputs(input.snapshot);
  const slug = resolveLeagueForQuery(input ?? null).league_slug;
  const state = await readLeagueState(slug, { wave: 1 });
  const snapshot = state.snapshot;
  // A usable snapshot (READY / PARTIAL, real league data) is required. A
  // not-found or provider failure is surfaced as a SleeperError so the route
  // handlers map the status exactly as they did before the migration
  // (404 for an unknown league, 502 for an upstream failure).
  const usable =
    snapshot != null &&
    snapshot.live_provider_status !== "PROVIDER_ERROR" &&
    (state.ok || state.status < 400) &&
    snapshot.league.team_count > 0;
  if (!usable) {
    const notFound = state.code === "league_not_found" || state.status === 404;
    throw new SleeperError(
      state.detail ?? `Could not load canonical state for "${slug}".`,
      `/canonical/state/${slug}`,
      notFound ? 404 : state.status && state.status >= 400 ? state.status : 502,
    );
  }
  return canonicalScoringInputs(snapshot);
}

export async function buildScoringBundle(
  input?: string | { snapshot: CanonicalLeagueSnapshot },
): Promise<ScoringResponse> {
  const facts = await resolveScoringInputs(input);

  const raw = facts.scoring_settings ?? {};
  const rosterPositions = facts.roster_positions;

  const { rules: normalized, warnings } = buildNormalizedRules(raw);
  const archetypeExamples = buildArchetypeExamples(raw);

  return {
    generated_at: new Date().toISOString(),
    source: "Sleeper",
    league_id: facts.league_id,
    league: {
      name: facts.name,
      season: facts.season,
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
