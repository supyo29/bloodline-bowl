/**
 * Freshness classification — age buckets vs. source health vs. DEGRADED, kept
 * as three distinct axes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveFreshness } from "../lib/canonical/freshness";

const T0 = Date.parse("2026-09-07T00:00:00.000Z");
const at = (secondsAgo: number) => new Date(T0 - secondsAgo * 1000).toISOString();

describe("deriveFreshness", () => {
  it("NORMAL age buckets", () => {
    const base = { mode: "NORMAL" as const, now: T0, source_status: "AVAILABLE" as const };
    assert.equal(deriveFreshness({ ...base, source_synced_at: at(30) }).status, "FRESH");
    assert.equal(deriveFreshness({ ...base, source_synced_at: at(300) }).status, "ACCEPTABLE");
    assert.equal(deriveFreshness({ ...base, source_synced_at: at(1200) }).status, "STALE");
  });

  it("LIVE_DRAFT tightens the boundaries", () => {
    const f = deriveFreshness({
      mode: "LIVE_DRAFT",
      now: T0,
      source_synced_at: at(20),
      source_status: "AVAILABLE",
    });
    assert.equal(f.status, "ACCEPTABLE"); // 20s > 10s fresh, <= 30s acceptable
  });

  it("source unavailable overrides age entirely", () => {
    const f = deriveFreshness({
      mode: "NORMAL",
      now: T0,
      source_synced_at: at(5),
      source_status: "SOURCE_UNAVAILABLE",
    });
    assert.equal(f.status, "SOURCE_UNAVAILABLE");
    assert.equal(f.source_status, "SOURCE_UNAVAILABLE");
  });

  it("STALE with a healthy source is distinct from SOURCE_UNAVAILABLE", () => {
    const stale = deriveFreshness({
      mode: "NORMAL",
      now: T0,
      source_synced_at: at(5000),
      source_status: "AVAILABLE",
    });
    assert.equal(stale.status, "STALE");
    assert.equal(stale.source_status, "AVAILABLE");
    assert.equal(stale.degraded_reason, null);
  });

  it("DEGRADED always carries a reason and is not an age bucket", () => {
    const f = deriveFreshness({
      mode: "NORMAL",
      now: T0,
      source_synced_at: at(5),
      source_status: "AVAILABLE",
      degraded_reason: "CERTIFICATION_FAILED",
    });
    assert.equal(f.status, "DEGRADED");
    assert.equal(f.degraded_reason, "CERTIFICATION_FAILED");
  });

  it("no published snapshot -> DEGRADED / NO_PUBLISHED_SNAPSHOT", () => {
    const f = deriveFreshness({ mode: "NORMAL", now: T0, degraded_reason: "NO_PUBLISHED_SNAPSHOT" });
    assert.equal(f.status, "DEGRADED");
    assert.equal(f.age_seconds, null);
  });
});
