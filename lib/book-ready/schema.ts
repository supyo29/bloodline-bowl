/**
 * Phase 3.5C — the Book-Ready EVIDENCE CONTRACT.
 *
 * Principle: models expose atomic, trustworthy evidence; a later analyst layer (Phase 3.5D) decides how it becomes
 * chapters, charts and synthesis. Nothing here writes prose or ranks fantasy decisions.
 *
 * Design rules (enforced by `validate.ts`):
 *  - Only legitimately supported dimensions are present. Absent capability is stated through `availability`, never
 *    through a null-filled object.
 *  - Source-native values are PRESERVED next to their normalized form (`source_class` + `analysis_class`).
 *  - Independent axes are never collapsed into one score: evidence origin, model confidence, sample support,
 *    freshness, deployment and predictive status are separate fields.
 *  - Units/scale are explicit per metric (never inferred from a column name).
 */

/** Namespaced phase reference — never a bare "Phase 4". */
export type PhaseNamespace =
  | "INTELLIGENCE_MODERNIZATION_PHASE"
  | "TEAM_MANAGEMENT_PHASE"
  | "TRADE_ENGINE_PHASE"
  | "FOOTBALL_INTELLIGENCE_PHASE"
  | "BRIDGE_REALTIME_STATE_STAGE";
export interface PhaseRef { namespace: PhaseNamespace; phase: string }

// ------------------------------------------------------------------------------------------------- vocabulary
/** Universal analytical class. `source_class` always travels alongside it. */
export type AnalysisClass =
  | "OBSERVED" | "MODELED" | "PROJECTED" | "CONDITIONAL" | "DESCRIPTIVE"
  | "SHADOW" | "RECONSTRUCTED" | "UNAVAILABLE" | "UNSUPPORTED" | "SOURCE_CONFLICT";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
export type SampleSupportLevel = "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";

export type PredictiveClass =
  | "PRODUCTION_PREDICTIVE" | "SHADOW_PREDICTIVE" | "WEAKLY_PREDICTIVE"
  | "DESCRIPTIVE_ONLY" | "RESEARCH_ONLY" | "EXCLUDED" | "UNVALIDATED";

/** Distinct states — never collapsed into one another. */
export type AvailabilityState =
  | "AVAILABLE"
  | "UNAVAILABLE"            // should exist, source/artifact does not provide it
  | "NOT_APPLICABLE"         // does not apply to this subject (e.g. rushing share for a K)
  | "HISTORY_NOT_SUPPORTED"  // this metric has no legitimate history
  | "NOT_YET_REFRESHED"      // artifact is behind the completed-week frontier
  | "SOURCE_CONFLICT"        // unresolved disagreement about meaning
  | "INSUFFICIENT_SAMPLE"
  | "UNSUPPORTED_COMPARISON" // a comparison was requested that is not legitimate
  | "EXPECTED_SOURCE_LAG"    // upstream source has not published yet
  | "CURRENT_ONLY";          // only the latest state exists

export type DeploymentState = "SHADOW_ONLY" | "SHARED_CONTEXT" | "SHARED_DESCRIPTIVE" | "ADVISORY_ONLY" | "PRODUCTION_ACTIVE" | "RESEARCH_ONLY" | "UNKNOWN";

// ------------------------------------------------------------------------------------------------- units
export type UnitKind =
  | "count" | "fraction" | "percentage" | "percentile" | "rate" | "ratio" | "index"
  | "points" | "yards" | "seconds" | "categorical" | "ordinal" | "probability";

export interface UnitSpec {
  kind: UnitKind;
  display_unit: string;
  raw_unit: string;
  /** Only a range that TRULY holds. `null` bound = unbounded that side; `null` range = no fixed range. */
  valid_range: [number | null, number | null] | null;
  /** Whether a value above 1 is legitimate (a share above 1.0 is NOT automatically an error). */
  may_exceed_one: boolean;
  /** For deviation-from-league values: the unit of the deviation. */
  is_deviation?: boolean;
  /** How a source-native percentile relates to the value. Must be explicit: it is NOT uniform across metrics. */
  percentile_orientation?: "VALUE_ORIENTED" | "INVERTED_VALUE";
  note?: string;
}

// ------------------------------------------------------------------------------------------------- identity
export type IdentityResolution = "RESOLVED" | "PARTIAL" | "PLACEHOLDER" | "UNRESOLVED";
export interface SubjectIdentity {
  resolution: IdentityResolution;
  canonical_player_id?: string | null;
  source_player_id?: string | null;
  source_id_type?: string;
  name: string | null;
  position: string | null;
  team: string | null;
  /** Human-readable limitations (e.g. "position is source-native placeholder XX"). Never silently dropped. */
  limitations: string[];
}
export type SubjectKind = "PLAYER" | "TEAM" | "POPULATION" | "MANAGER_TEAM" | "MATCHUP" | "LEAGUE";
export interface Subject {
  kind: SubjectKind;
  id: string;
  identity?: SubjectIdentity;
  team?: string;
  league_slug?: string;
  manager_slug?: string;
}

// ------------------------------------------------------------------------------------------------- time / history
/** What the row represents in time. */
export type PointKind =
  | "POINT_IN_TIME_STATE"   // what the system published at that time
  | "CURRENT"               // the currently served state
  | "CURRENT_UNSNAPSHOTTED" // current served state not (yet) in the immutable history
  | "NATIVE_OBSERVATION"    // an immutable observed fact keyed by its own game/week
  | "CUMULATIVE"            // running aggregate through `through_week`
  | "SCENARIO";             // conditional scenario output — not an observed series point

