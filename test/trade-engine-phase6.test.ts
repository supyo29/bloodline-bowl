/**
 * Trade Engine — Phase 6: strategic context and season-state intelligence.
 *
 * Tests the strategy library directly against synthetic `TradeAnalysisContext`
 * fixtures (the established pattern for this repo's trade-engine tests).
 * Standings/season geometry are set by mutating the fixture's plain-object
 * `snapshot.teams[i].record` / `snapshot.standings` / `ctx.week` /
 * `ctx.snapshot.league.playoff_settings` directly — `test/fixtures/trades.ts`
 * itself is NOT modified (it is shared by every frozen prior phase's tests).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import { resolveTradeConfig } from "../lib/trades/config";
import { buildDiscoveryEvalContext, evaluateCandidate } from "../lib/trades/discovery/candidate-eval";
import { buildDiscoveryResult } from "../lib/trades/discovery/rank";
import type { TradeAnalysisContext } from "../lib/trades/context";
import { resolveRosWeekPlan } from "../lib/trades/context";
import type { CanonicalPosition, CanonicalStanding } from "../lib/canonical/schema";

import { buildLeagueSeasonContext } from "../lib/trades/strategy/season";
import { buildManagerStandings, classifyPlayoffStatus } from "../lib/trades/strategy/standings";
import { classifyArchetype } from "../lib/trades/strategy/archetype";
import { computeUrgency } from "../lib/trades/strategy/urgency";
import { buildManagerStrategicProfile } from "../lib/trades/strategy/profile";
import { assessStrategicTrade } from "../lib/trades/strategy/adjustment";
import { assessDiscoveryResult, rankResultsStrategically, recommendOfferTier, strategicDiscoveryRank } from "../lib/trades/strategy/assess";
import { selectOfferTiers, paretoFrontier } from "../lib/trades/negotiation/pareto";
import { TRADE_STRATEGY_VERSION, promotionCeiling, capStrategicAdjustment } from "../lib/trades/strategy/config";
import { TRADE_CALIBRATION_MIN_REAL_TRADES } from "../lib/trades/discovery/config";

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3, 4].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3, 4].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);
function buildLeague(teams: StdTeamSpec[]) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections),
    freeAgents: FA, faProjections: FA_PROJ, transfers: [], rosFlatHorizon: ROS_WEEKS,
  });
}
const MID = (slug: string) => `manager:test-league:${slug}`;
const config = resolveTradeConfig();

function bilateralLeague() {
  return buildLeague([
    { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_wr3", pos: "WR", pts: 15 }, { id: "A_wr4", pos: "WR", pts: 13 }], lockPts: { RB1: 8, RB2: 7 } },
    { slug: "B", flex: { id: "B_flex", pos: "RB", pts: 10 }, bench: [{ id: "B_rb3", pos: "RB", pts: 15 }], lockPts: { WR1: 8, WR2: 7 } },
  ]);
}

/** Mutates the fixture's plain-object standings/records/week/playoff geometry in place. Test-only. */
function withSeasonState(
  ctx: TradeAnalysisContext,
  opts: {
    week?: number;
    playoffTeamCount?: number | null;
    playoffStartWeek?: number | null;
    championshipWeek?: number | null;
    records: Record<string, { wins: number; losses: number; ties?: number; points_for: number; points_against?: number }>;
  },
): TradeAnalysisContext {
  if (opts.week != null) ctx.week = opts.week;
  const rawPlayoffStartWeek = opts.playoffStartWeek === undefined ? 15 : opts.playoffStartWeek;
  const rawChampionshipWeek = opts.championshipWeek === undefined ? 17 : opts.championshipWeek;
  ctx.snapshot.league.playoff_settings = {
    playoff_team_count: opts.playoffTeamCount === undefined ? 6 : opts.playoffTeamCount,
    playoff_start_week: rawPlayoffStartWeek,
    championship_week: rawChampionshipWeek,
  };
  // `buildLeagueSeasonContext` reads `ctx.ros` directly (audit fix §3) — the
  // SAME field the real `buildTradeAnalysisContext` populates from these
  // same playoff settings, falling back to a real default championship week
  // (17, matching production's `DEFAULT_CHAMPIONSHIP_WEEK`) when unresolved
  // — `championship_week` is NEVER actually null in real production output,
  // only `playoff_start_week` can genuinely stay unresolved. Recomputed here
  // so `ros` and `playoff_settings` stay consistent, exactly as they would
  // in production — never mutate one without the other.
  const effectiveChampionshipWeek = rawChampionshipWeek ?? 17;
  const plan = resolveRosWeekPlan(ctx.week, effectiveChampionshipWeek, rawPlayoffStartWeek);
  ctx.ros = {
    ...ctx.ros,
    weeks: plan.weeks,
    regular_season_weeks: plan.regular_season_weeks,
    playoff_weeks: plan.playoff_weeks,
    playoff_window_available: plan.playoff_window_available,
    playoff_start_week: plan.playoff_start_week,
    championship_week: plan.championship_week,
  };
  for (const team of ctx.snapshot.teams) {
    const slug = team.provider_team_id!;
    const rec = opts.records[slug];
    if (rec) team.record = { wins: rec.wins, losses: rec.losses, ties: rec.ties ?? 0, points_for: rec.points_for, points_against: rec.points_against ?? 0 };
  }
  const rows: CanonicalStanding[] = ctx.snapshot.teams
    .map((team) => {
      const gp = team.record.wins + team.record.losses + team.record.ties;
      return {
        canonical_team_id: team.canonical_team_id, rank: null as number | null, wins: team.record.wins, losses: team.record.losses, ties: team.record.ties,
        win_percentage: gp > 0 ? Math.round(((team.record.wins + team.record.ties * 0.5) / gp) * 1000) / 1000 : null,
        points_for: team.record.points_for, points_against: team.record.points_against, games_played: gp, playoff_seed: null,
      };
    })
    .sort((a, b) => b.wins - a.wins || b.points_for - a.points_for);
  rows.forEach((r, i) => { r.rank = i + 1; });
  ctx.snapshot.standings = rows;
  return ctx;
}

