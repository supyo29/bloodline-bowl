/**
 * Injury -> Opportunity Propagation Intelligence — scenario evaluation
 * (Phase 3, Checkpoint D). Library-access only, no HTTP endpoint (spec
 * §41, matching Phase 2's own precedent).
 *
 * Combines the served, frozen model (`read.ts`) with Phase 2's OWN
 * current Role Intelligence snapshot (never recalculated -- spec §13) to
 * answer: IF the specified RB/WR/TE player(s) are unavailable for a full
 * game, how is opportunity expected to redistribute? Conditional, never
 * probabilistic (spec §10) -- this function never estimates whether the
 * player will actually be unavailable.
 */

import type { PlayerRoleProfile, DimensionProfile } from "@/lib/player-role-intelligence/schema";
import { loadRoleOpportunitySnapshot, type RoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import { loadOpportunityPropagationModel } from "./read";
import { allocateHierarchical, type CandidateInput } from "./model";
import type {
  OpportunityPropagationModel,
  OpportunityPropagationScenarioRequest,
  OpportunityPropagationScenarioResult,
  VacatedDomainRole,
  BeneficiaryDomainPrediction,
  StructuralResidual,
  RoleDomain,
} from "./schema";

const BENEFICIARY_POSITIONS = new Set(["RB", "WR", "TE", "QB"]);
const SUPPORTED_ABSENT_POSITIONS = new Set(["RB", "WR", "TE"]);

/** dimension name -> the PlayerRoleProfile path Phase 2 already computed it under -- never recalculated (spec §13/§22). */
function getDimensionProfile(profile: PlayerRoleProfile, dimension: string): DimensionProfile | null {
  switch (dimension) {
    case "snap_share": return profile.participation;
    case "rush_share": return profile.rushing?.rush_share ?? null;
    case "position_group_rush_share": return profile.rushing?.position_group_rush_share ?? null;
    case "target_share": return profile.receiving?.target_share ?? null;
    case "position_group_target_share": return profile.receiving?.position_group_target_share ?? null;
    case "air_yards_share": return profile.receiving?.air_yards_share ?? null;
    case "rz_carry_share": return profile.high_value?.rz_carry_share ?? null;
    case "rz_target_share": return profile.high_value?.rz_target_share ?? null;
    case "kick_return_role": return profile.returns.kick_return_role;
    case "punt_return_role": return profile.returns.punt_return_role;
    default: return null;
  }
}

function unsupportedResult(
  request: OpportunityPropagationScenarioRequest,
  model: OpportunityPropagationModel,
  roi: RoleOpportunitySnapshot,
  note: string,
): OpportunityPropagationScenarioResult {
  return {
    scenario: {
      team: request.team, season: request.season, week: request.week,
      unavailable_player_ids: request.unavailable_player_ids, scenario_type: request.scenario_type,
      support_level: "UNSUPPORTED_SCENARIO", support_note: note, availability_scenario_source: "CONSUMER_SUPPLIED",
    },
    vacated_role: null, beneficiaries: null, residual: null,
    opportunity_propagation_version: model.manifest.opportunity_propagation_version,
    role_opportunity_version: roi.manifest.role_opportunity_version,
  };
}

/**
 * Evaluates a Full-Game-Nonparticipation scenario. Returns `null` only
 * when the served model or the current Role Intelligence snapshot is
 * unavailable at all (honest degradation, matching `loadRoleOpportunitySnapshot()`'s
 * own null convention) -- an unsupported/unknown SCENARIO (QB, unknown
 * player) returns a typed `UNSUPPORTED_SCENARIO` result, never `null` and
 * never a thrown error, so a caller can render it explicitly (spec §9).
 */
export function evaluateOpportunityPropagationScenario(
  request: OpportunityPropagationScenarioRequest,
): OpportunityPropagationScenarioResult | null {
  if (request.scenario_type !== "FULL_GAME_NONPARTICIPATION") return null;

  const model = loadOpportunityPropagationModel();
  const roi = loadRoleOpportunitySnapshot();
  if (!model || !roi) return null;

  // Missing-current-observation != historical latest (spec §44): we only
  // ever read `.recent`/`.season` from the CURRENT snapshot; if a player
  // has no current profile at all, that is reported as an unknown player,
  // never silently backfilled from some other season's data.
  const absentProfiles = request.unavailable_player_ids.map((id) => ({ id, profile: roi.getPlayerRoleProfile({ gsis_id: id }) }));
  const unknown = absentProfiles.find((p) => !p.profile);
  if (unknown) return unsupportedResult(request, model, roi, `unavailable_player_id ${unknown.id} has no current Role Intelligence profile -- unknown player`);

  const qb = absentProfiles.find((p) => p.profile!.identity.position === "QB");
  if (qb) return unsupportedResult(request, model, roi, `QB (${qb.id}) is an explicitly UNSUPPORTED_SCENARIO trigger position -- never routed through skill-position propagation (spec §9/§57)`);

  const unsupportedPosition = absentProfiles.find((p) => !SUPPORTED_ABSENT_POSITIONS.has(p.profile!.identity.position));
  if (unsupportedPosition) {
    return unsupportedResult(request, model, roi, `position ${unsupportedPosition.profile!.identity.position} is not a supported absent-player trigger position (RB/WR/TE only)`);
  }

  const supportLevel = request.unavailable_player_ids.length === 1 ? "CALIBRATED" : "EXPERIMENTAL_MULTI_ABSENCE";
  const supportNote = supportLevel === "CALIBRATED"
    ? "single-absence: Checkpoint C's primary calibrated use case"
    : "multi-absence: Checkpoint C found materially weaker performance than single-absence, and a simple next-man-up baseline beat this model specifically on multi-absence top-beneficiary accuracy. Each unavailable player's vacated share is still allocated by the SAME selected hierarchical model (no invisible model switching, spec §21), independently against the shared candidate pool -- never jointly re-solved, never summed as if independent single-absence scenarios. Treat as experimental, not calibrated.";

  const unavailableSet = new Set(request.unavailable_player_ids);
  const candidateProfiles = request.candidate_player_ids
    ? request.candidate_player_ids.map((id) => roi.getPlayerRoleProfile({ gsis_id: id })).filter((p): p is PlayerRoleProfile => p != null)
    : roi.profiles.filter((p) => p.identity.team === request.team && BENEFICIARY_POSITIONS.has(p.identity.position) && !unavailableSet.has(p.identity.gsis_id));

  const vacated_role: VacatedDomainRole[] = [];
  const beneficiaries: BeneficiaryDomainPrediction[] = [];
  const residual: StructuralResidual[] = [];

  for (const { id: absentId, profile: absentProfile } of absentProfiles) {
    const absentPosition = absentProfile!.identity.position;
    const applicableDims = model.dimensions.filter((d) => (d.positions as string[]).includes(absentPosition));

    for (const d of applicableDims) {
      const absentDim = getDimensionProfile(absentProfile!, d.dimension);
      const vacatedOpportunity = absentDim?.recent ?? null;
      vacated_role.push({ absent_player_id: absentId, domain: d.domain as RoleDomain, dimension: d.dimension, vacated_opportunity: vacatedOpportunity });

      const eligible = candidateProfiles.filter((p) => (d.positions as string[]).includes(p.identity.position));
      const candidateInputs: CandidateInput[] = eligible.map((p) => {
        const dim = getDimensionProfile(p, d.dimension);
        return { gsis_id: p.identity.gsis_id, position: p.identity.position, pre_event_recent: dim?.recent ?? null, pre_event_season: dim?.season ?? null };
      });

      const preds = allocateHierarchical(model, request.team, absentPosition, d.dimension, vacatedOpportunity, candidateInputs);
      const identifiedGain = preds.reduce((s, p) => s + Math.max(p.predicted_delta, 0), 0);
      residual.push({
        absent_player_id: absentId, domain: d.domain as RoleDomain, dimension: d.dimension,
        structural_residual: (vacatedOpportunity ?? 0) - identifiedGain,
      });

      for (const p of preds) {
        beneficiaries.push({
          absent_player_id: absentId, domain: d.domain as RoleDomain, dimension: d.dimension,
          beneficiary_gsis_id: p.gsis_id, beneficiary_position: p.position,
          observed_pre_scenario_role: p.pre_event_role, expected_scenario_role: p.predicted_role, expected_delta: p.predicted_delta,
          confidence: p.evidence.evidence_count >= 8 ? "LOW" : "INSUFFICIENT_EVIDENCE",
          evidence: p.evidence,
          trace: p.trace,
        });
      }
    }
  }

  return {
    scenario: {
      team: request.team, season: request.season, week: request.week,
      unavailable_player_ids: request.unavailable_player_ids, scenario_type: request.scenario_type,
      support_level: supportLevel, support_note: supportNote, availability_scenario_source: "CONSUMER_SUPPLIED",
    },
    vacated_role, beneficiaries, residual,
    opportunity_propagation_version: model.manifest.opportunity_propagation_version,
    role_opportunity_version: roi.manifest.role_opportunity_version,
  };
}
