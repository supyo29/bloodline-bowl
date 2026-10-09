/**
 * Emits the versioned Role CHALLENGER spec for prospective (shadow) capture from the FROZEN DEV fit. NOT a certified production artifact:
 * status is SHADOW_ONLY. The Role-only contribution is the CENTERED effect of the Role features: the intercept and the baseline (regression-to-the-mean)
 * term of the offline fit are deliberately dropped, because they correct the PROXY baseline (not a Role effect) and would double-count source calibration.
 * Run: node --import tsx scripts/w2p1/emit-challenger-spec.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { preregSha, type RidgeModel } from "../lib/role-qualification";

const fz = JSON.parse(readFileSync("scripts/w2p1/FROZEN.json", "utf8")) as { models: Record<string, RidgeModel | null>; lambda: Record<string, number>; prereg_sha256: string };
if (fz.prereg_sha256 !== preregSha()) throw new Error("pre-registration changed after the freeze");
const final = JSON.parse(readFileSync("scripts/w2p1/results/final.json", "utf8")) as { verdict: string };
const positions: Record<string, unknown> = {};
for (const pos of ["QB", "RB", "WR", "TE"]) {
  const m = fz.models[`C2|${pos}|HALF`]; if (!m) continue;
  const role = m.features.map((f, i) => ({ f, i })).filter((x) => x.f !== "b0");
  positions[pos] = {
    scoring_fit: "HALF (0.5 PPR, 4pt pass TD, -2 INT/fumble lost); other scorings require their own frozen fit",
    ridge_lambda: m.lambda, n_fit: m.n_fit, training_period: "2025 REG weeks 3-9",
    role_features: role.map((x) => ({ feature: x.f, mean: m.mean[x.i], sd: m.sd[x.i], coefficient_per_sd: m.coef[x.i] })),
    contribution: "delta_role = confidence_weight * clamp(sum_k coefficient_k * (feature_k - mean_k) / sd_k, -cap, +cap); cap = max(1, 0.25 * conditional_active_points); confidence_weight MEDIUM 1 / LOW 0.6 / INSUFFICIENT 0",
    excluded_terms: ["intercept", "b0 (baseline regression-to-the-mean) term"],
  };
}
const spec = {
  model_id: "role-opportunity-challenger-2026.0", status: "SHADOW_ONLY — NOT CERTIFIED", offline_verdict: final.verdict,
  application: "ledger line ROLE_OPPORTUNITY, mode SHADOW; applied to conditional-on-active points BEFORE the Wave 1 injury model supplies availability exactly once; never alters asset/hold value, ROS or trade value",
  not_applicable: ["K", "DST"], missing_data: "neutral (no contribution), never zero, never stale", identity: "NFL gsis identity (provider-neutral); requires the canonical player's gsis identifier",
  prereg_sha256: fz.prereg_sha256, positions,
  required_before_any_promotion: ["Wave 1 staging certification", "prospective final-pregame Role challenger capture over completed real weeks", "G3: incremental value over the REAL Wave 1 canonical forecast", "five-league live validation"],
};
const text = JSON.stringify(spec, null, 1);
writeFileSync("scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json", text);
console.log("wrote scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json", createHash("sha256").update(text).digest("hex").slice(0, 16));
