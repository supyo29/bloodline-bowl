/**
 * W1.P4 / W1.R1 — the FINAL PREGAME forecast: what Bloodline actually believed before kickoff, frozen for calibration.
 *
 * REVISION SEMANTICS (W1.R1 decision): IMMUTABLE APPEND-ONLY REVISIONS + a deterministic final pointer.
 *   - Every distinct pre-kickoff forecast CONTENT is stored once, forever, as an immutable revision with a content-addressed id
 *     (`forecast_id = fpf:<hash>` over league/season/week/player/source observation/scoring + the full forecast content). The revision holds
 *     the complete canonical forecast as composed (source projection, conditional/expected points, injury model state + semantics,
 *     contribution ledger, bye state, shadow components, K/DST certification, freshness identity, model versions).
 *   - The "final" row per league/season/week/player is a POINTER to the latest valid revision. Pre-kickoff updates may advance it; nothing
 *     else may. A superseded revision is never altered or deleted, so any past belief stays reconstructable.
 *
 * Rules (pinned by tests):
 *   - valid  = the forecast was COMPOSED strictly before kickoff AND its source observation was observed at or before kickoff, and the
 *              observation precedes the composition. A request made after kickoff can read the frozen record but can never propose, alter or
 *              confirm one — combining an old observation with newer live status (the audit's hindsight hole) is rejected at the door.
 *   - final  = the valid revision with the greatest (source_observed_at, composed_at, forecast_id)
 *   - an update can never move the pointer to older evidence (older observation, or older composition of the same observation)
 *   - identical content seen again only CONFIRMS (extends confirmed_through); it never rewrites a revision
 * The record is LEAGUE-scoped (expected points are league-scored); the shared source observation is referenced, not duplicated.
 */

import { contentHash } from "@/lib/bridge/hash";
import type { CanonicalWeeklyPlayerForecast } from "../forecast/schema";

export const FINAL_PREGAME_RECORD_VERSION = 2 as const;

export interface FinalPregameRecord {
  record_version: typeof FINAL_PREGAME_RECORD_VERSION;
  /** immutable, content-addressed identity of THIS revision (deterministic: same evidence => same id, on every instance) */
  forecast_id: string;
  /** when Bloodline composed this forecast (injected clock). Must be strictly before kickoff for the record to be valid. */
  composed_at: string;
  /** hash of the forecast CONTENT (excludes time-varying freshness fields); equal signature => same belief */
  content_signature: string;
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
  /**
   * The COMPLETE canonical decision forecast exactly as composed (contribution ledger, injury model semantics, shadow components with
   * mode/version, bye state, K/DST certification, provenance, freshness identity). Present on revisions; stripped (`null`) on the
   * final pointer row, which references the revision by `forecast_id`.
   */
  forecast_snapshot: CanonicalWeeklyPlayerForecast | null;
}

export type FinalPregameWrite =
  | "RECORDED"
  | "CONFIRMED"
  | "UNCHANGED"
  | "REJECTED_POST_KICKOFF"
  | "REJECTED_OLDER_OBSERVATION"
  | "REJECTED_NO_KICKOFF"
  /** observation after composition, or unparseable times: the evidence timeline is not coherent */
  | "REJECTED_INCONSISTENT_TIMES";

export type FinalPregameWriteCounts = Record<FinalPregameWrite, number>;
export const emptyWriteCounts = (): FinalPregameWriteCounts => ({ RECORDED: 0, CONFIRMED: 0, UNCHANGED: 0, REJECTED_POST_KICKOFF: 0, REJECTED_OLDER_OBSERVATION: 0, REJECTED_NO_KICKOFF: 0, REJECTED_INCONSISTENT_TIMES: 0 });

