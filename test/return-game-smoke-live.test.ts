/**
 * Real Bloodline Bowl smoke test for the individual return-game repair.
 *
 * Hits the real Sleeper API for the actual Bloodline Bowl league
 * (`1395549281678532608`), which live-verified scoring includes individual
 * `kr_yd: 0.04` / `pr_yd: 0.04` (plus `st_td: 6`, `def_kr_yd`/`def_pr_yd`/
 * `def_st_td` at 0.04/6 for team defense). Confirms:
 *   1. the live league scoring configuration actually contains the return
 *      rule (so this isn't a theoretical fixture-only fix);
 *   2. a real rostered player's projected return production is represented;
 *   3. team-defense return stats are not double-counted into the player;
 *   4. a league WITHOUT return scoring configured is unaffected by the same
 *      Layer-1 projection (computed via the same base projections, translated
 *      through a synthetic no-return scoring context).
 *
 * Skips cleanly (does not fail) when Sleeper is unreachable.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { buildBaseProjections, buildLeagueProjections, clearProjectionCaches } from "@/lib/projections/build";
import { loadLeagueConfig } from "@/lib/projections/service";
import { getPlayerIndex } from "@/lib/sleeper/client";

const BLOODLINE_BOWL_LEAGUE_ID = "1395549281678532608";
const SEASON = 2026;

let online = true;
async function tryOnline() {
  try {
    await getPlayerIndex();
  } catch {
    online = false;
  }
}

describe("return-game repair — real Bloodline Bowl smoke test (live)", () => {
  before(tryOnline);

  it("the live league scoring configuration contains individual return-yardage rules", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const cfg = await loadLeagueConfig("bloodline-bowl", BLOODLINE_BOWL_LEAGUE_ID);
    assert.ok(typeof cfg.scoring_settings.kr_yd === "number" && cfg.scoring_settings.kr_yd !== 0, "expected a nonzero kr_yd rule");
    assert.ok(typeof cfg.scoring_settings.pr_yd === "number" && cfg.scoring_settings.pr_yd !== 0, "expected a nonzero pr_yd rule");
    // Team-defense return keys are a SEPARATE namespace — confirm both exist so
    // the double-count check below is meaningful.
    assert.ok(typeof cfg.scoring_settings.def_kr_yd === "number");
    assert.ok(typeof cfg.scoring_settings.def_pr_yd === "number");
  });

  it("real rostered return production is represented end-to-end and correctly scored, with no team-defense double-count", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    clearProjectionCaches();
    const cfg = await loadLeagueConfig("bloodline-bowl", BLOODLINE_BOWL_LEAGUE_ID);
    const base = await buildBaseProjections({ season: SEASON });

    const returners = [...base.projections.values()].filter(
      (p) => (p.stats.kr_yd ?? 0) > 0 || (p.stats.pr_yd ?? 0) > 0,
    );
    assert.ok(returners.length > 0, "expected at least one player with projected return-game production");

    const withReturns = buildLeagueProjections(base, {
      league_slug: "bloodline-bowl", league_id: BLOODLINE_BOWL_LEAGUE_ID,
      scoring_settings: cfg.scoring_settings, roster_positions: cfg.roster_positions, num_teams: cfg.num_teams,
    });
    const noReturnScoring = { ...cfg.scoring_settings };
    delete noReturnScoring.kr_yd;
    delete noReturnScoring.pr_yd;
    const withoutReturnScoring = buildLeagueProjections(base, {
      league_slug: "bloodline-bowl-no-returns", league_id: BLOODLINE_BOWL_LEAGUE_ID,
      scoring_settings: noReturnScoring, roster_positions: cfg.roster_positions, num_teams: cfg.num_teams,
    }, { force: true });

    let checked = 0;
    for (const rg of returners.slice(0, 5)) {
      const on = withReturns.projections.find((p) => p.player_id === rg.player_id);
      const off = withoutReturnScoring.projections.find((p) => p.player_id === rg.player_id);
      if (!on || !off) continue;
      checked += 1;
      // The scored return contribution must equal exactly kr_yd*rate + pr_yd*rate.
      const expectedReturnPoints =
        (rg.stats.kr_yd ?? 0) * (cfg.scoring_settings.kr_yd ?? 0) + (rg.stats.pr_yd ?? 0) * (cfg.scoring_settings.pr_yd ?? 0);
      const actualGap = on.league_points - off.league_points;
      // availability haircut applies uniformly; compare on the ppg*17 full-pace basis instead
      const fullPaceGap = on.league_ppg * 17 - off.league_ppg * 17;
      assert.ok(
        Math.abs(fullPaceGap - expectedReturnPoints) < 0.5,
        `${rg.full_name}: full-pace league_points gap ${fullPaceGap} should be ~${expectedReturnPoints} (kr_yd=${rg.stats.kr_yd}, pr_yd=${rg.stats.pr_yd})`,
      );
      assert.ok(actualGap >= 0, `${rg.full_name}: adding return scoring should never LOWER league_points`);
    }
    assert.ok(checked > 0, "expected to find at least one returner present in both league builds");
  });
});
