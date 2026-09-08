/**
 * Phase 4 remediation Part A — explicit deployment-state contract.
 *
 * Production Start/Sit is frozen at MAX_EXPECTED over the existing weekly
 * projection. A Football-Intelligence numeric contribution may reach a
 * production recommendation (start/sit, lineup, waiver, matchup, trade) ONLY
 * when this contract says a specific position is `PRODUCTION_ACTIVE` — which
 * requires an explicit, human-reviewed, versioned config change. No research
 * verdict flips it automatically (spec: "No auto-promotion").
 *
 * The guard here is the single checkpoint: absence of imports/call-sites is
 * NOT relied on.
 */

import type { StartSitModel } from "./translate";

/** Lifecycle a Start/Sit model candidate moves through (no state may be skipped). */
export const DEPLOYMENT_LIFECYCLE = [
  "SHADOW_ONLY",
  "RESEARCH_ELIGIBLE",
  "CERTIFICATION_PASSED",
  "PRODUCTION_ELIGIBLE",
  "PRODUCTION_ACTIVE",
] as const;
export type DeploymentState =
  | (typeof DEPLOYMENT_LIFECYCLE)[number]
  | "CERTIFICATION_FAILED";

export type PositionDeploymentState = DeploymentState;

/** The only state in which FI numerically influences a production recommendation. */
export const PRODUCTION_INFLUENCE_STATE: DeploymentState = "PRODUCTION_ACTIVE";

export interface DeploymentContract {
  model_version: string;
  /** whole-model deployment state. */
  deployment: DeploymentState;
  /**
   * per-position override. A position not listed inherits `deployment`.
   * Even a `PRODUCTION_ELIGIBLE` position does NOT influence production — only
   * `PRODUCTION_ACTIVE` does, and that is set exclusively by an explicit
   * human deployment step recorded here.
   */
  positions: Partial<Record<string, PositionDeploymentState>>;
  /** who/when a position was last explicitly activated for production. */
  activation_log: Array<{
    position: string;
    state: DeploymentState;
    at: string;
    by: string;
    note: string;
  }>;
}

/** Derive the deployment contract from the served model. Defaults to SHADOW_ONLY. */
export function deploymentContract(model: StartSitModel | null): DeploymentContract {
  const raw = (model as unknown as { deployment_contract?: DeploymentContract })?.deployment_contract;
  if (raw && typeof raw.deployment === "string") return raw;
  return {
    model_version: model?.start_sit_model_version ?? "unavailable",
    deployment: (model?.deployment ?? "SHADOW_ONLY") as DeploymentState,
    positions: {},
    activation_log: [],
  };
}

/** effective state for one position. */
export function positionDeploymentState(
  contract: DeploymentContract,
  position: string,
): DeploymentState {
  return contract.positions[position] ?? contract.deployment;
}

/**
 * THE production guard. Returns true only when this position is explicitly
 * `PRODUCTION_ACTIVE`. Every production code path that could consume an
 * FI-adjusted projection MUST gate on this. Today it always returns false
 * (nothing is PRODUCTION_ACTIVE).
 */
export function fiMayInfluenceProduction(
  model: StartSitModel | null,
  position: string,
): boolean {
  const c = deploymentContract(model);
  if (c.deployment === "CERTIFICATION_FAILED") return false;
  return positionDeploymentState(c, position) === PRODUCTION_INFLUENCE_STATE;
}

/** true if the FI shadow path is allowed to influence ANY production recommendation. */
export function anyFiProductionInfluence(model: StartSitModel | null): boolean {
  const c = deploymentContract(model);
  if (positionDeploymentState({ ...c, positions: {} }, "__whole__") === PRODUCTION_INFLUENCE_STATE)
    return true;
  return Object.values(c.positions).some((s) => s === PRODUCTION_INFLUENCE_STATE);
}

/** validate a proposed lifecycle transition — no state may be skipped. */
export function isValidTransition(from: DeploymentState, to: DeploymentState): boolean {
  if (to === "CERTIFICATION_FAILED") return from === "RESEARCH_ELIGIBLE" || from === "CERTIFICATION_PASSED";
  if (from === "CERTIFICATION_FAILED") return to === "SHADOW_ONLY" || to === "RESEARCH_ELIGIBLE";
  const fi = DEPLOYMENT_LIFECYCLE.indexOf(from as (typeof DEPLOYMENT_LIFECYCLE)[number]);
  const ti = DEPLOYMENT_LIFECYCLE.indexOf(to as (typeof DEPLOYMENT_LIFECYCLE)[number]);
  if (fi < 0 || ti < 0) return false;
  return ti === fi || ti === fi + 1 || ti < fi; // advance one step, hold, or roll back
}
