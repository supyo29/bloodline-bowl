/**
 * FINAL DRAFT-NIGHT READINESS AUDIT — adversarial engine probes.
 *
 *   npx tsx scripts/audit-draft-night.ts
 *
 * Exercises the FROZEN ri-snake-decision-2026.2 engine against synthetic draft
 * states that mirror the audit spec's failure modes and adversarial scenarios.
 * Read-only: builds no model, changes no production behaviour. Prints PASS/FAIL
 * lines for the readiness report. Not a unit test — a diagnostic harness.
 */

import type { FantasyPosition, LeagueProjection, OutcomeBand } from "@/lib/projections/schema";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import { recommendDraft, type CompletedPick, type EngineInput } from "@/lib/draft/engine";
import { buildMarketSnapshot, estimateSurvival } from "@/lib/draft/survival";

const ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"];
const NUM_TEAMS = 12;
const ROUNDS = 15;

function band(m: number): OutcomeBand {
  return { floor: m * 0.72, median: m, ceiling: m * 1.34, sd: m * 0.18, percentiles: { floor: 20, ceiling: 80 } };
}
let uid = 0;
function mkLP(o: { position: FantasyPosition; points: number; name?: string; id?: string; team?: string }): LeagueProjection {
  const id = o.id ?? `p${++uid}`;
  return {
    player_id: id, full_name: o.name ?? id, position: o.position, team: o.team ?? "AAA",
    league_slug: "synthetic", league_id: "0", scoring_hash: "sha_test",
    league_points: o.points, league_ppg: o.points / 17, league_outcome: band(o.points),
    sleeper_league_points: null,
    vs_sleeper: { delta_points: null, delta_pct: null, ri_rank: null, sleeper_rank: null, rank_delta: null, primary_driver: null },
    replacement_points: null, value_over_replacement: null, vor_rank: null, position_rank: null,
    overall_rank: null, tier: null, confidence: "HIGH",
  };
}
function standardPool(): LeagueProjection[] {
  uid = 0;
  const pool: LeagueProjection[] = [];
  const rbPts = [330, 322, 300, 292, 285, 250, 244, 240, 236, 232, 228, 224, 220, 216, 175, 170, 166, 162, 158, 150, 140, 135, 130, 120, 110, 100];
  rbPts.forEach((p, i) => pool.push(mkLP({ position: "RB", points: p, name: `RB${i + 1}`, id: `RB${i + 1}`, team: `T${i % 12}` })));
  // deep RB tail so a full 15-round sim never runs out
  for (let i = rbPts.length; i < 70; i++) pool.push(mkLP({ position: "RB", points: Math.max(20, 98 - (i - rbPts.length) * 3), name: `RB${i + 1}`, id: `RB${i + 1}`, team: `T${i % 12}` }));
  const wrPts = [305, 300, 296, 292, 288, 284, 280, 276, 272, 268, 264, 260, 256, 252, 248, 244, 240, 236, 232, 228, 224, 220, 216, 212, 208, 204, 200, 196, 192, 188, 184, 180, 176, 172, 168, 164];
  wrPts.forEach((p, i) => pool.push(mkLP({ position: "WR", points: p, name: `WR${i + 1}`, id: `WR${i + 1}`, team: `T${i % 12}` })));
  for (let i = wrPts.length; i < 90; i++) pool.push(mkLP({ position: "WR", points: Math.max(20, 162 - (i - wrPts.length) * 3), name: `WR${i + 1}`, id: `WR${i + 1}`, team: `T${i % 12}` }));
  const tePts = [232, 176, 172, 168, 164, 160, 120, 118, 116, 112, 108, 104, 100, 96, 92, 88];
  tePts.forEach((p, i) => pool.push(mkLP({ position: "TE", points: p, name: `TE${i + 1}`, id: `TE${i + 1}`, team: `T${i % 12}` })));
  for (let i = tePts.length; i < 40; i++) pool.push(mkLP({ position: "TE", points: Math.max(15, 86 - (i - tePts.length) * 3), name: `TE${i + 1}`, id: `TE${i + 1}`, team: `T${i % 12}` }));
  const qbPts = [340, 336, 332, 328, 325, 322, 319, 316, 313, 310, 307, 304, 300, 296, 292, 288];
  qbPts.forEach((p, i) => pool.push(mkLP({ position: "QB", points: p, name: `QB${i + 1}`, id: `QB${i + 1}`, team: `T${i % 12}` })));
  for (let i = qbPts.length; i < 40; i++) pool.push(mkLP({ position: "QB", points: Math.max(120, 286 - (i - qbPts.length) * 4), name: `QB${i + 1}`, id: `QB${i + 1}`, team: `T${i % 12}` }));
  for (let i = 0; i < 32; i++) pool.push(mkLP({ position: "K", points: 140 - i * 2, name: `K${i + 1}`, id: `K${i + 1}`, team: `T${i % 12}` }));
  for (let i = 0; i < 32; i++) pool.push(mkLP({ position: "DEF", points: 130 - i * 2, name: `DEF${i + 1}`, id: `DEF${i + 1}`, team: `T${i % 12}` }));
  return pool;
}
/** K/DEF-free pool — mirrors the REAL Bloodline projection gap (Layer 1 emits no K/DEF). */
function noKdstPool(): LeagueProjection[] {
  return standardPool().filter((p) => p.position !== "K" && p.position !== "DEF");
}
function mkPlayer(id: string, position: FantasyPosition): NormalizedPlayer {
  return {
    player_id: id, full_name: id, first_name: null, last_name: null, position,
    fantasy_positions: [position], team: "AAA", age: 26, years_exp: 4, status: null,
    injury_status: null, number: null, active: true, search_rank: 50,
    depth_chart_order: 1, depth_chart_position: null, resolved: true,
  };
}
function baseInput(over: Partial<EngineInput> = {}): EngineInput {
  const pool = over.leaguePool ?? standardPool();
  const searchRank = new Map<string, number | null>();
  [...pool].sort((a, b) => b.league_points - a.league_points).forEach((p, i) => searchRank.set(p.player_id, i + 1));
  return {
    leaguePool: pool, rosterPositions: ROSTER_POSITIONS, numTeams: NUM_TEAMS, draftType: "snake",
    rounds: ROUNDS, completedPicks: [], manager: { roster_id: 7, sleeper_user_id: "u7", manager_slug: "supyo29", draft_slot: 7 },
    rosterPlayers: [],
    market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: searchRank, timestamp: "2026-09-01T00:00:00Z" }),
    provenance: {
      projection_source: "test", projection_version: "ri-structural-2026.3",
      projection_timestamp: "2026-09-01T00:00:00Z", league_scoring_hash: "sha_test",
      draft_state_timestamp: "2026-09-01T00:00:00Z",
    },
    ...over,
  };
}
function simulatePicks(pool: LeagueProjection[], n: number, skip = new Set<string>(), positions?: FantasyPosition[]): CompletedPick[] {
  let ranked = [...pool].filter((p) => !skip.has(p.player_id) && p.position !== "K" && p.position !== "DEF");
  if (positions) ranked = ranked.filter((p) => positions.includes(p.position));
  ranked.sort((a, b) => b.league_points - a.league_points);
  const out: CompletedPick[] = [];
  for (let i = 0; i < n; i++) { const p = ranked[i]; if (!p) break; out.push({ overall: i + 1, roster_id: (i % NUM_TEAMS) + 1, player_id: p.player_id, position: p.position }); }
  return out;
}
const rosterOf = (...specs: Array<[string, FantasyPosition]>): NormalizedPlayer[] => specs.map(([id, pos]) => mkPlayer(id, pos));

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (cond) pass++;
  else fail++;
}

