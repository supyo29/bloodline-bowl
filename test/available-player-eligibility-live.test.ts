/**
 * PHASE 1 — live Sleeper verification of the available-player pool.
 *
 * Hits the real Sleeper API and the production `buildDraftBundle` path for both
 * leagues. Skips cleanly (does not fail) when Sleeper is unreachable.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { buildDraftBundle } from "../lib/sleeper/draft-service";
import { buildManagerDraftContext } from "../lib/leagues/manager-draft";
import { resolveManagerInLeague } from "../lib/leagues/resolve";
import { resolveLeagueId } from "../lib/sleeper/service";
import { getPlayerIndex } from "../lib/sleeper/client";
import { isCurrentlyDraftable } from "../lib/sleeper/eligibility";

const SKILL = new Set(["QB", "RB", "WR", "TE", "K"]);
const DEVOTED_LEAGUE_ID = "1389735763649761280";

let online = true;
before(async () => {
  try {
    await getPlayerIndex();
  } catch {
    online = false;
  }
});

async function poolFor(leagueId: string) {
  return (await buildDraftBundle(leagueId, { availableLimit: 1000, position: null }))
    .response;
}

describe("live: /api/draft available-player pool integrity", () => {
  for (const [label, getId] of [
    ["Bloodline Bowl", () => resolveLeagueId()],
    ["Devoted to the Game", () => DEVOTED_LEAGUE_ID],
  ] as const) {
    it(`${label}: no teamless QB/RB/WR/TE/K in the available pool`, async (t) => {
      if (!online) return t.skip("Sleeper offline");
      const r = await poolFor(getId());
      const teamless = r.available_players.filter(
        (p) =>
          SKILL.has(p.position ?? "") &&
          !(typeof p.team === "string" && p.team.trim().length > 0),
      );
      assert.equal(
        teamless.length,
        0,
        `teamless skill players leaked: ${teamless.map((p) => p.full_name).join(", ")}`,
      );
    });

    it(`${label}: every available skill candidate has team != null`, async (t) => {
      if (!online) return t.skip("Sleeper offline");
      const r = await poolFor(getId());
      for (const p of r.available_players) {
        if (!SKILL.has(p.position ?? "")) continue;
        assert.ok(
          typeof p.team === "string" && p.team.trim().length > 0,
          `${p.full_name} (${p.position}) has no team`,
        );
      }
    });

    it(`${label}: valid team defenses survive`, async (t) => {
      if (!online) return t.skip("Sleeper offline");
      const r = await poolFor(getId());
      const defs = r.available_players.filter((p) => p.position === "DEF");
      // pre-draft: all 32; mid/post-draft: fewer, but some must remain valid.
      assert.ok(defs.length > 0, "no DEF entities in the pool");
      for (const d of defs) {
        assert.ok(typeof d.team === "string" && d.team.length > 0);
        assert.equal(isCurrentlyDraftable(d), true);
      }
    });

    it(`${label}: none of the drafted/rostered players appear as available`, async (t) => {
      if (!online) return t.skip("Sleeper offline");
      const r = await poolFor(getId());
      const drafted = new Set(
        r.picks.map((pick) => pick.player?.player_id).filter(Boolean) as string[],
      );
      for (const p of r.available_players) {
        assert.ok(!drafted.has(p.player_id), `${p.full_name} is drafted but available`);
      }
    });

    it(`${label}: integrity diagnostics are internally consistent`, async (t) => {
      if (!online) return t.skip("Sleeper offline");
      const r = await poolFor(getId());
      const d = r.metadata.available_players.integrity;
      assert.equal(
        d.eligible_player_count + d.excluded_player_count,
        d.player_pool_total,
      );
      assert.equal(d.eligible_player_count, r.metadata.available_players.total_matching);
      assert.equal(
        d.stale_or_invalid_player_count,
        d.excluded_by_reason.malformed +
          d.excluded_by_reason.inactive +
          d.excluded_by_reason.missing_team,
      );
      // The historical defect: there really are stale teamless records in
      // Sleeper's dump, and we really are catching them.
      assert.ok(d.excluded_by_reason.missing_team > 100);
    });
  }
});

describe("live: shared pool and manager candidates agree", () => {
  it("Devoted/DarthMarker recommendations contain only currently-draftable players", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const league = { league_slug: "devoted-to-the-game", league_id: DEVOTED_LEAGUE_ID, registered: true, display_name: "Devoted to the Game" };
    const resolved = await resolveManagerInLeague(league, "darthmarker");
    assert.ok(resolved.ok, "DarthMarker must resolve in Devoted");
    const ctx = await buildManagerDraftContext(resolved.manager, { availableLimit: 400, recommendationCount: 40 });

    for (const p of ctx.available_players) {
      assert.equal(isCurrentlyDraftable(p), true, `available: ${p.full_name}`);
    }
    for (const rec of ctx.manager.recommendations) {
      const full = ctx.available_players.find((p) => p.player_id === rec.player_id);
      // recommendation ids are drawn from the (already-filtered) available pool
      assert.ok(full, `recommendation ${rec.name} not in available pool`);
      assert.equal(isCurrentlyDraftable(full!), true);
    }
  });
});
