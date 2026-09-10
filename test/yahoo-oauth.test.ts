/**
 * Yahoo OAuth 2.0 flow — deterministic. `globalThis.fetch` is stubbed; no real
 * network, no real credentials.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { loadYahooConfig } from "../lib/providers/yahoo/config";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getValidAccessToken,
  InMemoryYahooTokenStore,
  refreshAccessToken,
  statesMatch,
  YahooOAuthError,
  type YahooToken,
} from "../lib/providers/yahoo/oauth";

const CONFIG = {
  client_id: "test-client-id",
  client_secret: "test-client-secret",
  redirect_uri: "https://bloodline-bowl-sleeper-bridge.vercel.app/api/yahoo/oauth/callback",
  scope: "fspt-r",
  game_key_override: null,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {}))) as typeof fetch;
}

function tokenBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "ACCESS-1",
    refresh_token: "REFRESH-1",
    expires_in: 3600,
    token_type: "bearer",
    xoauth_yahoo_guid: "GUID123",
    ...over,
  });
}

describe("authorize URL", () => {
  it("includes client_id, redirect_uri, response_type=code, scope, state", () => {
    const url = new URL(buildAuthorizeUrl(CONFIG, "STATE-abc"));
    assert.equal(url.origin + url.pathname, "https://api.login.yahoo.com/oauth2/request_auth");
    assert.equal(url.searchParams.get("client_id"), "test-client-id");
    assert.equal(url.searchParams.get("redirect_uri"), CONFIG.redirect_uri);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "fspt-r");
    assert.equal(url.searchParams.get("state"), "STATE-abc");
  });
  it("never contains the client secret", () => {
    assert.ok(!buildAuthorizeUrl(CONFIG, "s").includes("test-client-secret"));
  });
});

describe("state validation", () => {
  it("matches only identical, present values (constant-time)", () => {
    assert.equal(statesMatch("abc", "abc"), true);
    assert.equal(statesMatch("abc", "abd"), false);
    assert.equal(statesMatch("abc", "abcd"), false);
    assert.equal(statesMatch(null, "abc"), false);
    assert.equal(statesMatch("abc", undefined), false);
    assert.equal(statesMatch("", ""), false);
  });
});

describe("code exchange", () => {
  it("posts grant_type=authorization_code with HTTP Basic client auth and parses the token", async () => {
    let seenAuth = "";
    let seenBody = "";
    stubFetch((url, init) => {
      assert.equal(url, "https://api.login.yahoo.com/oauth2/get_token");
      seenAuth = (init.headers as Record<string, string>).Authorization ?? "";
      seenBody = String(init.body);
      return new Response(tokenBody(), { status: 200 });
    });
    const tok = await exchangeCodeForToken(CONFIG, "AUTH-CODE-1");
    assert.equal(seenAuth, `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`);
    assert.ok(seenBody.includes("grant_type=authorization_code"));
    assert.ok(seenBody.includes("code=AUTH-CODE-1"));
    assert.equal(tok.access_token, "ACCESS-1");
    assert.equal(tok.refresh_token, "REFRESH-1");
    assert.equal(tok.yahoo_guid, "GUID123");
    assert.ok(tok.expires_at > Date.now());
  });

  it("throws YahooOAuthError on an HTTP error body", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }));
    await assert.rejects(() => exchangeCodeForToken(CONFIG, "bad"), (e: unknown) => {
      assert.ok(e instanceof YahooOAuthError);
      assert.equal((e as YahooOAuthError).kind, "TOKEN_ENDPOINT_HTTP");
      return true;
    });
  });

  it("classifies invalid_grant distinctly", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await assert.rejects(() => exchangeCodeForToken(CONFIG, "x"), (e: unknown) => {
      assert.equal((e as YahooOAuthError).kind, "INVALID_GRANT");
      return true;
    });
  });

  it("throws on a 200 with a malformed body (no tokens)", async () => {
    stubFetch(() => new Response(JSON.stringify({ access_token: "only-access" }), { status: 200 }));
    await assert.rejects(() => exchangeCodeForToken(CONFIG, "x"), (e: unknown) => {
      assert.equal((e as YahooOAuthError).kind, "TOKEN_ENDPOINT_MALFORMED");
      return true;
    });
  });

  it("throws on non-JSON body", async () => {
    stubFetch(() => new Response("<html>nope</html>", { status: 200 }));
    await assert.rejects(() => exchangeCodeForToken(CONFIG, "x"), (e: unknown) => {
      assert.equal((e as YahooOAuthError).kind, "TOKEN_ENDPOINT_MALFORMED");
      return true;
    });
  });
});

describe("refresh + getValidAccessToken", () => {
  function futureToken(msFromNow: number): YahooToken {
    return {
      access_token: "OLD-ACCESS",
      refresh_token: "REFRESH-1",
      token_type: "bearer",
      scope: "fspt-r",
      expires_at: Date.now() + msFromNow,
      yahoo_guid: "GUID123",
    };
  }

  it("returns NOT_CONNECTED when the store is empty", async () => {
    const r = await getValidAccessToken(CONFIG, new InMemoryYahooTokenStore());
    assert.equal(r.status, "NOT_CONNECTED");
    assert.equal(r.access_token, null);
  });

  it("returns the existing token when it is comfortably fresh (no fetch)", async () => {
    stubFetch(() => {
      throw new Error("should not refresh");
    });
    const store = new InMemoryYahooTokenStore();
    await store.set(futureToken(3_600_000));
    const r = await getValidAccessToken(CONFIG, store);
    assert.equal(r.status, "OK");
    assert.equal(r.access_token, "OLD-ACCESS");
  });

  it("refreshes when within the skew window and persists the rotated token", async () => {
    let calls = 0;
    stubFetch((_url, init) => {
      calls += 1;
      assert.ok(String(init.body).includes("grant_type=refresh_token"));
      return new Response(tokenBody({ access_token: "NEW-ACCESS", refresh_token: "REFRESH-2" }), { status: 200 });
    });
    const store = new InMemoryYahooTokenStore();
    await store.set(futureToken(30_000)); // 30s left -> below 120s skew
    const r = await getValidAccessToken(CONFIG, store);
    assert.equal(r.status, "OK");
    assert.equal(r.access_token, "NEW-ACCESS");
    assert.equal(calls, 1);
    assert.equal((await store.get())!.access_token, "NEW-ACCESS");
    assert.equal((await store.get())!.refresh_token, "REFRESH-2");
  });

  it("de-dupes concurrent refreshes into ONE network call + ONE write", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      await new Promise((res) => setTimeout(res, 10));
      return new Response(tokenBody({ access_token: "NEW-ACCESS" }), { status: 200 });
    });
    const store = new InMemoryYahooTokenStore();
    await store.set(futureToken(1_000));
    const [a, b, c] = await Promise.all([
      getValidAccessToken(CONFIG, store),
      getValidAccessToken(CONFIG, store),
      getValidAccessToken(CONFIG, store),
    ]);
    assert.equal(a.access_token, "NEW-ACCESS");
    assert.equal(b.access_token, "NEW-ACCESS");
    assert.equal(c.access_token, "NEW-ACCESS");
    assert.equal(calls, 1);
  });

  it("returns REFRESH_FAILED (never loops) when the refresh call errors", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const store = new InMemoryYahooTokenStore();
    await store.set(futureToken(1_000));
    const r = await getValidAccessToken(CONFIG, store);
    assert.equal(r.status, "REFRESH_FAILED");
    assert.equal(r.access_token, null);
    assert.ok(r.detail?.includes("invalid_grant"));
  });

  it("keeps the prior refresh_token if Yahoo omits it on refresh", async () => {
    stubFetch(() => new Response(JSON.stringify({ access_token: "NEW", expires_in: 3600 }), { status: 200 }));
    const prev = futureToken(1_000);
    const rotated = await refreshAccessToken(CONFIG, prev);
    assert.equal(rotated.refresh_token, "REFRESH-1");
  });
});

describe("loadYahooConfig", () => {
  it("NOT_CONFIGURED lists exactly the missing names, no values", () => {
    const cfg = loadYahooConfig({} as NodeJS.ProcessEnv);
    assert.equal(cfg.configured, false);
    assert.deepEqual(cfg.missing.sort(), ["YAHOO_CLIENT_ID", "YAHOO_CLIENT_SECRET", "YAHOO_REDIRECT_URI"]);
  });
  it("READY when the three core vars are present; reports encryption key separately", () => {
    const cfg = loadYahooConfig({
      YAHOO_CLIENT_ID: "i",
      YAHOO_CLIENT_SECRET: "s",
      YAHOO_REDIRECT_URI: "https://x/api/yahoo/oauth/callback",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(cfg.configured, true);
    assert.equal(cfg.encryption_key_present, false);
  });
});
