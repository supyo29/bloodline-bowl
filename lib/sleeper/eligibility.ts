/**
 * The single authoritative rule for "is this Sleeper player record a legitimate
 * current fantasy-draft candidate?".
 *
 * Every code path that builds an available-player pool or a recommendation
 * candidate list MUST use `isCurrentlyDraftable` / `eligibilityOf` from this
 * module. Do not re-implement the predicate inline.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Sleeper's `/players/nfl` dump keeps historical records forever. A retired
 * player frequently still has `active: true` and a low, relevant-looking
 * `search_rank`, e.g. (observed live, 2026 pre-season):
 *
 *     Tom Brady    QB  team: null  active: true   status: "Active"  search_rank: 74
 *     Todd Gurley  RB  team: null  active: true   status: "Active"  search_rank: 27
 *
 * The one field that reliably separates a current NFL player from a stale
 * record is **`team`**: a player on an NFL roster has a team abbreviation; a
 * retired / released / unsigned player has `team: null`. `active` and
 * `search_rank` are not trustworthy on their own.
 *
 * ── The predicate ───────────────────────────────────────────────────────────
 * Eligibility ("is this a legitimate entity to draft at all?") is separate from
 * availability ("is that legitimate entity still undrafted?").
 *
 *   For a non-DEF player p:
 *     Eligible(p)  =  SupportedPosition(p) ∧ Active(p) ∧ HasCurrentNFLTeam(p)
 *
 *   For a team defense p:
 *     EligibleDEF(p)  =  IsValidDefenseEntity(p) ∧ Active(p) ∧ HasCurrentNFLTeam(p)
 *     (all 32 real DEF records carry their own NFL team abbreviation, so the
 *      team check is a real signal here too — it is NOT waived for DEF.)
 *
 *   where
 *     SupportedPosition(p)  =  p resolves to at least one of QB/RB/WR/TE/K/DEF
 *     Active(p)             =  p.active !== false        (null / missing = ok)
 *     HasCurrentNFLTeam(p)  =  p.team is a non-empty string
 *
 * Then, at draft state D:
 *
 *     Available(p, D)  =  Eligible(p) ∧ ¬Drafted(p, D)
 *     Drafted(p, D)    =  player_id(p) ∈ DraftedPlayerIds(D)      (ID-first)
 *
 * ── Deliberate policy choices (see PHASE 1 report §H) ────────────────────────
 *  • Injury / IR / PUP / suspension are NOT exclusion criteria. An in-season IR
 *    player still has a `team`, so `team != null` keeps him eligible. We never
 *    read `status` to exclude a player — that would drop legitimate injured
 *    starters and stashes.
 *  • Depth-chart position / rookie status are NOT exclusion criteria.
 *  • A genuinely unsigned NFL free agent has `team: null` and is therefore
 *    excluded. This is the conservative choice: you cannot start a player who is
 *    not on an NFL team. Such a player re-enters the pool automatically the
 *    moment Sleeper assigns him a team. Documented, not silently guessed.
 *  • `team` is validated only as "non-empty string", not against a hard-coded
 *    list of 32 abbreviations — franchise relocations make a static list a
 *    maintenance hazard, and Sleeper never puts garbage in `team` for a real
 *    record.
 *  • Supported positions are hard-coded to QB/RB/WR/TE/K/DEF because this Bridge
 *    serves standard-lineup leagues (Bloodline Bowl, Devoted to the Game).
 *    IDP records fail closed as `unsupported_position`.
 */

import type { NormalizedPlayer } from "./types";

/** One-line statement of the predicate, for API diagnostics payloads. */
export const ELIGIBILITY_RULE_TEXT =
  "Available = supported_position(QB/RB/WR/TE/K/DEF) AND active!==false AND team!=null AND NOT drafted(by player_id). " +
  "Team defenses use the same rule (they carry their own NFL team abbreviation). " +
  "Injury/IR/PUP/suspension/depth-chart/rookie status are NOT exclusion criteria; a teamless free agent IS excluded until Sleeper assigns a team.";

/** Fantasy positions this Bridge supports drafting. IDP etc. fail closed. */
export const SUPPORTED_FANTASY_POSITIONS: ReadonlySet<string> = new Set([
  "QB",
  "RB",
  "WR",
  "TE",
  "K",
  "DEF",
]);