/* ===================================================================== */
/* 6A — Season state                                                      */
/* ===================================================================== */

describe("Phase 6A — season-state context", () => {
  it("early season: far from the playoff cutover", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), { week: 3, records: { A: { wins: 2, losses: 1, points_for: 300 }, B: { wins: 1, losses: 2, points_for: 280 } } });
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.season_stage, "EARLY_SEASON");
    assert.equal(season.playoff_start_week, 15);
    assert.equal(season.weeks_remaining_regular, 12);
  });

  it("midseason: past the elapsed-fraction threshold, still well before the playoff push window", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), { week: 8, records: { A: { wins: 4, losses: 3, points_for: 700 }, B: { wins: 3, losses: 4, points_for: 650 } } });
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.season_stage, "MIDSEASON");
  });

  it("playoff push: within the configured window of the playoff cutover", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), { week: 13, records: { A: { wins: 7, losses: 5, points_for: 1200 }, B: { wins: 6, losses: 6, points_for: 1150 } } });
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.season_stage, "PLAYOFF_PUSH");
  });

  it("fantasy playoffs: at or after the playoff start week", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), { week: 15, records: { A: { wins: 9, losses: 5, points_for: 1500 }, B: { wins: 7, losses: 7, points_for: 1400 } } });
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.season_stage, "FANTASY_PLAYOFFS");
  });

  it("season complete: past the championship week", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), { week: 18, records: { A: { wins: 10, losses: 7, points_for: 1800 }, B: { wins: 8, losses: 9, points_for: 1600 } } });
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.season_stage, "SEASON_COMPLETE");
  });

  it("missing playoff start week: no fabricated playoff geometry — matches Phase 2's own unresolved-playoff-window handling exactly", () => {
    // Real production behavior (see `buildTradeAnalysisContext`): an
    // unresolved `championship_week` gets a real default (17) so the
    // rest-of-season window is never simply empty, but an unresolved
    // `playoff_start_week` genuinely stays null — this is Phase 2's own
    // `PLAYOFF_WINDOW_UNAVAILABLE` case, and Phase 6 must report the exact
    // same unresolved state (audit fix §3 — no second interpretation).
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), { week: 10, playoffStartWeek: null, records: { A: { wins: 5, losses: 4, points_for: 900 }, B: { wins: 4, losses: 5, points_for: 850 } } });
    assert.equal(ctx.ros.playoff_window_available, false, "test setup sanity check — Phase 2's own plan must also be unresolved");
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.playoff_start_week, null);
    assert.equal(season.championship_week, ctx.ros.championship_week, "Phase 6 must report the SAME championship week Phase 2 already resolved — never null when Phase 2 has a real value");
    assert.equal(season.weeks_remaining_total, ctx.ros.weeks.length, "must match Phase 2's own remaining-week count exactly");
  });

  /**
   * Audit regression (§3, P1): directly proves Phase 6's season context
   * never diverges from Phase 2's own already-computed `ctx.ros` plan, for
   * every combination of resolved/unresolved playoff geometry — the
   * headline "second incompatible interpretation" defect this audit found
   * and fixed (season.ts previously re-called `resolveRosWeekPlan` with a
   * different null-fallback policy than Phase 2's own).
   */
  it("Phase 6's season context never diverges from Phase 2's own ctx.ros plan (resolved and unresolved cases)", () => {
    for (const playoffStartWeek of [15, null]) {
      const f = bilateralLeague();
      const ctx = withSeasonState(f.context({ rosWeeks: 6 }), { week: 10, playoffStartWeek, records: { A: { wins: 5, losses: 4, points_for: 900 }, B: { wins: 4, losses: 5, points_for: 850 } } });
      const season = buildLeagueSeasonContext(ctx);
      assert.equal(season.playoff_start_week, ctx.ros.playoff_start_week);
      assert.equal(season.championship_week, ctx.ros.championship_week);
      assert.equal(season.weeks_remaining_total, ctx.ros.weeks.length);
      assert.equal(season.weeks_remaining_regular, ctx.ros.regular_season_weeks.length);
    }
  });

  it("never invents a trade deadline", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), { week: 5, records: { A: { wins: 3, losses: 2, points_for: 500 }, B: { wins: 2, losses: 3, points_for: 480 } } });
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.trade_deadline_week, null);
    assert.equal(season.trade_deadline_status, "UNKNOWN");
  });
});

