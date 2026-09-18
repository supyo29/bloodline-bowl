/**
 * Injury -> Opportunity Propagation Intelligence — deterministic formatter
 * (Phase 3, Checkpoint D, spec §42-43).
 *
 * Renders an already-computed `OpportunityPropagationScenarioResult` as
 * text. Does NOT do new analysis, does NOT decide who to add/start, and
 * MUST NOT contain any fantasy-actionability language -- enforced by an
 * executable test that greps this file's own output for the forbidden
 * vocabulary (spec §43): pick up, start, bench, waiver, FAAB, trade for,
 * must-add, handcuff.
 */

import type { OpportunityPropagationScenarioResult } from "./schema";

function pct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${(v * 100).toFixed(1)}%`;
}
function pp(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}pp`;
}

export function formatOpportunityPropagationScenario(result: OpportunityPropagationScenarioResult): string {
  const lines: string[] = [];
  const s = result.scenario;
  lines.push(`Scenario: IF ${s.unavailable_player_ids.join(", ")} unavailable for the full game (${s.team}, season ${s.season} week ${s.week})`);
  lines.push(`Support: ${s.support_level} -- ${s.support_note}`);
  lines.push("");

  if (s.support_level === "UNSUPPORTED_SCENARIO") {
    lines.push("This scenario is unsupported. No redistribution was computed.");
    return lines.join("\n");
  }

  const byAbsent = new Map<string, typeof result.vacated_role>();
  for (const v of result.vacated_role ?? []) {
    const list = byAbsent.get(v.absent_player_id) ?? [];
    list.push(v);
    byAbsent.set(v.absent_player_id, list);
  }

  for (const absentId of s.unavailable_player_ids) {
    lines.push(`-- ${absentId} --`);
    const vacatedRows = (result.vacated_role ?? []).filter((v) => v.absent_player_id === absentId);
    for (const v of vacatedRows) {
      lines.push(`Vacated ${v.domain}/${v.dimension}: ${pct(v.vacated_opportunity)}`);
      const benRows = (result.beneficiaries ?? [])
        .filter((b) => b.absent_player_id === absentId && b.domain === v.domain && b.dimension === v.dimension)
        .sort((a, b) => (b.expected_delta ?? 0) - (a.expected_delta ?? 0))
        .slice(0, 5);
      for (const b of benRows) {
        lines.push(`  ${b.beneficiary_gsis_id} (${b.beneficiary_position}): observed ${pct(b.observed_pre_scenario_role)}, expected ${pct(b.expected_scenario_role)}, delta ${pp(b.expected_delta)} [${b.confidence}, evidence=${b.evidence.source}:${b.evidence.evidence_count}]`);
      }
      const res = (result.residual ?? []).find((r) => r.absent_player_id === absentId && r.domain === v.domain && r.dimension === v.dimension);
      if (res) lines.push(`  Structural residual: ${pp(res.structural_residual)}`);
      lines.push("");
    }
  }

  lines.push(`opportunity_propagation_version: ${result.opportunity_propagation_version}`);
  lines.push(`role_opportunity_version: ${result.role_opportunity_version}`);
  return lines.join("\n");
}
