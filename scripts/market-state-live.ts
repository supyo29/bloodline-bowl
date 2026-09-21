/** Phase 4.5 — read-only live probe of the market-state substrate for every registered Sleeper league. No writes, no transactions. */
import { loadMarketSnapshot } from "@/lib/market-state/load";
import { buildFreeAgentPool } from "@/lib/market-state/pool";
import { listLeagueTargets } from "@/lib/leagues/registry";
import { getNflState } from "@/lib/sleeper/client";

async function main() {
  const nfl = await getNflState().catch(() => null); const week = Math.max(1, Number((nfl as { week?: number } | null)?.week ?? 1));
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper")) {
    const t0 = Date.now(); const s = await loadMarketSnapshot(t.key, { week, noMemo: true }); const ms = Date.now() - t0;
    const t1 = Date.now(); const pool = buildFreeAgentPool(s); const poolMs = Date.now() - t1;
    console.log(JSON.stringify({ league: t.key, week, ms, poolMs, status: s.readiness.status, actionable: s.readiness.pool_actionable, blocks: s.readiness.blocks, limitations: s.readiness.limitations, counts: s.counts, ineligible: s.ineligible_counts, pool: pool.members.length, byPos: Object.fromEntries(Object.entries(pool.by_position).map(([k, v]) => [k, v.length])), system: s.acquisition.rules.system, clear: s.acquisition.rules.waiver_clear_days, content: s.identities.market_content_id, acq: s.acquisition.context_id, sample: pool.members.slice(0, 3).map((m) => `${m.full_name}/${m.position}/${m.team}`), waivers: pool.on_waivers.map((m) => `${m.full_name}@${m.waiver_window?.dropped_at}`) }));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
