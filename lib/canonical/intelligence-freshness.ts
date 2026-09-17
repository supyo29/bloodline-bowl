/**
 * Intelligence Modernization Phase 1 — the central freshness evaluator.
 * See `docs/INTELLIGENCE_MODERNIZATION_PHASE_1_AUDIT.md` for the audit this
 * implements.
 *
 * ONE deterministic, pure function judges whether the intelligence evidence
 * behind a recommendation is current, partially current, degraded, stale, or
 * incompatible -- so no recommendation engine has to reinvent this
 * comparison, and no two engines can silently disagree about it.
 *
 * `freshness-policy:2026.1` is versioned SEPARATELY from
 * `football_intelligence_version` (config below) -- the FI version says what
 * data produced a snapshot; the policy version says which rules were used to
 * judge it. They must never be conflated.
 *
 * HARD RULE (Checkpoint A finding, live-verified): a provider's nominal
 * "current NFL week" counter (e.g. Sleeper's `state.week`, which advances on
 * a fixed schedule cadence before games are played) is NEVER compared
 * directly against Football Intelligence's `through_week`. That comparison
 * is prohibited because it produces false staleness verdicts for a
 * legitimately current, not-yet-started week. Freshness is instead judged
 * against an explicit, independently-sourced `NflRealityFrontier` --
 * "how many games have actually finished" -- supplied by the caller. If no
 * such frontier is supplied, this evaluator does NOT guess; it reports FI's
 * own self-described completeness with a `NO_INDEPENDENT_FRONTIER` note
 * rather than fabricating a verdict it cannot support.
 *
 * `overall_status` and `usable` describe the INTELLIGENCE EVIDENCE assessed
 * for `operation`, scoped to whatever the caller's `lineage` actually
 * consulted. They are NOT a verdict on the production recommendation as a
 * whole. For an operation whose production path does not consume Football
 * Intelligence (Waiver and Start/Sit today, per the Phase 1 audit), a STALE
 * or DEGRADED result here means only that FI-derived shadow/advisory
 * evidence is unreliable for this call -- the production number is
 * unaffected because it never depended on that evidence in the first place.
 */

import type {
  RecommendationLineage,
  FootballIntelligenceLineage,
} from "./lineage";

export const FRESHNESS_POLICY_VERSION = "freshness-policy:2026.2";

/**
 * The Football Intelligence daily refresh's own documented cadence
 * (`.github/workflows/football-intel-daily-refresh.yml`, `cron: "0 13 * * *"`)
 * -- NOT an arbitrary threshold. A gap between the runtime
 * `NflRealityFrontier` and FI's self-reported `week_completion` that's
 * within one refresh cycle (plus a buffer for a delayed/retried run) is
 * expected, ordinary publication lag; a gap that persists past it means the
 * scheduled refresh should already have picked up the completed game and
 * something is actually behind.
 */
export const FI_REFRESH_CADENCE_HOURS = 24;
export const FI_REFRESH_LAG_BUFFER_HOURS = 12;

export type IntelligenceOperation =
  | "START_SIT"
  | "WAIVER"
  | "MATCHUP"
  | "TRADE"
  | "ROSTER_PLANNING"
  | "ANALYSIS_ONLY";

export type OverallFreshnessStatus =
  | "CURRENT"
  | "PARTIAL_CURRENT"
  | "DEGRADED"
  | "STALE"
  | "INCOMPATIBLE";

export type ConfidenceCap = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE";

export type FreshnessSeverity = "INFO" | "WARN" | "BLOCK";

export type FreshnessReasonCode =
  | "FI_NOT_USED"
  | "FI_CURRENT"
  | "FI_PARTIAL_CURRENT"
  | "FI_BEHIND_COMPLETED_GAMES"
  | "FI_SEASON_BEHIND_CURRENT"
  | "FI_AHEAD_OF_REALITY"
  | "FI_SEASON_MISMATCH"
  | "NO_INDEPENDENT_FRONTIER"
  | "NO_WEEK_COMPLETION_METADATA"
  | "LEAGUE_MISMATCH"
  | "SEASON_MISMATCH"
  | "SCORING_FINGERPRINT_MISMATCH"
  | "PROJECTION_UNAVAILABLE"
  | "PROJECTION_UNRESOLVED"
  | "SOURCE_AT_CUTOFF"
  | "SOURCE_EXPECTED_LAG"
  | "SOURCE_UNAVAILABLE_FOR_SEASON"
  | "SOURCE_REGRESSED"
  | "DESCRIPTIVE_ONLY_FAMILY"
  // Checkpoint D: the runtime NflRealityFrontier (Sleeper schedule status)
  // and Football Intelligence's own self-reported week_completion (nflverse
  // schedule/result state, via the daily refresh) are two independently
  // maintained descriptions of football reality. A gap between them is
  // classified using EVIDENCE (how long ago FI last refreshed, relative to
  // its own documented daily cadence), never an arbitrary wall-clock
  // threshold and never a third schedule source.
  | "REALITY_FRONTIER_SOURCE_DISAGREEMENT"
  | "FI_PUBLICATION_LAG_POSSIBLE"
  | "FI_BEHIND_CONFIRMED_COMPLETED_GAME"
  | "SCHEDULE_SOURCE_CONFLICT";

