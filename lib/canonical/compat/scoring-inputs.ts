/**
 * Phase 1B.2 compatibility adapter: canonical snapshot -> the four league facts
 * the legacy scoring surface (`/api/scoring`, `/api/scoring/:leagueSlug`,
 * `/api/leagues/:slug/scoring`, `POST /api/scoring/calculate`) needs.
 *
 * The scoring ANALYSIS (`buildNormalizedRules`, `classifyScoring`,
 * `buildSensitivity`, `buildDiagnostics`, …) is a specialised computation and is
 * NOT touched — only its INPUT (which used to be a raw `getLeague()` call) now
 * comes from `buildCanonicalLeagueState`, so there is one live league reality.
 *
 * Field-for-field compatibility with the pre-migration payload:
 *   - `league_id`   : the provider-native numeric id (`provenance.provider_id`),
 *                     matching the old `resolveLeagueId(...)` value.
 *   - `name`        : `snapshot.league.name` (identical to `getLeague().name`).
 *   - `season`      : STRING form of `snapshot.season` — Sleeper's `league.season`
 *                     is a string, so the old payload carried a string here.
 *   - `roster_positions` : the provider's verbatim ordered slot array
 *                     (`roster_settings.roster_positions_raw`, schema v3+). For a
 *                     pre-v3 persisted snapshot that field is absent, so it is
 *                     reconstructed as `starting_slots + BN*n + IR*n + TAXI*n`
 *                     (the order every mainstream Sleeper/Yahoo league uses).
 *   - `scoring_settings` : `snapshot.league.raw_scoring` verbatim.
 */

import type { CanonicalLeagueSnapshot } from "../schema";

export interface LegacyScoringInputs {
  league_id: string;
  name: string;
  season: string;
  roster_positions: string[];
  scoring_settings: Record<string, number>;
}

export function reconstructRosterPositions(
  rs: CanonicalLeagueSnapshot["league"]["roster_settings"],
): string[] {
  if (rs.roster_positions_raw && rs.roster_positions_raw.length > 0) {
    return [...rs.roster_positions_raw];
  }
  return [
    ...rs.starting_slots,
    ...Array<string>(rs.bench_slots).fill("BN"),
    ...Array<string>(rs.ir_slots).fill("IR"),
    ...Array<string>(rs.taxi_slots).fill("TAXI"),
  ];
}

export function canonicalScoringInputs(snapshot: CanonicalLeagueSnapshot): LegacyScoringInputs {
  const league = snapshot.league;
  return {
    league_id: league.provenance.provider_id ?? league.league_slug,
    name: league.name,
    season: String(snapshot.season),
    roster_positions: reconstructRosterPositions(league.roster_settings),
    scoring_settings: league.raw_scoring,
  };
}