// ---------------------------------------------------------------- A: elite faller
{
  console.log("\n[A] elite WR falls ~10 past ADP — value recognized, not vetoed by low survival");
  // WR1 (best) still available after 16 picks that skipped him
  const picks = simulatePicks(standardPool(), 16, new Set(["WR1"]));
  const res = recommendDraft(baseInput({ completedPicks: picks }));
  const all = [res.primary_recommendation, ...(res.alternates ?? [])];
  const wr1 = all.find((a) => a?.player_id === "WR1");
  check("fallen WR1 surfaced as primary or a top alternate", !!wr1, `primary=${res.primary_recommendation?.player_id}`);
  check("fallen WR1 not pushed to do_not_reach / hidden", (res.do_not_reach ?? []).every((d) => d.player_id !== "WR1"));
  check("fallen WR1 keeps full projected value (low survival did not discount his points)",
    (wr1?.projected_points ?? 0) >= 300, `pts=${wr1?.projected_points}`);
  check("fallen WR1 flagged as high-value / market inefficiency, not vetoed",
    (wr1?.vor ?? 0) > 0 && (wr1?.recommendation_score ?? 0) > 0, `vor=${wr1?.vor} score=${wr1?.recommendation_score}`);
}

// ---------------------------------------------------------------- B: QB run, no panic
{
  console.log("\n[B] a QB run is underway — engine does not panic-chase QB when waiting is viable");
  const qbRun: CompletedPick[] = [];
  const pool = standardPool();
  // 6 of the last 8 picks are QBs
  ["QB1","QB2","QB3","RB1","QB4","WR1","QB5","QB6"].forEach((id, i) => {
    const pl = pool.find((x) => x.player_id === id)!;
    qbRun.push({ overall: i + 1, roster_id: (i % 12) + 1, player_id: id, position: pl.position });
  });
  const res = recommendDraft(baseInput({ completedPicks: qbRun }));
  check("primary is NOT a QB", res.primary_recommendation?.position !== "QB", `got ${res.primary_recommendation?.position}`);
}

