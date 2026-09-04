/**
 * Trade Engine — Phase 3D/3E: historical-retrospective FRAMEWORK.
 *
 * This module defines the SHAPE of a historical trade record and a strict
 * no-look-ahead guard. It does NOT ingest real Bloodline Bowl trade history —
 * this environment has no network access to pull completed trades from the
 * provider, and the calibration report documents that as a data limitation,
 * not a defect. The framework exists so a richer historical dataset can be
 * plugged in later without a redesign (per the Phase 3A mandate: "do not
 * require external historical data to begin").
 *
 * The one rule that must never be violated: model INPUTS may only reflect
 * information available AT OR BEFORE the trade date. OUTCOME data is allowed,
 * and is expected, to be later — it is the evaluation target, never a model
 * input. `assertNoLookahead` enforces the timestamp ordering that makes this
 * checkable mechanically, not just by convention.
 */

export interface HistoricalOutcome {
  /** ISO timestamp through which the outcome was measured — must be AFTER trade_date. */
  evaluated_through: string;
  starter_points_added_after_trade: number | null;
  ros_points_realized: number | null;
  weeks_started: number | null;
  replacement_adjusted_realized_value: number | null;
  playoff_week_contribution: number | null;
  availability_note: string | null;
}

export interface HistoricalTradeRecord {
  trade_id: string;
  league_slug: string;
  /** ISO timestamp the trade was made/accepted. */
  trade_date: string;
  /** ISO timestamp the canonical snapshot used as model input was captured — MUST be <= trade_date. */
  input_snapshot_captured_at: string;
  /** the exact TradeProposal evaluated, in canonical ids */
  proposal: unknown;
  /** free-form record of which Phase 1/2/3 inputs were used, for audit */
  model_inputs_summary: Record<string, unknown>;
  /** null until the outcome window has been observed */
  outcome: HistoricalOutcome | null;
  /** optional deterministic human label (used when historical samples are too few) */
  human_label: "CLEARLY_POSITIVE" | "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "CLEARLY_NEGATIVE" | null;
  /** why the human label was assigned, when present — required for auditability */
  human_label_reason: string | null;
}

export interface LookaheadCheck {
  ok: boolean;
  violations: string[];
}

/**
 * Mechanically verifies a historical record does not leak future information
 * into model inputs. This checks TIMESTAMP ORDERING, which is necessary but
 * not sufficient (it cannot detect a value that was correctly timestamped but
 * numerically computed using future data) — treat it as a floor, not a proof.
 */
export function assertNoLookahead(record: HistoricalTradeRecord): LookaheadCheck {
  const violations: string[] = [];
  const tradeDate = Date.parse(record.trade_date);
  const snapDate = Date.parse(record.input_snapshot_captured_at);

  if (Number.isNaN(tradeDate)) violations.push("trade_date is not a valid ISO timestamp");
  if (Number.isNaN(snapDate)) violations.push("input_snapshot_captured_at is not a valid ISO timestamp");
  if (!Number.isNaN(tradeDate) && !Number.isNaN(snapDate) && snapDate > tradeDate) {
    violations.push(`input_snapshot_captured_at (${record.input_snapshot_captured_at}) is AFTER trade_date (${record.trade_date}) — model inputs would leak future state`);
  }
  if (record.outcome) {
    const outDate = Date.parse(record.outcome.evaluated_through);
    if (Number.isNaN(outDate)) violations.push("outcome.evaluated_through is not a valid ISO timestamp");
    else if (outDate <= tradeDate) {
      violations.push(`outcome.evaluated_through (${record.outcome.evaluated_through}) must be strictly AFTER trade_date (${record.trade_date}) — it is the evaluation target, not a model input`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** A record is usable for calibration only once BOTH the input snapshot and (if scored) the outcome pass the guard. */
export function isUsableForCalibration(record: HistoricalTradeRecord): boolean {
  return assertNoLookahead(record).ok;
}

export interface HistoricalDatasetSummary {
  total_records: number;
  records_with_outcome: number;
  records_with_human_label: number;
  lookahead_violations: number;
}

export function summarizeHistoricalDataset(records: HistoricalTradeRecord[]): HistoricalDatasetSummary {
  return {
    total_records: records.length,
    records_with_outcome: records.filter((r) => r.outcome != null).length,
    records_with_human_label: records.filter((r) => r.human_label != null).length,
    lookahead_violations: records.filter((r) => !assertNoLookahead(r).ok).length,
  };
}
