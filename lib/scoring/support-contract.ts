/**
 * Phase 6 — the SCORING SUPPORT CONTRACT.
 *
 * CATALOG COVERAGE != SCORING SUPPORT. A key in `catalog.ts`, in a league's settings, or with a human label is only *recognized*. This module
 * answers, per rule, whether the rule actually reaches valuation: who supplies the statistical event in each layer (weekly projection, season/draft
 * projection, completed games, waiver role pricing) and therefore what fantasy-point claim is honest.
 *
 * Data-driven: supply is read from `data/observed-provider-keys.json` (a snapshot of real Sleeper weekly-projection and actual-stat payloads), never
 * inferred from the catalog. An unrecognized key is UNSUPPORTED — it is never silently treated as supported.
 *
 * Final class = the WEAKEST honest link:
 *   FULLY_PROPAGATED                 event supplied/derived in weekly + season + completed-game layers, priced where the waiver role layer prices it
 *   EXACT_HISTORICAL_ONLY            exact on completed games; no projection supply
 *   PROJECTION_APPROXIMATION         projected through a declared approximation (e.g. season D/ST tier spread)
 *   NONLINEAR_PROJECTION_UNRESOLVED  threshold/tier rule: exact on completed games, but no calibrated distribution exists to price a projection
 *   PROVIDER_LIMITED                 the trustworthy provider data needed to score it for a projection does not exist
 *   DECISION_LAYER_MISSING           provider supplies it but a Bloodline Bowl layer (season/draft/trade or waiver role) does not materialize it
 *   CATALOG_ONLY                     recognized; never observed supplied by any provider
 *   UNSUPPORTED                      no player/position/stat pipeline exists for it (e.g. IDP)
 */
import observed from "./data/observed-provider-keys.json";
import { SCORING_CATALOG } from "./catalog";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";

export type SupportClass = "FULLY_PROPAGATED" | "EXACT_HISTORICAL_ONLY" | "PROJECTION_APPROXIMATION" | "NONLINEAR_PROJECTION_UNRESOLVED" | "PROVIDER_LIMITED" | "DECISION_LAYER_MISSING" | "CATALOG_ONLY" | "UNSUPPORTED";
export const SUPPORT_CLASSES: SupportClass[] = ["FULLY_PROPAGATED", "EXACT_HISTORICAL_ONLY", "PROJECTION_APPROXIMATION", "NONLINEAR_PROJECTION_UNRESOLVED", "PROVIDER_LIMITED", "DECISION_LAYER_MISSING", "CATALOG_ONLY", "UNSUPPORTED"];
export type Family = "PASSING" | "RUSHING" | "RECEIVING" | "BALL_SECURITY" | "POSITION_BONUS" | "FIRST_DOWN" | "THRESHOLD_BONUS" | "TD_DISTANCE_BONUS" | "RETURN_INDIVIDUAL" | "KICKING" | "TEAM_DEFENSE_EVENT" | "TEAM_DEFENSE_TIER" | "TEAM_DEFENSE_RETURN_YARDS" | "SPECIAL_TEAMS_EVENT" | "IDP" | "UNKNOWN";
export type Layer = "NATIVE" | "DERIVED" | "PLUG_IN_ESTIMATE" | "STANDARD_POINTS_FALLBACK" | "SUPPLIED" | "APPROXIMATED" | "ABSENT" | "EXACT_NATIVE" | "EXACT_DERIVABLE" | "NOT_OBSERVED" | "NOT_APPLICABLE";