/* ===================================================================== */
/* 6B — Standings and playoff context                                    */
/* ===================================================================== */

describe("Phase 6B — standings and playoff status", () => {
  function threeTeamLeague() {
    return buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 } },
      { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } },
      { slug: "C", flex: { id: "C_flex", pos: "WR", pts: 10 } },
    ]);
  }

  it("top seed with a comfortable cushion and few weeks left classifies CLINCHED", () => {
    const f = threeTeamLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 15, playoffTeamCount: 2,
      records: { A: { wins: 12, losses: 1, points_for: 2000 }, B: { wins: 6, losses: 7, points_for: 1500 }, C: { wins: 3, losses: 10, points_for: 1200 } },
    });
    const standings = buildManagerStandings(ctx, MID("A"));
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.equal(playoff.status, "CLINCHED");
  });

  /**
   * Audit regression (§9, P1 — freeze-critical): the original CLINCHED gate
   * (`clearance >= 2.5` AND `weeksRemaining <= 3`, as two independent
   * conditions) was NOT mathematically safe. With a clearance of exactly 3
   * games and 3 weeks remaining, the trailing team can close 1 game per
   * week (symmetric with the already-correct ELIMINATED check) and finish
   * TIED — never confidently ahead. `isClinchSafe` now requires
   * `clearance > weeksRemaining` (strictly), so this exact boundary case
   * must NOT classify CLINCHED.
   */
  it("a lead that could mathematically still be caught within the remaining weeks is NOT labeled CLINCHED", () => {
    const f = threeTeamLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 12, playoffTeamCount: 2, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 8, losses: 4, points_for: 1400 }, B: { wins: 7, losses: 5, points_for: 1300 }, C: { wins: 5, losses: 7, points_for: 1100 } },
    });
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.weeks_remaining_regular, 3, "test setup sanity check");
    const standings = buildManagerStandings(ctx, MID("A"));
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.notEqual(playoff.status, "CLINCHED", "a clearance of exactly 3 games with 3 weeks left is not mathematically safe — the trailing team can still tie or pass");
  });

  it("a lead that mathematically CANNOT be caught within the remaining weeks IS labeled CLINCHED", () => {
    const f = threeTeamLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 12, playoffTeamCount: 2, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 9, losses: 3, points_for: 1400 }, B: { wins: 6, losses: 6, points_for: 1300 }, C: { wins: 5, losses: 7, points_for: 1100 } },
    });
    const season = buildLeagueSeasonContext(ctx);
    assert.equal(season.weeks_remaining_regular, 3, "test setup sanity check");
    const standings = buildManagerStandings(ctx, MID("A"));
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.equal(playoff.status, "CLINCHED", "a clearance of 4 games with only 3 weeks left cannot be closed even if the chasing team wins out and the leader loses out");
  });

  it("bubble: a team just outside the cutline by a small margin", () => {
    const f = threeTeamLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 10, playoffTeamCount: 2,
      records: { A: { wins: 6, losses: 3, points_for: 1000 }, B: { wins: 5, losses: 4, points_for: 950 }, C: { wins: 4, losses: 5, points_for: 900 } },
    });
    const standings = buildManagerStandings(ctx, MID("C"));
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.equal(playoff.status, "BUBBLE");
  });

  it("long shot: well back of the cutline but still mathematically alive", () => {
    const f = threeTeamLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 6, playoffTeamCount: 2,
      records: { A: { wins: 5, losses: 1, points_for: 900 }, B: { wins: 4, losses: 2, points_for: 850 }, C: { wins: 1, losses: 5, points_for: 700 } },
    });
    const standings = buildManagerStandings(ctx, MID("C"));
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.equal(playoff.status, "LONG_SHOT");
  });

  it("eliminated: mathematically cannot close the gap even winning out", () => {
    const f = threeTeamLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 16, playoffTeamCount: 2, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 12, losses: 3, points_for: 1900 }, B: { wins: 10, losses: 5, points_for: 1800 }, C: { wins: 2, losses: 13, points_for: 1200 } },
    });
    const standings = buildManagerStandings(ctx, MID("C"));
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.equal(playoff.status, "ELIMINATED");
  });

  it("tied records break by points_for, matching the provider's own rank convention", () => {
    const f = threeTeamLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 8, playoffTeamCount: 2,
      records: { A: { wins: 5, losses: 3, points_for: 900 }, B: { wins: 5, losses: 3, points_for: 950 }, C: { wins: 3, losses: 5, points_for: 800 } },
    });
    const standingsA = buildManagerStandings(ctx, MID("A"));
    const standingsB = buildManagerStandings(ctx, MID("B"));
    assert.ok(standingsB.rank! < standingsA.rank!, "higher points_for wins the tiebreak, per the provider's own standings convention");
  });

  it("never fabricates a playoff-odds percentage — null with a categorical band or diagnostic instead", () => {
    const f = threeTeamLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 8, playoffTeamCount: 2,
      records: { A: { wins: 5, losses: 3, points_for: 900 }, B: { wins: 5, losses: 3, points_for: 850 }, C: { wins: 3, losses: 5, points_for: 800 } },
    });
    const standings = buildManagerStandings(ctx, MID("A"));
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.equal(playoff.playoff_odds, null);
    assert.ok(playoff.diagnostics.includes("PLAYOFF_ODDS_UNAVAILABLE"));
    assert.ok(playoff.playoff_odds_band === null || ["VERY_HIGH", "HIGH", "MEDIUM", "LOW", "VERY_LOW"].includes(playoff.playoff_odds_band));
  });

  it("missing standings reports STANDINGS_UNAVAILABLE, not a fabricated status", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: 6 });
    ctx.snapshot.standings = []; // simulate a provider that returned no standings
    const standings = buildManagerStandings(ctx, MID("A"));
    assert.equal(standings.standings_available, false);
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.equal(playoff.status, "UNKNOWN");
    assert.ok(playoff.diagnostics.includes("STANDINGS_UNAVAILABLE"));
  });

  it("week 1, every team 0-0: playoff status is UNKNOWN, never a confident-sounding guess from a single (zero-game) tiebreak", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 1, playoffTeamCount: 1,
      records: { A: { wins: 0, losses: 0, points_for: 0 }, B: { wins: 0, losses: 0, points_for: 0 } },
    });
    const standings = buildManagerStandings(ctx, MID("A"));
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    assert.equal(playoff.status, "UNKNOWN");
    assert.ok(playoff.diagnostics.includes("INSUFFICIENT_GAMES_PLAYED"));
  });
});

