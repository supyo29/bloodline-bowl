/**
 * PHASE 5 §43/§28/§40 — live Bloodline check + Phase 4↔Phase 5 comparison + latency.
 *
 *   npx tsx scripts/phase5-live-check.ts
 *
 * Queries the real Bloodline draft state, runs the frozen Phase 4 engine twice
 * over the identical universe:
 *   - PHASE 4 baseline : search_rank-only market snapshot
 *   - PHASE 5          : calibrated ADP consensus + conditional survival
 * and reports the recommendation deltas + latency. Also dumps the survival
 * evidence for several high-value candidates and the BijiMac 12/13 forecast.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { getLeagueRosters, getPlayerIndex, slimPlayer } from "@/lib/sleeper/client";
import { buildDraftBundle } from "@/lib/sleeper/draft-service";
import { loadLeagueConfig } from "@/lib/projections/service";
import { buildBaseProjections, buildLeagueProjections } from "@/lib/projections/build";
import { resolveLeagueStrict, resolveManagerInLeague } from "@/lib/leagues/resolve";
import { recommendDraft, type CompletedPick } from "@/lib/draft/engine";
import { buildMarketSnapshot, buildMarketConsensusSnapshot } from "@/lib/draft/survival";
import { buildMarketConsensus } from "@/lib/draft/market";
import type { FantasyPosition } from "@/lib/projections/schema";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

const OUT = join("outputs", "projections-2026");
const SKILL = new Set<FantasyPosition>(["QB", "RB", "WR", "TE", "K", "DEF"]);
const asSkill = (p?: string | null) => (p && SKILL.has(p as FantasyPosition) ? (p as FantasyPosition) : null);
const csv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return "\n";
  const k = Object.keys(rows[0]!);
  return [k.join(","), ...rows.map((r) => k.map((h) => {
    const v = r[h]; const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))].join("\n") + "\n";
};

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const lg = resolveLeagueStrict("bloodline-bowl");
  if (!lg.ok) throw new Error("league resolve failed");

  const [cfg, base, rosters, playerIndex, draftBundle] = await Promise.all([
    loadLeagueConfig("bloodline-bowl", lg.league.league_id),
    buildBaseProjections({ season: 2026 }),
    getLeagueRosters(lg.league.league_id),
    getPlayerIndex(),
    buildDraftBundle(lg.league.league_id, { availableLimit: 1, position: null }),
  ]);
  const league = buildLeagueProjections(base, cfg);
  const draft = draftBundle.response.draft;
  const picks = draftBundle.response.picks;
  const rounds = draft?.rounds ?? 15;
  const completedPicks: CompletedPick[] = picks.map((p) => ({
    overall: p.pick_no, roster_id: p.roster_id, player_id: p.player?.player_id ?? null,
    position: asSkill(p.player?.position),
  }));

  const bij = await resolveManagerInLeague(lg.league, "bijimac");
  if (!bij.ok) throw new Error("bijimac resolve failed");

  const mine = rosters.find((r) => r.roster_id === bij.manager.roster_id);
  const ownedIds = (mine?.players ?? []).filter((id): id is string => typeof id === "string" && id !== "0");
  const rosterPlayers: NormalizedPlayer[] = ownedIds.map((id) => playerIndex.get(id) ?? slimPlayer(id, undefined));

  const searchRankByPlayer = new Map<string, number | null>();
  for (const lp of league.projections) searchRankByPlayer.set(lp.player_id, playerIndex.get(lp.player_id)?.search_rank ?? null);

  const marketP4 = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer, timestamp: base.generated_at });
  const marketP5 = buildMarketConsensusSnapshot({ searchRankByPlayer });

  const baseInput = (market: typeof marketP4) => ({
    leaguePool: league.projections,
    rosterPositions: cfg.roster_positions,
    numTeams: cfg.num_teams,
    draftType: (draft?.type ?? "snake") as string,
    rounds,
    completedPicks,
    manager: {
      roster_id: bij.manager.roster_id, sleeper_user_id: bij.manager.sleeper_user_id,
      manager_slug: bij.manager.manager_slug, draft_slot: bij.manager.draft_slot,
    },
    rosterPlayers,
    market,
    provenance: {
      projection_source: "roster-intel", projection_version: base.model_version,
      projection_timestamp: base.generated_at, league_scoring_hash: league.scoring_hash,
      draft_state_timestamp: draftBundle.response.generated_at,
    },
  });

  // ---- latency -------------------------------------------------------
  const t0 = performance.now();
  const r4 = recommendDraft(baseInput(marketP4));
  const l4 = performance.now() - t0;
  const lat: number[] = [];
  let r5 = r4;
  for (let i = 0; i < 25; i++) {
    const s = performance.now();
    r5 = recommendDraft(baseInput(marketP5));
    lat.push(performance.now() - s);
  }
  lat.sort((a, b) => a - b);
  writeFileSync(join(OUT, "phase5_latency.csv"), csv([{
    runs: lat.length,
    candidate_pool: r5.manager_context.candidate_pool_size,
    market_consensus_build: "module-cached (one-time)",
    mean_ms: round2(lat.reduce((a, b) => a + b, 0) / lat.length),
    p50_ms: round2(lat[Math.floor(lat.length * 0.5)]!),
    p95_ms: round2(lat[Math.floor(lat.length * 0.95)]!),
    max_ms: round2(lat[lat.length - 1]!),
    phase4_baseline_ms: round2(l4),
    monte_carlo: "not used — closed-form normal CDF + conditioning ratio",
    within_120s_pick_timer: lat[lat.length - 1]! < 120_000,
  }]));

  // ---- Phase 4 vs Phase 5 recommendation delta ----------------------
  const desc = (r: typeof r4) => ({
    primary: r.primary_recommendation ? `${r.primary_recommendation.player_name} (${r.primary_recommendation.position}${r.primary_recommendation.position_rank})` : "—",
    primary_score: r.primary_recommendation?.recommendation_score ?? null,
    primary_survival: r.primary_recommendation?.survival.p_survives_next_pick ?? null,
    primary_surv_conf: r.primary_recommendation?.survival.confidence ?? null,
    pair: r.primary_pair ? `${r.primary_pair.player_1.player_name} + ${r.primary_pair.player_2.player_name}` : "—",
    pair_util: r.primary_pair?.combined_recommendation_utility ?? null,
    alt_pairs: r.alternate_pairs.map((p) => `${p.player_1.player_name}+${p.player_2.player_name}`).join(" | "),
    do_not_reach: r.do_not_reach.slice(0, 3).map((d) => d.player_name).join(", "),
  });
  const d4 = desc(r4);
  const d5 = desc(r5);
  writeFileSync(join(OUT, "phase5_bijimac_phase4_vs_phase5.csv"), csv([
    { field: "primary_recommendation", phase4: d4.primary, phase5: d5.primary, changed: d4.primary !== d5.primary },
    { field: "primary_score", phase4: d4.primary_score, phase5: d5.primary_score, changed: d4.primary_score !== d5.primary_score },
    { field: "primary_survival_to_next", phase4: d4.primary_survival, phase5: d5.primary_survival, changed: true },
    { field: "primary_survival_confidence", phase4: d4.primary_surv_conf, phase5: d5.primary_surv_conf, changed: d4.primary_surv_conf !== d5.primary_surv_conf },
    { field: "primary_pair", phase4: d4.pair, phase5: d5.pair, changed: d4.pair !== d5.pair },
    { field: "primary_pair_utility", phase4: d4.pair_util, phase5: d5.pair_util, changed: d4.pair_util !== d5.pair_util },
    { field: "alternate_pairs", phase4: d4.alt_pairs, phase5: d5.alt_pairs, changed: d4.alt_pairs !== d5.alt_pairs },
    { field: "do_not_reach_top3", phase4: d4.do_not_reach, phase5: d5.do_not_reach, changed: d4.do_not_reach !== d5.do_not_reach },
  ]));

  // ---- high-value candidate survival evidence (§43) ----------------
  const cand = [...r5.alternates, r5.primary_recommendation, ...r5.wait_candidates, ...r5.do_not_reach]
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 20)
    .map((c) => ({
      player: c.player_name, pos: `${c.position}${c.position_rank}`, tier: c.tier,
      kind: c.kind,
      current_pick: c.current_pick, next_pick: c.next_manager_pick,
      market_expected_pick: c.market_adp,
      p_survive_next: c.survival.p_survives_next_pick,
      survival_confidence: c.survival.confidence,
      tier_survival: c.tier_survival.p_tier_survives_next_pick,
      wait_proj_loss: `${c.wait_comparison.wait_projection_loss[0]}..${c.wait_comparison.wait_projection_loss[1]}`,
      wait_vor_loss: `${c.wait_comparison.wait_vor_loss[0]}..${c.wait_comparison.wait_vor_loss[1]}`,
      reason_codes: c.reason_codes.join("|"),
    }));
  writeFileSync(join(OUT, "phase5_live_bloodline_candidates.csv"), csv(cand));

  // ---- BijiMac 12/13 -> 36/37 forecast, engine-side (§25) ---------
  const table = buildMarketConsensus();
  const fc = [...table.by_player.values()]
    .filter((r) => r.expected_pick >= 9 && r.expected_pick <= 60)
    .sort((a, b) => a.expected_pick - b.expected_pick)
    .slice(0, 24)
    .map((r) => {
      const e = marketP5.by_player.get(r.sleeper_id);
      const lp = league.projections.find((p) => p.player_id === r.sleeper_id);
      return {
        player: r.name, pos: r.position, market_expected_pick: r.expected_pick,
        pick_range: `${r.pick_range[0]}..${r.pick_range[1]}`,
        dispersion: r.dispersion, market_confidence: r.confidence,
        league_points: lp?.league_points ?? "",
        p_survive_36: survivalAt(e?.expected_pick ?? null, e?.dispersion ?? 0, 36, 12),
        p_survive_37: survivalAt(e?.expected_pick ?? null, e?.dispersion ?? 0, 37, 12),
      };
    });
  writeFileSync(join(OUT, "phase5_bijimac_turn_forecast_engine.csv"), csv(fc));

  console.log("Phase 4 vs Phase 5 (BijiMac, current Bloodline state):");
  console.log("  primary  P4:", d4.primary, "| P5:", d5.primary);
  console.log("  pair     P4:", d4.pair, "| P5:", d5.pair);
  console.log("  primary survival  P4:", d4.primary_survival, `(${d4.primary_surv_conf})`, "| P5:", d5.primary_survival, `(${d5.primary_surv_conf})`);
  console.log("  latency  mean", round2(lat.reduce((a, b) => a + b, 0) / lat.length), "ms  p95", round2(lat[Math.floor(lat.length * 0.95)]!), "ms");
  console.log("  market   direct-ADP coverage", round2(marketP5.direct_adp_covered / marketP5.covered), "| consensus", marketP5.consensus_version);
}

function survivalAt(mu: number | null, disp: number, k: number, c: number): number | string {
  if (mu == null) return "";
  const s = Math.min(22, Math.max(3, 3 + 0.186 * Math.max(1, mu) + 0.9 * Math.max(0, disp)));
  const phi = (z: number) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? 1 - p : p;
  };
  const sk = phi((mu - k) / s);
  const sc = phi((mu - c) / s);
  return Math.round(Math.min(1, sk / Math.max(1e-4, sc)) * 1000) / 1000;
}
function round2(v: number): number { return Math.round(v * 100) / 100; }

main().catch((e) => { console.error(e); process.exit(1); });
