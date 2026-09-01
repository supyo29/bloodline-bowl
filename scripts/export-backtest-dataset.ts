/**
 * PHASE 2 — export the raw historical dataset the R calibration harness consumes.
 *
 *   npx tsx scripts/export-backtest-dataset.ts
 *
 * No projections are baked in here beyond a parity copy of the current
 * production RI core. R rebuilds every candidate projection from the raw
 * per-season component data so shrinkage K and formula families can be swept
 * and rolling-validated without re-running TypeScript.
 *
 * Outputs (outputs/projections-2026/):
 *   backtest_seasons.csv        one row per (player_id, season), raw component totals
 *   backtest_meta.csv           player_id -> name, position, current age / years_exp
 *   production_ri_core.csv      current production RI-core points per (player, target season)
 *   reconciliation_effect.csv   2026 per-player pre/post team-reconciliation points
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPlayerIndex } from "@/lib/sleeper/client";
import { loadSeasonActuals, type PlayerSeasonActual } from "@/lib/projections/actuals";
import { projectCoreForSeason } from "@/lib/projections/backtest";
import { buildBaseProjections, clearProjectionCaches } from "@/lib/projections/build";
import type { FantasyPosition } from "@/lib/projections/schema";

const OUT_DIR = join("outputs", "projections-2026");
const HISTORY = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const TARGETS = [2023, 2024, 2025];
const CURRENT_SEASON = 2026;
const SKILL: FantasyPosition[] = ["QB", "RB", "WR", "TE"];

function csv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") + "\n";
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const playerIndex = await getPlayerIndex();
  const posByPlayer = new Map<string, { position: string | null; team: string | null }>();
  for (const [pid, p] of playerIndex) posByPlayer.set(pid, { position: p.position, team: p.team });

  console.log("Loading season actuals 2018–2025…");
  const seasons = new Map<number, Awaited<ReturnType<typeof loadSeasonActuals>>>();
  for (const y of HISTORY) {
    seasons.set(y, await loadSeasonActuals(y, posByPlayer));
    console.log(`  ${y}: ${seasons.get(y)!.players.size} player rows`);
  }

  /* ---- backtest_seasons.csv : raw per-(player, season) component totals ---- */
  const seasonRows: Array<Record<string, unknown>> = [];
  const metaRows: Array<Record<string, unknown>> = [];
  const seenPlayers = new Set<string>();

  for (const y of HISTORY) {
    for (const [pid, a] of seasons.get(y)!.players) {
      const meta = playerIndex.get(pid);
      const pos = (meta?.position ?? a.position ?? "") as FantasyPosition;
      if (!SKILL.includes(pos)) continue;
      if (a.gp <= 0) continue;

      const currentExp = meta?.years_exp ?? null;
      const currentAge = meta?.age ?? null;
      // Approximate historical age / experience: current minus seasons elapsed.
      const ageThatSeason = currentAge != null ? currentAge - (CURRENT_SEASON - y) : null;
      const expThatSeason = currentExp != null ? currentExp - (CURRENT_SEASON - y) : null;

      seasonRows.push({
        player_id: pid,
        season: y,
        position: pos,
        gp: a.gp,
        gs: a.gs,
        age: ageThatSeason,
        years_exp: expThatSeason,
        is_rookie_season: expThatSeason === 0 ? 1 : 0,
        off_snp: a.off_snp,
        tm_off_snp: a.tm_off_snp,
        pass_att: a.pass_att,
        pass_cmp: a.pass_cmp,
        pass_yd: a.pass_yd,
        pass_td: a.pass_td,
        pass_int: a.pass_int,
        pass_rz_att: a.pass_rz_att,
        rush_att: a.rush_att,
        rush_yd: a.rush_yd,
        rush_td: a.rush_td,
        rush_rz_att: a.rush_rz_att,
        g2g_att: a.g2g_att,
        targets: a.targets,
        rec: a.rec,
        rec_yd: a.rec_yd,
        rec_td: a.rec_td,
        rec_rz_tgt: a.rec_rz_tgt,
        rec_air_yd: a.rec_air_yd,
        fum_lost: a.fum_lost,
        pts_ppr: a.pts_ppr,
      });

      if (!seenPlayers.has(pid)) {
        seenPlayers.add(pid);
        metaRows.push({
          player_id: pid,
          name: meta?.full_name ?? pid,
          position: pos,
          current_age: currentAge,
          current_years_exp: currentExp,
        });
      }
    }
  }
  writeFileSync(join(OUT_DIR, "backtest_seasons.csv"), csv(seasonRows));
  writeFileSync(join(OUT_DIR, "backtest_meta.csv"), csv(metaRows));
  console.log(`  backtest_seasons.csv: ${seasonRows.length} rows`);

  /* ---- production_ri_core.csv : parity target for the R re-implementation --- */
  const priorByPlayer = new Map<string, PlayerSeasonActual[]>();
  for (const y of HISTORY) {
    for (const [pid, row] of seasons.get(y)!.players) {
      if (!priorByPlayer.has(pid)) priorByPlayer.set(pid, []);
      priorByPlayer.get(pid)!.push(row);
    }
  }
  const parityRows: Array<Record<string, unknown>> = [];
  for (const ty of TARGETS) {
    for (const [pid, rows] of priorByPlayer) {
      const meta = playerIndex.get(pid);
      const pos = (meta?.position ?? "") as FantasyPosition;
      if (!SKILL.includes(pos)) continue;
      const prior = rows.filter((r) => r.season < ty);
      if (prior.length === 0) continue;
      const actual = seasons.get(ty)!.players.get(pid);
      if (!actual || actual.gp <= 0) continue;
      const ageAt = meta?.age != null ? meta.age - (CURRENT_SEASON - ty) : null;
      const core = projectCoreForSeason(pid, pos, ageAt, prior, ty);
      parityRows.push({
        player_id: pid,
        target_season: ty,
        position: pos,
        production_ri_core: core?.predicted_points ?? "",
        actual_pts_ppr: actual.pts_ppr,
      });
    }
  }
  writeFileSync(join(OUT_DIR, "production_ri_core.csv"), csv(parityRows));
  console.log(`  production_ri_core.csv: ${parityRows.length} rows`);

  /* ---- reconciliation_effect.csv : 2026 pre/post normalization -------------- */
  console.log("Building 2026 projections (normalize off / on)…");
  clearProjectionCaches();
  const pre = await buildBaseProjections({ season: 2026, skipBenchmark: true, normalize: false });
  clearProjectionCaches();
  const post = await buildBaseProjections({ season: 2026, skipBenchmark: true, normalize: true });
  const recRows: Array<Record<string, unknown>> = [];
  for (const [pid, prePlayer] of pre.projections) {
    const postPlayer = post.projections.get(pid);
    if (!postPlayer) continue;
    recRows.push({
      player_id: pid,
      name: prePlayer.full_name,
      position: prePlayer.position,
      team: prePlayer.team,
      pre_reconciliation_points: prePlayer.neutral_points,
      post_reconciliation_points: postPlayer.neutral_points,
      reconciliation_delta: Math.round((postPlayer.neutral_points - prePlayer.neutral_points) * 100) / 100,
      pre_targets: prePlayer.stats.targets,
      post_targets: postPlayer.stats.targets,
      pre_rush_att: prePlayer.stats.rush_att,
      post_rush_att: postPlayer.stats.rush_att,
      pre_pass_att: prePlayer.stats.pass_att,
      post_pass_att: postPlayer.stats.pass_att,
      pre_rush_td: prePlayer.stats.rush_td,
      post_rush_td: postPlayer.stats.rush_td,
      pre_rec_td: prePlayer.stats.rec_td,
      post_rec_td: postPlayer.stats.rec_td,
      expected_games: postPlayer.availability.expected_games,
      confidence: postPlayer.confidence.bucket,
    });
  }
  writeFileSync(join(OUT_DIR, "reconciliation_effect.csv"), csv(recRows));
  console.log(`  reconciliation_effect.csv: ${recRows.length} rows`);

  console.log("Done →", OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
