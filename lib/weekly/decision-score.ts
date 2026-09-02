/**
 * Inspectable decision scoring — a transparent sum of named components, not an
 * opaque number. Post-draft economics differ from snake-draft economics, so
 * these weights are NOT reused from the draft engine.
 *
 * Every recommendation carries its `DecisionScore` so a reader can see exactly
 * why. Explainability first; calibration is a later phase.
 */

export interface ScoreComponent {
  key: string;
  label: string;
  raw: number | null;
  weight: number;
  contribution: number;
  note?: string;
}

export interface DecisionScore {
  total: number;
  components: ScoreComponent[];
  /** components that were null (missing data) and therefore contributed 0 */
  missing_inputs: string[];
}

/** Post-draft weekly weights. Points-denominated components use weight 1. */
export const WEEKLY_WEIGHTS = {
  weekly_projected_gain: 1.0,
  weekly_vor: 0.6,
  starter_upgrade: 1.0,
  bench_utility: 0.25,
  positional_scarcity: 0.35,
  bye_coverage: 0.8,
  injury_hedge: 0.7,
  /** raw is a CLAMPED per-remaining-week ROS edge (pts/wk), not season points. */
  rest_of_season_value: 0.45,
  drop_cost: 1.0,
  uncertainty_penalty: 1.0,
  flex_utility: 0.3,
} as const;

export type WeightKey = keyof typeof WEEKLY_WEIGHTS;

export function buildScore(
  parts: Array<{ key: WeightKey; label: string; raw: number | null; note?: string }>,
): DecisionScore {
  const components: ScoreComponent[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const part of parts) {
    const weight = WEEKLY_WEIGHTS[part.key];
    if (part.raw == null) {
      missing.push(part.key);
      components.push({ key: part.key, label: part.label, raw: null, weight, contribution: 0, note: part.note });
      continue;
    }
    const contribution = Math.round(part.raw * weight * 100) / 100;
    total += contribution;
    components.push({ key: part.key, label: part.label, raw: part.raw, weight, contribution, note: part.note });
  }
  return { total: Math.round(total * 100) / 100, components, missing_inputs: missing };
}