export interface FreshnessReason {
  code: FreshnessReasonCode;
  severity: FreshnessSeverity;
  affects: string[];
  detail: string;
}

/** The feature families this evaluator can independently track. Ordering here IS the deterministic report order. */
export const INTELLIGENCE_FEATURE_FAMILIES = [
  "LEAGUE_STATE",
  "SCORING",
  "SCHEDULE",
  "PBP_TEAM_EFFICIENCY",
  "PLAYER_USAGE",
  "SNAP_COUNTS",
  "ROUTE_PARTICIPATION",
  "PFR_PRESSURE",
  "NGS",
  "FTN_DESCRIPTIVE",
  "COVERAGE_UNIT_PROFILES",
  "CONTEXTUAL_MATCHUP",
] as const;
export type IntelligenceFeatureFamily = (typeof INTELLIGENCE_FEATURE_FAMILIES)[number];

export type FeatureFamilyAvailability = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" | "NOT_APPLICABLE";
export type FeatureFamilyLagClassification =
  | "AT_CUTOFF"
  | "EXPECTED_SOURCE_LAG"
  | "BROKEN_OR_MISSING_DATA"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE";
export type PredictiveEligibility = "PREDICTIVE_ELIGIBLE" | "DESCRIPTIVE_ONLY" | "NOT_ELIGIBLE" | "UNKNOWN";
export type ProductionNumericInfluence = "PROHIBITED" | "NOT_APPLICABLE";

export interface FeatureFamilyStatus {
  family: IntelligenceFeatureFamily;
  availability: FeatureFamilyAvailability;
  /** the raw FI source's data_cutoff week, when this family maps to a tracked raw source. */
  data_cutoff_week: number | null;
  lag_weeks: number | null;
  lag_classification: FeatureFamilyLagClassification;
  predictive_eligibility: PredictiveEligibility;
  /**
   * Whether this family is currently permitted to influence a PRODUCTION
   * (non-shadow) numeric recommendation. Hardcoded PROHIBITED for every FI
   * family in Checkpoint B: the Phase 1 audit confirmed Football
   * Intelligence is shadow-only everywhere today, and this evaluator does
   * not read or change any deployment-state artifact (that remains
   * `lib/weekly/start-sit-fi/deployment.ts` / `matchup-intelligence/deployment.ts`'s
   * job, position-scoped, and untouched by this phase). This field will only
   * ever change when a future phase explicitly promotes a family AND wires
   * this evaluator to consult that promotion state.
   */
  production_numeric_influence: ProductionNumericInfluence;
}

/**
 * Independently-sourced ground truth about what NFL football has actually
 * happened -- NEVER derived from Football Intelligence itself, and NEVER a
 * provider's nominal "current week" counter. A caller who cannot supply this
 * (e.g. no schedule/result source available) should omit it; this evaluator
 * will not guess in its place.
 */
export interface NflRealityFrontier {
  season: number;
  /** highest NFL week for which at least one game has an authoritative final result. */
  latest_week_with_any_completed_game: number;
  completed_games_in_latest_week: number;
  scheduled_games_in_latest_week: number;
  /** the latest completed game's own date within that week, when the source provides one. */
  latest_completed_game_date: string | null;
  as_of: string;
}

export interface IntelligenceFreshnessRequest {
  lineage: RecommendationLineage;
  operation: IntelligenceOperation;
  nfl_reality?: NflRealityFrontier;
  /** a previously-observed FI lineage, to distinguish source regression from ordinary lag. */
  previous_football_intelligence?: FootballIntelligenceLineage | null;
  expected_league_id?: string;
  expected_season?: number;
  /** set true for a deliberate historical/ROS analysis where FI's season legitimately differs from the live snapshot's season. */
  allow_historical_football_intelligence?: boolean;
  /** clock injection for deterministic tests -- epoch ms. Defaults to `Date.now()`. */
  now?: number;
}