/* ===================================================================== */
/* 6C — Strategic archetype                                               */
/* ===================================================================== */

describe("Phase 6C — strategic archetypes", () => {
  it("does not use dynasty/rebuilder language for a redraft league — eliminated stays ELIMINATED", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 } },
      { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } },
    ]);
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 16, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 12, losses: 2, points_for: 1900 }, B: { wins: 1, losses: 13, points_for: 1000 } },
    });
    const standings = buildManagerStandings(ctx, MID("B"));
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    const { archetype } = classifyArchetype(season, standings, playoff);
    assert.equal(archetype, "ELIMINATED");
  });

  it("no single weak metric determines classification — insufficient evidence classifies UNKNOWN, not a guess", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: 6 });
    ctx.snapshot.standings = [];
    const standings = buildManagerStandings(ctx, MID("A"));
    const season = buildLeagueSeasonContext(ctx);
    const playoff = classifyPlayoffStatus(ctx, standings, season);
    const { archetype } = classifyArchetype(season, standings, playoff);
    assert.equal(archetype, "UNKNOWN");
  });
});

/* ===================================================================== */
/* 6D — Urgency                                                           */
/* ===================================================================== */

describe("Phase 6D — urgency model", () => {
  it("is bounded [0, 1] and a clinched team has lower urgency than a bubble team", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 } },
      { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } },
      { slug: "C", flex: { id: "C_flex", pos: "WR", pts: 10 } },
    ]);
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 14, playoffTeamCount: 2, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 12, losses: 1, points_for: 2000 }, B: { wins: 6, losses: 7, points_for: 1300 }, C: { wins: 5, losses: 8, points_for: 1250 } },
    });
    const seasonCtx = buildLeagueSeasonContext(ctx);
    const clinchedStandings = buildManagerStandings(ctx, MID("A"));
    const clinchedPlayoff = classifyPlayoffStatus(ctx, clinchedStandings, seasonCtx);
    const bubbleStandings = buildManagerStandings(ctx, MID("B"));
    const bubblePlayoff = classifyPlayoffStatus(ctx, bubbleStandings, seasonCtx);
    const clinchedUrgency = computeUrgency(seasonCtx, clinchedPlayoff, clinchedStandings.wins, clinchedStandings.losses, clinchedStandings.ties);
    const bubbleUrgency = computeUrgency(seasonCtx, bubblePlayoff, bubbleStandings.wins, bubbleStandings.losses, bubbleStandings.ties);
    assert.ok(clinchedUrgency.score >= 0 && clinchedUrgency.score <= 1);
    assert.ok(bubbleUrgency.score >= 0 && bubbleUrgency.score <= 1);
    assert.ok(bubbleUrgency.score > clinchedUrgency.score, `bubble urgency ${bubbleUrgency.score} should exceed clinched urgency ${clinchedUrgency.score}`);
  });
});

/* ===================================================================== */
/* 6F — Strategic adjustment / rationality floor                          */
/* ===================================================================== */

function evalOne(ctx: TradeAnalysisContext, evalCtx: ReturnType<typeof buildDiscoveryEvalContext>, transfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }>, managerIds: [string, string], mySlug: string) {
  const evaluated = evaluateCandidate(managerIds, transfers, ctx, evalCtx, config);
  if (!evaluated.ok || !evaluated.evaluation) throw new Error("expected a valid evaluation for this test fixture");
  const participant = Object.values(evaluated.evaluation.participants).find((p) => p.manager_slug === mySlug)!;
  return { evaluated, participant };
}

