/**
 * W1.P4 — THE freshness policy authority. Pure and deterministic: the clock is always an input.
 *
 * Before W1.P4 the only freshness rule was one universal constant (a 90-minute serving window on the snapshot pointer), applied
 * regardless of kickoff, injury relevance or events — and measured from when the snapshot was WRITTEN, not from when the upstream
 * source was observed. This module replaces it. Nothing else may carry TTL arithmetic (pinned by the freshness ratchet test).
 *
 * Time semantics (never interchangeable):
 *   source_observed_at   when Bloodline actually fetched the upstream source state
 *   snapshot_created_at  when Bloodline persisted a snapshot of it
 *   forecast_composed_at when the canonical forecast was assembled
 *   kickoff / event time absolute NFL instants (UTC); no timezone is assumed anywhere
 *
 * Freshness is a property of the SOURCE OBSERVATION relative to the decision moment, so copying old data into a new snapshot cannot
 * make it fresh.
 */

import type { InvalidationEvent } from "./events";

export const FRESHNESS_POLICY_VERSION = "projection-freshness-2026.1" as const;

const MIN = 60_000;
const HOUR = 60 * MIN;

export type FreshnessState = "FRESH" | "STALE" | "UNKNOWN" | "FROZEN_PREGAME";

export type FreshnessTier =
  | "EARLY_WEEK" //            > 72h to kickoff
  | "MIDWEEK" //               24h–72h
  | "GAME_DAY_FAR" //          6h–24h
  | "GAME_DAY_NEAR" //         90m–6h
  | "FINAL_PREGAME" //         15m–90m
  | "KICKOFF_IMMINENT" //      < 15m
  | "KICKOFF_UNKNOWN" //       kickoff not resolvable: conservative
  | "GAME_STARTED"; //         at/after kickoff: pregame forecast freezes

/**
 * Required maximum SOURCE age by time to kickoff. Rationale: injury/designation news concentrates in the last hours before a game
 * and the provider (Sleeper/RotoWire) republishes within minutes of inactive announcements; far from kickoff nothing material changes
 * quickly. The floor protects the upstream feed from being hammered (the client also de-duplicates in-flight fetches and shares one
 * process cache across all leagues). Values are an engineering judgement, NOT empirically derived; they are exposed here so they can be
 * tuned against the observation history this phase starts to collect.
 */
export const TIER_MAX_AGE_MS: Readonly<Record<Exclude<FreshnessTier, "GAME_STARTED">, number>> = {
  EARLY_WEEK: 6 * HOUR,
  MIDWEEK: 3 * HOUR,
  GAME_DAY_FAR: 60 * MIN,
  GAME_DAY_NEAR: 30 * MIN,
  FINAL_PREGAME: 15 * MIN,
  KICKOFF_IMMINENT: 5 * MIN,
  KICKOFF_UNKNOWN: 30 * MIN,
};

/** Never ask the upstream for a fresher observation than this (rate protection). */
export const MIN_REQUIRED_MAX_AGE_MS = 2 * MIN;

/** A player whose availability is uncertain (Questionable / Doubtful / unrecognised) tightens the requirement inside these windows. */
export const INJURY_UNCERTAIN_CAPS: ReadonlyArray<{ within_ms: number; max_age_ms: number }> = [
  { within_ms: 6 * HOUR, max_age_ms: 15 * MIN },
  { within_ms: 24 * HOUR, max_age_ms: 30 * MIN },
  { within_ms: 72 * HOUR, max_age_ms: 2 * HOUR },
];

/** A last-known snapshot older than this is not retained as a stale fallback (it is no longer a forecast of this week's state). */
export const STALE_FALLBACK_MAX_AGE_MS = 48 * HOUR;

export interface RefreshOutcome {
  attempted: boolean;
  succeeded: boolean | null;
  failed_at: string | null;
  reason: string | null;
}

