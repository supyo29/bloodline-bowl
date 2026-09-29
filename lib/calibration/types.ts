/**
 * Projection Calibration Phase 1 — the calibration ledger contract. OBSERVE AND RECORD; NEVER OPTIMISE.
 * Nothing in lib/calibration writes a projection value, weight, coefficient, floor/ceiling or model state.
 */
export const CALIBRATION_LEDGER_VERSION = 1;

export type ArtifactKind = "PROJECTION_SNAPSHOT" | "STARTSIT_CAPTURE";
export type ScoringExactness = "LEAGUE_EXACT" | "PROVIDER_STANDARD_APPROXIMATION" | "LEAGUE_EXACT_WITH_UNMAPPED_STATS";
export type ParticipationState =
  | "PLAYED_NORMAL" | "PLAYED_LOW_SNAP_SHARE" | "PLAYED_PARTIAL_EXIT" | "DID_NOT_PLAY" | "INACTIVE" | "GAME_POSTPONED_OR_CANCELLED" | "UNKNOWN";
export type EvidenceStatus =
  | "CERTIFIED" | "CERTIFIED_APPROXIMATE_SCORING" | "NO_PREKICKOFF_PROJECTION" | "UNRESOLVED_IDENTITY"
  | "ACTUAL_SCORING_UNAVAILABLE" | "SCORING_FINGERPRINT_MISMATCH" | "GAME_NOT_PLAYED";
export type RangeStatus = "BELOW_FLOOR" | "INSIDE_RANGE" | "ABOVE_CEILING" | "RANGE_UNAVAILABLE" | "NOT_EVALUATED";

/** One authoritative NFL game: identity from the Sleeper schedule, kickoff instant from a dated authoritative source. */
export interface NflGame {
  nfl_game_id: string;
  season: number;
  week: number;
  home_team: string;
  away_team: string;
  kickoff_at: string; // ISO instant
  kickoff_source: string;
  status: string; // provider status, lower-cased ("complete", "pre_game", "postponed", ...)
  provenance: Record<string, unknown>;
}

/** A projection that MAY be pre-kickoff evidence for one player under one league scoring fingerprint. */
export interface ProjectionCandidate {
  kind: ArtifactKind;
  artifact_id: string;
  content_hash: string | null;
  request_fingerprint: string | null;
  /** When this evidence was durably recorded. Strictly-before-kickoff is the ONLY temporal test. */
  recorded_at: string;
  league_slug: string;
  scoring_fingerprint: string;
  source: string;
  model_version: string;
  projected_points: number | null;
  floor_points: number | null;
  ceiling_points: number | null;
  std_dev: number | null;
  expected_availability: number | null;
  injury_status: string | null;
  warnings: string[];
  nfl_team: string | null;
  opponent: string | null;
  position: string | null;
  scoring_exactness: ScoringExactness;
  detail?: Record<string, unknown>;
}

export interface EvidenceSelection {
  chosen: ProjectionCandidate | null;
  considered: number;
  rejected_not_before_kickoff: number;
  rejected_invalid: number;
  rule: string;
}

export interface WeatherEvidence {
  snapshot_id: string | null;
  source_name: string | null;
  source_timestamp: string | null;
  retrieved_at: string;
  roof: string | null;
  temp: number | null;
  wind: number | null;
  weather_status: string | null;
  weather_risk_score: number | null;
}

export interface CalibrationCase {
  case_id: string;
  evidence_digest: string;
  revision: number;
  supersedes_evidence_digest: string | null;
  ledger_version: number;
  season: number; week: number;
  nfl_game_id: string; kickoff_at: string; kickoff_source: string;
  canonical_player_id: string; provider_player_ids: Record<string, string>;
  player_name: string | null; nfl_team: string | null; opponent: string | null; position: string | null;
  league_slug: string; provider: string; scoring_fingerprint: string;
  projection_artifact_kind: ArtifactKind | null; projection_artifact_id: string | null; projection_content_hash: string | null;
  projection_request_fingerprint: string | null; projection_recorded_at: string | null;
  projection_source: string | null; projection_model_version: string | null;
  projected_points: number | null; projected_floor: number | null; projected_ceiling: number | null; projected_std_dev: number | null;
  expected_availability: number | null; injury_status_at_projection: string | null;
  projection_warnings: string[]; projection_scoring_exactness: ScoringExactness | null;
  projection_selection: Record<string, unknown>;
  weather_snapshot_id: string | null; weather_evidence: WeatherEvidence | null;
  football_outcome_id: string | null; stats_digest: string | null;
  participation_state: ParticipationState;
  actual_fantasy_points: number | null; actual_scoring_basis: string | null; actual_scoring_exactness: ScoringExactness | null; actual_warnings: string[];
  error: number | null; abs_error: number | null; squared_error: number | null;
  range_status: RangeStatus; below_floor: boolean | null; inside_projected_range: boolean | null; above_ceiling: boolean | null;
  evidence_status: EvidenceStatus; evidence_notes: string[];
  generated_at: string;
}

export interface FootballOutcome {
  outcome_id: string; season: number; week: number; nfl_game_id: string | null;
  canonical_player_id: string; provider_player_ids: Record<string, string>; nfl_team: string | null;
  stat_row_present: boolean; raw_stats: Record<string, number>; stats_digest: string;
  stats_source: string; stats_fetched_at: string;
}
