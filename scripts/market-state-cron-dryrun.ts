/** Phase 4.5 merge task — runs the REAL scheduled-capture function against in-memory stores (no database write) to measure duration and classes. */
import { MemoryWaiverCaptureStore, waiver2EvidenceGate } from "@/lib/waiver2/capture";
import { __setWaiver2CaptureStore, runScheduledWaiver2Capture, __clearWaiver2SeenCache } from "@/lib/persistence/supabase/waiver2-capture-runtime";
import { MemoryMarketSnapshotStore } from "@/lib/market-state/history";
import { __setMarketSnapshotStore, __resetMarketSnapshotRuntime } from "@/lib/persistence/supabase/market-state";
(async () => {
  const mem = new MemoryWaiverCaptureStore(); const ms = new MemoryMarketSnapshotStore(); __setWaiver2CaptureStore(mem); __setMarketSnapshotStore(ms); __clearWaiver2SeenCache(); __resetMarketSnapshotRuntime();
  for (const run of [1, 2]) { const t = Date.now(); const r = await runScheduledWaiver2Capture(); console.log(JSON.stringify({ run, duration_ms: Date.now() - t, failures: r.failures, leagues: r.leagues })); }
  const rows = mem.list(); console.log(JSON.stringify({ rows: rows.length, classes: rows.reduce((a: Record<string, number>, r) => ((a[r.capture_class] = (a[r.capture_class] ?? 0) + 1), a), {}), invocation: [...new Set(rows.map((r) => r.provenance?.invocation))], market_snapshots: ms.rows.size, gate: waiver2EvidenceGate(rows, []).status, eligible: waiver2EvidenceGate(rows, []).eligible_records }));
})();