export interface FinalPregameStore {
  readonly kind: string;
  upsertCandidate(rec: FinalPregameRecord): Promise<FinalPregameWrite>;
  /** batched form used by the context builder (one read + minimal writes per league/week) */
  upsertMany(recs: readonly FinalPregameRecord[]): Promise<FinalPregameWriteCounts>;
  /** the final pointer row (thin: `forecast_snapshot` is null — read the revision for the full evidence) */
  get(league_slug: string, season: number, week: number, canonical_player_id: string): Promise<FinalPregameRecord | null>;
  /** an immutable revision with its complete forecast snapshot */
  getRevision(forecast_id: string): Promise<FinalPregameRecord | null>;
  /** every revision of one league/week/player, oldest first by (source_observed_at, composed_at, forecast_id) */
  listRevisions(league_slug: string, season: number, week: number, canonical_player_id: string): Promise<FinalPregameRecord[]>;
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

/**
 * The forecast CONTENT — what Bloodline believed — with every time-varying field removed (freshness age, ms-to-kickoff, composed-at, snapshot
 * read path). Two requests that compose the same belief at different moments share one signature, so a refresh storm cannot mint revisions.
 * Shadow components, contribution ledger, injury semantics and model versions are INSIDE the signature: a change in any of them is a new belief.
 */
/** reasons/warnings that merely restate the freshness state at composition time (they vary with the clock, not with the belief) */
const TIME_VARYING_NOTE = /^FORECAST_(STALE|OBSERVATION_AFTER_KICKOFF)/;
export function forecastContent(f: CanonicalWeeklyPlayerForecast): unknown {
  return {
    model_version: f.model_version,
    value_state: f.value_state,
    game_status: f.game_status,
    projection: f.projection,
    weekly_value: f.weekly_value,
    asset_context: f.asset_context,
    availability: f.availability,
    injury_model: f.injury_model,
    role: f.role,
    environment: f.environment,
    matchup: f.matchup,
    uncertainty: { ...f.uncertainty, reasons: f.uncertainty.reasons.filter((r) => !TIME_VARYING_NOTE.test(r)) },
    contributions: f.contributions,
    certification: { ...f.certification, warnings: f.certification.warnings.filter((w) => !TIME_VARYING_NOTE.test(w)) },
    source: { provider: f.provenance.projection_provider, version: f.provenance.source_version, ids: f.provenance.source_ids },
  };
}

export const forecastContentSignature = (f: CanonicalWeeklyPlayerForecast): string => contentHash(forecastContent(f)).slice(0, 32);

export function buildFinalPregameRecord(a: {
  forecast: CanonicalWeeklyPlayerForecast;
  league_slug: string;
  provider: string;
  scoring_fingerprint: string | null;
  source_observation_id: string | null;
  recorded_at: string;
  /** defaults to the forecast's own composition instant, then `recorded_at` */
  composed_at?: string;
}): FinalPregameRecord | null {
  const f = a.forecast;
  const kickoff = f.game_status.kickoff_at;
  const observed = f.freshness.source_observed_at;
  if (!kickoff || !observed) return null;
  const composed = a.composed_at ?? f.freshness.forecast_composed_at ?? a.recorded_at;
  const signature = forecastContentSignature(f);
  const forecastId = `fpf:${contentHash({ l: a.league_slug, s: f.season, w: f.week, p: f.canonical_player_id, o: observed, oid: a.source_observation_id, fp: a.scoring_fingerprint, c: signature }).slice(0, 24)}`;
  return {
    record_version: FINAL_PREGAME_RECORD_VERSION,
    forecast_id: forecastId,
    composed_at: composed,
    content_signature: signature,
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
    // an independent deep copy: later mutation of the live forecast object can never reach the frozen evidence
    forecast_snapshot: structuredClone(f),
  };
}

/** the pointer row: identical, minus the bulky snapshot (the revision holds it) */
export const thinRecord = (r: FinalPregameRecord): FinalPregameRecord => ({ ...r, forecast_snapshot: null });

/** ordering of revisions / evidence: older first */
export function compareRevisions(a: FinalPregameRecord, b: FinalPregameRecord): number {
  return (
    Date.parse(a.source_observed_at) - Date.parse(b.source_observed_at) ||
    Date.parse(a.composed_at) - Date.parse(b.composed_at) ||
    (a.forecast_id < b.forecast_id ? -1 : a.forecast_id > b.forecast_id ? 1 : 0)
  );
}

/** the revision a pointer should reference: the latest VALID one (deterministic, independent of arrival order) */
export function selectFinalRevision(revisions: readonly FinalPregameRecord[]): FinalPregameRecord | null {
  let best: FinalPregameRecord | null = null;
  for (const r of revisions) {
    if (decideCandidate(null, r) !== "RECORDED") continue;
    if (!best || compareRevisions(r, best) > 0) best = r;
  }
  return best;
}

/**
 * THE decision rule (the Supabase store applies it against its stored pointer row).
 *   composition at/after kickoff, observation after kickoff, or observation after composition  -> rejected: no hindsight, ever
 *   older evidence than the pointer                                                              -> rejected
 *   identical content                                                                            -> CONFIRMED (observation advanced) / UNCHANGED
 *   anything else valid                                                                          -> RECORDED (a new immutable revision; the pointer advances)
 */
export function decideCandidate(existing: FinalPregameRecord | null, rec: FinalPregameRecord): FinalPregameWrite {
  const k = Date.parse(rec.kickoff_at);
  const o = Date.parse(rec.source_observed_at);
  const c = Date.parse(rec.composed_at);
  if (!Number.isFinite(k)) return "REJECTED_NO_KICKOFF";
  if (!Number.isFinite(o) || !Number.isFinite(c)) return "REJECTED_INCONSISTENT_TIMES";
  // W1.R1 (G2): the COMPOSITION instant is what bounds the evidence the forecast could contain. A request made at/after kickoff may pair an
  // old pregame observation with newer live status; it must never reach the frozen record, whatever the observation's own timestamp says.
  if (c >= k || o > k) return "REJECTED_POST_KICKOFF";
  if (o > c) return "REJECTED_INCONSISTENT_TIMES";
  if (!existing) return "RECORDED";
  const eo = Date.parse(existing.confirmed_through);
  if (Number.isFinite(eo) && eo > o) return "REJECTED_OLDER_OBSERVATION";
  const ec = Date.parse(existing.composed_at);
  if (Number.isFinite(ec) && (ec > c || (ec === c && rec.content_signature !== existing.content_signature && rec.forecast_id <= existing.forecast_id))) return "REJECTED_OLDER_OBSERVATION";
  if (rec.content_signature === existing.content_signature) return Number.isFinite(eo) && eo === o ? "UNCHANGED" : "CONFIRMED";
  return "RECORDED";
}

export class MemoryFinalPregameStore implements FinalPregameStore {
  readonly kind = "memory";
  #final = new Map<string, FinalPregameRecord>();
  #revisions = new Map<string, FinalPregameRecord>();
  #k = (l: string, s: number, w: number, p: string) => `${l}|${s}|${w}|${p}`;

