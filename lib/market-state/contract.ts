/**
 * Phase 4.5 — the CANONICAL LEAGUE MARKET-STATE contract.
 *
 * One substrate answers: which players are actually acquirable, in THIS league, at THIS point in time, and through which
 * acquisition mechanism. It is owned by neither Waiver 2.0 nor any other consumer (waivers, trade/roster planning,
 * replacement-value, streaming and the Analysis Book all read the same snapshot).
 *
 * Non-negotiables encoded here (and enforced by `integrity.ts`):
 *   - OWNERSHIP IS NOT AVAILABILITY. `UNROSTERED` never implies `AVAILABLE_FREE_AGENT`; that needs a verified universe,
 *     verified rosters, verified rules, a verified transaction window, and an eligible player identity.
 *   - Unknown stays unknown. A waiver clear instant the provider does not expose is `null`, never estimated.
 *   - Three identities never mix: a request id (per read), a source snapshot id (per read), and the semantic
 *     `market_content_id` (what the market actually says). Only the last is stable across reads.
 */
export const MARKET_STATE_VERSION = "market-state-2026.1";
export const MARKET_ELIGIBILITY_RULES_VERSION = "market-eligibility-2026.1";

export type MarketProvider = "sleeper";

/** The headline state per player. WAIVER_CLAIM_PENDING is part of the vocabulary but no supported provider can emit it. */
export type PlayerMarketStatus =
  | "ROSTERED"
  | "AVAILABLE_FREE_AGENT"
  | "ON_WAIVERS"
  | "WAIVER_CLAIM_PENDING"
  | "LOCKED" // vocabulary only: emitted when a provider states an add-lock; Sleeper does not, so this builder never emits it
  | "INELIGIBLE"
  | "UNKNOWN_AVAILABILITY"
  | "SOURCE_UNAVAILABLE";
export const PLAYER_MARKET_STATUSES: PlayerMarketStatus[] = ["ROSTERED", "AVAILABLE_FREE_AGENT", "ON_WAIVERS", "WAIVER_CLAIM_PENDING", "LOCKED", "INELIGIBLE", "UNKNOWN_AVAILABILITY", "SOURCE_UNAVAILABLE"];

export type OwnershipStatus = "ROSTERED" | "UNROSTERED" | "UNKNOWN";
export type AcquisitionStatus = "FREE_AGENT" | "WAIVER" | "LOCKED" | "UNAVAILABLE" | "UNKNOWN";
/** How the player could be acquired. `NONE` when not acquirable; `UNKNOWN` when it cannot be established. */
export type AcquisitionMechanism = "FREE_AGENT_ADD" | "WAIVER_CLAIM" | "NONE" | "UNKNOWN";
export type RosterSlotKind = "ACTIVE" | "RESERVE" | "TAXI";

export type IneligibleReason =
  | "NO_FANTASY_POSITION"
  | "POSITION_NOT_IN_LEAGUE"
  | "NO_NFL_TEAM"
  | "RETIRED_OR_INACTIVE_IDENTITY"
  | "DUPLICATE_OR_STALE_IDENTITY";
export type UnknownReason =
  | "PRACTICE_SQUAD_ELIGIBILITY_UNVERIFIED"
  | "PLAYER_STATUS_UNRECOGNIZED"
  | "PLAYER_MARKED_NOT_ACTIVE"
  | "WAIVER_WINDOW_UNVERIFIABLE"
  | "ACQUISITION_RULES_UNKNOWN"
  | "ROSTER_STATE_UNAVAILABLE"
  | "PLAYER_UNIVERSE_UNAVAILABLE";
/** Facts that do NOT change availability but that a consumer may need (a poor or injured player is still available). */
export type PlayerCaveat = "NFL_INJURED_RESERVE_DESIGNATION" | "NFL_INACTIVE_DESIGNATION" | "SUSPENDED" | "PUP_OR_NFI" | "INJURY_DESIGNATION_PRESENT";