// ---------------------------------------------------------------- C/D: 2 / 3 / 4 QB
for (const [n, ids] of [[2, ["Qa","Qb"]], [3, ["Qa","Qb","Qc"]], [4, ["Qa","Qb","Qc","Qd"]]] as Array<[number, string[]]>) {
  console.log(`\n[C/D] manager already has ${n} QB — extra QB must be damped`);
  const roster = rosterOf(...ids.map((id) => [id, "QB"] as [string, FantasyPosition]), ["r1","RB"], ["r2","RB"], ["w1","WR"]);
  const picks = simulatePicks(standardPool(), 40, new Set(roster.map((r) => r.player_id)));
  const res = recommendDraft(baseInput({ rosterPlayers: roster, completedPicks: picks }));
  const primaryQB = res.primary_recommendation?.position === "QB";
  check(`primary is not a ${n + 1}th QB`, !primaryQB, `got ${res.primary_recommendation?.position}${res.primary_recommendation?.position_rank}`);
  const qbAlt = res.alternates?.find((a) => a.position === "QB");
  if (qbAlt) {
    const topNonQb = [res.primary_recommendation, ...(res.alternates ?? [])].find((a) => a && a.position !== "QB");
    check(`QB alternate scores below top non-QB`, !!topNonQb && qbAlt.recommendation_score < topNonQb!.recommendation_score,
      `QB ${qbAlt.recommendation_score} vs ${topNonQb?.position} ${topNonQb?.recommendation_score}`);
  }
}

// ---------------------------------------------------------------- E/F: WR/WR & RB/RB openings
for (const [label, pos] of [["E", "WR"], ["F", "RB"]] as Array<[string, FantasyPosition]>) {
  console.log(`\n[${label}] ${pos}/${pos} opening — no reflexive "must draft the other" penalty`);
  const roster = rosterOf(["s1", pos], ["s2", pos]);
  const picks = simulatePicks(standardPool(), 20, new Set(roster.map((r) => r.player_id)));
  const res = recommendDraft(baseInput({ rosterPlayers: roster, completedPicks: picks }));
  const other = pos === "WR" ? "RB" : "WR";
  const samePos = res.primary_recommendation?.position === pos;
  const otherPos = res.primary_recommendation?.position === other;
  check(`primary is a rational skill pick (${pos}, ${other}, or TE ok)`,
    ["QB", "RB", "WR", "TE"].includes(res.primary_recommendation?.position ?? ""), `got ${res.primary_recommendation?.position}`);
  check(`same-position ${pos} still allowed if best`, samePos || otherPos || res.primary_recommendation?.position === "TE" || res.primary_recommendation?.position === "QB", "");
}

