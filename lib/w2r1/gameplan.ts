/**
 * W2.R1 S5 game-plan / tactical evidence primitives (SHADOW; DIAGNOSTIC). Pure, provider neutral, golden-tested against the S5 research harness.
 *
 * Evidence tiers: TIER A (play-by-play, charting, lines, snaps, injury designations: identical definition every season, usable for 2026 directly) vs
 * TIER B (participation: formation / personnel / coverage — NOT observed in 2026; allowed ONLY as prior-season carryover, discounted by continuity, labelled).
 * Honest framing: tendencies are PROBABLE, never a claim about an unpublished game plan.
 */
export type EvidenceState = "OK" | "NO_EVIDENCE" | "STALE_EVIDENCE" | "PRIOR_SEASON_ONLY" | "LOW_CONTINUITY";
export const STALE_AFTER_DAYS = 21;
export const MIN_LAYER_GAIN = 0.03;

/** prereg continuity constants (fixed): a head-coach change keeps 40 %, a QB change keeps 60 %; OC/DC/personnel are UNKNOWN (no extra discount, flagged). */
export function continuityFactor(c: { hcSame: boolean; qbSame?: boolean }): number {
  return (c.hcSame ? 1 : 0.4) * (c.qbSame === false ? 0.6 : 1);
}
export const seasonAgeWeight = (seasonsAgo: number): number => (seasonsAgo <= 0 ? 1 : 0.5 ** seasonsAgo);

/** strictly-earlier games only: the point-in-time contract. A target game and every later game are NEVER evidence. */
export interface GameKey { season: number; week: number }
export const isStrictlyEarlier = (g: GameKey, target: GameKey): boolean => g.season < target.season || (g.season === target.season && g.week < target.week);
export function priorGames<T extends GameKey>(games: readonly T[], target: GameKey, max: number): T[] {
  return games.filter((g) => isStrictlyEarlier(g, target)).sort((a, b) => a.season - b.season || a.week - b.week).slice(-max);
}

/** empirical-Bayes rate with k0 game-equivalents of shrinkage to the league mean; weights default to 1 (continuity weights for the CONT mode). */
export function ebRate(values: ReadonlyArray<number | null>, league: number, k0 = 4, weights?: readonly number[]): number {
  let sw = 0, s = 0;
  values.forEach((v, i) => { if (v == null) return; const w = weights?.[i] ?? 1; if (w <= 0) return; sw += w; s += w * v; });
  return (s + k0 * league) / (sw + k0);
}

/** weight applied to a delta: unknown / thin evidence NEVER yields a confident adjustment. */
export function confidenceWeight(playerGames: number, teamGames: number): 0 | 0.6 | 1 {
  const k = Math.min(playerGames, teamGames);
  return k >= 4 ? 1 : k >= 2 ? 0.6 : 0;
}

export function evidenceStates(i: { currentSeasonGames: number; totalGames: number; gapDays: number | null; continuity: number }): EvidenceState[] {
  const out: EvidenceState[] = [];
  if (i.totalGames <= 0) return ["NO_EVIDENCE"];
  if (i.gapDays != null && i.gapDays > STALE_AFTER_DAYS) out.push("STALE_EVIDENCE");
  if (i.currentSeasonGames < 2) out.push("PRIOR_SEASON_ONLY");
  if (i.continuity < 0.5) out.push("LOW_CONTINUITY");
  return out.length ? out : ["OK"];
}

/** Tier-B carryover: only a STRICTLY EARLIER season may enter, shrunk to the league mean by the continuity factor. Returns null (unknown) otherwise — never target-season "truth". */
export function tierBCarryover(a: { targetSeason: number; evidenceSeason: number; prior: number | null; continuity: number; league: number }): { value: number; observed: false; tier: "B"; evidence_age_seasons: number; continuity: number } | null {
  if (a.evidenceSeason >= a.targetSeason || a.prior == null) return null;
  return { value: a.continuity * a.prior + (1 - a.continuity) * a.league, observed: false, tier: "B", evidence_age_seasons: a.targetSeason - a.evidenceSeason, continuity: a.continuity };
}
export const TIER_B_PREFIXES = ["tb_", "tbB_", "participation_", "formation_", "personnel_", "coverage_shell_", "man_zone_"] as const;
export function tierBColumns(features: readonly string[]): string[] { return features.filter((f) => TIER_B_PREFIXES.some((p) => f.startsWith(p))); }

/** a matchup term exists only where the PLAYER has the relevant usage: product of a player fingerprint and an opponent response (zero usage => zero effect). */
export const interactionTerm = (playerFingerprint: number | null, opponentResponse: number | null): number | null => (playerFingerprint == null || opponentResponse == null ? null : playerFingerprint * opponentResponse);

/** teammate absence redistributes opportunity across ALL remaining teammates in proportion to their as-of shares (not only to one named backup). */
export function redistributeShare(absent: number, teammates: ReadonlyArray<{ id: string; share: number }>): Map<string, number> {
  const total = teammates.reduce((s, t) => s + Math.max(0, t.share), 0); const out = new Map<string, number>();
  for (const t of teammates) out.set(t.id, total > 0 ? absent * (Math.max(0, t.share) / total) : absent / Math.max(1, teammates.length));
  return out;
}

/** availability is applied EXACTLY ONCE: expected = injury(B0p + delta). */
export const expectedFromDelta = (b0: number, delta: number, injury: (sourcePoints: number) => number): number => injury(b0 + delta);

/** layer inclusion (prereg): >= 0.03 points better than the previous retained step AND the 95% bootstrap lower bound > 0. */
export const retainLayer = (dMAE: number, lo95: number): boolean => dMAE >= MIN_LAYER_GAIN && lo95 > 0;

export interface TacticalEvidence {
  tier: "A" | "B";
  kind: "OFFENSIVE_TENDENCY" | "DEFENSIVE_RESPONSE" | "PLAYER_FIT" | "SECOND_ORDER";
  summary: string;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
  evidence_states: EvidenceState[];
  evidence_age_games: number;
  continuity: number | null;
  provenance: string;
  observed_in_target_season: boolean;
}
/** probabilistic wording only ("tends to", "historically"); never "the team will ...". */
export function describeTendency(a: { subject: string; metric: string; value: number; league: number; tier: "A" | "B"; confidence: TacticalEvidence["confidence"] }): string {
  const rel = a.league === 0 ? 0 : (a.value - a.league) / Math.abs(a.league);
  const level = rel > 0.15 ? "elevated" : rel < -0.15 ? "reduced" : "near league average";
  const basis = a.tier === "B" ? "Prior-season (carryover) evidence" : "Point-in-time evidence";
  return `${a.subject} ${a.metric} tendency is ${level} (${basis}; confidence: ${a.confidence.toLowerCase()}).`;
}
