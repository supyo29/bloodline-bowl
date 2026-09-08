/**
 * Phase 5 — matchup-model deployment-state contract (Phase 4 pattern, spec §25).
 *
 * v1 state: SHADOW_ONLY. Production `buildMatchup` output is unchanged. No
 * auto-promotion: any future production activation must be an explicit,
 * versioned, human-reviewed change to `deployment_contract` in
 * `matchup_distribution_model.json` (or an equivalent served artifact).
 */
import type { MatchupDeploymentState } from "./schema";
import { loadDistributionModel } from "./distributions";

export const MATCHUP_LIFECYCLE: MatchupDeploymentState[] = [
  "SHADOW_ONLY",
  "RESEARCH_ELIGIBLE",
  "CERTIFICATION_PASSED",
  "PRODUCTION_ELIGIBLE",
  "PRODUCTION_ACTIVE",
];

export interface MatchupDeploymentContract {
  matchup_model_version: string;
  deployment: MatchupDeploymentState;
  activation_log: Array<{ state: MatchupDeploymentState; at: string; by: string; note: string }>;
}

export function matchupDeploymentContract(): MatchupDeploymentContract {
  const m = loadDistributionModel() as unknown as {
    matchup_model_version?: string;
    deployment?: string;
    deployment_contract?: MatchupDeploymentContract;
  } | null;
  if (m?.deployment_contract) return m.deployment_contract;
  return {
    matchup_model_version: m?.matchup_model_version ?? "unavailable",
    deployment: (m?.deployment as MatchupDeploymentState) ?? "SHADOW_ONLY",
    activation_log: [],
  };
}

/** Never true in v1 — matchup intelligence cannot influence a production recommendation. */
export function matchupMayInfluenceProduction(): boolean {
  return matchupDeploymentContract().deployment === "PRODUCTION_ACTIVE";
}

export function isValidMatchupTransition(from: MatchupDeploymentState, to: MatchupDeploymentState): boolean {
  if (to === "CERTIFICATION_FAILED") return from === "RESEARCH_ELIGIBLE" || from === "CERTIFICATION_PASSED";
  if (from === "CERTIFICATION_FAILED") return to === "SHADOW_ONLY" || to === "RESEARCH_ELIGIBLE";
  const fi = MATCHUP_LIFECYCLE.indexOf(from);
  const ti = MATCHUP_LIFECYCLE.indexOf(to);
  if (fi < 0 || ti < 0) return false;
  return ti === fi || ti === fi + 1 || ti < fi;
}