describe("Phase 6F — strategic adjustment and rationality floor", () => {
  it("Desperation trap: a deeply negative base trade for a 2-7 team is never promoted past its own band", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 10, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 2, losses: 7, points_for: 700 }, B: { wins: 7, losses: 2, points_for: 1100 } },
    });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    // A gives away its best two WRs for the RB it already has covered — a bad trade for A.
    const { participant } = evalOne(ctx, evalCtx, [
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr4" },
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
    ], [MID("A"), MID("B")], "A");
    const profile = buildManagerStrategicProfile(ctx, MID("A"), "A");
    const assessment = assessStrategicTrade(profile, participant);
    if (assessment.base_acceptance === "HARD_REJECT") {
      assert.equal(assessment.strategic_acceptance, "HARD_REJECT", "desperation must never promote a HARD_REJECT trade");
    }
    // Regardless of band, strategic_trade_score must never flip a clearly
    // negative base trade into a positive strategic score via urgency alone.
    if (assessment.base_utility_delta < -2) {
      assert.ok(assessment.strategic_trade_score < 0, "a deeply negative base trade must not be turned positive by strategic desperation");
    }
  });

  it("promotionCeiling never promotes HARD_REJECT and promotes every other band by at most one step", () => {
    assert.equal(promotionCeiling("HARD_REJECT"), "HARD_REJECT");
    assert.equal(promotionCeiling("REJECT"), "RELUCTANT");
    assert.equal(promotionCeiling("RELUCTANT"), "NEUTRAL");
    assert.equal(promotionCeiling("NEUTRAL"), "ACCEPT");
    assert.equal(promotionCeiling("ACCEPT"), "ACCEPT");
    assert.equal(promotionCeiling("STRONG_ACCEPT"), "STRONG_ACCEPT");
  });

  it("capStrategicAdjustment bounds the adjustment relative to the trade's own base value", () => {
    const { capped, wasCapped } = capStrategicAdjustment(100, 2);
    assert.ok(wasCapped);
    assert.ok(Math.abs(capped) < 100);
    const unaffected = capStrategicAdjustment(0.1, 10);
    assert.equal(unaffected.wasCapped, false);
  });

  it("capStrategicAdjustment: zero and near-zero base utility stay bounded by the fixed floor, never divide-by-zero", () => {
    const atZero = capStrategicAdjustment(5, 0);
    assert.ok(Number.isFinite(atZero.capped));
    assert.equal(atZero.capped, 0.75, "zero base utility falls back to the fixed floor cap (0.75), not zero or Infinity");
    const nearZero = capStrategicAdjustment(5, 0.0001);
    assert.ok(Number.isFinite(nearZero.capped));
    assert.ok(Math.abs(nearZero.capped) <= 0.75 + 1e-9);
  });

  /**
   * Audit hardening (§24, P2): `Math.max(-CAP, Math.min(CAP, x))` does not
   * catch `NaN` (any comparison with `NaN` is `false`), so a corrupt or
   * missing upstream signal could previously poison `strategic_adjustment`
   * and `strategic_trade_score` with a silent `NaN`. Both the per-component
   * clamp and the aggregate cap now treat non-finite input as zero evidence.
   */
  it("capStrategicAdjustment never propagates NaN/Infinity from a corrupt input", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const result = capStrategicAdjustment(bad, 5);
      assert.ok(Number.isFinite(result.capped), `capStrategicAdjustment(${bad}, 5) must not propagate a non-finite value`);
    }
    for (const bad of [NaN, Infinity, -Infinity]) {
      const result = capStrategicAdjustment(1, bad);
      assert.ok(Number.isFinite(result.capped), `capStrategicAdjustment(1, ${bad}) must not propagate a non-finite value`);
    }
  });

  it("Clinched optimization: a clinched front-runner may see a bounded positive strategic adjustment from playoff-window value", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 14, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 12, losses: 1, points_for: 2000 }, B: { wins: 4, losses: 9, points_for: 1000 } },
    });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { participant } = evalOne(ctx, evalCtx, [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
    ], [MID("A"), MID("B")], "A");
    const profile = buildManagerStrategicProfile(ctx, MID("A"), "A");
    assert.equal(profile.archetype, "FRONT_RUNNER");
    const assessment = assessStrategicTrade(profile, participant);
    // Whatever the sign, the adjustment must stay within the documented cap.
    const cap = Math.max(0.75, Math.abs(assessment.base_utility_delta) * 0.5);
    assert.ok(Math.abs(assessment.strategic_adjustment) <= cap + 1e-9);
  });

  it("Same trade, different manager state: identical structural trade can receive different strategic recommendations", () => {
    const contenderLeague = bilateralLeague();
    const ctxContender = withSeasonState(contenderLeague.context({ rosWeeks: 6 }), {
      week: 10, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 8, losses: 1, points_for: 1400 }, B: { wins: 1, losses: 8, points_for: 900 } },
    });
    const longShotLeague = bilateralLeague();
    const ctxLongShot = withSeasonState(longShotLeague.context({ rosWeeks: 6 }), {
      week: 10, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 2, losses: 7, points_for: 900 }, B: { wins: 7, losses: 2, points_for: 1400 } },
    });
    const evalCtxContender = buildDiscoveryEvalContext(ctxContender);
    const evalCtxLongShot = buildDiscoveryEvalContext(ctxLongShot);
    const transfers = [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
    ];
    const { participant: pContender } = evalOne(ctxContender, evalCtxContender, transfers, [MID("A"), MID("B")], "A");
    const { participant: pLongShot } = evalOne(ctxLongShot, evalCtxLongShot, transfers, [MID("A"), MID("B")], "A");
    const profileContender = buildManagerStrategicProfile(ctxContender, MID("A"), "A");
    const profileLongShot = buildManagerStrategicProfile(ctxLongShot, MID("A"), "A");
    assert.notEqual(profileContender.archetype, profileLongShot.archetype);
    const aContender = assessStrategicTrade(profileContender, pContender);
    const aLongShot = assessStrategicTrade(profileLongShot, pLongShot);
    // Same base utility (identical structural trade), but the strategic layer
    // is free to differ — that is the entire point of Phase 6.
    assert.equal(aContender.base_utility_delta, aLongShot.base_utility_delta);
  });

  it("strategic adjustment is fully decomposable — every component is a named, individually-inspectable number", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 10, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 4, losses: 5, points_for: 900 }, B: { wins: 5, losses: 4, points_for: 950 } },
    });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { participant } = evalOne(ctx, evalCtx, [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
    ], [MID("A"), MID("B")], "A");
    const profile = buildManagerStrategicProfile(ctx, MID("A"), "A");
    const assessment = assessStrategicTrade(profile, participant);
    const sumOfComponents = Object.values(assessment.components).reduce((a, b) => a + b, 0);
    // strategic_adjustment == sum of components, UNLESS the cap fired (then <=).
    if (!assessment.strategic_adjustment_capped) {
      assert.equal(Math.round(assessment.strategic_adjustment * 100) / 100, Math.round(sumOfComponents * 100) / 100);
    }
    for (const key of ["immediate_need_adjustment", "short_horizon_adjustment", "playoff_window_adjustment", "depth_resilience_adjustment", "ceiling_preference_adjustment", "floor_preference_adjustment", "bye_urgency_adjustment"]) {
      assert.ok(typeof (assessment.components as unknown as Record<string, number>)[key] === "number");
    }
    assert.equal(assessment.components.ceiling_preference_adjustment, 0, "no non-Phase-3 volatility evidence exists — ceiling preference must stay structurally zero");
    assert.equal(assessment.components.floor_preference_adjustment, 0);
  });
});