export interface IntelligenceFreshnessAssessment {
  freshness_policy_version: string;
  operation: IntelligenceOperation;
  overall_status: OverallFreshnessStatus;
  /** whether the FI-derived evidence assessed here is usable at all (false only for INCOMPATIBLE). Never a verdict on the production baseline -- see module doc. */
  usable: boolean;
  confidence_cap: ConfidenceCap | null;
  /** true when a caller that intended to present FI-informed output for this operation must fall back to the non-FI baseline instead. */
  fallback_required: boolean;
  reasons: FreshnessReason[];
  feature_families: FeatureFamilyStatus[];
  prohibited_features: IntelligenceFeatureFamily[];
  lineage: RecommendationLineage;
  /** the independent ground truth this assessment was judged against, exactly as supplied -- `null` if the caller supplied none. Passed through so a formatter never has to be handed a second copy. */
  nfl_reality: NflRealityFrontier | null;
}

// ---------------------------------------------------------------------------
// operation materiality: how much a stale/degraded FI signal should matter
// ---------------------------------------------------------------------------
type FiMateriality = "NOT_USED" | "LOW" | "HIGH";
const OPERATION_FI_MATERIALITY: Record<IntelligenceOperation, FiMateriality> = {
  // Per the Checkpoint A audit: production Start/Sit and Waiver do not
  // consume FI at all today. A stale FI shadow signal must not invalidate
  // their baseline -- it only degrades what the shadow layer itself reports.
  START_SIT: "LOW",
  WAIVER: "LOW",
  ROSTER_PLANNING: "LOW",
  // Trades' provider seam is null-wired; FI is architecturally not used.
  TRADE: "NOT_USED",
  // A matchup analysis that presents FI-derived opponent intelligence must
  // treat staleness as material -- this is the one operation where "old FI
  // presented as current" would be a real, user-facing correctness bug.
  MATCHUP: "HIGH",
  ANALYSIS_ONLY: "LOW",
};

// ---------------------------------------------------------------------------
// FI raw-source -> feature-family mapping (mirrors fetch_raw.R's own
// per-source availability tracking -- see FI$EXPECTED_SOURCES, config.R)
// ---------------------------------------------------------------------------
const RAW_SOURCE_FAMILY: Record<string, IntelligenceFeatureFamily> = {
  pbp: "PBP_TEAM_EFFICIENCY",
  participation: "ROUTE_PARTICIPATION",
  snap_counts: "SNAP_COUNTS",
  pfr_pass: "PFR_PRESSURE",
  pfr_def: "PFR_PRESSURE",
  pfr_rec: "PFR_PRESSURE",
  pfr_rush: "PFR_PRESSURE",
  ngs_passing: "NGS",
  ngs_rushing: "NGS",
  ngs_receiving: "NGS",
  ftn_charting: "FTN_DESCRIPTIVE",
};

/** Derived FI output tables inherit the worst status of the raw sources they're built from. */
const DERIVED_FAMILY_DEPENDENCIES: Partial<Record<IntelligenceFeatureFamily, string[]>> = {
  PLAYER_USAGE: ["pbp", "participation", "snap_counts"],
  COVERAGE_UNIT_PROFILES: ["pbp"],
  CONTEXTUAL_MATCHUP: ["pbp"],
};

const LAG_SEVERITY_RANK: Record<FeatureFamilyLagClassification, number> = {
  AT_CUTOFF: 0,
  EXPECTED_SOURCE_LAG: 1,
  UNAVAILABLE: 1,
  NOT_APPLICABLE: 0,
  BROKEN_OR_MISSING_DATA: 2,
};

