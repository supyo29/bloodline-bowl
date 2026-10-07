/**
 * W1.P1 — the ONE authoritative construction path for `CanonicalWeeklyPlayerForecast`.
 *
 * Nothing else may assemble this object (pinned by `test/canonical-weekly-forecast-architecture.test.ts`).
 * Pure + deterministic: no wall clock, no I/O, no randomness. Ages come from the snapshot provenance the projection
 * provider already stamped on the batch.
 *
 * Input is the PRODUCTION-RESOLVED `WeeklyProjection` (i.e. after the context builder's authoritative-schedule bye
 * override). So `expected_points` is, by construction, exactly the value every current consumer already reads.
 */

import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../schema";
import { PROJECTION_SNAPSHOT_MAX_AGE_MS } from "../projections/canonical-snapshot";
import {
  SOURCE_INJURY_SEMANTICS,
  evaluateInjuryModel,
  type InjuryEvidence,
  type InjuryMode,
  type InjuryModelResult,
  type NormalizedInjuryState,
} from "./injury-model";
import {
  CANONICAL_WEEKLY_FORECAST_VERSION,
  type AvailabilityStatus,
  type CanonicalWeeklyForecastBatch,
  type CanonicalWeeklyPlayerForecast,
  type CertificationState,
  type ComponentMode,
  type ExpectedPointsBasis,
  type ForecastComponent,
  type ForecastContribution,
  type ForecastShadowSignals,
  type ForecastValueState,
  type ShadowSignalInput,
} from "./schema";

export const K_DST_FALLBACK_WARNING = "K_DST_SOURCE_USES_STANDARD_SCORING_FALLBACK";
export const FI_PRODUCTION_MARKER = "fi_production_adjustment_applied:";

type BatchMeta = Pick<
  WeeklyProjectionBatch,
  "status" | "source" | "model_version" | "teams_with_games" | "canonical_snapshot"
>;

export interface BuildForecastInput {
  canonical_player_id: string;
  season: number;
  week: number;
  /** Production-resolved row, or null when the batch has no entry for this player. */
  projection: WeeklyProjection | null;
  batch: BatchMeta;
  /** Canonical identity, when resolved. null/undefined with no projection -> PLAYER_NOT_FOUND. */
  player?: CanonicalPlayer | null;
  /**
   * The source value BEFORE the schedule-proven bye override replaced it (usually null: a bye team is absent from the feed).
   * Lets a bye keep its underlying value visible instead of collapsing to the compat zero.
   */
  bye_source_points?: number | null;
  shadow?: ForecastShadowSignals;
  /**
   * Extra injury evidence beyond the provider's own status (practice participation, official inactive/active, explicit workload,
   * returning-from-injury, role tier). Nothing in production supplies these yet; the model works without them.
   */
  injury?: Partial<InjuryEvidence>;
  /** PRODUCTION (default) applies the injury model to expected_points; SHADOW computes it and leaves expected_points alone. */
  injury_mode?: InjuryMode;
  /** Caller-supplied schedule facts, when an authoritative source has them. */
  game_status?: Partial<CanonicalWeeklyPlayerForecast["game_status"]> & { no_scheduled_game?: boolean };
}

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0; // + 0 normalizes -0
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4 + 0;

function isKdst(position: string | null): boolean {
  const p = (position ?? "").toUpperCase();
  return p === "K" || p === "DEF" || p === "DST";
}

function availabilityStatusOf(state: NormalizedInjuryState, isBye: boolean, known: boolean): AvailabilityStatus {
  if (isBye) return "BYE";
  if (!known) return "UNKNOWN";
  switch (state) {
    case "HEALTHY":
    case "OFFICIAL_ACTIVE":
    case "NOT_APPLICABLE":
      return "ACTIVE";
    case "QUESTIONABLE":
      return "QUESTIONABLE";
    case "DOUBTFUL":
      return "DOUBTFUL";
    case "OUT":
    case "OFFICIAL_INACTIVE":
      return "OUT";
    case "INJURED_RESERVE":
      return "INJURED_RESERVE";
    case "UNAVAILABLE_LIST":
      return "SUSPENDED_OR_OTHER";
    default:
      return "UNKNOWN"; // unrecognised status: never asserted as ACTIVE
  }
}