export interface RuleSupport {
  key: string; label: string; category: string; family: Family;
  linearity: "LINEAR" | "THRESHOLD" | "TIER"; positions: string[]; requires_position: boolean; requires_whole_game: boolean; derived_event: boolean;
  weekly_projection: Layer; season_projection: Layer; historical: Layer; waiver_role_pricing: "PRICED" | "NOT_PRICED" | "DECISION_LAYER_MISSING" | "NOT_APPLICABLE";
  consumers: { lineup: string; start_sit: string; matchup: string; leverage: string; positional_needs: string; trade: string; waiver: string };
  in_catalog: boolean; live_leagues_scoring_nonzero: string[]; classification: SupportClass; exact_vs_approximate: "EXACT" | "APPROXIMATE" | "PROVIDER_STANDARD_POINTS" | "NOT_PROJECTED"; limitation: string;
}

const proj = observed.projection_keys_by_position as Record<string, string[]>; const act = observed.actual_keys_by_position as Record<string, string[]>;
const OFF = ["QB", "RB", "WR", "TE"]; const inAny = (m: Record<string, string[]>, ps: string[], k: string) => ps.some((p) => m[p]?.includes(k));
const IDP = new Set(["tkl", "tkl_solo", "tkl_ast", "qb_hit", "def_pass_def", "bonus_tkl_10p", "bonus_sack_2p", "def_st_tkl_solo", "st_tkl_solo"]);
const SEASON_OFFENSE = new Set(["pass_yd", "pass_td", "pass_int", "pass_2pt", "pass_cmp", "pass_att", "pass_inc", "rush_yd", "rush_att", "rush_td", "rush_2pt", "rec", "rec_yd", "rec_td", "rec_2pt", "rec_tgt", "fum_lost", "fum", "kr_yd", "pr_yd", "bonus_rec_te", "bonus_rec_rb", "bonus_rec_wr"]);
const SEASON_K_EXACT = new Set(["fgm", "fgmiss", "xpm", "xpmiss"]); const SEASON_DEF = new Set(["sack", "sack_yd", "int", "int_ret_yd", "ff", "fum_rec", "fum_ret_yd", "safe", "blk_kick", "blk_kick_ret_yd", "def_td", "st_td", "def_kr_yd", "def_pr_yd", "def_4_and_stop", "def_forced_punts", "pts_allow"]);
const WAIVER_PRICED = new Set(["rec", "rec_yd", "rec_td", "rec_tgt", "rush_att", "rush_yd", "rush_td", "bonus_rec_te", "bonus_rec_rb", "bonus_rec_wr"]);
const DEF_LINEAR_EVENTS = /^(sack|sack_yd|int|int_ret_yd|fum_rec|fum_rec_td|fum_ret_yd|ff|safe|blk_kick|def_td|def_2pt|def_3_and_out|def_4_and_stop|def_forced_punts|tkl_loss|pts_allow|yds_allow|pass_int_td_def)$/;

