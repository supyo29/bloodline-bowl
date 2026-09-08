/**
 * Phase 8 §36 — Orchestrator decision capture.
 *
 * An ADDITIVE capture interface so a future `team-management-orchestrator-2026.2`
 * re-evaluation can score this policy against real 2026 management outcomes.
 * The DEFAULT store is a no-op (`NullCaptureStore`) — persistence infrastructure
 * is not approved for Phase 8, so nothing is written unless an operator wires a
 * real store via `setOrchestratorCaptureStore`.
 *
 * Manager compliance (`acted_upon`) is NEVER fabricated — it stays `"UNKNOWN"`
 * unless a downstream transaction-observation mechanism sets it.
 */

import type { OrchestratorCaptureStore, OrchestratorDecisionRecord, OrchestratorResult } from "./schema";

class NullCaptureStore implements OrchestratorCaptureStore {
  readonly kind = "null" as const;
  record(): void {
    /* no-op */
  }
}

/**
 * A bounded in-memory ring buffer — useful for tests and for a single-process
 * dev inspection. NOT durable; never the production default.
 */
export class MemoryCaptureStore implements OrchestratorCaptureStore {
  readonly kind = "memory" as const;
  private readonly buf: OrchestratorDecisionRecord[] = [];
  constructor(private readonly cap = 500) {}
  record(rec: OrchestratorDecisionRecord): void {
    this.buf.push(rec);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  all(): readonly OrchestratorDecisionRecord[] {
    return this.buf;
  }
  clear(): void {
    this.buf.length = 0;
  }
}

let store: OrchestratorCaptureStore = new NullCaptureStore();

export function getOrchestratorCaptureStore(): OrchestratorCaptureStore {
  return store;
}

export function setOrchestratorCaptureStore(next: OrchestratorCaptureStore | null): void {
  store = next ?? new NullCaptureStore();
}

/** Build the immutable as-of record for one Orchestrator result. */
export function toDecisionRecord(result: OrchestratorResult): OrchestratorDecisionRecord {
  const pa = result.primary_action;
  return {
    orchestrator_version: result.orchestrator_version,
    captured_at: new Date().toISOString(),
    league_slug: result.league_slug,
    manager_slug: result.manager_slug,
    roster_id: result.roster_id,
    league_snapshot_id: result.lineage.league_snapshot_id,
    scoring_fingerprint: result.lineage.scoring_fingerprint,
    season: result.lineage.season,
    week: result.lineage.week,
    verdict: result.verdict,
    primary_action: pa
      ? {
          action_class: pa.action_class,
          target_condition: pa.target_condition,
          remedy_kind: pa.remedy.kind,
          priority: pa.priority,
          urgency: pa.dimensions.urgency,
          expected_weekly_effect: pa.dimensions.expected_weekly_effect?.value ?? null,
          confidence: pa.dimensions.confidence,
          cost_band: pa.dimensions.cost.band,
          reason_codes: pa.reason_codes,
        }
      : null,
    secondary_action_count: result.secondary_actions.length,
    suppressed: result.suppressed_actions.map((s) => ({
      action_class: s.action.action_class,
      target_condition: s.action.target_condition,
      reasons: s.reasons,
    })),
    condition_codes: result.current_conditions.map((c) => c.code),
    watch_codes: result.future_watch_items.map((c) => c.code),
    hold_rationale: result.hold_rationale,
    specialist_versions: Object.fromEntries(
      Object.entries(result.lineage.specialists).map(([k, v]) => [k, v.version]),
    ),
    acted_upon: "UNKNOWN",
  };
}

/** Fire-and-forget capture. Never throws into the caller. */
export async function captureOrchestratorResult(result: OrchestratorResult): Promise<void> {
  try {
    if (store.kind === "null") return;
    await store.record(toDecisionRecord(result));
  } catch {
    /* capture is best-effort — never breaks a recommendation */
  }
}
