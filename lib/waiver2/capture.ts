/**
 * Phase 4 (Checkpoint G) — PROSPECTIVE SHADOW CAPTURE for Waiver 2.0, with the Phase 3.5A integrity philosophy.
 *
 * Historical waiver pools were never preserved (the free-agent pool is not even materialized), so a backtest of Waiver 2.0
 * would have to FABRICATE the alternatives. The honest path is to capture pristine, content-addressed weekly evaluations
 * going forward and attach outcomes later without ever touching the decision. Capture classes are never merged:
 *   LIVE_CAPTURED  — taken live, pool CERTIFIED, and no NFL game of the target week had started/finished
 *   LIVE_POST_LOCK — observed live but a game had already kicked off
 *   LIVE_UNVERIFIED — observed live but the pool is NOT certified (or lock/week state could not be verified)
 *   HISTORICALLY_RECONSTRUCTED — rebuilt from archives (lower integrity; excluded from every evidence gate)
 * This module is a pure store contract + in-memory implementation. NOTHING in a request path calls it; persistence to a
 * database is a separately-approved step (the migration is prepared, not applied).
 */
import { hashOf } from "./hash";
import { WAIVER2_ENGINE_VERSION } from "./config";
import type { WaiverEvaluation, WaiverInput } from "./types";

export type CaptureKind = "LIVE_CAPTURED" | "LIVE_POST_LOCK" | "LIVE_UNVERIFIED" | "HISTORICALLY_RECONSTRUCTED";
export const CAPTURE_KINDS: CaptureKind[] = ["LIVE_CAPTURED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED", "HISTORICALLY_RECONSTRUCTED"];
export const CAPTURE_RECORD_SCHEMA_VERSION = 1;

export interface CaptureClockFacts { games_started_or_finished: boolean | null; is_reconstruction: boolean }
export function captureKindFor(ev: Pick<WaiverEvaluation, "availability">, facts: CaptureClockFacts): CaptureKind {
  if (facts.is_reconstruction) return "HISTORICALLY_RECONSTRUCTED";
  if (ev.availability.certification !== "CERTIFIED" || ev.availability.status !== "AVAILABLE") return "LIVE_UNVERIFIED";
  if (facts.games_started_or_finished === null) return "LIVE_UNVERIFIED";
  return facts.games_started_or_finished ? "LIVE_POST_LOCK" : "LIVE_CAPTURED";
}

export interface WaiverShadowCaptureRecord {
  schema_version: number; capture_id: string; capture_kind: CaptureKind; captured_at: string; season: number; week: number;
  league_slug: string; manager_slug: string; scoring_fingerprint: string | null; model_version: string; params_hash: string;
  pool: { certification: string; candidate_ids: string[]; count: number };
  roster: { active_player_ids: string[]; faab_remaining: number | null; waiver_priority: number | null; roster_hash: string };
  actions: Array<{ id: string; tier: string; net_action_value: number; net_low: number; net_high: number; gross_add_value: number; drop_cost: number; acquisition_cost: number; risk_penalty: number; faab: [number | null, number | null, number | null, number | null]; candidate_id: string | null; drop_id: string | null; content_id: string }>;
  recommended_id: string | null; pass_recommended: boolean;
  evidence: { snapshot: string | null; role: string | null; fi: string | null; opp: string | null; projection_model: string | null };
  evaluation_hash: string; content_hash: string;
}

/** Capture identity covers the WHOLE decision content, so any change in inputs or output is a different capture. */
export function buildCaptureRecord(ev: WaiverEvaluation, input: WaiverInput, o: { kind: CaptureKind; league_slug: string; manager_slug: string; season: number }): WaiverShadowCaptureRecord {
  const my = input.teams.find((t) => t.team_id === input.my_team_id)!;
  const roster = { active_player_ids: [...my.active_player_ids].sort(), faab_remaining: my.faab_remaining, waiver_priority: my.waiver_priority };
  const body = {
    schema_version: CAPTURE_RECORD_SCHEMA_VERSION, capture_kind: o.kind, season: o.season, week: ev.week, league_slug: o.league_slug, manager_slug: o.manager_slug, scoring_fingerprint: ev.scoring_fingerprint, model_version: WAIVER2_ENGINE_VERSION, params_hash: ev.lineage.params_hash,
    pool: { certification: ev.availability.certification, candidate_ids: input.pool.candidates.map((c) => c.canonical_player_id).sort(), count: input.pool.candidates.length },
    roster: { ...roster, roster_hash: hashOf(roster) },
    actions: ev.actions.map((a) => ({ id: a.id, tier: a.tier, net_action_value: a.net_action_value, net_low: a.net_low, net_high: a.net_high, gross_add_value: a.gross_add_value, drop_cost: a.drop_cost, acquisition_cost: a.acquisition_cost, risk_penalty: a.risk_penalty, faab: [a.market.faab.min_useful, a.market.faab.expected_competitive, a.market.faab.aggressive, a.market.faab.walk_away] as [number | null, number | null, number | null, number | null], candidate_id: a.candidate?.player_id ?? null, drop_id: a.drop?.player_id ?? null, content_id: a.content_id })),
    recommended_id: ev.recommended?.id ?? null, pass_recommended: ev.recommended == null,
    evidence: { snapshot: ev.lineage.snapshot, role: ev.lineage.role, fi: ev.lineage.fi, opp: ev.lineage.opp, projection_model: ev.lineage.projection_model }, evaluation_hash: ev.evaluation_hash,
  };
  const content_hash = hashOf(body, 16);
  return { ...body, captured_at: ev.generated_at, capture_id: `w2cap:${hashOf({ b: body, c: content_hash }, 16)}`, content_hash };
}

