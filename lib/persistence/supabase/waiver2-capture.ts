/**
 * Supabase-backed DURABLE store for Waiver Intelligence 2.0 prospective shadow evidence (Phase 4).
 * Tables: public.bridge_waiver2_shadow_captures / _outcomes (INSERT-only, enforced by trigger; class/record-type/pool consistency
 * enforced by CHECK constraints). Idempotency is the DATABASE primary key (`capture_id`). The store re-validates every record with the
 * same `validateCaptureRecord` the memory store uses, so an invalid class can never reach the database from this code path.
 * Telemetry only: nothing on a ranking path reads these tables.
 */
import { validateCaptureRecord, waiver2EvidenceGate, type WaiverCaptureStore, type WaiverEvidenceGate, type WaiverOutcome, type WaiverShadowCaptureRecord, type WriteResult } from "@/lib/waiver2/capture";
import { SupabaseRest } from "./rest";

const CAPTURES = "bridge_waiver2_shadow_captures";
const OUTCOMES = "bridge_waiver2_shadow_outcomes";
const GATE_ROW_CAP = 5000;

export function captureRow(r: WaiverShadowCaptureRecord): Record<string, unknown> {
  return { capture_id: r.capture_id, capture_class: r.capture_class, record_type: r.record_type, season: r.season, week: r.week, league_slug: r.league_slug, manager_slug: r.manager_slug, scoring_fingerprint: r.scoring_fingerprint, model_version: r.model_version, lifecycle_state: r.lifecycle_state, params_hash: r.params_hash, snapshot_id: r.snapshot.id, pool_certification: r.pool.certification, lock_verdict: r.lock?.verdict ?? null, content_hash: r.content_hash, record_schema_version: r.schema_version, record: r };
}

export class SupabaseWaiverCaptureStore implements WaiverCaptureStore {
  readonly kind = "supabase"; readonly durable = true;
  constructor(private readonly rest: SupabaseRest) {}
  async record(r: WaiverShadowCaptureRecord): Promise<WriteResult> {
    const base = { store_kind: this.kind, durable: true }; const errs = validateCaptureRecord(r);
    if (errs.length) return { ...base, status: "REFUSED", reason: errs.join("; ") };
    try { const ins = await this.rest.insertIgnoreDuplicates<{ capture_id: string }>(CAPTURES, [captureRow(r)], ["capture_id"]); return { ...base, status: ins.length > 0 ? "INSERTED" : "DUPLICATE_IDENTICAL" }; }
    catch (e) { return { ...base, status: "ERROR", reason: e instanceof Error ? e.message : String(e) }; }
  }
  async attachOutcome(o: WaiverOutcome): Promise<WriteResult> {
    const base = { store_kind: this.kind, durable: true };
    try { const ins = await this.rest.insertIgnoreDuplicates<{ capture_id: string }>(OUTCOMES, [{ capture_id: o.capture_id, source: o.source, outcome: o }], ["capture_id", "source"]); return { ...base, status: ins.length > 0 ? "INSERTED" : "DUPLICATE_IDENTICAL" }; }
    catch (e) { return { ...base, status: "ERROR", reason: e instanceof Error ? e.message : String(e) }; }
  }
  /** Read-only evidence gate over the durable rows (bounded). Never promotes anything. */
  async gate(): Promise<WaiverEvidenceGate> {
    const recs = await this.rest.select<{ record: WaiverShadowCaptureRecord }>(CAPTURES, { select: "record", filter: { capture_class: "eq.LIVE_CAPTURED" }, order: "captured_at.asc", limit: GATE_ROW_CAP });
    const outs = await this.rest.select<{ capture_id: string }>(OUTCOMES, { select: "capture_id", limit: GATE_ROW_CAP });
    return waiver2EvidenceGate(recs.map((x) => x.record), outs);
  }
}
