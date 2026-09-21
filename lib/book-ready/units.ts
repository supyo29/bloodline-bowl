/**
 * Phase 3.5C — explicit unit/scale registry. Keys are `surface.metric`; NOTHING is inferred from a column name
 * (Phase 3.5B: several "share"/"rate" columns legitimately exceed 1). An unknown metric throws.
 */
import type { UnitSpec } from "./schema";

const U = (s: UnitSpec): UnitSpec => s;
const frac = (display = "fraction", note?: string): UnitSpec => U({ kind: "fraction", display_unit: display, raw_unit: "fraction", valid_range: [0, 1], may_exceed_one: false, ...(note ? { note } : {}) });
const epa = (per: string): UnitSpec => U({ kind: "rate", display_unit: `EPA/${per}`, raw_unit: `expected points added per ${per}`, valid_range: null, may_exceed_one: true, note: "signed; unbounded" });
const count = (what: string): UnitSpec => U({ kind: "count", display_unit: what, raw_unit: what, valid_range: [0, null], may_exceed_one: true, note: "a COUNT — never a fraction" });
const points = (what = "fantasy points"): UnitSpec => U({ kind: "points", display_unit: what, raw_unit: what, valid_range: null, may_exceed_one: true });
/** A role share that is a fraction but may legitimately be negative (air yards) or exceed 1 (QB snaps vs excluded kneels). */
const roleShare = (opts: { exceeds?: boolean; negative?: boolean; note?: string } = {}): UnitSpec =>
  U({ kind: "fraction", display_unit: "share", raw_unit: "fraction", valid_range: [opts.negative ? null : 0, opts.exceeds ? null : 1], may_exceed_one: !!opts.exceeds, ...(opts.note ? { note: opts.note } : {}) });

const FI_TEAM: Record<string, UnitSpec & { percentile_orientation: "VALUE_ORIENTED" | "INVERTED_VALUE" }> = {};
const fiTeam = (metric: string, u: UnitSpec, orient: "VALUE_ORIENTED" | "INVERTED_VALUE") => { FI_TEAM[metric] = { ...u, percentile_orientation: orient }; };
// EPA / success / rates. Orientation verified against the served artifact (test: units.orientation-matches-data).
for (const m of ["off_pass_epa", "off_rush_epa", "off_epa_play"]) fiTeam(m, epa("play"), "VALUE_ORIENTED");
for (const m of ["def_epa_play_allowed", "def_pass_epa_allowed", "def_rush_epa_allowed"]) fiTeam(m, epa("play"), "INVERTED_VALUE");
for (const m of ["off_success_rate", "off_explosive_pass_rate", "off_explosive_rush_rate", "off_rz_td_rate"]) fiTeam(m, frac("rate (fraction of plays)"), "VALUE_ORIENTED");
for (const m of ["def_success_allowed", "def_explosive_pass_rate_allowed", "def_explosive_rush_rate_allowed", "def_rz_td_rate_allowed", "off_pressure_rate_allowed", "off_sack_rate_allowed"]) fiTeam(m, frac("rate (fraction of plays)"), "INVERTED_VALUE");
for (const m of ["def_blitz_rate", "def_pressure_rate"]) fiTeam(m, frac("rate (fraction of plays)"), "VALUE_ORIENTED");
fiTeam("off_pace_sec_play", U({ kind: "seconds", display_unit: "sec/play", raw_unit: "seconds per play", valid_range: [0, null], may_exceed_one: true, note: "higher = slower pace; percentile is value-oriented (slower = higher)" }), "VALUE_ORIENTED");
fiTeam("off_proe", U({ kind: "percentage", display_unit: "pp", raw_unit: "percentage points (NOT a 0-1 fraction)", valid_range: [-100, 100], may_exceed_one: true, note: "pass rate over expected, in percentage points" }), "VALUE_ORIENTED");

