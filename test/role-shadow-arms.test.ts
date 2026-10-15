/**
 * W2.P2 — arms: challenger / Role-free control / diagnostic full-C2.
 * Verified against (a) the FROZEN W2.P1 harness (`c2Of`), (b) the REAL production injury model, and (c) hand arithmetic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeArms, roleFeatures, IDENTITY_TOLERANCE, type ArmsInput, type InjuryEvidenceRecord } from "../lib/role-shadow/arms";
import { FROZEN_CONF_WEIGHT, SHADOW_POSITIONS, c2FullModel, challengerPositionSpec, controlModel, type RoleConfidence, type ShadowPosition } from "../lib/role-shadow/spec";
import { lcg } from "../lib/role-shadow/stats";
import { evaluateInjuryModel, type SourceInjurySemantics } from "../lib/weekly/forecast/injury-model";
import { c2Of, type RidgeModel, type Row } from "../scripts/lib/role-qualification";
import { roleForecast } from "./fixtures/role-shadow";

type Practice = "FULL" | "LIMITED" | "DNP";

/** A champion produced by the REAL production injury model for a source value. */
function champ(pos: ShadowPosition, src: number, status: string | null, practice?: Practice, semantics: SourceInjurySemantics = "CONDITIONAL_ON_ACTIVE") {
  const evidence: InjuryEvidenceRecord = {
    source_status: status, position: pos, source_points: src, source_semantics: semantics, practice: practice ?? null, official_inactive: null, official_active: null,
    returning_from_injury: null, role_tier: null, expected_workload: null, observed_at: null, mode: "PRODUCTION",
  };
  const m = evaluateInjuryModel({ ...evidence });
  return { evidence, cond: m.conditional_active_points, expected: m.injury_adjusted_expected_points, p: m.probability_active, lambda: m.embedded_fraction_assumed, unavailable: m.availability_state === "UNAVAILABLE" };
}
const base = (pos: ShadowPosition, features: Record<string, number | null>, confidence: RoleConfidence, c: ReturnType<typeof champ>): ArmsInput => ({
  position: pos, role: { confidence, features }, conditional_active_points: c.cond, expected_points: c.expected, probability_active: c.p, embedded_fraction: c.lambda, injury: c.evidence, unavailable: c.unavailable,
});
const featuresAt = (pos: ShadowPosition, scale: number): Record<string, number | null> => {
  const full = c2FullModel(pos)!;
  const f: Record<string, number | null> = {};
  full.features.forEach((x, i) => { if (x !== "b0") f[x] = full.mean[i]! + scale * full.sd[i]!; });
  return f;
};

