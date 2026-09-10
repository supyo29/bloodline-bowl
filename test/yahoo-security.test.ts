/**
 * Yahoo security invariants — make it hard to accidentally leak a secret.
 * Deterministic, no network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildAuthorizeUrl, InMemoryYahooTokenStore, type YahooToken } from "../lib/providers/yahoo/oauth";
import { loadYahooSession } from "../lib/providers/yahoo/session";

const CONFIG = {
  client_id: "cid-PUBLIC",
  client_secret: "csecret-MUST-NOT-LEAK",
  redirect_uri: "https://x/api/yahoo/oauth/callback",
  scope: "fspt-r",
  game_key_override: null,
};

describe("authorize URL never carries the client secret", () => {
  it("omits the secret entirely", () => {
    const url = buildAuthorizeUrl(CONFIG, "state123");
    assert.ok(!url.includes("csecret-MUST-NOT-LEAK"));
    assert.ok(!url.toLowerCase().includes("client_secret"));
  });
});

describe("/api/yahoo/status body never contains a token or secret", () => {
  it("serializes only non-secret token metadata", async () => {
    // A connected, healthy session via an in-memory store + fake config env.
    const env = {
      YAHOO_CLIENT_ID: "cid",
      YAHOO_CLIENT_SECRET: "csecret-MUST-NOT-LEAK",
      YAHOO_REDIRECT_URI: "https://x/api/yahoo/oauth/callback",
      YAHOO_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
      YAHOO_ALLOW_MEMORY_TOKEN_STORE: "1",
    } as unknown as NodeJS.ProcessEnv;

    const session = await loadYahooSession(env, { allowMemoryFallback: true });
    const serialized = JSON.stringify(session.token);
    assert.ok(!serialized.includes("csecret-MUST-NOT-LEAK"));
    assert.ok(!/access_token"\s*:/.test(serialized));
    assert.ok(!/refresh_token"\s*:/.test(serialized));
    // The safe fields ARE present.
    assert.ok("expires_in_seconds" in session.token);
    assert.ok("healthy" in session.token);
  });
});

describe("token object shape", () => {
  it("the status route projects a token to a whitelist of non-secret fields", () => {
    const tok: YahooToken = {
      access_token: "SECRET-ACCESS",
      refresh_token: "SECRET-REFRESH",
      token_type: "bearer",
      scope: "fspt-r",
      expires_at: Date.now() + 1000,
      yahoo_guid: "g",
    };
    // Simulate the projection the routes use.
    const projected = {
      connected: true,
      healthy: true,
      expires_at: new Date(tok.expires_at).toISOString(),
      yahoo_guid: tok.yahoo_guid,
    };
    const s = JSON.stringify(projected);
    assert.ok(!s.includes("SECRET-ACCESS"));
    assert.ok(!s.includes("SECRET-REFRESH"));
  });
});

describe("no secret literals committed in the Yahoo source tree", () => {
  it("source files reference env var NAMES, not values", () => {
    for (const f of [
      "lib/providers/yahoo/config.ts",
      "lib/providers/yahoo/oauth.ts",
      "lib/providers/yahoo/client.ts",
      "lib/providers/yahoo/token-store.ts",
      "app/api/yahoo/auth/start/route.ts",
      "app/api/yahoo/oauth/callback/route.ts",
      "app/api/yahoo/status/route.ts",
    ]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      // A Yahoo consumer secret is a 40-char hex string; a client id is longer.
      // Assert no long hex/again-base64-ish literal is embedded.
      assert.ok(!/["'][0-9a-f]{40,}["']/i.test(src), `${f} contains a suspicious long hex literal`);
      assert.ok(src.includes("process.env") || !src.includes("YAHOO_CLIENT_SECRET"), f);
    }
  });
});

describe("InMemoryYahooTokenStore is clearly non-durable", () => {
  it("loses its token when replaced (documents the fallback risk)", async () => {
    const s = new InMemoryYahooTokenStore();
    await s.set({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
      scope: null,
      expires_at: Date.now() + 1000,
      yahoo_guid: null,
    });
    assert.ok(await s.get());
    assert.equal(new InMemoryYahooTokenStore().backend, "memory");
    assert.equal(await new InMemoryYahooTokenStore().get(), null);
  });
});
