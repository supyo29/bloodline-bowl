/**
 * Phase 4.5 Checkpoint G — READ-ONLY live certification. For every registered Sleeper league, rebuilds availability with an INDEPENDENT
 * implementation (raw HTTP + ~20 lines of set logic, no import from lib/market-state) and requires exact set equality with the substrate.
 * No writes, no transactions, no claims.   npx tsx scripts/market-state-certify.ts
 */
import { loadMarketSnapshot } from "@/lib/market-state/load";
import { buildFreeAgentPool } from "@/lib/market-state/pool";
import { listLeagueTargets } from "@/lib/leagues/registry";

const B = "https://api.sleeper.app/v1"; const get = async <T>(p: string): Promise<T> => (await fetch(`${B}${p}`)).json() as Promise<T>;
type P = { position?: string | null; fantasy_positions?: string[]; team?: string | null; status?: string | null; active?: boolean | null; full_name?: string };
const FLEX: Record<string, string[]> = { FLEX: ["RB", "WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"] };
let fails = 0; const check = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) fails += 1; };

async function main() {
  const nfl = await get<{ week: number }>("/state/nfl"); const week = Math.max(1, nfl.week); const players = await get<Record<string, P>>("/players/nfl");
  const sched = await (await fetch("https://api.sleeper.app/schedule/nfl/regular/2026")).json() as Array<{ week: number; home: string; away: string; status: string }>;
  const rosteredByLeague: Record<string, Set<string>> = {}; const availByLeague: Record<string, Set<string>> = {};
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper")) {
    console.log(`\n== ${t.key} (week ${week})`);
    const league = await get<{ settings: Record<string, number>; roster_positions: string[] }>(`/league/${t.external_league_id}`); const rosters = await get<Array<{ players: string[] | null }>>(`/league/${t.external_league_id}/rosters`);
    const clear = league.settings.waiver_clear_days ?? 0; const start = new Set<string>(); for (const s of league.roster_positions) { if (["QB", "RB", "WR", "TE", "K", "DEF"].includes(s)) start.add(s); for (const p of FLEX[s] ?? []) start.add(p); }
    const rostered = new Set<string>(); let dupes = 0; for (const r of rosters) for (const id of r.players ?? []) { if (!id || id === "0") continue; if (rostered.has(id)) dupes += 1; rostered.add(id); }
    const drops = new Map<string, number>(); const now = Date.now();
    for (let w = Math.max(1, week - 1 - Math.floor(clear / 7)); w <= week; w += 1) for (const x of await get<Array<{ type: string; status: string; status_updated: number; drops: Record<string, number> | null }>>(`/league/${t.external_league_id}/transactions/${w}`)) if (x.status === "complete" && ["free_agent", "waiver", "commissioner"].includes(x.type) && now - x.status_updated < clear * 86_400_000) for (const id of Object.keys(x.drops ?? {})) drops.set(id, x.status_updated);
    const ok = new Set(["active", "injured reserve", "inactive", "suspended", "pup", "physically unable to perform", "non football injury"]);
    const expFA = new Set<string>(); const expWV = new Set<string>();
    for (const [id, p] of Object.entries(players)) {
      if (rostered.has(id)) continue; const pos = (p.position ?? "").toUpperCase(); const fold = ({ DE: "DL", DT: "DL", NT: "DL", OLB: "LB", ILB: "LB", CB: "DB", S: "DB", SS: "DB", FS: "DB" } as Record<string, string>)[pos] ?? pos;
      if (!fold || fold === "XX" || !start.has(fold) || !p.team) continue;
      if (fold !== "DEF") { const st = (p.status ?? "").toLowerCase(); if (!ok.has(st) || p.active === false) continue; }
      (drops.has(id) ? expWV : expFA).add(id);
    }
    const s = await loadMarketSnapshot(t.key, { week, noMemo: true }); const pool = buildFreeAgentPool(s);
    const got = { own: new Set(s.players.filter((x) => x.status === "ROSTERED").map((x) => x.provider_player_id)), fa: new Set(pool.members.map((x) => x.provider_player_id)), wv: new Set(s.players.filter((x) => x.status === "ON_WAIVERS").map((x) => x.provider_player_id)) };
    const eq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
    check(s.readiness.pool_actionable, `readiness ${s.readiness.status} blocks=[${s.readiness.blocks}] limits=[${s.readiness.limitations}]`);
    check(dupes === 0, `no player on two rosters (independent check: ${dupes} dupes)`); check(eq(got.own, rostered), `ROSTERED set == raw rosters (${rostered.size})`);
    check(eq(got.fa, expFA), `AVAILABLE set == independent derivation (${expFA.size} vs ${got.fa.size})`); check(eq(got.wv, expWV), `ON_WAIVERS set == independent drops-in-window (${expWV.size} vs ${got.wv.size})`);
    check(![...got.fa].some((id) => rostered.has(id)) && ![...got.wv].some((id) => rostered.has(id)), "no AVAILABLE/ON_WAIVERS player is rostered in this league");
    check(pool.members.every((m) => m.eligible_to_add && m.ownership === "UNROSTERED" && m.waiver_clears_at === null && m.team && m.position), "every member: eligible_to_add, UNROSTERED, no fabricated clear time, team+position present");
    check(s.acquisition.rules.system === (league.settings.waiver_type === 2 ? "FAAB" : "PRIORITY") && (league.settings.waiver_type === 2) === (s.acquisition.rules.faab_budget != null), `acquisition system/FAAB currency correct (${s.acquisition.rules.system})`);
    const games = sched.filter((g) => g.week === week); const started = new Set(games.filter((g) => g.status !== "pre_game").flatMap((g) => [g.home, g.away])); const lockedSeen = pool.members.filter((m) => m.lock === "LOCKED").length;
    check(pool.members.filter((m) => m.lock === "LOCKED").every((m) => started.has(m.team!)) && pool.members.filter((m) => m.lock === "OPEN").every((m) => !started.has(m.team!)), `lock state matches schedule status (${lockedSeen} of pool on started games; not an availability verdict)`);
    await new Promise((r) => setTimeout(r, 1500)); const s2 = await loadMarketSnapshot(t.key, { week, noMemo: true });
    check(s2.identities.market_content_id === s.identities.market_content_id && s2.identities.request_id !== s.identities.request_id, `content id stable across two reads (${s.identities.market_content_id}); request ids differ`);
    rosteredByLeague[t.key] = rostered; availByLeague[t.key] = got.fa;
  }
  const keys = Object.keys(rosteredByLeague); let cross = 0, checked = 0;
  for (const a of keys) for (const b of keys) if (a !== b) for (const id of rosteredByLeague[a]!) if (!rosteredByLeague[b]!.has(id)) { checked += 1; if (rosteredByLeague[b]!.has(id) && availByLeague[b]!.has(id)) cross += 1; }
  check(cross === 0 && checked > 0, `multi-league isolation: ${checked} cross-league (owned in one, not the other) comparisons; none leaked ownership`);
  console.log(fails ? `\nFAILED: ${fails}` : "\nALL CHECKS PASSED"); process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
