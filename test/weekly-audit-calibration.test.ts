/**
 * Phase 9 Step 62 — calibration math, hand-computed fixtures.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { errorStats, rollingMean, assessDrift, calibrationByConfidence, bucketBy, STARTSIT_DIFFICULTY_BUCKETS } from "@/lib/weekly-audit/calibration";

describe("errorStats", () => {
  test("hand-computed: predicted [10,10,10], actual [12,8,10] -> errors [2,-2,0]", () => {
    const s = errorStats([{ predicted: 10, actual: 12 }, { predicted: 10, actual: 8 }, { predicted: 10, actual: 10 }])!;
    assert.equal(s.n, 3);
    assert.equal(s.mae, Math.round(((2 + 2 + 0) / 3) * 10_000) / 10_000);
    assert.equal(s.rmse, Math.round(Math.sqrt((4 + 4 + 0) / 3) * 10_000) / 10_000);
    assert.equal(s.signed_bias, 0);
  });
  test("empty input -> null, never NaN", () => { assert.equal(errorStats([]), null); });
});

describe("rollingMean", () => {
  test("takes the most recent N points regardless of input order", () => {
    const pts = [{ at: "2026-09-01", value: 10 }, { at: "2026-09-15", value: 30 }, { at: "2026-09-08", value: 20 }];
    assert.equal(rollingMean(pts, 2), (20 + 30) / 2);
    assert.equal(rollingMean(pts, 10), (10 + 20 + 30) / 3);
  });
  test("empty -> null", () => { assert.equal(rollingMean([], 4), null); });
});

describe("assessDrift", () => {
  test("within 2 SD of reference -> not drifting", () => { const d = assessDrift(5.2, 5, 0.5); assert.equal(d.drifting, false); });
  test("beyond 2 SD -> drifting, with a stated threshold and delta", () => { const d = assessDrift(7, 5, 0.5); assert.equal(d.drifting, true); assert.equal(d.delta, 2); });
  test("insufficient history (sd<=0) -> never flagged, honest reason given", () => { const d = assessDrift(100, 5, 0); assert.equal(d.drifting, false); assert.match(d.note, /insufficient history/); });
  test("a single noisy week alone cannot trigger drift without an established SD", () => { const d = assessDrift(5.01, 5, 0); assert.equal(d.drifting, false); });
});

describe("calibrationByConfidence", () => {
  test("reports mean |error| per confidence label; a row with no resolvable error is skipped, not zeroed", () => {
    const rows = [{ c: "HIGH", e: 1 }, { c: "HIGH", e: 3 }, { c: "LOW", e: 10 }, { c: "LOW", e: null }];
    const r = calibrationByConfidence(rows, (x) => x.c, (x) => x.e);
    assert.equal(r.HIGH!.n, 2); assert.equal(r.HIGH!.mean_abs_error, 2);
    assert.equal(r.LOW!.n, 1); assert.equal(r.LOW!.mean_abs_error, 10);
  });
});

describe("bucketBy / Start-Sit difficulty buckets", () => {
  test("|edge| routes into the correct pre-registered bucket", () => {
    const xs = [{ e: 0.5 }, { e: 1.5 }, { e: 4 }, { e: 20 }];
    const b = bucketBy(xs, (x) => x.e, STARTSIT_DIFFICULTY_BUCKETS as unknown as Array<{ label: string; max: number }>);
    assert.equal(b.very_close!.length, 1); assert.equal(b.close!.length, 1); assert.equal(b.moderate!.length, 1); assert.equal(b.obvious!.length, 1);
  });
});