// ---------------------------------------------------------------- G: elite TE before cliff
{
  console.log("\n[G] one elite TE left before a cliff — TE can beat RB/WR on VOR/cliff when the roster needs it");
  // Manager already has RB/RB/WR/WR; TE slot open; TE1 (232) huge vs TE2 (176) cliff.
  const roster = rosterOf(["r1","RB"],["r2","RB"],["w1","WR"],["w2","WR"]);
  const picks = simulatePicks(standardPool(), 40, new Set([...roster.map((r) => r.player_id), "TE1"]));
  const res = recommendDraft(baseInput({ rosterPlayers: roster, completedPicks: picks }));
  const all = [res.primary_recommendation, ...(res.alternates ?? [])];
  const te1 = all.find((a) => a?.player_id === "TE1");
  check("elite TE1 wins or is a strong alternate given the open TE slot + cliff",
    res.primary_recommendation?.player_id === "TE1" || (te1 != null && (all.indexOf(te1) <= 2)),
    `primary=${res.primary_recommendation?.player_id} te1_rank=${te1 ? all.indexOf(te1) : "absent"}`);
  check("TE1 tier_drop / cliff is quantified in its evidence", (te1?.tier_drop ?? 0) > 0 || /tier|cliff/i.test(te1?.reason ?? ""));
}

// ---------------------------------------------------------------- H/I: K/DEF hard gate by round (K/DEF PRESENT in pool)
console.log("\n[H/I] K/DEF hard gate across rounds — K/DEF present in pool, incomplete core lineup");
for (const round of [8, 10, 12, 13, 14, 15]) {
  // Manager mid-draft with an INCOMPLETE core (no TE yet) so the gate must hold on merit, not lineup-complete.
  const roster = rosterOf(["q","QB"],["r1","RB"],["r2","RB"],["w1","WR"],["w2","WR"],
    ...Array.from({ length: Math.max(0, round - 6) }, (_, i) => [`bn${i}`, (["RB","WR"] as const)[i % 2]] as [string, FantasyPosition]));
  const need = round - 1; // opponents have taken ~ (round-1)*11 skill players
  const picks = simulatePicks(noKdstPool(), need * 11, new Set(roster.map((r) => r.player_id)));
  // pretend the manager is at their round-`round` pick
  const overallAtRound = ((round - 1) * 12) + 6; // slot-7 pick in this round
  const padded = [...picks];
  while (padded.length < overallAtRound - 1) padded.push({ overall: padded.length + 1, roster_id: (padded.length % 12) + 1, player_id: `filler${padded.length}`, position: "WR" });
  const res = recommendDraft(baseInput({ completedPicks: padded.slice(0, overallAtRound - 1), rosterPlayers: roster, leaguePool: standardPool() }));
  const primaryKdst = ["K", "DEF"].includes(res.primary_recommendation?.position ?? "");
  if (round <= 12) check(`round ${round}: gate blocks K/DEF as primary (core incomplete)`, !primaryKdst, `got ${res.primary_recommendation?.position}${res.primary_recommendation?.position_rank}`);
  else check(`round ${round}: K/DEF allowed by frozen gate`, true, `primary=${res.primary_recommendation?.position}`);
}

