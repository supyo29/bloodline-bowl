/** Phase 5 — synthetic MatchupSource: 32 deterministic defenses + configurable players (no files, no network). */
import type { EvidenceTier, SourceVintage } from "@/lib/matchup2/contract";
import type { DefenseEvidence, FiRating, MatchupSource, OffenseEvidence, PlayerEvidence, Row, SplitRow, CellRow } from "@/lib/matchup2/source";

export const TEAMS = Array.from({ length: 32 }, (_, i) => `T${String(i).padStart(2, "0")}`);
const DEPTHS = ["BEHIND_LOS", "SHORT", "INTERMEDIATE", "DEEP"]; const THIRDS = ["LEFT", "MIDDLE", "RIGHT"];
const fi = (m: number, pct: number, ps = "PREDICTIVE"): FiRating => ({ modeled: m, league_percentile: pct, predictive_status: ps, confidence: "MEDIUM" });

export interface DefSpec { man?: number; pressure?: number; blitz?: number; heavy_box?: number; deepEpa?: number; shortEpa?: number; runMid?: number; runEnd?: number; explDeep?: number; unitRb?: number; unitTe?: number; unitWr?: number; reset?: boolean; rz?: number }
export function mkDefense(i: number, o: DefSpec = {}): DefenseEvidence {
  const w = (window: string): Row => ({ window, man_zone__man_rate: o.man ?? 0.2 + i * 0.01, man_zone__charted_mz: 900, pressure__charted_pressure: 900, coverage_family__charted_cov: 900, pressure__pressure_rate_generated: o.pressure ?? 0.22 + i * 0.004, pressure__blitz_proxy_rate: o.blitz ?? 0.12 + i * 0.003, box__heavy_box_rate: o.heavy_box ?? 0.15 + i * 0.006, coverage_family__cover_3: 0.3, coverage_family__cover_1: 0.2, coverage_family__cover_2: 0.15, coverage_family__cover_4: 0.1, coverage_family__cover_6: 0.05, coverage_family__two_man: 0.04, coverage_family__cover_0: 0.05, live__explosive_pass_allowed: 0.07, live__explosive_rush_allowed: 0.035 });
  const pass_cells = DEPTHS.flatMap((d) => THIRDS.map((t) => ({ window: "recent", depth_bin: d, field_third: t, targets: 120, share: 1 / 12, epa: (d === "DEEP" ? (o.deepEpa ?? -0.02 + i * 0.002) : d === "SHORT" ? (o.shortEpa ?? -0.03 + i * 0.002) : -0.02 + i * 0.001), explosive: d === "DEEP" ? (o.explDeep ?? 0.2 + i * 0.002) : 0.05, success: 0.45, td: 0.03, evidence: "STRONG" as EvidenceTier })));
  const rush_direction = THIRDS.map((t) => ({ window: "recent", field_third: t, carries: 300, epa: t === "MIDDLE" ? (o.runMid ?? -0.08 + i * 0.002) : (o.runEnd ?? -0.06 + i * 0.001), explosive: 0.04, stuff: 0.18, evidence: "STRONG" as EvidenceTier }));
  const rush_gap = ["END", "TACKLE", "GUARD"].map((g) => ({ window: "recent", run_gap: g, carries: 300, epa: g === "GUARD" ? (o.runMid ?? -0.08 + i * 0.002) : (o.runEnd ?? -0.06 + i * 0.001), explosive: 0.04, evidence: "STRONG" as EvidenceTier }));
  return { team: TEAMS[i]!, tendency: { recent: w("recent"), career: w("career") }, pass_cells, rush_direction, rush_gap,
    fi_defense: { def_pass_epa_allowed: fi(-0.02 + i * 0.002, 1 - i / 31), def_rush_epa_allowed: fi(-0.03 + i * 0.001, 1 - i / 31), def_epa_play_allowed: fi(-0.02 + i * 0.001, 1 - i / 31, "NOT_PREDICTIVE"), def_rz_td_rate_allowed: fi(o.rz ?? -0.02 + i * 0.002, 1 - i / 31, "WEAKLY_PREDICTIVE"), def_pressure_rate: fi(0, 0.5), def_blitz_rate: fi(0, 0.5) },
    fi_unit_coverage: { RB: fi(o.unitRb ?? -0.05 + i * 0.003, 1 - i / 31, "UNVALIDATED"), WR: fi(o.unitWr ?? -0.05 + i * 0.003, 1 - i / 31, "UNVALIDATED"), TE: fi(o.unitTe ?? -0.05 + i * 0.003, 1 - i / 31, "UNVALIDATED") },
    scheme_era: [{ team: TEAMS[i]!, season: 2026, scheme_reset_hint: o.reset ?? false, coordinator_known: false, starting_qb_changed: false }] };
}
const split = (bucket: string, n: number, values: Record<string, number | null>, ev: EvidenceTier = "STRONG", window = "recent"): SplitRow => ({ window, bucket, n, values, evidence: ev });
const cell = (d: string, t: string, share: number, epa: number, explosive = 0.06, ev: EvidenceTier = "STRONG"): CellRow => ({ window: "recent", depth_bin: d, field_third: t, n: 100, share, epa, explosive, success: 0.5, evidence: ev });

