/**
 * PHASE 5 — real-league, read-only negotiation smoke test.
 *
 *   npx tsx scripts/phase5-real-league-smoke-test.ts
 *
 * Read-only: calls `negotiateTrade` against the REAL registered leagues.
 * Nothing is mutated — negotiation never proposes, submits, or persists a
 * trade; it only returns analysis.
 */
import { negotiateTrade } from "../lib/trades/negotiation/negotiate";
import { buildTradeAnalysisContext } from "../lib/trades/context";

async function run(label: string, req: Parameters<typeof negotiateTrade>[0]) {
  console.log(`\n=== ${label} ===`);
  try {
    const res = await negotiateTrade(req);
    console.log(`status=${res.status} mode=${res.mode}`);
    for (const d of res.diagnostics) console.log(`  diagnostic: [${d.severity}] ${d.code}: ${d.message}`);
    if (res.target_dependency) console.log(`  target dependency: ${res.target_dependency.dependency} (${res.target_dependency.reasons.join("; ")})`);
    if (res.leverage) console.log(`  leverage: ${res.leverage.level} (score=${res.leverage.score}) — ${res.leverage.reasons.join(" | ")}`);
    for (const [tier, offer] of Object.entries(res.offers)) {
      console.log(`  [${tier}] my_gain=${offer!.my_gain} viability=${offer!.trade_viability}`);
      for (const t of offer!.transfers) console.log(`     ${t.from_manager_id} -> ${t.to_manager_id}: ${t.canonical_player_id}`);
    }
    if (res.walk_away) console.log(`  walk-away: ${res.walk_away.trigger} [${res.walk_away.reasons.join(", ")}]`);
    if (res.sweeteners.length > 0) {
      console.log(`  sweeteners:`);
      for (const s of res.sweeteners.slice(0, 3)) console.log(`     ${s.canonical_player_id}: cost=${s.requester_utility_cost} gain=${s.partner_utility_gain} efficiency=${s.concession_efficiency} class=${s.sweetener_class}`);
    }
    console.log(`  behavioral_intelligence: ${res.behavioral_intelligence.status} (${res.behavioral_intelligence.note})`);
  } catch (e) {
    console.log(`ERROR: ${(e as Error).message}`);
  }
}

async function findPlayerByName(league: string, namePart: string): Promise<{ id: string; name: string; team: string | undefined; ownerManagerId: string | null } | null> {
  const ctxResult = await buildTradeAnalysisContext(league);
  if (!ctxResult.context) return null;
  const ctx = ctxResult.context;
  const match = ctx.snapshot.players.find((p) => p.full_name.toLowerCase().includes(namePart.toLowerCase()));
  if (!match) return null;
  const ownerManagerId = [...ctx.rosters_by_manager.entries()].find(([, r]) => r.all_players.includes(match.canonical_player_id))?.[0] ?? null;
  return { id: match.canonical_player_id, name: match.full_name, team: match.nfl_team ?? undefined, ownerManagerId };
}

async function main() {
  // --- Devoted to the Game / darthmarker ---
  const dg = "devoted-to-the-game";
  const mgr = "darthmarker";

  const washington = await findPlayerByName(dg, "Mike Washington");
  if (washington) {
    console.log(`\nFound "Mike Washington": ${washington.name} (${washington.id}), owner=${washington.ownerManagerId ?? "UNROSTERED"}`);
    await run("Devoted to the Game / darthmarker — ACQUIRE Mike Washington", { league: dg, manager: mgr, target_player_id: washington.id });
  } else {
    console.log('\n"Mike Washington" not found on any roster in Devoted to the Game — using a real alternative RB target instead.');
  }

  // Find a real RB target from another roster for a general ACQUIRE_TARGET smoke test
  const ctxResult = await buildTradeAnalysisContext(dg);
  if (ctxResult.context) {
    const ctx = ctxResult.context;
    const darth = ctx.snapshot.managers.find((m) => m.manager_slug === mgr);
    if (darth) {
      const darthTeam = ctx.snapshot.teams.find((t) => t.canonical_manager_ids.includes(darth.canonical_manager_id));
      let rbTargetId: string | null = null;
      for (const [managerId, roster] of ctx.rosters_by_manager) {
        if (managerId === darth.canonical_manager_id) continue;
        const rb = roster.all_players.find((id) => ctx.players_by_id.get(id)?.position === "RB");
        if (rb) { rbTargetId = rb; break; }
      }
      if (rbTargetId) {
        await run("Devoted to the Game / darthmarker — ACQUIRE a real RB target", { league: dg, manager: mgr, target_player_id: rbTargetId });
      }
      void darthTeam;
    }
  }

  // --- Bloodline Bowl / supyo29 ---
  const bb = "bloodline-bowl";
  const bbCtxResult = await buildTradeAnalysisContext(bb);
  if (bbCtxResult.context) {
    const ctx = bbCtxResult.context;
    const me = ctx.snapshot.managers.find((m) => m.manager_slug === "supyo29");
    if (me) {
      let target: string | null = null;
      for (const [managerId, roster] of ctx.rosters_by_manager) {
        if (managerId === me.canonical_manager_id) continue;
        const wr = roster.all_players.find((id) => ctx.players_by_id.get(id)?.position === "WR");
        if (wr) { target = wr; break; }
      }
      if (target) await run("Bloodline Bowl / supyo29 — ACQUIRE a real WR target", { league: bb, manager: "supyo29", target_player_id: target });
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
