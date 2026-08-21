/**
 * Sensitivity analysis: how much would each archetype's score move if a single
 * scoring rule shifted by a modest amount?
 *
 * The league's actual settings are never mutated — each scenario clones the
 * settings object, adjusts one key, and recomputes every archetype through the
 * same {@link calculateFantasyPoints} engine used everywhere else, so results
 * are always derived, never hardcoded.
 */

import { calculateFantasyPoints, roundPoints } from "./calculate";
import { ARCHETYPE_STAT_LINES } from "./archetypes";
import type {
  ArchetypeKey,
  ArchetypeResult,
  SensitivityKey,
  SensitivityScenario,
} from "./types";

interface ScenarioDefinition {
  description: string;
  key: string;
  delta: number;
}

const SCENARIOS: Record<SensitivityKey, ScenarioDefinition> = {
  pass_td_plus_1: {
    description: "Passing touchdowns worth 1 additional point",
    key: "pass_td",
    delta: 1,
  },
  interception_penalty_minus_1: {
    description: "Interceptions penalized 1 additional point",
    key: "pass_int",
    delta: -1,
  },
  reception_plus_0_5: {
    description: "Receptions worth 0.5 additional points",
    key: "rec",
    delta: 0.5,
  },
  rush_td_plus_1: {
    description: "Rushing touchdowns worth 1 additional point",
    key: "rush_td",
    delta: 1,
  },
  rec_td_plus_1: {
    description: "Receiving touchdowns worth 1 additional point",
    key: "rec_td",
    delta: 1,
  },
};

function scoreAllArchetypes(
  scoringSettings: Record<string, number>,
): Record<ArchetypeKey, number> {
  const entries = Object.entries(ARCHETYPE_STAT_LINES).map(
    ([key, { stats }]) => [
      key,
      calculateFantasyPoints(stats, scoringSettings).fantasy_points,
    ],
  ) as Array<[ArchetypeKey, number]>;
  return Object.fromEntries(entries) as Record<ArchetypeKey, number>;
}

/**
 * Compute every scenario's per-archetype point swing.
 *
 * `baseline` is the already-computed archetype results from the real settings
 * (passed in rather than recomputed) so the response stays internally
 * consistent with `archetype_examples` even if this function's rounding ever
 * diverges from that one's.
 */
export function buildSensitivity(
  scoringSettings: Record<string, number>,
  baseline: Record<ArchetypeKey, ArchetypeResult>,
): Record<SensitivityKey, SensitivityScenario> {
  const baselinePoints = Object.fromEntries(
    Object.entries(baseline).map(([key, result]) => [
      key,
      result.fantasy_points,
    ]),
  ) as Record<ArchetypeKey, number>;

  const entries = Object.entries(SCENARIOS).map(([scenarioKey, definition]) => {
    const adjusted = {
      ...scoringSettings,
      [definition.key]:
        (scoringSettings[definition.key] ?? 0) + definition.delta,
    };
    const adjustedPoints = scoreAllArchetypes(adjusted);

    const changes = Object.fromEntries(
      (Object.keys(ARCHETYPE_STAT_LINES) as ArchetypeKey[]).map((archetype) => [
        archetype,
        roundPoints(adjustedPoints[archetype] - baselinePoints[archetype]),
      ]),
    ) as Record<ArchetypeKey, number>;

    const scenario: SensitivityScenario = {
      description: definition.description,
      adjustment: { key: definition.key, delta: definition.delta },
      changes,
    };
    return [scenarioKey, scenario] as const;
  });

  return Object.fromEntries(entries) as Record<
    SensitivityKey,
    SensitivityScenario
  >;
}
