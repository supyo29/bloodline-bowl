/**
 * Weekly kickoff-return projection enrichment — regression coverage.
 *
 * Certification phase: close the weekly KR-projection gap (Sleeper's weekly
 * feed omits individual kr/kr_yd entirely — see the return-game repair
 * checkpoints) using the existing return-game architecture, without touching
 * `calculateFantasyPoints()` or weekly actuals.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  weeklyKrYdEnrichment,
  enrichWeeklyStatsWithReturnGame,
  RETURN_GAME_WEEKLY_MODEL_VERSION,
  type ReturnGameSeasonSignal,
} from "@/lib/weekly/return-game-weekly";
import { SleeperWeeklyProjectionProvider } from "@/lib/weekly/projections/sleeper-weekly";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";

const cw = () => new PlayerCrosswalk(NoCrosswalk);

/* -------------------------------------------------------------------- pure unit: weeklyKrYdEnrichment */

describe("weeklyKrYdEnrichment — role-continuity rule (pure, deterministic)", () => {
  it("a known KR-role player (season model + no in-season data yet) gets a nonzero weekly kr_yd", () => {
    const r = weeklyKrYdEnrichment(340, []); // season full-pace 340 kr_yd, week 1 (no recent games)
    assert.ok(r.kr_yd != null && r.kr_yd > 0);
    assert.equal(r.role_confidence, "MEDIUM");
  });

  it("confirmed usage in the most recent game upgrades confidence and does not damp", () => {
    const withRecentUsage = weeklyKrYdEnrichment(340, [4]); // 4 KR attempts last week
    const noData = weeklyKrYdEnrichment(340, []);
    assert.equal(withRecentUsage.role_confidence, "HIGH");
    assert.equal(withRecentUsage.kr_yd, noData.kr_yd, "same baseline rate when confirmed, just higher confidence");
  });

  it("a single recent zero-attempt game damps but does NOT suppress (spec: never one game)", () => {
    const r = weeklyKrYdEnrichment(340, [0]);
    assert.ok(r.kr_yd != null && r.kr_yd > 0, "must not be suppressed by a single zero-attempt game");
    const baseline = weeklyKrYdEnrichment(340, []).kr_yd!;
    assert.ok(r.kr_yd! < baseline, "should be damped relative to the undamped baseline");
    assert.equal(r.role_confidence, "LOW");
  });

  it("two consecutive recent zero-attempt games suppress the projection entirely (role lost)", () => {
    const r = weeklyKrYdEnrichment(340, [0, 0]);
    assert.equal(r.kr_yd, null);
    assert.equal(r.role_confidence, "LOW");
    assert.ok(r.notes.some((n) => n.includes("suppressed")));
  });

  it("a stale zero followed by a real return the following week is NOT suppressed (order matters: most-recent-first)", () => {
    // recent[0] is the MOST recent game -> attempts this week, recent[1] is a week further back with 0.
    const r = weeklyKrYdEnrichment(340, [3, 0]);
    assert.ok(r.kr_yd != null && r.kr_yd > 0);
    assert.equal(r.role_confidence, "HIGH");
  });

  it("no season-model role evidence at all -> null, never a fabricated zero-based estimate", () => {
    assert.equal(weeklyKrYdEnrichment(null, [4]).kr_yd, null);
    assert.equal(weeklyKrYdEnrichment(0, [4]).kr_yd, null);
  });

  it("is bounded — never an implausible weekly value regardless of season input", () => {
    const r = weeklyKrYdEnrichment(10_000, [9]); // absurd season input
    assert.ok(r.kr_yd! <= 32, `weekly kr_yd ${r.kr_yd} should be bounded`);
  });
});

/* -------------------------------------------------------------------- merge policy: provider-first */

