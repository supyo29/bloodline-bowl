/**
 * W2.R1 S7: writes scripts/w2r1/FROZEN.json (the exact candidate set, artifacts and rules) + scripts/w2r1/FROZEN.sha256.
 * Run ONCE, after the S7 protocol adjudication is committed and BEFORE any 2026 final row is opened. Refuses to overwrite an existing FROZEN.json.
 * Does not read any 2026 data.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FROZEN_ARTIFACTS } from "./s7_freeze_artifacts";

if (existsSync("scripts/w2r1/FROZEN.json")) throw new Error("FROZEN.json already exists: the candidate set is frozen and must not be regenerated");
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const J = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
const prereg = J("scripts/w2r1/prereg.json"), s5v = J("scripts/w2r1/results/s5_val.json"), s6v = J("scripts/w2r1/results/s6_val.json"), cov = J("scripts/w2r1/results/s7_kdst_coverage.json"), regs = J("scripts/w2r1/s4_regimes.json").regimes;
const artifacts: Record<string, string> = Object.fromEntries(FROZEN_ARTIFACTS.map((p) => [p, sha(p)]));

const POS = ["QB", "RB", "WR", "TE"] as const;
const s5: unknown[] = [];
for (const pos of POS) { const P = s5v.positions[pos]; for (const c of ["RL", "G1", "G2"]) s5.push({ id: `S5.${pos}.${c}`, layer: "S5_forecast", position: pos, step: c, tactical_mode: c === "G2" ? P.chosen_tactical_mode : c === "RL" ? "CUR" : "CUR", lambda: P.candidates[c].lambda, val_cap_hit_rate: P.candidates[c].cap_hit_rate, retained_on_VAL: P.retained_chain.includes(c),
  final_status_ceiling: "DIAGNOSTIC_ONLY", reason: "preregistered cap gate (<=10%) already FAILED on VAL (14-44%); no bug found; REPORT-ONLY at final, cannot be SHADOW_QUALIFIED" }); }
const s6: unknown[] = POS.map((pos) => ({ id: `S6.${pos}.${s6v.positions[pos].last_retained}`, layer: "S6_upside_likelihood", position: pos, model: s6v.positions[pos].last_retained, retained_chain: s6v.positions[pos].retained_chain, val_verdict: s6v.positions[pos].verdict,
  final_status_ceiling: s6v.positions[pos].verdict === "VALIDATION CANDIDATE" ? "SHADOW_QUALIFIED_IF_ALL_PREREGISTERED_GATES_PASS_ON_FINAL" : s6v.positions[pos].verdict === "DIAGNOSTIC ONLY" ? "DIAGNOSTIC_ONLY" : "NO_RELIABLE_SIGNAL (base rate reported)" }));
const kdst: unknown[] = [];
for (const [rn, rg] of Object.entries(regs) as Array<[string, any]>) {
  kdst.push({ id: `S4.${rn}.DST`, layer: "S4_kdst", regime: rn, provider: rg.provider, slot: "DST", scoring_status: cov[rn].status, end_to_end_mean_abs_pts_error: cov[rn].end_to_end_mean_abs_pts_error, unknown_keys_bounded: cov[rn].unreconstructable_keys_mean_abs_pts,
    final_status_ceiling: cov[rn].status === "DIAGNOSTIC_ONLY" ? "DIAGNOSTIC_ONLY" : "SHADOW_QUALIFIED_IF_ALL_PREREGISTERED_GATES_PASS_ON_FINAL" });
  if (rg.has_K) kdst.push({ id: `S4.${rn}.K`, layer: "S4_kdst", regime: rn, provider: rg.provider, slot: "K", scoring_status: rg.provider === "sleeper" ? "KEY_COVERAGE_COMPLETE_AND_STATLINE_PARITY_VERIFIED_SLEEPER" : "KEY_COVERAGE_COMPLETE_STATLINE_PARITY_UNVERIFIED_YAHOO",
    final_status_ceiling: rg.provider === "sleeper" ? "SHADOW_QUALIFIED_IF_ALL_PREREGISTERED_GATES_PASS_ON_FINAL" : "DIAGNOSTIC_ONLY" });
}
const frozen = {
  frozen_version: "w2r1-s7-frozen-1", frozen_at_stage: "S7_PRE_FINAL", final_set_status_at_freeze: "UNOPENED",
  source_commit: execSync("git rev-parse HEAD").toString().trim(), source_branch: execSync("git rev-parse --abbrev-ref HEAD").toString().trim(),
  prereg_sha256: sha("scripts/w2r1/prereg.json"), s4_spec_sha256: sha("scripts/w2r1/s4_spec.json"), s5_spec_sha256: sha("scripts/w2r1/s5_spec.json"), s6_spec_sha256: sha("scripts/w2r1/s6_spec.json"), s7_adjudication_sha256: sha("scripts/w2r1/s7_protocol_adjudication.json"),
  artifacts_sha256: artifacts,
  availability: { authority: "lib/weekly/forecast/injury-model.ts :: evaluateInjuryModel", model_version: "injury-expected-value-2026.1", applied_exactly_once: true, source_semantics: "CONDITIONAL_ON_ACTIVE", proof: "scripts/w2r1/results/s7_cap_bias_audit.json (availability_once_proof) + test/w2r1-freeze.test.ts" },
  role_candidate: { id: "W2.P1 role-opportunity-challenger-2026.0 (C2)", file: "scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json", w2p1_frozen: "scripts/w2p1/FROZEN.json" },
  splits: { FIT: "2022-2024", VAL: "2025 wk 3-17", FINAL: "2026 wk 1-5 (completed games), evaluated exactly once", PROSPECTIVE: "wk >= 6" },
  ladder: { S5: ["RL", "G1", "G2(CUR|MULTI|CONT)", "G2b", "G3", "G4"], S6: ["M0", "M1a", "M1b", "M1c", "M1d"], S4: ["components -> exact league scoring"] },
  thresholds: { source: "scripts/w2r1/prereg.json (UNCHANGED)", gates_forecast_G2: prereg.gates_forecast_G2, breakout_gates_B: prereg.breakout.gates_B, k_dst_gates: prereg.k_dst.gates, cap_rule: "cap = max(1, 0.25*B0p); cap-hit gate <= 10% (NOT tuned)", thresholds_changed: false },
  metric_labels: { original_confirmatory: "bias/MAE on ALL gate rows incl. actual==0 (preregistered T4)", pipeline_corrected_confirmatory: "NONE (not defensible)", conditional_on_play: "DIAGNOSTIC ONLY" },
  candidates: [...s5, ...s6, ...kdst],
  eligibility_rules: { final_rows: "completed 2026 wk 1-5 games; weeks 1-2 use prior-season evidence only and are reported separately", min_rows: "per prereg T1 / B1_n / k_dst N>=150 else INSUFFICIENT_FINAL_SAMPLE", scoring_regimes: Object.fromEntries(Object.entries(regs).map(([k, v]: [string, any]) => [k, v.provider])) },
  final_set_rules: "Opening any 2026 wk 1-5 outcome spends the final set: no refit / feature / threshold / cap / scoring-semantic change / candidate substitution. Post-open defects are reported, affected confirmatory results invalidated, reruns exploratory.",
  note_no_candidate_is_W2R1_qualified_before_S7: true,
};
writeFileSync("scripts/w2r1/FROZEN.json", JSON.stringify(frozen, null, 1) + "\n");
writeFileSync("scripts/w2r1/FROZEN.sha256", sha("scripts/w2r1/FROZEN.json") + "\n");
console.log("FROZEN.json sha256", sha("scripts/w2r1/FROZEN.json"), "candidates", frozen.candidates.length);
