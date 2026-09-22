/**
 * Phase 9 Steps 13-15 — Waiver2 outcome ingestion. Waiver2's OWN `WaiverOutcome` type (`lib/waiver2/capture.ts`)
 * already separates market/action (`claim_result`, `winning_bid`, `winning_manager`) from performance
 * (`realized.*`) — Phase 9 populates it honestly, it does not redesign it.
 *
 * MARKET/ACTION is joined against REAL league transactions (never inferred from "manager didn't add the
 * player" — that could mean the manager never saw the recommendation, so a not-executed recommendation is
 * neutrally `NOT_SUBMITTED`, never `REJECTED`). PERFORMANCE (`realized.*`) needs multi-week roster tracking
 * (survival weeks, subsequent starts) that a single completed-week audit cannot honestly produce; those fields
 * are left `null` here with the limitation stated on the record, never fabricated (Step 15/25 limitation).
 */
import type { WaiverOutcome } from "@/lib/waiver2/capture";
import type { RawTransaction } from "@/lib/sleeper/types";

export interface Waiver2CaptureRow {
  capture_id: string; capture_class: string; record_type: string; season: number; week: number;
  league_slug: string; manager_slug: string; scoring_fingerprint: string | null;
  record: { recommended_id: string | null; roster: { team_id: string } };
}

/** Resolves a canonical `player:sleeper:<id>` to a bare Sleeper id for the transaction join. Any other identity scheme is unresolvable (never guessed). */
function bareSleeperId(canonicalId: string | null): string | null {
  if (!canonicalId) return null;
  const m = /^player:sleeper:(.+)$/.exec(canonicalId);
  return m ? m[1]! : null;
}

export interface Waiver2Finding { capture_id: string; executed: boolean; claimed_by_other: boolean; outcome: WaiverOutcome }

/**
 * `rosterIdToManagerSlug` resolves a league's numeric roster_id to the manager_slug the capture used — needed to
 * tell "this manager executed the recommendation" apart from "someone else claimed the same player".
 */
export function buildWaiver2Outcomes(
  captures: readonly Waiver2CaptureRow[],
  transactionsByLeague: ReadonlyMap<string, readonly RawTransaction[]>,
  rosterIdToManagerSlug: (leagueSlug: string, rosterId: number) => string | null,
  source = "sleeper-transactions:v1",
): Waiver2Finding[] {
  const out: Waiver2Finding[] = [];
  for (const cap of captures) {
    if (cap.capture_class !== "LIVE_CAPTURED" || !cap.record.recommended_id) continue;
    const sid = bareSleeperId(cap.record.recommended_id);
    const txns = transactionsByLeague.get(cap.league_slug) ?? [];
    if (!sid) {
      out.push({ capture_id: cap.capture_id, executed: false, claimed_by_other: false, outcome: { capture_id: cap.capture_id, source, recorded_at: new Date().toISOString(), claim_result: "UNKNOWN", winning_bid: null, winning_manager: null, candidate_unclaimed: null, realized: { candidate_points_started: null, drop_points_lost: null, role_share_change: null, roster_survival_weeks: null, best_alternative_points_started: null } } });
      continue;
    }
    // completed waiver/free-agent transactions that ADD this player, most-recent first
    const hits = txns.filter((t) => t.status === "complete" && (t.type === "waiver" || t.type === "free_agent") && t.adds && Object.prototype.hasOwnProperty.call(t.adds, sid)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    if (!hits.length) {
      out.push({ capture_id: cap.capture_id, executed: false, claimed_by_other: false, outcome: { capture_id: cap.capture_id, source, recorded_at: new Date().toISOString(), claim_result: "NOT_SUBMITTED", winning_bid: null, winning_manager: null, candidate_unclaimed: true, realized: { candidate_points_started: null, drop_points_lost: null, role_share_change: null, roster_survival_weeks: null, best_alternative_points_started: null } } });
      continue;
    }
    const winner = hits[0]!;
    const winnerRosterId = winner.adds![sid]!;
    const winnerSlug = rosterIdToManagerSlug(cap.league_slug, winnerRosterId);
    const bid = winner.waiver_budget?.find((b) => b.receiver === winnerRosterId)?.amount ?? (winner.settings?.waiver_bid ?? null);
    const executed = winnerSlug === cap.manager_slug;
    // Sleeper's transaction feed exposes only the WINNING claim, never a losing bid — so a player claimed by
    // someone else is UNKNOWN for this manager (we cannot tell "tried and lost" from "never tried"), never
    // asserted "LOST" (that would be an unsupported inference — see Step 14's REJECTED/RECOMMENDATION_NOT_EXECUTED guidance).
    out.push({ capture_id: cap.capture_id, executed, claimed_by_other: !executed, outcome: { capture_id: cap.capture_id, source, recorded_at: new Date().toISOString(), claim_result: executed ? "WON" : "UNKNOWN", winning_bid: bid, winning_manager: winnerSlug, candidate_unclaimed: false, realized: { candidate_points_started: null, drop_points_lost: null, role_share_change: null, roster_survival_weeks: null, best_alternative_points_started: null } } });
  }
  return out;
}
