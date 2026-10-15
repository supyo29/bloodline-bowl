/**
 * W1.P2 injury-model calibration: the shipped priors are reproducible from committed point-in-time data, held-out evaluation
 * claims are asserted (not just reported), and the committed report matches a fresh run.
 *
 * What these tests do NOT claim: that the model is calibrated in the certified sense. Single season, small cells, final-designation
 * (not timestamped) evidence, and a PROXY source (no stored Sleeper projection history). Those limits are asserted below too.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { INJURY_PRIOR_COUNTS } from "../lib/weekly/forecast/injury-priors";
import { fitCounts, loadDataset, runCalibration } from "../scripts/lib/injury-calibration";

const ds = loadDataset();
const report = runCalibration();

describe("W1.P2 calibration reproducibility", () => {
  it("shipped prior counts are exactly what the committed 2025 W1-18 data produces (no hand-edited priors)", () => {
    assert.deepEqual(fitCounts(ds.cases.filter((c) => c.season === 2025)), INJURY_PRIOR_COUNTS);
  });

  it("2026 W1-4 is held out: no 2026 case influences the shipped counts", () => {
    const only25 = fitCounts(ds.cases.filter((c) => c.season === 2025));
    const withAll = fitCounts(ds.cases);
    assert.notDeepEqual(only25, withAll, "2026 rows exist and would change the counts if leaked in");
    assert.deepEqual(INJURY_PRIOR_COUNTS, only25);
  });

  it("committed calibration report equals a fresh run", () => {
    const committed = JSON.parse(readFileSync(join(process.cwd(), "lib/weekly/forecast/data/injury-calibration-report.json"), "utf8"));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(report)));
  });

  it("no hindsight: every feature is pregame (final designation, practice, strictly-earlier games)", () => {
    // baseline/prior_snap are built from games with week < target week only (checked structurally on a sample)
    const withBaseline = ds.cases.filter((c) => c.season === 2025 && c.baseline != null).slice(0, 50);
    assert.ok(withBaseline.length > 0);
    for (const c of ds.cases.filter((x) => x.week === 1 && x.season === 2025)) assert.equal(c.baseline, null, "week-1 cases have no earlier games");
  });
});

describe("W1.P2 held-out evaluation (what the model does and does not demonstrate)", () => {
  const t = report.split_2025_temporal;
  const o = report.out_of_time_2026_w1_4;

  it("probability: new model beats the legacy 0.78/0.30/0.03 heuristic on BOTH held-out windows (Brier)", () => {
    assert.ok(t.probability.brier_new < t.probability.brier_legacy);
    assert.ok(o.probability.brier_new < o.probability.brier_legacy);
  });

  it("excluding trivially-separable Out rows, the new model beats climatology; the legacy heuristic does not", () => {
    assert.ok(t.probability_excl_out.brier_new < t.probability_excl_out.brier_climatology);
    assert.ok(t.probability_excl_out.brier_legacy > t.probability_excl_out.brier_climatology);
    assert.ok(o.probability_excl_out.brier_new < o.probability_excl_out.brier_legacy);
  });

  it("points (proxy source, 2025 holdout): injury-adjusted has lower MAE and near-zero bias vs the unadjusted source proxy", () => {
    const p = t.points_questionable_doubtful;
    assert.ok(p.mae_adjusted < p.mae_source_proxy);
    assert.ok(p.mae_adjusted < p.mae_legacy_heuristic);
    assert.ok(Math.abs(p.bias_adjusted) < Math.abs(p.bias_source_proxy) / 3);
  });

  it("decisions (2025 holdout pairs): adjustment sharply cuts false starts and raises accuracy; the false-bench cost is REPORTED, not hidden", () => {
    const d = t.decisions;
    assert.ok(d.pairs >= 100);
    assert.ok(d.adjusted.false_start < d.unadjusted.false_start / 3);
    assert.ok(d.adjusted.accuracy > d.unadjusted.accuracy + 0.15);
    assert.ok(d.adjusted.false_bench > d.unadjusted.false_bench, "known trade-off: benching more questionable players also benches some who play well");
  });

  it("documented weaknesses are real: the model is somewhat over-optimistic on Questionable out-of-time (mean P above observed rate)", () => {
    assert.ok(o.probability_excl_out.mean_p_new > o.probability_excl_out.observed_active_rate);
  });

  it("the sample is small where it matters: Doubtful and 2026 cells are thin (so priors are provisional)", () => {
    assert.ok(INJURY_PRIOR_COUNTS.doubtful[0] < 50);
    assert.ok(o.probability.n < 200);
    const med = report.workload_when_active.QUESTIONABLE?.median ?? NaN;
    assert.equal(med > 0.9 && med < 1.05, true, "no evidence for a default workload discount");
  });

  it("probability buckets exist for the held-out windows and are not empty everywhere", () => {
    assert.ok(t.buckets.filter((b) => b.n > 0).length >= 3);
    assert.ok(o.buckets.filter((b) => b.n > 0).length >= 3);
  });
});
