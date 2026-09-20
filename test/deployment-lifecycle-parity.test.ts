/**
 * Phase 3.5B duplicate-interpretation guard: the deployment lifecycle state machine is implemented twice
 * (Start/Sit FI and Matchup Intelligence). Both are frozen shadow surfaces, so they are not refactored here; this
 * proves they can never diverge. One owner / many consumers is the eventual target.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEPLOYMENT_LIFECYCLE, isValidTransition, type DeploymentState } from "@/lib/weekly/start-sit-fi";
import { MATCHUP_LIFECYCLE, isValidMatchupTransition } from "@/lib/weekly/matchup-intelligence/deployment";
import type { MatchupDeploymentState } from "@/lib/weekly/matchup-intelligence/schema";

const STATES = [...DEPLOYMENT_LIFECYCLE, "CERTIFICATION_FAILED"] as const;

test("both lifecycles list the same five ordered states", () => {
  assert.deepEqual([...MATCHUP_LIFECYCLE], [...DEPLOYMENT_LIFECYCLE]);
  assert.deepEqual([...DEPLOYMENT_LIFECYCLE], ["SHADOW_ONLY", "RESEARCH_ELIGIBLE", "CERTIFICATION_PASSED", "PRODUCTION_ELIGIBLE", "PRODUCTION_ACTIVE"]);
});

test("the transition tables are identical over the full state matrix (no skipping, no auto-promotion, same failure edges)", () => {
  for (const from of STATES) for (const to of STATES) {
    assert.equal(
      isValidMatchupTransition(from as MatchupDeploymentState, to as MatchupDeploymentState),
      isValidTransition(from as DeploymentState, to as DeploymentState),
      `${from} -> ${to}`,
    );
  }
  // and the invariant they both encode: no state may be skipped forward
  for (const [from, to] of [["SHADOW_ONLY", "CERTIFICATION_PASSED"], ["SHADOW_ONLY", "PRODUCTION_ACTIVE"], ["RESEARCH_ELIGIBLE", "PRODUCTION_ELIGIBLE"], ["CERTIFICATION_PASSED", "PRODUCTION_ACTIVE"]] as const) {
    assert.equal(isValidTransition(from, to), false, `${from} -> ${to}`);
    assert.equal(isValidMatchupTransition(from as MatchupDeploymentState, to as MatchupDeploymentState), false);
  }
});