function classifySource(
  source: string,
  fi: FootballIntelligenceLineage,
  previous: FootballIntelligenceLineage | null | undefined,
): { classification: FeatureFamilyLagClassification; cutoffWeek: number | null; lagWeeks: number | null } {
  const cutoffWeek = fi.data_cutoff[source] ?? null;
  const prevCutoff =
    previous && previous.season === fi.season ? previous.data_cutoff[source] ?? null : null;

  if (prevCutoff != null && (cutoffWeek == null || cutoffWeek < prevCutoff)) {
    return { classification: "BROKEN_OR_MISSING_DATA", cutoffWeek, lagWeeks: null };
  }
  if (cutoffWeek == null) {
    return { classification: "UNAVAILABLE", cutoffWeek: null, lagWeeks: null };
  }
  const lag = fi.through_week - cutoffWeek;
  return { classification: lag > 0 ? "EXPECTED_SOURCE_LAG" : "AT_CUTOFF", cutoffWeek, lagWeeks: lag };
}

function buildFeatureFamilyStatuses(
  fi: FootballIntelligenceLineage | null,
  previous: FootballIntelligenceLineage | null | undefined,
): FeatureFamilyStatus[] {
  return INTELLIGENCE_FEATURE_FAMILIES.map((family): FeatureFamilyStatus => {
    if (family === "LEAGUE_STATE" || family === "SCORING" || family === "SCHEDULE") {
      // Owned by the canonical snapshot / scoring / schedule layers, not FI.
      // Phase 1 does not yet independently assess these here (see risks in
      // the audit doc) -- reported NOT_APPLICABLE rather than a fabricated verdict.
      return {
        family,
        availability: "NOT_APPLICABLE",
        data_cutoff_week: null,
        lag_weeks: null,
        lag_classification: "NOT_APPLICABLE",
        predictive_eligibility: "UNKNOWN",
        production_numeric_influence: "NOT_APPLICABLE",
      };
    }
    if (!fi) {
      return {
        family,
        availability: "UNAVAILABLE",
        data_cutoff_week: null,
        lag_weeks: null,
        lag_classification: "NOT_APPLICABLE",
        predictive_eligibility: "UNKNOWN",
        production_numeric_influence: "PROHIBITED",
      };
    }

    const rawSources = DERIVED_FAMILY_DEPENDENCIES[family] ?? [
      Object.keys(RAW_SOURCE_FAMILY).find((s) => RAW_SOURCE_FAMILY[s] === family),
    ].filter((s): s is string => Boolean(s));

    const classified = rawSources.map((s) => classifySource(s, fi, previous));
    const worst = classified.reduce((a, b) =>
      LAG_SEVERITY_RANK[b.classification] > LAG_SEVERITY_RANK[a.classification] ? b : a,
    );
    const availability: FeatureFamilyAvailability =
      worst.classification === "UNAVAILABLE"
        ? "UNAVAILABLE"
        : worst.classification === "BROKEN_OR_MISSING_DATA"
          ? "PARTIAL"
          : "AVAILABLE";

    const isDescriptive = family === "FTN_DESCRIPTIVE";
    return {
      family,
      availability,
      data_cutoff_week: worst.cutoffWeek,
      lag_weeks: worst.lagWeeks,
      lag_classification: worst.classification,
      predictive_eligibility: isDescriptive
        ? "DESCRIPTIVE_ONLY"
        : availability === "UNAVAILABLE"
          ? "NOT_ELIGIBLE"
          : "PREDICTIVE_ELIGIBLE",
      // Every FI-backed family is PROHIBITED from production numeric
      // influence in Checkpoint B -- see the field's own doc comment.
      production_numeric_influence: "PROHIBITED",
    };
  });
}

function compareFiToReality(
  fi: FootballIntelligenceLineage,
  reality: NflRealityFrontier,
): { aheadOfReality: boolean; behindReality: boolean; weekGap: number; sameWeekGamesBehind: number } {
  if (fi.season !== reality.season) {
    return { aheadOfReality: false, behindReality: false, weekGap: 0, sameWeekGamesBehind: 0 };
  }
  const fiCompleted = fi.week_completion?.games_completed_in_latest_week ?? 0;
  const weekGap = reality.latest_week_with_any_completed_game - fi.through_week;
  if (weekGap < 0) {
    return { aheadOfReality: true, behindReality: false, weekGap, sameWeekGamesBehind: 0 };
  }
  if (weekGap === 0) {
    const gamesBehind = reality.completed_games_in_latest_week - fiCompleted;
    if (gamesBehind < 0) return { aheadOfReality: true, behindReality: false, weekGap: 0, sameWeekGamesBehind: 0 };
    return { aheadOfReality: false, behindReality: gamesBehind > 0, weekGap: 0, sameWeekGamesBehind: gamesBehind };
  }
  return { aheadOfReality: false, behindReality: true, weekGap, sameWeekGamesBehind: 0 };
}

