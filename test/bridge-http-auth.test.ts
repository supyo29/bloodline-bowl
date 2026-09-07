/**
 * Stage E — shared secret auth for mutation / scheduler endpoints.
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import { authorizeSecret } from "../lib/http-auth";

const ENV = "TEST_REFRESH_SECRET";
afterEach(() => {
  delete process.env[ENV];
});

const req = (headers: Record<string, string>) =>
  new Request("https://x/api/refresh", { method: "POST", headers });

describe("authorizeSecret", () => {
  it("missing env secret -> endpoint disabled (401), not open", () => {
    const r = authorizeSecret(req({ authorization: "Bearer whatever" }), ENV);
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 401);
    assert.equal((r as { code: string }).code, "endpoint_disabled");
  });

  it("no credentials -> 401 unauthorized", () => {
    process.env[ENV] = "s3cr3t";
    const r = authorizeSecret(req({}), ENV);
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, "unauthorized");
  });

  it("wrong secret -> 401, and the error never contains the expected value", () => {
    process.env[ENV] = "the-real-secret-value";
    const r = authorizeSecret(req({ authorization: "Bearer wrong" }), ENV);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes("the-real-secret-value"));
  });

  it("correct secret via Authorization: Bearer -> ok", () => {
    process.env[ENV] = "s3cr3t";
    assert.equal(authorizeSecret(req({ authorization: "Bearer s3cr3t" }), ENV).ok, true);
  });

  it("correct secret via custom header -> ok", () => {
    process.env[ENV] = "s3cr3t";
    const r = authorizeSecret(req({ "x-refresh-secret": "s3cr3t" }), ENV, { header: "x-refresh-secret" });
    assert.equal(r.ok, true);
  });

  it("length mismatch does not throw (constant-time over digests)", () => {
    process.env[ENV] = "short";
    assert.doesNotThrow(() =>
      authorizeSecret(req({ authorization: "Bearer a-much-much-longer-attempted-value" }), ENV),
    );
  });

  it("query-string secret is ignored (never read)", () => {
    process.env[ENV] = "s3cr3t";
    const r = authorizeSecret(
      new Request("https://x/api/refresh?secret=s3cr3t", { method: "POST" }),
      ENV,
    );
    assert.equal(r.ok, false);
  });
});
