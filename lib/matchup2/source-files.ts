/** Phase 5 — file-backed MatchupSource over the certified readers (read-only, synchronous, Vercel-safe like the readers themselves). */
import { loadFootballIntelligence } from "@/lib/football-intel/read";
import { loadRoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import { loadPlayerSchemeIntelligence, resolvePlayer, defensePassMatrix, defenseRushProfile, defenseRushGap, defenseTeamProfile, offenseTeamProfile, schemeEra, receiverMatrix, qbMatrix, rbRushGap, rbRushMatrix, receiverCoverageProfile, receiverRouteProfile, qbCoverageProfile, qbPressureProfile, qbRusherCountProfile, rbBoxProfile, type ChartingSplitRow, type SpatialCellRow } from "@/lib/player-scheme-intelligence/read";
import { playerSchemeContentIdentity } from "@/lib/player-scheme-intelligence/query";
import { normalizeTeam } from "./stats";
import type { EvidenceTier, SourceVintage } from "./contract";
import type { CellRow, DefenseEvidence, FiRating, MatchupSource, OffenseEvidence, PlayerEvidence, RoleSummary, SplitRow } from "./source";

const tier = (v: unknown): EvidenceTier => (v === "STRONG" || v === "MODERATE" || v === "WEAK" ? v : "INSUFFICIENT");
const splits = (rows: ChartingSplitRow[]): SplitRow[] => rows.map((r) => ({ window: r.window, bucket: r.bucket, n: r.plays, values: r.values, evidence: tier(r.evidence_class) }));
const cells = (rows: SpatialCellRow[]): CellRow[] => rows.map((r) => ({ window: r.window, depth_bin: r.depth_bin, field_third: r.field_third, n: r.attempts, share: r.attempt_share, epa: r.epa_per_attempt, explosive: r.explosive_rate, success: r.success_rate, evidence: tier(r.evidence_class) }));
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rating = (r: { modeled: number | null; league_percentile: number | null; predictive_status?: string; confidence?: string } | undefined): FiRating | null => (r ? { modeled: r.modeled, league_percentile: r.league_percentile, predictive_status: r.predictive_status ?? null, confidence: r.confidence ?? null } : null);
const byWindow = <T extends { window?: unknown }>(rows: Array<Record<string, unknown>>): Record<string, T> => Object.fromEntries(rows.map((r) => [String(r.window), r as unknown as T]));

export function fileMatchupSource(opts: { scheduleOpponent?: (team: string, week: number) => string | null } = {}): MatchupSource {
  const psi = loadPlayerSchemeIntelligence(); const fi = loadFootballIntelligence(); const role = loadRoleOpportunitySnapshot();
  const roleSummary = (gsis: string, sleeper: string | null): RoleSummary | null => {
    const p = role?.getPlayerRoleProfile({ gsis_id: gsis, sleeper_id: sleeper }); if (!p) return null;
    return { target_share: p.receiving?.target_share.recent ?? p.receiving?.target_share.season ?? null, route_participation: p.receiving?.route_participation.recent ?? null, rush_share: p.rushing?.rush_share.recent ?? p.rushing?.rush_share.season ?? null, rz_target_share: p.high_value?.rz_target_share?.recent ?? null, rz_carry_share: p.high_value?.rz_carry_share?.recent ?? null, goal_line_carries: p.high_value?.goal_line_carries_latest ?? null, snap_share: p.participation?.recent ?? null, role_level: p.role_state.role_level ?? null, role_evidence: p.role_state.evidence_state ?? null, role_trend: p.role_state.role_trend ?? null, injury_status: null, through_week: p.as_of.through_week };
  };
  const teams = fi ? fi.teams().map((t) => t.team) : [];
  return {
    season: () => fi?.manifest.season ?? 2026,
    vintages: (): SourceVintage[] => [
      { source: "football-intelligence", version: fi?.manifest.football_intelligence_version ?? null, season: fi?.manifest.season ?? null, through_week: fi?.manifest.through_week ?? null, availability: fi ? "LIVE_CURRENT" : "UNAVAILABLE" },
      { source: "player-scheme", version: psi ? String((psi.manifest as { player_scheme_version?: string }).player_scheme_version ?? null) : null, season: psi ? Number((psi.manifest as { current_season?: number }).current_season ?? 0) || null : null, through_week: psi ? Number((psi.manifest as { as_of_week?: number }).as_of_week ?? 0) || null : null, availability: psi ? "PRIOR_ONLY" : "UNAVAILABLE" },
      { source: "role-opportunity", version: role?.manifest.role_opportunity_version ?? null, season: role?.manifest.season ?? null, through_week: role?.manifest.through_week ?? null, availability: role ? "LIVE_CURRENT" : "UNAVAILABLE" },
    ],
    resolvePlayer: (raw): PlayerEvidence | null => {
      const r = resolvePlayer(raw); const e = r.entry; if (!e) return null; const pos = (e.position ?? "").toUpperCase();
      return { gsis_id: e.gsis_id, name: e.full_name, position: pos || null, team: normalizeTeam(role?.getPlayerRoleProfile({ gsis_id: e.gsis_id, sleeper_id: e.sleeper_id })?.identity.team) ?? normalizeTeam(e.nfl_team),
        receiver_cells: cells(receiverMatrix(e.gsis_id)), qb_cells: cells(qbMatrix(e.gsis_id)),
        rb_direction: rbRushMatrix(e.gsis_id).map((c) => ({ window: c.window, field_third: c.field_third, n: c.attempts, share: c.attempt_share, epa: c.epa_per_attempt, explosive: c.explosive_rate, stuff: null, evidence: tier(c.evidence_class) })),
        rb_gap: rbRushGap(e.gsis_id).map((g) => ({ window: String(g.window), run_gap: String(g.run_gap), n: n(g.carries), epa: n(g.epa_per_rush), explosive: n(g.explosive_rate), stuff: n(g.stuff_rate), evidence: tier(g.evidence_class) })),
        receiver_coverage: splits(receiverCoverageProfile(e.gsis_id)), receiver_routes: splits(receiverRouteProfile(e.gsis_id)), qb_coverage: splits(qbCoverageProfile(e.gsis_id)), qb_pressure: splits(qbPressureProfile(e.gsis_id)), qb_rushers: splits(qbRusherCountProfile(e.gsis_id)), rb_box: splits(rbBoxProfile(e.gsis_id)),
        role: roleSummary(e.gsis_id, e.sleeper_id) };
    },
    defenseTeams: () => teams,
    defense: (team): DefenseEvidence | null => {
      const t = team.toUpperCase(); const wide = defenseTeamProfile(t); if (!wide.length && !defensePassMatrix(t).length) return null; const ft = fi?.team(t);
      const unit = fi?.coverageAllowed(t) ?? [];
      return { team: t, tendency: byWindow(wide), scheme_era: schemeEra(t),
        pass_cells: defensePassMatrix(t).map((c) => ({ window: c.window, depth_bin: c.depth_bin, field_third: c.field_third, targets: c.targets_allowed, share: c.target_share_allowed, epa: c.epa_per_target_allowed, explosive: c.explosive_rate_allowed, success: c.success_rate_allowed, td: c.td_rate_allowed, evidence: tier(c.evidence_class) })),
        rush_direction: defenseRushProfile(t).map((r) => ({ window: String(r.window), field_third: String(r.field_third), carries: n(r.carries_allowed), epa: n(r.epa_per_rush_allowed), explosive: n(r.explosive_rate_allowed), stuff: n(r.stuff_rate_generated), evidence: tier(r.evidence_class) })),
        rush_gap: defenseRushGap(t).map((r) => ({ window: String(r.window), run_gap: String(r.run_gap), carries: n(r.carries_allowed), epa: n(r.epa_per_rush_allowed), explosive: n(r.explosive_rate_allowed), evidence: tier(r.evidence_class) })),
        fi_defense: Object.fromEntries(Object.entries(ft?.defense ?? {}).map(([k, v]) => [k, rating(v)!])),
        fi_unit_coverage: { RB: rating(unit.find((u) => u.position === "RB")), WR: rating(unit.find((u) => u.position === "WR")), TE: rating(unit.find((u) => u.position === "TE")) } };
    },
    offense: (team): OffenseEvidence | null => { const t = team.toUpperCase(); const wide = offenseTeamProfile(t); const ft = fi?.team(t); if (!wide.length && !ft) return null; return { team: t, tendency: byWindow(wide), scheme_era: schemeEra(t), fi_offense: Object.fromEntries(Object.entries(ft?.offense ?? {}).map(([k, v]) => [k, rating(v)!])) }; },
    opponent: (team, week) => opts.scheduleOpponent?.(team.toUpperCase(), week) ?? null,
    contextual: (feature, off, def) => { if (!fi) return null; const r = fi.contextualMatchup(feature, off ?? "", def) as { availability?: string; offense_rating?: number | null; defense_rating?: number | null; interaction_signal?: number | null; predictive_status?: string | null; confidence?: string | null }; return r.availability === "NOT_AVAILABLE" ? null : { offense_rating: r.offense_rating ?? null, defense_rating: r.defense_rating ?? null, interaction_signal: r.interaction_signal ?? null, predictive_status: r.predictive_status ?? null, confidence: r.confidence ?? null }; },
    identities: () => ({ player_scheme: psi ? playerSchemeContentIdentity(psi.manifest).served_content_id : null, fi: fi?.manifest.football_intelligence_version ?? null, role: role?.manifest.role_opportunity_version ?? null, opp: null }),
  };
}