/* ===================================================================== */
/* 6G — Discovery integration                                             */
/* ===================================================================== */

describe("Phase 6G — discovery integration", () => {
  /**
   * Audit items §39/§40: base trade quality must remain PRIMARY. A near-tie
   * in base value may be reordered by strategic fit if the cap allows, but a
   * large base-value gap can never be overcome — proven directly against
   * `strategicDiscoveryRank`'s formula and cap, not just asserted informally.
   */
  it("strategicDiscoveryRank: strategy may break a near-tie, but can never overcome a large base-value gap", () => {
    const mk = (my_gain: number, minimum_partner_gain = 1, complexity = 1) => ({
      rank: 0, shape: "ONE_FOR_ONE" as const, my_gain,
      transfers: [{ from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p1" }],
      participants: [], minimum_partner_gain, trade_viability: "HIGH" as const, rationale: [],
      phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE" as const, warnings: [] },
      search_metadata: { mode: "BEST_AVAILABLE" as const, complexity, partner_fit: null },
      full_evaluation: { trade_summary: {} as never, phase2_summary: null, phase3_summary: null, participants: {} },
    });
    const mkStrategic = (adjustment: number) => ({
      base_utility_delta: 0, base_acceptance: "ACCEPT" as const,
      components: { immediate_need_adjustment: adjustment, short_horizon_adjustment: 0, playoff_window_adjustment: 0, depth_resilience_adjustment: 0, ceiling_preference_adjustment: 0, floor_preference_adjustment: 0, bye_urgency_adjustment: 0 },
      strategic_adjustment: adjustment, strategic_adjustment_capped: false, strategic_trade_score: adjustment,
      strategic_acceptance: "ACCEPT" as const, strategic_recommendation: "CONSIDER" as const, reasons: [],
    });

    // Near-tie: Trade A base +6 (weak strategic fit), Trade B base +5.7 (strong strategic fit).
    // Strategy MAY prefer B if the gap (0.3) is within B's own cap.
    const tradeA = { result: mk(6), strategic: mkStrategic(0) };
    const tradeB = { result: mk(5.7), strategic: mkStrategic(0.5) }; // 0.5 <= cap(5.7) = max(0.75, 2.85) = 2.85, legal
    assert.ok(strategicDiscoveryRank(tradeB.result, tradeB.strategic) > strategicDiscoveryRank(tradeA.result, tradeA.strategic), "a strong strategic fit MAY overcome a small (0.3) base-value gap");

    // Large gap: Trade A base +6, Trade C base -5 (even with C's maximum legal
    // strategic adjustment for its own base value, it cannot come close to +6).
    const tradeC = { result: mk(-5), strategic: mkStrategic(2.5) }; // cap(-5) = max(0.75, 2.5) = 2.5, the legal maximum
    assert.ok(strategicDiscoveryRank(tradeA.result, tradeA.strategic) > strategicDiscoveryRank(tradeC.result, tradeC.strategic), "strategy must NEVER let a deeply negative base trade outrank a strongly positive one");
  });

  /**
   * Audit item §51: strategic discovery integration is NOT restricted to
   * bilateral results — `assessDiscoveryResult` reads only the requested
   * manager's own `full_evaluation.participants[managerSlug]` entry, which
   * exists identically for a 3-participant `THREE_TEAM_CYCLE` result. Each
   * of the three managers gets their OWN independently-computed strategic
   * assessment from the SAME shared result — never a single global score
   * (negotiation's offer-ladder integration, by contrast, IS bilateral-only,
   * consistent with Phase 5's own audited three-team rejection).
   */
  it("three-team discovery results: each participant gets an independent strategic assessment, not one global score", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_wr3", pos: "WR", pts: 16 }], lockPts: { RB1: 8, RB2: 7 } },
      { slug: "B", flex: { id: "B_flex", pos: "TE", pts: 8, eligible: ["TE"] }, bench: [{ id: "B_te2", pos: "TE", pts: 13 }], lockPts: { WR1: 8, WR2: 7, TE: 6 } },
      { slug: "C", flex: { id: "C_flex", pos: "RB", pts: 10 }, bench: [{ id: "C_rb3", pos: "RB", pts: 16 }], lockPts: { TE: 6 } },
    ]);
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 10, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 2, losses: 7, points_for: 700 }, B: { wins: 8, losses: 1, points_for: 1100 }, C: { wins: 5, losses: 4, points_for: 900 } },
    });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    // Constructed directly (bypassing `runThreeTeamSearch`, which does not
    // reliably surface a cycle for every roster shape) via the SAME
    // `evaluateCandidate`/`buildDiscoveryResult` pipeline every discovery
    // mode uses — a real, canonically-evaluated 3-leg cycle: A -> B -> C -> A.
    const transfers = [
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
      { from_manager_id: MID("B"), to_manager_id: MID("C"), canonical_player_id: "B_te2" },
      { from_manager_id: MID("C"), to_manager_id: MID("A"), canonical_player_id: "C_rb3" },
    ];
    const evaluated = evaluateCandidate([MID("A"), MID("B"), MID("C")], transfers, ctx, evalCtx, config);
    assert.ok(evaluated.ok && evaluated.evaluation, "this 3-leg cycle must evaluate successfully for the test to be meaningful");
    const result = buildDiscoveryResult("A", { shape: "THREE_TEAM_CYCLE", transfers, participant_manager_ids: [MID("A"), MID("B"), MID("C")] }, evaluated, "THREE_TEAM", null, undefined, undefined);
    assert.ok(result, "buildDiscoveryResult must accept a real 3-participant candidate");
    assert.equal(result!.participants.length, 3);
    const profileA = buildManagerStrategicProfile(ctx, MID("A"), "A");
    const profileB = buildManagerStrategicProfile(ctx, MID("B"), "B");
    const profileC = buildManagerStrategicProfile(ctx, MID("C"), "C");
    assert.notEqual(profileA.archetype, profileB.archetype, "test setup sanity check — A and B must have different season states");
    const assessmentA = assessDiscoveryResult(result!, profileA, "A");
    const assessmentB = assessDiscoveryResult(result!, profileB, "B");
    const assessmentC = assessDiscoveryResult(result!, profileC, "C");
    assert.ok(assessmentA && assessmentB && assessmentC, "every one of the 3 participants must resolve independently from the SAME shared result");
    // Each participant's assessment must reflect THEIR OWN base utility, not a shared/global number.
    const baseUtilities = [assessmentA!.base_utility_delta, assessmentB!.base_utility_delta, assessmentC!.base_utility_delta];
    assert.equal(new Set(baseUtilities).size, baseUtilities.length, "each participant's base_utility_delta must be independently their own, not collapsed into one global score");
  });

  it("strategic ranking never changes the underlying base results array", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 10, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 2, losses: 7, points_for: 700 }, B: { wins: 7, losses: 2, points_for: 1100 } },
    });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const transfers = [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
    ];
    const evaluated = evaluateCandidate([MID("A"), MID("B")], transfers, ctx, evalCtx, config);
    if (!evaluated.ok || !evaluated.evaluation) throw new Error("expected valid evaluation");
    const result = buildDiscoveryResult("A", { shape: "ONE_FOR_ONE", transfers, participant_manager_ids: [MID("A"), MID("B")] }, evaluated, "BEST_AVAILABLE", null, undefined, undefined)!;
    const before = JSON.stringify(result);
    const profile = buildManagerStrategicProfile(ctx, MID("A"), "A");
    const ranked = rankResultsStrategically([result], profile, "A");
    assert.equal(JSON.stringify(result), before, "base result object must never be mutated by strategic ranking");
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.result, result);
  });

  it("assessDiscoveryResult returns null (never fabricated) when the manager slug is not a participant", () => {
    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 10, records: { A: { wins: 4, losses: 5, points_for: 900 }, B: { wins: 5, losses: 4, points_for: 950 } },
    });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const transfers = [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
    ];
    const evaluated = evaluateCandidate([MID("A"), MID("B")], transfers, ctx, evalCtx, config);
    if (!evaluated.ok || !evaluated.evaluation) throw new Error("expected valid evaluation");
    const result = buildDiscoveryResult("A", { shape: "ONE_FOR_ONE", transfers, participant_manager_ids: [MID("A"), MID("B")] }, evaluated, "BEST_AVAILABLE", null, undefined, undefined)!;
    const profile = buildManagerStrategicProfile(ctx, MID("A"), "A");
    const strategic = assessDiscoveryResult(result, profile, "nonexistent-manager");
    assert.equal(strategic, null);
  });
});

