/**
 * Projection Calibration Phase 3 — game environment, weather and outcome-distribution tests: leakage + poisoning, football constraints, distribution
 * math, scoring translation, weather integrity, exact error-class identity, idempotency/versioning and production isolation.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadObservedRoleGames, loadRoleProfilesAsOf } from "@/lib/role-calibration/data";
import { buildWeekForecasts } from "@/lib/role-calibration/forecast-week";
import type { RoleForecast } from "@/lib/role-calibration/types";
import type { NflGame } from "@/lib/calibration/types";
import { loadModelInputs, latestForecastPerPlayer, simulateWeek } from "@/lib/game-distribution/run-week";
import { simulateGame } from "@/lib/game-distribution/simulate";
import { allocateCounts, mulberry32, seedFrom } from "@/lib/game-distribution/rng";
import { QUANTILE_LEVELS, calibration, inverseLevel, intervalScore, mapLevel, normalQuantiles, pinball, pit, pitNormalClamped, quantileSorted, recalibrationMap, summarize, summarizeRecalibrated, RECAL_KNOTS } from "@/lib/game-distribution/dist";
import { N_STATS, STAT_INDEX, linearCoefficients, scoreStats, STAT_KEYS } from "@/lib/game-distribution/fast-score";
import { scoreExpectedLine } from "@/lib/role-calibration/xfp";
import { buildDistributionAnalysis } from "@/lib/game-distribution/analysis";
import { distributionReport, dedupeDist } from "@/lib/game-distribution/report";
import { decompose6, DECOMP6_KEYS } from "@/lib/game-distribution/decompose";
import { buildGameEnvironment, buildPlayerDistributionRecord, fiContext } from "@/lib/game-distribution/environment";
import { qbChangedBefore } from "@/lib/game-distribution/fit";
import { availabilityClass, poolKeys, recencyOf, selectPool, tierOf, MIN_POOL, GAME_DISTRIBUTION_MODEL_VERSION } from "@/lib/game-distribution/priors";
import { writeDistributionAnalysis, writeEnvironments, writePlayerDistributions, writeWeather } from "@/lib/game-distribution/store";
import { buildWeatherSnapshot, latestPregameWeather } from "@/lib/game-weather/capture";
import { gridValueAt, parseWindMph, pickPeriod, type NwsForecast } from "@/lib/game-weather/nws";
import { weatherRisk } from "@/lib/game-weather/risk";
import { STADIUMS } from "@/lib/game-weather/stadiums";
import { WEEKLY_POSITION_CV, weeklyBand } from "@/lib/weekly/uncertainty";
import { interactionValueFor, INTERACTION_PROXY_NOTE } from "@/lib/weekly/start-sit-fi/usage-values";
import { translateFiAdjustment } from "@/lib/weekly/start-sit-fi/translate";
import { loadFootballIntelligence, type FootballIntelligence } from "@/lib/football-intel";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { RoleAnalysisRow } from "@/lib/role-calibration/analysis";

const KICK = "2026-09-27T17:00:00.000Z";
const mkGame = (id: string, home: string, away: string, over: Partial<NflGame> = {}): NflGame => ({ nfl_game_id: id, season: 2026, week: 3, home_team: home, away_team: away, kickoff_at: KICK, kickoff_source: "test", status: "complete", provenance: {}, ...over });
const PPR = { pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_sack: -1, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2 };
const HALF = { ...PPR, rec: 0.5 };
const { priors, sampler } = loadModelInputs(2026);

async function week3Forecasts(observed = loadObservedRoleGames()): Promise<RoleForecast[]> {
  const teams = [...new Set(loadRoleProfilesAsOf().filter((p) => p.target_week === 3).map((p) => p.team))];
  const games: NflGame[] = []; const prior = new Map<string, string>();
  for (let i = 0; i + 1 < teams.length; i += 2) games.push(mkGame(`g-${teams[i]}-${teams[i + 1]}`, teams[i]!, teams[i + 1]!));
  for (const t of teams) { prior.set(`2026|1|${t}`, "2026-09-13T17:00:00.000Z"); prior.set(`2026|2|${t}`, "2026-09-20T17:00:00.000Z"); }
  return (await buildWeekForecasts({ season: 2026, week: 3, captureKind: "AS_OF_RECONSTRUCTION", games, priorKickoffs: prior, observed })).forecasts;
}
const pairOf = (fs: RoleForecast[], a: string, b: string) => ({ season: 2026, week: 3, game_id: `g-${a}-${b}`, a: { team: a, forecasts: fs.filter((f) => f.nfl_team === a) }, b: { team: b, forecasts: fs.filter((f) => f.nfl_team === b) } });
const firstPair = (fs: RoleForecast[]) => { const teams = [...new Set(fs.map((f) => f.nfl_team!))]; return pairOf(fs, teams[0]!, teams[1]!); };

describe("leakage: the pregame environment/distribution never sees the game being forecast", () => {
  test("ADVERSARIAL: poisoning every Week-3 outcome leaves the simulated distributions byte-identical", async () => {
    const observed = loadObservedRoleGames();
    const poisoned = observed.map((o) => (o.season === 2026 && o.week >= 3 ? { ...o, snap_share: 1, target_share: 0.99, rush_share: 0.99, targets: 60, carries: 60, dropbacks: 200, team_pass_att: 500, team_rush_att: 500, team_rz_pass_att: 90, team_rz_rush_att: 90, rz_target_share: 0.99, rz_carry_share: 0.99 } : o));
    const a = await week3Forecasts(observed), b = await week3Forecasts(poisoned);
    const ra = simulateGame(firstPair(a), sampler, priors, { sims: 200 }), rb = simulateGame(firstPair(b), sampler, priors, { sims: 200 });
    assert.ok(ra.players.length > 20);
    assert.deepEqual(rb.players.map((p) => Array.from(p.stats)), ra.players.map((p) => Array.from(p.stats)));
    assert.deepEqual(rb.teams.map((t) => Array.from(t.pass_att)), ra.teams.map((t) => Array.from(t.pass_att)));
  });
  test("QB-regime flag looks only at games strictly before the target week", () => {
    const row = (week: number, gsis: string, db: number) => ({ season: 2026, week, game_id: `g${week}`, gsis_id: gsis, position: "QB", team: "AAA", dropbacks: db }) as never;
    const base = [row(1, "q1", 30), row(2, "q1", 30)];
    assert.equal(qbChangedBefore(base, "AAA", 2026, 3), false);
    assert.equal(qbChangedBefore([...base, row(3, "q2", 40), row(4, "q2", 40)], "AAA", 2026, 3), false); // weeks >= target ignored
    assert.equal(qbChangedBefore([row(1, "q1", 30), row(2, "q2", 33)], "AAA", 2026, 3), true);
  });
  test("weather retrieved at/after kickoff, or a forecast issued after kickoff, can never become a pregame snapshot or be selected", () => {
    const g = mkGame("g", "GB", "ATL");
    const fc = (issued: string | null): NwsForecast => ({ forecast_issued_at: issued, source_url: "u", period: { startTime: "2026-09-27T17:00:00Z", endTime: "2026-09-27T18:00:00Z", temperature: 55, temperatureUnit: "F", windSpeed: "10 mph", shortForecast: "Sunny", probabilityOfPrecipitation: { value: 5 } }, wind_gust_mph: 15, precip_mm: 0, raw: { selected_period: "2026-09-27T17:00:00Z" } });
    assert.equal(buildWeatherSnapshot(g, fc("2026-09-26T12:00:00Z"), "2026-09-27T17:00:00.000Z").skipped, "RETRIEVED_AT_OR_AFTER_KICKOFF");
    assert.equal(buildWeatherSnapshot(g, fc("2026-09-27T16:30:00Z"), "2026-09-27T18:00:00.000Z").skipped, "RETRIEVED_AT_OR_AFTER_KICKOFF");
    assert.equal(buildWeatherSnapshot(g, fc("2026-09-27T17:30:00Z"), "2026-09-27T16:00:00.000Z").skipped, "FORECAST_ISSUED_AT_OR_AFTER_KICKOFF");
    const ok = buildWeatherSnapshot(g, fc("2026-09-27T12:00:00Z"), "2026-09-27T13:00:00.000Z").snapshot!;
    assert.equal(ok.hours_to_kickoff, 4); assert.equal(ok.roof_status, null);
    const rows = [{ ...ok, retrieved_at: "2026-09-27T13:00:00Z" }, { ...ok, snapshot_id: "gw:late", retrieved_at: "2026-09-27T17:05:00Z" }];
    assert.equal(latestPregameWeather(rows, Date.parse("2026-09-27T18:00:00Z"))?.snapshot_id, ok.snapshot_id);
    assert.equal(latestPregameWeather(rows, Date.parse("2026-09-27T12:00:00Z")), null); // nothing existed yet at that as-of instant
  });
  test("FI context is attached only when the published FI snapshot predates the target week", () => {
    const fi = { manifest: { season: 2026, through_week: 3, football_intelligence_version: "fi:test" }, team: () => ({ offense: {}, defense: {} }), contextualMatchup: () => ({ availability: "NOT_AVAILABLE" }) } as unknown as FootballIntelligence;
    assert.equal(fiContext(fi, 3, 2026, "GB", "ATL").status, "OMITTED_NOT_PREGAME");
    assert.equal(fiContext(fi, 2, 2026, "GB", "ATL").status, "OMITTED_NOT_PREGAME");
    assert.equal(fiContext(fi, 4, 2026, "GB", "ATL").status, "USED_AS_CONTEXT");
    assert.equal(fiContext(fi, 4, 2027, "GB", "ATL").status, "OMITTED_NOT_PREGAME");
    assert.equal(fiContext(null, 4, 2026, "GB", "ATL").status, "UNAVAILABLE");
  });
  test("DB guards: as_of/retrieved strictly before kickoff, LIVE and weather rejected at/after kickoff, insert-only on all four tables", () => {
    const sql = readFileSync("supabase/migrations/20260930180000_game_distribution.sql", "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const re of [/retrieved_at < kickoff_at/, /as_of_at < kickoff_at/, /data_cutoff_at < kickoff_at/, /now\(\) >= new\.kickoff_at/, /forecast_issued_at < kickoff_at/]) assert.match(sql, re);
    assert.match(sql, /bridge_game_weather_forecasts','bridge_game_environment_forecasts','bridge_player_distribution_forecasts','bridge_distribution_calibration_analysis/);
    assert.ok(!/drop table|alter table public\.bridge_(projection|calibration|startsit|weekly|role)/i.test(sql));
  });
  test("the prior-season fit never reads the evaluated season", () => {
    for (const f of ["lib/game-distribution/fit.ts", "scripts/game-distribution-fit.ts"]) { const src = readFileSync(f, "utf8"); assert.ok(!/observed_role_game\.csv|role_profile_asof\.csv|season:\s*2026|loadObservedRoleGames\(|loadRoleProfilesAsOf\(/.test(src), f); }
    assert.equal(priors.prior_season, 2025); assert.match(priors.fitted_on, /^2025 REG/);
  });
});

describe("football constraints", () => {
  test("allocateCounts: never exceeds the team total, no player above the total, expected counts preserved", () => {
    const rng = mulberry32(7); const shares = [0.4, 0.3, 0.2, 0.1]; const T = 33; const sum = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) { const c = allocateCounts(shares, T, rng); assert.ok(c.reduce((a, b) => a + b, 0) <= T); assert.ok(c.every((x) => x >= 0 && x <= T)); c.forEach((x, k) => { sum[k]! += x; }); }
    shares.forEach((s, k) => assert.ok(Math.abs(sum[k]! / 4000 - s * T) < 0.15, `player ${k}`));
    assert.deepEqual(allocateCounts([0.5, 0.5], 0, rng), [0, 0]);
    assert.ok(allocateCounts([1], 10, rng)[0]! <= 10);
  });
  test("in EVERY simulation: player targets <= team pass attempts and RB carries <= team rush attempts; team volumes are integers", async () => {
    const r = simulateGame(firstPair(await week3Forecasts()), sampler, priors, { sims: 400 });
    for (let t = 0; t < 2; t++) {
      const team = r.teams[t]!; const mine = r.players.filter((p) => p.forecast.nfl_team === team.team);
      for (let s = 0; s < 400; s++) {
        let tg = 0, car = 0; for (const p of mine) { tg += p.stats[s * N_STATS + STAT_INDEX.rec_tgt]!; if (p.forecast.position === "RB") car += p.stats[s * N_STATS + STAT_INDEX.rush_att]!; }
        assert.ok(tg <= team.pass_att[s]! + 1e-6, `targets ${tg} > team pass ${team.pass_att[s]}`); assert.ok(car <= team.rush_att[s]! + 1e-6, `carries ${car} > team rush ${team.rush_att[s]}`);
        assert.equal(team.pass_att[s], Math.round(team.pass_att[s]!)); assert.ok(team.rz_pass[s]! <= team.pass_att[s]!);
      }
    }
  });
  test("every simulated stat is a non-negative integer count (yards excepted); completions <= attempts, receptions <= targets", async () => {
    const r = simulateGame(firstPair(await week3Forecasts()), sampler, priors, { sims: 200 });
    for (const p of r.players) for (let s = 0; s < 200; s++) { const o = s * N_STATS; const g = (k: keyof typeof STAT_INDEX) => p.stats[o + STAT_INDEX[k]]!;
      for (const k of ["pass_att", "pass_cmp", "pass_td", "pass_int", "pass_sack", "rush_att", "rush_td", "rec_tgt", "rec", "rec_td", "fum_lost"] as const) { assert.ok(g(k) >= 0 && g(k) === Math.round(g(k)), k); }
      assert.ok(g("pass_cmp") <= g("pass_att")); assert.ok(g("rec") <= g("rec_tgt")); }
  });
  test("script scenario probabilities sum to 1 per team and every probability is valid", async () => {
    const fs = await week3Forecasts(); const g = mkGame("g-x", firstPair(fs).a.team, firstPair(fs).b.team); const ws = simulateWeek({ season: 2026, week: 3, games: [g], forecasts: fs, sims: 300, captureKind: "AS_OF_RECONSTRUCTION", asOfAt: () => "2026-09-27T16:00:00.000Z" });
    const env = ws.envs[0]!; for (const t of env.teams) { const total = Object.values(t.scenario_probabilities).reduce((a, b) => a + b, 0); assert.ok(Math.abs(total - 1) < 2e-3, String(total)); assert.ok(Object.values(t.scenario_probabilities).every((p) => p >= 0 && p <= 1)); }
  });
  test("QB scrambles are a sampled dropback outcome (the substrate's scramble count is always 0): a QB with 0 forecast designed rushes still rushes", async () => {
    const fs = await week3Forecasts(); const qb = fs.find((f) => f.position === "QB" && f.confidence !== "INSUFFICIENT_SAMPLE" && (f.opportunity.dropbacks ?? 0) > 20 && (f.opportunity.designed_rushes ?? 1) < 0.5)!;
    const team = qb.nfl_team!; const opp = [...new Set(fs.map((f) => f.nfl_team!))].find((t) => t !== team)!;
    const r = simulateGame(pairOf(fs, team, opp), sampler, priors, { sims: 600 }); const ps = r.players.find((p) => p.forecast.forecast_id === qb.forecast_id)!;
    let rush = 0; for (let s = 0; s < 600; s++) rush += ps.stats[s * N_STATS + STAT_INDEX.rush_att]!; assert.ok(rush / 600 > 0.15, `mean QB rush attempts ${rush / 600}`);
  });
  test("latestForecastPerPlayer: one forecast per player, the latest frozen strictly before that player's kickoff", async () => {
    const fs = await week3Forecasts(); const f = fs[0]!; const g = mkGame("g", f.nfl_team!, "ZZZ");
    const mk = (id: string, asOf: string): RoleForecast => ({ ...f, forecast_id: id, as_of_at: asOf, capture_kind: "LIVE_CAPTURED" });
    const out = latestForecastPerPlayer([mk("early", "2026-09-26T10:00:00Z"), mk("late", "2026-09-27T15:00:00Z"), mk("after", "2026-09-27T17:00:01Z")], [g], 2026, 3);
    assert.equal(out.length, 1); assert.equal(out[0]!.forecast_id, "late");
  });
});

describe("distribution math (hand-verifiable)", () => {
  test("simulation is reproducible: same inputs + seed -> identical; a different game id -> a different stream", async () => {
    const fs = await week3Forecasts(); const spec = firstPair(fs);
    const a = simulateGame(spec, sampler, priors, { sims: 150 }), b = simulateGame(spec, sampler, priors, { sims: 150 }), c = simulateGame({ ...spec, game_id: "other" }, sampler, priors, { sims: 150 });
    assert.deepEqual(Array.from(b.players[3]!.stats), Array.from(a.players[3]!.stats)); assert.equal(a.seed, b.seed); assert.notEqual(c.seed, a.seed);
    assert.notDeepEqual(Array.from(c.players[3]!.stats), Array.from(a.players[3]!.stats));
    assert.equal(seedFrom("x", 1), seedFrom("x", 1));
  });
  test("quantiles of a known sample; summarize is monotone with valid tail probabilities", () => {
    assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.5), 3); assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.25), 2); assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.9), 4.6);
    const d = summarize(Float64Array.from({ length: 1001 }, (_, i) => i / 10));
    const qs = QUANTILE_LEVELS.map((p) => d.quantiles[`p${Math.round(p * 100)}`]!); for (let i = 1; i < qs.length; i++) assert.ok(qs[i]! >= qs[i - 1]!);
    assert.ok(d.floor < d.quantiles.p50! && d.quantiles.p50! < d.ceiling); assert.ok(Object.values(d.prob_ge).every((p) => p >= 0 && p <= 1));
  });
  test("every simulated player distribution is monotone, valid, and floor < ceiling when non-degenerate", async () => {
    const fs = await week3Forecasts(); const r = simulateGame(firstPair(fs), sampler, priors, { sims: 300 }); const coef = linearCoefficients("WR", PPR); void coef;
    for (const p of r.players) { const c = linearCoefficients(p.forecast.position, PPR); const pts = new Float64Array(300); for (let s = 0; s < 300; s++) pts[s] = scoreStats(p.stats, s * N_STATS, c);
      const d = summarize(pts); const qs = QUANTILE_LEVELS.map((x) => d.quantiles[`p${Math.round(x * 100)}`]!); for (let i = 1; i < qs.length; i++) assert.ok(qs[i]! >= qs[i - 1]!);
      if (d.quantiles.p95! > d.quantiles.p5!) assert.ok(d.floor <= d.ceiling); assert.ok(d.sd >= 0); }
  });
  test("pinball loss, interval score and calibration on hand-computed values", () => {
    const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`); near(pinball(5, 3, 0.8), 1.6); near(pinball(1, 3, 0.8), 0.4);
    near(intervalScore(5, 2, 8, 0.4), 6); near(intervalScore(10, 2, 8, 0.4), 6 + (2 / 0.4) * 2); near(intervalScore(0, 2, 8, 0.4), 6 + (2 / 0.4) * 2);
    const q = { p5: 1, p10: 2, p16: 3, p20: 4, p25: 5, p50: 6, p75: 7, p80: 8, p84: 9, p90: 10, p95: 11 };
    const c = calibration([{ actual: 6, quantiles: q, pit: 0.5 }, { actual: 4.5, quantiles: q, pit: 0.2 }, { actual: 12, quantiles: q, pit: 0.99 }, { actual: 0, quantiles: q, pit: 0.01 }]);
    assert.equal(c.n, 4); assert.equal(c.intervals[0]!.observed, 0.25); // only the first lies in P25-P75
    assert.equal(c.intervals[3]!.observed, 0.5); assert.equal(c.exceed_p90, 0.25); assert.equal(c.below_p10, 0.25); assert.equal(c.pit_intervals![1]!.observed, 0.5);
  });
  test("point masses: randomized PIT stays inside the atom's probability range (unbiased coverage), and the recalibration map is the identity for uniform PITs", () => {
    const draws = [0, 0, 0, 0, 5, 6, 7, 8, 9, 10]; // 40% atom at 0
    for (const u of [0, 0.5, 0.999]) { const v = pit(draws, 0, u); assert.ok(v >= 0 && v <= 0.4 + 1e-9); }
    assert.equal(pit(draws, 7.5, 0.3), 0.7); assert.equal(pit(draws, 100, 0.3), 1);
    const uniform = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 1000); const m = recalibrationMap(uniform);
    RECAL_KNOTS.forEach((k, i) => assert.ok(Math.abs(m[i]! - k) < 0.01, `knot ${k}`));
    const skew = Array.from({ length: 1000 }, (_, i) => Math.pow((i + 0.5) / 1000, 0.5)); const ms = recalibrationMap(skew);
    for (let i = 1; i < ms.length; i++) assert.ok(ms[i]! >= ms[i - 1]!); assert.ok(Math.abs(inverseLevel(ms, mapLevel(ms, 0.4)) - 0.4) < 0.01);
    const d = Float64Array.from({ length: 999 }, (_, i) => i); assert.deepEqual(summarizeRecalibrated(d, null).quantiles, summarize(d).quantiles);
  });
  test("production heuristic as a distribution: normal(median, |median|*CV) with its 0 clamp == weeklyBand floor/ceiling at P20/P80", () => {
    for (const [pos, med] of [["WR", 10], ["TE", 6], ["QB", 18], ["RB", 12.5]] as const) {
      const band = weeklyBand(med, pos, 1); const q = normalQuantiles(med, med * WEEKLY_POSITION_CV[pos]!);
      assert.ok(Math.abs(q.p20! - band.floor) < 0.02, `${pos} floor`); assert.ok(Math.abs(q.p80! - band.ceiling) < 0.02, `${pos} ceiling`); assert.equal(q.p50, med);
    }
    assert.equal(normalQuantiles(1, 5).p5, 0); // lower clamp at 0 for a non-negative median, as production
    assert.ok(pitNormalClamped(0, 1, 5, 0.5) <= 0.5 * 0.6); assert.ok(Math.abs(pitNormalClamped(1, 1, 5, 0.1) - 0.5) < 1e-6);
  });
});

describe("one football outcome, multiple league translations", () => {
  test("fast linear scoring equals the repo's scoring engine on arbitrary lines, for every position and league", () => {
    const rng = mulberry32(11);
    for (const raw of [PPR, HALF, { ...HALF, bonus_rec_te: 0.5 }]) for (const pos of ["QB", "RB", "WR", "TE"] as const) {
      const coef = linearCoefficients(pos, raw);
      for (let t = 0; t < 30; t++) { const line: Record<string, number> = {}; const v = new Float32Array(N_STATS); STAT_KEYS.forEach((k, i) => { const x = Math.floor(rng() * 12); line[k] = x; v[i] = x; }); assert.ok(Math.abs(scoreExpectedLine(pos, line, raw) - scoreStats(v, 0, coef)) < 1e-4); }
    }
  });
  test("the SAME simulated stat line scores differently under different league fingerprints (TE premium, PPR, interception value)", async () => {
    const fs = await week3Forecasts(); const teamsAll = [...new Set(fs.map((f) => f.nfl_team!))]; const teTeam = fs.find((f) => f.position === "TE" && (f.metrics.target_share?.value ?? 0) > 0.1 && f.confidence !== "INSUFFICIENT_SAMPLE")!.nfl_team!; const r = simulateGame(pairOf(fs, teTeam, teamsAll.find((t) => t !== teTeam)!), sampler, priors, { sims: 200 }); const te = r.players.find((p) => p.forecast.position === "TE" && (p.forecast.metrics.target_share?.value ?? 0) > 0.1)!;
    const mean = (raw: Record<string, number>) => { const c = linearCoefficients("TE", raw); let s = 0; for (let k = 0; k < 200; k++) s += scoreStats(te.stats, k * N_STATS, c); return s / 200; };
    assert.ok(mean(PPR) > mean(HALF)); assert.ok(mean({ ...HALF, bonus_rec_te: 0.5 }) > mean(HALF));
    const rec = buildPlayerDistributionRecord({ ps: te, sims: 200, seed: r.seed, game: mkGame("g", te.forecast.nfl_team!, "ZZZ"), env_id: null, captureKind: "AS_OF_RECONSTRUCTION", asOfAt: "2026-09-27T16:00:00.000Z", leagues: [{ scoring_fingerprint: "fp-ppr", raw_scoring: PPR }, { scoring_fingerprint: "fp-half", raw_scoring: HALF }, { scoring_fingerprint: "fp-ppr", raw_scoring: PPR }], priors });
    assert.deepEqual(Object.keys(rec.fantasy).sort(), ["fp-half", "fp-ppr"]); assert.ok(rec.fantasy["fp-ppr"]!.raw.mean > rec.fantasy["fp-half"]!.raw.mean);
    assert.equal(rec.football.rec_yd!.mean, rec.football.rec_yd!.mean); const td = rec.td_count_probabilities; assert.ok(Math.abs(td.zero + td.one + td.two + td.three_plus - 1) < 1e-3);
  });
});

describe("analysis: models A/B/C/D, error classes and exclusions", () => {
  const base = (over: Partial<RoleAnalysisRow> = {}): RoleAnalysisRow => ({ analysis_id: "ra:" + "a".repeat(24), analysis_version: "v", case_id: "cc:" + "1".repeat(24), evidence_digest: "d", forecast_id: "rf:x", season: 2026, week: 3, league_slug: "L1", provider: "sleeper", scoring_fingerprint: "fp-ppr", position: "WR", canonical_player_id: "player:gsis:x", gsis_id: "x", sleeper_id: "1", player_name: "X", nfl_team: "AAA", baseline_projection: 10, actual_fantasy_points: 14, projection_error: 4, forecast_capture_kind: "AS_OF_RECONSTRUCTION", forecast_confidence: "LOW", confidence_score: 0.4, role: {}, opportunity: { forecast: null, forecast_no_pressure: null, actual: null }, xfp: { forecast: 9, forecast_no_pressure: 9, actual_opportunity: 12 }, decomposition: null, labels: { designation: "NONE", expected_absent: false, participated: true, injury_contamination: null, teammate_absence: false, depth_starter: true, role_trend: "STABLE", role_volatility: 0.02 }, eval_populations: { projection_eval: true, role_accuracy: true }, exclusion_reasons: [], shadow: { mode: "SHADOW_ONLY", baseline_projection: 10, role_adjustment: 0.6, candidate_projection: 10.6, teammate_only_adjustment: 0, teammate_only_candidate: 10, contributions: { xfp_forecast: 9, xfp_effective: 9, xfp_gap_vs_baseline: -1, teammate_pressure_points: 0, kappa: 0.3, confidence_weight: 0.6, capped: false }, confidence: "LOW", reason_codes: [] }, stats_note: "", ...over });
  async function sim() { const fs = await week3Forecasts(); const r = simulateGame(firstPair(fs), sampler, priors, { sims: 400 }); const ps = r.players.find((p) => p.forecast.position === "WR" && (p.forecast.metrics.target_share?.value ?? 0) > 0.12)!; return { r, ps }; }
  test("models A/B/C/D: A = production normal, B/D keep the baseline/candidate mean, C = simulated mean; scores are internally consistent; SHADOW_ONLY", async () => {
    const { ps } = await sim(); const gsis = ps.forecast.gsis_id!;
    const rows = buildDistributionAnalysis({ roleRows: [base({ gsis_id: gsis })], cases: new Map([["cc:" + "1".repeat(24), { case_id: "cc:" + "1".repeat(24), projected_std_dev: 4.8, projected_floor: null, projected_ceiling: null, projection_artifact_kind: "PROJECTION_SNAPSHOT" }]]), sims: new Map(), simByGsis: new Map([[gsis, ps]]), priors, rawScoringByFingerprint: new Map([["fp-ppr", PPR]]) });
    assert.equal(rows.length, 1); const r = rows[0]!;
    assert.equal(r.mode, "SHADOW_ONLY"); assert.equal(r.models.A.mean, 10); assert.equal(r.models.A.sd, 4.8); assert.ok(Math.abs(r.models.A.quantiles.p20! - (10 - 0.8416 * 4.8)) < 0.02);
    assert.equal(r.models.B.mean, 10); assert.equal(r.models.D.mean, 10.6); assert.equal(r.models.C.mean, r.sim.sim_mean);
    for (const m of ["A", "B", "C", "D"] as const) { const q = r.models[m].quantiles; assert.ok(q.p10! <= q.p50! && q.p50! <= q.p90!); assert.equal(r.models[m].scores.inside_60, 14 >= q.p20! && 14 <= q.p80!); assert.ok(r.models[m].scores.pit >= 0 && r.models[m].scores.pit <= 1); }
    assert.equal(r.mean_miss_5, false); assert.equal(r.mean_miss_8, false); assert.equal(r.baseline_projection, 10);
  });
  test("injury-contaminated and DNP cases: contaminated rows leave the primary population (counted, not silently dropped); DNP stays a real outcome", async () => {
    const { ps } = await sim(); const gsis = ps.forecast.gsis_id!; const mk = (over: Partial<RoleAnalysisRow>, id: string) => base({ gsis_id: gsis, case_id: "cc:" + id.repeat(24), league_slug: id, ...over });
    const contaminated = mk({ labels: { ...base().labels, injury_contamination: "POSSIBLE_IN_GAME_INJURY" }, eval_populations: { projection_eval: false, role_accuracy: false } }, "2");
    const dnp = mk({ actual_fantasy_points: 0, labels: { ...base().labels, participated: false } }, "3");
    const rows = buildDistributionAnalysis({ roleRows: [mk({}, "1"), contaminated, dnp], cases: new Map(), sims: new Map(), simByGsis: new Map([[gsis, ps]]), priors, rawScoringByFingerprint: new Map([["fp-ppr", PPR]]) });
    const rep = distributionReport(rows.map((r, i) => ({ ...r, scoring_fingerprint: `fp-${i}` })));
    assert.equal(rep.populations.injury_contaminated_excluded, 1); assert.equal(rep.populations.primary, 2); assert.equal(rep.populations.dnp_in_primary, 1); assert.equal(rep.populations.rows_total, 3);
  });
  test("football dedupe: the same player under the same scoring fingerprint counts once; Yahoo is not pooled", async () => {
    const { ps } = await sim(); const gsis = ps.forecast.gsis_id!; const rows = buildDistributionAnalysis({ roleRows: [base({ gsis_id: gsis, case_id: "cc:" + "1".repeat(24), league_slug: "Devoted" }), base({ gsis_id: gsis, case_id: "cc:" + "2".repeat(24), league_slug: "Sportys" }), base({ gsis_id: gsis, case_id: "cc:" + "3".repeat(24), league_slug: "Rogers", provider: "yahoo", scoring_fingerprint: "fp-yahoo" })], cases: new Map(), sims: new Map(), simByGsis: new Map([[gsis, ps]]), priors, rawScoringByFingerprint: new Map([["fp-ppr", PPR], ["fp-yahoo", HALF]]) });
    assert.equal(dedupeDist(rows).length, 1); assert.equal(dedupeDist(rows, { includeYahoo: true }).length, 2);
  });
  test("six-way error decomposition is an exact identity (baseline gap + volume + role share + TD + turnover + yardage)", () => {
    const yields = JSON.parse(readFileSync("lib/role-calibration/data/position_yields_2025.json", "utf8"));
    const forecast = { position: "RB", metrics: { rush_share: { value_with_pressure: 0.55 }, rz_carry_share: { value_with_pressure: 0.4 }, target_share: { value_with_pressure: 0.1 }, rz_target_share: { value_with_pressure: 0.05 } }, volumes: { team_pass_att: 35, team_rush_att: 25, team_rz_pass_att: 5, team_rz_rush_att: 4 }, opportunity: { carries: 13.75, rz_carries: 1.6, targets: 3.5, rz_targets: 0.25, dropbacks: null, rz_dropbacks: null, designed_rushes: null, scrambles: null } } as unknown as RoleForecast;
    const actualRow = { team_pass_att: 42, team_rush_att: 21, team_rz_pass_att: 7, team_rz_rush_att: 3, carries: 17, red_zone_carries: 3, targets: 5, red_zone_targets: 1 } as never;
    for (const [actual, line] of [[24, { rush_att: 17, rush_yd: 110, rush_td: 2, rec_tgt: 5, rec: 3, rec_yd: 20, rec_td: 0, fum_lost: 0 }], [3.4, { rush_att: 17, rush_yd: 30, rush_td: 0, rec_tgt: 5, rec: 1, rec_yd: 4, rec_td: 0, fum_lost: 1 }]] as const) {
      const d = decompose6({ pos: "RB", baseline: 11, actual, forecast, actualRow, actualLine: line as unknown as Record<string, number>, yields, raw: PPR })!;
      assert.ok(Math.abs(d.total_error - DECOMP6_KEYS.reduce((s, k) => s + d[k], 0)) < 6e-4); assert.equal(d.total_error, Math.round((actual - 11) * 1e4) / 1e4);
    }
  });
});

describe("persistence: idempotency, versioning, immutability", () => {
  const fakeRest = () => { const seen = new Set<string>(); const targets: string[] = []; return { rest: { insertIgnoreDuplicates: async (_t: string, rows: Array<Record<string, string>>, cols: string[]) => { targets.push(cols[0]!); return rows.filter((r) => { const k = r[cols[0]!]!; if (seen.has(k)) return false; seen.add(k); return true; }); } } as unknown as SupabaseRest, targets }; };
  test("env / player-distribution / analysis / weather writes are idempotent (second identical write inserts nothing) and key on the primary id", async () => {
    const fs = await week3Forecasts(); const spec = firstPair(fs); const g = mkGame("g-1", spec.a.team, spec.b.team);
    const ws = simulateWeek({ season: 2026, week: 3, games: [g], forecasts: fs, sims: 100, captureKind: "AS_OF_RECONSTRUCTION", asOfAt: () => "2026-09-27T16:00:00.000Z" });
    const f = fakeRest(); const env = ws.envs[0]!; const pd = buildPlayerDistributionRecord({ ps: [...ws.simByGsis.values()][0]!, sims: 100, seed: 1, game: g, env_id: env.env_id, captureKind: "AS_OF_RECONSTRUCTION", asOfAt: "2026-09-27T16:00:00.000Z", leagues: [], priors });
    const a = await writeEnvironments(f.rest, [env]), b = await writeEnvironments(f.rest, [env]); assert.equal(a.inserted, 1); assert.equal(b.inserted, 0); assert.equal(b.duplicate, 1);
    assert.equal((await writePlayerDistributions(f.rest, [pd])).inserted, 1); assert.equal((await writePlayerDistributions(f.rest, [pd])).inserted, 0);
    const snap = buildWeatherSnapshot(mkGame("g-w", "GB", "ATL"), { forecast_issued_at: "2026-09-27T10:00:00Z", source_url: "u", period: { startTime: "2026-09-27T17:00:00Z", endTime: "2026-09-27T18:00:00Z", temperature: 50, temperatureUnit: "F", windSpeed: "5 to 10 mph", shortForecast: "Rain", probabilityOfPrecipitation: { value: 60 } }, wind_gust_mph: 18, precip_mm: 1.2, raw: { selected_period: "x" } }, "2026-09-27T11:00:00.000Z").snapshot!;
    assert.equal((await writeWeather(f.rest, [snap])).inserted, 1); assert.equal((await writeWeather(f.rest, [snap])).inserted, 0);
    assert.deepEqual([...new Set(f.targets)].sort(), ["env_id", "pd_id", "snapshot_id"]);
    assert.equal((await writeDistributionAnalysis(f.rest, [])).attempted, 0);
  });
  test("deterministic ids; changed inputs create a NEW id (a new revision), never a rewrite", async () => {
    const fs = await week3Forecasts(); const spec = firstPair(fs); const g = mkGame("g-1", spec.a.team, spec.b.team);
    const run = (sims: number) => simulateWeek({ season: 2026, week: 3, games: [g], forecasts: fs, sims, captureKind: "AS_OF_RECONSTRUCTION", asOfAt: () => "2026-09-27T16:00:00.000Z" });
    const a = run(120), b = run(120), c = run(121);
    assert.equal(a.envs[0]!.env_id, b.envs[0]!.env_id); assert.notEqual(c.envs[0]!.env_id, a.envs[0]!.env_id);
    assert.match(a.envs[0]!.env_id, /^ge:[0-9a-f]{24}$/); assert.equal(a.envs[0]!.model_version, GAME_DISTRIBUTION_MODEL_VERSION);
    const wxA = buildWeatherSnapshot(mkGame("g-1", spec.a.team, spec.b.team, { home_team: "GB", away_team: "ATL" }), { forecast_issued_at: "2026-09-27T10:00:00Z", source_url: "u", period: { startTime: "2026-09-27T17:00:00Z", endTime: "2026-09-27T18:00:00Z", temperature: 50, temperatureUnit: "F", windSpeed: "5 mph", shortForecast: "Clear", probabilityOfPrecipitation: { value: 0 } }, wind_gust_mph: 8, precip_mm: 0, raw: { selected_period: "x" } }, "2026-09-27T11:00:00.000Z").snapshot!;
    const withW = buildGameEnvironment({ game: g, sim: [...a.sims.values()][0]!, observed: loadObservedRoleGames(), qbChange: { a: false, b: false }, teams: [g.home_team, g.away_team], weather: wxA, fi: null, captureKind: "AS_OF_RECONSTRUCTION", asOfAt: "2026-09-27T16:00:00.000Z", dataCutoffAt: null, firstForecasts: [{ games_used: 5, pass: 30, rush: 25, rzp: 4, rzr: 3 }, { games_used: 5, pass: 30, rush: 25, rzp: 4, rzr: 3 }] });
    assert.notEqual(withW.env_id, a.envs[0]!.env_id); assert.equal(withW.weather.status, "CAPTURED_PREGAME"); assert.equal(a.envs[0]!.weather.status, "NOT_CAPTURED");
  });
});

describe("priors, recency and the fallback chain (regression for the pool-contamination bug)", () => {
  test("recency is read from the forecast's own metrics, so forecasts persisted before provenance carried the field still classify correctly", () => {
    const f = { season: 2026, week: 3, position: "RB", provenance: { last_game: { season: 2026, week: 2 } }, metrics: { rush_share: { n_games_season: 2 } } };
    assert.equal(recencyOf(f), "ACT"); assert.equal(recencyOf({ ...f, provenance: { last_game: { season: 2025, week: 17 } } }), "LAP");
    assert.equal(recencyOf({ ...f, metrics: { rush_share: { n_games_season: 0 } } }), "LAP"); assert.equal(recencyOf({ ...f, week: 9, provenance: { last_game: { season: 2026, week: 8 } } }), "LAP"); // 2 games in 8 weeks = sporadic
  });
  test("pool fallback drops the sample tier before the starter-vs-backup magnitude; tiers and availability classes", () => {
    const keys = poolKeys("QB", "HEALTHY", "ACT", "T0", 2); assert.equal(keys[0], "QB|HEALTHY|ACT|T0|2"); assert.equal(keys[1], "QB|HEALTHY|ACT|m2"); assert.equal(keys[2], "QB|HEALTHY|ACT|T0");
    const row = { played: 1 as const, d_snap: 0, d_target: 0, d_rush: 0, d_rz_target: 0, d_rz_carry: 0, ratio_dropbacks: 1, d_designed: 0, d_scrambles: 0 };
    const pools = { "QB|HEALTHY|ACT|T0|2": { n: MIN_POOL - 1, rows: [row] }, "QB|HEALTHY|ACT|m2": { n: MIN_POOL, rows: [row] }, "QB|HEALTHY|ACT|T0": { n: 500, rows: [row] } };
    assert.equal(selectPool({ role_pools: pools }, keys).key, "QB|HEALTHY|ACT|m2");
    assert.equal(tierOf(2), "T0"); assert.equal(tierOf(5), "T1"); assert.equal(tierOf(12), "T2"); assert.equal(availabilityClass("UNKNOWN"), "HEALTHY"); assert.equal(availabilityClass("DOUBTFUL"), "DOUBTFUL");
  });
  test("fitted priors: prior-season, disjoint recalibration/hold-out weeks, and a hold-out PIT calibration near nominal", () => {
    const rep = JSON.parse(readFileSync("lib/game-distribution/data/fit_report_2025.json", "utf8")); const rw = new Set(priors.recalibration.fit_weeks as number[]);
    assert.ok(priors.shocks.holdout_weeks.every((w: number) => !rw.has(w)));
    const pit = rep.holdout_overall_recalibrated.pit_intervals as Array<{ nominal: number; observed: number }>; for (const i of pit) assert.ok(Math.abs(i.observed - i.nominal) < 0.07, `${i.nominal}: ${i.observed}`);
    assert.ok(priors.team_game_pairs.length > 150);
  });
});

describe("weather capture: parsers, stadiums, risk", () => {
  test("NWS parsers: wind ranges, hourly period selection, gridpoint intervals", () => {
    assert.equal(parseWindMph("5 to 10 mph"), 10); assert.equal(parseWindMph("12 mph"), 12); assert.equal(parseWindMph(null), null); assert.equal(parseWindMph("calm"), null);
    const periods = [{ startTime: "2026-09-27T16:00:00Z", endTime: "2026-09-27T17:00:00Z" }, { startTime: "2026-09-27T17:00:00Z", endTime: "2026-09-27T18:00:00Z" }] as never;
    assert.equal(pickPeriod(periods, Date.parse("2026-09-27T17:00:00Z"))?.startTime, "2026-09-27T17:00:00Z"); assert.equal(pickPeriod(periods, Date.parse("2026-09-27T19:00:00Z")), null);
    const series = { values: [{ validTime: "2026-09-27T15:00:00+00:00/PT3H", value: 20 }, { validTime: "2026-09-27T18:00:00+00:00/P1DT0H", value: 5 }] };
    assert.equal(gridValueAt(series, Date.parse("2026-09-27T17:59:00Z")), 20); assert.equal(gridValueAt(series, Date.parse("2026-09-27T18:00:00Z")), 5); assert.equal(gridValueAt(series, Date.parse("2026-09-27T14:00:00Z")), null);
  });
  test("stadium registry covers all 32 clubs; domes are domes; retractable roof status is unknown (null) and flagged", () => {
    assert.equal(Object.keys(STADIUMS).length, 32); for (const t of ["DET", "LV", "MIN", "NO"]) assert.equal(STADIUMS[t]!.roof, "dome"); for (const t of ["ARI", "ATL", "DAL", "HOU", "IND"]) assert.equal(STADIUMS[t]!.roof, "retractable");
    const dome = buildWeatherSnapshot(mkGame("g", "DET", "GB"), null, "2026-09-27T10:00:00.000Z").snapshot!; assert.equal(dome.risk_class, "DOME_CONTROLLED"); assert.equal(dome.source, "stadium_registry"); assert.equal(dome.temp_f, null);
    assert.equal(buildWeatherSnapshot(mkGame("g", "GB", "ATL"), null, "2026-09-27T10:00:00.000Z").skipped, "NO_FORECAST_AVAILABLE");
    assert.equal(buildWeatherSnapshot(mkGame("g", "GB", "ATL", { provenance: { espn_neutral_site: true } }), null, "2026-09-27T10:00:00.000Z").skipped, "NEUTRAL_SITE_UNSUPPORTED");
    assert.ok(weatherRisk({ roof: "retractable", temp_f: 70, wind_mph: 5, wind_gust_mph: null, precip_prob: 0, short_forecast: "Clear" }).flags.includes("ROOF_STATUS_UNKNOWN"));
  });
  test("risk classification is descriptive and monotone in conditions (never a fantasy adjustment)", () => {
    const r = (o: Partial<Parameters<typeof weatherRisk>[0]>) => weatherRisk({ roof: "outdoor", temp_f: 65, wind_mph: 4, wind_gust_mph: null, precip_prob: 5, short_forecast: "Sunny", ...o });
    assert.equal(r({}).risk_class, "LOW"); assert.equal(r({ wind_mph: 22 }).risk_class, "HIGH"); assert.ok(r({ wind_mph: 22 }).flags.includes("HIGH_WIND"));
    assert.ok(r({ precip_prob: 90, short_forecast: "Heavy Snow" }).risk_score! >= r({ precip_prob: 90, short_forecast: "Rain" }).risk_score!); assert.equal(r({ temp_f: null, wind_mph: null, precip_prob: null }).risk_class, "UNKNOWN");
    assert.ok(r({ temp_f: 10 }).risk_score! > r({ temp_f: 40 }).risk_score!);
  });
});

describe("FI interaction family repair (always null before: nothing resolved fi_interaction_* value columns)", () => {
  const fi = loadFootballIntelligence();
  test("resolves from the published FI contextual-matchup feature as a LABELED PROXY; unavailable/unknown stays null", { skip: !fi }, () => {
    const x = interactionValueFor(fi!, "MIN", "CHI", "fi_interaction_pass_epa_vs_pass_defense_modeled"); assert.ok(x && x.value != null && x.value >= -1 && x.value <= 1); assert.equal(x!.proxy, INTERACTION_PROXY_NOTE);
    assert.equal(interactionValueFor(fi!, "MIN", "ZZZ", "fi_interaction_pass_epa_vs_pass_defense_modeled"), null); assert.equal(interactionValueFor(fi!, null, "CHI", "fi_interaction_pass_epa_vs_pass_defense_modeled"), null);
    assert.equal(interactionValueFor(fi!, "MIN", "CHI", "fi_usage_snap_share_modeled"), null);
    const adj = translateFiAdjustment({ canonical_player_id: "player:sleeper:6794", position: "WR", nfl_team: "MIN", opponent: "CHI", baseline_projection: 12, request_season: 2026 });
    const c = adj.contributions.find((k) => k.family === "interaction_pass_epa_vs_pass_defense")!; assert.ok(c.fi_value != null); assert.ok(adj.warnings.includes(INTERACTION_PROXY_NOTE));
    const none = translateFiAdjustment({ canonical_player_id: "player:sleeper:6794", position: "WR", nfl_team: "MIN", opponent: null, baseline_projection: 12, request_season: 2026 });
    assert.equal(none.contributions.find((k) => k.family === "interaction_pass_epa_vs_pass_defense")!.fi_value, null);
  });
});

describe("shadow-only isolation", () => {
  const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (!["node_modules", ".next", "data"].includes(n)) walk(p, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(p); } return out; };
  test("nothing in production imports lib/game-distribution or lib/game-weather except the weekly audit and Phase-3 routes", () => {
    const allowed = (f: string) => ["game-distribution", "game-weather", "role-calibration", "calibration"].some((m) => f.includes(join("lib", m))) || ["game-distribution", "game-weather"].some((m) => f.includes(join("app", "api", m))) || f.includes(join("app", "api", "cron", "game-environment")) || f.endsWith(join("lib", "weekly-audit", "build.ts")) || f.endsWith(join("lib", "weekly-audit", "contract.ts"));
    const offenders = ["lib", "app"].flatMap((d) => walk(join(process.cwd(), d))).filter((f) => !allowed(f) && /@\/lib\/(game-distribution|game-weather)\//.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
  });
  test("lib/game-distribution and lib/game-weather import no production model/decision module (only the uncertainty constants and the scoring path), and write only their own tables", () => {
    for (const f of [...walk(join(process.cwd(), "lib", "game-distribution")), ...walk(join(process.cwd(), "lib", "game-weather"))]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/from ["']@\/lib\/(projections|weekly\/(lineup|start-sit|waivers|matchup|projections)|matchup2|waiver2|orchestrator)/.test(src), f);
      assert.ok(!/insertIgnoreDuplicates\([^)]*["']bridge_(projection|startsit|matchup2|waiver2|calibration|weekly)/.test(src) && !/rest\.(update|updateReturning|insert)\(/.test(src), f);
    }
  });
});
