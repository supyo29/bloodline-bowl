/**
 * Provider abstraction — deterministic (no network).
 *
 * Proves the shape of the provider surface and, critically, the degraded-state
 * contract: an unconfigured / unconnected Yahoo NEVER returns fabricated data.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getProvider, reportProviderStatus, SUPPORTED_PROVIDERS } from "../lib/providers/registry";
import { YahooProvider } from "../lib/providers/yahoo/provider";
import { loadYahooConfig } from "../lib/providers/yahoo/config";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import type { ProviderLeagueContext } from "../lib/providers/types";

async function ctx(): Promise<ProviderLeagueContext> {
  return {
    league_slug: "maclin-on-chicks-xvi",
    external_league_id: "82713",
    season: 2026,
    crosswalk: await PlayerCrosswalk.create(NoCrosswalk),
  };
}

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe("provider registry", () => {
  it("returns a SleeperProvider and a YahooProvider", () => {
    assert.equal(getProvider("sleeper").name, "sleeper");
    assert.equal(getProvider("yahoo").name, "yahoo");
  });

  it("SUPPORTED_PROVIDERS is [sleeper, yahoo]", () => {
    assert.deepEqual(SUPPORTED_PROVIDERS, ["sleeper", "yahoo"]);
  });

  it("ESPN is explicitly not implemented (throws, not a silent stub)", () => {
    assert.throws(() => getProvider("espn"), /not implemented/);
  });
});

describe("Sleeper provider capabilities + auth", () => {
  it("declares full capabilities and no authentication", () => {
    const p = getProvider("sleeper");
    assert.equal(p.authentication, "NONE");
    const caps = p.capabilities();
    assert.equal(caps.live_authenticated_access, true);
    assert.equal(caps.transactions, true);
  });
});

describe("Yahoo provider degraded states — never fabricates", () => {
  it("loadYahooConfig reports NOT_CONFIGURED with the missing env names", () => {
    const cfg = loadYahooConfig(EMPTY_ENV);
    assert.equal(cfg.configured, false);
    assert.equal(cfg.status, "NOT_CONFIGURED");
    assert.deepEqual(cfg.missing.sort(), ["YAHOO_CLIENT_ID", "YAHOO_CLIENT_SECRET", "YAHOO_REDIRECT_URI"]);
  });

  it("with no env: every data method returns NOT_CONFIGURED and null data", async () => {
    const p = new YahooProvider({ env: EMPTY_ENV });
    const c = await ctx();
    for (const call of [
      () => p.getLeagueState(c),
      () => p.getLeague(c),
      () => p.getManagers(c),
      () => p.getStandings(c),
      () => p.getRosters(c),
      () => p.getMatchups(c),
      () => p.getTransactions(c),
      () => p.getDraftResults(c),
      () => p.getWaiverState(c),
    ]) {
      const res = await call();
      assert.equal(res.data, null, "no fabricated data");
      assert.equal(res.status, "NOT_CONFIGURED");
      assert.ok(res.warnings[0]?.code.startsWith("yahoo_"));
    }
    const health = await p.healthCheck();
    assert.equal(health.status, "NOT_CONFIGURED");
  });

  it("with env set but no connected account: AUTH_REQUIRED (still null data)", async () => {
    const env = {
      YAHOO_CLIENT_ID: "id",
      YAHOO_CLIENT_SECRET: "secret",
      YAHOO_REDIRECT_URI: "https://x/api/auth/yahoo/callback",
    } as unknown as NodeJS.ProcessEnv;
    const p = new YahooProvider({ env });
    const res = await p.getLeagueState(await ctx());
    assert.equal(res.status, "AUTH_REQUIRED");
    assert.equal(res.data, null);
    const health = await p.healthCheck();
    assert.equal(health.status, "AUTH_REQUIRED");
  });

  it("capabilities() shows the surface Yahoo COULD serve, but live_authenticated_access is false", () => {
    const caps = new YahooProvider({ env: EMPTY_ENV }).capabilities();
    assert.equal(caps.transactions, true);
    assert.equal(caps.live_authenticated_access, false);
  });
});

describe("reportProviderStatus (backs /api/providers)", () => {
  it("returns one entry per supported provider with a real status + capabilities", async () => {
    const report = await reportProviderStatus();
    assert.equal(report.length, 2);
    const yahoo = report.find((r) => r.provider === "yahoo")!;
    assert.equal(yahoo.authentication, "OAUTH");
    assert.ok(["NOT_CONFIGURED", "AUTH_REQUIRED", "READY"].includes(yahoo.status));
    const sleeper = report.find((r) => r.provider === "sleeper")!;
    assert.equal(sleeper.authentication, "NONE");
  });
});