export interface PlayerSpec { gsis: string; pos: "QB" | "RB" | "WR" | "TE"; team?: string; epaMan?: number; epaZone?: number; ev?: EvidenceTier; deepShare?: number; shortShare?: number; pressEpa?: number; cleanEpa?: number; boxHeavy?: number; boxLight?: number; midShare?: number; role?: Partial<NonNullable<PlayerEvidence["role"]>> | null }
export function mkPlayer(s: PlayerSpec): PlayerEvidence {
  const ev = s.ev ?? "STRONG"; const deep = s.deepShare ?? 0.1; const short = s.shortShare ?? 0.5; const rest = (1 - deep - short) / 2;
  const cells: CellRow[] = DEPTHS.flatMap((d) => THIRDS.map((t) => cell(d, t, (d === "DEEP" ? deep : d === "SHORT" ? short : d === "INTERMEDIATE" ? rest : rest) / 3, 0.1, d === "DEEP" ? 0.25 : 0.05, ev)));
  const mid = s.midShare ?? 0.6;
  return { gsis_id: s.gsis, name: s.gsis, position: s.pos, team: s.team ?? "T00",
    receiver_cells: s.pos === "WR" || s.pos === "TE" || s.pos === "RB" ? cells : [], qb_cells: s.pos === "QB" ? cells : [],
    rb_direction: s.pos === "RB" ? THIRDS.map((t) => ({ window: "recent", field_third: t, n: 100, share: t === "MIDDLE" ? mid : (1 - mid) / 2, epa: -0.05, explosive: 0.04, stuff: 0.18, evidence: ev })) : [],
    rb_gap: s.pos === "RB" ? ["END", "TACKLE", "GUARD"].map((g) => ({ window: "recent", run_gap: g, n: 100, epa: -0.05, explosive: 0.04, stuff: 0.18, evidence: ev })) : [],
    receiver_coverage: s.pos === "WR" || s.pos === "TE" || s.pos === "RB" ? [split("MAN", 90, { epa_per_target: s.epaMan ?? 0.05 }, ev), split("ZONE", 160, { epa_per_target: s.epaZone ?? 0.15 }, ev)] : [],
    receiver_routes: s.pos === "WR" || s.pos === "TE" ? [split("GO", 30, { epa_per_target: 0.2, targeted_route_share: 0.15 }, ev), split("SLANT", 50, { epa_per_target: 0.25, targeted_route_share: 0.3 }, ev)] : [],
    qb_coverage: s.pos === "QB" ? [split("MAN", 300, { epa_per_play: s.epaMan ?? 0.02 }, ev), split("ZONE", 600, { epa_per_play: s.epaZone ?? 0.08 }, ev)] : [],
    qb_pressure: s.pos === "QB" ? [split("CLEAN", 500, { epa_per_play: s.cleanEpa ?? 0.15, sack_rate: 0.02, time_to_throw: 2.5, air_yards: 8 }, ev), split("PRESSURED", 300, { epa_per_play: s.pressEpa ?? -0.35, sack_rate: 0.15, time_to_throw: 3.1, air_yards: 6 }, ev)] : [],
    qb_rushers: s.pos === "QB" ? [split("FOUR", 500, { epa_per_play: 0.1 }, ev), split("FIVE", 200, { epa_per_play: 0.0 }, ev), split("SIXPLUS", 60, { epa_per_play: -0.1 }, ev)] : [],
    rb_box: s.pos === "RB" ? [split("HEAVY", 200, { epa_per_rush: s.boxHeavy ?? -0.15 }, ev), split("LIGHT", 150, { epa_per_rush: s.boxLight ?? 0.05 }, ev), split("NEUTRAL", 250, { epa_per_rush: -0.05 }, ev)] : [],
    role: s.role === null ? null : { target_share: 0.22, route_participation: 0.85, rush_share: 0.45, rz_target_share: 0.2, rz_carry_share: 0.3, goal_line_carries: 2, snap_share: 0.8, role_level: "REGULAR", role_evidence: "OBSERVED", role_trend: "STABLE", injury_status: null, through_week: 2, ...(s.role ?? {}) } };
}
export interface SourceSpec { defs?: Record<number, DefSpec>; players?: PlayerSpec[]; vintages?: SourceVintage[]; opponents?: Record<string, string> }
export function mkSource(s: SourceSpec = {}): MatchupSource {
  const defs = TEAMS.map((_, i) => mkDefense(i, s.defs?.[i])); const players = new Map((s.players ?? []).map((p) => [p.gsis, mkPlayer(p)]));
  const vintages: SourceVintage[] = s.vintages ?? [{ source: "football-intelligence", version: "fi:2026:w02:test", season: 2026, through_week: 2, availability: "LIVE_CURRENT" }, { source: "player-scheme", version: "psi:2025:w18:test", season: 2025, through_week: 18, availability: "PRIOR_ONLY" }, { source: "role-opportunity", version: "roi:2026:w01:test", season: 2026, through_week: 1, availability: "LIVE_CURRENT" }];
  const off = (t: string): OffenseEvidence => ({ team: t, tendency: { recent: { window: "recent", live__pass_rate: 0.6, live__shotgun_rate: 0.7, formation__form_under_center: 0.2 } }, fi_offense: { off_pass_epa: fi(0.05, 0.6), off_pressure_rate_allowed: fi(0.01, 0.4), off_sack_rate_allowed: fi(0.0, 0.5), off_proe: fi(0.02, 0.7) }, scheme_era: [{ team: t, season: 2026, scheme_reset_hint: false, coordinator_known: false, starting_qb_changed: false }] });
  return { season: () => 2026, vintages: () => vintages, resolvePlayer: (id) => players.get(id) ?? null, defenseTeams: () => TEAMS, defense: (t) => defs[TEAMS.indexOf(t.toUpperCase())] ?? null, offense: (t) => off(t.toUpperCase()), opponent: (t) => s.opponents?.[t] ?? null,
    contextual: (f, o, d) => (TEAMS.includes(d) ? { offense_rating: 0.01, defense_rating: 0.0, interaction_signal: 0.1, predictive_status: "off:PREDICTIVE|def:NOT_PREDICTIVE", confidence: "LOW" } : null), identities: () => ({ player_scheme: "psi-test", fi: "fi-test", role: "roi-test", opp: null }) };
}
