/** Phase 4.5 merge task — read-only extra live checks: stale identities, DEF, cross-league ownership, manager overlay. No writes. */
import { loadMarketSnapshot } from "@/lib/market-state/load";
import { buildFreeAgentPool, managerAcquisitionContext } from "@/lib/market-state/pool";
import type { MarketSnapshot } from "@/lib/market-state/contract";
import { listLeagueTargets } from "@/lib/leagues/registry";
(async () => {
  const leagues = listLeagueTargets().filter((t) => t.provider === "sleeper").map((t) => t.key); const snaps: Record<string, MarketSnapshot> = Object.fromEntries(await Promise.all(leagues.map(async (l) => [l, await loadMarketSnapshot(l, { week: 2, noMemo: true })] as const)));
  const p = await (await fetch("https://api.sleeper.app/v1/players/nfl")).json() as Record<string, { full_name?: string; status?: string; active?: boolean; team?: string }>;
  const stale = Object.entries(p).filter(([, v]) => v.team && v.active === false).map(([id, v]) => ({ id, name: v.full_name, status: v.status }));
  console.log("stale/active=false directory rows with a team:", stale.length);
  for (const l of leagues) { const s = snaps[l]!; const st = stale.map((x) => s.players.find((q) => q.provider_player_id === x.id)?.status ?? "NOT_LISTED(ineligible/excluded)"); const leaked = stale.filter((x) => s.players.find((q) => q.provider_player_id === x.id)?.status === "AVAILABLE_FREE_AGENT").length; console.log(l, "stale statuses:", JSON.stringify(Object.entries(st.reduce((a: Record<string, number>, k) => ((a[k] = (a[k] ?? 0) + 1), a), {}))), "leaked as AVAILABLE:", leaked); }
  const dup = Object.entries(p).find(([, v]) => /^duplicate/i.test(v.full_name ?? "")); console.log("directory still contains 'Duplicate Player' rows (preserved, not removed):", Object.values(p).filter((v) => /^duplicate/i.test(v.full_name ?? "")).length, dup?.[0]);
  for (const l of leagues) { const s = snaps[l]!; const defs = s.players.filter((x) => x.entity === "TEAM_DEFENSE"); const pool = buildFreeAgentPool(s); console.log(l, "DEF entities:", defs.length, "rostered", defs.filter((d) => d.status === "ROSTERED").length, "available", defs.filter((d) => d.status === "AVAILABLE_FREE_AGENT").length, "in DEF positional pool", pool.by_position.DEF?.length ?? 0, "bad", defs.filter((d) => d.position !== "DEF" || !d.team).length); }
  // cross-league: same provider player id, different status
  const ids = new Map<string, Record<string, string>>(); for (const l of leagues) for (const x of snaps[l]!.players) { const m = ids.get(x.provider_player_id) ?? {}; m[l] = x.status; ids.set(x.provider_player_id, m); }
  const ex = [...ids.entries()].filter(([, m]) => Object.keys(m).length === leagues.length && new Set(Object.values(m)).size > 1 && Object.values(m).includes("ROSTERED") && Object.values(m).includes("AVAILABLE_FREE_AGENT")).slice(0, 5);
  for (const [id, m] of ex) console.log("cross-league", id, p[id]?.full_name, JSON.stringify(m));
  console.log("league content ids:", leagues.map((l) => snaps[l]!.identities.market_content_id).join(" "), "distinct:", new Set(leagues.map((l) => snaps[l]!.identities.market_content_id)).size);
  const b = snaps["bloodline-bowl"]!; const pool = buildFreeAgentPool(b); const ctxs = b.acquisition.teams.slice(0, 3).map((t) => managerAcquisitionContext(b, t.team_id)); console.log("manager overlay over ONE pool", pool.pool_id, JSON.stringify(ctxs.map((c) => ({ faab: c?.faab_remaining, prio: c?.waiver_priority, open: c?.open_roster_slots, dropNeeded: c?.requires_drop }))));
})();