export function familyOf(key: string): { family: Family; linearity: RuleSupport["linearity"]; positions: string[]; whole_game: boolean; derived: boolean } {
  const f = (family: Family, positions: string[], o: Partial<{ linearity: RuleSupport["linearity"]; whole_game: boolean; derived: boolean }> = {}) => ({ family, positions, linearity: o.linearity ?? "LINEAR", whole_game: o.whole_game ?? false, derived: o.derived ?? false });
  if (/^idp_/.test(key) || IDP.has(key)) return f("IDP", []);
  if (/^bonus_(pass|rush|rec|rush_rec)_yd_\d+$/.test(key) || key === "bonus_pass_cmp_25" || key === "bonus_rush_att_20") return f("THRESHOLD_BONUS", OFF, { linearity: "THRESHOLD", whole_game: true, derived: true });
  if (/_td_(40|50)p$/.test(key) || /^bonus_def_(int|fum)_td_50p$/.test(key)) return f("TD_DISTANCE_BONUS", OFF, { linearity: "THRESHOLD", whole_game: false, derived: true });
  if (/^bonus_rec_(te|rb|wr)$/.test(key)) return f("POSITION_BONUS", [key.slice(-2).toUpperCase()], { derived: true });
  if (key === "bonus_rush_td_qb") return f("POSITION_BONUS", ["QB"]);
  if (/^(pass_fd|rush_fd|rec_fd)$/.test(key) || /^bonus_fd_/.test(key)) return f("FIRST_DOWN", OFF);
  if (/^(fgm|fgmiss|xpm|xpmiss|xp_blkd|fgm_yds|fgm_yds_over_30)/.test(key)) return f("KICKING", ["K"], { linearity: /_\d|_50p|_60p/.test(key) ? "TIER" : "LINEAR" });
  if (/^pts_allow_|^yds_allow_/.test(key)) return f("TEAM_DEFENSE_TIER", ["DEF"], { linearity: "TIER", whole_game: true, derived: true });
  if (/^(def_kr_yd|def_pr_yd|fg_ret_yd|blk_kick_ret_yd|fum_ret_yd|int_ret_yd|sack_yd)$/.test(key)) return f("TEAM_DEFENSE_RETURN_YARDS", ["DEF"]);
  if (key === "kr_yd" || key === "pr_yd") return f("RETURN_INDIVIDUAL", OFF);
  if (DEF_LINEAR_EVENTS.test(key)) return f("TEAM_DEFENSE_EVENT", ["DEF"]);
  if (/^(st_td|st_ff|st_fum_rec|def_st_td|def_st_ff|def_st_fum_rec)$/.test(key)) return f("SPECIAL_TEAMS_EVENT", ["DEF", "K"]);
  if (/^pass_/.test(key)) return f("PASSING", ["QB"]); if (/^rush_/.test(key)) return f("RUSHING", OFF); if (/^rec/.test(key)) return f("RECEIVING", ["RB", "WR", "TE"]); if (/^fum/.test(key)) return f("BALL_SECURITY", OFF);
  return f("UNKNOWN", []);
}

const isKdef = (f: Family) => f === "KICKING" || f === "TEAM_DEFENSE_EVENT" || f === "TEAM_DEFENSE_TIER" || f === "TEAM_DEFENSE_RETURN_YARDS" || f === "SPECIAL_TEAMS_EVENT";
const liveNonzero = (k: string): string[] => Object.entries(observed.live_league_scoring as Record<string, Record<string, number>>).filter(([, s]) => (s[k] ?? 0) !== 0).map(([slug]) => slug);