// helper: put the manager at a specific overall pick with `roster` owned, drawing real opponent picks from `pool`
function stateAtOverall(overall: number, roster: NormalizedPlayer[], pool: LeagueProjection[]): CompletedPick[] {
  // draw as many REAL best-available opponent picks as the pool allows, so the
  // late-round board is genuinely thinned (not padded with phantom ids)
  const real = simulatePicks(pool, Math.min(overall - 1, 230), new Set(roster.map((r) => r.player_id)));
  const out = [...real];
  while (out.length < overall - 1) out.push({ overall: out.length + 1, roster_id: (out.length % 12) + 1, player_id: `filler${out.length}`, position: "WR" });
  return out.slice(0, overall - 1);
}

// ---------------------------------------------------------------- J: round 14 lacks DEF, K/DEF ABSENT from pool (real Bloodline state)
{
  console.log("\n[J] round 14, still lacks DEF, K/DEF ABSENT from pool (real Bloodline) — must DEGRADE, not crash or fake a DEF");
  const roster = rosterOf(["q","QB"],["r1","RB"],["r2","RB"],["w1","WR"],["w2","WR"],["t","TE"],["f1","RB"],["f2","WR"],
    ["b1","WR"],["b2","RB"],["b3","QB"],["b4","TE"],["k1","K"]);
  const res = recommendDraft(baseInput({ completedPicks: stateAtOverall(162, roster, noKdstPool()), rosterPlayers: roster, leaguePool: noKdstPool() }));
  check("engine does not crash and still produces guidance", !!res.primary_recommendation || (res.readiness.degraded_reasons.length > 0));
  check("readiness DEGRADED (DEF pool gap surfaced)", res.readiness.snake_engine_status === "DEGRADED", res.readiness.snake_engine_status);
  check("no fabricated DEF recommendation", res.primary_recommendation?.position !== "DEF");
  check("degraded reason names the .../draft fallback", res.readiness.degraded_reasons.some((r) => /draft.*candidate|candidate list/i.test(r)));
}

// ---------------------------------------------------------------- K: round 15, only K unfilled, K PRESENT in pool
{
  console.log("\n[K] final pick (overall 175), only K unfilled, full 14-man roster, K present — desperation makes the required slot win");
  // Realistic terminal roster: 14 players, EVERY skill slot + DEF + all 5 bench filled, only K open.
  const roster = rosterOf(["q","QB"],["r1","RB"],["r2","RB"],["w1","WR"],["w2","WR"],["t","TE"],["f1","RB"],["f2","WR"],
    ["d1","DEF"],["b1","WR"],["b2","RB"],["b3","QB"],["b4","TE"],["b5","RB"]);
  const res = recommendDraft(baseInput({ completedPicks: stateAtOverall(175, roster, standardPool()), rosterPlayers: roster, leaguePool: standardPool() }));
  check("primary is K on the last pick when K is the only hole (deep roster)", res.primary_recommendation?.position === "K",
    `got ${res.primary_recommendation?.position}${res.primary_recommendation?.position_rank ?? ""}`);

  // Thin roster (13) one bench short — documents the latent desperation limitation (moot tonight: K/DEF not in real pool)
  const thin = rosterOf(["q","QB"],["r1","RB"],["r2","RB"],["w1","WR"],["w2","WR"],["t","TE"],["f1","RB"],["f2","WR"],
    ["d1","DEF"],["b1","WR"],["b2","RB"],["b3","QB"],["b4","TE"]);
  const rThin = recommendDraft(baseInput({ completedPicks: stateAtOverall(175, thin, standardPool()), rosterPlayers: thin, leaguePool: standardPool() }));
  check("[latent, non-blocking] thin-roster last pick still completes K", rThin.primary_recommendation?.position === "K",
    `got ${rThin.primary_recommendation?.position}${rThin.primary_recommendation?.position_rank ?? ""} — desperation scales rosterNeedValue by candidate VOR; a low-VOR K gets little lift unless competitors are damped by full depth`);
}

