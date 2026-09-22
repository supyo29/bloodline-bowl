/**
 * Phase 9 Steps 11-12 — Matchup 2.0 outcome ingestion. Matchup2 is DESCRIPTIVE (`may_influence_production: false`,
 * `numeric_adjustment: null`); it never issued a fantasy-point prediction, so it is never graded as one. Every
 * component is evaluated ONLY against what its OWN `direction` claimed (ADVANTAGE/DISADVANTAGE), against the
 * player's realized performance relative to his own pre-game baseline projection — never a fabricated universal
 * "Matchup2 accuracy" score, and never applied to a NEUTRAL/UNDETERMINED component (nothing was claimed).
 */
import type { Matchup2Outcome } from "@/lib/matchup2/capture";
import type { MatchupMissCategory, Matchup2FamilyAudit } from "./contract";
import { actualPointsFor, sleeperIdFromCanonical, type WeekActuals } from "./scoring-actuals";

export interface Matchup2CaptureRow {
  capture_id: string; capture_class: string; season: number; week: number; player_gsis_id: string; position: string;
  scoring_fingerprint: string | null;
  record: { offense_subject: { id: string }; baseline: { projected_points: number | null; model_version: string | null } | null;
    components: Array<{ family: string; direction: "ADVANTAGE" | "DISADVANTAGE" | "NEUTRAL" | "UNDETERMINED"; evidence: string; title: string }> };
}

/** Materiality: a realized margin smaller than this (relative to baseline) is WEAK alignment, not STRONG, regardless of sign. Pre-registered, not chosen after inspecting results. */
const MATERIAL_MARGIN_POINTS = 3;

function classify(direction: "ADVANTAGE" | "DISADVANTAGE", margin: number | null, evidenceTier: string): MatchupMissCategory {
  if (margin == null) return "OUTCOME_NOT_MEASURABLE";
  if (evidenceTier === "INSUFFICIENT") return "INSUFFICIENT_SAMPLE";
  const favors = direction === "ADVANTAGE" ? margin > 0 : margin < 0;
  if (!favors) return "DIRECTIONAL_MISS";
  return Math.abs(margin) >= MATERIAL_MARGIN_POINTS ? "EVIDENCE_ALIGNED_OUTCOME_STRONG" : "EVIDENCE_ALIGNED_OUTCOME_WEAK";
}

/**
 * `gsisToSleeper` resolves a GSIS id to a Sleeper id for the actuals lookup (Phase 7 temporal identity is NOT
 * re-derived here — this reads the SAME identity resolution the capture itself already used, via the crosswalk
 * the caller supplies; an unresolved id is `OUTCOME_NOT_MEASURABLE`, never a current-team guess).
 */
export function buildMatchup2Outcomes(
  captures: readonly Matchup2CaptureRow[],
  actuals: WeekActuals,
  rawScoringByFingerprint: ReadonlyMap<string, Record<string, number>>,
  gsisToSleeper: (gsis: string) => string | null,
  source = "sleeper-stats:v1",
): { outcomeRows: Matchup2Outcome[]; by_family: Matchup2FamilyAudit[] } {
  const outcomeRows: Matchup2Outcome[] = [];
  const perFamily = new Map<string, { n: number; aligned: number; misses: Record<MatchupMissCategory, number>; claim_kind: string }>();
  const zero = (): Record<MatchupMissCategory, number> => ({ EVIDENCE_ALIGNED_OUTCOME_STRONG: 0, EVIDENCE_ALIGNED_OUTCOME_WEAK: 0, DIRECTIONAL_MISS: 0, PLAYER_ROLE_CHANGED: 0, INJURY_CONTEXT_CHANGED: 0, GAME_SCRIPT_CHANGED: 0, SOURCE_STALE: 0, SOURCE_MISSING: 0, OUTCOME_NOT_MEASURABLE: 0, INSUFFICIENT_SAMPLE: 0 });

  for (const cap of captures) {
    if (cap.capture_class !== "LIVE_CAPTURED") continue; // only pristine prospective captures back an audit finding
    const rawScoring = cap.scoring_fingerprint ? rawScoringByFingerprint.get(cap.scoring_fingerprint) : undefined;
    const sleeperId = gsisToSleeper(cap.player_gsis_id) ?? (cap.player_gsis_id.startsWith("player:sleeper:") ? sleeperIdFromCanonical(cap.player_gsis_id) : null);
    const rawKey = cap.position === "K" || cap.position === "DEF" ? sleeperId?.toUpperCase() : sleeperId;
    const actual = rawScoring && sleeperId ? actualPointsFor(cap.position, actuals.clean.get(sleeperId), rawKey ? actuals.raw.get(rawKey) : undefined, rawScoring) : { basis: "UNAVAILABLE" as const, points: null, warnings: [] };
    const played = actual.points != null;
    outcomeRows.push({ capture_id: cap.capture_id, source, recorded_at: new Date().toISOString(), realized_fantasy_points: actual.points, played });

    const baseline = cap.record.baseline?.projected_points ?? null;
    const margin = actual.points != null && baseline != null ? Math.round((actual.points - baseline) * 100) / 100 : null;
    for (const c of cap.record.components) {
      if (c.direction === "NEUTRAL" || c.direction === "UNDETERMINED") continue; // nothing was claimed; not evaluated
      const key = c.family;
      const agg = perFamily.get(key) ?? { n: 0, aligned: 0, misses: zero(), claim_kind: c.direction };
      const cat = classify(c.direction, margin, c.evidence);
      agg.n += 1; agg.misses[cat] += 1;
      if (cat === "EVIDENCE_ALIGNED_OUTCOME_STRONG" || cat === "EVIDENCE_ALIGNED_OUTCOME_WEAK") agg.aligned += 1;
      perFamily.set(key, agg);
    }
  }
  // `n` itself is the sample-size signal (readers judge it directly); a low weekly n never overwrites the real
  // per-decision classification — INSUFFICIENT_SAMPLE is reserved for a component whose OWN evidence tier said so.
  const by_family: Matchup2FamilyAudit[] = [...perFamily.entries()]
    .map(([family, v]) => ({ family, claim_kind: v.claim_kind, n: v.n, aligned: v.aligned, misses: v.misses }))
    .sort((a, b) => a.family.localeCompare(b.family));
  return { outcomeRows, by_family };
}