describe("enrichWeeklyStatsWithReturnGame — merge policy (Phase 7)", () => {
  const season = new Map<string, ReturnGameSeasonSignal>([["kr_guy", { kr_yd: 340, pr_yd: null }]]);

  it("adds kr_yd only when the provider's raw entry has no kr_yd key at all", () => {
    const { stats, warnings } = enrichWeeklyStatsWithReturnGame({ rec: 3, rec_yd: 30 }, "kr_guy", season, undefined);
    assert.ok(stats.kr_yd != null && stats.kr_yd > 0);
    assert.ok(warnings.length === 1 && warnings[0]!.includes(RETURN_GAME_WEEKLY_MODEL_VERSION));
    // combined line: existing receiving stats untouched.
    assert.equal(stats.rec, 3);
    assert.equal(stats.rec_yd, 30);
  });

  it("does NOT override an explicit provider kr_yd, including an explicit 0 (missing vs zero)", () => {
    const explicitZero = enrichWeeklyStatsWithReturnGame({ kr_yd: 0 }, "kr_guy", season, undefined);
    assert.equal(explicitZero.stats.kr_yd, 0);
    assert.equal(explicitZero.warnings.length, 0);

    const explicitReal = enrichWeeklyStatsWithReturnGame({ kr_yd: 55 }, "kr_guy", season, undefined);
    assert.equal(explicitReal.stats.kr_yd, 55);
    assert.equal(explicitReal.warnings.length, 0);
  });

  it("never adds/alters pr_yd, even when the season model has a pr_yd signal", () => {
    const seasonWithPr = new Map<string, ReturnGameSeasonSignal>([["both", { kr_yd: 200, pr_yd: 150 }]]);
    const { stats } = enrichWeeklyStatsWithReturnGame({ pr_yd: 12, rec: 4 }, "both", seasonWithPr, undefined);
    assert.equal(stats.pr_yd, 12, "Sleeper's real pr_yd must survive completely unchanged — no stacking");
  });

  it("a player with no season return-game signal is untouched (no fabricated data)", () => {
    const { stats, warnings } = enrichWeeklyStatsWithReturnGame({ rec: 5 }, "nobody", season, undefined);
    assert.equal(stats.kr_yd, undefined);
    assert.equal(warnings.length, 0);
  });

  it("respects the recent-attempts role-loss gate end to end (2 zero-attempt games -> no enrichment)", () => {
    const recent = new Map<string, number[]>([["kr_guy", [0, 0]]]);
    const { stats } = enrichWeeklyStatsWithReturnGame({ rec: 3 }, "kr_guy", season, recent);
    assert.equal(stats.kr_yd, undefined);
  });
});

/* -------------------------------------------------------------------- end-to-end: SleeperWeeklyProjectionProvider */

