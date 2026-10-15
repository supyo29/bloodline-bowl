/** The exact set of files whose content is bound by FROZEN.json (research code, specs, results, scoring semantics, availability authority, Role candidate). Shared by the freezer and the integrity test. */
export const FROZEN_ARTIFACTS: string[] = [
  "scripts/w2r1/prereg.json", "scripts/w2r1/s4_spec.json", "scripts/w2r1/s5_spec.json", "scripts/w2r1/s6_spec.json", "scripts/w2r1/s7_protocol_adjudication.json", "scripts/w2r1/s4_regimes.json",
  "scripts/w2r1/s4_weights.R", "scripts/w2r1/s4_build.R", "scripts/w2r1/s4_fit_eval.R", "scripts/w2r1/s5_build.R", "scripts/w2r1/s5_run.ts", "scripts/w2r1/s6_build.R", "scripts/w2r1/s6_fit_eval.R", "scripts/w2r1/s6_kdst_spike.R", "scripts/w2r1/s7_kdst_coverage.R", "scripts/w2r1/s7_k_parity.R",
  "scripts/w2r1/results/s4_val.json", "scripts/w2r1/results/s4_golden.json", "scripts/w2r1/results/s5_val.json", "scripts/w2r1/results/s6_val.json", "scripts/w2r1/results/s6_kdst_spike.json", "scripts/w2r1/results/s7_kdst_coverage.json", "scripts/w2r1/results/s7_k_parity.json", "scripts/w2r1/results/s7_cap_bias_audit.json",
  "lib/w2r1/kdst.ts", "lib/w2r1/gameplan.ts", "lib/w2r1/breakout.ts", "lib/w2r1/vor.ts", "lib/w2r1/roster.ts", "lib/w2r1/evidence.ts", "lib/w2r1/adapter.ts",
  "lib/weekly/forecast/injury-model.ts", "lib/weekly/forecast/injury-priors.ts",
  "scripts/w2p1/FROZEN.json", "scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json",
];
