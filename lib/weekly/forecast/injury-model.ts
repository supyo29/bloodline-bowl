/**
 * W1.P2 — injury-aware expected value. Pure, deterministic, provider-neutral.
 *
 * Separates five things that W1.P1 deliberately left fused:
 *   1. what the provider REPORTED (`source_status`, kept verbatim)            -> never overwritten
 *   2. how Bloodline INTERPRETS it (`normalized_state`, `availability_state`)
 *   3. P(active)                                                              -> participation
 *   4. workload if active                                                     -> NOT folded into P(active)
 *   5. whether the SOURCE projection already embeds injury risk               -> double-counting guard
 *
 * One formula covers every source-semantics case. Let P = P(active), w = workload if active, and λ the fraction of the
 * injury discount the source is believed to ALREADY embed (0 = source is conditional-on-active, 1 = unconditional):
 *
 *     m_s            = 1 - λ(1 - P)          (the multiplier already inside the source)
 *     conditional    = source / m_s          (value if active)
 *     expected       = conditional × P × w   = source × (P / m_s) × w
 *
 * λ=0 -> expected = source·P·w;   λ=1 -> expected = source·w (no second discount);   0<λ<1 -> only the REMAINING risk is applied.
 *
 * Known-unavailable (Out / IR / PUP / NFI / SUS / DNR / official inactive) resolve to a known zero regardless of λ.
 * HEALTHY is the identity. An unrecognised status is NOT guessed at: no discount, degraded confidence.
 *
 * Nothing here is an empirically certified model: P(active) is a PROVISIONAL prior fitted to one season of public data,
 * workload has INSUFFICIENT data to justify a default discount, and the source semantics of the current provider are
 * UNKNOWN (cannot be established offline). Those states are reported on every result.
 */

import {
  DOUBTFUL_PARENT_MEAN,
  INJURY_PRIOR_COUNTS,
  INJURY_PRIOR_VERSION,
  RELEVANT_SOURCE_POINTS,
  SHRINKAGE_K,
  type Counts,
  type InjuryPriorCounts,
  type Practice,
  type RoleTier,
} from "./injury-priors";

export const INJURY_MODEL_VERSION = "injury-expected-value-2026.1" as const;

/** Fraction of the injury discount assumed already embedded when source semantics are UNKNOWN. A maximum-uncertainty midpoint, NOT an estimate. */
export const UNKNOWN_SEMANTICS_EMBEDDED_FRACTION = 0.5;

/**
 * Whether a provider's weekly projection already embeds injury risk. Registered per `WeeklyProjectionBatch.source`.
 *
 * `sleeper_weekly` is UNKNOWN and this cannot be established offline: the provider scores RotoWire stat lines without any injury
 * logic of its own, live Sleeper is unreachable from the build sandbox, and no stored history of source projections exists. Do
 * not change this entry without evidence (e.g. matchup2 capture rows pairing the baseline projection with its injury status).
 */
export const SOURCE_INJURY_SEMANTICS: Readonly<Record<string, SourceInjurySemantics>> = {
  sleeper_weekly: "UNKNOWN",
};

export type SourceInjurySemantics = "CONDITIONAL_ON_ACTIVE" | "UNCONDITIONAL" | "PARTIALLY_ADJUSTED" | "UNKNOWN";

export type NormalizedInjuryState =
  | "HEALTHY"
  | "QUESTIONABLE"
  | "DOUBTFUL"
  | "OUT"
  | "INJURED_RESERVE"
  /** PUP / NFI / suspended / did-not-report: structurally unavailable lists. */
  | "UNAVAILABLE_LIST"
  | "OFFICIAL_INACTIVE"
  | "OFFICIAL_ACTIVE"
  | "UNKNOWN_STATUS"
  | "NOT_APPLICABLE";

export type AvailabilityState = "AVAILABLE" | "AT_RISK" | "UNAVAILABLE" | "UNKNOWN";

export type InjuryMode = "NOT_APPLIED" | "SHADOW" | "PRODUCTION";

export type CalibrationState =
  | "NOT_APPLICABLE"
  /** Fitted to public data and checked on a held-out window, but single-season / small sample: provisional. */
  | "PRODUCTION_PROVISIONAL_PRIOR"
  | "INSUFFICIENT_DATA"
  /** Assumed, not measured. */
  | "ASSUMED_UNVALIDATED";

