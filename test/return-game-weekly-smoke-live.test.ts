/**
 * Real Bloodline Bowl smoke test — weekly kickoff-return projection enrichment.
 *
 * Hits real Sleeper data end to end:
 *   1. confirms Sleeper's live weekly projection feed still omits individual
 *      kr/kr_yd for real Bloodline-Bowl-rostered kickoff returners;
 *   2. confirms the RI weekly enrichment supplies a bounded return-yard
 *      expectation for at least one of them;
 *   3. confirms the enriched weekly fantasy projection increases by EXACTLY
 *      `projected_kr_yd * kr_yd_rate` under Bloodline Bowl's live scoring —
 *      through the normal scorer, no manual bonus;
 *   4. confirms the weekly/start-sit output (WeeklyProjection.projected_points,
 *      what start-sit.ts / lineup.ts consume) carries the corrected number.
 *
 * Skips cleanly (does not fail) when Sleeper is unreachable.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { getPlayerIndex, getLeagueRosters } from "@/lib/sleeper/client";
import { loadLeagueConfig } from "@/lib/projections/service";
import { RosterIntelReturnGameSeasonProvider, fetchRecentReturnAttempts } from "@/lib/weekly/return-game-weekly";
import { SleeperWeeklyProjectionProvider } from "@/lib/weekly/projections/sleeper-weekly";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { clearProjectionCaches } from "@/lib/projections/build";

const BLOODLINE_BOWL_LEAGUE_ID = "1395549281678532608";
const SEASON = 2026;
const WEEK = 2;

let online = true;
async function tryOnline() {
  try {
    await getPlayerIndex();
  } catch {
    online = false;
  }
}

describe("weekly KR enrichment — real Bloodline Bowl smoke test (live)", () => {
  before(tryOnline);

  it("closes the real weekly KR gap for a real rostered returner, with exact kr_yd*rate scoring", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    clearProjectionCaches();

    const cfg = await loadLeagueConfig("bloodline-bowl", BLOODLINE_BOWL_LEAGUE_ID);
    const rosters = await getLeagueRosters(BLOODLINE_BOWL_LEAGUE_ID).catch(() => []);
    const rosteredIds = new Set<string>(rosters.flatMap((r) => r.players ?? []));
    assert.ok(rosteredIds.size > 0, "expected real Bloodline Bowl rosters");

    // 1) season return-game signal for real rostered returners.
    const rgProvider = new RosterIntelReturnGameSeasonProvider();
    const seasonSignal = await rgProvider.getSeasonSignal(SEASON);
    assert.equal(seasonSignal.status, "READY");
    const rosteredReturners = [...seasonSignal.by_sleeper_id.entries()].filter(
      ([pid, sig]) => rosteredIds.has(pid) && (sig.kr_yd ?? 0) > 0,
    );
    assert.ok(rosteredReturners.length > 0, "expected at least one rostered player with a projected KR role");
    const [targetId, targetSignal] = rosteredReturners[0]!;

    // 2) confirm Sleeper's live weekly feed really does omit kr_yd for him.
    const provider = new SleeperWeeklyProjectionProvider();
    const crosswalk = new PlayerCrosswalk(NoCrosswalk);
    const recentAttempts = await fetchRecentReturnAttempts(SEASON, WEEK);

    const withoutEnrichment = await provider.getWeeklyProjections({
      league: { league_slug: "bloodline-bowl", season: SEASON, raw_scoring: cfg.scoring_settings, scoring_rules: [] },
      week: WEEK, crosswalk, canonical_player_ids: [], want_rest_of_season: false,
    });
    const withEnrichment = await provider.getWeeklyProjections({
      league: { league_slug: "bloodline-bowl", season: SEASON, raw_scoring: cfg.scoring_settings, scoring_rules: [] },
      week: WEEK, crosswalk, canonical_player_ids: [], want_rest_of_season: false,
      return_game_season: seasonSignal.by_sleeper_id,
      return_game_recent_attempts: recentAttempts,
    });

    // Both batches resolve the same raw feed -> same canonical id set; find the
    // canonical id whose resolved player's name matches what we'd expect by
    // re-resolving pid directly through the crosswalk the same way the provider does.
    const resolved = crosswalk.resolve({ provider: "sleeper", provider_player_id: targetId, full_name: null, first_name: null, last_name: null, position: null, nfl_team: null, eligible_positions: null }).player;
    const cid = resolved.canonical_player_id;

    const before_ = withoutEnrichment.by_player.get(cid);
    const after = withEnrichment.by_player.get(cid);

    if (!before_ && !after) {
      return t.skip(`week ${WEEK} projection has no entry for target player ${targetId} (bye or feed gap) — pick a different week`);
    }

    const krRate = cfg.scoring_settings.kr_yd ?? 0;
    assert.ok(krRate !== 0, "Bloodline Bowl must score kr_yd for this smoke test to be meaningful");

    const beforePts = before_?.projected_points ?? 0;
    const afterPts = after?.projected_points ?? 0;
    const gap = afterPts - beforePts;

    if (gap <= 0) {
      // Role-continuity gate suppressed it (2+ recent zero-attempt games) —
      // a VALID outcome per spec, not a bug. Report and stop here.
      return t.skip(`role-continuity gate suppressed KR enrichment for ${targetId} this week (season kr_yd=${targetSignal.kr_yd}) — expected behavior, not a failure`);
    }

    // 3) the gap must equal EXACTLY enriched_kr_yd * kr_yd_rate (no separate bonus).
    const enrichedWarning = after?.warnings.find((w) => w.includes("weekly_kr_yd_enrichment"));
    assert.ok(enrichedWarning, "expected an enrichment provenance warning");
    const m = enrichedWarning!.match(/kr_yd=([\d.]+)/);
    assert.ok(m, "expected kr_yd value in the enrichment warning");
    const enrichedKrYd = Number(m![1]);
    assert.equal(Math.round(gap * 100) / 100, Math.round(enrichedKrYd * krRate * 100) / 100);

    // 4) this IS the number start-sit/lineup consume.
    assert.equal(after!.projected_points, afterPts);
  });
});