function classify(
  input: BuildForecastInput,
  hasPlayerResolved: boolean,
): { state: ForecastValueState; basis: ExpectedPointsBasis } {
  const p = input.projection;
  if (!p) {
    if (input.game_status?.no_scheduled_game) return { state: "NO_SCHEDULED_GAME", basis: "UNKNOWN" };
    if (!hasPlayerResolved) return { state: "PLAYER_NOT_FOUND", basis: "UNKNOWN" };
    if (input.batch.status === "PROJECTIONS_UNAVAILABLE") return { state: "SOURCE_FETCH_FAILURE", basis: "UNKNOWN" };
    return { state: "SOURCE_MISSING_PLAYER", basis: "UNKNOWN" };
  }
  if (p.is_bye || p.projection_status === "bye") return { state: "BYE_VERIFIED", basis: "BYE_COMPAT_ZERO" };
  if (p.projected_points == null) {
    if (p.projection_status === "out") return { state: "PLAYER_OUT_IN_SOURCE", basis: "UNKNOWN" };
    if (p.warnings.some((w) => w.startsWith("only_precomputed_totals"))) {
      return { state: "UNSUPPORTED_SCORING_DATA", basis: "UNKNOWN" };
    }
    if (p.projection_status === "unavailable") return { state: "PROJECTION_UNAVAILABLE", basis: "UNKNOWN" };
    return { state: "UNKNOWN", basis: "UNKNOWN" };
  }
  const fi = p.warnings.some((w) => w.startsWith(FI_PRODUCTION_MARKER));
  const basis: ExpectedPointsBasis = fi ? "SOURCE_PLUS_FI_PRODUCTION" : "SOURCE_PROJECTION";
  return { state: p.projected_points === 0 ? "KNOWN_ZERO_PROJECTION" : "PROJECTED", basis };
}

function component<T extends { adjustment_points: number }>(
  s: ShadowSignalInput<T> | undefined,
): ForecastComponent<T> {
  if (!s) return { mode: "NOT_APPLIED", signal: null };
  return { mode: s.mode as ComponentMode, signal: s.signal };
}

function sourceIds(player: CanonicalPlayer | null | undefined, batch: BatchMeta): Record<string, string> {
  const out: Record<string, string> = {};
  const ids = player?.identifiers ?? {};
  for (const k of ["sleeper_id", "yahoo_id", "yahoo_player_key", "espn_id", "gsis_id", "pfr_id"] as const) {
    const v = ids[k];
    if (v) out[k] = String(v);
  }
  if (batch.canonical_snapshot?.artifact_id) out.projection_snapshot_artifact_id = batch.canonical_snapshot.artifact_id;
  return out;
}

