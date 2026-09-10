/**
 * Yahoo access-state taxonomy + the "valid OAuth, forbidden Fantasy API" case.
 * Deterministic; no network, no real credentials.
 *
 * The external situation being modeled: OAuth is fully connected (token issued,
 * refresh token stored, healthy) but Yahoo has NOT yet provisioned Fantasy API
 * access for the Client ID, so every Fantasy endpoint returns HTTP 403. This
 * MUST surface as `FANTASY_API_FORBIDDEN`, never as an OAuth/token failure.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { YahooApiError, YahooFantasyClient } from "../lib/providers/yahoo/client";
import { InMemoryYahooTokenStore, type YahooToken } from "../lib/providers/yahoo/oauth";
import {
  accessStateFromSession,
  classifyFantasyApiError,
  describeAccessState,
  refineWithFantasyProbe,
  YAHOO_ACCESS_STATES,
} from "../lib/providers/yahoo/access-state";
import { runLeagueDiscovery, runDeepProbe } from "../lib/providers/yahoo/diagnostics";
import { clearGameKeyCache } from "../lib/providers/yahoo/games";
import type { YahooSession } from "../lib/providers/yahoo/session";

const CONFIG = {
  client_id: "cid",
  client_secret: "csecret-DO-NOT-LEAK",
  redirect_uri: "https://x/api/yahoo/oauth/callback",
  scope: "fspt-r",
  game_key_override: null,
};

const HEALTHY_TOKEN: YahooToken = {
  access_token: "ACCESS-SECRET-1",
  refresh_token: "REFRESH-SECRET-1",
  token_type: "bearer",
  scope: "fspt-r",
  expires_at: Date.now() + 3_600_000,
  yahoo_guid: "GUID-1",
};

function connectedStore(): InMemoryYahooTokenStore {
  const s = new InMemoryYahooTokenStore();
  void s.set({ ...HEALTHY_TOKEN });
  return s;
}

/** A YahooFantasyClient whose every Fantasy call returns `status`. */
function clientReturning(status: number, body: unknown = { error: "not provisioned" }) {
  let fantasyCalls = 0;
  let tokenCalls = 0;
  const client = new YahooFantasyClient({
    config: CONFIG,
    store: connectedStore(),
    fetchImpl: ((url: string) => {
      if (String(url).includes("oauth2/get_token")) {
        tokenCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }), { status: 200 }),
        );
      }
      fantasyCalls += 1;
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as unknown as typeof fetch,
  });
  return {
    client,
    counts: () => ({ fantasyCalls, tokenCalls }),
  };
}

describe("taxonomy shape", () => {
  it("has the 8 documented states (+ STORAGE_UNAVAILABLE)", () => {
    for (const s of [
      "NOT_CONFIGURED",
      "NOT_CONNECTED",
      "TOKEN_EXPIRED_OR_INVALID",
      "CONNECTED",
      "FANTASY_API_FORBIDDEN",
      "RATE_LIMITED",
      "NETWORK_ERROR",
      "MALFORMED_RESPONSE",
    ]) {
      assert.ok(YAHOO_ACCESS_STATES.includes(s as never), `${s} present`);
    }
  });

  it("the FANTASY_API_FORBIDDEN sentence names OAuth as connected and API as 403", () => {
    const d = describeAccessState("FANTASY_API_FORBIDDEN");
    assert.match(d, /connected/i);
    assert.match(d, /403/);
    assert.match(d, /provision/i);
  });
});

describe("classifyFantasyApiError", () => {
  const cases: Array<[YahooApiError["kind"], string]> = [
    ["FORBIDDEN", "FANTASY_API_FORBIDDEN"],
    ["RATE_LIMITED", "RATE_LIMITED"],
    ["TIMEOUT", "NETWORK_ERROR"],
    ["NETWORK", "NETWORK_ERROR"],
    ["SERVER", "NETWORK_ERROR"],
    ["MALFORMED", "MALFORMED_RESPONSE"],
    ["NOT_FOUND", "MALFORMED_RESPONSE"],
    ["AUTH", "TOKEN_EXPIRED_OR_INVALID"],
    ["NOT_CONNECTED", "NOT_CONNECTED"],
  ];
  for (const [kind, expected] of cases) {
    it(`${kind} -> ${expected}`, () => {
      const { state, detail } = classifyFantasyApiError(new YahooApiError(kind, "x", 403, "/p"));
      assert.equal(state, expected);
      assert.ok(!detail.includes("ACCESS-SECRET"));
    });
  }

  it("403 and a persistent 401 classify DIFFERENTLY", () => {
    assert.equal(classifyFantasyApiError(new YahooApiError("FORBIDDEN", "x", 403, "/p")).state, "FANTASY_API_FORBIDDEN");
    assert.equal(classifyFantasyApiError(new YahooApiError("AUTH", "x", 401, "/p")).state, "TOKEN_EXPIRED_OR_INVALID");
  });

  it("429 stays distinct from 403 and from network", () => {
    assert.equal(classifyFantasyApiError(new YahooApiError("RATE_LIMITED", "x", 429, "/p")).state, "RATE_LIMITED");
  });
});

