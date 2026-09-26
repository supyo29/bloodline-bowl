import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { clearProjectionFeedCache } from "@/lib/sleeper/client";
import { SleeperWeeklyProjectionProvider } from "@/lib/weekly/projections/sleeper-weekly";

function rowsFor(positions: string[], weekly: boolean) {
  return positions.map((position) => {
    const id = `${position.toLowerCase()}-seg`;
    const stats: Record<string, number> =
      position === "QB"
        ? { gp: 17, pass_att: 500, pass_cmp: 330, pass_yd: 3900, pass_td: 25, rush_yd: 200, rush_td: 2 }
        : position === "RB"
          ? { gp: 17, rush_att: 220, rush_yd: 950, rush_td: 7, rec: 35, rec_yd: 250, rec_td: 2 }
          : position === "WR"
            ? { gp: 17, rec: 75, rec_yd: 1050, rec_td: 7 }
            : position === "TE"
              ? { gp: 17, rec: 55, rec_yd: 650, rec_td: 5 }
              : { gp: 17, pts_std: position === "K" ? 125 : 115 };

    return {
      player_id: id,
      team: "KC",
      opponent: weekly ? "LV" : null,
      season: "2026",
      season_type: "regular",
      week: weekly ? 3 : null,
      category: "proj",
      company: "rotowire",
      last_modified: 1_790_000_000_000,
      updated_at: 1_790_000_000_000,
      stats,
      player: {
        first_name: position,
        last_name: "Segment",
        position,
        team: "KC",
        years_exp: 3,
        injury_status: null,
        fantasy_positions: [position],
        metadata: null,
      },
    };
  });
}

function segmentPositions(url: URL): string[] {
  return url.searchParams.getAll("position[]");
}

async function runProvider(
  fetchImpl: typeof fetch,
  wantRestOfSeason = true,
) {
  clearProjectionFeedCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const crosswalk = await PlayerCrosswalk.create(NoCrosswalk);
    const provider = new SleeperWeeklyProjectionProvider();
    return await provider.getWeeklyProjections({
      league: {
        league_slug: "segment-test",
        season: 2026,
        raw_scoring: {
          pass_yd: 0.04,
          pass_td: 4,
          rush_yd: 0.1,
          rush_td: 6,
          rec: 1,
          rec_yd: 0.1,
          rec_td: 6,
        },
        scoring_rules: [],
      },
      week: 3,
      crosswalk,
      canonical_player_ids: [],
      want_rest_of_season: wantRestOfSeason,
    });
  } finally {
    globalThis.fetch = originalFetch;
    clearProjectionFeedCache();
  }
}

describe("segmented production weekly projections", () => {
  it("keeps QB/RB and K/DEF when the WR/TE weekly segment fails", async () => {
    const batch = await runProvider((async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const positions = segmentPositions(url);
      const weekly = /\/projections\/nfl\/2026\/3$/.test(url.pathname);

      if (weekly && positions.includes("WR")) {
        return new Response("segment unavailable", { status: 404 });
      }

      return new Response(JSON.stringify(rowsFor(positions, weekly)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    assert.equal(batch.status, "PROJECTIONS_PARTIAL");
    assert.ok(
      batch.warnings.some(
        (w) =>
          w.code === "weekly_projection_segment_unavailable" &&
          w.message.includes("WR_TE") &&
          w.message.includes("WR/TE"),
      ),
    );

    const positions = new Set([...batch.by_player.values()].map((p) => p.position));
    assert.ok(positions.has("QB"));
    assert.ok(positions.has("RB"));
    assert.ok(positions.has("K"));
    assert.ok(positions.has("DEF"));
    assert.ok(!positions.has("WR"));
    assert.ok(!positions.has("TE"));

    const qb = [...batch.by_player.values()].find((p) => p.position === "QB");
    assert.ok(qb && qb.projected_points != null);
    assert.ok(qb.rest_of_season_points != null, "successful season segment still supplies ROS");
  });

  it("keeps every weekly projection when only the K/DEF season segment fails", async () => {
    const batch = await runProvider((async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const positions = segmentPositions(url);
      const weekly = /\/projections\/nfl\/2026\/3$/.test(url.pathname);

      if (!weekly && positions.includes("K")) {
        return new Response("season segment unavailable", { status: 404 });
      }

      return new Response(JSON.stringify(rowsFor(positions, weekly)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    assert.equal(batch.by_player.size, 6, "all weekly position families remain present");
    assert.ok(
      batch.warnings.some(
        (w) =>
          w.code === "season_projection_segment_unavailable" &&
          w.message.includes("K_DEF"),
      ),
    );

    const qb = [...batch.by_player.values()].find((p) => p.position === "QB");
    const kicker = [...batch.by_player.values()].find((p) => p.position === "K");
    const defense = [...batch.by_player.values()].find((p) => p.position === "DEF");

    assert.ok(qb?.rest_of_season_points != null);
    assert.equal(kicker?.rest_of_season_points, null);
    assert.equal(defense?.rest_of_season_points, null);
  });

  it("returns PROJECTIONS_UNAVAILABLE only when no weekly segment is usable", async () => {
    const batch = await runProvider((async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const weekly = /\/projections\/nfl\/2026\/3$/.test(url.pathname);
      if (weekly) return new Response("all weekly segments unavailable", { status: 404 });

      return new Response(JSON.stringify(rowsFor(segmentPositions(url), false)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    assert.equal(batch.status, "PROJECTIONS_UNAVAILABLE");
    assert.equal(batch.by_player.size, 0);
    assert.ok(batch.warnings.some((w) => w.code === "weekly_projection_source_unavailable"));
    assert.equal(
      batch.warnings.filter((w) => w.code === "weekly_projection_segment_unavailable").length,
      3,
    );
  });
});