describe("parity with the frozen W2.P1 harness (c2Of): full-C2 and Role-free control arms", () => {
  it("2,000 randomized player-weeks across positions, designations, practice states and confidences: IDENTICAL delta and expected points", () => {
    const rnd = lcg(42);
    const statuses: Array<string | null> = [null, null, "Questionable", "Doubtful"];
    const practices: Array<Practice | undefined> = [undefined, "FULL", "LIMITED", "DNP"];
    const confs: RoleConfidence[] = ["MEDIUM", "LOW", "INSUFFICIENT_SAMPLE"];
    let compared = 0, applied = 0, capped = 0, flipped = 0;
    for (let n = 0; n < 2000; n++) {
      const pos = SHADOW_POSITIONS[Math.floor(rnd() * 4)]!;
      const b0 = Math.round((3 + rnd() * 20) * 100) / 100; // production conditional-active values are 0.01-rounded; the harness b0 is then identical
      const status = statuses[Math.floor(rnd() * statuses.length)]!;
      const practice = practices[Math.floor(rnd() * practices.length)];
      const conf = confs[Math.floor(rnd() * 3)]!;
      const feats = featuresAt(pos, (rnd() - 0.5) * 6); // up to +/- 3 sd: exercises the cap
      const c = champ(pos, b0, status, practice);
      if (c.unavailable) continue;
      const mine = computeArms(base(pos, feats, conf, c));
      assert.equal(mine.shared_state === "APPLIED" || mine.shared_state === "NEUTRAL_NOT_COVERED", true, mine.shared_state);

      const row = { b0: { HALF: b0 }, covered: conf !== "INSUFFICIENT_SAMPLE", designation: status === "Questionable" ? "QUESTIONABLE" : status === "Doubtful" ? "DOUBTFUL" : "NONE", x: feats, oracle: feats, conf, raw_status: status, position: pos, practice: practice ?? null } as unknown as Row;
      const full = c2Of(row, c2FullModel(pos) as unknown as RidgeModel, "HALF");
      const ctl = c2Of(row, controlModel(pos) as unknown as RidgeModel, "HALF");
      assert.ok(Math.abs(mine.c2_full.delta - full.delta) < 1e-3, `c2_full delta ${pos} ${mine.c2_full.delta} vs ${full.delta}`);
      assert.ok(Math.abs(mine.control.delta - ctl.delta) < 1e-3, `control delta ${pos} ${mine.control.delta} vs ${ctl.delta}`);
      assert.ok(Math.abs((mine.c2_full.expected_points ?? NaN) - full.expected) <= 0.011, `c2_full expected ${pos}/${status}/${practice}: ${mine.c2_full.expected_points} vs ${full.expected}`);
      assert.ok(Math.abs((mine.control.expected_points ?? NaN) - ctl.expected) <= 0.011, `control expected ${pos}/${status}/${practice}: ${mine.control.expected_points} vs ${ctl.expected}`);
      compared++;
      if (mine.c2_full.state === "APPLIED") { applied++; if (mine.c2_full.capped) capped++; if (mine.c2_full.p_active !== c.p) flipped++; }
    }
    assert.ok(compared > 1500 && applied > 800 && capped > 40, `coverage of the comparison: compared=${compared} applied=${applied} capped=${capped}`);
    assert.ok(flipped > 0, "the sweep reached the injury model's role-tier threshold at least once (otherwise this parity would not cover the non-linearity)");
  });
});

describe("availability is applied exactly once — by the production injury model, re-run on the adjusted value", () => {
  it("REGRESSION (found by the parity sweep): the injury model is NOT linear in the source value — a Role delta can cross the role-tier threshold and change P(active)", () => {
    // Questionable QB with a 7.9-point source is FRINGE-tier; +0.3 pushes it over RELEVANT_SOURCE_POINTS (8) and the participation prior changes.
    const c = champ("WR", 7.9, "Questionable", "LIMITED");
    const flipped = evaluateInjuryModel({ ...c.evidence, source_points: 8.2 });
    assert.notEqual(flipped.probability_active, c.p, "precondition: the threshold really changes P(active)");
    const out = computeArms(base("WR", featuresAt("WR", 1.5), "MEDIUM", c));
    assert.equal(out.shared_state, "APPLIED");
    assert.ok(out.challenger.delta > 0.2, `a delta large enough to cross the threshold (${out.challenger.delta})`);
    assert.notEqual(out.challenger.p_active, c.p, "the arm's P(active) reflects the re-run, not the champion's stale value");
    const direct = evaluateInjuryModel({ ...c.evidence, source_points: 7.9 + out.challenger.delta }).injury_adjusted_expected_points!;
    assert.ok(Math.abs(out.challenger.expected_points! - direct) <= 0.011);
    // the linear shortcut (champion + delta x P(active)) would have been wrong here — that is why the model is re-run
    const linear = c.expected! + out.challenger.delta * c.p!;
    assert.ok(Math.abs(linear - out.challenger.expected_points!) > 0.1, "linear shortcut differs materially from the faithful re-run");
  });

  for (const sem of ["CONDITIONAL_ON_ACTIVE", "UNKNOWN", "UNCONDITIONAL", "PARTIALLY_ADJUSTED"] as const) {
    it(`${sem} source semantics: re-run conditional-active = champion conditional + delta (the delta lands on the conditional value, whatever the semantics)`, () => {
      for (const [status, practice] of [["Questionable", "LIMITED"], ["Doubtful", "DNP"], [null, undefined]] as const) {
        const c = champ("RB", 14.2, status, practice, sem);
        if (c.cond == null) continue;
        const out = computeArms(base("RB", featuresAt("RB", 0.8), "MEDIUM", c));
        assert.equal(out.shared_state, "APPLIED", `${sem}/${status}`);
        const d = out.challenger.delta;
        const mS = 1 - (c.lambda ?? 0) * (1 - (c.p ?? 1));
        const rerun = evaluateInjuryModel({ ...c.evidence, source_points: 14.2 + d * mS });
        assert.ok(Math.abs((rerun.conditional_active_points ?? NaN) - (c.cond + d)) <= 0.011, `${sem}/${status}: conditional ${rerun.conditional_active_points} vs ${c.cond + d}`);
        assert.equal(out.challenger.expected_points, rerun.injury_adjusted_expected_points);
      }
    });
  }

  it("a delta of 0 reproduces the champion EXACTLY (not within rounding): neutral arms equal champion expected points", () => {
    const c = champ("WR", 9.37, "Questionable", "LIMITED");
    const n = computeArms(base("WR", featuresAt("WR", 1), "INSUFFICIENT_SAMPLE", c));
    for (const a of [n.challenger, n.control, n.c2_full]) { assert.equal(a.delta, 0); assert.equal(a.expected_points, c.expected); assert.equal(a.state, "NEUTRAL_NOT_COVERED"); }
  });
});

