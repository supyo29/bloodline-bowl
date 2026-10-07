/**
 * W1.P4 — the FINAL PREGAME forecast: the last valid pre-kickoff observation, frozen for calibration.
 *
 * Rules (pinned by tests):
 *   - valid  = source_observed_at <= kickoff (an observation made after kickoff is never a pregame forecast)
 *   - final  = the valid observation with the greatest observed_at
 *   - an update can never move the frozen record to an older observation, nor onto a post-kickoff one
 *   - live scoring systems may run separately; nothing here is rewritten by post-kickoff data
 * The record is LEAGUE-scoped (expected points are league-scored) and carries enough provenance to prove timing, source and model.
 */

import type { CanonicalWeeklyPlayerForecast } from "../forecast/schema";

export interface FinalPregameRecord {
  league_slug: string;
  provider: string;
  season: number;
  week: number;
  canonical_player_id: string;
  identifiers: Record<string, string>;
  game_id: string | null;
  kickoff_at: string;
  /** when THIS forecast content was first observed (a later identical observation advances `confirmed_through`, not this) */
  source_observed_at: string;
  /** the latest valid (<= kickoff) observation that confirmed this content: the "final pregame observation" instant */
  confirmed_through: string;
  source_observation_id: string | null;
  seconds_before_kickoff: number;
  source_provider: string | null;
  source_version: string | null;
  forecast_model_version: string;
  injury_model_version: string;
  scoring_fingerprint: string | null;
  snapshot_artifact_id: string | null;
  expected_points: number | null;
  source_points: number | null;
  conditional_active_points: number | null;
  current_week_state: string;
  injury: { source_status: string | null; normalized_state: string; probability_active: number | null; mode: string };
  shadow: { role_adjustment: number | null; matchup_adjustment: number | null; environment_adjustment: number | null };
  freshness_state: string;
  recorded_at: string;
}

export type FinalPregameWrite = "RECORDED" | "CONFIRMED" | "UNCHANGED" | "REJECTED_POST_KICKOFF" | "REJECTED_OLDER_OBSERVATION" | "REJECTED_NO_KICKOFF";

export interface FinalPregameStore {
  readonly kind: string;
  upsertCandidate(rec: FinalPregameRecord): Promise<FinalPregameWrite>;
  /** batched form used by the context builder (one read + minimal writes per league/week) */
  upsertMany(recs: readonly FinalPregameRecord[]): Promise<Record<FinalPregameWrite, number>>;
  get(league_slug: string, season: number, week: number, canonical_player_id: string): Promise<FinalPregameRecord | null>;
}

/** Last observation with observed_at <= kickoff (ISO strings compare chronologically only when normalised, so compare as instants). */
export function selectFinalPregameObservation<T extends { observed_at: string }>(observations: readonly T[], kickoffIso: string): T | null {
  const k = Date.parse(kickoffIso);
  if (!Number.isFinite(k)) return null;
  let best: T | null = null;
  let bestMs = -Infinity;
  for (const o of observations) {
    const t = Date.parse(o.observed_at);
    if (Number.isFinite(t) && t <= k && t > bestMs) {
      best = o;
      bestMs = t;
    }
  }
  return best;
}