describe("SleeperWeeklyProjectionProvider — weekly KR enrichment end-to-end", () => {
  const RAW = [
    // Pure return specialist: Sleeper's weekly feed gives him nothing but a
    // punt-return line (no receiving/rushing) — exactly the "only pts_*-like"
    // shape that would otherwise be `unavailable`.
    { player_id: "returner1", team: "SEA", opponent: "SF", week: 3, stats: { pr: 2, pr_yd: 18 }, player: { first_name: "Kick", last_name: "Returner", position: "WR", injury_status: null, team: "SEA" } },
    // A comparable non-returner with slightly higher receiving production.
    { player_id: "wr2", team: "SEA", opponent: "SF", week: 3, stats: { rec: 3, rec_yd: 25 }, player: { first_name: "Slot", last_name: "Guy", position: "WR", injury_status: null, team: "SEA" } },
  ];

  function mockFetch(t: { mock: { method: typeof mock.method } }) {
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => RAW }) as unknown as Response);
  }

  const RETURN_GAME_SEASON = new Map<string, ReturnGameSeasonSignal>([["returner1", { kr_yd: 340, pr_yd: null }]]);

  it("a KR-scoring league: the enriched weekly projection includes kr_yd contribution via the normal scorer, no hard-coded league logic", async (t) => {
    mockFetch(t);
    const provider = new SleeperWeeklyProjectionProvider();
    const KR_RATE = 0.04; // Bloodline Bowl's live rate
    const batch = await provider.getWeeklyProjections({
      league: { league_slug: "bloodline-bowl", season: 2026, raw_scoring: { rec: 1, rec_yd: 0.1, pr_yd: 0.04, kr_yd: KR_RATE }, scoring_rules: [] },
      week: 3, crosswalk: cw(), canonical_player_ids: [], want_rest_of_season: false,
      return_game_season: RETURN_GAME_SEASON,
    });
    const byName = (n: string) => [...batch.by_player.values()].find((p) => batch.resolved_players.get(p.canonical_player_id)?.full_name === n)!;
    const returner = byName("Kick Returner");
    assert.equal(returner.projection_status, "projected", "a pure returner must no longer be 'unavailable'");
    // 2 pr attempts * 18 yd already known; enriched kr_yd = round1(340/17) = 20.
    const expectedKrYd = Math.round((340 / 17) * 10) / 10;
    const expected = Math.round((18 * 0.04 + expectedKrYd * KR_RATE) * 100) / 100;
    assert.equal(returner.projected_points, expected);
    assert.ok(returner.warnings.some((w) => w.includes("weekly_kr_yd_enrichment")));
    mock.restoreAll();
  });

  it("a league WITHOUT kr_yd scoring gets no added value from the same enriched projection", async (t) => {
    mockFetch(t);
    const provider = new SleeperWeeklyProjectionProvider();
    const batchWith = await provider.getWeeklyProjections({
      league: { league_slug: "l-on", season: 2026, raw_scoring: { rec: 1, rec_yd: 0.1, pr_yd: 0.04, kr_yd: 0.04 }, scoring_rules: [] },
      week: 3, crosswalk: cw(), canonical_player_ids: [], want_rest_of_season: false,
      return_game_season: RETURN_GAME_SEASON,
    });
    mockFetch(t);
    const batchWithout = await provider.getWeeklyProjections({
      league: { league_slug: "l-off", season: 2026, raw_scoring: { rec: 1, rec_yd: 0.1, pr_yd: 0.04 }, scoring_rules: [] },
      week: 3, crosswalk: cw(), canonical_player_ids: [], want_rest_of_season: false,
      return_game_season: RETURN_GAME_SEASON,
    });
    const nameOf = (b: typeof batchWith) => (n: string) => [...b.by_player.values()].find((p) => b.resolved_players.get(p.canonical_player_id)?.full_name === n)!;
    const withKr = nameOf(batchWith)("Kick Returner").projected_points!;
    const withoutKr = nameOf(batchWithout)("Kick Returner").projected_points!;
    // pr_yd (0.04) is identical in both leagues; only kr_yd scoring differs.
    assert.ok(withKr > withoutKr, `with-KR-scoring points (${withKr}) should exceed without (${withoutKr})`);
    mock.restoreAll();
  });

  it("start/sit propagation: enrichment can flip which of two comparable players projects higher, only in a KR-scoring league", async (t) => {
    mockFetch(t);
    const provider = new SleeperWeeklyProjectionProvider();
    const scoringWithKr = { rec: 1, rec_yd: 0.1, pr_yd: 0.04, kr_yd: 0.04 };
    const batchOn = await provider.getWeeklyProjections({
      league: { league_slug: "on", season: 2026, raw_scoring: scoringWithKr, scoring_rules: [] },
      week: 3, crosswalk: cw(), canonical_player_ids: [], want_rest_of_season: false,
      return_game_season: RETURN_GAME_SEASON,
    });
    mockFetch(t);
    const scoringWithoutKr = { rec: 1, rec_yd: 0.1, pr_yd: 0.04 };
    const batchOff = await provider.getWeeklyProjections({
      league: { league_slug: "off", season: 2026, raw_scoring: scoringWithoutKr, scoring_rules: [] },
      week: 3, crosswalk: cw(), canonical_player_ids: [], want_rest_of_season: false,
      return_game_season: RETURN_GAME_SEASON,
    });
    // lib/weekly/start-sit.ts and lib/weekly/lineup.ts rank/select purely off
    // WeeklyProjection.projected_points (see start-sit.ts:36-37, lineup.ts:160)
    // — so a change here IS the propagation to start/sit.
    const nameOf = (b: typeof batchOn) => (n: string) => [...b.by_player.values()].find((p) => b.resolved_players.get(p.canonical_player_id)?.full_name === n)!;
    const returnerOn = nameOf(batchOn)("Kick Returner").projected_points!;
    const wr2On = nameOf(batchOn)("Slot Guy").projected_points!;
    const returnerOff = nameOf(batchOff)("Kick Returner").projected_points!;
    const wr2Off = nameOf(batchOff)("Slot Guy").projected_points!;
    assert.ok(returnerOn > returnerOff, "KR enrichment should raise the returner's points in a KR-scoring league");
    assert.equal(wr2On, wr2Off, "a non-returner's projection must be completely unaffected by KR enrichment existing");
    mock.restoreAll();
  });

  it("no return-TD double count: enrichment never adds any *_td key", async (t) => {
    mockFetch(t);
    const provider = new SleeperWeeklyProjectionProvider();
    const batch = await provider.getWeeklyProjections({
      league: { league_slug: "bloodline-bowl", season: 2026, raw_scoring: { rec: 1, rec_yd: 0.1, pr_yd: 0.04, kr_yd: 0.04, st_td: 6 }, scoring_rules: [] },
      week: 3, crosswalk: cw(), canonical_player_ids: [], want_rest_of_season: false,
      return_game_season: RETURN_GAME_SEASON,
    });
    const returner = [...batch.by_player.values()].find((p) => batch.resolved_players.get(p.canonical_player_id)?.full_name === "Kick Returner")!;
    // st_td=6 configured but no TD stat was ever added by enrichment (or present
    // in the raw feed here), so it contributes nothing — no hidden TD value.
    assert.ok(!returner.warnings.some((w) => /_td/.test(w)));
  });
});

/* -------------------------------------------------------------------- weekly actuals isolation */

describe("weekly actuals isolation (Phase 10 of the certification spec)", () => {
  it("lib/analytics/weekly-stats.ts (post-game actuals scoring) has no dependency on the weekly return-game enrichment module", () => {
    const src = readFileSync(join(process.cwd(), "lib", "analytics", "weekly-stats.ts"), "utf8");
    assert.ok(!src.includes("return-game-weekly"), "weekly ACTUALS scoring must stay independent of the projection-only enrichment module");
  });

  it("lib/stats/provider.ts (raw actual stat line source) has no dependency on the weekly return-game enrichment module", () => {
    const src = readFileSync(join(process.cwd(), "lib", "stats", "provider.ts"), "utf8");
    assert.ok(!src.includes("return-game-weekly"));
  });
});