const REGISTRY: Record<string, UnitSpec> = {
  // ---- Football Intelligence
  ...Object.fromEntries(Object.entries(FI_TEAM).map(([m, u]) => [`fi.team.${m}`, u])),
  "fi.percentile": U({ kind: "percentile", display_unit: "percentile (0-1)", raw_unit: "fraction", valid_range: [0, 1], may_exceed_one: false, note: "orientation is per-metric; see percentile_orientation on the metric" }),
  "fi.coverage_allowed_epa": epa("target"),
  "fi.usage.snap_share": roleShare(), "fi.usage.target_share": roleShare(), "fi.usage.rush_share": roleShare(),
  "fi.usage.air_yards_share": roleShare({ negative: true, note: "may be negative" }), "fi.usage.route_participation": roleShare(),
  "fi.usage.rz_target_share": roleShare(), "fi.usage.rz_carry_share": roleShare(),
  "fi.usage.deep_att_rate": frac("rate (fraction)"), "fi.usage.designed_rush_rate": frac("rate (fraction)"),
  "fi.n_obs_effective": U({ kind: "index", display_unit: "effective observations", raw_unit: "effective sample size (recency-weighted)", valid_range: [0, null], may_exceed_one: true, note: "NOT a raw count; recency-weighted" }),
  // ---- Role
  "role.snap_share": roleShare({ exceeds: true, note: "offensive_snaps / team_offensive_plays; QB values may exceed 1.0 because kneels are excluded from the denominator (documented Phase 2 Checkpoint B)" }),
  "role.target_share": roleShare(), "role.position_group_target_share": roleShare(), "role.air_yards_share": roleShare({ negative: true }),
  "role.route_participation": roleShare({ note: "proxy (on-field for a pass play), not a confirmed route count" }),
  "role.rush_share": roleShare(), "role.position_group_rush_share": roleShare(), "role.rz_target_share": roleShare(), "role.rz_carry_share": roleShare(),
  "role.kick_return_role": roleShare(), "role.punt_return_role": roleShare(),
  "role.opportunity_total": count("opportunities"), "role.n_games_season": count("games"),
  "role.delta": U({ kind: "fraction", display_unit: "share change", raw_unit: "difference of two shares", valid_range: null, may_exceed_one: true, is_deviation: true }),
  // ---- Opportunity Propagation
  "opp.role_share": roleShare({ exceeds: true, negative: true, note: "domain-specific share; scenario values are conditional predictions" }),
  "opp.inheritance_rate": U({ kind: "ratio", display_unit: "ratio", raw_unit: "beneficiary gain / vacated opportunity", valid_range: [0, null], may_exceed_one: true, note: "a RATIO, not a probability; beneficiaries can collectively over-absorb the vacated share" }),
  "opp.evidence_count": count("training episodes"),
  "opp.vacated_opportunity": roleShare({ exceeds: true, negative: true }),
  // ---- Player-Scheme
  "scheme.count": count("plays"), "scheme.fraction": frac(), "scheme.rate": frac("rate (fraction)"),
  "scheme.epa": epa("play"), "scheme.yards": U({ kind: "yards", display_unit: "yards", raw_unit: "yards", valid_range: null, may_exceed_one: true }),
  "scheme.seconds": U({ kind: "seconds", display_unit: "sec", raw_unit: "seconds", valid_range: [0, null], may_exceed_one: true }),
  // ---- Start/Sit shadow, Matchup, roster health, schedule
  "startsit.points": points(), "startsit.contribution_points": points("fantasy points (adjustment)"),
  "matchup.probability": U({ kind: "probability", display_unit: "probability (0-1)", raw_unit: "fraction", valid_range: [0, 1], may_exceed_one: false }),
  "matchup.points": points(), "matchup.percentage": U({ kind: "percentage", display_unit: "%", raw_unit: "percent (0-100)", valid_range: [0, 100], may_exceed_one: true, note: "whole-percent display of a probability" }),
  "health.vor_points": points("VOR (fantasy points over replacement)"), "health.count": count("count"),
  "schedule.week": U({ kind: "ordinal", display_unit: "NFL week", raw_unit: "week number", valid_range: [1, 22], may_exceed_one: true }),
  "schedule.points": points(),
  // ---- Waiver Intelligence 2.0 (Phase 4)
  "waiver2.points": U({ kind: "points", display_unit: "league-scoring fantasy points (over the stated horizon)", raw_unit: "league-scoring fantasy points", valid_range: null, may_exceed_one: true, note: "signed: a net action value can be negative" }),
  "waiver2.points_per_week": U({ kind: "points", display_unit: "fantasy points per week", raw_unit: "league-scoring fantasy points / week", valid_range: null, may_exceed_one: true, note: "signed" }),
  "waiver2.faab_dollars": U({ kind: "currency", display_unit: "FAAB dollars", raw_unit: "whole FAAB dollars", valid_range: [0, null], may_exceed_one: true, note: "a budget amount — never a fraction of the budget" }),
  "waiver2.fraction": U({ kind: "fraction", display_unit: "fraction (0-1)", raw_unit: "fraction", valid_range: [0, 1], may_exceed_one: false }),
  "waiver2.count": U({ kind: "count", display_unit: "count", raw_unit: "count", valid_range: [0, null], may_exceed_one: true, note: "a COUNT — never a fraction" }),
  // ---- League market state (Phase 4.5)
  "market.count": U({ kind: "count", display_unit: "count", raw_unit: "count", valid_range: [0, null], may_exceed_one: true, note: "a COUNT of players — never a fraction" }),
  "market.days": U({ kind: "count", display_unit: "days", raw_unit: "days", valid_range: [0, null], may_exceed_one: true, note: "a number of days (the league waiver-clear window)" }),
  // ---- Matchup Intelligence 2.0 (Phase 5). Interaction values are DEVIATIONS from a league-average defense/mix, in the stated per-play unit.
  "matchup2.epa_target": U({ kind: "rate", display_unit: "EPA/target vs league-average defense", raw_unit: "expected points added per target (difference vs league average)", valid_range: null, may_exceed_one: true, is_deviation: true, note: "signed deviation, unbounded; NOT fantasy points" }),
  "matchup2.epa_play": U({ kind: "rate", display_unit: "EPA/dropback vs league-average defense", raw_unit: "expected points added per dropback (difference vs league average)", valid_range: null, may_exceed_one: true, is_deviation: true, note: "signed deviation, unbounded; NOT fantasy points" }),
  "matchup2.epa_rush": U({ kind: "rate", display_unit: "EPA/rush vs league-average defense", raw_unit: "expected points added per rush (difference vs league average)", valid_range: null, may_exceed_one: true, is_deviation: true, note: "signed deviation, unbounded; NOT fantasy points" }),
  "matchup2.rate_delta": U({ kind: "fraction", display_unit: "rate deviation (fraction)", raw_unit: "difference of two rates", valid_range: null, may_exceed_one: true, is_deviation: true, note: "signed difference vs a league-average defense" }),
  "matchup2.rate": U({ kind: "fraction", display_unit: "rate (fraction)", raw_unit: "fraction", valid_range: [0, 1], may_exceed_one: false }),
  "matchup2.epa": U({ kind: "rate", display_unit: "EPA/play", raw_unit: "expected points added per play", valid_range: null, may_exceed_one: true, note: "signed; unbounded" }),
  "matchup2.index": U({ kind: "index", display_unit: "index (source-defined)", raw_unit: "Football Intelligence interaction signal", valid_range: null, may_exceed_one: true, note: "semantics owned by Football Intelligence; consumed unmodified" }),
  "matchup2.z": U({ kind: "index", display_unit: "z among 32 defenses (same player)", raw_unit: "standard deviations", valid_range: null, may_exceed_one: true, is_deviation: true }),
  "matchup2.rank": U({ kind: "ordinal", display_unit: "rank among 32 defenses", raw_unit: "1 = highest", valid_range: [1, 32], may_exceed_one: true }),
  "matchup2.share": U({ kind: "fraction", display_unit: "share", raw_unit: "fraction", valid_range: [0, 1], may_exceed_one: false }),
  "matchup2.count": U({ kind: "count", display_unit: "plays", raw_unit: "plays", valid_range: [0, null], may_exceed_one: true, note: "a COUNT — never a fraction" }),
  "scoring.points_per_unit": U({ kind: "points", display_unit: "fantasy points per stat unit", raw_unit: "league scoring multiplier", valid_range: null, may_exceed_one: true, note: "signed; the league's own multiplier for one unit of the stat (e.g. per yard, per reception)" }),
  "scoring.count": count("rules"),
  "temporal.count": count("count"),
  "fi.cert.points": points("fantasy points (certification effect; + = baseline improved)"), "fi.cert.count": count("count"), "fi.cert.ratio": U({ kind: "ratio", display_unit: "ratio", raw_unit: "slope of realised residual on predicted adjustment", valid_range: null, may_exceed_one: true }),
  "category": U({ kind: "categorical", display_unit: "category", raw_unit: "source-native label", valid_range: null, may_exceed_one: false }),
};