export function buildFinalPregameRecord(a: {
  forecast: CanonicalWeeklyPlayerForecast;
  league_slug: string;
  provider: string;
  scoring_fingerprint: string | null;
  source_observation_id: string | null;
  recorded_at: string;
}): FinalPregameRecord | null {
  const f = a.forecast;
  const kickoff = f.game_status.kickoff_at;
  const observed = f.freshness.source_observed_at;
  if (!kickoff || !observed) return null;
  return {
    league_slug: a.league_slug,
    provider: a.provider,
    season: f.season,
    week: f.week,
    canonical_player_id: f.canonical_player_id,
    identifiers: Object.fromEntries(Object.entries(f.identifiers).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])),
    game_id: f.game_status.game_id,
    kickoff_at: kickoff,
    source_observed_at: observed,
    source_observation_id: a.source_observation_id,
    confirmed_through: observed,
    seconds_before_kickoff: Math.round((Date.parse(kickoff) - Date.parse(observed)) / 1000),
    source_provider: f.provenance.projection_provider,
    source_version: f.provenance.source_version,
    forecast_model_version: f.model_version,
    injury_model_version: f.injury_model.model_version,
    scoring_fingerprint: a.scoring_fingerprint,
    snapshot_artifact_id: f.provenance.snapshot.artifact_id,
    expected_points: f.projection.expected_points,
    source_points: f.projection.source_points,
    conditional_active_points: f.projection.conditional_active_points,
    current_week_state: f.weekly_value.current_week_state,
    injury: { source_status: f.injury_model.source_status, normalized_state: f.injury_model.normalized_state, probability_active: f.injury_model.probability_active, mode: f.injury_model.mode },
    shadow: {
      role_adjustment: f.role.signal?.adjustment_points ?? null,
      matchup_adjustment: f.matchup.signal?.adjustment_points ?? null,
      environment_adjustment: f.environment.signal?.adjustment_points ?? null,
    },
    freshness_state: f.freshness.state ?? "UNKNOWN",
    recorded_at: a.recorded_at,
  };
}

export class MemoryFinalPregameStore implements FinalPregameStore {
  readonly kind = "memory";
  #m = new Map<string, FinalPregameRecord>();
  #k = (l: string, s: number, w: number, p: string) => `${l}|${s}|${w}|${p}`;
  async upsertCandidate(rec: FinalPregameRecord): Promise<FinalPregameWrite> {
    return applyCandidate(this.#m, this.#k(rec.league_slug, rec.season, rec.week, rec.canonical_player_id), rec);
  }
  async upsertMany(recs: readonly FinalPregameRecord[]): Promise<Record<FinalPregameWrite, number>> {
    const out: Record<FinalPregameWrite, number> = { RECORDED: 0, CONFIRMED: 0, UNCHANGED: 0, REJECTED_POST_KICKOFF: 0, REJECTED_OLDER_OBSERVATION: 0, REJECTED_NO_KICKOFF: 0 };
    for (const r of recs) out[await this.upsertCandidate(r)] += 1;
    return out;
  }
  async get(l: string, s: number, w: number, p: string): Promise<FinalPregameRecord | null> {
    return this.#m.get(this.#k(l, s, w, p)) ?? null;
  }
  size(): number {
    return this.#m.size;
  }
}

/** The forecast CONTENT that calibration cares about; identical content seen again only confirms, it does not rewrite. */
export function contentSignature(r: FinalPregameRecord): string {
  return JSON.stringify([r.expected_points, r.source_points, r.conditional_active_points, r.current_week_state, r.injury, r.scoring_fingerprint, r.forecast_model_version, r.kickoff_at]);
}

/** shared decision rule (the Supabase store applies the same rule against its stored row) */
export function decideCandidate(existing: FinalPregameRecord | null, rec: FinalPregameRecord): FinalPregameWrite {
  const k = Date.parse(rec.kickoff_at);
  const o = Date.parse(rec.source_observed_at);
  if (!Number.isFinite(k)) return "REJECTED_NO_KICKOFF";
  if (!Number.isFinite(o) || o > k) return "REJECTED_POST_KICKOFF";
  if (!existing) return "RECORDED";
  const eo = Date.parse(existing.confirmed_through);
  if (Number.isFinite(eo) && eo > o) return "REJECTED_OLDER_OBSERVATION";
  if (contentSignature(existing) === contentSignature(rec)) return Number.isFinite(eo) && eo === o ? "UNCHANGED" : "CONFIRMED";
  return "RECORDED";
}

function applyCandidate(m: Map<string, FinalPregameRecord>, key: string, rec: FinalPregameRecord): FinalPregameWrite {
  const existing = m.get(key) ?? null;
  const d = decideCandidate(existing, rec);
  if (d === "RECORDED") m.set(key, rec);
  else if (d === "CONFIRMED" && existing) m.set(key, { ...existing, confirmed_through: rec.confirmed_through, seconds_before_kickoff: rec.seconds_before_kickoff });
  return d;
}
