/**
 * YahooFantasyClient — deterministic. Injected `fetchImpl`, injected token store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { YahooApiError, YahooFantasyClient } from "../lib/providers/yahoo/client";
import { InMemoryYahooTokenStore, type YahooToken } from "../lib/providers/yahoo/oauth";

const CONFIG = {
  client_id: "cid",
  client_secret: "csecret",
  redirect_uri: "https://x/api/yahoo/oauth/callback",
  scope: "fspt-r",
  game_key_override: null,
};

function connectedStore(over: Partial<YahooToken> = {}): InMemoryYahooTokenStore {
  const s = new InMemoryYahooTokenStore();
  void s.set({
    access_token: "ACCESS-1",
    refresh_token: "REFRESH-1",
    token_type: "bearer",
    scope: "fspt-r",
    expires_at: Date.now() + 3_600_000,
    yahoo_guid: "GUID",
    ...over,
  });
  return s;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

describe("YahooFantasyClient.get", () => {
  it("adds format=json, sends the bearer token, returns parsed data + sanitized meta", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const client = new YahooFantasyClient({
      config: CONFIG,
      store: connectedStore(),
      fetchImpl: ((url: string, init: RequestInit) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>).Authorization ?? "";
        return Promise.resolve(jsonResponse({ fantasy_content: { ok: 1 } }, 200, { "x-yahoo-request-id": "req-9" }));
      }) as unknown as typeof fetch,
    });
    const res = await client.get("/game/nfl");
    assert.ok(seenUrl.endsWith("/game/nfl?format=json"));
    assert.equal(seenAuth, "Bearer ACCESS-1");
    assert.deepEqual(res.data, { fantasy_content: { ok: 1 } });
    assert.equal(res.meta.request_id, "req-9");
    assert.equal(res.meta.http_status, 200);
    assert.equal(res.meta.refreshed, false);
  });

  it("throws NOT_CONNECTED when no token is stored", async () => {
    const client = new YahooFantasyClient({
      config: CONFIG,
      store: new InMemoryYahooTokenStore(),
      fetchImpl: (() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch,
    });
    await assert.rejects(() => client.get("/x"), (e: unknown) => {
      assert.equal((e as YahooApiError).kind, "NOT_CONNECTED");
      return true;
    });
  });

  it("on 401: refreshes once, retries once, then succeeds (meta.refreshed=true)", async () => {
    let apiCalls = 0;
    let tokenCalls = 0;
    const client = new YahooFantasyClient({
      config: CONFIG,
      store: connectedStore({ expires_at: Date.now() + 3_600_000 }),
      fetchImpl: ((url: string) => {
        if (String(url).includes("oauth2/get_token")) {
          tokenCalls += 1;
          return Promise.resolve(jsonResponse({ access_token: "ACCESS-2", refresh_token: "REFRESH-1", expires_in: 3600 }));
        }
        apiCalls += 1;
        return Promise.resolve(apiCalls === 1 ? jsonResponse({ error: "token expired" }, 401) : jsonResponse({ fantasy_content: { ok: 1 } }));
      }) as unknown as typeof fetch,
    });
    const res = await client.get("/league/x/metadata");
    assert.equal(tokenCalls, 1);
    assert.equal(apiCalls, 2);
    assert.equal(res.meta.refreshed, true);
  });

  it("on a second 401 after refresh: gives up with AUTH (no loop)", async () => {
    let apiCalls = 0;
    const client = new YahooFantasyClient({
      config: CONFIG,
      store: connectedStore(),
      fetchImpl: ((url: string) => {
        if (String(url).includes("oauth2/get_token")) {
          return Promise.resolve(jsonResponse({ access_token: "A2", refresh_token: "R1", expires_in: 3600 }));
        }
        apiCalls += 1;
        return Promise.resolve(jsonResponse({ error: "nope" }, 401));
      }) as unknown as typeof fetch,
    });
    await assert.rejects(() => client.get("/x"), (e: unknown) => {
      assert.equal((e as YahooApiError).kind, "AUTH");
      return true;
    });
    assert.equal(apiCalls, 2);
  });

  for (const [status, kind] of [
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "SERVER"],
    [503, "SERVER"],
  ] as const) {
    it(`classifies HTTP ${status} as ${kind}`, async () => {
      const client = new YahooFantasyClient({
        config: CONFIG,
        store: connectedStore(),
        fetchImpl: (() => Promise.resolve(jsonResponse({ error: "x" }, status))) as unknown as typeof fetch,
      });
      await assert.rejects(() => client.get("/x"), (e: unknown) => {
        assert.equal((e as YahooApiError).kind, kind);
        assert.equal((e as YahooApiError).httpStatus, status);
        return true;
      });
    });
  }

  it("classifies a non-JSON 200 body as MALFORMED", async () => {
    const client = new YahooFantasyClient({
      config: CONFIG,
      store: connectedStore(),
      fetchImpl: (() => Promise.resolve(jsonResponse("<xml/>", 200))) as unknown as typeof fetch,
    });
    await assert.rejects(() => client.get("/x"), (e: unknown) => {
      assert.equal((e as YahooApiError).kind, "MALFORMED");
      return true;
    });
  });

  it("classifies a thrown/aborted fetch as TIMEOUT or NETWORK", async () => {
    const client = new YahooFantasyClient({
      config: CONFIG,
      store: connectedStore(),
      fetchImpl: (() => {
        const e = new Error("The operation was aborted");
        e.name = "TimeoutError";
        return Promise.reject(e);
      }) as unknown as typeof fetch,
    });
    await assert.rejects(() => client.get("/x"), (e: unknown) => {
      assert.equal((e as YahooApiError).kind, "TIMEOUT");
      return true;
    });
  });

  it("never puts the access token in the error message", async () => {
    const client = new YahooFantasyClient({
      config: CONFIG,
      store: connectedStore(),
      fetchImpl: (() => Promise.resolve(jsonResponse({ error: "x" }, 500))) as unknown as typeof fetch,
    });
    try {
      await client.get("/x");
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(!(e as Error).message.includes("ACCESS-1"));
    }
  });
});