/* ===================================================================== */
/* 6H — Negotiation integration                                          */
/* ===================================================================== */

describe("Phase 6H — negotiation integration", () => {
  it("recommendOfferTier only ever returns a tier that is present on the ladder — never fabricates or exceeds it", () => {
    const good = { rank: 0, shape: "ONE_FOR_ONE" as const, my_gain: 5, transfers: [{ from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p1" }], search_metadata: { mode: "BEST_AVAILABLE" as const, complexity: 1, partner_fit: null }, participants: [{ manager_id: "A", manager_slug: "A", utility_delta: 5, acceptance: "ACCEPT" as const }, { manager_id: "B", manager_slug: "B", utility_delta: 0.5, acceptance: "ACCEPT" as const }], minimum_partner_gain: 0.5, trade_viability: "HIGH" as const, rationale: [], phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE" as const, warnings: [] }, full_evaluation: { trade_summary: {} as never, phase2_summary: null, phase3_summary: null, participants: {} } };
    const balanced = { ...good, my_gain: 2, participants: [{ manager_id: "A", manager_slug: "A", utility_delta: 2, acceptance: "ACCEPT" as const }, { manager_id: "B", manager_slug: "B", utility_delta: 2, acceptance: "ACCEPT" as const }] };
    const frontier = paretoFrontier([good, balanced], "A");
    const ladder = selectOfferTiers(frontier, "A");

    const f = bilateralLeague();
    const ctx = withSeasonState(f.context({ rosWeeks: 6 }), {
      week: 10, playoffTeamCount: 1, playoffStartWeek: 15, championshipWeek: 17,
      records: { A: { wins: 2, losses: 7, points_for: 700 }, B: { wins: 7, losses: 2, points_for: 1100 } },
    });
    const profile = buildManagerStrategicProfile(ctx, MID("A"), "A");
    const guidance = recommendOfferTier(ladder, profile);
    assert.ok(guidance.recommended_tier == null || Object.keys(ladder).includes(guidance.recommended_tier));
    assert.equal(guidance.exceeded_maximum_rational, false);
  });

  it("recommendOfferTier on an empty ladder never fabricates a recommendation", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: 6 });
    const profile = buildManagerStrategicProfile(ctx, MID("A"), "A");
    const guidance = recommendOfferTier({}, profile);
    assert.equal(guidance.recommended_tier, null);
  });

  /**
   * Audit item §44: a ladder collapsed to a single tier (the common case per
   * D7's structural finding — see the Phase 5 audit) must never have Phase 6
   * fabricate a different tier just because urgency prefers one that isn't
   * actually there. Tested at every urgency level.
   */
  it("recommendOfferTier: a single-tier ladder (OPENING only) always recommends that one real tier, at every urgency level", () => {
    const only = { rank: 0, shape: "ONE_FOR_ONE" as const, my_gain: 3, transfers: [{ from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p1" }], search_metadata: { mode: "BEST_AVAILABLE" as const, complexity: 1, partner_fit: null }, participants: [], minimum_partner_gain: 1, trade_viability: "HIGH" as const, rationale: [], phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE" as const, warnings: [] }, full_evaluation: { trade_summary: {} as never, phase2_summary: null, phase3_summary: null, participants: {} } };
    const ladder = { OPENING: only };

    // Low urgency (front-runner-like)
    const fLow = threeTeamLeague();
    const ctxLow = withSeasonState(fLow.context({ rosWeeks: 6 }), { week: 15, playoffTeamCount: 2, records: { A: { wins: 12, losses: 1, points_for: 2000 }, B: { wins: 6, losses: 7, points_for: 1500 }, C: { wins: 3, losses: 10, points_for: 1200 } } });
    const profileLow = buildManagerStrategicProfile(ctxLow, MID("A"), "A");
    assert.equal(recommendOfferTier(ladder, profileLow).recommended_tier, "OPENING");

    // High urgency (bubble/must-win-like)
    const fHigh = threeTeamLeague();
    const ctxHigh = withSeasonState(fHigh.context({ rosWeeks: 6 }), { week: 10, playoffTeamCount: 2, records: { A: { wins: 4, losses: 5, points_for: 900 }, B: { wins: 5, losses: 4, points_for: 950 }, C: { wins: 3, losses: 6, points_for: 800 } } });
    const profileHigh = buildManagerStrategicProfile(ctxHigh, MID("A"), "A");
    assert.equal(recommendOfferTier(ladder, profileHigh).recommended_tier, "OPENING");
  });

  function threeTeamLeague() {
    return buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 } },
      { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } },
      { slug: "C", flex: { id: "C_flex", pos: "WR", pts: 10 } },
    ]);
  }
});

/* ===================================================================== */
/* Versioning / calibration deferral (unchanged from Phase 4/5)           */
/* ===================================================================== */

describe("Phase 6 — versioning and calibration deferral", () => {
  it("TRADE_STRATEGY_VERSION is the expected initial version", () => {
    assert.equal(TRADE_STRATEGY_VERSION, "ri-trade-strategy-2026.2");
  });

  it("TRADE_CALIBRATION_MIN_REAL_TRADES is still 50 — Phase 6 does not touch calibration deferral", () => {
    assert.equal(TRADE_CALIBRATION_MIN_REAL_TRADES, 50);
  });
});