export function classifyScoringKey(key: string): RuleSupport {
  const meta = SCORING_CATALOG[key]; const fam = familyOf(key); const live = liveNonzero(key);
  const seenProj = inAny(proj, ["QB", "RB", "WR", "TE", "K", "DEF"], key); const seenAct = inAny(act, ["QB", "RB", "WR", "TE", "K", "DEF"], key);
  const base = { key, label: meta?.label ?? key.replace(/_/g, " "), category: meta?.category ?? "other", family: fam.family, linearity: fam.linearity, positions: fam.positions, requires_position: fam.family === "POSITION_BONUS", requires_whole_game: fam.whole_game, derived_event: fam.derived, in_catalog: !!meta, live_leagues_scoring_nonzero: live };
  let weekly: Layer, season: Layer, waiver: RuleSupport["waiver_role_pricing"] = "NOT_APPLICABLE", cls: SupportClass, exact: RuleSupport["exact_vs_approximate"], limitation: string;
  const kdef = isKdef(fam.family);
  const hist: Layer = seenAct ? "EXACT_NATIVE" : fam.family === "THRESHOLD_BONUS" ? "EXACT_DERIVABLE" : "NOT_OBSERVED";
  if (fam.family === "IDP") { weekly = "ABSENT"; season = "ABSENT"; cls = "UNSUPPORTED"; exact = "NOT_PROJECTED"; limitation = "No IDP player positions, projection rows, or roster slots exist in the product (weekly feed is requested for QB/RB/WR/TE/K/DEF only); cataloged for label portability only."; }
  else if (fam.family === "UNKNOWN") { weekly = "ABSENT"; season = "ABSENT"; cls = meta || seenProj || seenAct ? "CATALOG_ONLY" : "UNSUPPORTED"; exact = "NOT_PROJECTED"; limitation = meta || seenProj || seenAct ? "Recognized but no family contract: never treated as scored by a projection." : "Unrecognized scoring key: not scored by any projection; calculator warns and skips it."; }
  else if (kdef) {
    weekly = "STANDARD_POINTS_FALLBACK"; exact = "PROVIDER_STANDARD_POINTS"; cls = "PROVIDER_LIMITED";
    season = fam.family === "TEAM_DEFENSE_TIER" ? "APPROXIMATED" : fam.family === "KICKING" ? (SEASON_K_EXACT.has(key) ? "SUPPLIED" : "APPROXIMATED") : SEASON_DEF.has(key) ? "SUPPLIED" : "ABSENT";
    const supplied = inAny(proj, ["K", "DEF"], key);
    limitation = `Weekly K/D-ST projections use Sleeper's STANDARD precomputed points (league-agnostic): this league rule does not change weekly K/DEF values. Provider component supply for this key: ${supplied ? (fam.family === "TEAM_DEFENSE_TIER" ? "plug-in point estimate (1.0 on the projected tier), not a probability" : "present but the feed is partial/internally inconsistent, so exact league-specific reconstruction is not trustworthy") : "absent from the weekly feed"}. Season/draft projection uses the season special-teams model (${season}).`;
  } else if (fam.family === "THRESHOLD_BONUS") {
    weekly = "ABSENT"; season = "ABSENT"; cls = "NONLINEAR_PROJECTION_UNRESOLVED"; exact = "NOT_PROJECTED";
    limitation = "Exact on completed games (inclusive >=, stacking tiers, verified against Sleeper actuals). Not projected: no calibrated per-player yardage distribution exists, and treating a projected mean as an observed game would misstate expected value. Weekly feed does not supply these flags.";
  } else if (fam.family === "TD_DISTANCE_BONUS") {
    weekly = "ABSENT"; season = "ABSENT"; cls = "PROVIDER_LIMITED"; exact = "NOT_PROJECTED";
    limitation = "Requires play-level touchdown distance; the provider projection feed supplies none. Not derivable from a stat line.";
  } else {
    const w = inAny(proj, OFF, key) ? "NATIVE" : key === "kr_yd" ? "DERIVED" : "ABSENT"; weekly = w as Layer;
    season = SEASON_OFFENSE.has(key) ? "SUPPLIED" : "ABSENT"; waiver = WAIVER_PRICED.has(key) ? "PRICED" : fam.family === "RETURN_INDIVIDUAL" ? "DECISION_LAYER_MISSING" : "NOT_PRICED";
    exact = "EXACT";
    if (weekly === "ABSENT") { cls = seenAct ? "EXACT_HISTORICAL_ONLY" : live.length ? "PROVIDER_LIMITED" : "CATALOG_ONLY"; exact = "NOT_PROJECTED"; limitation = "Not in the weekly projection feed; scored only from completed-game stat lines."; }
    else if (season === "ABSENT") { cls = "DECISION_LAYER_MISSING"; limitation = "Provider supplies it weekly, but the season/draft/trade projection layer does not materialize it, so season valuations ignore this rule."; }
    else if (waiver === "DECISION_LAYER_MISSING") { cls = "DECISION_LAYER_MISSING"; limitation = "Reaches weekly/season projected points (lineup, Start/Sit, trades) but Waiver 2.0 Role -> value has no return-yield evidence, so return-role shifts are not priced (Role evidence stays descriptive)."; }
    else { cls = "FULLY_PROPAGATED"; limitation = waiver === "NOT_PRICED" ? "Reaches weekly + season projected points and completed-game scoring; second-order for Waiver role-delta pricing (share x rec/yd/td/carry yield only)." : ""; }
  }
  const viaProj = weekly === "ABSENT" ? "NOT_REACHED" : weekly === "STANDARD_POINTS_FALLBACK" ? "LEAGUE_AGNOSTIC_STANDARD_POINTS" : "VIA_WEEKLY_PROJECTED_POINTS";
  return { ...base, weekly_projection: weekly, season_projection: season, historical: hist, waiver_role_pricing: waiver, classification: cls, exact_vs_approximate: exact, limitation,
    consumers: { lineup: viaProj, start_sit: viaProj, matchup: viaProj, leverage: viaProj, positional_needs: viaProj, trade: season === "ABSENT" ? "NOT_REACHED" : season === "APPROXIMATED" ? "VIA_SEASON_PROJECTION_APPROXIMATION" : "VIA_SEASON_PROJECTION", waiver: waiver === "PRICED" ? "PROJECTION+ROLE_PRICING" : weekly === "ABSENT" ? "NOT_REACHED" : viaProj } };
}