export function buildCanonicalWeeklyPlayerForecast(input: BuildForecastInput): CanonicalWeeklyPlayerForecast {
  const { projection: p, batch, player } = input;
  const resolved = Boolean(player) && player!.resolution.method !== "unresolved";
  const { state, basis } = classify(input, resolved || Boolean(p));
  const isBye = state === "BYE_VERIFIED";
  const kdst = isKdst(p?.position ?? player?.position ?? null);
  const warnings: string[] = [];

  // ---- value the injury model operates on (pre-injury) ---------------------------------------------
  // `source_points` is the provider's number; `preInjury` is what injury math multiplies. They differ only when an FI production
  // adjustment is already baked into the row (then the source is not recoverable).
  let sourcePoints: number | null = null;
  let preInjury: number | null = null;
  if (p) {
    if (isBye) {
      sourcePoints = input.bye_source_points ?? null;
      preInjury = p.projected_points ?? 0; // production compat value (0); see BYE_COMPAT_ZERO
      warnings.push("BYE_EXPECTED_POINTS_IS_COMPAT_ZERO_NOT_UNDERLYING_VALUE");
    } else if (basis === "SOURCE_PLUS_FI_PRODUCTION") {
      sourcePoints = null; // pre-adjustment value not recoverable from the post-adjustment row
      preInjury = p.projected_points;
      warnings.push("FI_PRODUCTION_ADJUSTMENT_PRESENT_SOURCE_POINTS_NOT_RECOVERABLE");
    } else {
      sourcePoints = p.projected_points;
      preInjury = p.projected_points;
    }
  }

  // ---- W1.P2 injury model ----------------------------------------------------------------------------
  const injuryMode: InjuryMode = isBye ? "NOT_APPLIED" : input.injury_mode ?? "PRODUCTION";
  const injury: InjuryModelResult = evaluateInjuryModel({
    source_status: p?.injury_status ?? null,
    fallback_status: player?.injury_status ?? null,
    position: p?.position ?? player?.position ?? null,
    is_team_defense: player?.is_team_defense ?? false,
    source_points: isBye ? sourcePoints : preInjury,
    source_semantics: SOURCE_INJURY_SEMANTICS[batch.source] ?? "UNKNOWN",
    ...input.injury,
    mode: injuryMode,
  });
  if (isBye) injury.reasons.push("BYE_STATE_NOT_ALTERED_BY_INJURY_PROCESSING");
  const applyInjury = injuryMode === "PRODUCTION";
  const knownUnavailable = injury.basis === "OFFICIAL_UNAVAILABLE_KNOWN_ZERO";
  const injuryChanged = applyInjury && (knownUnavailable || injury.availability_delta !== 0 || injury.workload_delta !== 0);

  let expected: number | null = null;
  let valueState: ForecastValueState = state;
  let expectedBasis: ExpectedPointsBasis = basis;
  if (isBye) {
    expected = preInjury; // compat zero, untouched by injury processing
  } else if (injuryChanged) {
    expected = injury.injury_adjusted_expected_points;
    expectedBasis = injury.basis;
    if (knownUnavailable) valueState = "KNOWN_UNAVAILABLE";
  } else {
    expected = preInjury; // bit-for-bit the pre-W1.P2 value (healthy players, shadow mode, unknown status)
    if (applyInjury && preInjury != null && injury.basis === "UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT") {
      expectedBasis = injury.basis;
    }
  }
  // conditional-active: the injury model's value-if-active. A bye keeps the source value (or null), never the compat 0.
  const conditionalActive = isBye ? sourcePoints : injury.conditional_active_points == null ? sourcePoints : injury.conditional_active_points;

  // ---- contributions ledger -----------------------------------------------------------------------
  const contributions: ForecastContribution[] = [];
  const shadowComputed: string[] = [];
  if (isBye) {
    if (preInjury != null) {
      if (sourcePoints != null) {
        contributions.push({ component: "BASE_PROJECTION", phenomenon: "BASE", points_delta: r2(sourcePoints), mode: "PRODUCTION", reason: "upstream source projection" });
      }
      contributions.push({
        component: "BYE_COMPAT_ZERO",
        phenomenon: "BYE",
        points_delta: r2(preInjury - (sourcePoints ?? 0)),
        mode: "PRODUCTION",
        reason: "verified bye: zero substituted so existing decision math is unchanged (W1.P3 replaces this)",
      });
    }
  } else if (preInjury != null) {
    if (basis === "SOURCE_PLUS_FI_PRODUCTION") {
      contributions.push({ component: "SOURCE_PLUS_FI_PRODUCTION", phenomenon: "BASE", points_delta: r2(preInjury), mode: "PRODUCTION", reason: "source projection with a production FI adjustment already applied (not separable here)" });
    } else {
      contributions.push({ component: "BASE_PROJECTION", phenomenon: "BASE", points_delta: r2(preInjury), mode: "PRODUCTION", reason: "upstream source projection" });
    }
  }

  const calib = injury.calibration;
  const why = (extra: string): string =>
    `${injury.normalized_state}` +
    `${injury.probability_active != null ? `; P(active)=${injury.probability_active}` : ""}` +
    `; semantics ${injury.source_projection_injury_semantics}` +
    `${injury.embedded_fraction_assumed != null ? ` (λ=${injury.embedded_fraction_assumed}${injury.confidence_components.semantics_certainty < 1 ? " assumed" : ""})` : ""}` +
    `; availability ${calib.availability}; ${extra}`;
  if (!isBye) {
    const entryMode = applyInjury ? "PRODUCTION" : "SHADOW";
    const wantsEntries = injury.availability_delta !== 0 || injury.workload_delta !== 0 || (knownUnavailable && preInjury == null);
    if (wantsEntries && injuryMode !== "NOT_APPLIED") {
      if (injury.availability_delta !== 0 || (knownUnavailable && preInjury == null)) {
        contributions.push({
          component: "INJURY_AVAILABILITY",
          phenomenon: "INJURY_AVAILABILITY",
          points_delta: injury.availability_delta,
          mode: entryMode,
          reason: why(knownUnavailable ? (preInjury == null ? "no source projection; unavailable resolves to known zero" : "unavailable resolves to known zero; source value retained in source_points") : "probability-of-playing discount"),
        });
        if (!applyInjury) shadowComputed.push("INJURY_AVAILABILITY");
      }
      if (injury.workload_delta !== 0) {
        contributions.push({
          component: "INJURY_WORKLOAD",
          phenomenon: "INJURY_WORKLOAD",
          points_delta: injury.workload_delta,
          mode: entryMode,
          reason: why(`workload if active ${injury.workload_if_active.expected_fraction} (${injury.workload_if_active.basis}); workload ${calib.workload}`),
        });
        if (!applyInjury) shadowComputed.push("INJURY_WORKLOAD");
      }
    } else if (injury.normalized_state !== "HEALTHY" && injury.normalized_state !== "NOT_APPLICABLE") {
      contributions.push({
        component: "AVAILABILITY_METADATA",
        phenomenon: "AVAILABILITY",
        points_delta: 0,
        mode: "INFORMATIONAL",
        reason: `${injury.normalized_state} recorded (${injury.reasons[0] ?? "no discount"}); no points applied`,
      });
    }
  }
  const sh = input.shadow ?? {};
  const addShadow = (
    sig: ShadowSignalInput<{ adjustment_points: number }> | undefined,
    name: string,
    phenomenon: ForecastContribution["phenomenon"],
  ): void => {
    if (!sig) return;
    contributions.push({
      component: name,
      phenomenon,
      points_delta: r2(sig.signal.adjustment_points),
      mode: sig.mode,
      reason: sig.reason ?? (sig.mode === "SHADOW" ? "computed in shadow; not applied to expected_points" : "informational; not applied to expected_points"),
    });
    shadowComputed.push(name);
  };
  addShadow(sh.role, "ROLE_CALIBRATION", "ROLE");
  addShadow(sh.environment, "GAME_ENVIRONMENT", "ENVIRONMENT");
  addShadow(sh.matchup, "MATCHUP_INTELLIGENCE", "MATCHUP");

  const injuryText = p?.injury_status ?? player?.injury_status ?? null;
  const known = Boolean(p) || Boolean(player);
  const status = availabilityStatusOf(injury.normalized_state, isBye, known);

  // ---- certification ------------------------------------------------------------------------------
  let cert: CertificationState;
  if (expected == null) cert = "UNAVAILABLE";
  else if (kdst || basis === "SOURCE_PLUS_FI_PRODUCTION") cert = "PARTIAL";
  else cert = "PRODUCTION";
  if (kdst && p) warnings.push(K_DST_FALLBACK_WARNING);
  if (valueState === "PLAYER_OUT_IN_SOURCE") warnings.push("SOURCE_REPORTS_NOT_PLAYING_GP_0_NO_VALUE_ASSERTED");
  if (!isBye) {
    for (const w of injury.warnings) warnings.push(w);
    // a value that rests on an assumed source-semantics fraction or an unrecognised status is not fully certified
    if (cert === "PRODUCTION" && (injury.normalized_state === "UNKNOWN_STATUS" || (injuryChanged && !knownUnavailable && injury.confidence_components.semantics_certainty < 1))) cert = "PARTIAL";
  }

  // ---- freshness ----------------------------------------------------------------------------------
  const snap = batch.canonical_snapshot;
  const age = snap?.age_ms ?? null;
  if (age != null && age > PROJECTION_SNAPSHOT_MAX_AGE_MS) {
    warnings.push("SOURCE_SNAPSHOT_STALE");
    if (cert === "PRODUCTION") cert = "PARTIAL";
  }

  // ---- uncertainty ----------------------------------------------------------------------------------
  // Source dispersion is for the player if active. With P(active)<1 the unconditional variance is the Bernoulli mixture:
  //   Var = P(σ² + μ²) − (Pμ)²,  μ = conditional-active × workload.
  const sigma = p && !isBye ? p.std_dev : null;
  const reasons: string[] = [];
  if (p && !isBye && p.uncertainty_source === "position_volatility_heuristic") reasons.push("HEURISTIC_POSITION_VOLATILITY_BAND_NOT_FITTED_DISTRIBUTION");
  if (p && !isBye && p.std_dev == null && expected != null) reasons.push("NO_DISPERSION_AVAILABLE");
  let variance: number | null = sigma != null ? sigma * sigma : null;
  if (!isBye && applyInjury && sigma != null && injury.probability_active != null && conditionalActive != null) {
    const pa = injury.probability_active;
    const mu = conditionalActive * (injury.workload_if_active.expected_fraction ?? 1);
    variance = knownUnavailable ? 0 : pa * (sigma * sigma + mu * mu) - (pa * mu) ** 2;
    if (pa < 1) reasons.push("PARTICIPATION_RISK_INCLUDED_IN_VARIANCE");
  }
  if (injury.confidence != null && injury.confidence < 0.5 && injury.normalized_state !== "HEALTHY") reasons.push("INJURY_EVIDENCE_STRENGTH_BELOW_0.5");

  const identifiers = { ...(player?.identifiers ?? {}) };
  const opponent = p?.opponent ?? null;
  const team = p?.nfl_team ?? player?.nfl_team ?? null;
  const teamHasGame = team != null && batch.teams_with_games.map((t) => t.toUpperCase()).includes(team.toUpperCase());

  return {
    model_version: CANONICAL_WEEKLY_FORECAST_VERSION,
    canonical_player_id: input.canonical_player_id,
    identifiers,
    season: input.season,
    week: input.week,
    team,
    opponent,
    position: p?.position ?? player?.position ?? null,
    value_state: valueState,
    game_status: {
      has_game: input.game_status?.has_game ?? (isBye || state === "NO_SCHEDULED_GAME" ? false : teamHasGame || (p != null && opponent != null) ? true : null),
      is_bye: isBye,
      game_id: input.game_status?.game_id ?? null,
      kickoff_at: input.game_status?.kickoff_at ?? null,
    },
    projection: {
      source_points: sourcePoints,
      conditional_active_points: conditionalActive,
      expected_points: expected,
      expected_points_basis: expectedBasis,
      floor: p && !isBye ? p.floor_points : null,
      median: null, // not modeled by any current source
      ceiling: p && !isBye ? p.ceiling_points : null,
    },
    availability: {
      probability_active: isBye ? null : injury.probability_active,
      status,
      injury_status: injuryText,
      normalized_state: injury.normalized_state,
      availability_state: isBye ? "BYE" : injury.availability_state,
      workload_state: injury.workload_if_active.expected_fraction == null ? null : injury.workload_if_active.basis,
      source_heuristic_availability: p && !isBye ? p.expected_availability : null,
      applied_to_expected_points: injuryChanged,
      basis: isBye ? "bye_schedule" : known ? "injury_model" : "none",
    },
    injury_model: injury,
    role: component(sh.role),
    environment: component(sh.environment),
    matchup: component(sh.matchup),
    uncertainty: {
      // evidence strength of the injury component only (NOT calibrated, never derived from points or band width); null if no injury evidence applies
      confidence: isBye ? null : injury.confidence,
      variance: variance != null ? r4(variance) : null,
      basis: p && !isBye ? p.uncertainty_source : "none",
      reasons,
    },
    freshness: {
      source_observed_at: null,
      snapshot_created_at: snap?.observed_at ?? null,
      age_ms: age,
      stale: age == null ? null : age > PROJECTION_SNAPSHOT_MAX_AGE_MS,
    },
    provenance: {
      projection_provider: batch.source ?? null,
      source_version: p?.model_version ?? batch.model_version ?? null,
      source_type: !p ? "NONE" : isBye ? "BYE_SCHEDULE" : kdst ? "K_DST_STANDARD_FALLBACK" : "WEEKLY_STAT_LINE_SCORED",
      snapshot: {
        artifact_id: snap?.artifact_id ?? null,
        read_path: snap?.read_path ?? null,
        durable: snap?.durable ?? null,
      },
      source_ids: sourceIds(player, batch),
      production_adjustments_applied: contributions.filter((c) => c.mode === "PRODUCTION").map((c) => c.component),
      shadow_adjustments_computed: shadowComputed,
      source_warnings: p ? [...p.warnings] : [],
    },
    contributions,
    certification: { state: cert, warnings },
  };
}

