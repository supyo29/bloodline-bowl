/**
 * Phase 5 — evidence SOURCE boundary. Pure interfaces + a file-backed implementation over the already-certified readers
 * (Player-Scheme, Football Intelligence, Role). Nothing here recomputes a model; tests inject synthetic sources.
 */
import type { EvidenceTier, SourceVintage } from "./contract";

export type Row = Record<string, string | number | boolean | null>;
export interface SplitRow { window: string; bucket: string; n: number | null; values: Record<string, number | null>; evidence: EvidenceTier }
export interface CellRow { window: string; depth_bin: string; field_third: string; n: number | null; share: number | null; epa: number | null; explosive: number | null; success: number | null; evidence: EvidenceTier }
export interface FiRating { modeled: number | null; league_percentile: number | null; predictive_status: string | null; confidence: string | null }

export interface DefenseEvidence {
  team: string;
  /** wide tendency rows by window (man_zone__*, coverage_family__*, pressure__*, box__*, live__*) */
  tendency: Record<string, Row>;
  pass_cells: Array<{ window: string; depth_bin: string; field_third: string; targets: number | null; share: number | null; epa: number | null; explosive: number | null; success: number | null; td: number | null; evidence: EvidenceTier }>;
  rush_direction: Array<{ window: string; field_third: string; carries: number | null; epa: number | null; explosive: number | null; stuff: number | null; evidence: EvidenceTier }>;
  rush_gap: Array<{ window: string; run_gap: string; carries: number | null; epa: number | null; explosive: number | null; evidence: EvidenceTier }>;
  fi_defense: Record<string, FiRating>;
  /** unit-level EPA allowed to a position group (FI). NEVER an individual defender. */
  fi_unit_coverage: Record<"RB" | "WR" | "TE", FiRating | null>;
  scheme_era: Row[];
}
export interface OffenseEvidence { team: string; tendency: Record<string, Row>; fi_offense: Record<string, FiRating>; scheme_era: Row[] }
export interface RoleSummary { target_share: number | null; route_participation: number | null; rush_share: number | null; rz_target_share: number | null; rz_carry_share: number | null; goal_line_carries: number | null; snap_share: number | null; role_level: string | null; role_evidence: string | null; role_trend: string | null; injury_status: string | null; through_week: number | null }
export interface PlayerEvidence {
  gsis_id: string; name: string | null; position: string | null; team: string | null;
  receiver_cells: CellRow[]; qb_cells: CellRow[]; rb_direction: Array<{ window: string; field_third: string; n: number | null; share: number | null; epa: number | null; explosive: number | null; stuff: number | null; evidence: EvidenceTier }>;
  rb_gap: Array<{ window: string; run_gap: string; n: number | null; epa: number | null; explosive: number | null; stuff: number | null; evidence: EvidenceTier }>;
  receiver_coverage: SplitRow[]; receiver_routes: SplitRow[]; qb_coverage: SplitRow[]; qb_pressure: SplitRow[]; qb_rushers: SplitRow[]; rb_box: SplitRow[];
  role: RoleSummary | null;
}
export interface MatchupSource {
  season(): number;
  vintages(): SourceVintage[];
  resolvePlayer(idOrName: string): PlayerEvidence | null;
  defenseTeams(): string[];
  defense(team: string): DefenseEvidence | null;
  offense(team: string): OffenseEvidence | null;
  /** upcoming opponent for a team (schedule), when known */
  opponent(team: string, week: number): string | null;
  contextual(feature: string, offense: string | null, defense: string): { offense_rating: number | null; defense_rating: number | null; interaction_signal: number | null; predictive_status: string | null; confidence: string | null } | null;
  identities(): { player_scheme: string | null; fi: string | null; role: string | null; opp: string | null };
}
