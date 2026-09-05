/**
 * Trade Engine — Phase 5G: manager-specific behavioral evidence framework.
 *
 * Deliberately conservative: the real historical sample
 * (`lib/trades/historical-loader.ts`) is 1 completed trade across all
 * registered leagues. This module NEVER infers a tendency from that sample.
 * `status` is `INSUFFICIENT_DATA` for every manager until a real, per-manager
 * trade count clears a documented threshold — and even then, `confidence`
 * caps at what the threshold table says, never silently promoted.
 *
 * Forbidden outputs, permanently, until real evidence exists: personality
 * claims ("stubborn", "aggressive"), unsupported preference claims ("loves
 * rookies", "always overpays"). This module cannot produce those strings —
 * there is no code path that emits free-form personality text at all.
 */

import { loadRealHistoricalTradeRecords } from "../historical-loader";
import { behavioralConfidence } from "./config";
import type { ManagerBehaviorEvidence } from "./types";

/** Counts real, completed trades a specific manager (by canonical id embedded in the ingested record's participants) has been party to. */
function countManagerTrades(managerId: string): number {
  const dataset = loadRealHistoricalTradeRecords();
  let count = 0;
  for (const record of dataset.records) {
    const proposal = record.proposal as { participants?: Array<{ roster_id?: number; owner_user_id?: string | null }> } | undefined;
    const participants = proposal?.participants ?? [];
    if (participants.some((p) => p.owner_user_id === managerId || String(p.roster_id) === managerId)) count += 1;
  }
  return count;
}

export function buildManagerBehaviorEvidence(managerId: string): ManagerBehaviorEvidence {
  const completed_trade_count = countManagerTrades(managerId);
  const confidence = behavioralConfidence(completed_trade_count);
  // Even at "possible behavioral review" (10+), this module does not enable
  // behavioral output — that requires an explicit future phase to define what
  // a supported behavioral claim looks like and validate it. Today: always
  // structural-only.
  return {
    manager_id: managerId,
    completed_trade_count,
    confidence,
    status: "INSUFFICIENT_DATA",
    note:
      completed_trade_count === 0
        ? "No real completed trades found for this manager. Negotiation advice is structural (roster-derived) only."
        : `${completed_trade_count} real completed trade(s) found for this manager — below every threshold this repository treats as sufficient for a behavioral claim. Negotiation advice remains structural (roster-derived) only.`,
  };
}