export function assessIntelligenceFreshness(
  request: IntelligenceFreshnessRequest,
): IntelligenceFreshnessAssessment {
  const { lineage, operation } = request;
  const fi = lineage.football_intelligence;
  const materiality = OPERATION_FI_MATERIALITY[operation];
  const reasons: FreshnessReason[] = [];
  // A plain `let` here gets narrowed to its literal initializer type by
  // TS's control-flow analysis across the many conditional `escalate()`
  // calls below (a closure mutation doesn't reset that narrowing the way a
  // direct reassignment in the same lexical flow would). Wrapping it in an
  // object sidesteps the narrowing entirely -- every comparison below reads
  // the current, correctly-widened value.
  const state: { status: OverallFreshnessStatus } = { status: "CURRENT" };
  const STATUS_RANK: Record<OverallFreshnessStatus, number> = {
    CURRENT: 0,
    PARTIAL_CURRENT: 1,
    DEGRADED: 2,
    STALE: 3,
    INCOMPATIBLE: 4,
  };
  const escalate = (next: OverallFreshnessStatus) => {
    if (STATUS_RANK[next] > STATUS_RANK[state.status]) state.status = next;
  };

  // ---- compatibility checks (highest precedence, deterministic order) ----
  if (request.expected_league_id && lineage.snapshot.league_id !== request.expected_league_id) {
    reasons.push({
      code: "LEAGUE_MISMATCH",
      severity: "BLOCK",
      affects: ["LEAGUE_STATE"],
      detail: `snapshot league_id ${lineage.snapshot.league_id} !== expected ${request.expected_league_id}`,
    });
    escalate("INCOMPATIBLE");
  }
  if (request.expected_season != null && lineage.snapshot.season !== request.expected_season) {
    reasons.push({
      code: "SEASON_MISMATCH",
      severity: "BLOCK",
      affects: ["LEAGUE_STATE"],
      detail: `snapshot season ${lineage.snapshot.season} !== expected ${request.expected_season}`,
    });
    escalate("INCOMPATIBLE");
  }
  for (const p of lineage.projections) {
    if (p.scoring_fingerprint && p.scoring_fingerprint !== lineage.snapshot.scoring_fingerprint) {
      reasons.push({
        code: "SCORING_FINGERPRINT_MISMATCH",
        severity: "BLOCK",
        affects: ["SCORING"],
        detail: `projection ${p.source} scoring_fingerprint ${p.scoring_fingerprint} !== snapshot ${lineage.snapshot.scoring_fingerprint}`,
      });
      escalate("INCOMPATIBLE");
    }
    if (p.status === "UNAVAILABLE") {
      reasons.push({ code: "PROJECTION_UNAVAILABLE", severity: "WARN", affects: [p.role], detail: `${p.source} UNAVAILABLE` });
      escalate("DEGRADED");
    } else if (p.status === "UNRESOLVED") {
      reasons.push({ code: "PROJECTION_UNRESOLVED", severity: "WARN", affects: [p.role], detail: `${p.source} UNRESOLVED` });
      escalate("DEGRADED");
    }
  }
  // Two different things can make an FI season "not match" -- they must not
  // be conflated. (a) The CALLER wired the wrong FI/analysis pairing
  // together (e.g. asked for season X but got handed season Y's FI) -- a
  // wiring bug, INCOMPATIBLE, detected only against an explicit
  // `expected_season` the caller states it wants. (b) FI's own automation
  // is genuinely behind an entire season (the exact "NFL is in 2026, FI
  // still describes 2025" example from the audit) -- that is STALE, not
  // INCOMPATIBLE: the data is still self-consistent, just old, and the
  // whole point of a STALE verdict (vs. refusing to answer at all) is that
  // it's a normal, recoverable-once-the-refresh-catches-up state.
  if (
    fi &&
    request.expected_season != null &&
    fi.season !== request.expected_season &&
    !request.allow_historical_football_intelligence
  ) {
    reasons.push({
      code: "FI_SEASON_MISMATCH",
      severity: "BLOCK",
      affects: ["PBP_TEAM_EFFICIENCY", "PLAYER_USAGE"],
      detail: `FI season ${fi.season} !== expected_season ${request.expected_season} without allow_historical_football_intelligence`,
    });
    escalate("INCOMPATIBLE");
  }
  if (fi && fi.season > lineage.snapshot.season) {
    // FI describing a season beyond the live canonical snapshot's own
    // season is never legitimate -- future data, regardless of whether a
    // reality frontier was supplied.
    reasons.push({
      code: "FI_AHEAD_OF_REALITY",
      severity: "BLOCK",
      affects: ["PBP_TEAM_EFFICIENCY"],
      detail: `FI season ${fi.season} is ahead of the live snapshot's season ${lineage.snapshot.season} -- impossible/future data`,
    });
    escalate("INCOMPATIBLE");
  }
  if (fi && request.nfl_reality && fi.season === request.nfl_reality.season) {
    const cmp = compareFiToReality(fi, request.nfl_reality);
    if (cmp.aheadOfReality) {
      reasons.push({
        code: "FI_AHEAD_OF_REALITY",
        severity: "BLOCK",
        affects: ["PBP_TEAM_EFFICIENCY"],
        detail: `FI claims through_week ${fi.through_week} with ${fi.week_completion?.games_completed_in_latest_week ?? "?"} completed games, ahead of the supplied reality frontier (w${request.nfl_reality.latest_week_with_any_completed_game}, ${request.nfl_reality.completed_games_in_latest_week} completed) -- impossible/future data`,
      });
      escalate("INCOMPATIBLE");
    }
  }

  // ---- FI freshness dimension (only if not already INCOMPATIBLE) --------
  if (state.status !== "INCOMPATIBLE") {
    if (!fi) {
      reasons.push({ code: "FI_NOT_USED", severity: "INFO", affects: [], detail: "lineage.football_intelligence is null: not consulted for this call" });
    } else if (fi.season < lineage.snapshot.season) {
      // Checked FIRST, independent of whether a reality frontier was
      // supplied: the live canonical snapshot's own season is itself a
      // trustworthy "what season is it really" signal. An entire season
      // behind is the audit's own STALE example -- self-consistent data,
      // just old, not a wiring error.
      reasons.push({
        code: "FI_SEASON_BEHIND_CURRENT",
        severity: "BLOCK",
        affects: ["PBP_TEAM_EFFICIENCY", "PLAYER_USAGE"],
        detail: `FI season ${fi.season} is behind the live snapshot's season ${lineage.snapshot.season}`,
      });
      escalate("STALE");
    } else if (request.nfl_reality && fi.season === request.nfl_reality.season) {
      const cmp = compareFiToReality(fi, request.nfl_reality);
      const nowMs = request.now ?? Date.now();
      const generatedMs = Date.parse(fi.generated_at);
      const hoursSinceFiRefresh = Number.isFinite(generatedMs) ? (nowMs - generatedMs) / 3_600_000 : null;
      const withinExpectedLagWindow = hoursSinceFiRefresh != null && hoursSinceFiRefresh <= FI_REFRESH_CADENCE_HOURS + FI_REFRESH_LAG_BUFFER_HOURS;

      // True schedule incompatibility: the two sources disagree about how
      // MANY games are even scheduled for the same week -- not a timing
      // question at all, so it's checked before the completed-count gap.
      const fiWc = fi.week_completion;
      if (fiWc && fiWc.latest_week === request.nfl_reality.latest_week_with_any_completed_game && fiWc.games_scheduled_in_latest_week !== request.nfl_reality.scheduled_games_in_latest_week) {
        reasons.push({
          code: "SCHEDULE_SOURCE_CONFLICT",
          severity: "BLOCK",
          affects: ["SCHEDULE", "PBP_TEAM_EFFICIENCY"],
          detail: `week ${fiWc.latest_week}: FI (nflverse) reports ${fiWc.games_scheduled_in_latest_week} scheduled games, runtime frontier (Sleeper) reports ${request.nfl_reality.scheduled_games_in_latest_week} -- the two schedule sources disagree`,
        });
        escalate("INCOMPATIBLE");
      } else if (cmp.behindReality && cmp.weekGap > 0) {
        reasons.push({
          code: withinExpectedLagWindow ? "FI_PUBLICATION_LAG_POSSIBLE" : "FI_BEHIND_CONFIRMED_COMPLETED_GAME",
          severity: withinExpectedLagWindow ? "WARN" : "BLOCK",
          affects: ["PBP_TEAM_EFFICIENCY", "PLAYER_USAGE"],
          detail:
            `FI through_week ${fi.through_week} is ${cmp.weekGap} week(s) behind the runtime frontier's last completed week (w${request.nfl_reality.latest_week_with_any_completed_game}); ` +
            (hoursSinceFiRefresh != null
              ? `FI last refreshed ${hoursSinceFiRefresh.toFixed(1)}h ago (cadence ${FI_REFRESH_CADENCE_HOURS}h + ${FI_REFRESH_LAG_BUFFER_HOURS}h buffer)`
              : "FI's generated_at could not be parsed"),
        });
        escalate(withinExpectedLagWindow ? "DEGRADED" : "STALE");
      } else if (cmp.behindReality && cmp.sameWeekGamesBehind > 0) {
        reasons.push({
          code: withinExpectedLagWindow ? "FI_PUBLICATION_LAG_POSSIBLE" : "FI_BEHIND_CONFIRMED_COMPLETED_GAME",
          severity: withinExpectedLagWindow ? "INFO" : "BLOCK",
          affects: ["PBP_TEAM_EFFICIENCY", "PLAYER_USAGE"],
          detail:
            `FI has captured ${fi.week_completion?.games_completed_in_latest_week ?? 0} of ${request.nfl_reality.completed_games_in_latest_week} completed week-${fi.through_week} games; ` +
            (hoursSinceFiRefresh != null
              ? `FI last refreshed ${hoursSinceFiRefresh.toFixed(1)}h ago (cadence ${FI_REFRESH_CADENCE_HOURS}h + ${FI_REFRESH_LAG_BUFFER_HOURS}h buffer)`
              : "FI's generated_at could not be parsed"),
        });
        escalate(withinExpectedLagWindow ? "PARTIAL_CURRENT" : "STALE");
      } else if (fi.week_completion?.week_state === "COMPLETE") {
        reasons.push({ code: "FI_CURRENT", severity: "INFO", affects: [], detail: `FI matches the reality frontier and week ${fi.through_week} is COMPLETE` });
      } else {
        reasons.push({ code: "FI_PARTIAL_CURRENT", severity: "INFO", affects: [], detail: `FI matches the reality frontier; week ${fi.through_week} is PARTIAL (${fi.week_completion?.games_completed_in_latest_week ?? 0}/${fi.week_completion?.games_scheduled_in_latest_week ?? "?"})` });
        escalate("PARTIAL_CURRENT");
      }
    } else if (!request.nfl_reality) {
      // No independent frontier: report FI's own self-described state
      // honestly, without claiming a cross-checked verdict.
      reasons.push({ code: "NO_INDEPENDENT_FRONTIER", severity: "INFO", affects: [], detail: "no NflRealityFrontier supplied; FI's own week_completion is reported uncross-checked" });
      if (!fi.week_completion) {
        reasons.push({ code: "NO_WEEK_COMPLETION_METADATA", severity: "WARN", affects: ["PBP_TEAM_EFFICIENCY"], detail: "manifest predates week_completion" });
        escalate("DEGRADED");
      } else if (fi.week_completion.week_state === "COMPLETE") {
        reasons.push({ code: "FI_CURRENT", severity: "INFO", affects: [], detail: `FI reports week ${fi.through_week} COMPLETE (uncross-checked)` });
      } else {
        reasons.push({ code: "FI_PARTIAL_CURRENT", severity: "INFO", affects: [], detail: `FI reports week ${fi.through_week} PARTIAL (uncross-checked)` });
        escalate("PARTIAL_CURRENT");
      }
    }
  }

  // ---- feature-family statuses (independent per family, always computed) ----
  const featureFamilies = buildFeatureFamilyStatuses(fi, request.previous_football_intelligence);
  for (const f of featureFamilies) {
    if (f.lag_classification === "BROKEN_OR_MISSING_DATA") {
      reasons.push({ code: "SOURCE_REGRESSED", severity: "BLOCK", affects: [f.family], detail: `${f.family} cutoff regressed vs the previously-observed FI lineage` });
      escalate("STALE");
    } else if (f.lag_classification === "EXPECTED_SOURCE_LAG") {
      reasons.push({ code: "SOURCE_EXPECTED_LAG", severity: "INFO", affects: [f.family], detail: `${f.family} is ${f.lag_weeks} week(s) behind through_week -- expected lag, not a failure` });
    } else if (f.lag_classification === "UNAVAILABLE" && fi) {
      reasons.push({ code: "SOURCE_UNAVAILABLE_FOR_SEASON", severity: "INFO", affects: [f.family], detail: `${f.family} has no rows for season ${fi.season} yet` });
    }
    if (f.predictive_eligibility === "DESCRIPTIVE_ONLY") {
      reasons.push({ code: "DESCRIPTIVE_ONLY_FAMILY", severity: "INFO", affects: [f.family], detail: `${f.family} is DESCRIPTIVE_ONLY -- never eligible for numeric/predictive use regardless of freshness` });
    }
  }

  // ---- confidence cap + fallback, scaled by operation materiality --------
  let confidenceCap: ConfidenceCap | null = null;
  let fallbackRequired = false;
  if (state.status === "INCOMPATIBLE") {
    confidenceCap = "INSUFFICIENT_SAMPLE";
    fallbackRequired = true;
  } else if (materiality === "HIGH") {
    if (state.status === "STALE") {
      confidenceCap = "LOW";
      fallbackRequired = true;
    } else if (state.status === "DEGRADED" || state.status === "PARTIAL_CURRENT") {
      confidenceCap = "MEDIUM";
    }
  } else if (materiality === "LOW" && (state.status === "STALE" || state.status === "DEGRADED")) {
    // Non-material operations (Waiver, Start/Sit baseline, ROSTER_PLANNING,
    // ANALYSIS_ONLY): a stale/degraded FI signal never forces a fallback --
    // there is nothing FI-derived in their production number to fall back
    // FROM -- but it's still worth a capped confidence note if a consumer
    // chooses to surface the shadow evidence at all.
    confidenceCap = "MEDIUM";
  }

  const prohibited = Array.from(
    new Set(
      featureFamilies
        .filter((f) => f.production_numeric_influence === "PROHIBITED" || f.predictive_eligibility === "DESCRIPTIVE_ONLY")
        .map((f) => f.family),
    ),
  );

  return {
    freshness_policy_version: FRESHNESS_POLICY_VERSION,
    operation,
    overall_status: state.status,
    usable: state.status !== "INCOMPATIBLE",
    confidence_cap: confidenceCap,
    fallback_required: fallbackRequired,
    reasons,
    feature_families: featureFamilies,
    prohibited_features: prohibited,
    lineage,
    nfl_reality: request.nfl_reality ?? null,
  };
}