export type HistoryClass =
  | "NATIVE_HISTORY" | "RECONSTRUCTABLE_AS_OF" | "RETROSPECTIVE_ONLY" | "CURRENT_ONLY" | "UNSUPPORTED";

export interface TemporalIdentity {
  season: number | null;
  week: number | null;
  through_week: number | null;
  /** When the SYSTEM produced/knew this (never "when it happened"). */
  as_of: string | null;
  generated_at: string | null;
  source_cutoff?: Record<string, number> | null;
  point_kind: PointKind;
  /** genuine as-of (published then) vs retrospective reconstruction. */
  as_of_kind: "PUBLISHED_STATE" | "OBSERVED_FACT" | "RETROSPECTIVE_RECONSTRUCTION" | "CURRENT_SNAPSHOT" | "SCENARIO_INPUT";
  week_state?: "PARTIAL" | "COMPLETE" | null;
  snapshot_id?: string | null;
  /** Player-team temporal identity (traded/released players) is Phase 7's; stated, never faked. */
  player_team_temporal_identity: "NOT_MODELED_UNTIL_INTELLIGENCE_MODERNIZATION_PHASE_7";
}

export interface HistoryPoint {
  temporal: TemporalIdentity;
  value: number | string | null;
  /** Point-level source class where it differs. */
  source_class?: string;
  availability?: AvailabilityState;
  components?: Component[];
}

// ------------------------------------------------------------------------------------------------- comparison / change
export interface Population {
  /** e.g. NFL_OFFENSE_TEAMS, NFL_WR, CHI_RECEIVERS — always stated. */
  id: string;
  season: number | null;
  through_week: number | null;
  n: number;
  definition: string;
}
export interface ComparisonContext {
  population: Population;
  /** Rank within the population by the metric's own value, with the ordering made explicit. */
  rank?: { position: number; of: number; order: "VALUE_DESCENDING" | "VALUE_ASCENDING" } | null;
  percentile?: { value: number; scale: "FRACTION_0_1"; source: "SOURCE_NATIVE" | "COMPUTED"; orientation: "VALUE_ORIENTED" | "INVERTED_VALUE" } | null;
  baseline?: { kind: string; value: number | null } | null;
  delta_vs_baseline?: number | null;
}
export interface ChangeContext {
  comparison_period: string;            // e.g. "PREVIOUS_SNAPSHOT", "SEASON_BASELINE", "PRIOR_SEASON"
  prior_value: number | string | null;
  current_value: number | string | null;
  absolute_delta: number | null;
  relative_delta: number | null;        // only when the prior is non-zero and the metric is ratio-scale
  /** Categorical states expose a transition, never a fake numeric delta. */
  transition?: { from: string; to: string } | null;
  significance: { status: string; source: "MODEL_SUPPLIED" } | null; // never manufactured
}

// ------------------------------------------------------------------------------------------------- decomposition / relations / charts
export interface Component {
  key: string;
  label?: string;
  value: number | string | null;
  unit?: UnitSpec;
  analysis_class?: AnalysisClass;
  source_class?: string;
  note?: string;
}
export type RelationType = "UPSTREAM_OF" | "DEPENDS_ON" | "DESCRIBES" | "DERIVED_FROM" | "COMPARABLE_TO" | "CONDITIONAL_ON";
export interface Relationship { type: RelationType; target: { surface: string; topic?: string; version?: string | null; note?: string } }

export type ChartForm = "line" | "bar" | "stacked_distribution" | "scatter" | "percentile" | "heatmap" | "uncertainty";
export interface ChartHint { form: ChartForm; x?: string; y?: string; group?: string; unit?: string; domain?: [number, number] | null; note?: string }

// ------------------------------------------------------------------------------------------------- the block
export interface EvidenceBlock {
  evidence_id: string;                 // deterministic
  contract_version: string;
  surface: string;                     // registry id
  topic: string;
  metric: string;
  subject: Subject;

  availability: { state: AvailabilityState; reason?: string };

  value?: number | string | null;
  unit?: UnitSpec;
  /** Present only for source-native categorical values whose translation would lose information. */
  category?: { raw: string; normalized: string | null; mapping_status: "VERIFIED" | "NO_VERIFIED_MAPPING" | "SOURCE_CONFLICT" };

  origin: { source_class: string; analysis_class: AnalysisClass };
  model_confidence?: { source_value: string; level: ConfidenceLevel; source: string };
  sample_support?: { source_value?: string; level?: SampleSupportLevel; n?: number | null; basis: string };
  predictive?: { source_status: string; class: PredictiveClass };
  deployment: { state: DeploymentState; may_influence_production: boolean };
  freshness: {
    as_of: string | null; through_week: number | null; generated_at: string | null;
    week_completion?: unknown; canonical_verdict?: unknown | null;
  };

  temporal: TemporalIdentity;
  history?: { class: HistoryClass; points: HistoryPoint[]; note?: string };
  comparison?: ComparisonContext[];
  change?: ChangeContext[];
  components?: Component[];
  uncertainty?: { kind: string; value?: number | null; range?: [number, number] | null; note?: string };

  lineage: { surface_version: string | null; content_identity?: string | null; canonical?: unknown; depends_on?: Array<{ surface: string; version: string | null }> };
  source: { artifact?: string; built_in: PhaseRef; source_data?: string };
  limitations: string[];
  relationships?: Relationship[];
  chart?: ChartHint[];
}

export const EVIDENCE_CONTRACT_VERSION = "book-ready-evidence-2026.1";
