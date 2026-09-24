import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_YAHOO_CONNECTION_ID,
  listYahooConnectionBindings,
  resolveYahooConnectionSelection,
  yahooLeaguesForConnection,
} from "../lib/providers/yahoo/connections";
import {
  decodeYahooOAuthState,
  encodeYahooOAuthState,
} from "../lib/providers/yahoo/oauth-state";
import { resolveLeagueStrict } from "../lib/leagues/resolve";

describe("Yahoo multi-account registry bindings", () => {
  it("keeps Rogers Park on primary and isolates Maclin on maclin", () => {
    const bindings = listYahooConnectionBindings();
    const primary = bindings.find((b) => b.connection_id === "primary");
    const maclin = bindings.find((b) => b.connection_id === "maclin");

    assert.ok(primary);
    assert.ok(maclin);
    assert.deepEqual(primary!.league_slugs, ["rogers-park"]);
    assert.deepEqual(maclin!.league_slugs, ["maclin-on-chicks-xvi"]);

    assert.deepEqual(
      yahooLeaguesForConnection("primary").map((l) => l.key),
      ["rogers-park"],
    );
    assert.deepEqual(
      yahooLeaguesForConnection("maclin").map((l) => l.key),
      ["maclin-on-chicks-xvi"],
    );
  });

  it("league resolution carries the correct provider connection id", () => {
    const rogers = resolveLeagueStrict("rogers-park");
    const maclin = resolveLeagueStrict("maclin-on-chicks-xvi");
    assert.equal(rogers.ok, true);
    assert.equal(maclin.ok, true);
    if (!rogers.ok || !maclin.ok) throw new Error("registered leagues did not resolve");
    assert.equal(rogers.league.provider_connection_id, "primary");
    assert.equal(maclin.league.provider_connection_id, "maclin");
  });
});

describe("Yahoo connection selection", () => {
  it("defaults to the legacy primary connection when no selector is supplied", () => {
    const r = resolveYahooConnectionSelection(new URLSearchParams());
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("connection selection unexpectedly failed");
    assert.equal(r.connection_id, DEFAULT_YAHOO_CONNECTION_ID);
    assert.equal(r.league_slug, null);
  });

  it("resolves Maclin by league slug", () => {
    const r = resolveYahooConnectionSelection(
      new URLSearchParams("league=maclin-on-chicks-xvi"),
    );
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("connection selection unexpectedly failed");
    assert.equal(r.connection_id, "maclin");
    assert.equal(r.league_slug, "maclin-on-chicks-xvi");
  });

  it("resolves Rogers Park by league slug", () => {
    const r = resolveYahooConnectionSelection(
      new URLSearchParams("league=rogers-park"),
    );
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("connection selection unexpectedly failed");
    assert.equal(r.connection_id, "primary");
  });

  it("rejects a league/connection mismatch instead of crossing token slots", () => {
    const r = resolveYahooConnectionSelection(
      new URLSearchParams("league=maclin-on-chicks-xvi&connection=primary"),
    );
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("expected mismatch to fail");
    assert.equal(r.code, "yahoo_connection_league_mismatch");
  });

  it("rejects unregistered connection ids and non-Yahoo leagues", () => {
    const unknown = resolveYahooConnectionSelection(
      new URLSearchParams("connection=someone-elses-row"),
    );
    assert.equal(unknown.ok, false);

    const sleeper = resolveYahooConnectionSelection(
      new URLSearchParams("league=bloodline-bowl"),
    );
    assert.equal(sleeper.ok, false);
    if (!sleeper.ok) assert.equal(sleeper.code, "yahoo_league_wrong_provider");
  });
});

describe("Yahoo OAuth state connection binding", () => {
  it("round-trips the selected connection + league + nonce", () => {
    const encoded = encodeYahooOAuthState({
      connection_id: "maclin",
      league_slug: "maclin-on-chicks-xvi",
      nonce: "a".repeat(64),
    });
    const decoded = decodeYahooOAuthState(encoded);
    assert.deepEqual(decoded, {
      connection_id: "maclin",
      league_slug: "maclin-on-chicks-xvi",
      nonce: "a".repeat(64),
    });
  });

  it("rejects malformed/unregistered-shaped payloads before callback selection", () => {
    assert.equal(decodeYahooOAuthState("not-base64-json"), null);
    const bad = Buffer.from(
      JSON.stringify({
        connection_id: "../primary",
        league_slug: "maclin-on-chicks-xvi",
        nonce: "a".repeat(64),
      }),
      "utf8",
    ).toString("base64url");
    assert.equal(decodeYahooOAuthState(bad), null);
  });
});