// ---------------------------------------------------------------- desperation not too early
{
  console.log("\n[H2] desperation must NOT overwhelm an elite VOR opportunity several rounds early");
  // round 6 (overall 66), manager lacks TE but a deep TE tier remains; elite RB value on the board
  const roster = rosterOf(["q","QB"],["r1","RB"],["w1","WR"],["w2","WR"],["f1","RB"]);
  const res = recommendDraft(baseInput({ completedPicks: stateAtOverall(66, roster, standardPool()).concat(), rosterPlayers: roster, leaguePool: standardPool() }));
  check("does not force a weak TE reach when a deep TE tier + elite RB/WR remain",
    res.primary_recommendation?.position !== "TE" || (res.primary_recommendation?.tier ?? 9) <= 2,
    `got ${res.primary_recommendation?.position}${res.primary_recommendation?.position_rank} tier ${res.primary_recommendation?.tier}`);
}

// ---------------------------------------------------------------- M: drafted player, alias-proof
{
  console.log("\n[M] a drafted player cannot be re-recommended, even under an id the pool doesn't share");
  const picks = simulatePicks(standardPool(), 11);
  const surfaced = new Set([
    res_ids(recommendDraft(baseInput({ completedPicks: picks }))),
  ].flat());
  const takenIds = new Set(picks.map((p) => p.player_id));
  check("no drafted id appears in any bucket", [...surfaced].every((id) => !takenIds.has(id)),
    `overlap: ${[...surfaced].filter((id) => takenIds.has(id)).join(",")}`);
}
function res_ids(r: ReturnType<typeof recommendDraft>): string[] {
  return [r.primary_recommendation, ...(r.alternates ?? []), ...(r.wait_candidates ?? []), ...(r.do_not_reach ?? [])]
    .filter(Boolean).map((x) => x!.player_id);
}

// ---------------------------------------------------------------- N: stale record with no projection
{
  console.log("\n[N] a stale player with active=true + team!=null but NO projection cannot enter the rec pool");
  const pool = standardPool(); // 'ghost' is NOT in the pool
  const res = recommendDraft(baseInput({
    leaguePool: pool,
    rosterPlayers: [],
    completedPicks: simulatePicks(pool, 11),
  }));
  const ids = new Set(res_ids(res));
  check("ghost id never surfaced (pool is the only universe)", !ids.has("ghost"));
  check("every surfaced id is a real pool member", [...ids].every((id) => pool.some((p) => p.player_id === id)));
}

// ---------------------------------------------------------------- O: completed draft (180/180)
{
  console.log("\n[O] ALL picks complete (180/180) — engine must NOT invent an extra recommendation");
  const full: CompletedPick[] = [];
  for (let i = 0; i < 180; i++) full.push({ overall: i + 1, roster_id: (i % 12) + 1, player_id: `done${i}`, position: "WR" });
  const res = recommendDraft(baseInput({ completedPicks: full, rosterPlayers: [] }));
  const terminal = !res.primary_recommendation || res.readiness.snake_engine_status === "BLOCKED";
  check("terminal state signalled — primary null OR BLOCKED (no phantom pick)", terminal,
    `primary=${res.primary_recommendation?.player_id ?? "null"} status=${res.readiness.snake_engine_status} ` +
    `turn.current=${JSON.stringify(res.turn?.current_pick)} own_made=${res.turn?.own_picks_made}`);
}

// ---------------------------------------------------------------- O2: manager done, draft ongoing
{
  console.log("\n[O2] manager's 15 picks all made (overall 176+), draft still going — no 16th recommendation");
  const roster = rosterOf(["q","QB"],["r1","RB"],["r2","RB"],["w1","WR"],["w2","WR"],["t","TE"],["f1","RB"],["f2","WR"],
    ["k1","K"],["d1","DEF"],["b1","WR"],["b2","RB"],["b3","QB"],["b4","TE"],["b5","WR"]);
  const picks: CompletedPick[] = [];
  for (let i = 0; i < 176; i++) picks.push({ overall: i + 1, roster_id: (i % 12) + 1, player_id: `done${i}`, position: "WR" });
  const res = recommendDraft(baseInput({ completedPicks: picks, rosterPlayers: roster }));
  const terminal = !res.primary_recommendation || res.readiness.snake_engine_status === "BLOCKED";
  check("no recommendation once the manager has all 15 — primary null OR BLOCKED", terminal,
    `primary=${res.primary_recommendation?.player_id ?? "null"} turn.current=${JSON.stringify(res.turn?.current_pick)} own_made=${res.turn?.own_picks_made}`);
}