describe("challenger arithmetic (independent hand calculation)", () => {
  it("delta = confidence_weight x clamp(sum coef_k (x_k - mean_k)/sd_k, +/- max(1, 0.25 x conditional)); no intercept, no baseline term", () => {
    for (const pos of SHADOW_POSITIONS) {
      const spec = challengerPositionSpec(pos)!;
      for (const conf of ["MEDIUM", "LOW"] as const) {
        for (const scale of [-0.4, 0.3, 0.9]) {
          const feats = featuresAt(pos, scale);
          const c = champ(pos, 10, null);
          const raw = spec.role_features.reduce((s, f) => s + f.coefficient_per_sd * ((feats[f.feature]! - f.mean) / f.sd), 0);
          const cap = Math.max(1, 0.25 * 10);
          const want = Math.round(FROZEN_CONF_WEIGHT[conf] * Math.max(-cap, Math.min(cap, raw)) * 1e4) / 1e4;
          const got = computeArms(base(pos, feats, conf, c)).challenger;
          assert.equal(got.delta, want + 0, `${pos} ${conf} ${scale}`);
          assert.equal(got.capped, Math.abs(raw) > cap);
          assert.equal(got.expected_points, Math.round((10 + want) * 100) / 100, "healthy player: expected = conditional + delta (the production model returns 0.01-rounded points)");
        }
      }
    }
  });

  it("the cap binds: an extreme feature vector never moves a 10-point baseline by more than 2.5 (MEDIUM) / 1.5 (LOW); a tiny baseline keeps the 1.0 floor", () => {
    for (const pos of SHADOW_POSITIONS) for (const s of [-50, 50]) {
      const c = champ(pos, 10, null);
      const m = computeArms(base(pos, featuresAt(pos, s), "MEDIUM", c));
      const l = computeArms(base(pos, featuresAt(pos, s), "LOW", c));
      assert.ok(Math.abs(m.challenger.delta) <= 2.5 + 1e-9 && Math.abs(l.challenger.delta) <= 1.5 + 1e-9, `${pos} ${m.challenger.delta} ${l.challenger.delta}`);
      assert.ok(Math.abs(m.c2_full.delta) <= 2.5 + 1e-9 && Math.abs(m.control.delta) <= 2.5 + 1e-9);
    }
    const small = computeArms(base("WR", featuresAt("WR", 50), "MEDIUM", champ("WR", 3.2, null)));
    assert.ok(Math.abs(small.challenger.delta) <= 1 + 1e-9);
  });

  it("confidence weights: MEDIUM 1, LOW 0.6 (damped), INSUFFICIENT_SAMPLE neutral", () => {
    const c = champ("RB", 80, null); // large baseline so the cap never binds
    const f = featuresAt("RB", 0.7);
    const m = computeArms(base("RB", f, "MEDIUM", c)).challenger.delta;
    const l = computeArms(base("RB", f, "LOW", c)).challenger.delta;
    assert.ok(Math.abs(l - 0.6 * m) < 2e-4, `${l} vs ${0.6 * m}`);
    assert.equal(computeArms(base("RB", f, "INSUFFICIENT_SAMPLE", c)).challenger.state, "NEUTRAL_NOT_COVERED");
  });
});