/**
 * The rule universe: the local catalog plus Sleeper's scoring vocabulary (every key present in a live league's full `scoring_settings`, which
 * enumerates the platform's scorable stats). Provider stat fields that are NOT scoring rules (`gp`, snaps, rates, ratings, longs) are excluded:
 * they are statistical context, not rules, and must not be reported as "catalog only".
 */
export function allKnownScoringKeys(): string[] {
  const s = new Set<string>(Object.keys(SCORING_CATALOG));
  for (const sc of Object.values(observed.live_league_scoring as Record<string, Record<string, number>>)) Object.keys(sc).forEach((k) => s.add(k));
  return [...s].sort();
}
export function buildSupportMatrix(): RuleSupport[] { return allKnownScoringKeys().map(classifyScoringKey); }
export function countByClass(rows: RuleSupport[]): Record<SupportClass, number> { const o = Object.fromEntries(SUPPORT_CLASSES.map((c) => [c, 0])) as Record<SupportClass, number>; for (const r of rows) o[r.classification] += 1; return o; }

export interface LeagueScoringContract {
  scoring_fingerprint: string; active_rule_count: number; rules: RuleSupport[]; by_class: Record<SupportClass, number>;
  weekly_basis: { offense: "COMPONENT_RESCORED_WITH_LEAGUE_SCORING"; k_dst: "PROVIDER_STANDARD_POINTS_NOT_LEAGUE_SPECIFIC" };
  k_dst_rules_not_reflected_in_weekly_values: string[]; offense_rules_not_reaching_weekly_projection: string[]; unrecognized_active_keys: string[]; approximations: string[];
}
/** The contract for ONE league's actual scoring map: which of its active (non-zero) rules truly reach valuation, and which do not. */
export function leagueScoringContract(rawScoring: Record<string, number>): LeagueScoringContract {
  const active = Object.entries(rawScoring).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v !== 0).map(([k]) => k).sort(); const rules = active.map(classifyScoringKey);
  return { scoring_fingerprint: scoringFingerprint(rawScoring), active_rule_count: rules.length, rules, by_class: countByClass(rules),
    weekly_basis: { offense: "COMPONENT_RESCORED_WITH_LEAGUE_SCORING", k_dst: "PROVIDER_STANDARD_POINTS_NOT_LEAGUE_SPECIFIC" },
    k_dst_rules_not_reflected_in_weekly_values: rules.filter((r) => isKdef(r.family)).map((r) => r.key),
    offense_rules_not_reaching_weekly_projection: rules.filter((r) => !isKdef(r.family) && r.family !== "IDP" && (r.weekly_projection === "ABSENT")).map((r) => r.key),
    unrecognized_active_keys: rules.filter((r) => r.family === "UNKNOWN" && !r.in_catalog).map((r) => r.key),
    approximations: rules.filter((r) => r.season_projection === "APPROXIMATED").map((r) => `${r.key}: season projection ${r.family === "TEAM_DEFENSE_TIER" ? "spreads a mean over tiers with a fixed normal(sigma=7)" : "splits coarse FG buckets with fixed shares"}`) };
}
