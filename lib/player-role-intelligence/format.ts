/**
 * Player Role & Opportunity Intelligence — deterministic diagnostic
 * formatter (Checkpoint D spec §21-22).
 *
 * Renders ONLY existing structured fields -- never infers a new conclusion,
 * never adds a fantasy recommendation, never blends returns into offense.
 */

import type { PlayerRoleProfile, RoleChangeEvent, DimensionProfile } from "./schema";
import type { RoleOpportunityIntelligenceLineage } from "@/lib/canonical/lineage";

const pct = (v: number | null): string => (v == null ? "unavailable" : `${(v * 100).toFixed(1)}%`);

function formatDimension(label: string, dim: DimensionProfile | null | undefined): string[] {
  if (!dim) return [];
  const lines = [`${label}: ${dim.trend_latest_vs_recent} / ${dim.evidence_state}`];
  lines.push(`  latest: ${pct(dim.latest)}  recent: ${pct(dim.recent)}  season: ${pct(dim.season)}  prior: ${pct(dim.prior)}`);
  if (dim.discontinuity !== "NONE") lines.push(`  prior discontinuity: ${dim.discontinuity} (prior_role_confidence: ${dim.prior_role_confidence})`);
  lines.push(`  confidence: ${dim.confidence}  (${dim.n_games_season} game(s) this season, ${dim.opportunity_total} opportunities)`);
  return lines;
}

export function formatPlayerRoleProfile(profile: PlayerRoleProfile): string {
  const lines: string[] = [];
  lines.push(`Player: ${profile.identity.full_name} (${profile.identity.position}, ${profile.identity.team})`);
  lines.push(`As of: season ${profile.as_of.season}, week ${profile.as_of.through_week}`);
  lines.push(`Role: ${profile.role_state.role_level ?? "unavailable"} / ${profile.role_state.role_trend} / ${profile.role_state.evidence_state}`);
  lines.push("");

  lines.push(...formatDimension("Participation", profile.participation));
  if (profile.receiving) {
    lines.push("");
    lines.push(...formatDimension("Receiving opportunity (target share)", profile.receiving.target_share));
    if (profile.receiving.position_group_target_share) lines.push(...formatDimension("  Position-group target share", profile.receiving.position_group_target_share));
    lines.push(...formatDimension("  Air-yards share", profile.receiving.air_yards_share));
    if (profile.receiving.route_participation.evidence_state === "INSUFFICIENT_SAMPLE" && profile.receiving.route_participation.latest == null) {
      lines.push("  Routes: unavailable for current period");
    } else {
      lines.push(...formatDimension("  Route participation", profile.receiving.route_participation));
    }
    lines.push(`  Corroborating dimensions moving together: ${profile.receiving.corroboration_count}`);
  }
  if (profile.rushing) {
    lines.push("");
    lines.push(...formatDimension("Rushing opportunity", profile.rushing.rush_share));
    if (profile.rushing.position_group_rush_share) lines.push(...formatDimension("  Position-group rush share", profile.rushing.position_group_rush_share));
    lines.push(`  Corroborating dimensions moving together: ${profile.rushing.corroboration_count}`);
  }
  if (profile.high_value) {
    lines.push("");
    lines.push("High-value opportunity:");
    if (profile.high_value.rz_target_share) lines.push(...formatDimension("  Red-zone target share", profile.high_value.rz_target_share));
    if (profile.high_value.rz_carry_share) lines.push(...formatDimension("  Red-zone carry share", profile.high_value.rz_carry_share));
    lines.push(`  Goal-line carries (latest): ${profile.high_value.goal_line_carries_latest ?? "n/a"}`);
    lines.push(`  Third-down targets (latest): ${profile.high_value.third_down_targets_latest ?? "n/a"}`);
    lines.push(`  Two-minute targets (latest): ${profile.high_value.two_minute_targets_latest ?? "n/a"}`);
  }

  lines.push("");
  lines.push("Special-teams return role (kept separate from offense):");
  lines.push(...formatDimension("  Kickoff return", profile.returns.kick_return_role));
  lines.push(...formatDimension("  Punt return", profile.returns.punt_return_role));

  lines.push("");
  lines.push(`Route evidence: ${profile.source_availability.route_evidence}`);
  lines.push(`Schema version: ${profile.schema_version}`);
  return lines.join("\n");
}

export function formatRoleChangeEvent(event: RoleChangeEvent): string {
  return (
    `${event.full_name} (${event.domain}/${event.dimension}): ${event.trend}, ${event.evidence_state}, confidence ${event.confidence}\n` +
    `  latest ${pct(event.latest)} vs recent ${pct(event.baseline_recent)} (delta ${event.delta != null ? (event.delta * 100).toFixed(1) + "pp" : "n/a"})\n` +
    `  ${event.n_games_season} game(s) this season, ${event.opportunity_total} opportunities`
  );
}

export function formatRoleOpportunityLineage(lineage: RoleOpportunityIntelligenceLineage | null): string {
  if (!lineage) return "Role & Opportunity Intelligence: NOT_USED";
  const wc = lineage.week_completion;
  return (
    `Role & Opportunity Intelligence: ${lineage.version} (${lineage.model_tag})\n` +
    (wc ? `  week ${wc.latest_week} ${wc.week_state} (${wc.games_completed_in_latest_week}/${wc.games_scheduled_in_latest_week} games)\n` : "") +
    `  feature schema: ${lineage.feature_schema_version}, substrate schema: ${lineage.substrate_schema_version}`
  );
}