/** Machine-readable exclusion reason, for aggregated diagnostics. */
export type IneligibilityReason =
  | "malformed"
  | "unsupported_position"
  | "inactive"
  | "missing_team";

export type EligibilityReason = "eligible" | IneligibilityReason;

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  /** True when the record is a team-defense entity (took the DEF branch). */
  is_defense: boolean;
}

/** The positions a record can fill: Sleeper's `fantasy_positions`, else `position`. */
function effectivePositions(player: NormalizedPlayer): string[] {
  if (Array.isArray(player.fantasy_positions) && player.fantasy_positions.length > 0) {
    return player.fantasy_positions.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
  }
  return typeof player.position === "string" && player.position.length > 0
    ? [player.position]
    : [];
}

function hasCurrentNflTeam(player: NormalizedPlayer): boolean {
  return typeof player.team === "string" && player.team.trim().length > 0;
}

function isActive(player: NormalizedPlayer): boolean {
  // `active` is only ever `false` for a record Sleeper has explicitly retired.
  // `null` (unknown, only on unresolved records) is not treated as inactive —
  // those records are already rejected as `malformed`.
  return player.active !== false;
}

/**
 * Classify one player record. Deterministic. Precedence of failure reasons:
 * malformed → unsupported_position → inactive → missing_team.
 */
export function eligibilityOf(
  player: NormalizedPlayer | null | undefined,
): EligibilityResult {
  if (!player || typeof player !== "object") {
    return { eligible: false, reason: "malformed", is_defense: false };
  }
  if (typeof player.player_id !== "string" || player.player_id.length === 0) {
    return { eligible: false, reason: "malformed", is_defense: false };
  }
  // `resolved: false` == the id was not found in Sleeper's player DB.
  if (player.resolved === false) {
    return { eligible: false, reason: "malformed", is_defense: false };
  }

  const positions = effectivePositions(player);
  if (positions.length === 0) {
    return { eligible: false, reason: "malformed", is_defense: false };
  }

  const supported = positions.filter((p) => SUPPORTED_FANTASY_POSITIONS.has(p));
  if (supported.length === 0) {
    return { eligible: false, reason: "unsupported_position", is_defense: false };
  }

  const isDefense = supported.includes("DEF");

  if (isDefense) {
    // ── DEF branch ──────────────────────────────────────────────────────────
    // A team defense is a valid entity when it is an active record carrying its
    // own NFL team abbreviation. All 32 real DEF records satisfy this; a
    // malformed DEF without a team fails closed.
    if (!isActive(player)) {
      return { eligible: false, reason: "inactive", is_defense: true };
    }
    if (!hasCurrentNflTeam(player)) {
      return { eligible: false, reason: "missing_team", is_defense: true };
    }
    return { eligible: true, reason: "eligible", is_defense: true };
  }

  // ── Non-DEF branch (QB / RB / WR / TE / K) ─────────────────────────────────
  if (!isActive(player)) {
    return { eligible: false, reason: "inactive", is_defense: false };
  }
  if (!hasCurrentNflTeam(player)) {
    return { eligible: false, reason: "missing_team", is_defense: false };
  }
  return { eligible: true, reason: "eligible", is_defense: false };
}

/** `true` iff this record is a legitimate current fantasy-draft candidate. */
export function isCurrentlyDraftable(
  player: NormalizedPlayer | null | undefined,
): boolean {
  return eligibilityOf(player).eligible;
}

/** Aggregated exclusion counts for diagnostics (see PHASE 1 report §F). */
export interface EligibilityDiagnostics {
  player_pool_total: number;
  eligible_player_count: number;
  excluded_player_count: number;
  excluded_by_reason: Record<IneligibilityReason, number>;
}

export function emptyEligibilityDiagnostics(): EligibilityDiagnostics {
  return {
    player_pool_total: 0,
    eligible_player_count: 0,
    excluded_player_count: 0,
    excluded_by_reason: {
      malformed: 0,
      unsupported_position: 0,
      inactive: 0,
      missing_team: 0,
    },
  };
}

/** Fold one classification into a running diagnostics accumulator. */
export function recordEligibility(
  diag: EligibilityDiagnostics,
  result: EligibilityResult,
): void {
  diag.player_pool_total += 1;
  if (result.eligible) {
    diag.eligible_player_count += 1;
    return;
  }
  diag.excluded_player_count += 1;
  if (result.reason !== "eligible") {
    diag.excluded_by_reason[result.reason] += 1;
  }
}
