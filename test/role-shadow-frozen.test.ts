/**
 * W2.P2 — frozen-model integrity. The challenger and the Role-free control must be EXACTLY what W2.P1 froze: file hashes, config hashes,
 * coefficients, feature definitions, shrinkage/cap constants. A silent edit must fail closed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { contentHash } from "../lib/bridge/hash";
import { ROLE_SHADOW_CONF_WEIGHT, ROLE_SHADOW_CAP_FLOOR_POINTS, ROLE_SHADOW_CAP_FRACTION } from "../lib/role-calibration/shadow";
import {
  C2_FULL_MODEL_ID, CHALLENGER_MODEL_ID, CONTROL_MODEL_ID, FROZEN_CAP_FLOOR_POINTS, FROZEN_CAP_FRACTION, FROZEN_CONF_WEIGHT, PINNED, SHADOW_POSITIONS,
  c2FullModel, challengerPositionSpec, configHashes, controlModel, knownModelVersions, verifyFrozenIntegrity,
} from "../lib/role-shadow/spec";
import { FEATURES } from "../scripts/lib/role-qualification";

const ROOT = process.cwd();
const sha = (rel: string) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");
const read = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

describe("frozen W2.P1 artifacts are unchanged in the working tree", () => {
  it("file-level SHA-256 equals the pinned values (candidate spec, FROZEN.json, pre-registration, harness, driver)", () => {
    assert.equal(sha("scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json"), PINNED.candidate_file_sha256);
    assert.equal(sha("scripts/w2p1/FROZEN.json"), PINNED.frozen_file_sha256);
    assert.equal(sha("scripts/w2p1/prereg.json"), PINNED.prereg_sha256);
    assert.equal(sha("scripts/lib/role-qualification.ts"), PINNED.harness_sha256);
    assert.equal(sha("scripts/role-qualification.ts"), PINNED.driver_sha256);
  });

  it("FROZEN.json itself records the same pre-registration / harness / driver hashes it was frozen against", () => {
    const fz = read("scripts/w2p1/FROZEN.json");
    assert.equal(fz.prereg_sha256, PINNED.prereg_sha256);
    assert.equal(fz.harness_sha256, PINNED.harness_sha256);
    assert.equal(fz.driver_sha256, PINNED.driver_sha256);
    assert.equal(read("scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json").prereg_sha256, PINNED.prereg_sha256);
  });
});

describe("runtime integrity (the check the capture job runs before any write)", () => {
  it("passes on the shipped configuration and the config hashes equal the pinned values", () => {
    const r = verifyFrozenIntegrity();
    assert.deepEqual(r.mismatches, []);
    assert.equal(r.ok, true);
    const h = configHashes();
    assert.equal(h.challenger, PINNED.challenger_config_hash);
    assert.equal(h.control, PINNED.control_config_hash);
    assert.equal(h.c2_full, PINNED.c2_full_config_hash);
  });

  it("model identities are the frozen ids and map to their pinned hashes (so a record of another version never validates as this one)", () => {
    assert.equal(CHALLENGER_MODEL_ID, "role-opportunity-challenger-2026.0");
    assert.equal(read("scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json").model_id, CHALLENGER_MODEL_ID);
    const k = knownModelVersions();
    assert.equal(k[CHALLENGER_MODEL_ID], PINNED.challenger_config_hash);
    assert.equal(k[CONTROL_MODEL_ID], PINNED.control_config_hash);
    assert.equal(k[C2_FULL_MODEL_ID], PINNED.c2_full_config_hash);
    assert.equal(new Set(Object.values(k)).size, 3, "three distinct configurations");
  });

  it("MUTATION: changing any single frozen coefficient, mean, sd or lambda changes the config hash (a silent edit cannot pass)", () => {
    const spec = read("scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json");
    const base = contentHash(spec).slice(0, 32);
    assert.equal(base, PINNED.challenger_config_hash);
    for (const pos of SHADOW_POSITIONS) {
      for (let i = 0; i < spec.positions[pos].role_features.length; i++) {
        for (const field of ["coefficient_per_sd", "mean", "sd"] as const) {
          const m = structuredClone(spec);
          m.positions[pos].role_features[i][field] += 1e-9;
          assert.notEqual(contentHash(m).slice(0, 32), base, `${pos}[${i}].${field}`);
        }
      }
      const m = structuredClone(spec);
      m.positions[pos].ridge_lambda += 1;
      assert.notEqual(contentHash(m).slice(0, 32), base);
    }
    const fz = read("scripts/w2p1/FROZEN.json");
    const ctlBase = configHashes().control;
    const alt = structuredClone(fz.models["C0|RB|HALF"]);
    alt.intercept += 1e-9;
    const mutated = Object.fromEntries(SHADOW_POSITIONS.map((p) => [p, p === "RB" ? alt : fz.models[`C0|${p}|HALF`]]));
    const orig = Object.fromEntries(SHADOW_POSITIONS.map((p) => [p, fz.models[`C0|${p}|HALF`]]));
    assert.equal(contentHash({ id: CONTROL_MODEL_ID, models: orig }).slice(0, 32), ctlBase);
    assert.notEqual(contentHash({ id: CONTROL_MODEL_ID, models: mutated }).slice(0, 32), ctlBase);
  });
});

describe("challenger and control are consistent with the frozen W2.P1 models", () => {
  it("the challenger spec IS the frozen full C2 minus exactly the intercept and the baseline (b0) term — same means, sds and coefficients", () => {
    for (const pos of SHADOW_POSITIONS) {
      const spec = challengerPositionSpec(pos)!;
      const full = c2FullModel(pos)!;
      assert.equal(spec.ridge_lambda, full.lambda, `${pos} lambda`);
      assert.equal(spec.n_fit, full.n_fit, `${pos} n_fit`);
      const roleOnly = full.features.filter((f) => f !== "b0");
      assert.deepEqual(spec.role_features.map((f) => f.feature), roleOnly, `${pos} feature set and order`);
      spec.role_features.forEach((f, i) => {
        assert.equal(f.mean, full.mean[i], `${pos}.${f.feature} mean`);
        assert.equal(f.sd, full.sd[i], `${pos}.${f.feature} sd`);
        assert.equal(f.coefficient_per_sd, full.coef[i], `${pos}.${f.feature} coef`);
      });
      assert.equal(full.features[full.features.length - 1], "b0", "the dropped term is the baseline term");
    }
  });

  it("the Role-free control is baseline-only (features = [b0]) for every position; no Role feature can reach it", () => {
    for (const pos of SHADOW_POSITIONS) assert.deepEqual(controlModel(pos)!.features, ["b0"]);
  });

  it("feature definitions equal the frozen harness's FEATURES table (challenger = harness list without b0)", () => {
    for (const pos of SHADOW_POSITIONS) {
      assert.deepEqual(challengerPositionSpec(pos)!.role_features.map((f) => f.feature), FEATURES[pos].filter((f) => f !== "b0"), pos);
      assert.deepEqual(c2FullModel(pos)!.features, [...FEATURES[pos]], pos);
    }
  });

  it("shrinkage and cap constants equal BOTH the spec text and the existing Role shadow convention (not re-tuned)", () => {
    assert.deepEqual(FROZEN_CONF_WEIGHT, { ...ROLE_SHADOW_CONF_WEIGHT });
    assert.equal(FROZEN_CAP_FRACTION, ROLE_SHADOW_CAP_FRACTION);
    assert.equal(FROZEN_CAP_FLOOR_POINTS, ROLE_SHADOW_CAP_FLOOR_POINTS);
    const spec = read("scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json");
    for (const pos of SHADOW_POSITIONS) {
      const text: string = spec.positions[pos].contribution;
      assert.match(text, /confidence_weight MEDIUM 1 \/ LOW 0\.6 \/ INSUFFICIENT 0/);
      assert.match(text, /cap = max\(1, 0\.25 \* conditional_active_points\)/);
      assert.deepEqual(spec.positions[pos].excluded_terms, ["intercept", "b0 (baseline regression-to-the-mean) term"]);
    }
    assert.match(spec.application, /BEFORE the Wave 1 injury model supplies availability exactly once/);
    assert.deepEqual(spec.not_applicable, ["K", "DST"]);
    assert.match(spec.missing_data, /neutral \(no contribution\), never zero, never stale/);
  });
});
