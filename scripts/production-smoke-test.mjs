// Production smoke test — read-only, against the LIVE deployed API.
// Run: node scripts/production-smoke-test.mjs
const BASE = "https://bloodline-bowl-sleeper-bridge.vercel.app";

async function post(path, body) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
async function get(path) {
  const res = await fetch(BASE + path);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function summarize(label, obj, maxLen = 400) {
  const s = JSON.stringify(obj);
  console.log(`  ${label}: ${s.length > maxLen ? s.slice(0, maxLen) + "…" : s}`);
}

async function leagueQA(league, manager) {
  console.log(`\n########## ${league} / ${manager} ##########`);

  // 1. Discovery: BEST_AVAILABLE, with strategic context
  const disc = await post("/api/trades/discover", { league, manager, mode: "BEST_AVAILABLE", max_results: 5, include_strategic: true });
  console.log(`[discover BEST_AVAILABLE] status=${disc.status} api_status=${disc.json?.status} results=${disc.json?.results?.length}`);
  summarize("versions", disc.json?.versions);
  summarize("calibration_status", disc.json?.calibration_status);
  if (disc.json?.manager_strategic_profile) {
    const p = disc.json.manager_strategic_profile;
    console.log(`  strategic profile: archetype=${p.archetype} playoff_status=${p.playoff?.status} urgency=${p.urgency?.score} season_stage=${p.season?.season_stage}`);
  }
  for (const r of disc.json?.results ?? []) {
    console.log(`  candidate: my_gain=${r.my_gain} viability=${r.trade_viability} strategic_score=${r.strategic?.strategic_trade_score} recommendation=${r.strategic?.strategic_recommendation}`);
  }

  // 2. Discovery: POSITIONAL_NEED RB
  const posNeed = await post("/api/trades/discover", { league, manager, mode: "POSITIONAL_NEED", target_position: "RB", max_results: 2 });
  console.log(`[discover POSITIONAL_NEED RB] status=${posNeed.status} api_status=${posNeed.json?.status} results=${posNeed.json?.results?.length} diagnostics=${JSON.stringify(posNeed.json?.diagnostics?.map((d) => d.code))}`);

  // 3. Discovery: CONSOLIDATE
  const consolidate = await post("/api/trades/discover", { league, manager, mode: "CONSOLIDATE", max_results: 2 });
  console.log(`[discover CONSOLIDATE] status=${consolidate.status} api_status=${consolidate.json?.status} results=${consolidate.json?.results?.length}`);

  // 4. If BEST_AVAILABLE found a real candidate, feed it into /analyze directly (real bilateral proof).
  // Prefer an all-Sleeper-id candidate: analyze's public `asset.player_id` contract
  // is documented as a Sleeper-native id (its own doc example: "4046") and does not
  // resolve a raw GSIS-format id even though discover/negotiate correctly use that
  // player internally via the canonical crosswalk — a real, minor (P2) integration
  // finding, not a valuation defect (see docs/TRADE_ENGINE_PRODUCTION_READINESS.md).
  const allResults = disc.json?.results ?? [];
  const candidate = allResults.find((r) => r.transfers.every((t) => t.canonical_player_id.startsWith("player:sleeper:"))) ?? allResults[0];
  if (candidate) {
    // analyze's PUBLIC contract wants bare manager slugs and raw provider
    // player ids (per its own doc comment: "from_manager_id": "supyo29",
    // "player_id": "4046") — discovery's internal transfer shape uses full
    // canonical ids (manager:league:id / player:provider:id), a different,
    // internally-consistent convention for that layer. Translate here.
    const canonicalIdToSlug = new Map();
    for (const p of candidate.participants) {
      const ctx = await get(`/api/context/${league}/${p.manager_slug}`);
      const cid = ctx.json?.context?.canonical_manager_id;
      if (cid) canonicalIdToSlug.set(cid, p.manager_slug);
    }
    const managerIdToSlug = (canonicalId) => canonicalIdToSlug.get(canonicalId) ?? canonicalId;
    const rawPlayerId = (canonicalPlayerId) => canonicalPlayerId.split(":").pop();
    const participants = candidate.participants.map((p) => p.manager_slug);
    console.log(`[analyze] re-analyzing discovered candidate directly (participants=${JSON.stringify(participants)})`);
    const analyzeBody = {
      league,
      participants,
      transfers: candidate.transfers.map((t) => ({ from_manager_id: managerIdToSlug(t.from_manager_id), to_manager_id: managerIdToSlug(t.to_manager_id), asset: { type: "PLAYER", player_id: rawPlayerId(t.canonical_player_id) } })),
    };
    const an = await post("/api/trades/analyze", analyzeBody);
    console.log(`  status=${an.status} api_status=${an.json?.status}`);
    if (an.json?.status !== "OK") summarize("  analyze error detail", an.json);
    else {
      summarize("  versions", an.json.trade_summary ? { foundation: an.json.trade_foundation_version, contextual: an.json.trade_context_version, calibrated: an.json.trade_calibrated_version } : an.json);
    }
  }

  // 5. Negotiate: pick a real target from the roster of ANOTHER manager, via BUY_PLAYER discovery diagnostics, else skip.
  const buy = await post("/api/trades/discover", { league, manager, mode: "BUY_PLAYER", target_player_id: "___nonexistent___" });
  console.log(`[discover BUY_PLAYER sanity] status=${buy.status} diagnostics=${JSON.stringify(buy.json?.diagnostics?.map((d) => d.code))}`);

  // 6. Strategic context standalone endpoint
  const strat = await get(`/api/leagues/${league}/managers/${manager}/strategic-context`);
  console.log(`[strategic-context] status=${strat.status}`);
  summarize("  body", strat.json);

  // 7. Adversarial: malformed analyze request
  const bad = await post("/api/trades/analyze", { league, participants: [manager], transfers: [{ from_manager_id: manager, to_manager_id: manager, asset: { type: "PLAYER", player_id: "x" } }] });
  console.log(`[adversarial: same-manager-both-sides] status=${bad.status} api_status=${bad.json?.status ?? bad.json?.error}`);

  const badLeague = await post("/api/trades/analyze", { league: "___does_not_exist___", participants: ["a", "b"], transfers: [] });
  console.log(`[adversarial: unknown league] status=${badLeague.status} api_status=${badLeague.json?.status ?? badLeague.json?.error}`);

  return { disc, candidate, manager };
}

async function negotiateQA(league, manager, targetPlayerId) {
  if (!targetPlayerId) {
    console.log(`\n[negotiate] no target available for ${league}/${manager} — skipping`);
    return;
  }
  const neg = await post("/api/trades/negotiate", { league, manager, target_player_id: targetPlayerId, include_strategic: true });
  console.log(`\n[negotiate ACQUIRE_TARGET ${targetPlayerId}] status=${neg.status} api_status=${neg.json?.status}`);
  console.log(`  offer tiers: ${Object.keys(neg.json?.offers ?? {}).join(", ") || "(none)"}`);
  for (const [tier, offer] of Object.entries(neg.json?.offers ?? {})) {
    console.log(`    ${tier}: my_gain=${offer.my_gain}`);
  }
  summarize("  strategic_offer_guidance", neg.json?.strategic_offer_guidance);
  summarize("  walk_away", neg.json?.walk_away);
  summarize("  diagnostics", neg.json?.diagnostics);

  // three-team adversarial: negotiate with a 3-participant proposal must be rejected
  const threeTeam = await post("/api/trades/negotiate", { league, manager, proposal: { participants: [manager, "x", "y"], transfers: [] }, mode: "IMPROVE_OFFER" });
  console.log(`[negotiate adversarial: 3-team proposal] status=${threeTeam.status} api_status=${threeTeam.json?.status} diagnostics=${JSON.stringify(threeTeam.json?.diagnostics?.map((d) => d.code))}`);
}

async function threeTeamQA(league, manager) {
  const tt = await post("/api/trades/discover", { league, manager, mode: "THREE_TEAM", max_results: 3 });
  console.log(`\n[discover THREE_TEAM] status=${tt.status} api_status=${tt.json?.status} results=${tt.json?.results?.length}`);
  if ((tt.json?.results?.length ?? 0) === 0) console.log("  NO_VIABLE_THREE_TEAM_RESULT");
  for (const r of tt.json?.results ?? []) {
    console.log(`  shape=${r.shape} participants=${r.participants.length} my_gain=${r.my_gain}`);
  }
}

async function main() {
  const r1 = await leagueQA("devoted-to-the-game", "darthmarker");
  const targetB = r1.disc.json?.results?.[0]?.transfers?.find((t) => t.to_manager_id?.includes("darthmarker") === false)?.canonical_player_id;
  await negotiateQA("devoted-to-the-game", "darthmarker", targetB);
  await threeTeamQA("devoted-to-the-game", "darthmarker");

  const r2 = await leagueQA("bloodline-bowl", "supyo29");
  const targetA = r2.disc.json?.results?.[0]?.transfers?.find((t) => !t.to_manager_id?.includes("supyo29"))?.canonical_player_id;
  await negotiateQA("bloodline-bowl", "supyo29", targetA);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
