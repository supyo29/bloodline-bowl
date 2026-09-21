/** Phase 4.5 — read-only: Waiver 2.0 evaluation consuming the canonical market state, for every manager of every Sleeper league. No capture write, no claim. */
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { buildWaiverInputForManager } from "@/lib/waiver2/adapter";
import { evaluateWaiver2 } from "@/lib/waiver2/actions";
import { listLeagueTargets } from "@/lib/leagues/registry";

async function main() {
  const only = process.argv[2]; const perLeague = Number(process.argv[3] ?? 2);
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper" && (!only || x.key === only))) {
    const st = await buildCanonicalLeagueState(t.key, { reportPersistence: false }); if (!st.snapshot) { console.log(t.key, "state unavailable", st.code); continue; }
    for (const m of st.snapshot.managers.slice(0, perLeague)) {
      const t0 = Date.now(); const r = await buildWaiverInputForManager(t.key, m.manager_slug); const build = Date.now() - t0;
      if (!r.ok) { console.log(JSON.stringify({ league: t.key, manager: m.manager_slug, ok: false, code: r.code })); continue; }
      const t1 = Date.now(); const ev = evaluateWaiver2(r.input); const evalMs = Date.now() - t1;
      const top = ev.recommended; 
      console.log(JSON.stringify({ league: t.key, manager: m.manager_slug, buildMs: build, evalMs, avail: ev.availability.status, cert: ev.availability.certification, market: r.input.pool.market, actions: ev.actions.length, rec: top ? { add: top.candidate?.name, drop: top.drop?.name, tier: top.tier, net: top.net_action_value } : null, pass: ev.pass ? true : false, deployment: ev.deployment }));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
