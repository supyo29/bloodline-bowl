/** Phase 5 — runs the REAL scheduled capture against an IN-MEMORY store (no database write): duration, classes, dedupe, gate. */
import { MemoryMatchup2CaptureStore, matchup2EvidenceGate } from "@/lib/matchup2/capture";
import { __setMatchup2CaptureStore, __resetMatchup2CaptureHealth, runScheduledMatchup2Capture } from "@/lib/persistence/supabase/matchup2-capture";
(async () => {
  const mem = new MemoryMatchup2CaptureStore(); __setMatchup2CaptureStore(mem); __resetMatchup2CaptureHealth();
  for (const run of [1, 2]) { const t = Date.now(); const r = await runScheduledMatchup2Capture(); console.log(JSON.stringify({ run, ms: Date.now() - t, failures: r.failures, by_class: r.by_class, by_status: r.by_status, leagues: r.leagues })); }
  const rows = mem.list(); const g = matchup2EvidenceGate(rows, []); const r0 = rows[0] ?? ({} as never);
  console.log(JSON.stringify({ rows: rows.length, players: new Set(rows.map((r) => r.player.gsis_id)).size, by_position: rows.reduce((a: Record<string, number>, r) => ((a[r.player.position] = (a[r.player.position] ?? 0) + 1), a), {}), verdicts: rows.reduce((a: Record<string, number>, r) => ((a[r.structural_verdict] = (a[r.structural_verdict] ?? 0) + 1), a), {}), gate: g.status, eligible: g.eligible_decisions, excluded: g.excluded, sample: rows.length ? { p: r0.player, opp: r0.opponent, cls: r0.capture_class, lock: r0.lock?.reason, fp: r0.scoring_fingerprint, baseline: r0.baseline?.projected_points, comps: r0.components.length } : null }));
})();