export interface FreshnessInput {
  now_ms: number;
  /** absolute NFL kickoff (ISO-8601 with offset/Z). null = unknown. */
  kickoff_at: string | null;
  source_observed_at: string | null;
  snapshot_created_at?: string | null;
  /** availability of THIS player is uncertain (Questionable/Doubtful/unrecognised) */
  injury_uncertain?: boolean;
  /** events already filtered to those whose scope covers this player/forecast */
  events?: readonly InvalidationEvent[];
  refresh?: RefreshOutcome | null;
}

export interface FreshnessAssessment {
  policy_version: typeof FRESHNESS_POLICY_VERSION;
  state: FreshnessState;
  tier: FreshnessTier;
  /** null while FROZEN_PREGAME (no further refresh is required or meaningful) */
  required_max_age_ms: number | null;
  age_ms: number | null;
  kickoff_at: string | null;
  ms_to_kickoff: number | null;
  source_observed_at: string | null;
  snapshot_created_at: string | null;
  invalidation_reasons: string[];
  refresh: RefreshOutcome;
  /** why this state, as a stable machine reason */
  reason: string;
  /** user-facing explanation derived from the fields above */
  user_warning: string | null;
}

const NO_REFRESH: RefreshOutcome = { attempted: false, succeeded: null, failed_at: null, reason: null };

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function tierFor(msToKickoff: number | null): FreshnessTier {
  if (msToKickoff == null) return "KICKOFF_UNKNOWN";
  if (msToKickoff <= 0) return "GAME_STARTED";
  if (msToKickoff <= 15 * MIN) return "KICKOFF_IMMINENT";
  if (msToKickoff <= 90 * MIN) return "FINAL_PREGAME";
  if (msToKickoff <= 6 * HOUR) return "GAME_DAY_NEAR";
  if (msToKickoff <= 24 * HOUR) return "GAME_DAY_FAR";
  if (msToKickoff <= 72 * HOUR) return "MIDWEEK";
  return "EARLY_WEEK";
}

/** Required max source age for a tier (+ injury tightening). null for GAME_STARTED. */
export function requiredMaxAgeMs(msToKickoff: number | null, injuryUncertain = false): { tier: FreshnessTier; required: number | null } {
  const tier = tierFor(msToKickoff);
  if (tier === "GAME_STARTED") return { tier, required: null };
  let required = TIER_MAX_AGE_MS[tier];
  if (injuryUncertain && msToKickoff != null) {
    for (const cap of INJURY_UNCERTAIN_CAPS) if (msToKickoff <= cap.within_ms) required = Math.min(required, cap.max_age_ms);
  }
  return { tier, required: Math.max(MIN_REQUIRED_MAX_AGE_MS, required) };
}

const fmtMin = (v: number): string => (v >= HOUR ? `${Math.round((v / HOUR) * 10) / 10} h` : `${Math.round(v / MIN)} min`);

/** Required source age for a LEAGUE-WIDE snapshot: governed by the next not-yet-started kickoff in the week. */
export function requiredMaxAgeForBatch(args: { now_ms: number; next_kickoff_at: string | null; kickoff_known: boolean; any_injury_uncertain?: boolean }): { tier: FreshnessTier; required_max_age_ms: number } {
  const k = ms(args.next_kickoff_at);
  if (k == null) {
    // no upcoming kickoff: either unknowable (be conservative) or every game of the week has started/finished
    const tier: FreshnessTier = args.kickoff_known ? "EARLY_WEEK" : "KICKOFF_UNKNOWN";
    return { tier, required_max_age_ms: TIER_MAX_AGE_MS[tier] };
  }
  const r = requiredMaxAgeMs(k - args.now_ms, args.any_injury_uncertain ?? false);
  return { tier: r.tier, required_max_age_ms: r.required ?? TIER_MAX_AGE_MS.KICKOFF_IMMINENT };
}