/**
 * Game state of the player's NFL team THIS WEEK, from the schedule: OPEN = pre_game (or bye), LOCKED = in progress or complete, UNKNOWN = unverifiable.
 * A fact about this week's scoring, NOT an add-eligibility verdict: the provider publishes no add-lock rule.
 */
export type LockState = "OPEN" | "LOCKED" | "UNKNOWN";

export type SourceStatus = "OK" | "UNAVAILABLE" | "PARTIAL";
export type SourceClass = "PROVIDER_LIVE" | "PROVIDER_DERIVED" | "INFERRED" | "UNAVAILABLE";
export type Freshness = "FRESH" | "STALE" | "UNKNOWN";

export interface PlayerMarketState {
  /** Provider-scoped identity: `sleeper:<player_id>`. DEF/ST teams are `sleeper:<TEAM>` with `entity: "TEAM_DEFENSE"`. */
  player_key: string;
  provider: MarketProvider;
  provider_player_id: string;
  entity: "PLAYER" | "TEAM_DEFENSE";
  /** Canonical id when a resolver supplied one (consumers key their own evidence on it). Never required for ownership. */
  canonical_player_id: string | null;
  full_name: string | null;
  position: string | null;
  team: string | null;
  league_slug: string;
  season: number;
  week: number;
  as_of: string;
  status: PlayerMarketStatus;
  ownership: OwnershipStatus;
  owner_team_id: string | null;
  roster_slot: RosterSlotKind | null;
  acquisition: { status: AcquisitionStatus; mechanism: AcquisitionMechanism };
  /** null unless the provider states it. Never fabricated: Sleeper does not expose a clear instant. */
  waiver_clears_at: string | null;
  /** When the player entered the waiver window (the provable drop), and the configured window length. Both from the transaction feed. */
  waiver_window: { dropped_at: string; clear_days: number } | null;
  eligible_to_add: boolean;
  /** Present whenever `eligible_to_add` is false or the status is not a clean FREE_AGENT/ROSTERED. */
  reason: IneligibleReason | UnknownReason | "OWNED" | "IN_WAIVER_WINDOW" | "GAME_LOCKED" | null;
  lock: LockState;
  caveats: PlayerCaveat[];
  injury_status: string | null;
  nfl_status: string | null;
  source: { provider: MarketProvider; source_class: SourceClass; freshness: Freshness };
}

/* ------------------------------------------------------------------------------------------ readiness */
export type ReadinessReasonCode =
  | "PLAYER_UNIVERSE_UNAVAILABLE"
  | "ROSTER_STATE_UNAVAILABLE"
  | "IDENTITY_INCOMPLETE"
  | "ACQUISITION_RULES_UNKNOWN"
  | "STALE_MARKET_STATE"
  | "PROVIDER_ERROR"
  | "WAIVER_STATE_UNVERIFIABLE"
  | "GAME_LOCK_UNVERIFIABLE"
  | "FAAB_CONTEXT_UNAVAILABLE"
  | "PENDING_CLAIMS_NOT_EXPOSED"
  | "WAIVER_CLEAR_TIME_NOT_EXPOSED"
  | "OWNERSHIP_INTEGRITY_VIOLATION";
/** BLOCKING: the pool must not be treated as actionable. LIMITING: actionable, but a stated caveat applies. INFO: permanent provider limitation. */
export type ReadinessSeverity = "BLOCKING" | "LIMITING" | "INFO";
export interface ReadinessReason { code: ReadinessReasonCode; severity: ReadinessSeverity; detail: string }
export const BLOCKING_REASON_CODES: ReadinessReasonCode[] = ["PLAYER_UNIVERSE_UNAVAILABLE", "ROSTER_STATE_UNAVAILABLE", "ACQUISITION_RULES_UNKNOWN", "WAIVER_STATE_UNVERIFIABLE", "STALE_MARKET_STATE", "PROVIDER_ERROR", "OWNERSHIP_INTEGRITY_VIOLATION"];
export type MarketReadinessStatus = "READY" | "PARTIAL" | "NOT_READY";
export interface MarketReadiness {
  status: MarketReadinessStatus;
  /** true only when there is no BLOCKING reason. Waiver 2.0 must still decide per field; see `blocks`. */
  pool_actionable: boolean;
  reasons: ReadinessReason[];
  /** Codes that block actionability (a subset of `reasons`). */
  blocks: ReadinessReasonCode[];
  /** Codes that limit but do not block. */
  limitations: ReadinessReasonCode[];
}