/** Human-readable summary, generated from the typed assessment -- never hand-formatted by a caller. */
export function summarizeIntelligenceFreshness(
  assessment: IntelligenceFreshnessAssessment,
  opts: { deployment_active?: boolean } = {},
): string {
  const lines: string[] = [];
  const snap = assessment.lineage.snapshot;
  lines.push(`League state: ${snap.league_snapshot_id}`);
  const fi = assessment.lineage.football_intelligence;
  if (fi) {
    const wc = fi.week_completion;
    lines.push(
      `Football Intelligence: ${assessment.overall_status} -- ${fi.version}` +
        (wc ? ` (w${wc.latest_week} ${wc.week_state}, ${wc.games_completed_in_latest_week}/${wc.games_scheduled_in_latest_week} games)` : ""),
    );
    if (assessment.nfl_reality) {
      const r = assessment.nfl_reality;
      lines.push(
        `Latest completed NFL frontier: Week ${r.latest_week_with_any_completed_game} -- ${r.completed_games_in_latest_week}/${r.scheduled_games_in_latest_week}`,
      );
    }
    for (const f of assessment.feature_families) {
      if (f.availability === "NOT_APPLICABLE") continue;
      lines.push(
        `  ${f.family}: ${f.lag_classification}` +
          (f.data_cutoff_week != null ? ` (w${f.data_cutoff_week})` : "") +
          (f.predictive_eligibility === "DESCRIPTIVE_ONLY" ? " -- DESCRIPTIVE_ONLY" : ""),
      );
    }
    lines.push(`FI production influence: ${opts.deployment_active ? "ACTIVE" : "DISALLOWED"}`);
  } else {
    lines.push("Football Intelligence: NOT_USED");
  }
  lines.push(`Freshness policy: ${assessment.freshness_policy_version}`);
  const engines = Object.entries(assessment.lineage.engine_versions);
  if (engines.length > 0) {
    lines.push(`Recommendation: ${engines.map(([k, v]) => `${k}:${v}`).join(", ")}`);
  }
  lines.push(
    `Overall: ${assessment.overall_status} / ${assessment.usable ? "usable" : "not usable"}` +
      (assessment.confidence_cap ? ` (confidence capped ${assessment.confidence_cap})` : ""),
  );
  return lines.join("\n");
}