/** THE per-forecast freshness decision. */
export function evaluateForecastFreshness(input: FreshnessInput): FreshnessAssessment {
  const kickoffMs = ms(input.kickoff_at);
  const observedMs = ms(input.source_observed_at);
  const msToKickoff = kickoffMs == null ? null : kickoffMs - input.now_ms;
  const refresh = input.refresh ?? NO_REFRESH;
  const { tier, required } = requiredMaxAgeMs(msToKickoff, input.injury_uncertain ?? false);
  const age = observedMs == null ? null : Math.max(0, input.now_ms - observedMs);
  const base = {
    policy_version: FRESHNESS_POLICY_VERSION,
    tier,
    required_max_age_ms: required,
    age_ms: age,
    kickoff_at: input.kickoff_at,
    ms_to_kickoff: msToKickoff,
    source_observed_at: input.source_observed_at,
    snapshot_created_at: input.snapshot_created_at ?? null,
    refresh,
  };

  // ---- the game has started: the pregame forecast freezes (never evaluated against a post-kickoff observation) -----------------
  if (tier === "GAME_STARTED") {
    if (observedMs != null && kickoffMs != null && observedMs > kickoffMs) {
      return {
        ...base,
        state: "UNKNOWN",
        invalidation_reasons: ["OBSERVATION_AFTER_KICKOFF_NOT_A_VALID_PREGAME_FORECAST"],
        reason: "POST_KICKOFF_OBSERVATION",
        user_warning: "This projection was observed after kickoff and cannot serve as the pregame forecast.",
      };
    }
    return {
      ...base,
      required_max_age_ms: null,
      state: "FROZEN_PREGAME",
      invalidation_reasons: [],
      reason: "GAME_STARTED_PREGAME_FORECAST_FROZEN",
      user_warning: null,
    };
  }

  // ---- events that supersede this observation ----------------------------------------------------------------------------------
  const superseding = (input.events ?? []).filter((e) => {
    const known = ms(e.known_at);
    return known != null && (observedMs == null || known > observedMs);
  });
  const reasons = superseding.map((e) => `${e.type}:${e.event_id}`);

  if (superseding.length > 0) {
    return {
      ...base,
      state: "STALE",
      invalidation_reasons: reasons,
      reason: "INVALIDATED_BY_EVENT",
      user_warning: `A newer source event (${superseding.map((e) => e.type).join(", ")}) supersedes the observation this forecast is built from; it must be refreshed before it is used for a decision.`,
    };
  }

  if (refresh.attempted && refresh.succeeded === false) {
    return {
      ...base,
      state: "STALE",
      invalidation_reasons: ["REFRESH_FAILED"],
      reason: "REFRESH_FAILED_LAST_KNOWN_RETAINED",
      user_warning: `Latest refresh failed${refresh.reason ? ` (${refresh.reason})` : ""}; using the last known projection${input.source_observed_at ? ` observed at ${input.source_observed_at}` : ""}. Confidence is degraded.`,
    };
  }

  if (observedMs == null || age == null) {
    return {
      ...base,
      state: "UNKNOWN",
      invalidation_reasons: [],
      reason: "SOURCE_OBSERVATION_TIME_UNKNOWN",
      user_warning: "The time this projection was observed is unknown, so its freshness cannot be verified.",
    };
  }

  if (required != null && age > required) {
    const toK = msToKickoff == null ? "kickoff time unknown" : `kickoff is in ${fmtMin(msToKickoff)}`;
    return {
      ...base,
      state: "STALE",
      invalidation_reasons: [],
      reason: "AGE_EXCEEDS_REQUIRED",
      user_warning: `Projection last observed ${fmtMin(age)} ago. Because ${toK}, this forecast is outside the ${tier} freshness threshold (${fmtMin(required)}).`,
    };
  }

  return { ...base, state: "FRESH", invalidation_reasons: [], reason: "WITHIN_REQUIRED_AGE", user_warning: null };
}