describe("accessStateFromSession", () => {
  const mk = (state: YahooSession["state"]): YahooSession =>
    ({
      state,
      detail: "d",
      config: null,
      store: null,
      client: null,
      token: { connected: false, healthy: false, expires_at: null, expires_in_seconds: null, yahoo_guid: null, backend: "none" },
      missing_env: [],
    }) as YahooSession;

  it("maps session states to the taxonomy", () => {
    assert.equal(accessStateFromSession(mk("NOT_CONFIGURED")).state, "NOT_CONFIGURED");
    assert.equal(accessStateFromSession(mk("STORAGE_UNAVAILABLE")).state, "STORAGE_UNAVAILABLE");
    assert.equal(accessStateFromSession(mk("NOT_CONNECTED")).state, "NOT_CONNECTED");
    assert.equal(accessStateFromSession(mk("TOKEN_UNHEALTHY")).state, "TOKEN_EXPIRED_OR_INVALID");
    assert.equal(accessStateFromSession(mk("READY")).state, "CONNECTED");
  });
});

describe("refineWithFantasyProbe", () => {
  it("CONNECTED + 403 probe -> FANTASY_API_FORBIDDEN", () => {
    const r = refineWithFantasyProbe(
      { state: "CONNECTED", detail: "" },
      new YahooApiError("FORBIDDEN", "x", 403, "/users;use_login=1/games"),
    );
    assert.equal(r.state, "FANTASY_API_FORBIDDEN");
  });
  it("CONNECTED + successful probe -> CONNECTED", () => {
    assert.equal(refineWithFantasyProbe({ state: "CONNECTED", detail: "" }, null).state, "CONNECTED");
  });
  it("NOT_CONNECTED is never overridden by a probe outcome", () => {
    assert.equal(
      refineWithFantasyProbe({ state: "NOT_CONNECTED", detail: "" }, new YahooApiError("FORBIDDEN", "x", 403, "/p")).state,
      "NOT_CONNECTED",
    );
  });
});

describe("OAuth success + Fantasy API 403 (runLeagueDiscovery)", () => {
  it("reports FANTASY_API_FORBIDDEN, fabricates nothing, touches no token, no retry loop", async () => {
    clearGameKeyCache();
    const store = new InMemoryYahooTokenStore();
    await store.set({ ...HEALTHY_TOKEN });
    let fantasyCalls = 0;
    const client = new YahooFantasyClient({
      config: CONFIG,
      store,
      fetchImpl: ((url: string) => {
        assert.ok(!String(url).includes("oauth2/get_token"), "must not refresh on a 403");
        fantasyCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: "not provisioned" }), { status: 403 }));
      }) as unknown as typeof fetch,
    });

    const report = await runLeagueDiscovery(client, { season: 2026 });

    assert.equal(report.access_state, "FANTASY_API_FORBIDDEN");
    assert.match(report.access_detail, /403/);
    assert.equal(report.authenticated, false);
    assert.equal(report.game_key, null, "game key stays unresolved — never guessed");
    assert.equal(report.game_key_live, false);
    assert.deepEqual(report.discovered_leagues, []);
    assert.deepEqual(report.configured_leagues, []);

    // Exactly the identity probe + the game-key call. Discovery + per-league
    // probes are skipped (no hammering), and a 403 is not retried.
    assert.equal(fantasyCalls, 2);

    // The stored token is byte-identical — nothing cleared, refresh token kept.
    const after = await store.get();
    assert.equal(after!.access_token, HEALTHY_TOKEN.access_token);
    assert.equal(after!.refresh_token, HEALTHY_TOKEN.refresh_token);
    assert.equal(after!.expires_at, HEALTHY_TOKEN.expires_at);
  });

  it("runDeepProbe under 403 yields zero league_probes and the same state", async () => {
    clearGameKeyCache();
    const { client } = clientReturning(403);
    const probe = await runDeepProbe(client, { season: 2026 });
    assert.equal(probe.discovery.access_state, "FANTASY_API_FORBIDDEN");
    assert.deepEqual(probe.league_probes, []);
  });

  it("rate-limited Fantasy API -> RATE_LIMITED (distinct), still no fabrication", async () => {
    clearGameKeyCache();
    const { client } = clientReturning(429);
    const report = await runLeagueDiscovery(client, { season: 2026 });
    assert.equal(report.access_state, "RATE_LIMITED");
    assert.deepEqual(report.discovered_leagues, []);
    assert.equal(report.game_key, null);
  });

  it("Yahoo 5xx -> NETWORK_ERROR (distinct)", async () => {
    clearGameKeyCache();
    const { client } = clientReturning(503);
    const report = await runLeagueDiscovery(client, { season: 2026 });
    assert.equal(report.access_state, "NETWORK_ERROR");
  });
});

describe("redaction — a 403 discovery report carries no secret", () => {
  it("serialized report has no token/secret/Authorization material", async () => {
    clearGameKeyCache();
    const { client } = clientReturning(403);
    const report = await runLeagueDiscovery(client, { season: 2026 });
    const s = JSON.stringify(report);
    for (const needle of [
      "ACCESS-SECRET",
      "REFRESH-SECRET",
      "csecret-DO-NOT-LEAK",
      "Bearer ",
      "authorization",
      "service_role",
    ]) {
      assert.ok(!s.toLowerCase().includes(needle.toLowerCase()), `report must not contain "${needle}"`);
    }
  });
});
