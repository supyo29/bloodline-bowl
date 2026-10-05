/**
 * Projection Calibration Phase 2 — Role & Opportunity calibration tests: point-in-time integrity + adversarial leakage, missingness,
 * position logic, teammate propagation, identity interoperability, exact decomposition, SHADOW_ONLY candidate, evaluation math,
 * FI usage-family repair, injury labeling and DB/production isolation guards.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadObservedRoleGames, loadRoleProfilesAsOf, loadPositionYields, loadInjuryReports, type ObservedRow, type ProfileRow, type InjuryRow } from "@/lib/role-calibration/data";
import { ewma, forecastTeamVolume, forecastQbVolume } from "@/lib/role-calibration/volume";
import { buildRoleForecast, assertPointInTime, designationOf, P_ABSENT } from "@/lib/role-calibration/forecast";
import { buildWeekForecasts } from "@/lib/role-calibration/forecast-week";
import { buildRoleAnalysis, selectForecast, type CaseLike } from "@/lib/role-calibration/analysis";
import { expectedPoints, expectedStatLine } from "@/lib/role-calibration/xfp";
import { shadowCandidate, ROLE_SHADOW_KAPPA } from "@/lib/role-calibration/shadow";
import { compare, tail, roleAccuracy, pearson, dedupeFootball, roleVsFantasy } from "@/lib/role-calibration/evaluate";
import { loadOpportunityPropagationModel } from "@/lib/opportunity-propagation-intelligence/read";
import { METRICS_BY_POSITION, type RoleForecast, type RolePosition } from "@/lib/role-calibration/types";
import { loadFootballIntelligence } from "@/lib/football-intel";
import { usageValueFor, fiIdsFromCanonical } from "@/lib/weekly/start-sit-fi/usage-values";
import { translateFiAdjustment } from "@/lib/weekly/start-sit-fi/translate";
import type { NflGame } from "@/lib/calibration/types";

const PPR = { pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2 };
const YIELDS = loadPositionYields(2025)!;
const obs = (over: Partial<ObservedRow>): ObservedRow => ({ season: 2026, week: 1, game_id: "g", gsis_id: "g1", sleeper_id: "s1", full_name: "P", position: "WR", team: "AAA", opponent: "BBB", offensive_snaps: 50, team_offensive_plays: 65, snap_share: 0.77, route_participation: null, targets: 8, team_pass_att: 35, target_share: 0.229, receptions: 5, air_yards_share: 0.2, carries: null, team_rush_att: 25, rush_share: null, position_group_rush_share: null, position_group_target_share: null, dropbacks: null, qb_scrambles: null, designed_rushes: null, red_zone_targets: 1, red_zone_carries: null, inside_10_carries: null, goal_line_carries: null, end_zone_targets: 0, team_rz_pass_att: 5, team_rz_rush_att: 4, rz_target_share: 0.2, rz_carry_share: null, third_down_targets: 2, third_down_carries: null, two_minute_targets: 0, two_minute_carries: null, inside_10_carry_share: null, goal_line_carry_share: null, ...over });
const metric = (recent: number | null, n = 2, season: number | null = recent) => ({ recent, season, prior: recent, prior_conf: "LOW", discontinuity: "NONE", n_games: n, opp_total: 30, conf: "LOW" });
const prof = (gsis: string, position: string, team: string, m: Record<string, number | null>, n = 2): ProfileRow => ({ target_week: 3, gsis_id: gsis, sleeper_id: `s-${gsis}`, full_name: gsis, position, team, last_game_season: 2026, last_game_week: 2, last_game_team: team, games_before_target_season: n, roster_team_source: "rosters_weekly", metrics: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, metric(v, n)])) });
const inj = (gsis: string, status: string, week = 3): InjuryRow => ({ season: 2026, week, gsis_id: gsis, team: "AAA", position: "WR", report_status: status, practice_status: null, report_primary_injury: null });
const history: ObservedRow[] = [obs({ week: 1, gsis_id: "x", team: "AAA" }), obs({ week: 2, gsis_id: "x", team: "AAA", team_pass_att: 45 }), obs({ season: 2025, week: 17, gsis_id: "x", team: "AAA", team_pass_att: 30 })];
const KICK = "2026-09-27T17:00:00.000Z";
const fcast = (profile: ProfileRow, teammates: ProfileRow[], injuries: InjuryRow[], observed: readonly ObservedRow[] = history) => buildRoleForecast({ season: 2026, week: 3, profile, teammates, observed, injuries, depth: [], propagation: loadOpportunityPropagationModel(), nflGameId: "g3", kickoffAt: KICK, asOfAt: "2026-09-27T16:00:00.000Z", captureKind: "AS_OF_RECONSTRUCTION", priorGameKickoff: () => "2026-09-21T17:00:00.000Z" });
// an injury table that contains reports for the week (so absent players are 'NONE' rather than 'UNKNOWN')
const weekHasReports = (extra: InjuryRow[] = []): InjuryRow[] => [inj("someone-else", "Questionable"), ...extra];

describe("point-in-time integrity + adversarial leakage", () => {
  test("EWMA matches the canonical R ewma_through (half-life 2, oldest->newest, NA dropped)", () => {
    assert.equal(ewma([1]), 1);
    const w = (k: number) => Math.pow(0.5, k / 2);
    assert.ok(Math.abs(ewma([0.2, 0.4, 0.6])! - (w(2) * 0.2 + w(1) * 0.4 + w(0) * 0.6) / (w(2) + w(1) + w(0))) < 1e-12);
    assert.equal(ewma([null, null]), null);
  });
  test("team/QB volume forecasts use ONLY strictly-earlier games: mutating the target week's own rows changes nothing", () => {
    const base = forecastTeamVolume(history, "AAA", 2026, 3);
    const poisoned = [...history, obs({ week: 3, gsis_id: "x", team: "AAA", team_pass_att: 999, team_rush_att: 999, team_rz_pass_att: 99, team_rz_rush_att: 99 }), obs({ week: 4, gsis_id: "x", team: "AAA", team_pass_att: 777 })];
    assert.deepEqual(forecastTeamVolume(poisoned, "AAA", 2026, 3), base);
    assert.equal(base.games_used, 3);
    const qb = [obs({ week: 1, gsis_id: "q", position: "QB", dropbacks: 30, designed_rushes: 2, qb_scrambles: 1 }), obs({ week: 3, gsis_id: "q", position: "QB", dropbacks: 99 })];
    assert.equal(forecastQbVolume(qb, "q", 2026, 3).dropbacks, 30);
  });
  test("ADVERSARIAL: Week 3 final stats cannot alter the Week 3 pregame forecast (real committed data, every player)", async () => {
    const observed = loadObservedRoleGames();
    const games: NflGame[] = [];
    const prior = new Map<string, string>();
    for (const t of new Set(observed.filter((o) => o.season === 2026).map((o) => o.team))) { prior.set(`2026|1|${t}`, "2026-09-13T17:00:00.000Z"); prior.set(`2026|2|${t}`, "2026-09-20T17:00:00.000Z"); games.push({ nfl_game_id: `g-${t}`, season: 2026, week: 3, home_team: t, away_team: "ZZZ", kickoff_at: KICK, kickoff_source: "test", status: "complete", provenance: {} }); }
    const a = await buildWeekForecasts({ season: 2026, week: 3, captureKind: "AS_OF_RECONSTRUCTION", games, priorKickoffs: prior, observed });
    // poison every Week-3 outcome to absurd values and rebuild
    const poisoned = observed.map((o) => (o.season === 2026 && o.week >= 3 ? { ...o, snap_share: 1, target_share: 0.99, rush_share: 0.99, targets: 60, carries: 60, dropbacks: 200, team_pass_att: 500, team_rush_att: 500, team_rz_pass_att: 90, team_rz_rush_att: 90, rz_target_share: 0.99, rz_carry_share: 0.99 } : o));
    const b = await buildWeekForecasts({ season: 2026, week: 3, captureKind: "AS_OF_RECONSTRUCTION", games, priorKickoffs: prior, observed: poisoned });
    assert.ok(a.forecasts.length > 500);
    assert.deepEqual(b.forecasts.map((f) => f.forecast_id), a.forecasts.map((f) => f.forecast_id));
    assert.deepEqual(b.forecasts.map((f) => f.opportunity), a.forecasts.map((f) => f.opportunity));
    assert.deepEqual(a.forecasts.flatMap((f) => assertPointInTime(f)), []);
  });
  test("the committed role profiles are reproducible from strictly-earlier games ONLY (statistically: EWMA over weeks < target matches the R export; including the target week does not)", () => {
    const observed = loadObservedRoleGames();
    const profiles = loadRoleProfilesAsOf().filter((p) => p.target_week === 3 && p.position === "WR" && (p.metrics.target_share?.n_games ?? 0) >= 2);
    assert.ok(profiles.length >= 50);
    const before: number[] = [], withW3: number[] = []; let closer = 0, n = 0;
    for (const p of profiles) {
      const rows = observed.filter((o) => o.gsis_id === p.gsis_id).sort((a, b) => a.season - b.season || a.week - b.week);
      const csv = p.metrics.target_share!.recent; if (csv == null) continue;
      const hasW3 = rows.some((o) => o.season === 2026 && o.week === 3 && o.target_share != null); if (!hasW3) continue;
      // (the R profile also carries pre-2025 history at tiny EWMA weights, so equality is to ~1e-2, never exact)
      const b = Math.abs(ewma(rows.filter((o) => o.season < 2026 || o.week < 3).map((o) => o.target_share))! - csv), w = Math.abs(ewma(rows.map((o) => o.target_share))! - csv);
      before.push(b); withW3.push(w); n++; if (b <= w) closer++;
    }
    const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    assert.ok(n >= 50);
    assert.ok(Math.max(...before) < 0.03, "every profile is within the pre-2025-history residual of the strictly-earlier EWMA");
    assert.ok(med(before) < 5e-4, `median strictly-before deviation ${med(before)}`);
    assert.ok(med(withW3) > 5e-3, `median deviation if week 3 leaked ${med(withW3)}`); // the test has teeth: leakage would move the numbers ~20x more
    assert.ok(closer / n >= 0.85, `strictly-before is the closer reconstruction for ${closer}/${n} players`);
  });
  test("DB-level guards: as_of/cutoff strictly before kickoff, and LIVE capture rejected at/after kickoff (migration text)", () => {
    const sql = readFileSync("supabase/migrations/20260930120000_role_calibration.sql", "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.match(sql, /as_of_at < kickoff_at/); assert.match(sql, /data_cutoff_at < kickoff_at/); assert.match(sql, /now\(\) >= new\.kickoff_at/);
    assert.equal((sql.match(/before update or delete on public\.bridge_role_/g) ?? []).length, 2);
    assert.ok(!/drop table|alter table public\.bridge_(projection|calibration|startsit|weekly)/i.test(sql));
  });
  test("assertPointInTime flags a forecast whose as_of or input game is not before kickoff", () => {
    const f = fcast(prof("a", "WR", "AAA", { target_share: 0.2 }), [], weekHasReports());
    assert.deepEqual(assertPointInTime(f), []);
    assert.ok(assertPointInTime({ ...f, as_of_at: KICK }).length > 0);
    assert.ok(assertPointInTime({ ...f, data_cutoff_at: "2026-09-27T18:00:00.000Z" }).length > 0);
    assert.ok(assertPointInTime({ ...f, provenance: { last_game: { season: 2026, week: 3 } } }).length > 0);
  });
  test("selectForecast: latest frozen strictly before kickoff wins; a post-kickoff forecast is rejected; LIVE beats reconstruction on a tie", () => {
    const base = fcast(prof("a", "WR", "AAA", { target_share: 0.2 }), [], weekHasReports());
    const mk = (id: string, asOf: string, kind: RoleForecast["capture_kind"]): RoleForecast => ({ ...base, forecast_id: id, as_of_at: asOf, capture_kind: kind });
    const fs = [mk("early", "2026-09-26T10:00:00Z", "LIVE_CAPTURED"), mk("late", "2026-09-27T15:00:00Z", "LIVE_CAPTURED"), mk("after", "2026-09-27T17:00:01Z", "LIVE_CAPTURED"), mk("at", KICK, "LIVE_CAPTURED")];
    assert.equal(selectForecast(fs, "a", null, 2026, 3, KICK)?.forecast_id, "late");
    assert.equal(selectForecast([fs[2]!, fs[3]!], "a", null, 2026, 3, KICK), null);
    assert.equal(selectForecast([mk("r", "2026-09-27T15:00:00Z", "AS_OF_RECONSTRUCTION"), mk("l", "2026-09-27T15:00:00Z", "LIVE_CAPTURED")], "a", null, 2026, 3, KICK)?.forecast_id, "l");
  });
});

describe("missingness stays missing; confidence falls with thin evidence", () => {
  test("no history -> value null (never zero), opportunity null, INSUFFICIENT_SAMPLE, no adjustment", () => {
    const rookie: ProfileRow = { ...prof("r", "WR", "AAA", {}, 0), metrics: { snap_share: metric(null, 0), target_share: metric(null, 0), route_participation: metric(null, 0) } };
    const f = fcast(rookie, [], weekHasReports());
    assert.equal(f.metrics.snap_share!.value, null); assert.equal(f.metrics.target_share!.value, null); assert.equal(f.opportunity.targets, null);
    assert.equal(f.confidence, "INSUFFICIENT_SAMPLE"); assert.equal(f.confidence_score, 0);
    assert.ok(f.reason_codes.includes("PRIMARY_ROLE_METRIC_UNAVAILABLE"));
    const s = shadowCandidate({ baseline: 7, xfp_forecast: 0, xfp_no_pressure: 0, p_absent: 0, confidence: f.confidence });
    assert.equal(s.role_adjustment, 0); assert.ok(s.reason_codes.includes("ROLE_CONFIDENCE_INSUFFICIENT_NO_ADJUSTMENT"));
  });
  test("route participation is never a fabricated 2026 observation: prior-season-only and capped at LOW", () => {
    const p = prof("a", "WR", "AAA", { target_share: 0.2, route_participation: 0.8 }, 3);
    p.metrics.route_participation = { ...metric(0.8, 0), conf: "MEDIUM" };
    const f = fcast(p, [], weekHasReports());
    assert.equal(f.metrics.route_participation!.prior_season_only, true); assert.equal(f.metrics.route_participation!.confidence, "LOW");
  });
  test("confidence and score rise with current-season evidence and fall with team/position discontinuity; HIGH is never issued", () => {
    const thin = fcast(prof("a", "WR", "AAA", { target_share: 0.2 }, 1), [], weekHasReports());
    const thick = fcast({ ...prof("a", "WR", "AAA", { target_share: 0.2 }, 4), metrics: { target_share: { ...metric(0.2, 4), conf: "MEDIUM" } } }, [], weekHasReports());
    const moved = fcast({ ...prof("a", "WR", "AAA", { target_share: 0.2 }, 4), metrics: { target_share: { ...metric(0.2, 4), conf: "MEDIUM", discontinuity: "TEAM_CHANGE" } } }, [], weekHasReports());
    assert.ok(thick.confidence_score > thin.confidence_score); assert.equal(thick.confidence, "MEDIUM"); assert.equal(thin.confidence, "LOW");
    assert.ok(moved.confidence_score < thick.confidence_score); assert.ok(moved.reason_codes.includes("TEAM_OR_POSITION_DISCONTINUITY"));
    assert.ok(!["HIGH"].includes(thick.confidence));
  });
  test("no official injury report yet -> UNKNOWN (not healthy) and no pressure is fabricated", () => {
    assert.equal(designationOf([], 2026, 4, "a"), "UNKNOWN");
    assert.equal(designationOf(weekHasReports(), 2026, 3, "a"), "NONE");
    assert.equal(designationOf(weekHasReports([inj("a", "Out")]), 2026, 3, "a"), "OUT");
    const wr1 = prof("wr1", "WR", "AAA", { target_share: 0.3, snap_share: 0.9 }), wr2 = prof("wr2", "WR", "AAA", { target_share: 0.15, snap_share: 0.8 });
    const f = fcast(wr2, [wr1], []);
    assert.equal(f.teammate_pressure, null); assert.equal(f.metrics.target_share!.value_with_pressure, f.metrics.target_share!.value);
  });
});

describe("position-aware metrics and expected-stat logic", () => {
  test("metric families per position (QB has no target/route; WR/TE have no rush; RB has both)", () => {
    assert.ok(!METRICS_BY_POSITION.QB.includes("target_share")); assert.ok(!METRICS_BY_POSITION.QB.includes("route_participation"));
    assert.ok(!METRICS_BY_POSITION.WR.includes("rush_share")); assert.ok(!METRICS_BY_POSITION.TE.includes("rush_share"));
    for (const m of ["rush_share", "target_share", "route_participation", "rz_carry_share", "rz_target_share"] as const) assert.ok(METRICS_BY_POSITION.RB.includes(m));
    for (const m of ["target_share", "route_participation", "air_yards_share", "rz_target_share"] as const) { assert.ok(METRICS_BY_POSITION.WR.includes(m)); assert.ok(METRICS_BY_POSITION.TE.includes(m)); }
  });
  test("forecast opportunity: RB carries+targets, WR/TE targets only (no carries), QB dropbacks/rushes", () => {
    const team = [obs({ week: 1, gsis_id: "t", team: "AAA", team_pass_att: 40, team_rush_att: 25, team_rz_pass_att: 6, team_rz_rush_att: 5 })];
    const rb = fcast(prof("rb", "RB", "AAA", { rush_share: 0.6, rz_carry_share: 0.5, target_share: 0.1, rz_target_share: 0.05, snap_share: 0.6 }), [], weekHasReports(), team);
    assert.equal(rb.opportunity.carries, 15); assert.equal(rb.opportunity.rz_carries, 2.5); assert.equal(rb.opportunity.targets, 4); assert.ok(Math.abs(rb.opportunity.rz_targets! - 0.3) < 1e-9);
    const wr = fcast(prof("wr", "WR", "AAA", { target_share: 0.25, rush_share: 0.4, rz_target_share: 0.3 }), [], weekHasReports(), team);
    assert.equal(wr.opportunity.carries, null); assert.equal(wr.opportunity.targets, 10);
    const qbObs = [...team, obs({ week: 1, gsis_id: "qb", position: "QB", team: "AAA", dropbacks: 36, designed_rushes: 3, qb_scrambles: 2 })];
    const qb = fcast(prof("qb", "QB", "AAA", { snap_share: 0.98, rush_share: 0.1 }), [], weekHasReports(), qbObs);
    assert.equal(qb.opportunity.dropbacks, 36); assert.equal(qb.opportunity.designed_rushes, 3); assert.equal(qb.opportunity.targets, null);
  });
  test("expected stat lines: RB rush+rec, WR receiving only, QB passing + rushing; red-zone opportunities carry TD-heavier yields", () => {
    const empty = { carries: null, rz_carries: null, targets: null, rz_targets: null, dropbacks: null, rz_dropbacks: null, designed_rushes: null, scrambles: null };
    const rb = expectedStatLine("RB", { ...empty, carries: 20, rz_carries: 4, targets: 5, rz_targets: 1 }, YIELDS);
    assert.ok(rb.rush_yd! > 60 && rb.rec! > 3); assert.equal(rb.rush_att, 20);
    const nonRz = expectedStatLine("RB", { ...empty, carries: 20, rz_carries: 0 }, YIELDS), rz = expectedStatLine("RB", { ...empty, carries: 20, rz_carries: 10 }, YIELDS);
    assert.ok(rz.rush_td! > nonRz.rush_td! * 5);
    assert.ok(!("rush_att" in expectedStatLine("WR", { ...empty, targets: 8, rz_targets: 1 }, YIELDS)));
    const qb = expectedStatLine("QB", { ...empty, dropbacks: 35, rz_dropbacks: 5, designed_rushes: 2, scrambles: 3 }, YIELDS);
    assert.ok(qb.pass_att! > 28 && qb.pass_yd! > 150 && qb.rush_att === 5 && qb.pass_sack! > 1);
  });
  test("same football opportunity, different league scoring -> different expected points (football forecast is scoring-neutral)", () => {
    const empty = { carries: null, rz_carries: null, targets: 8, rz_targets: 1, dropbacks: null, rz_dropbacks: null, designed_rushes: null, scrambles: null };
    const ppr = expectedPoints("TE", empty, YIELDS, PPR), std = expectedPoints("TE", empty, YIELDS, { ...PPR, rec: 0 }), tep = expectedPoints("TE", empty, YIELDS, { ...PPR, bonus_rec_te: 0.5 });
    assert.ok(ppr > std); assert.ok(tep > ppr);
  });
});

describe("teammate-availability propagation", () => {
  const wr1 = prof("wr1", "WR", "AAA", { target_share: 0.3, snap_share: 0.9, air_yards_share: 0.35 }), wr2 = prof("wr2", "WR", "AAA", { target_share: 0.15, snap_share: 0.8, air_yards_share: 0.15 }), te = prof("te1", "TE", "AAA", { target_share: 0.1, snap_share: 0.7 });
  test("an OUT teammate raises the beneficiaries' expected target share (weighted by their own role); a healthy teammate does not", () => {
    const withOut = fcast(wr2, [wr1, te], weekHasReports([inj("wr1", "Out")]));
    assert.ok(withOut.teammate_pressure); assert.equal(withOut.teammate_pressure!.support_level, "CALIBRATED");
    assert.ok(withOut.metrics.target_share!.value_with_pressure! > withOut.metrics.target_share!.value!);
    assert.ok(withOut.opportunity.targets! > withOut.opportunity_no_pressure.targets!);
    const teF = fcast(te, [wr1, wr2], weekHasReports([inj("wr1", "Out")]));
    assert.ok(teF.metrics.target_share!.value_with_pressure! > teF.metrics.target_share!.value!);
    assert.ok(withOut.metrics.target_share!.value_with_pressure! - withOut.metrics.target_share!.value! > teF.metrics.target_share!.value_with_pressure! - teF.metrics.target_share!.value!); // bigger existing role inherits more
    const healthy = fcast(wr2, [wr1, te], weekHasReports());
    assert.equal(healthy.teammate_pressure, null); assert.equal(healthy.metrics.target_share!.value_with_pressure, healthy.metrics.target_share!.value);
  });
  test("designation weights: OUT > DOUBTFUL > QUESTIONABLE; multi-absence is flagged experimental; the absent player and QBs get no pressure", () => {
    const d = (s: string) => fcast(wr2, [wr1, te], weekHasReports([inj("wr1", s)])).metrics.target_share!.value_with_pressure!;
    assert.ok(d("Out") > d("Doubtful")); assert.ok(d("Doubtful") > d("Questionable")); assert.ok(d("Questionable") > wr2.metrics.target_share!.recent!);
    assert.equal(P_ABSENT.QUESTIONABLE, 0.25);
    const multi = fcast(wr2, [wr1, te], weekHasReports([inj("wr1", "Out"), inj("te1", "Out")]));
    assert.equal(multi.teammate_pressure!.support_level, "EXPERIMENTAL_MULTI_ABSENCE");
    const selfOut = fcast(wr1, [wr2, te], weekHasReports([inj("wr1", "Out")]));
    assert.equal(selfOut.teammate_pressure, null); assert.equal(selfOut.availability.expected_absent, true);
    const qb = fcast(prof("qb", "QB", "AAA", { snap_share: 0.98, rush_share: 0.1 }), [wr1, wr2], weekHasReports([inj("wr1", "Out")]));
    assert.equal(qb.teammate_pressure, null);
  });
  test("redistribution never REDUCES a healthy teammate's forecast (renormalization artifacts suppressed) and stale zero-game roster entries are not beneficiaries", () => {
    const crowd = [1, 2, 3, 4, 5].map((i) => prof(`w${i}`, "WR", "AAA", { target_share: 0.25, snap_share: 0.7 }));
    const out = prof("wrOut", "WR", "AAA", { target_share: 0.2, snap_share: 0.9 });
    const stale = prof("stale", "WR", "AAA", { target_share: 0.4, snap_share: 0.9 }, 0);
    for (const self of crowd) { const f = fcast(self, [...crowd.filter((c) => c !== self), out, stale], weekHasReports([inj("wrOut", "Out")])); assert.ok(f.metrics.target_share!.value_with_pressure! >= f.metrics.target_share!.value! - 1e-12); }
  });
  test("a teammate with no prior role evidence vacates nothing (no fabricated redistribution)", () => {
    const ghost: ProfileRow = { ...prof("ghost", "WR", "AAA", {}, 0), metrics: { target_share: metric(null, 0) } };
    const f = fcast(wr2, [ghost, te], weekHasReports([inj("ghost", "Out")]));
    assert.equal(f.metrics.target_share!.value_with_pressure, f.metrics.target_share!.value);
  });
});

describe("identity interoperability (Sleeper-form / GSIS-form canonical ids)", () => {
  const f = fcast(prof("00-0039139", "RB", "AAA", { rush_share: 0.6, target_share: 0.1, rz_carry_share: 0.4, rz_target_share: 0.05 }), [], weekHasReports());
  const observed = [obs({ season: 2026, week: 3, gsis_id: "00-0039139", sleeper_id: "s-00-0039139", position: "RB", team: "AAA", carries: 20, targets: 4, red_zone_carries: 3, red_zone_targets: 1, rush_share: 0.7, target_share: 0.1, snap_share: 0.7, offensive_snaps: 45 })];
  const mkCase = (canonical: string, ids: Record<string, string>): CaseLike => ({ case_id: `cc:${"a".repeat(24)}`, evidence_digest: "d", season: 2026, week: 3, league_slug: "L1", scoring_fingerprint: "fp", provider: "sleeper", canonical_player_id: canonical, provider_player_ids: ids, player_name: "X", nfl_team: "AAA", position: "RB", projected_points: 12, actual_fantasy_points: 20, evidence_status: "CERTIFIED", participation_state: "PLAYED_NORMAL", projection_artifact_id: "a", projection_artifact_kind: "PROJECTION_SNAPSHOT", kickoff_at: KICK });
  const run = (c: CaseLike) => buildRoleAnalysis({ cases: [c], forecasts: [f], observed, yields: YIELDS, rawScoringByFingerprint: new Map([["fp", PPR]]), exclusions: [], postgameInjury: new Map() });
  test("the same player joins forecast + observed role whether the ledger case carries a gsis-form id, a sleeper-form id, or only provider ids", () => {
    const a = run(mkCase("player:gsis:00-0039139", {})), b = run(mkCase("player:sleeper:9226", { sleeper_id: "s-00-0039139" })), c = run(mkCase("player:sleeper:9226", { gsis_id: "00-0039139" }));
    for (const r of [a, b, c]) { assert.equal(r.length, 1); assert.equal(r[0]!.forecast_id, f.forecast_id); assert.equal(r[0]!.role.rush_share!.actual, 0.7); assert.equal(r[0]!.gsis_id, "00-0039139"); }
  });
  test("real committed forecasts have exactly one record per (season, week, gsis) — no duplicates from id form", async () => {
    const r = await buildWeekForecasts({ season: 2026, week: 3, captureKind: "AS_OF_RECONSTRUCTION", games: [], priorKickoffs: new Map() });
    assert.equal(r.forecasts.length, 0); // no games passed -> nothing (guard); real duplicate check on the profile inputs:
    const ps = loadRoleProfilesAsOf().filter((p) => p.target_week === 3);
    assert.equal(new Set(ps.map((p) => p.gsis_id)).size, ps.length);
  });
  test("provider-specific ids never become the forecast key: gsis_id is the football key, sleeper_id is provenance", () => {
    assert.equal(f.gsis_id, "00-0039139"); assert.match(f.sleeper_id ?? "", /^s-/);
    assert.deepEqual(fiIdsFromCanonical("player:gsis:00-1"), { gsis_id: "00-1", sleeper_id: null }); assert.deepEqual(fiIdsFromCanonical("player:sleeper:42"), { gsis_id: null, sleeper_id: "42" });
  });
});

describe("exact decomposition of the fantasy projection error (opportunity vs efficiency/TD)", () => {
  const f = fcast(prof("a", "RB", "AAA", { rush_share: 0.55, target_share: 0.1, rz_carry_share: 0.4, rz_target_share: 0.05, snap_share: 0.6 }), [], weekHasReports(), [obs({ week: 1, gsis_id: "t", team: "AAA", team_pass_att: 35, team_rush_att: 25, team_rz_pass_att: 5, team_rz_rush_att: 4 })]);
  const c = (act: number): CaseLike => ({ case_id: `cc:${"b".repeat(24)}`, evidence_digest: "d", season: 2026, week: 3, league_slug: "L1", scoring_fingerprint: "fp", provider: "sleeper", canonical_player_id: "player:gsis:a", provider_player_ids: {}, player_name: "A", nfl_team: "AAA", position: "RB", projected_points: 11, actual_fantasy_points: act, evidence_status: "CERTIFIED", participation_state: "PLAYED_NORMAL", projection_artifact_id: "p", projection_artifact_kind: "PROJECTION_SNAPSHOT", kickoff_at: KICK });
  const run = (act: number, actual: Partial<ObservedRow>) => buildRoleAnalysis({ cases: [c(act)], forecasts: [f], observed: [obs({ season: 2026, week: 3, gsis_id: "a", position: "RB", team: "AAA", carries: 14, targets: 4, red_zone_carries: 2, red_zone_targets: 0, rush_share: 0.5, target_share: 0.11, snap_share: 0.55, ...actual })], yields: YIELDS, rawScoringByFingerprint: new Map([["fp", PPR]]), exclusions: [], postgameInjury: new Map() })[0]!;
  test("total error == efficiency/TD residual + role error + baseline-vs-role gap, exactly", () => {
    for (const [act, extra] of [[24, {}], [3.4, {}], [11, { carries: 8, targets: 1 }]] as const) {
      const d = run(act, extra).decomposition!;
      assert.ok(Math.abs(d.total_error! - (d.efficiency_td_residual! + d.role_error_points! + d.baseline_vs_role_gap!)) < 2e-4);
    }
  });
  test("forecast role ~ actual role but a 2-TD game: the miss is EFFICIENCY/TD, not role", () => {
    const r = run(26, { carries: 13.75, targets: 3.5, red_zone_carries: 1.6, red_zone_targets: 0.25 }); // exactly the forecast volume, big scoring
    assert.ok(Math.abs(r.decomposition!.role_error_points!) < 2); assert.ok(r.decomposition!.efficiency_td_residual! > 8);
  });
  test("role collapse: far fewer carries/targets than forecast -> a NEGATIVE role error priced in points", () => {
    const r = run(5, { carries: 6, targets: 1, red_zone_carries: 0, rush_share: 0.2, snap_share: 0.3 });
    assert.ok(r.decomposition!.role_error_points! < -5);
    assert.ok(r.role.rush_share!.error! < -0.3);
  });
});

describe("SHADOW_ONLY role candidate", () => {
  test("baseline is never mutated; candidate = baseline + adjustment; deterministic; SHADOW_ONLY; pre-registered kappa", () => {
    const input = { baseline: 8, xfp_forecast: 14, xfp_no_pressure: 12, p_absent: 0, confidence: "LOW" as const };
    const a = shadowCandidate(input), b = shadowCandidate({ ...input });
    assert.deepEqual(a, b); assert.equal(a.mode, "SHADOW_ONLY"); assert.equal(a.baseline_projection, 8);
    assert.equal(ROLE_SHADOW_KAPPA, 0.3);
    assert.equal(a.role_adjustment, Math.round(0.3 * 0.6 * 6 * 1e4) / 1e4); assert.equal(a.candidate_projection, Math.round((8 + a.role_adjustment) * 1e4) / 1e4);
    assert.ok(a.reason_codes.includes("ROLE_FORECAST_ABOVE_BASELINE")); assert.ok(a.reason_codes.includes("LOW_CONFIDENCE_DAMPED")); assert.equal(a.contributions.teammate_pressure_points, 2);
  });
  test("cap (max(1, 25% of baseline)); expected-absent players are pulled toward zero; teammate-only candidate isolates the pressure term", () => {
    const capped = shadowCandidate({ baseline: 2, xfp_forecast: 30, xfp_no_pressure: 30, p_absent: 0, confidence: "MEDIUM" });
    assert.equal(capped.role_adjustment, 1); assert.ok(capped.reason_codes.includes("ADJUSTMENT_CAPPED"));
    const out = shadowCandidate({ baseline: 8, xfp_forecast: 12, xfp_no_pressure: 12, p_absent: 1, confidence: "MEDIUM" });
    assert.ok(out.role_adjustment < 0); assert.equal(out.teammate_only_adjustment, 0);
    const tm = shadowCandidate({ baseline: 8, xfp_forecast: 10, xfp_no_pressure: 8, p_absent: 0, confidence: "MEDIUM" });
    assert.ok(tm.teammate_only_adjustment > 0 && tm.teammate_only_adjustment <= 1.0001);
  });
  test("production isolation: nothing in production imports lib/role-calibration except the weekly audit and the calibration routes; it imports no production model/weight module", () => {
    const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (!["node_modules", ".next", "data"].includes(n)) walk(p, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(p); } return out; };
    const allowed = (f: string) => f.includes(join("lib", "role-calibration")) || f.includes(join("lib", "game-distribution")) || f.includes(join("lib", "game-weather")) || f.includes(join("app", "api", "game-distribution")) || f.includes(join("app", "api", "cron", "game-environment")) || f.includes(join("app", "api", "role-calibration")) || f.includes(join("app", "api", "cron", "role-calibration")) || f.endsWith(join("lib", "weekly-audit", "build.ts")) || f.endsWith(join("lib", "weekly-audit", "contract.ts"));
    const offenders = ["lib", "app"].flatMap((d) => walk(join(process.cwd(), d))).filter((f) => !allowed(f) && /@\/lib\/role-calibration\//.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
    for (const f of walk(join(process.cwd(), "lib", "role-calibration"))) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/from ["']@\/lib\/(projections|weekly\/(lineup|start-sit-fi|waivers|matchup)|matchup2|waiver2|orchestrator)/.test(src), f);
      assert.ok(!/insertIgnoreDuplicates\([^)]*["']bridge_(projection|startsit|matchup2|waiver2)/.test(src) && !/rest\.(update|updateReturning|insert)\(/.test(src), f);
    }
  });
});

describe("evaluation math (hand-verifiable)", () => {
  const row = (id: string, base: number, cand: number, act: number, over: Record<string, unknown> = {}) => ({ analysis_id: id, provider: "sleeper", scoring_fingerprint: "fp", season: 2026, week: 3, gsis_id: id, canonical_player_id: id, league_slug: "L", position: "RB", baseline_projection: base, actual_fantasy_points: act, shadow: { candidate_projection: cand, teammate_only_candidate: base }, eval_populations: { projection_eval: true, role_accuracy: true }, role: {}, decomposition: null, labels: {}, ...over }) as never;
  test("compare: N, MAE, RMSE, bias, improvement, help/hurt/neutral", () => {
    const rows = [row("a", 10, 12, 14), row("b", 10, 9, 5), row("c", 10, 10.02, 10)];
    const c = compare(rows);
    assert.equal(c.n, 3); assert.equal(c.baseline.mae, 3); assert.equal(c.candidate.mae, 2.0067); // |4|,|5|,|0| vs |2|,|4|,|0.02|... baseline (4+5+0)/3=3, candidate (2+4+0.02)/3
    assert.equal(c.baseline.bias, -0.3333); assert.equal(c.pct_helped, 0.6667); assert.equal(c.pct_hurt, 0); assert.equal(c.pct_neutral, 0.3333);
    assert.equal(c.mean_abs_error_improvement, Math.round((3 - 2.0067) * 1e4) / 1e4);
  });
  test("tail: only baseline misses >= threshold are counted; new tail misses created are tracked", () => {
    const rows = [row("a", 5, 9, 15), row("b", 5, 6, 16), row("c", 10, 4, 10.5), row("d", 10, 3, 9.9)];
    const t = tail(rows, 8);
    assert.equal(t.n_baseline_misses, 2); assert.equal(t.baseline_mae, 10.5); assert.equal(t.candidate_mae_on_same, 8); assert.equal(t.pct_reduced, 1); assert.equal(t.new_tail_misses_created, 0);
    assert.equal(tail(rows, 5).new_tail_misses_created, 2); // c and d: baseline was close, the candidate would have created a >=5 miss
    assert.equal(tail([row("z", 10, 2, 9)], 5).new_tail_misses_created, 1);
  });
  test("pearson and role accuracy vs naive predictors; football dedupe never double-counts the same scoring fingerprint or includes Yahoo", () => {
    assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1); assert.equal(pearson([1, 2, 3, 4], [4, 3, 2, 1]), -1); assert.equal(pearson([1, 2], [1, 2]), null);
    const mk = (id: string, f: number, a: number, last: number) => row(id, 1, 1, 1, { role: { target_share: { forecast: f, forecast_with_pressure: f, actual: a, error: a - f, naive_last_game: last, naive_season_mean: f, prior_season_only: false } } });
    const acc = roleAccuracy([mk("a", 0.2, 0.25, 0.4), mk("b", 0.3, 0.2, 0.5)]);
    assert.equal(acc[0]!.n, 2); assert.equal(acc[0]!.forecast_mae, 0.075); assert.equal(acc[0]!.naive_last_game_mae, 0.225); assert.equal(acc[0]!.forecast_beats_last_game, true);
    const dup = [row("p", 1, 1, 1, { league_slug: "Devoted" }), row("p", 1, 1, 1, { league_slug: "Sportys" }), row("p", 1, 1, 1, { league_slug: "Rogers", provider: "yahoo", scoring_fingerprint: "y" })];
    assert.equal(dedupeFootball(dup).length, 1);
  });
  test("roleVsFantasy: shares of squared error by component", () => {
    const d = (t: number, r: number, e: number, g: number) => row("x" + t, 1, 1, 1, { decomposition: { total_error: t, role_error_points: r, efficiency_td_residual: e, baseline_vs_role_gap: g } });
    const r = roleVsFantasy([d(6, 3, 2, 1), d(-6, -3, -2, -1), d(2, 1, 1, 0)]);
    assert.equal(r.n, 3); assert.ok(r.share_sq_error_role! > 0.5); assert.equal(r.corr_role_error_vs_total_error, 1);
  });
});

describe("FI role-family repair (usage families were always null: nothing injected fiValues)", () => {
  const fi = loadFootballIntelligence();
  test("RB/TE/WR usage families now resolve from the published FI usage profile for both id forms; wrong position and unknown players stay null", { skip: !fi }, () => {
    assert.ok(fi);
    const a = usageValueFor(fi!, "player:sleeper:9226", "RB", "fi_usage_snap_share_modeled"), b = usageValueFor(fi!, "player:gsis:00-0039139", "RB", "fi_usage_snap_share_modeled");
    assert.ok(a && a.value != null && a.value > 0 && a.value <= 1); assert.ok(b && b.value != null);
    assert.equal(usageValueFor(fi!, "player:sleeper:9226", "WR", "fi_usage_snap_share_modeled"), null); // id/position mismatch is never used
    assert.equal(usageValueFor(fi!, "player:sleeper:0000000", "RB", "fi_usage_snap_share_modeled"), null);
    assert.equal(usageValueFor(fi!, "player:sleeper:9226", "RB", "fi_off_pace_sec_play_league_percentile"), null); // only fi_usage_* value columns
    const adj = translateFiAdjustment({ canonical_player_id: "player:sleeper:9226", position: "RB", nfl_team: "MIA", opponent: "KC", baseline_projection: 12, request_season: 2026 });
    const u = adj.contributions.find((c) => c.family === "usage_snap_share")!;
    assert.ok(u.fi_value != null && u.fi_confidence != null); assert.notEqual(u.points_contribution, 0);
    const unknown = translateFiAdjustment({ canonical_player_id: "player:sleeper:0000000", position: "RB", nfl_team: "MIA", opponent: "KC", baseline_projection: 12, request_season: 2026 });
    assert.equal(unknown.contributions.find((c) => c.family === "usage_snap_share")!.fi_value, null); // missing stays missing
  });
  test("explicit fiValues still take precedence over the resolver (backward compatible)", { skip: !fi }, () => {
    const adj = translateFiAdjustment({ canonical_player_id: "player:sleeper:9226", position: "RB", nfl_team: "MIA", opponent: "KC", baseline_projection: 12, request_season: 2026, fiValues: { fi_usage_snap_share_modeled: { value: 0.11, confidence: "LOW" } } });
    assert.equal(adj.contributions.find((c) => c.family === "usage_snap_share")!.fi_value, 0.11);
  });
});

describe("injury labeling and evaluation populations (§16)", () => {
  const f = fcast(prof("a", "WR", "AAA", { target_share: 0.25, snap_share: 0.9 }), [], weekHasReports());
  const mkCase = (): CaseLike => ({ case_id: `cc:${"c".repeat(24)}`, evidence_digest: "d", season: 2026, week: 3, league_slug: "L1", scoring_fingerprint: "fp", provider: "sleeper", canonical_player_id: "player:gsis:a", provider_player_ids: { sleeper_id: "s-a" }, player_name: "A", nfl_team: "AAA", position: "WR", projected_points: 12, actual_fantasy_points: 3, evidence_status: "CERTIFIED", participation_state: "PLAYED_NORMAL", projection_artifact_id: "p", projection_artifact_kind: "PROJECTION_SNAPSHOT", kickoff_at: KICK });
  const run = (actual: Partial<ObservedRow> | null, post: [string, string][] = [], excl: { season: number; week: number; gsis_id: string; reason: string; note: string }[] = []) => buildRoleAnalysis({ cases: [mkCase()], forecasts: [f], observed: actual ? [obs({ season: 2026, week: 3, gsis_id: "a", sleeper_id: "s-a", ...actual })] : [], yields: YIELDS, rawScoringByFingerprint: new Map([["fp", PPR]]), exclusions: excl, postgameInjury: new Map(post) })[0]!;
  test("normal participation is in both populations; a healthy low-scoring game is NOT flagged as injury", () => {
    const r = run({ snap_share: 0.85, offensive_snaps: 55 });
    assert.equal(r.eval_populations.role_accuracy, true); assert.equal(r.labels.injury_contamination, null);
  });
  test("played + big snap drop + a post-game injury designation -> POSSIBLE_IN_GAME_INJURY, excluded from role accuracy and shadow evaluation", () => {
    const r = run({ snap_share: 0.3, offensive_snaps: 20 }, [["a", "Questionable"]]);
    assert.equal(r.labels.injury_contamination, "POSSIBLE_IN_GAME_INJURY"); assert.equal(r.eval_populations.role_accuracy, false); assert.equal(r.eval_populations.projection_eval, false);
    assert.equal(run({ snap_share: 0.3, offensive_snaps: 20 }).labels.injury_contamination, null); // the snap drop alone (no designation) is never labeled an injury
  });
  test("auditable manual exclusion list overrides and carries its reason code", () => {
    const r = run({ snap_share: 0.9, offensive_snaps: 58 }, [], [{ season: 2026, week: 3, gsis_id: "a", reason: "MANUAL_IN_GAME_INJURY", note: "test" }]);
    assert.equal(r.labels.injury_contamination, "MANUAL_IN_GAME_INJURY"); assert.ok(r.exclusion_reasons.includes("MANUAL_IN_GAME_INJURY")); assert.equal(r.eval_populations.role_accuracy, false);
  });
  test("DNP: no observed row -> availability, not a role miss (excluded from role accuracy); expected-absent is labeled", () => {
    const r = buildRoleAnalysis({ cases: [{ ...mkCase(), participation_state: "DID_NOT_PLAY" }], forecasts: [f], observed: [], yields: YIELDS, rawScoringByFingerprint: new Map([["fp", PPR]]), exclusions: [], postgameInjury: new Map() })[0]!; assert.equal(r.labels.participated, false); assert.equal(r.eval_populations.role_accuracy, false); assert.ok(r.exclusion_reasons.includes("NO_OBSERVED_ROLE_ROW"));
    const out = fcast(prof("a", "WR", "AAA", { target_share: 0.25, snap_share: 0.9 }), [], weekHasReports([inj("a", "Out")]));
    assert.equal(out.availability.expected_absent, true); assert.ok(out.reason_codes.includes("EXPECTED_ABSENT_OFFICIAL_OUT"));
  });
  test("real injury designations are loadable and Week 3 reports exist", () => { assert.ok(loadInjuryReports().some((r) => r.season === 2026 && r.week === 3)); });
});
export type { RolePosition };
