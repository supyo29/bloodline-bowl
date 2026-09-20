/**
 * Phase 3.5D — Analysis Book contract (TYPES ONLY, no evidence queries).
 *
 * A Book maps an analytical question into an exhaustive but lightweight CONTENTS of chapters grouped into Parts.
 * Contents is metadata + capability declarations; nothing is researched until the user opens a chapter. Opened
 * chapters are researched through Book-Ready evidence; the session records WHAT WAS EXPLORED separately from what was
 * merely USED AS SUPPORT. The Book never computes a model score: it plans, tracks state and organizes evidence.
 */
export const ANALYSIS_BOOK_CONTRACT = "analysis-book-2026.1";
export const TAXONOMY_VERSION = "analysis-taxonomy-2026.1";
export const PLANNER_RULES_VERSION = "analysis-planner-rules-2026.1";

export type BookType =
  | "PLAYER_ANALYSIS" | "START_SIT_COMPARISON" | "GAME_ANALYSIS" | "DEFENSE_ANALYSIS" | "WAIVER_ANALYSIS"
  | "TRADE_ANALYSIS" | "MANAGER_REVIEW" | "WHY_ANALYSIS" | "PLAYER_VS_DEFENSE_GAME_ANALYSIS";

/** What the system can do TODAY for a chapter (worth-asking is separate: a chapter is never dropped for lack of evidence). */
export type Researchability =
  | "READY" | "PARTIAL" | "CURRENT_ONLY" | "HISTORY_LIMITED" | "CONDITIONAL"
  | "SOURCE_LAG" | "SOURCE_CONFLICT" | "UNSUPPORTED" | "UNAVAILABLE";

export type CostClass = "FAST" | "MODERATE" | "EXPENSIVE";

export type ChapterStatus = "NOT_OPENED" | "RESEARCHING" | "EXPLORED" | "PARTIAL" | "STALE" | "NEEDS_REFRESH";

/** How a Need derives its query parameters from the book subject. */
export type Bind = "self" | "each_player" | "own_team" | "opponent" | "team_qb" | "manager" | "both_teams";

export interface Need {
  /** A Book-Ready topic id … */
  topic?: string;
  /** … or a named capability the system does NOT have (see topics.ts UNSUPPORTED_CAPABILITIES). */
  capability?: string;
  /** required: the chapter cannot answer its question without it. enrich: deepens the chapter. */
  role: "required" | "enrich";
  bind: Bind;
  /** the evidence needs a history series / comparison populations (raises depth requirements, never cost of Contents) */
  history?: boolean;
  comparisons?: boolean;
  /** conditional scenario evidence: needs a consumer-supplied scenario input */
  scenario?: boolean;
  /** extra fixed params, e.g. side=offense */
  params?: Record<string, string>;
  /** need only applies to these player positions (otherwise skipped, not failed) */
  positions?: string[];
}

export type VisualizationIntent = "TIME_SERIES" | "DISTRIBUTION" | "HEATMAP" | "PERCENTILE_BAR" | "TABLE" | "COMPARISON_BARS" | "SCATTER" | "TIMELINE";

export interface SubchapterDef { id: string; title: string; needs?: Need[]; tags?: string[] }

export interface ChapterDef {
  /** STABLE analytical identity; the displayed number is NOT identity. */
  id: string;
  title: string;
  question: string;
  tags: string[];
  needs: Need[];
  /** EVIDENCE dependency: retrieving this chapter's evidence may reuse those chapters' evidence as SUPPORT (never marks them explored). */
  depends_on?: string[];
  viz?: VisualizationIntent[];
  subchapters?: SubchapterDef[];
  /** question relevance by player position (not evidence availability) */
  applies_to?: string[];
  kind?: "EVIDENCE" | "SYNTHESIS";
}

export interface PartDef { id: string; title: string; chapters: string[] }
export interface BookTemplate {
  type: BookType;
  title: string;
  parts: PartDef[];
  /** taxonomy coverage expectations: tags that MUST be represented (checked by tests) */
  coverage_expectations: string[];
}

