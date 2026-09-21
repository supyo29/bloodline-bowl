/** Phase 4.5 — read-only performance measurement: build once, consume many. */
import { loadMarketSnapshot, __clearMarketMemo } from "@/lib/market-state/load";
import { buildFreeAgentPool } from "@/lib/market-state/pool";
import { compactMarketSnapshot } from "@/lib/market-state/history";
import { buildWaiverInputForManager } from "@/lib/waiver2/adapter";
import { evaluateWaiver2 } from "@/lib/waiver2/actions";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
const ms = async <T>(f: () => Promise<T> | T): Promise<[number, T]> => { const t = performance.now(); const v = await f(); return [Math.round(performance.now() - t), v]; };
(async () => {
  const league = "bloodline-bowl"; const week = 2;
  const [cold] = await ms(() => loadMarketSnapshot(league, { week, noMemo: true })); // first call also downloads the 12k-player universe
  const warm: number[] = []; for (let i = 0; i < 5; i++) warm.push((await ms(() => loadMarketSnapshot(league, { week, noMemo: true })))[0]);
  const [memo1] = await ms(() => loadMarketSnapshot(league, { week })); const [memo2] = await ms(() => loadMarketSnapshot(league, { week }));
  const snap = await loadMarketSnapshot(league, { week }); const [poolMs] = await ms(() => buildFreeAgentPool(snap)); const [compactMs, c] = await ms(() => compactMarketSnapshot(snap));
  console.log(JSON.stringify({ cold_first_ms: cold, warm_uncached_ms: warm, memo_first_ms: memo1, memo_hit_ms: memo2, pool_build_ms: poolMs, compact_ms: compactMs, snapshot_players: snap.players.length, compact_json_kb: Math.round(JSON.stringify(c).length / 1024), full_json_kb: Math.round(JSON.stringify(snap).length / 1024) }));
  const st = await buildCanonicalLeagueState(league, { reportPersistence: false }); const mgrs = st.snapshot!.managers.slice(0, 6);
  __clearMarketMemo(); const t0 = performance.now(); let evalMs = 0; const markets = new Set<string>();
  for (const m of mgrs) { const r = await buildWaiverInputForManager(league, m.manager_slug); if (!r.ok) continue; markets.add(r.input.pool.market!.market_content_id); const [e] = await ms(() => evaluateWaiver2(r.input)); evalMs += e; }
  console.log(JSON.stringify({ managers: mgrs.length, total_ms: Math.round(performance.now() - t0), per_manager_ms: Math.round((performance.now() - t0) / mgrs.length), eval_ms_total: evalMs, distinct_market_ids_across_managers: markets.size, note: "one market read shared via the 30s memo" }));
})();
