/**
 * W2.R1 S4: K and D/ST expected points from COMPONENT expectations under a league's EXACT scoring keys.
 * The component expectations (attempts, make probabilities, sacks, interceptions, points-allowed distribution ...) come from the S4 component models (R, scripts/w2r1/s4_*.R);
 * this module is the exact-scoring reconstruction and is golden-tested against the R implementation. It never uses a generic "standard points" number.
 * Status: DIAGNOSTIC until the S7 final evaluation labels it.
 */
export type Scoring = Record<string, number>;
const w = (s: Scoring, k: string): number => (typeof s[k] === "number" ? (s[k] as number) : 0);
const has = (s: Scoring, k: string): boolean => typeof s[k] === "number";

export interface KWeights { make: number[]; miss: number[]; xpm: number; xpmiss: number }
/** bins: 0-19, 20-29, 30-39, 40-49, 50-59, 60+ */
export function kWeights(s: Scoring): KWeights {
  const fm = w(s, "fgm"), fx = w(s, "fgmiss");
  return {
    make: [w(s, "fgm_0_19") + fm, w(s, "fgm_20_29") + fm, w(s, "fgm_30_39") + fm, w(s, "fgm_40_49") + fm, (has(s, "fgm_50_59") ? w(s, "fgm_50_59") : w(s, "fgm_50p")) + fm, (has(s, "fgm_60p") ? w(s, "fgm_60p") : w(s, "fgm_50p")) + fm],
    miss: [w(s, "fgmiss_0_19") + fx, w(s, "fgmiss_20_29") + fx, w(s, "fgmiss_30_39") + fx, w(s, "fgmiss_40_49") + fx, (has(s, "fgmiss_50_59") ? w(s, "fgmiss_50_59") : w(s, "fgmiss_50p")) + fx, (has(s, "fgmiss_60p") ? w(s, "fgmiss_60p") : w(s, "fgmiss_50p")) + fx],
    xpm: w(s, "xpm"), xpmiss: w(s, "xpmiss"),
  };
}

export interface KComponents { e_fg: number; shares: number[]; pbin: number[]; e_xp: number; xp_rate: number }
export function expectedKPoints(c: KComponents, s: Scoring): number {
  const k = kWeights(s);
  let pts = 0;
  for (let b = 0; b < 6; b++) pts += c.e_fg * c.shares[b]! * (c.pbin[b]! * k.make[b]! + (1 - c.pbin[b]!) * k.miss[b]!);
  return pts + c.e_xp * (c.xp_rate * k.xpm + (1 - c.xp_rate) * k.xpmiss);
}

/** Provider semantics differ (verified against live 2025 provider D/ST stat lines, S7 adjudication). */
export type Provider = "sleeper" | "yahoo";
export interface DWeights {
  sacks: number; sack_yd: number; ints: number; int_ret_yd: number; fumrec_def: number; fumrec_st: number; fum_ret_yd: number; ff_def: number; ff_st: number; def_td: number; st_td: number; blk_td: number;
  safeties: number; blk: number; stops4: number; forced_punts: number; kr_yd: number; pr_yd: number; def2pt: number; pa_cont: number; pa_bins: number[];
}
export function dWeights(s: Scoring, provider: Provider): DWeights {
  const dk = (a: string, b: string) => (has(s, a) ? w(s, a) : w(s, b));
  const sl = provider === "sleeper";
  // Sleeper: fum_rec = defensive recoveries, def_st_fum_rec = ST recoveries by the D/ST; ff / def_st_ff split likewise; def_td vs def_st_td (KR/PR TDs). st_* and fum_rec_td are individual-player keys.
  // Blocked punt / blocked FG TDs (blk_td): Sleeper pays def_st_td; Yahoo pays the defensive "Touchdown" (def_td). KR/PR (unblocked return) TDs: Sleeper def_st_td, Yahoo st_td.
  // Yahoo: Fumble Recovery covers defense AND special teams; Touchdown = def_td; KR/PR TD = st_td; no forced-fumble stat; fum_rec_td is an offensive-player key.
  return {
    sacks: w(s, "sack"), sack_yd: w(s, "sack_yd"), ints: w(s, "int"), int_ret_yd: w(s, "int_ret_yd"), fumrec_def: w(s, "fum_rec"), fumrec_st: sl ? w(s, "def_st_fum_rec") : w(s, "fum_rec"),
    fum_ret_yd: w(s, "fum_ret_yd"), ff_def: sl ? w(s, "ff") : 0, ff_st: sl ? w(s, "def_st_ff") : 0, def_td: w(s, "def_td"), st_td: sl ? w(s, "def_st_td") : w(s, "st_td"), blk_td: sl ? w(s, "def_st_td") : w(s, "def_td"), safeties: w(s, "safe"), blk: w(s, "blk_kick"), stops4: w(s, "def_4_and_stop"),
    forced_punts: w(s, "def_forced_punts"), kr_yd: dk("def_kr_yd", "kr_yd"), pr_yd: dk("def_pr_yd", "pr_yd"), def2pt: w(s, "def_2pt"), pa_cont: w(s, "pts_allow"),
    pa_bins: [w(s, "pts_allow_0"), w(s, "pts_allow_1_6"), w(s, "pts_allow_7_13"), w(s, "pts_allow_14_20"), w(s, "pts_allow_21_27"), w(s, "pts_allow_28_34"), w(s, "pts_allow_35p")],
  };
}
export function paScore(pa: number, d: DWeights): number {
  const bin = pa === 0 ? 0 : pa <= 6 ? 1 : pa <= 13 ? 2 : pa <= 20 ? 3 : pa <= 27 ? 4 : pa <= 34 ? 5 : 6;
  return d.pa_bins[bin]! + d.pa_cont * pa;
}