export type ExpectedBasisFromInjury =
  | "SOURCE_PROJECTION"
  | "CONDITIONAL_ACTIVE_X_AVAILABILITY"
  | "SOURCE_ALREADY_INJURY_ADJUSTED"
  | "SOURCE_WITH_PARTIAL_INJURY_ADJUSTMENT"
  | "SOURCE_WITH_LIMITED_WORKLOAD_ADJUSTMENT"
  | "UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT"
  | "OFFICIAL_UNAVAILABLE_KNOWN_ZERO";

export interface InjuryEvidence {
  /** Provider's own injury designation, verbatim. null = provider reported none. */
  source_status: string | null;
  /** Canonical-player status, used only when the provider row carries none. */
  fallback_status?: string | null;
  /** false when the provider has no injury field at all (then absence is NOT "healthy"). Default true. */
  source_provides_injury_data?: boolean;
  position: string | null;
  is_team_defense?: boolean;
  /** Source projection (conditional or not per semantics). Used as a role-relevance proxy when no explicit tier is given. */
  source_points: number | null;
  role_tier?: RoleTier | null;
  practice?: Practice | null;
  /** Authoritative game-day evidence. */
  official_inactive?: boolean | null;
  official_active?: boolean | null;
  returning_from_injury?: boolean | null;
  /** Explicit workload evidence (e.g. snap-count restriction reported). Nothing derives this from status alone. */
  expected_workload?: { fraction: number; lower?: number; upper?: number; reason?: string } | null;
  /** When the evidence was observed, if the provider says. Never invented. */
  observed_at?: string | null;
  source_semantics?: SourceInjurySemantics;
  assumed_embedded_fraction?: number;
  mode?: InjuryMode;
}

