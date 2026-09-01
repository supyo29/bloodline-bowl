/**
 * PHASE 6 §13/§14/§38/§39/§40 — BijiMac slot-12 pair trajectory + Supyo29
 * slot-7 multi-round audit.
 *
 *   npx tsx scripts/phase6-manager-trajectory.ts [--n 150]
 *
 * BijiMac (§13/§14/§38/§39): the frozen Phase 4/5 engine's live pick-12/13
 * recommendation is Amon-Ra St. Brown + Ja'Marr Chase (WR+WR). This script
 * does NOT assume that is correct. It builds the credible alternative pairs
 * straight from the engine's own top candidates (its `primary_pair` +
 * `alternate_pairs`, plus constructed RB+RB / WR+TE / WR+QB combinations from
 * the same candidate list), forces each pair as BijiMac's actual 12/13 picks,
 * then simulates the REST of the draft (her remaining 13 picks via the frozen
 * D3 engine, opponents via the Phase-5-market opponent model) forward to a
 * complete 15-round roster. Reports the final-roster utility distribution
 * (P20/P50/P80), viable-roster rate, and intermediate roster snapshots at
 * 36/37, 60/61, 84/85 for every pair, under matched opponent seeds (paired).
 *
 * Supyo29 (§40): uses her ACTUAL live Bloodline draft slot (queried, not
 * hard-coded) and reports the descriptive multi-turn trajectory from the
 * frozen engine with no forced picks.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveLeagueStrict, resolveManagerInLeague } from "@/lib/leagues/resolve";
import { recommendDraft, type EngineInput } from "@/lib/draft/engine";
import type { DraftRecommendation } from "@/lib/draft/schema";
import {
  buildContext,
  simulateDraft,
  toRosterPlayer,
  round2,
  mean,
  type SimContext,
} from "./phase6-simulation";

const OUT = join("outputs", "projections-2026");
const csv = (rows: Array<Record<string, unknown>>): string => {
  if (rows.length === 0) return "\n";
  const keys = Object.keys(rows[0]!);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => {
    const v = r[k]; const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))].join("\n") + "\n";
};
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i]!;
}

/* ==================================================================== BijiMac */