/* ------------------------------------------------------------------------------------------ rules + acquisition context */
export type AcquisitionSystem = "FAAB" | "PRIORITY" | "UNKNOWN";
export interface LeagueAcquisitionRules {
  system: AcquisitionSystem;
  /** Only meaningful when `system === "FAAB"`; a stray `waiver_budget` value in a priority league is NOT a currency. */
  faab_budget: number | null;
  faab_min_bid: number | null;
  waiver_clear_days: number | null;
  waiver_day_of_week: number | null;
  reserve_slots: number | null;
  taxi_slots: number | null;
  /** Positions this league can start (after FLEX/SUPER_FLEX/IDP expansion). */
  startable_positions: string[];
}
export interface TeamAcquisitionContext { team_id: string; roster_id: number; faab_remaining: number | null; waiver_priority: number | null; roster_size: number; roster_limit: number | null }
/** Separate from availability by construction. Missing FAAB never changes a player's `status`. */
export interface AcquisitionContext { rules: LeagueAcquisitionRules; teams: TeamAcquisitionContext[]; status: "OK" | "PARTIAL" | "UNAVAILABLE"; context_id: string }

/* ------------------------------------------------------------------------------------------ snapshot */
export type HistoryClass = "TRUE_AS_OF" | "RECONSTRUCTED" | "RETROSPECTIVE_ONLY" | "UNSAFE";
export interface MarketIdentities {
  /** Per-read. NEVER part of any content identity. */
  request_id: string;
  /** Per-read source snapshot (canonical league snapshot id, when known). NEVER part of any content identity. */
  source_snapshot_id: string | null;
  ownership_id: string;
  universe_id: string;
  transactions_id: string;
  rules_id: string;
  lock_id: string;
  scoring_fingerprint: string | null;
  /** Semantic identity of the market: ownership + universe + waiver window + rules + locks. Excludes FAAB, request ids and timestamps. */
  market_content_id: string;
}
export interface SourceReport { status: SourceStatus; source_class: SourceClass; fetched_at: string | null; detail: string | null }
export interface MarketSources { rules: SourceReport; rosters: SourceReport; universe: SourceReport; transactions: SourceReport; schedule: SourceReport }

export interface MarketSnapshot {
  market_state_version: string;
  eligibility_rules_version: string;
  league_slug: string;
  season: number;
  week: number;
  /** Wall-clock of the read; not part of any content identity. */
  as_of: string;
  provider: MarketProvider;
  identities: MarketIdentities;
  history_class: HistoryClass;
  sources: MarketSources;
  readiness: MarketReadiness;
  acquisition: AcquisitionContext;
  /** Every decision-relevant player: rostered, available, on waivers, locked, and unknown. INELIGIBLE players are counted, not enumerated. */
  players: PlayerMarketState[];
  ineligible_counts: Record<string, number>;
  counts: Record<PlayerMarketStatus, number>;
  limitations: string[];
}

/** The union of provider limits that no consumer may ignore; kept in one place so docs, Book-Ready and readiness agree. */
export const PROVIDER_LIMITATIONS: Record<string, string> = {
  PENDING_CLAIMS_NOT_EXPOSED: "The provider does not expose pending waiver claims; WAIVER_CLAIM_PENDING cannot be established and pending competition is UNKNOWN.",
  WAIVER_CLEAR_TIME_NOT_EXPOSED: "The provider does not expose a per-player waiver clear instant; only the drop time and the league's clear-days window are known.",
  HIDDEN_BIDS_NOT_EXPOSED: "Other teams' pending FAAB bids are not exposed; bids are visible only after processing.",
};