export interface WaiverOutcome { capture_id: string; source: string; recorded_at: string; claim_result: "WON" | "LOST" | "NOT_SUBMITTED" | "UNKNOWN"; winning_bid: number | null; realized: { candidate_points_started: number | null; drop_points_lost: number | null; role_share_change: number | null; roster_survival_weeks: number | null; best_alternative_points_started: number | null } }
export interface WaiverCaptureStore {
  record(r: WaiverShadowCaptureRecord): { status: "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED"; reason?: string };
  attachOutcome(o: WaiverOutcome): { status: "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED"; reason?: string };
  list(): WaiverShadowCaptureRecord[]; outcomes(): WaiverOutcome[];
}

/** Insert-only, idempotent, tamper-evident in-memory store (the contract a database implementation must honor). */
export class MemoryWaiverCaptureStore implements WaiverCaptureStore {
  private caps = new Map<string, WaiverShadowCaptureRecord>(); private outs = new Map<string, WaiverOutcome>();
  record(r: WaiverShadowCaptureRecord) {
    const { content_hash, capture_id, captured_at, ...body } = r; void captured_at;
    if (!content_hash || !capture_id.startsWith("w2cap:")) return { status: "REFUSED" as const, reason: "missing identity" };
    if (!CAPTURE_KINDS.includes(r.capture_kind)) return { status: "REFUSED" as const, reason: `unknown capture kind ${r.capture_kind}` };
    if (hashOf(body, 16) !== content_hash) return { status: "REFUSED" as const, reason: "content_hash does not match the record (tampered or malformed)" };
    const prior = this.caps.get(capture_id);
    if (prior) return JSON.stringify(prior) === JSON.stringify(r) ? { status: "DUPLICATE_IDENTICAL" as const } : { status: "REFUSED" as const, reason: `capture ${capture_id} already exists with different content (rows are immutable)` };
    this.caps.set(capture_id, structuredClone(r)); return { status: "INSERTED" as const };
  }
  attachOutcome(o: WaiverOutcome) {
    if (!this.caps.has(o.capture_id)) return { status: "REFUSED" as const, reason: "outcome for an unknown capture" };
    const k = `${o.capture_id}|${o.source}`; const prior = this.outs.get(k);
    if (prior) return JSON.stringify(prior) === JSON.stringify(o) ? { status: "DUPLICATE_IDENTICAL" as const } : { status: "REFUSED" as const, reason: "outcomes are insert-only" };
    this.outs.set(k, structuredClone(o)); return { status: "INSERTED" as const };
  }
  list() { return [...this.caps.values()].map((x) => structuredClone(x)); } outcomes() { return [...this.outs.values()].map((x) => structuredClone(x)); }
}

/** Evidence gate: only LIVE_CAPTURED records with a later outcome count; nothing reconstructed, post-lock or unverified ever does. */
export const WAIVER2_EVIDENCE_MIN_WEEKS = 4;
export function waiver2EvidenceGate(store: WaiverCaptureStore): { status: "NOT_ELIGIBLE" | "ELIGIBLE_FOR_REVIEW"; eligible_records: number; distinct_weeks: number; excluded: Record<string, number>; reasons: string[] } {
  const outs = new Set(store.outcomes().map((o) => o.capture_id)); const excluded: Record<string, number> = {}; const weeks = new Set<string>(); let n = 0;
  for (const r of store.list()) { if (r.capture_kind !== "LIVE_CAPTURED") { excluded[r.capture_kind] = (excluded[r.capture_kind] ?? 0) + 1; continue; } if (!outs.has(r.capture_id)) { excluded["NO_OUTCOME_YET"] = (excluded["NO_OUTCOME_YET"] ?? 0) + 1; continue; } n += 1; weeks.add(`${r.season}-${r.week}`); }
  const ok = weeks.size >= WAIVER2_EVIDENCE_MIN_WEEKS;
  return { status: ok ? "ELIGIBLE_FOR_REVIEW" : "NOT_ELIGIBLE", eligible_records: n, distinct_weeks: weeks.size, excluded, reasons: ok ? ["enough distinct live weeks with outcomes; a SEPARATE certification is still required before any activation"] : [`${weeks.size}/${WAIVER2_EVIDENCE_MIN_WEEKS} distinct live weeks with outcomes`] };
}