export function unitFor(key: string): UnitSpec {
  const u = REGISTRY[key];
  if (!u) throw new Error(`no explicit unit registered for '${key}' — units are never inferred from names`);
  return u;
}
export const fiTeamUnit = (metric: string): UnitSpec & { percentile_orientation: "VALUE_ORIENTED" | "INVERTED_VALUE" } => {
  const u = FI_TEAM[metric]; if (!u) throw new Error(`no explicit FI team unit for '${metric}'`); return u;
};
export const registeredUnitKeys = (): string[] => Object.keys(REGISTRY);
export const registeredFiTeamMetrics = (): string[] => Object.keys(FI_TEAM);

/** Fraction vs percentage vs count can never be silently converted. */
export function assertConvertible(from: UnitSpec, to: UnitSpec): void {
  const ok = from.kind === to.kind && from.raw_unit === to.raw_unit;
  if (!ok) throw new Error(`refusing implicit conversion ${from.kind}(${from.raw_unit}) -> ${to.kind}(${to.raw_unit})`);
}

/** True iff a value violates the metric's TRUE range. A value above 1 is not a violation when `may_exceed_one`. */
export function violatesRange(value: number, u: UnitSpec): boolean {
  if (!Number.isFinite(value)) return true;
  if (!u.valid_range) return false;
  const [lo, hi] = u.valid_range;
  return (lo !== null && value < lo - 1e-9) || (hi !== null && value > hi + 1e-9);
}
