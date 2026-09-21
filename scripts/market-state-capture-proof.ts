/** Phase 4.5 — proves a certified market pool yields ranked shadow captures through the REAL runtime path, against an IN-MEMORY store (no database write). */
import { buildWaiverInputForManager } from "@/lib/waiver2/adapter";
import { evaluateWaiver2 } from "@/lib/waiver2/actions";
import { MemoryWaiverCaptureStore, evaluationEligibility, validateCaptureRecord, waiver2EvidenceGate } from "@/lib/waiver2/capture";
import { persistWaiver2Evidence, __setWaiver2CaptureStore, __clearWaiver2SeenCache } from "@/lib/persistence/supabase/waiver2-capture-runtime";
import { persistMarketSnapshot, __setMarketSnapshotStore } from "@/lib/persistence/supabase/market-state";
import { MemoryMarketSnapshotStore } from "@/lib/market-state/history";

(async () => {
  const mem = new MemoryWaiverCaptureStore(); __setWaiver2CaptureStore(mem); const msnap = new MemoryMarketSnapshotStore(); __setMarketSnapshotStore(msnap); __clearWaiver2SeenCache();
  for (const [league, manager] of [["bloodline-bowl", "msamuel4"], ["devoted-to-the-game", "lashespn"]] as const) {
    for (let pass = 1; pass <= 3; pass++) {
      const r = await buildWaiverInputForManager(league, manager); if (!r.ok) throw new Error(r.code); const ev = evaluateWaiver2(r.input);
      const snapOut = pass === 1 ? (await persistMarketSnapshot(r.input.pool.market_snapshot!, { minIntervalMs: 0 })).status : "-";
      const out = await persistWaiver2Evidence(ev, r.input, { league_slug: league, manager_slug: manager, season: 2026, illustrative: false }, { minIntervalMs: 0 });
      console.log(JSON.stringify({ league, manager, pass, market_snapshot: snapOut, capture: out.status, class: out.capture_class, id: out.capture_id }));
    }
  }
  const rows = mem.list(); const r0 = rows[0]!;
  console.log(JSON.stringify({ rows: rows.length, classes: rows.map((r) => r.capture_class), record_types: rows.map((r) => r.record_type), valid: rows.every((r) => validateCaptureRecord(r).length === 0),
    market: r0.market, candidate_count: r0.pool.candidate_count, actions: r0.actions.length, top: r0.actions[0] && { tier: r0.actions[0].tier, alt: r0.actions[0].alternatives.length, faab: r0.actions[0].faab, uncertainty_components: r0.actions[0].uncertainty.components.length }, pass_recommended: r0.pass_recommended, roster_hash: r0.roster.roster_hash, scoring: r0.scoring_fingerprint, lock: r0.lock && { verdict: r0.lock.verdict, reason: r0.lock.reason },
    eligibility_now: evaluationEligibility(r0, false).reasons, gate: waiver2EvidenceGate(rows, []).status, market_snapshots_stored: msnap.rows.size }));
})();