export interface PlayerRef {
  gsis_id?: string | null; name: string; position?: string | null; team?: string | null; opponent?: string | null;
}
export interface BookSubject {
  kind: "PLAYER" | "PLAYERS" | "TEAM" | "GAME" | "MANAGER" | "TRADE" | "WAIVER" | "EVENT";
  players: PlayerRef[];
  team?: string | null;
  opponent_team?: string | null;
  league?: string | null;
  manager?: string | null;
  /** an unresolved reference from the question ("Mark's team"): kept, never guessed */
  unresolved: string[];
  season: number;
  week?: number | null;
  team_qb_gsis?: Record<string, string>;
}

export interface EvidenceIdentity {
  surface: string; version: string | null; season: number | null; through_week: number | null; week_state?: string | null;
}

export interface ChapterResearchability {
  state: Researchability;
  reasons: string[];
  cost: CostClass;
  /** which needs are unsupported / missing / conditional, for inspection */
  unsupported: string[];
  missing_context: string[];
}

export interface ContentsChapter {
  chapter_id: string;
  display_number: number;
  part_id: string;
  title: string;
  question: string;
  tags: string[];
  needs: Need[];
  depends_on: string[];
  viz: VisualizationIntent[];
  subchapters: Array<{ id: string; label: string; title: string; needs: Need[] }>;
  kind: "EVIDENCE" | "SYNTHESIS";
  researchability: ChapterResearchability;
}

export interface EvidenceRef {
  evidence_id: string; surface: string; topic: string; metric: string; subject_id: string;
  availability: string; analysis_class: string; version: string | null; season: number | null; through_week: number | null; week_state: string | null;
  /** scale facts, so cross-subject claims can be checked without carrying payloads */
  unit_kind?: string | null; population?: string | null;
}

export interface ChapterRevision {
  revision: number; depth: number; researched_at: string; identities: EvidenceIdentity[]; evidence_refs: EvidenceRef[];
  query_keys: string[]; coverage: { satisfied: string[]; unsatisfied: string[] }; status: ChapterStatus; limitations: string[];
}
export interface SupportUse { by: string; at: string; evidence_refs: EvidenceRef[] }

export interface ChapterState {
  status: ChapterStatus;
  depth: number;
  /** newest revision last; older research is PRESERVED, never silently replaced */
  revisions: ChapterRevision[];
  used_as_support: SupportUse[];
  blocked_reason?: string | null;
}

export type FindingKind = "OBSERVATION" | "MODEL_RESULT" | "ANALYST_SYNTHESIS";
export type ClaimStrength = "STRONG" | "TENTATIVE";
export interface Finding {
  id: string; kind: FindingKind; text: string;
  chapters: string[];
  evidence_refs: string[];
  /** verbatim model value reference (MODEL_RESULT only): the Book never alters model numbers */
  model_value_ref?: string;
  claim_strength: ClaimStrength;
  strength_reasons: string[];
  temporal_context: EvidenceIdentity[];
  mixed_vintage: boolean;
  vintage_statement: string;
  cross_chapter: boolean;
}

export interface SynthesisState {
  status: "NOT_STARTED" | "PARTIAL" | "FINAL";
  last_run_at: string | null;
  coverage_hash: string | null;
}

export interface AnalysisBookSession {
  analysis_book_contract: string;
  taxonomy_version: string;
  planner_rules_version: string;
  book_id: string;
  question: string;
  book_types: BookType[];
  subject: BookSubject;
  classification: { primary: BookType; secondary: BookType[]; matched_rules: string[] };
  contents_version: string;
  /** the capability/vintage basis the Contents was generated against (researchability is re-derivable; this is what it was at creation) */
  capability_basis: { registry_version: string; season: number; vintage: EvidenceIdentity[] };
  parts: Array<{ id: string; title: string }>;
  /** frozen at creation: a taxonomy change never reinterprets a saved book */
  contents: ContentsChapter[];
  chapters: Record<string, ChapterState>;
  current_chapter: string | null;
  selected_part: string | null;
  findings: Finding[];
  synthesis_state: SynthesisState;
  created_at: string;
}
