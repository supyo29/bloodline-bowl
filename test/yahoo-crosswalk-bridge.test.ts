/** LIVE DEFECT regression (W2.R1 early shadow, 2026-10-14): Yahoo roster identities must be bridged in every league-state caller. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { resolveLeagueCrosswalk, yahooBridgeLoader } from "@/lib/canonical/yahoo-bridge-source";
import { YahooSleeperBridge } from "@/lib/canonical/yahoo-sleeper-bridge";

const bridge = new YahooSleeperBridge([{ player_id: "S1", full_name: "Drake Maye", position: "QB", fantasy_positions: ["QB"], team: "NE", status: "Active", active: true } as never]);
const withLoader = async <T>(fn: (calls: { n: number }) => Promise<T>): Promise<T> => {
  const keep = yahooBridgeLoader.load; const calls = { n: 0 };
  yahooBridgeLoader.load = async () => { calls.n += 1; return bridge; };
  try { return await fn(calls); } finally { yahooBridgeLoader.load = keep; }
};

describe("resolveLeagueCrosswalk", () => {
  it("a YAHOO league's default crosswalk is bridged to the Sleeper identity", async () => {
    await withLoader(async (calls) => {
      const cw = await resolveLeagueCrosswalk("yahoo", undefined, () => new PlayerCrosswalk(NoCrosswalk));
      assert.equal(calls.n, 1);
      await cw.ensureLoaded();
      const r = cw.resolve({ provider: "yahoo", provider_player_id: "nfl.p.40881", full_name: "Drake Maye", position: "QB", nfl_team: "NE", known_identifiers: { yahoo_player_key: "nfl.p.40881" } });
      assert.ok(!r.player.canonical_player_id.startsWith("player:yahoo:"), `still provider-scoped: ${r.player.canonical_player_id}`);
    });
  });
  it("a Sleeper league never loads the Yahoo bridge", async () => {
    await withLoader(async (calls) => { await resolveLeagueCrosswalk("sleeper", undefined, () => new PlayerCrosswalk(NoCrosswalk)); assert.equal(calls.n, 0); });
  });
  it("a caller-injected crosswalk is returned untouched (no bridge, no network)", async () => {
    await withLoader(async (calls) => { const mine = new PlayerCrosswalk(NoCrosswalk); assert.equal(await resolveLeagueCrosswalk("yahoo", mine, () => { throw new Error("must not build"); }), mine); assert.equal(calls.n, 0); });
  });
});

describe("every league-state caller that builds its own crosswalk goes through the bridge-aware resolver", () => {
  for (const f of ["lib/weekly/context.ts", "lib/trades/context.ts", "lib/roster-health/inputs.ts", "lib/persistence/capture.ts", "app/api/transactions/[league]/route.ts", "app/api/yahoo/leagues/[leagueId]/provider-availability/route.ts"]) {
    it(`${f} uses resolveLeagueCrosswalk and no longer builds a bare default crosswalk`, () => {
      const src = readFileSync(f, "utf8");
      assert.match(src, /resolveLeagueCrosswalk\(/);
      assert.ok(!/const crosswalk =\s*\n?\s*options\.crosswalkOverride \?\?\s*\n?\s*\(defaultCrosswalkSource/.test(src), "bare default crosswalk (bridge bypass) must not return");
    });
  }
});
