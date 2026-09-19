/** Phase 3.5A Checkpoint D -- the dormant candidate-v2 registry is honest and cannot smuggle unsafe features in. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const reg = JSON.parse(readFileSync(join(ROOT, "analysis", "football_intel_startsit", "candidate_v2_feature_registry.json"), "utf8"));
const SAFE = new Set(["TRUE_AS_OF_HISTORY", "RECONSTRUCTABLE_AS_OF"]);

test("registry: dormant, no v2 artifact exists, served model is still 2026.1", () => {
  assert.equal(reg.status, "DORMANT_RESEARCH_ONLY");
  assert.equal(reg.candidate_artifact_generated, false);
  const served = JSON.parse(readFileSync(join(ROOT, "lib", "weekly", "data", "start_sit_model.json"), "utf8"));
  assert.equal(served.start_sit_model_version, "ri-startsit-2026.1");
  assert.ok(!existsSync(join(ROOT, "lib", "weekly", "data", "start_sit_model_2026.2.json")));
});

test("registry: every feature has a valid class; unsafe classes are never allowed in a historical backtest", () => {
  for (const f of reg.features) {
    assert.ok(reg.classes.includes(f.history_class), f.family);
    if (!SAFE.has(f.history_class)) assert.equal(f.historical_backtest_allowed, false, `${f.family} (${f.history_class}) must not be backtested`);
  }
});

test("registry: every 2026.1 family in config.R is classified", () => {
  const cfg = readFileSync(join(ROOT, "analysis", "football_intel_startsit", "config.R"), "utf8");
  const fams = [...cfg.matchAll(/^\s+"([a-z_]+)",\s+"(?:team_off|opp_def|player_usage|interaction|descriptive)"/gm)].map((m) => m[1]!);
  assert.ok(fams.length >= 15);
  const text = JSON.stringify(reg.features);
  for (const f of fams) {
    const key = f.replace(/^(off_|def_)/, "").replace(/^usage_/, "");
    assert.ok(text.includes(f) || text.includes(key.split("_")[0]!), `family ${f} missing from registry`);
  }
});

test("registry: Phase 3 opportunity propagation is conditional-only; captured baseline is the only production baseline", () => {
  const op = reg.features.find((f: { family: string }) => f.family.startsWith("opportunity_propagation"));
  assert.equal(op.history_class, "CONDITIONAL_SCENARIO_ONLY"); assert.equal(op.conditional_only, true);
  const sl = reg.features.find((f: { family: string }) => f.family === "baseline_sleeper_projection");
  assert.equal(sl.history_class, "REVISED_HISTORICAL");
  assert.match(reg.residual_target, /production_baseline/);
});

test("R model-write guard is present in every artifact writer", () => {
  for (const f of ["train.R", "backtest.R", "finalize_model.R"]) {
    assert.match(readFileSync(join(ROOT, "analysis", "football_intel_startsit", f), "utf8"), /guard_model_write\(\)/, f);
  }
});