export interface DComponents {
  e_sacks: number; e_ints: number; e_fr: number; r_fumrec_st: number; r_ff_def: number; r_ff_st: number; r_def_td: number; r_st_td: number; r_blk_td: number; r_safeties: number; r_blk: number; r_stops4: number;
  r_forced_punts: number; r_kr_yd: number; r_pr_yd: number; r_def2pt: number; mean_yds: { sack_yd: number; int_ret_yd: number; fum_ret_yd: number };
  /** P(points allowed by the opponent offense = k), k = 0..70, normalized */
  pa_pmf: number[];
}
export function expectedDstPoints(c: DComponents, s: Scoring, provider: Provider): number {
  const d = dWeights(s, provider);
  let epa = 0;
  for (let k = 0; k < c.pa_pmf.length; k++) epa += c.pa_pmf[k]! * paScore(k, d);
  return (
    c.e_sacks * (d.sacks + d.sack_yd * c.mean_yds.sack_yd) + c.e_ints * (d.ints + d.int_ret_yd * c.mean_yds.int_ret_yd) + c.e_fr * (d.fumrec_def + d.fum_ret_yd * c.mean_yds.fum_ret_yd) +
    c.r_fumrec_st * d.fumrec_st + c.r_ff_def * d.ff_def + c.r_ff_st * d.ff_st + c.r_def_td * d.def_td + c.r_st_td * d.st_td + c.r_blk_td * d.blk_td + c.r_safeties * d.safeties + c.r_blk * d.blk + c.r_stops4 * d.stops4 +
    c.r_forced_punts * d.forced_punts + c.r_kr_yd * d.kr_yd + c.r_pr_yd * d.pr_yd + c.r_def2pt * d.def2pt + epa
  );
}

/** keys of a scoring regime that the K/D-ST component model CANNOT reconstruct (reported, never silently scored as 0): the regime is DIAGNOSTIC_UNQUALIFIED for them unless quantified immaterial.
 *  Provider-aware: keys that are individual-player stats (not D/ST) are NOT APPLICABLE to the D/ST and are listed in `notApplicableDstKeys`. */
const SUPPORTED_K = /^(fgm|fgmiss|xpm|xpmiss)(_|$)/;
const SUPPORTED_D_COMMON = ["sack", "sack_yd", "int", "int_ret_yd", "fum_rec", "fum_ret_yd", "safe", "blk_kick", "def_4_and_stop", "def_forced_punts", "def_kr_yd", "def_pr_yd", "def_2pt", "def_td", "pts_allow"];
const SUPPORTED_D: Record<Provider, Set<string>> = {
  sleeper: new Set([...SUPPORTED_D_COMMON, "def_st_fum_rec", "ff", "def_st_ff", "def_st_td"]),
  yahoo: new Set([...SUPPORTED_D_COMMON, "st_td"]),
};
/** Individual-player stat keys that exist in the league scoring but are not D/ST stat-line components (a D/ST never earns them). */
const NOT_APPLICABLE_D: Record<Provider, Set<string>> = {
  sleeper: new Set(["st_td", "st_ff", "st_fum_rec", "kr_yd", "pr_yd", "fum_rec_td"]),
  yahoo: new Set(["fum_rec_td", "kr_yd", "pr_yd"]),
};
export function notApplicableDstKeys(s: Scoring, provider: Provider): string[] {
  return Object.entries(s).filter(([k, v]) => v !== 0 && NOT_APPLICABLE_D[provider].has(k)).map(([k]) => k).sort();
}
export function unsupportedKdstKeys(s: Scoring, provider: Provider): string[] {
  return Object.entries(s).filter(([k, v]) => v !== 0 && /^(fg|xp|sack|int|fum|def_|st_|safe|blk|pts_allow|yds_allow|ff|kr_yd|pr_yd|bonus_def)/.test(k) && !SUPPORTED_K.test(k) && !SUPPORTED_D[provider].has(k) && !NOT_APPLICABLE_D[provider].has(k) && !/^pts_allow_/.test(k)).map(([k]) => k).sort();
}