async function bijimacAudit(ctx: SimContext, N: number): Promise<void> {
  console.log("\n=== BijiMac Slot-12 Multi-Round Audit ===");
  const slot = 12;

  // ---- current live recommendation at pick 12/13 (0 picks made) ----
  const input: EngineInput = {
    leaguePool: ctx.pool,
    rosterPositions: ctx.rosterPositions,
    numTeams: ctx.numTeams,
    draftType: "snake",
    rounds: ctx.rounds,
    completedPicks: [],
    manager: { roster_id: slot, sleeper_user_id: "bijimac-sim", manager_slug: "bijimac", draft_slot: slot },
    rosterPlayers: [],
    market: ctx.market,
    provenance: ctx.provenance,
  };
  const res = recommendDraft(input);
  if (!res.primary_pair) throw new Error("expected a consecutive-turn pair at slot 12 pick 1");

  const allCand = [res.primary_recommendation, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach]
    .filter((x): x is DraftRecommendation => !!x);
  const byPos = (pos: string) => allCand.filter((c) => c.position === pos).sort((a, b) => b.recommendation_score - a.recommendation_score);

  interface PairCandidate { label: string; ids: [string, string]; source: string }
  const pairs: PairCandidate[] = [];
  const addPair = (label: string, a?: DraftRecommendation, b?: DraftRecommendation, source = "constructed") => {
    if (!a || !b || a.player_id === b.player_id) return;
    pairs.push({ label, ids: [a.player_id, b.player_id], source });
  };

  addPair(`ENGINE PRIMARY: ${res.primary_pair.player_1.player_name} + ${res.primary_pair.player_2.player_name}`,
    allCand.find((c) => c.player_id === res.primary_pair!.player_1.player_id),
    allCand.find((c) => c.player_id === res.primary_pair!.player_2.player_id), "engine_primary_pair");
  for (const ap of res.alternate_pairs) {
    addPair(`ENGINE ALT: ${ap.player_1.player_name} + ${ap.player_2.player_name}`,
      allCand.find((c) => c.player_id === ap.player_1.player_id),
      allCand.find((c) => c.player_id === ap.player_2.player_id), "engine_alternate_pair");
  }
  // §13 required archetypes, constructed from the same top candidates
  addPair("RB + RB (constructed)", byPos("RB")[0], byPos("RB")[1], "constructed_rb_rb");
  addPair("RB + WR (constructed)", byPos("RB")[0], byPos("WR")[0], "constructed_rb_wr");
  addPair("WR + TE (constructed)", byPos("WR")[0], byPos("TE")[0], "constructed_wr_te");
  addPair("WR + QB (constructed)", byPos("WR")[0], byPos("QB")[0], "constructed_wr_qb");

  // dedupe by canonical pair
  const seen = new Set<string>();
  const uniquePairs = pairs.filter((p) => {
    const key = [...p.ids].sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  evaluating ${uniquePairs.length} candidate pairs x ${N} paired simulations each`);

  const rows: Array<Record<string, unknown>> = [];
  const snapshotRows: Array<Record<string, unknown>> = [];

  for (const pc of uniquePairs) {
    const utils: number[] = [];
    const openSlotsFinal: number[] = [];
    const snap37: number[] = [];
    const snap61: number[] = [];
    const snap85: number[] = [];
    const posLossQb: number[] = [];
    const posLossRb: number[] = [];

    for (let i = 0; i < N; i++) {
      const seed = 700000 + i; // SAME opponent seed for every pair -> paired comparison
      const forced = new Map<number, string>([[12, pc.ids[0]], [13, pc.ids[1]]]);
      const r = simulateDraft(ctx, slot, "D3_frozen_engine", seed, {
        forcedPicks: forced,
        snapshotAtOverall: [37, 61, 85],
      });
      utils.push(r.utility.utility);
      openSlotsFinal.push(r.open_starter_slots);
      if (r.snapshots?.[37]) snap37.push(r.snapshots[37].utility);
      if (r.snapshots?.[61]) snap61.push(r.snapshots[61].utility);
      if (r.snapshots?.[85]) snap85.push(r.snapshots[85].utility);
      const seq = r.pick_sequence.split(",");
      posLossQb.push(seq.filter((p) => p === "QB").length);
      posLossRb.push(seq.filter((p) => p === "RB").length);
    }

    const viable = openSlotsFinal.filter((x) => x === 0).length / N;
    rows.push({
      pair: pc.label, source: pc.source, player_1: pc.ids[0], player_2: pc.ids[1], n: N,
      final_utility_p20: round2(percentile(utils, 20)),
      final_utility_p50: round2(percentile(utils, 50)),
      final_utility_p80: round2(percentile(utils, 80)),
      final_utility_mean: round2(mean(utils)),
      viable_roster_rate: round2(viable),
      mean_open_starter_slots_final: round2(mean(openSlotsFinal)),
      snapshot_37_p50: snap37.length ? round2(percentile(snap37, 50)) : "",
      snapshot_61_p50: snap61.length ? round2(percentile(snap61, 50)) : "",
      snapshot_85_p50: snap85.length ? round2(percentile(snap85, 50)) : "",
      mean_final_RB_count: round2(mean(posLossRb)),
      mean_final_QB_count: round2(mean(posLossQb)),
    });
    snapshotRows.push({ pair: pc.label, turn: "37 (after 36/37)", p20: round2(percentile(snap37, 20)), p50: round2(percentile(snap37, 50)), p80: round2(percentile(snap37, 80)) });
    snapshotRows.push({ pair: pc.label, turn: "61 (after 60/61)", p20: round2(percentile(snap61, 20)), p50: round2(percentile(snap61, 50)), p80: round2(percentile(snap61, 80)) });
    snapshotRows.push({ pair: pc.label, turn: "85 (after 84/85)", p20: round2(percentile(snap85, 20)), p50: round2(percentile(snap85, 50)), p80: round2(percentile(snap85, 80)) });
    console.log(`  ${pc.label}: median final utility ${round2(percentile(utils, 50))}, viable ${round2(viable * 100)}%`);
  }

  rows.sort((a, b) => (b.final_utility_p50 as number) - (a.final_utility_p50 as number));
  writeFileSync(join(OUT, "phase6_bijimac_trajectory.csv"), csv(rows));
  writeFileSync(join(OUT, "phase6_bijimac_snapshots.csv"), csv(snapshotRows));
  console.log("  wrote phase6_bijimac_trajectory.csv, phase6_bijimac_snapshots.csv");
}

/* ==================================================================== Supyo29 */

async function supyo29Audit(ctx: SimContext, N: number): Promise<void> {
  console.log("\n=== Supyo29 Draft-Slot Multi-Round Audit ===");
  const lg = resolveLeagueStrict("bloodline-bowl");
  if (!lg.ok) throw new Error("league resolve failed");
  const m = await resolveManagerInLeague(lg.league, "supyo29");
  if (!m.ok) throw new Error("supyo29 resolve failed");
  const slot = m.manager.draft_slot;
  if (slot == null) throw new Error("supyo29 has no live draft slot");
  console.log(`  live draft slot: ${slot}`);

  const input: EngineInput = {
    leaguePool: ctx.pool,
    rosterPositions: ctx.rosterPositions,
    numTeams: ctx.numTeams,
    draftType: "snake",
    rounds: ctx.rounds,
    completedPicks: [],
    manager: { roster_id: slot, sleeper_user_id: m.manager.sleeper_user_id, manager_slug: "supyo29", draft_slot: slot },
    rosterPlayers: [],
    market: ctx.market,
    provenance: ctx.provenance,
  };
  const res = recommendDraft(input);
  const rows: Array<Record<string, unknown>> = [{
    slot, current_pick: res.turn.current_pick?.overall, next_pick: res.turn.next_manager_pick?.overall,
    picks_until_next: res.turn.picks_until_next, is_consecutive_turn: res.turn.is_consecutive_turn,
    primary: res.primary_recommendation ? `${res.primary_recommendation.player_name} (${res.primary_recommendation.position}${res.primary_recommendation.position_rank}, T${res.primary_recommendation.tier})` : "",
    primary_score: res.primary_recommendation?.recommendation_score,
    primary_vor: res.primary_recommendation?.vor,
    primary_tier_drop: res.primary_recommendation?.tier_drop,
    primary_survival: res.primary_recommendation?.survival.p_survives_next_pick,
    primary_survival_confidence: res.primary_recommendation?.survival.confidence,
    top_alternates: res.alternates.slice(0, 4).map((a) => `${a.player_name}(${a.position}${a.position_rank})`).join(" | "),
    reason: res.primary_recommendation?.reason,
  }];

  // simulate forward N times, D3, no forcing, to characterise the trajectory
  const utils: number[] = [];
  const seqs: string[] = [];
  const snap37: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = simulateDraft(ctx, slot, "D3_frozen_engine", 800000 + i, { snapshotAtOverall: [slot < 12 ? 24 : 36] });
    utils.push(r.utility.utility);
    seqs.push(r.pick_sequence.split(",").slice(0, 3).join("-"));
    const snapKey = slot < 12 ? 24 : 36;
    if (r.snapshots?.[snapKey]) snap37.push(r.snapshots[snapKey]!.utility);
  }
  const seqCounts = new Map<string, number>();
  for (const s of seqs) seqCounts.set(s, (seqCounts.get(s) ?? 0) + 1);
  const topSeqs = [...seqCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  writeFileSync(join(OUT, "phase6_supyo29_trajectory.csv"), csv(rows));
  writeFileSync(join(OUT, "phase6_supyo29_paths.csv"), csv(topSeqs.map(([seq, count]) => ({
    first_3_picks_by_position: seq, occurrences: count, share: round2(count / N),
  }))));
  writeFileSync(join(OUT, "phase6_supyo29_utility.csv"), csv([{
    n: N, final_utility_p20: round2(percentile(utils, 20)), final_utility_p50: round2(percentile(utils, 50)),
    final_utility_p80: round2(percentile(utils, 80)), final_utility_mean: round2(mean(utils)),
  }]));
  console.log(`  slot ${slot} primary: ${rows[0]!.primary}`);
  console.log(`  N=${N} simulated forward, median final utility ${round2(percentile(utils, 50))}`);
  console.log("  most common opening sequences:", topSeqs.map(([s, c]) => `${s} (${c})`).join(", "));
  console.log("  wrote phase6_supyo29_trajectory.csv, phase6_supyo29_paths.csv, phase6_supyo29_utility.csv");
}

/* ==================================================================== main */

async function main(): Promise<void> {
  const nArg = process.argv.find((a) => a.startsWith("--n"));
  const N = nArg ? Number(nArg.split("=")[1] ?? process.argv[process.argv.indexOf(nArg) + 1]) : 150;
  mkdirSync(OUT, { recursive: true });
  console.log("Building simulation context…");
  const ctx = await buildContext();
  await bijimacAudit(ctx, N);
  await supyo29Audit(ctx, N);
}

main().catch((e) => { console.error(e); process.exit(1); });
