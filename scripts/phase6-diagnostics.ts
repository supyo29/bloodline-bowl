/**
 * PHASE 6 §43/§44/§9/§36/§47 — failure-mode probes, adversarial draft states,
 * recovery-cost model output, and latency. All fast (targeted checks, not
 * thousands of sims).
 *
 *   npx tsx scripts/phase6-diagnostics.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { FantasyPosition, LeagueProjection } from "@/lib/projections/schema";
import { overallPickNumber } from "@/lib/bridge/geometry";
import { recommendDraft, type CompletedPick, type EngineInput } from "@/lib/draft/engine";
import { positionOutlook } from "@/lib/draft/lookahead";
import { positionRecoveryCost } from "@/lib/draft/recovery";
import { vorOf } from "@/lib/draft/replacement";
import { buildContext, simulateDraft, toRosterPlayer, round2, type SimContext } from "./phase6-simulation";
import { estimateSurvival } from "@/lib/draft/survival";

const OUT = join("outputs", "projections-2026");
const csv = (rows: Array<Record<string, unknown>>): string => {
  if (rows.length === 0) return "\n";
  const keys = Object.keys(rows[0]!);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => {
    const v = r[k]; const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))].join("\n") + "\n";
};

function mkInput(ctx: SimContext, slot: number, completedPicks: CompletedPick[], roster: LeagueProjection[]): EngineInput {
  return {
    leaguePool: ctx.pool.filter((p) => !completedPicks.some((c) => c.player_id === p.player_id) && !roster.some((r) => r.player_id === p.player_id)),
    rosterPositions: ctx.rosterPositions, numTeams: ctx.numTeams, draftType: "snake", rounds: ctx.rounds,
    completedPicks, manager: { roster_id: slot, sleeper_user_id: `d${slot}`, manager_slug: `d${slot}`, draft_slot: slot },
    rosterPlayers: roster.map(toRosterPlayer), market: ctx.market, provenance: ctx.provenance,
  };
}

/** Build a plausible completed-pick history where opponents drained `drainPos` heavily (adversarial run). */
function drainedHistory(ctx: SimContext, uptoOverall: number, drainPos: FantasyPosition | null): { picks: CompletedPick[]; taken: Set<string> } {
  const taken = new Set<string>();
  const picks: CompletedPick[] = [];
  const ranked = [...ctx.pool].sort((a, b) => b.league_points - a.league_points);
  const drained = drainPos ? [...ctx.pool].filter((p) => p.position === drainPos).sort((a, b) => b.league_points - a.league_points) : [];
  let di = 0;
  let ri = 0;
  for (let overall = 1; overall < uptoOverall; overall++) {
    const round = Math.ceil(overall / ctx.numTeams);
    // 65% of picks in an extreme run go to the drained position (until it's thin)
    let pick: LeagueProjection | undefined;
    if (drainPos && di < drained.length && (overall % 3 !== 0)) {
      while (di < drained.length && taken.has(drained[di]!.player_id)) di++;
      pick = drained[di];
      di++;
    }
    if (!pick) {
      while (ri < ranked.length && (taken.has(ranked[ri]!.player_id) || (ranked[ri]!.position === "K" || ranked[ri]!.position === "DEF") && round < 13)) ri++;
      pick = ranked[ri];
      ri++;
    }
    if (!pick) break;
    taken.add(pick.player_id);
    picks.push({ overall, roster_id: (overall % ctx.numTeams) + 1, player_id: pick.player_id, position: pick.position });
  }
  return { picks, taken };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const ctx = await buildContext();
  const SLOT = 7;

  /* -------------------------------------------------- §43 failure modes */
  console.log("[failure modes]");
  const failRows: Array<Record<string, unknown>> = [];

  // Failure A/F/G: force the first 4 picks to WR, then let the frozen engine
  // run the rest — does it recover RB and complete a legal lineup?
  {
    const wr4 = ctx.pool.filter((p) => p.position === "WR").sort((a, b) => b.league_points - a.league_points).slice(0, 4);
    const forced = new Map<number, string>();
    [1, 2, 3, 4].forEach((rd, i) => forced.set(overallPickNumber(SLOT, rd, ctx.numTeams, "snake"), wr4[i]!.player_id));
    const r = simulateDraft(ctx, SLOT, "D3_frozen_engine", 505050, { forcedPicks: forced });
    const c = r.picks_by_position;
    failRows.push({
      failure: "A/F/G: 4-WR forced start", sequence_after: r.pick_sequence,
      final_RB: c.RB ?? 0, final_QB: c.QB ?? 0, final_TE: c.TE ?? 0, final_K: c.K ?? 0, final_DEF: c.DEF ?? 0,
      verdict: r.open_starter_slots === 0 && (c.RB ?? 0) >= 2 && (c.QB ?? 0) >= 1 && (c.TE ?? 0) >= 1 && (c.K ?? 0) >= 1 && (c.DEF ?? 0) >= 1
        ? "OK — recovered RB and completed the lineup" : `FAIL — open slots ${r.open_starter_slots}, RB ${c.RB ?? 0}`,
    });
  }

  // Failure C/D: does the engine fill QB/TE too early / too late? natural D3 over a full draft.
  {
    const r = simulateDraft(ctx, SLOT, "D3_frozen_engine", 606060);
    const seq = r.pick_sequence.split(",");
    const qbRound = seq.indexOf("QB") + 1;
    const teRound = seq.indexOf("TE") + 1;
    failRows.push({
      failure: "C/D: QB/TE timing (natural D3)", sequence_after: r.pick_sequence,
      final_RB: r.picks_by_position.RB ?? 0, final_QB: r.picks_by_position.QB ?? 0, final_TE: r.picks_by_position.TE ?? 0,
      final_K: r.picks_by_position.K ?? 0, final_DEF: r.picks_by_position.DEF ?? 0,
      verdict: qbRound >= 3 && qbRound <= 12 && teRound >= 1 && teRound <= 13 && r.open_starter_slots === 0
        ? `OK — first QB round ${qbRound}, first TE round ${teRound}, roster complete` : `REVIEW — QB round ${qbRound}, TE round ${teRound}, open slots ${r.open_starter_slots}`,
    });
  }

  // Failure J: trajectory optimisation (D4) must never pull K/DST EARLIER than
  // the frozen engine (D3) would, and neither may take K/DST before ~round 10
  // (the gate allows an early release only once the core lineup is done).
  {
    let d4Earlier = 0;
    let prematureAbs = 0;
    for (let s = 0; s < 20; s++) {
      const rd3 = simulateDraft(ctx, SLOT, "D3_frozen_engine", 707000 + s);
      const rd4 = simulateDraft(ctx, SLOT, "D4_trajectory", 707000 + s);
      const firstKdst = (seq: string) => { const a = seq.split(","); const i = a.findIndex((p) => p === "K" || p === "DEF"); return i < 0 ? 99 : i + 1; };
      if (firstKdst(rd4.pick_sequence) < firstKdst(rd3.pick_sequence)) d4Earlier++;
      if (Math.min(firstKdst(rd3.pick_sequence), firstKdst(rd4.pick_sequence)) < 10) prematureAbs++;
    }
    failRows.push({
      failure: "J: early K/DST leak", sequence_after: "20 paired D3/D4 drafts",
      final_RB: "", final_QB: "", final_TE: "", final_K: "", final_DEF: "",
      verdict: d4Earlier === 0 && prematureAbs === 0
        ? "OK — D4 never earlier than D3; no K/DST before round 10"
        : `REVIEW — D4 earlier in ${d4Earlier}, absolute-premature in ${prematureAbs}`,
    });
  }

  // Failure H: does the D4 trajectory term ever overwhelm obvious VOR? (bounded-ness check)
  {
    const res = recommendDraft(mkInput(ctx, SLOT, drainedHistory(ctx, 30, null).picks, []));
    const all = [res.primary_recommendation, ...res.alternates].filter((x): x is NonNullable<typeof x> => !!x);
    // simulate the D4 adjustment magnitude vs the score spread
    const spread = (all[0]?.recommendation_score ?? 0) - (all[all.length - 1]?.recommendation_score ?? 0);
    failRows.push({ failure: "H: trajectory adj bounded", sequence_after: `TRAJ_CAP 35 vs score spread ${round2(spread)}`, verdict: 35 < spread ? "OK — cap < candidate spread, cannot flip an obvious pick" : "REVIEW — cap comparable to spread" });
  }

  writeFileSync(join(OUT, "phase6_failure_modes.csv"), csv(failRows));
  failRows.forEach((r) => console.log(`  ${r.failure}: ${r.verdict}`));

  /* -------------------------------------------------- §44 adversarial states */
  console.log("\n[adversarial states]");
  const advRows: Array<Record<string, unknown>> = [];
  for (const scenario of [
    { label: "extreme RB run", drain: "RB" as FantasyPosition, at: 30 },
    { label: "extreme WR run", drain: "WR" as FantasyPosition, at: 30 },
    { label: "early QB run", drain: "QB" as FantasyPosition, at: 24 },
    { label: "early TE run", drain: "TE" as FantasyPosition, at: 24 },
    { label: "no run (control)", drain: null, at: 30 },
  ]) {
    const { picks } = drainedHistory(ctx, scenario.at, scenario.drain);
    const res = recommendDraft(mkInput(ctx, SLOT, picks, []));
    const p = res.primary_recommendation;
    advRows.push({
      scenario: scenario.label,
      primary: p ? `${p.player_name} (${p.position}${p.position_rank}, T${p.tier})` : "",
      primary_score: p?.recommendation_score, primary_vor: p?.vor,
      primary_survival: p?.survival.p_survives_next_pick, survival_conf: p?.survival.confidence,
      readiness: res.readiness.snake_engine_status,
      warnings: res.warnings.join(" | "),
      rational: p && p.vor > 0 && (p.recommendation_score > 0) ? "rational" : "REVIEW",
    });
  }
  writeFileSync(join(OUT, "phase6_adversarial.csv"), csv(advRows));
  advRows.forEach((r) => console.log(`  ${r.scenario}: ${r.primary} — ${r.rational}`));

  /* -------------------------------------------------- §9/§36 recovery cost */
  console.log("\n[recovery cost by round]");
  const recRows: Array<Record<string, unknown>> = [];
  for (const round of [1, 3, 5, 7, 9, 11]) {
    const overall = overallPickNumber(SLOT, round, ctx.numTeams, "snake");
    const nextOverall = overallPickNumber(SLOT, round + 1, ctx.numTeams, "snake");
    const secondOverall = overallPickNumber(SLOT, round + 2, ctx.numTeams, "snake");
    const { picks, taken } = drainedHistory(ctx, overall, null);
    const avail = ctx.pool.filter((p) => !taken.has(p.player_id));
    for (const pos of ["QB", "RB", "WR", "TE"] as FantasyPosition[]) {
      const posAvail = avail.filter((p) => p.position === pos).sort((a, b) => b.league_points - a.league_points);
      if (posAvail.length < 2) continue;
      const best = posAvail[0]!;
      const cand = (targetOverall: number) => posAvail.map((p) => ({
        player_id: p.player_id, league_points: p.league_points, vor: vorOf(p, ctx.levels),
        p_survives_next_pick: estimateSurvival({
          playerId: p.player_id, position: pos, targetPickOverall: targetOverall,
          interveningPicks: Math.max(1, targetOverall - overall - 1), currentPickOverall: overall, market: ctx.market,
        }).p_survives_next_pick,
      }));
      const rc = positionRecoveryCost(pos, best.league_points, vorOf(best, ctx.levels), cand(nextOverall), cand(secondOverall));
      recRows.push({
        round, position: pos, best_now_points: round2(best.league_points), best_now_vor: round2(vorOf(best, ctx.levels)),
        expected_alt_next_pts: rc.outlook_next_turn.expected_alt_points.map(round2).join(".."),
        expected_alt_2turn_pts: rc.outlook_second_turn ? rc.outlook_second_turn.expected_alt_points.map(round2).join("..") : "",
        recovery_cost_points: rc.recovery_cost_points, recovery_cost_vor: rc.recovery_cost_vor,
      });
    }
    void picks; void positionOutlook;
  }
  writeFileSync(join(OUT, "phase6_recovery_cost.csv"), csv(recRows));

  /* -------------------------------------------------- §47 latency */
  console.log("\n[latency]");
  const lat: number[] = [];
  const { picks: histMid } = drainedHistory(ctx, 55, null);
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    recommendDraft(mkInput(ctx, SLOT, histMid, []));
    lat.push(performance.now() - t0);
  }
  lat.sort((a, b) => a - b);
  writeFileSync(join(OUT, "phase6_latency.csv"), csv([{
    context: "deterministic recommendation, real Bloodline pool mid-draft",
    runs: lat.length, mean_ms: round2(lat.reduce((a, b) => a + b, 0) / lat.length),
    p50_ms: round2(lat[Math.floor(lat.length / 2)]!), p95_ms: round2(lat[Math.floor(lat.length * 0.95)]!), max_ms: round2(lat[lat.length - 1]!),
    trajectory_research_sim: "offline only — never in a live request (see phase6-simulation.ts)",
    pick_timer_seconds: 120, within_timer: lat[lat.length - 1]! < 120_000,
  }]));
  console.log(`  mean ${round2(lat.reduce((a, b) => a + b, 0) / lat.length)}ms, p95 ${round2(lat[Math.floor(lat.length * 0.95)]!)}ms`);

  /* -------------------------------------------------- §4 roster utility definition */
  writeFileSync(join(OUT, "phase6_roster_utility_definition.csv"), csv([
    { term: "StarterVOR", sign: "+", weight: 1.0, definition: "Σ VOR of the QB/RB/RB/WR/WR/TE starters (league-derived replacement)" },
    { term: "FlexVOR", sign: "+", weight: 1.0, definition: "Σ VOR of the 2 FLEX starters (best remaining RB/WR/TE after base slots)" },
    { term: "BenchVOR", sign: "+", weight: 0.3, definition: "Σ max(0, VOR) of bench players × 0.3 discount (a bench point is not a starter point)" },
    { term: "PositionalAdvantage", sign: "+", weight: 0.5, definition: "Σ max(0, starterVOR − leagueMedianStarterVOR[pos]) — rewards a true positional edge" },
    { term: "StarterCompletionPenalty", sign: "−", weight: 1.5, definition: "openStarterSlots × avgReplacementPoints × 1.5" },
    { term: "ConstructionRisk", sign: "−", weight: 40, definition: "trajectory starter-completion risk (0..1) × 40 — 0 for a finished roster" },
  ]));

  console.log("\nwrote phase6_failure_modes.csv, phase6_adversarial.csv, phase6_recovery_cost.csv, phase6_latency.csv, phase6_roster_utility_definition.csv");
}

main().catch((e) => { console.error(e); process.exit(1); });