export interface InjuryModelResult {
  model_version: typeof INJURY_MODEL_VERSION;
  prior_version: typeof INJURY_PRIOR_VERSION;
  mode: InjuryMode;
  /** Exactly what the provider reported. */
  source_status: string | null;
  normalized_state: NormalizedInjuryState;
  availability_state: AvailabilityState;
  probability_active: number | null;
  workload_if_active: { expected_fraction: number | null; lower_bound: number | null; upper_bound: number | null; basis: string };
  source_projection_injury_semantics: SourceInjurySemantics;
  /** λ actually used (null when no discount math ran). */
  embedded_fraction_assumed: number | null;
  conditional_active_points: number | null;
  injury_adjusted_expected_points: number | null;
  /** Points added on top of the source value (negative = discount). Reconciles to the two component deltas. */
  adjustment_points: number;
  availability_delta: number;
  workload_delta: number;
  basis: ExpectedBasisFromInjury;
  /** Evidence strength in [0,1]. NOT a calibrated probability. */
  confidence: number | null;
  confidence_components: { status_support: number | null; semantics_certainty: number };
  calibration: { availability: CalibrationState; workload: CalibrationState; source_semantics: CalibrationState };
  evidence: {
    role_tier: RoleTier | null;
    role_tier_basis: "EXPLICIT" | "SOURCE_POINTS_PROXY" | "UNKNOWN" | null;
    practice: Practice | null;
    official_inactive: boolean | null;
    official_active: boolean | null;
    returning_from_injury: boolean | null;
    observed_at: string | null;
    prior_cell: string | null;
    prior_n: number | null;
  };
  reasons: string[];
  warnings: string[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;
const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Provider-neutral status normalisation. Unrecognised strings are UNKNOWN_STATUS, never "healthy". */
export function normalizeInjuryStatus(raw: string | null | undefined): NormalizedInjuryState {
  const s = (raw ?? "").trim().toLowerCase().replace(/[._]/g, " ");
  if (s === "" || s === "active" || s === "healthy" || s === "probable") return "HEALTHY";
  if (s === "questionable" || s === "q") return "QUESTIONABLE";
  if (s === "doubtful" || s === "d") return "DOUBTFUL";
  if (s === "out" || s === "o") return "OUT";
  if (s === "ir" || s === "injured reserve" || s === "reserve" || s === "ir r" || s === "ir dfr") return "INJURED_RESERVE";
  if (s === "pup" || s === "pup r" || s === "pup p" || s === "nfi" || s === "nfi r" || s === "sus" || s === "suspended" || s === "dnr") {
    return "UNAVAILABLE_LIST";
  }
  return "UNKNOWN_STATUS";
}

/** [n, active] -> shrunk probability with the parent as the prior mean. */
export function shrink(c: Counts, parentMean: number, k: number = SHRINKAGE_K): number {
  return (c[1] + k * parentMean) / (c[0] + k);
}

function questionableP(
  priors: InjuryPriorCounts,
  tier: RoleTier | null,
  practice: Practice | null,
): { p: number; cell: string; n: number } {
  const q = priors.questionable;
  const pooledP = q.pooled[0] > 0 ? q.pooled[1] / q.pooled[0] : 0.5; // an empty prior table falls back to a coin flip, never to 1
  if (!tier) return { p: pooledP, cell: "QUESTIONABLE/pooled", n: q.pooled[0] };
  const tierP = shrink(q.tier[tier], pooledP);
  if (!practice) return { p: tierP, cell: `QUESTIONABLE/${tier}`, n: q.tier[tier][0] };
  const c = q.cell[tier][practice];
  return { p: shrink(c, tierP), cell: `QUESTIONABLE/${tier}/${practice}`, n: c[0] };
}

function embeddedFraction(e: InjuryEvidence): { semantics: SourceInjurySemantics; lambda: number; assumed: boolean } {
  const semantics = e.source_semantics ?? "UNKNOWN";
  if (semantics === "CONDITIONAL_ON_ACTIVE") return { semantics, lambda: 0, assumed: false };
  if (semantics === "UNCONDITIONAL") return { semantics, lambda: 1, assumed: false };
  const lam = clamp(e.assumed_embedded_fraction ?? UNKNOWN_SEMANTICS_EMBEDDED_FRACTION, 0, 1);
  return { semantics, lambda: lam, assumed: true };
}

export function evaluateInjuryModel(e: InjuryEvidence, priors: InjuryPriorCounts = INJURY_PRIOR_COUNTS): InjuryModelResult {
  const mode: InjuryMode = e.mode ?? "PRODUCTION";
  const reasons: string[] = [];
  const warnings: string[] = [];
  const src = e.source_points;
  // the designation actually used, verbatim: the provider row's status, else the canonical player's (also provider-reported)
  const designation = e.source_status ?? e.fallback_status ?? null;
  const rawStatus = designation;
  const { semantics, lambda, assumed } = embeddedFraction(e);

  const empty = (
    state: NormalizedInjuryState,
    avail: AvailabilityState,
    basis: ExpectedBasisFromInjury,
    why: string,
    over: Partial<InjuryModelResult> = {},
  ): InjuryModelResult => ({
    model_version: INJURY_MODEL_VERSION,
    prior_version: INJURY_PRIOR_VERSION,
    mode,
    source_status: rawStatus,
    normalized_state: state,
    availability_state: avail,
    probability_active: null,
    workload_if_active: { expected_fraction: null, lower_bound: null, upper_bound: null, basis: "NOT_MODELED" },
    source_projection_injury_semantics: semantics,
    embedded_fraction_assumed: null,
    conditional_active_points: src,
    injury_adjusted_expected_points: src,
    adjustment_points: 0,
    availability_delta: 0,
    workload_delta: 0,
    basis,
    confidence: null,
    confidence_components: { status_support: null, semantics_certainty: 1 },
    calibration: { availability: "NOT_APPLICABLE", workload: "NOT_APPLICABLE", source_semantics: "NOT_APPLICABLE" },
    evidence: {
      role_tier: null,
      role_tier_basis: null,
      practice: e.practice ?? null,
      official_inactive: e.official_inactive ?? null,
      official_active: e.official_active ?? null,
      returning_from_injury: e.returning_from_injury ?? null,
      observed_at: e.observed_at ?? null,
      prior_cell: null,
      prior_n: null,
    },
    reasons: [why, ...reasons],
    warnings,
    ...over,
  });

  // A team defense is a team entity: never run an individual injury model on it.
  if (e.is_team_defense || (e.position ?? "").toUpperCase() === "DEF" || (e.position ?? "").toUpperCase() === "DST") {
    return empty("NOT_APPLICABLE", "AVAILABLE", "SOURCE_PROJECTION", "TEAM_DEFENSE_NOT_AN_INDIVIDUAL_INJURY_ENTITY", {
      confidence: 1,
      probability_active: null,
    });
  }

  // Provider without an injury field: absence of a status is not evidence of health.
  if (e.source_provides_injury_data === false && !designation && e.official_inactive == null && e.official_active == null) {
    warnings.push("SOURCE_PROVIDES_NO_INJURY_DATA");
    return empty("UNKNOWN_STATUS", "UNKNOWN", "UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT", "NO_INJURY_FIELD_FROM_SOURCE", { confidence: 0.5 });
  }

  const normalized = e.official_inactive === true ? "OFFICIAL_INACTIVE" : e.official_active === true ? "OFFICIAL_ACTIVE" : normalizeInjuryStatus(designation);
  const isKicker = (e.position ?? "").toUpperCase() === "K";

  // ---- known unavailable -> known zero (explicit zero; source value stays visible via source_points) -------------------
  const unavailable = normalized === "OFFICIAL_INACTIVE" || normalized === "OUT" || normalized === "INJURED_RESERVE" || normalized === "UNAVAILABLE_LIST";
  if (unavailable) {
    const why =
      normalized === "OFFICIAL_INACTIVE"
        ? "OFFICIAL_GAME_DAY_INACTIVE"
        : normalized === "OUT"
          ? "DESIGNATION_OUT_RESOLVES_TO_KNOWN_ZERO"
          : "DESIGNATION_ON_UNAVAILABLE_LIST";
    const n = normalized === "OUT" ? priors.out[0] : null;
    const support = n == null ? 1 : n / (n + SHRINKAGE_K);
    const delta = src == null ? 0 : r2(0 - r2(src));
    return empty(normalized, "UNAVAILABLE", "OFFICIAL_UNAVAILABLE_KNOWN_ZERO", why, {
      probability_active: 0,
      workload_if_active: { expected_fraction: null, lower_bound: null, upper_bound: null, basis: "NOT_ACTIVE" },
      conditional_active_points: src,
      injury_adjusted_expected_points: 0, // known unavailable is a KNOWN zero even when the source never projected the player
      adjustment_points: delta,
      availability_delta: delta,
      confidence: r3(support),
      confidence_components: { status_support: r3(support), semantics_certainty: 1 },
      calibration: {
        availability: normalized === "OUT" ? "PRODUCTION_PROVISIONAL_PRIOR" : "NOT_APPLICABLE",
        workload: "NOT_APPLICABLE",
        source_semantics: "NOT_APPLICABLE",
      },
      evidence: {
        role_tier: null,
        role_tier_basis: null,
        practice: e.practice ?? null,
        official_inactive: e.official_inactive ?? null,
        official_active: e.official_active ?? null,
        returning_from_injury: e.returning_from_injury ?? null,
        observed_at: e.observed_at ?? null,
        prior_cell: normalized === "OUT" ? "OUT/pooled" : null,
        prior_n: n,
      },
    });
  }

  if (normalized === "UNKNOWN_STATUS") {
    warnings.push(`UNRECOGNISED_INJURY_STATUS:${rawStatus ?? designation}`);
    return empty("UNKNOWN_STATUS", "UNKNOWN", "UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT", "UNRECOGNISED_STATUS_NO_INVENTED_CERTAINTY", {
      confidence: 0.25,
      confidence_components: { status_support: 0, semantics_certainty: 0.5 },
    });
  }

  // ---- probability of participating -----------------------------------------------------------------------------------
  let p: number;
  let cell: string | null = null;
  let nCell: number | null = null;
  let tier: RoleTier | null = null;
  let tierBasis: "EXPLICIT" | "SOURCE_POINTS_PROXY" | "UNKNOWN" = "UNKNOWN";
  let availCal: CalibrationState = "PRODUCTION_PROVISIONAL_PRIOR";

  if (normalized === "HEALTHY" || normalized === "OFFICIAL_ACTIVE") {
    p = 1;
    availCal = "NOT_APPLICABLE";
    reasons.push(normalized === "OFFICIAL_ACTIVE" ? "OFFICIALLY_ACTIVE_NO_PARTICIPATION_RISK" : "NO_MATERIAL_INJURY_DESIGNATION");
  } else if (normalized === "DOUBTFUL") {
    p = shrink(priors.doubtful, DOUBTFUL_PARENT_MEAN);
    cell = "DOUBTFUL/pooled";
    nCell = priors.doubtful[0];
    if (isKicker) {
      availCal = "ASSUMED_UNVALIDATED";
      warnings.push("DOUBTFUL_PRIOR_EXTRAPOLATED_TO_KICKER_NO_KICKER_SAMPLE");
    }
  } else {
    // QUESTIONABLE
    if (isKicker) {
      // The injury sample contains no kickers; do not extrapolate a skill-position participation rate onto one.
      warnings.push("QUESTIONABLE_KICKER_NO_CALIBRATION_SAMPLE_NO_DISCOUNT");
      return empty("QUESTIONABLE", "AT_RISK", "UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT", "NO_CALIBRATION_SAMPLE_FOR_POSITION_K", {
        confidence: 0.25,
        confidence_components: { status_support: 0, semantics_certainty: 0.5 },
        calibration: { availability: "INSUFFICIENT_DATA", workload: "INSUFFICIENT_DATA", source_semantics: "ASSUMED_UNVALIDATED" },
      });
    }
    if (e.role_tier) {
      tier = e.role_tier;
      tierBasis = "EXPLICIT";
    } else if (src != null) {
      tier = src >= RELEVANT_SOURCE_POINTS ? "RELEVANT" : "FRINGE";
      tierBasis = "SOURCE_POINTS_PROXY";
    }
    const q = questionableP(priors, tier, e.practice ?? null);
    p = q.p;
    cell = q.cell;
    nCell = q.n;
    if (!e.practice) reasons.push("NO_PRACTICE_PARTICIPATION_EVIDENCE_USING_TIER_RATE");
    if (!tier) reasons.push("NO_ROLE_EVIDENCE_USING_POOLED_RATE");
  }
  p = clamp(p, 0, 1);

  // ---- workload if active (separate variable) -------------------------------------------------------------------------
  let wFrac = 1;
  let wLo: number | null = null;
  let wHi: number | null = null;
  let wBasis = "NO_WORKLOAD_EVIDENCE_NO_DISCOUNT";
  let workloadCal: CalibrationState = "INSUFFICIENT_DATA";
  if (e.expected_workload) {
    wFrac = clamp(e.expected_workload.fraction, 0, 1.25);
    wLo = e.expected_workload.lower ?? null;
    wHi = e.expected_workload.upper ?? null;
    wBasis = `EXPLICIT_EVIDENCE${e.expected_workload.reason ? `:${e.expected_workload.reason}` : ""}`;
    workloadCal = "ASSUMED_UNVALIDATED";
    reasons.push("EXPLICIT_WORKLOAD_EVIDENCE_APPLIED");
  } else if (normalized === "QUESTIONABLE" || normalized === "DOUBTFUL") {
    // Training evidence: snap share when active vs the player's own prior games has median ~0.97 and mean ~1.0 for Questionable.
    // That does not justify a default discount; carry the uncertainty as bounds instead.
    wLo = 0.75;
    wHi = 1.1;
    wBasis = "NO_DEFAULT_DISCOUNT_ACTIVE_QUESTIONABLE_SNAP_SHARE_MEDIAN_0.97_OF_PRIOR";
  } else if (e.returning_from_injury) {
    wBasis = "RETURNING_FROM_INJURY_NO_CALIBRATION_DATA_NO_DISCOUNT";
    warnings.push("RETURNING_FROM_INJURY_WORKLOAD_UNMODELED");
  }

  // ---- source-semantics guard + arithmetic ---------------------------------------------------------------------------
  const hasDiscountRisk = p < 1;
  const mS = 1 - lambda * (1 - p);
  let cond: number | null = src;
  let afterAvail: number | null = src;
  let basis: ExpectedBasisFromInjury = "SOURCE_PROJECTION";

  if (src != null) {
    if (!hasDiscountRisk) {
      cond = src;
      afterAvail = src;
    } else if (lambda >= 1) {
      // unconditional source: availability is ALREADY inside it — no second discount.
      cond = p >= 0.2 ? r2(src / p) : null;
      afterAvail = src;
      basis = "SOURCE_ALREADY_INJURY_ADJUSTED";
    } else {
      cond = r2(src / mS);
      afterAvail = src * (p / mS);
      basis = lambda === 0 ? "CONDITIONAL_ACTIVE_X_AVAILABILITY" : "SOURCE_WITH_PARTIAL_INJURY_ADJUSTMENT";
    }
  }
  const final = src == null ? null : afterAvail! * wFrac;
  if (src != null && wFrac !== 1) {
    basis = lambda >= 1 || basis === "SOURCE_PROJECTION" ? "SOURCE_WITH_LIMITED_WORKLOAD_ADJUSTMENT" : basis;
  }

  let a = 0;
  let dAvail = 0;
  let dWork = 0;
  let expected: number | null = null;
  if (src != null) {
    a = r2(src);
    const b = r2(afterAvail!);
    dAvail = r2(b - a);
    dWork = r2(r2(final!) - b);
    expected = r2(a + dAvail + dWork); // exact by construction: base + availability delta + workload delta
  }

  // ---- confidence: evidence strength, explicitly not a calibrated probability --------------------------------------
  const statusSupport = hasDiscountRisk && nCell != null ? nCell / (nCell + SHRINKAGE_K) : hasDiscountRisk ? 0 : 1;
  const semanticsCertainty = hasDiscountRisk && assumed ? 0.5 : 1;
  if (hasDiscountRisk && assumed) {
    warnings.push("SOURCE_INJURY_SEMANTICS_UNKNOWN_PARTIAL_DISCOUNT_ASSUMED");
    reasons.push(`SOURCE_ASSUMED_TO_EMBED_${Math.round(lambda * 100)}PCT_OF_INJURY_RISK`);
  }
  const confidence = r3(statusSupport * semanticsCertainty);
  if (e.returning_from_injury) reasons.push("RETURNING_FROM_INJURY");
  if (hasDiscountRisk) reasons.push(`${normalized}_P_ACTIVE_${r3(p)}`);

  const modeApplied = mode === "PRODUCTION";
  return {
    model_version: INJURY_MODEL_VERSION,
    prior_version: INJURY_PRIOR_VERSION,
    mode,
    source_status: rawStatus,
    normalized_state: normalized,
    availability_state: hasDiscountRisk ? "AT_RISK" : "AVAILABLE",
    probability_active: r3(p),
    workload_if_active: { expected_fraction: r3(wFrac), lower_bound: wLo, upper_bound: wHi, basis: wBasis },
    source_projection_injury_semantics: semantics,
    embedded_fraction_assumed: hasDiscountRisk ? lambda : null,
    conditional_active_points: cond,
    injury_adjusted_expected_points: expected,
    adjustment_points: r2(dAvail + dWork),
    availability_delta: dAvail,
    workload_delta: dWork,
    basis,
    confidence,
    confidence_components: { status_support: r3(statusSupport), semantics_certainty: semanticsCertainty },
    calibration: {
      availability: availCal,
      workload: workloadCal,
      source_semantics: hasDiscountRisk ? (assumed ? "ASSUMED_UNVALIDATED" : "PRODUCTION_PROVISIONAL_PRIOR") : "NOT_APPLICABLE",
    },
    evidence: {
      role_tier: tier,
      role_tier_basis: normalized === "QUESTIONABLE" ? tierBasis : null,
      practice: e.practice ?? null,
      official_inactive: e.official_inactive ?? null,
      official_active: e.official_active ?? null,
      returning_from_injury: e.returning_from_injury ?? null,
      observed_at: e.observed_at ?? null,
      prior_cell: cell,
      prior_n: nCell,
    },
    reasons,
    warnings: modeApplied ? warnings : [...warnings, "INJURY_MODEL_NOT_APPLIED_TO_EXPECTED_POINTS_SHADOW"],
  };
}
