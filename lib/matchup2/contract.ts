/**
 * Phase 5 — MATCHUP INTELLIGENCE 2.0 contract.
 *
 * Models INTERACTION between a specific offensive profile and a specific defensive structure — not opponent rank. Position-aware families,
 * every component labelled with its evidence ORIGIN, its reconstruction/predictive class and its uncertainty. v1 emits NO numeric fantasy
 * adjustment (`numeric_adjustment: null`): Phase 9 Tier D found no player×scheme interaction family beating the production-like baseline
 * out of sample, and weights may not be assigned without an evaluation target and a beating result.
 */
export const MATCHUP2_VERSION = "matchup-2-2026.1";
export const MATCHUP2_CONTRACT = "matchup2-evidence-2026.1";
export const MATCHUP2_LIFECYCLE = "SHADOW_ONLY" as const;

export type Position = "QB" | "RB" | "WR" | "TE";
/** What kind of knowledge a component is. A modeled game expectation is NEVER presented as an observed tendency. */
export type EvidenceOrigin = "OBSERVED_DEFENSIVE_TENDENCY" | "OBSERVED_PLAYER_PROFILE" | "MODELED_GAME_EXPECTATION" | "DESCRIPTIVE_CONTEXT" | "UNSUPPORTED";
export type Direction = "ADVANTAGE" | "DISADVANTAGE" | "NEUTRAL" | "UNDETERMINED";
export type EvidenceTier = "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";
export type HistoryClass = "TRUE_AS_OF" | "RECONSTRUCTABLE_AS_OF" | "RETROSPECTIVE_ONLY" | "UNSAFE_FOR_BACKTEST";
/** EVALUATED_NO_INCREMENTAL_VALUE: a candidate family whose walk-forward study found no gain over the production-like baseline (contextual evidence only). */
export type PredictiveClass = "PREDICTIVE_CANDIDATE_UNVALIDATED" | "EVALUATED_NO_INCREMENTAL_VALUE" | "DESCRIPTIVE_CONTEXT" | "UNSUPPORTED";
export type Availability = "LIVE_CURRENT" | "PRIOR_ONLY" | "DESCRIPTIVE_ONLY" | "UNAVAILABLE";

export interface SourceVintage { source: "football-intelligence" | "player-scheme" | "role-opportunity" | "opportunity-propagation" | "schedule"; version: string | null; season: number | null; through_week: number | null; availability: Availability }

/** A single structural interaction. `value` is in the stated unit; `z` is this defense's value standardized against the other defenses FOR THE SAME PLAYER (player-specific by construction). */
export interface InteractionComponent {
  id: string;
  family: string;
  position: Position | "TEAM";
  title: string;
  origin: EvidenceOrigin;
  history_class: HistoryClass;
  predictive_class: PredictiveClass;
  direction: Direction;
  value: number | null;
  unit: string;
  /** standardized across defenses for this player (null when not computable) */
  z: number | null;
  /** the defense's own rank of this value among 32 (1 = most favorable to the offense); null when not computable */
  rank_among_defenses: number | null;
  evidence: EvidenceTier;
  window: string | null;
  /** raw inputs the value was computed from — component-level transparency (never hidden behind a composite) */
  inputs: Record<string, number | string | null>;
  /** what would change this reading (scenario sensitivity) */
  sensitivity: Array<{ scenario: string; value: number | null; note: string }>;
  uncertainty: UncertaintySource[];
  limitations: string[];
}

export type UncertaintySourceKind = "SMALL_SAMPLE" | "PRIOR_ONLY_CURRENT_SEASON" | "MIXED_VINTAGE" | "SCHEME_RESET_HINT" | "QB_CHANGE" | "ROLE_INSTABILITY" | "SOURCE_UNSUPPORTED" | "STALE_SOURCE" | "GENERIC_PROXY_ONLY" | "BASELINE_ONLY_EXPECTATION" | "PLAYER_INJURY_STATE";
export interface UncertaintySource { kind: UncertaintySourceKind; level: "LOW" | "MEDIUM" | "HIGH"; note: string }

export interface UnsupportedItem { id: string; asked: string; reason: string; would_need: string; chapter_ids: string[] }

export interface MatchupSubject { kind: "PLAYER" | "TEAM"; id: string; name: string | null; team: string | null; position: Position | null }
export interface GameRef { season: number; week: number | null; offense_team: string; defense_team: string; home: boolean | null }

export type StructuralVerdict = "FAVORABLE" | "UNFAVORABLE" | "MIXED" | "NEUTRAL" | "INSUFFICIENT_EVIDENCE";
export interface MatchupEvaluation {
  contract: typeof MATCHUP2_CONTRACT;
  model_version: typeof MATCHUP2_VERSION;
  lifecycle_state: typeof MATCHUP2_LIFECYCLE;
  may_influence_production: false;
  offense_subject: MatchupSubject;
  defense_subject: { team: string };
  game: GameRef;
  components: InteractionComponent[];
  advantages: string[]; disadvantages: string[]; neutral_factors: string[]; undetermined: string[];
  /** Descriptive summary of the component directions — NOT a score and NOT a prediction. */
  structural_verdict: StructuralVerdict;
  /** the generic opponent-strength reading (FI overall), reported SEPARATELY so player-specific and generic can be compared */
  generic_defense_context: { pass_percentile: number | null; rush_percentile: number | null; overall_percentile: number | null; predictive_status: string | null; note: string };
  player_specific_vs_generic: "AGREE" | "DISAGREE" | "NOT_COMPARABLE";
  numeric_adjustment: null;
  numeric_adjustment_reason: string;
  unsupported: UnsupportedItem[];
  uncertainty: UncertaintySource[];
  overall_evidence: EvidenceTier;
  vintage: SourceVintage[];
  lineage: { context_identity: string; player_scheme_identity: string | null; fi_version: string | null; role_version: string | null; opp_version: string | null; scoring_fingerprint: string | null };
  content_identity: string;
}

export const NUMERIC_ADJUSTMENT_REASON = "No fitted numeric adjustment exists: Phase 9 Tier D (walk-forward 2022-2025, production-like baseline) found 0 PREDICTIVE_INCREMENTAL interaction families, and Matchup 2.0 v1 assigns no weights without an evaluation target and a beating result (docs §25).";
