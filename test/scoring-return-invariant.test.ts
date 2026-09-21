/** Phase 6 production certification — exhaustive return-yard invariant: ONE return-yard event -> ONE scoring treatment, in every provider/enrichment/league combination. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { SleeperWeeklyProjectionProvider } from "@/lib/weekly/projections/sleeper-weekly";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import type { ReturnGameSeasonSignal } from "@/lib/weekly/return-game-weekly";

const PROVIDERS: Record<string, Record<string, number>> = { none: {}, def_kr_yd_only: { def_kr_yd: 80 }, kr_yd_only: { kr_yd: 60 }, both_fields: { def_kr_yd: 80, kr_yd: 60 } };
const LEAGUES: Record<string, Record<string, number>> = { no_return_rules: {}, kr_only: { kr_yd: 0.04 }, def_kr_only: { def_kr_yd: 0.04 }, both_rules: { kr_yd: 0.04, def_kr_yd: 0.04 } };
const ENRICH_YD = 20; /* weeklyKrYdEnrichment(340, []) == round1(340/17) */
const expectedYards = (p: string, enrichment: boolean): number => (p === "kr_yd_only" || p === "both_fields" ? 60 : p === "def_kr_yd_only" ? 80 : enrichment ? ENRICH_YD : 0);

for (const [pn, prov] of Object.entries(PROVIDERS)) for (const enrichment of [false, true]) for (const [ln, league] of Object.entries(LEAGUES)) {
  test(`return invariant: provider=${pn} enrichment=${enrichment ? "present" : "absent"} league=${ln}`, async (t) => {
    const rows = [{ player_id: "r1", team: "DAL", opponent: "NYG", week: 3, stats: { rec_yd: 10, ...prov }, player: { first_name: "Kick", last_name: "Returner", position: "WR", team: "DAL" } }];
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => rows }) as unknown as Response);
    const season = enrichment ? new Map<string, ReturnGameSeasonSignal>([["r1", { kr_yd: 340, pr_yd: null }]]) : undefined;
    const b = await new SleeperWeeklyProjectionProvider().getWeeklyProjections({ league: { league_slug: "l", season: 2026, raw_scoring: { rec_yd: 0.1, ...league }, scoring_rules: [] }, week: 3, crosswalk: new PlayerCrosswalk(NoCrosswalk), canonical_player_ids: [], want_rest_of_season: false, ...(season ? { return_game_season: season } : {}) });
    mock.restoreAll(); const p = [...b.by_player.values()][0]!;
    const krRate = league.kr_yd ?? 0; const expected = Math.round((1 + krRate * expectedYards(pn, enrichment)) * 100) / 100;
    assert.equal(p.projected_points, expected, "return yards are priced exactly once, at the individual (kr_yd) rate only; the team-defense def_kr_yd rule never prices an individual");
  });
}

import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import { deriveCompletedGameThresholdEvents } from "@/lib/scoring/derived-events";
import { scoreWeeklyLine } from "@/lib/weekly/scoring";
test("nonlinear boundaries: completed games earn the threshold (inclusive), projections never do — 299/300/301 passing, 99/100/101 receiving", () => {
  const pass = { pass_yd: 0.04, bonus_pass_yd_300: 3 }, rec = { rec_yd: 0.1, bonus_rec_yd_100: 3 };
  for (const [y, bonus] of [[299, 0], [300, 3], [301, 3]] as const) {
    const done = calculateFantasyPoints(deriveCompletedGameThresholdEvents({ pass_yd: y }), pass).fantasy_points; assert.equal(done, Math.round((y * 0.04 + bonus) * 100) / 100, `completed ${y}`);
    assert.equal(scoreWeeklyLine({ pass_yd: y }, pass).points, Math.round(y * 0.04 * 100) / 100, `projected ${y} carries no bonus`);
  }
  for (const [y, bonus] of [[99, 0], [100, 3], [101, 3]] as const) {
    assert.equal(calculateFantasyPoints(deriveCompletedGameThresholdEvents({ rec_yd: y }), rec).fantasy_points, Math.round((y * 0.1 + bonus) * 100) / 100); assert.equal(scoreWeeklyLine({ rec_yd: y }, rec).points, Math.round(y * 0.1 * 100) / 100);
  }
});
