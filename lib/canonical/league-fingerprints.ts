/**
 * The two deterministic identities stamped onto every `CanonicalLeague`:
 *   - `scoring_fingerprint` — order/zero-rule-insensitive scoring identity.
 *   - `roster_fingerprint`  — a change to starting slots, bench/IR/taxi counts,
 *     or slot requirements (FLEX rules) means a cached lineup/legality decision
 *     may no longer be valid.
 *
 * Provider adapters call {@link attachLeagueFingerprints} as the last step of
 * building a `CanonicalLeague`, so the fingerprints are always consistent with
 * the object's own `raw_scoring` / `roster_settings`.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "@/lib/persistence/serialize";
import { scoringFingerprint } from "./scoring-fingerprint";
import type { CanonicalLeague, CanonicalRosterSettings } from "./schema";

export const ROSTER_FINGERPRINT_VERSION = "v1" as const;

export function rosterFingerprint(settings: CanonicalRosterSettings): string {
  const normalized = {
    starting_slots: [...settings.starting_slots],
    bench_slots: settings.bench_slots,
    ir_slots: settings.ir_slots,
    taxi_slots: settings.taxi_slots,
    slot_requirements: settings.slot_requirements,
  };
  const digest = createHash("sha256").update(stableStringify(normalized)).digest("hex").slice(0, 24);
  return `roster:${ROSTER_FINGERPRINT_VERSION}:${digest}`;
}

/** Fill `scoring_fingerprint` + `roster_fingerprint` from the league's own fields. */
export function attachLeagueFingerprints(
  league: Omit<CanonicalLeague, "scoring_fingerprint" | "roster_fingerprint">,
): CanonicalLeague {
  return {
    ...league,
    scoring_fingerprint: scoringFingerprint(league.raw_scoring),
    roster_fingerprint: rosterFingerprint(league.roster_settings),
  };
}