describe("identical eligibility across control and challenger; fail-closed neutral states", () => {
  it("a missing Role feature neutralises ALL arms — the control may not apply where the challenger cannot (NEUTRAL, never 0-as-data)", () => {
    for (const pos of SHADOW_POSITIONS) {
      const f = featuresAt(pos, 0.5);
      f[challengerPositionSpec(pos)!.role_features[0]!.feature] = null;
      const c = champ(pos, 12, null);
      const o = computeArms(base(pos, f, "MEDIUM", c));
      assert.equal(o.shared_state, "NEUTRAL_MISSING_FEATURE");
      for (const a of [o.challenger, o.control, o.c2_full]) { assert.equal(a.state, "NEUTRAL_MISSING_FEATURE"); assert.equal(a.delta, 0); assert.equal(a.expected_points, 12); }
    }
  });

  it("known-unavailable (OUT / bye / no game): every arm contributes EXACTLY 0 and equals the champion", () => {
    const c = champ("RB", 14, "Out");
    assert.equal(c.unavailable, true);
    const o = computeArms(base("RB", featuresAt("RB", 2), "MEDIUM", c));
    for (const a of [o.challenger, o.control, o.c2_full]) { assert.equal(a.state, "NEUTRAL_UNAVAILABLE"); assert.equal(a.delta, 0); assert.equal(a.expected_points, 0); }
  });

  it("no baseline (null conditional or expected): neutral, expected stays null — never fabricated", () => {
    const c = champ("WR", 10, null);
    const o = computeArms({ ...base("WR", featuresAt("WR", 1), "MEDIUM", c), conditional_active_points: null, expected_points: null });
    assert.equal(o.shared_state, "NEUTRAL_NO_BASELINE");
    assert.equal(o.challenger.expected_points, null);
  });

  it("IDENTITY GUARD: if replaying the recorded injury evidence does not reproduce the champion exactly, every arm is neutral (fail closed)", () => {
    const c = champ("WR", 10, "Questionable", "LIMITED");
    for (const tweak of [{ expected_points: c.expected! + 0.5 }, { conditional_active_points: c.cond! + 0.4 }]) {
      const o = computeArms({ ...base("WR", featuresAt("WR", 1), "MEDIUM", c), ...tweak });
      assert.equal(o.shared_state, "NEUTRAL_IDENTITY_MISMATCH");
      assert.equal(o.challenger.delta, 0);
      assert.ok(IDENTITY_TOLERANCE < 1e-3);
    }
    // evidence the module does not know about (e.g. an extra production adjustment inside the value) is exactly this case
    const withFi = computeArms({ ...base("WR", featuresAt("WR", 1), "MEDIUM", c), expected_points: c.expected! + 1.25 });
    assert.equal(withFi.shared_state, "NEUTRAL_IDENTITY_MISMATCH");
    assert.ok(Math.abs(withFi.identity_residual! - 1.25) < 1e-6);
  });

  it("roleFeatures() maps a Role forecast exactly as the frozen harness does (expected opportunity incl. teammate pressure + as-of snap/air share)", () => {
    const f = roleFeatures(roleForecast({ position: "RB" }));
    assert.deepEqual(f, { exp_carries: 12.5, exp_targets: 3, exp_rz_carries: 2.1, exp_rz_targets: 0.4, exp_dropbacks: null, exp_designed_rushes: null, exp_scrambles: null, snap_share: 0.82, air_yards_share: 0.27 });
  });

  it("arms are a pure function of stored inputs: same input twice => byte-identical output; the input type has no outcome field", () => {
    const i = base("TE", featuresAt("TE", 0.6), "MEDIUM", champ("TE", 8.2, null));
    assert.equal(JSON.stringify(computeArms(i)), JSON.stringify(computeArms(structuredClone(i))));
    assert.deepEqual(Object.keys(i).sort(), ["conditional_active_points", "embedded_fraction", "expected_points", "injury", "position", "probability_active", "role", "unavailable"]);
  });
});
