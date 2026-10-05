/**
 * Fit the Phase 3 prior-season calibration (2025) and write lib/game-distribution/data/calibration_priors_2025.json.
 *   npx tsx scripts/game-distribution-fit.ts [priorSeason=2025] [--sims 300]
 * Fitted ONLY on the prior season; shocks chosen by pinball loss on held-out fit weeks with LEAVE-WEEK-OUT pools; a separate set of hold-out weeks is reported.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CalibrationPriors } from "../lib/game-distribution/priors";
const root = process.cwd();
async function main() {
  const prior = Number(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : 2025);
  const sims = Number(process.argv[process.argv.indexOf("--sims") + 1] || 300);
  const D = join(root, "lib", "game-distribution", "data");
  const { parseObservedCsv, parseProfileCsv, loadInjuryReports } = await import("../lib/role-calibration/data");
  const { buildHistoricalForecasts, magCutpoints, buildRolePools, buildTeamGamePairs, regimeDispersion } = await import("../lib/game-distribution/fit");
  const { parseHistoricalStats, evalHistoricalWeek, summarizeEval, MATERIAL_MEAN_POINTS } = await import("../lib/game-distribution/fit-eval");
  const { recalibrationMap, RECAL_KNOTS } = await import("../lib/game-distribution/dist");
  const { loadEmpiricalPools } = await import("../lib/game-distribution/pools");
  const { PoolSampler } = await import("../lib/game-distribution/pools");
  const { GAME_DISTRIBUTION_MODEL_VERSION } = await import("../lib/game-distribution/priors");
  const observed = parseObservedCsv(readFileSync(join(D, `observed_role_game_${prior}.csv`), "utf8"));
  const profiles = parseProfileCsv(readFileSync(join(D, `role_profile_asof_${prior}.csv`), "utf8"));
  const stats = parseHistoricalStats(readFileSync(join(D, `historical_player_game_stats_${prior}.csv`), "utf8"));
  const injuries = loadInjuryReports();
  const weeks = [...new Set(profiles.map((p) => p.target_week))].sort((a, b) => a - b);
  const forecasts = buildHistoricalForecasts({ season: prior, profiles, observed, injuries, weeks });
  console.log(`historical as-of forecasts: ${forecasts.length} over weeks ${weeks[0]}-${weeks[weeks.length - 1]}`);
  const cut = magCutpoints(forecasts);
  const pairs = buildTeamGamePairs(observed, prior, weeks);
  const regime = regimeDispersion(pairs);
  console.log(`team-game pairs: ${pairs.length}; regime`, regime);
  const pf = loadEmpiricalPools(prior); if (!pf) throw new Error("empirical pools missing");
  const sampler = new PoolSampler(pf);
  const mkPriors = (excludeWeek: number | null, sigma_team: number, sigma_player: number): CalibrationPriors => ({
    version: "", model_version: GAME_DISTRIBUTION_MODEL_VERSION, prior_season: prior, fitted_on: "", generated_at: "", mag_cutpoints: cut,
    team_game_pairs: pairs, role_pools: buildRolePools(excludeWeek == null ? forecasts : forecasts.filter((f) => f.week !== excludeWeek), observed, prior, cut),
    shocks: { sigma_team, sigma_player, fit_grid: [], fit_weeks: [], holdout_weeks: [] }, recalibration: { fit_weeks: [], n: {}, knots: [...RECAL_KNOTS], mapped: {} }, regime, notes: [],
  });
  const fitWeeks = [8, 11, 14].filter((w) => weeks.includes(w)), recalWeeks = [7, 8, 10, 11, 13, 14, 16].filter((w) => weeks.includes(w)), holdWeeks = [6, 9, 12, 15, 17].filter((w) => weeks.includes(w));
  const grid: Array<{ sigma_team: number; sigma_player: number; pinball: number }> = [];
  for (const st of [0, 0.08, 0.16, 0.24]) for (const sp of [0, 0.12, 0.24, 0.36]) {
    const ev = fitWeeks.map((w) => evalHistoricalWeek({ season: prior, week: w, forecasts, observed, stats, priors: mkPriors(w, st, sp), sampler, sims, sigma_team: st, sigma_player: sp }));
    const c = summarizeEval(ev); grid.push({ sigma_team: st, sigma_player: sp, pinball: c.mean_pinball! });
    console.log(`sigma_team=${st} sigma_player=${sp} pinball=${c.mean_pinball} cov60=${c.intervals[1]!.observed} n=${c.n}`);
  }
  grid.sort((a, b) => a.pinball - b.pinball); const best = grid[0]!;
  console.log("best", best);
  // PIT recalibration fitted on recalWeeks (leave-week-out pools) — disjoint from the hold-out weeks
  const recalEv = recalWeeks.map((w) => evalHistoricalWeek({ season: prior, week: w, forecasts, observed, stats, priors: mkPriors(w, best.sigma_team, best.sigma_player), sampler, sims, sigma_team: best.sigma_team, sigma_player: best.sigma_player }));
  const material = (ws: typeof recalEv) => ws.flatMap((w) => w.scored).filter((x) => x.sim_mean >= MATERIAL_MEAN_POINTS);
  const recalPits = material(recalEv); const mapped: Record<string, number[]> = { ALL: recalibrationMap(recalPits.map((x) => x.pit)) }; const recalN: Record<string, number> = { ALL: recalPits.length };
  for (const p of ["QB", "RB", "WR", "TE"]) { const sub = recalPits.filter((x) => x.position === p); recalN[p] = sub.length; if (sub.length >= 120) mapped[p] = recalibrationMap(sub.map((x) => x.pit)); }
  const evalHold = (recal: Record<string, number[]> | null) => holdWeeks.map((w) => evalHistoricalWeek({ season: prior, week: w, forecasts, observed, stats, priors: mkPriors(w, best.sigma_team, best.sigma_player), sampler, sims, sigma_team: best.sigma_team, sigma_player: best.sigma_player, recal }));
  const holdRaw = evalHold(null), holdRecal = evalHold(mapped);
  const holdStats = summarizeEval(holdRecal), holdRawStats = summarizeEval(holdRaw);
  const byPos = Object.fromEntries(["QB", "RB", "WR", "TE"].map((p) => [p, { raw: summarizeEval(holdRaw.map((h) => ({ week: h.week, scored: h.scored.filter((s) => s.position === p) }))), recalibrated: summarizeEval(holdRecal.map((h) => ({ week: h.week, scored: h.scored.filter((s) => s.position === p) }))) }]));
  const out = mkPriors(null, best.sigma_team, best.sigma_player);
  out.version = `${GAME_DISTRIBUTION_MODEL_VERSION}-priors-${prior}`; out.fitted_on = `${prior} REG as-of forecasts, weeks ${weeks[0]}-${weeks[weeks.length - 1]}; shocks fit on weeks ${fitWeeks.join(",")} (leave-week-out pools), hold-out weeks ${holdWeeks.join(",")}`; out.generated_at = new Date().toISOString();
  out.shocks = { sigma_team: best.sigma_team, sigma_player: best.sigma_player, fit_grid: grid, fit_weeks: fitWeeks, holdout_weeks: holdWeeks };
  out.recalibration = { fit_weeks: recalWeeks, n: recalN, knots: [...RECAL_KNOTS], mapped };
  out.notes = ["pools hold actual-minus-forecast role residuals INCLUDING DNP (availability is learned, not assumed)", "prior-season in-game injuries are NOT labeled in the pools, so in-game exit risk is part of the tail", "teammate pressure is off in the historical forecasts", `hold-out (2025, disjoint weeks, material players >= ${MATERIAL_MEAN_POINTS} sim-mean pts): RAW 60% interval observed ${holdRawStats.intervals[1]!.observed}, 80% ${holdRawStats.intervals[3]!.observed}; RECALIBRATED 60% ${holdStats.intervals[1]!.observed}, 80% ${holdStats.intervals[3]!.observed} (n=${holdStats.n})`];
  writeFileSync(join(D, `calibration_priors_${prior}.json`), JSON.stringify(out));
  writeFileSync(join(D, `fit_report_${prior}.json`), JSON.stringify({ generated_at: out.generated_at, best, grid, holdout_overall_recalibrated: holdStats, holdout_overall_raw: holdRawStats, holdout_by_position: byPos, recalibration_n: recalN, n_forecasts: forecasts.length, n_pairs: pairs.length, regime, pool_sizes: Object.fromEntries(Object.entries(out.role_pools).map(([k, v]) => [k, v.n])) }, null, 1));
  const pc = (c: typeof holdStats) => JSON.stringify(c.pit_intervals!.map((i) => [i.name.slice(0, 4), i.observed]));
  console.log("holdout RAW   inclusive", JSON.stringify(holdRawStats.intervals.map((i) => [i.name.slice(0, 4), i.observed])), "PIT", pc(holdRawStats), "pinball", holdRawStats.mean_pinball, "n", holdRawStats.n);
  console.log("holdout RECAL inclusive", JSON.stringify(holdStats.intervals.map((i) => [i.name.slice(0, 4), i.observed])), "PIT", pc(holdStats), "pinball", holdStats.mean_pinball, "n", holdStats.n);
  console.log("recal n", recalN);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
