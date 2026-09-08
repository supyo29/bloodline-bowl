/**
 * Refresh-policy — pure mode selection + reuse windows.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveRefreshPolicy } from "../lib/canonical/refresh-policy";
import { FRESHNESS_THRESHOLDS } from "../lib/canonical/freshness";

describe("resolveRefreshPolicy", () => {
  it("no signals -> NORMAL", () => {
    const p = resolveRefreshPolicy({});
    assert.equal(p.mode, "NORMAL");
    assert.equal(p.rebuild_after_seconds, 120);
  });

  it("recent transactions -> HIGH_ACTIVITY", () => {
    const p = resolveRefreshPolicy({ recent_transaction_count: 2 });
    assert.equal(p.mode, "HIGH_ACTIVITY");
    assert.ok(p.rebuild_after_seconds < 120);
  });

  it("active draft -> LIVE_DRAFT and outranks transaction activity", () => {
    const p = resolveRefreshPolicy({ draft_active: true, recent_transaction_count: 9 });
    assert.equal(p.mode, "LIVE_DRAFT");
  });

  it("forced -> zero reuse window but mode preserved", () => {
    const p = resolveRefreshPolicy({ recent_transaction_count: 1, forced: true });
    assert.equal(p.mode, "HIGH_ACTIVITY");
    assert.equal(p.rebuild_after_seconds, 0);
    assert.equal(p.pointer_cache_seconds, 0);
  });

  it("thresholds are codified and monotonic across modes", () => {
    assert.deepEqual(FRESHNESS_THRESHOLDS.NORMAL, { fresh_seconds: 120, acceptable_seconds: 600 });
    assert.deepEqual(FRESHNESS_THRESHOLDS.HIGH_ACTIVITY, { fresh_seconds: 30, acceptable_seconds: 90 });
    assert.deepEqual(FRESHNESS_THRESHOLDS.LIVE_DRAFT, { fresh_seconds: 10, acceptable_seconds: 30 });
  });
});
