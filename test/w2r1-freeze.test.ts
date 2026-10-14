import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { PREREG_IMMUTABLE_SHA256, verifyFrozen } from "../scripts/w2r1/s7_verify_frozen";
import { FROZEN_ARTIFACTS } from "../scripts/w2r1/s7_freeze_artifacts";

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("W2.R1 S7 freeze integrity (every artifact bound by FROZEN.json has its expected hash before final scoring can run)", () => {
  it("prereg.json is the immutable preregistration", () => { assert.equal(sha("scripts/w2r1/prereg.json"), PREREG_IMMUTABLE_SHA256); });
  it("every frozen artifact exists", () => { for (const p of FROZEN_ARTIFACTS) assert.ok(existsSync(p), p); });
  it("FROZEN.json (when present) is intact: every referenced artifact hash, spec hash, adjudication hash and FROZEN.sha256 match", () => {
    if (!existsSync("scripts/w2r1/FROZEN.json")) return; // pre-freeze state
    assert.deepEqual(verifyFrozen("."), []);
  });
  it("the verifier DETECTS a tampered artifact, a missing artifact, a tampered FROZEN.json and a changed prereg (run on a scratch copy)", () => {
    if (!existsSync("scripts/w2r1/FROZEN.json")) return;
    const files = [...FROZEN_ARTIFACTS, "scripts/w2r1/FROZEN.json", "scripts/w2r1/FROZEN.sha256"];
    const mk = () => { const d = mkdtempSync(join(tmpdir(), "frozen-")); for (const p of files) { mkdirSync(dirname(join(d, p)), { recursive: true }); cpSync(p, join(d, p)); } return d; };
    assert.deepEqual(verifyFrozen(mk()), []);
    let d = mk(); writeFileSync(join(d, "scripts/w2r1/s4_weights.R"), readFileSync("scripts/w2r1/s4_weights.R", "utf8") + "\n# tamper\n"); assert.ok(verifyFrozen(d).some((x) => x.includes("hash mismatch scripts/w2r1/s4_weights.R")));
    d = mk(); writeFileSync(join(d, "lib/w2r1/kdst.ts"), readFileSync("lib/w2r1/kdst.ts", "utf8") + "\n// tamper\n"); assert.ok(verifyFrozen(d).some((x) => x.includes("hash mismatch lib/w2r1/kdst.ts")));
    d = mk(); writeFileSync(join(d, "scripts/w2r1/FROZEN.json"), readFileSync("scripts/w2r1/FROZEN.json", "utf8").replace("UNOPENED", "OPENED")); assert.ok(verifyFrozen(d).some((x) => x.includes("FROZEN.sha256")));
    d = mk(); writeFileSync(join(d, "scripts/w2r1/prereg.json"), readFileSync("scripts/w2r1/prereg.json", "utf8") + " "); assert.ok(verifyFrozen(d).length > 0);
    d = mk(); writeFileSync(join(d, "scripts/w2r1/s7_protocol_adjudication.json"), readFileSync("scripts/w2r1/s7_protocol_adjudication.json", "utf8") + " "); assert.ok(verifyFrozen(d).length > 0);
  });
  it("thresholds in FROZEN.json are byte-equal to the preregistration (no threshold changed)", () => {
    if (!existsSync("scripts/w2r1/FROZEN.json")) return;
    const f = JSON.parse(readFileSync("scripts/w2r1/FROZEN.json", "utf8")); const p = JSON.parse(readFileSync("scripts/w2r1/prereg.json", "utf8"));
    assert.deepEqual(f.thresholds.gates_forecast_G2, p.gates_forecast_G2); assert.deepEqual(f.thresholds.breakout_gates_B, p.breakout.gates_B); assert.deepEqual(f.thresholds.k_dst_gates, p.k_dst.gates); assert.equal(f.thresholds.thresholds_changed, false);
  });
  it("the S5 harness applies canonical availability EXACTLY ONCE: one evaluateInjuryModel call site, delta added BEFORE it, never nested", () => {
    const src = readFileSync("scripts/w2r1/s5_run.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only (comments stripped)
    assert.equal((src.match(/evaluateInjuryModel\(/g) ?? []).length, 1, "single call site");
    assert.ok(/const inj = \(r: Row, source: number\): number => evaluateInjuryModel\(/.test(src));
    assert.ok(src.includes("expected: inj(r, b0 + delta)"), "delta enters the SINGLE availability application");
    const predictBody = src.slice(src.indexOf("function predict("), src.indexOf("const mae = "));
    assert.equal((predictBody.match(/inj\(/g) ?? []).length, 2, "predict: neutral path + corrected path only"); assert.ok(!/inj\(\s*inj\(/.test(predictBody));
  });
  it("the research builders never load 2026 outcomes", () => {
    assert.ok(/seasons <- 2022:2025/.test(readFileSync("scripts/w2r1/s4_build.R", "utf8")));
    assert.ok(readFileSync("scripts/w2r1/s5_run.ts", "utf8").includes("S5 must not load FINAL data"));
  });
});