  async upsertCandidate(rec: FinalPregameRecord): Promise<FinalPregameWrite> {
    const key = this.#k(rec.league_slug, rec.season, rec.week, rec.canonical_player_id);
    const existing = this.#final.get(key) ?? null;
    const d = decideCandidate(existing, rec);
    if (d === "RECORDED") {
      if (!this.#revisions.has(rec.forecast_id)) this.#revisions.set(rec.forecast_id, structuredClone(rec)); // append-only: never replaced
      this.#final.set(key, thinRecord(rec));
    } else if (d === "CONFIRMED" && existing) {
      this.#final.set(key, { ...existing, confirmed_through: rec.confirmed_through, seconds_before_kickoff: rec.seconds_before_kickoff });
    }
    return d;
  }
  async upsertMany(recs: readonly FinalPregameRecord[]): Promise<FinalPregameWriteCounts> {
    const out = emptyWriteCounts();
    for (const r of recs) out[await this.upsertCandidate(r)] += 1;
    return out;
  }
  async get(l: string, s: number, w: number, p: string): Promise<FinalPregameRecord | null> {
    return this.#final.get(this.#k(l, s, w, p)) ?? null;
  }
  async getRevision(id: string): Promise<FinalPregameRecord | null> {
    const r = this.#revisions.get(id);
    return r ? structuredClone(r) : null;
  }
  async listRevisions(l: string, s: number, w: number, p: string): Promise<FinalPregameRecord[]> {
    return [...this.#revisions.values()].filter((r) => r.league_slug === l && r.season === s && r.week === w && r.canonical_player_id === p).sort(compareRevisions).map((r) => structuredClone(r));
  }
  size(): number {
    return this.#final.size;
  }
  revisionCount(): number {
    return this.#revisions.size;
  }
}

/** @deprecated legacy P4 signature (value-only). Kept for callers/tests that compare content; the revision identity uses `content_signature`. */
export function contentSignature(r: FinalPregameRecord): string {
  return r.content_signature;
}
