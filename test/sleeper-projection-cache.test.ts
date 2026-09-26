import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearProjectionFeedCache,
  getProjectionFeedCacheStatus,
  getSeasonProjections,
  getWeeklyProjectionArray,
} from "@/lib/sleeper/client";

function projectionRow(playerId: string) {
  return {
    player_id: playerId,
    team: "AAA",
    opponent: "BBB",
    season: "2026",
    season_type: "regular",
    week: 3,
    category: "proj",
    company: "rotowire",
    last_modified: 1_790_000_000_000,
    updated_at: 1_790_000_000_000,
    stats: { gp: 17, pts_ppr: 200, rec: 50, rec_yd: 700 },
    player: {
      first_name: "Cache",
      last_name: "Test",
      position: "WR",
      team: "AAA",
      years_exp: 3,
      injury_status: null,
      fantasy_positions: ["WR"],
      metadata: null,
    },
  };
}

describe("oversized Sleeper projection feed cache", () => {
  it("uses no-store, deduplicates concurrent reads, reuses TTL entries, and keeps weekly/season keys distinct", async () => {
    clearProjectionFeedCache();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const urls: string[] = [];
    const cacheModes: Array<RequestCache | undefined> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      urls.push(String(input));
      cacheModes.push(init?.cache);
      // Make overlapping callers contend on the same in-flight Promise.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify([projectionRow(String(calls))]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const seasonCalls = await Promise.all([
        getSeasonProjections("2026"),
        getSeasonProjections("2026"),
        getSeasonProjections("2026"),
      ]);
      assert.equal(calls, 3, "concurrent season callers should share one upstream read per segment");
      assert.deepEqual(seasonCalls[0], seasonCalls[1]);
      assert.deepEqual(seasonCalls[1], seasonCalls[2]);

      await getSeasonProjections("2026");
      assert.equal(calls, 3, "warm season call should reuse all process-local segment TTL entries");

      await Promise.all([
        getWeeklyProjectionArray("2026", 3),
        getWeeklyProjectionArray("2026", 3),
      ]);
      assert.equal(calls, 6, "weekly feed has three distinct keys but concurrent weekly callers dedupe");

      await getWeeklyProjectionArray("2026", 3);
      assert.equal(calls, 6, "warm weekly call should reuse all process-local segment TTL entries");

      assert.equal(urls.filter((u) => u.includes("/projections/nfl/2026?")).length, 3);
      assert.equal(urls.filter((u) => u.includes("/projections/nfl/2026/3?")).length, 3);
      assert.deepEqual(cacheModes, Array(6).fill("no-store"));

      const status = getProjectionFeedCacheStatus();
      assert.equal(status.entries, 6);
      assert.equal(status.in_flight, 0);
      assert.equal(status.keys.length, 6);
    } finally {
      globalThis.fetch = originalFetch;
      clearProjectionFeedCache();
    }
  });

  it("does not silently serve an expired projection entry after a refresh failure", async () => {
    clearProjectionFeedCache();
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = 1_000_000;
    let calls = 0;

    Date.now = () => now;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify([projectionRow("fresh")]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // 404 is non-retryable in fetchSleeper, so this proves the expired entry
      // is not used as a hidden stale fallback.
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const first = await getSeasonProjections("2026", ["QB"], { revalidate: 1 });
      assert.equal(first[0]?.player_id, "fresh");
      assert.equal(calls, 1);

      now += 1_001;
      await assert.rejects(
        () => getSeasonProjections("2026", ["QB"], { revalidate: 1 }),
        /Sleeper returned 404/,
      );
      assert.equal(calls, 2);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      clearProjectionFeedCache();
    }
  });
});