/**
 * Build the forecast for every player the weekly context knows about: all rostered ids plus every id the source
 * projected. Order is deterministic (sorted by canonical id) so identical inputs give identical batches.
 */
export function buildCanonicalForecastBatch(input: {
  batch: WeeklyProjectionBatch;
  requested_player_ids?: readonly string[];
  players?: ReadonlyMap<string, CanonicalPlayer>;
  bye_source_points?: ReadonlyMap<string, number | null>;
  shadow?: ReadonlyMap<string, ForecastShadowSignals>;
  injury_evidence?: ReadonlyMap<string, Partial<InjuryEvidence>>;
  injury_mode?: InjuryMode;
}): CanonicalWeeklyForecastBatch {
  const { batch } = input;
  const ids = [...new Set([...(input.requested_player_ids ?? []), ...batch.by_player.keys()])].sort();
  const by_player = new Map<string, CanonicalWeeklyPlayerForecast>();
  const counts: CanonicalWeeklyForecastBatch["counts"] = {
    total: 0,
    by_value_state: {},
    by_certification: {},
    bye: 0,
    with_shadow_signal: 0,
  };
  for (const id of ids) {
    const f = buildCanonicalWeeklyPlayerForecast({
      canonical_player_id: id,
      season: batch.season,
      week: batch.week,
      projection: batch.by_player.get(id) ?? null,
      batch,
      player: batch.resolved_players.get(id) ?? input.players?.get(id) ?? null,
      bye_source_points: input.bye_source_points?.get(id) ?? null,
      shadow: input.shadow?.get(id),
      injury: input.injury_evidence?.get(id),
      injury_mode: input.injury_mode,
    });
    by_player.set(id, f);
    counts.total += 1;
    counts.by_value_state[f.value_state] = (counts.by_value_state[f.value_state] ?? 0) + 1;
    counts.by_certification[f.certification.state] = (counts.by_certification[f.certification.state] ?? 0) + 1;
    if (f.game_status.is_bye) counts.bye += 1;
    if (f.provenance.shadow_adjustments_computed.length > 0) counts.with_shadow_signal += 1;
  }
  return {
    model_version: CANONICAL_WEEKLY_FORECAST_VERSION,
    league_slug: batch.league_slug,
    season: batch.season,
    week: batch.week,
    source: batch.source,
    source_version: batch.model_version,
    by_player,
    counts,
  };
}