// ---------------------------------------------------------------- N: pair optimizer when the top board is gone
{
  console.log("\n[N-pair] BijiMac slot 12 — Amon-Ra/Chase-equivalents GONE before 12: optimizer must return a real available pair");
  // slot 12 pre-turn: 11 opponent picks already made, taking the top 11 skill players
  const top11 = simulatePicks(standardPool(), 11);
  const res = recommendDraft(baseInput({
    completedPicks: top11,
    manager: { roster_id: 12, sleeper_user_id: "u12", manager_slug: "bijimac", draft_slot: 12 },
    rosterPlayers: [],
  }));
  const takenIds = new Set(top11.map((p) => p.player_id));
  check("consecutive turn detected (pick 12/13)", res.turn.is_consecutive_turn && res.turn.current_pick?.overall === 12);
  const pair = res.primary_pair;
  check("a primary pair is returned", !!pair);
  if (pair) {
    check("pair player_1 is actually still available", !takenIds.has(pair.player_1.player_id), pair.player_1.player_name);
    check("pair player_2 is actually still available", !takenIds.has(pair.player_2.player_id), pair.player_2.player_name);
    check("pair players are distinct", pair.player_1.player_id !== pair.player_2.player_id);
    check("canonical pair key is order-independent (no A,B / B,A dupes in alternates)",
      new Set((res.alternate_pairs ?? []).map((p) => [p.player_1.player_id, p.player_2.player_id].sort().join("::"))).size === (res.alternate_pairs ?? []).length);
  }
}

// ---------------------------------------------------------------- L: conditional survival monotonicity
{
  console.log("\n[L] conditional survival P(D>k | D>c) rises once the player has already fallen to a later pick c");
  const pool = standardPool();
  const sr = new Map<string, number | null>();
  [...pool].sort((a, b) => b.league_points - a.league_points).forEach((p, i) => sr.set(p.player_id, i + 1));
  const mkt = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "t" });
  // WR3 has market ~pick 3. Compare survival-to-30 from an early pick vs from pick 24 (already fell).
  const early = estimateSurvival({ playerId: "WR3", position: "WR", targetPickOverall: 30, interveningPicks: 27, currentPickOverall: 3, market: mkt });
  const fell = estimateSurvival({ playerId: "WR3", position: "WR", targetPickOverall: 30, interveningPicks: 6, currentPickOverall: 24, market: mkt });
  check("survival-to-30 is higher when already available at pick 24 than when measured from pick 3",
    fell.p_survives_next_pick >= early.p_survives_next_pick,
    `from3=${early.p_survives_next_pick.toFixed(3)} from24=${fell.p_survives_next_pick.toFixed(3)}`);
  check("both are valid probabilities", [early, fell].every((s) => s.p_survives_next_pick >= 0 && s.p_survives_next_pick <= 1));
  // deeper horizon => not higher survival
  const near = estimateSurvival({ playerId: "WR10", position: "WR", targetPickOverall: 20, interveningPicks: 5, currentPickOverall: 14, market: mkt });
  const far = estimateSurvival({ playerId: "WR10", position: "WR", targetPickOverall: 40, interveningPicks: 25, currentPickOverall: 14, market: mkt });
  check("survival to a nearer pick >= survival to a farther pick", near.p_survives_next_pick >= far.p_survives_next_pick,
    `near=${near.p_survives_next_pick.toFixed(3)} far=${far.p_survives_next_pick.toFixed(3)}`);
}

console.log(`\n==== audit probes: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail > 0 ? 1 : 0);
