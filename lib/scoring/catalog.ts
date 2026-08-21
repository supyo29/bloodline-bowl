/**
 * Static label catalog for Sleeper's scoring-settings keys.
 *
 * Covers the offense/kicking/defense/special-teams keys Sleeper documents,
 * plus common IDP keys, so most leagues resolve every key to a readable label.
 * A key this league doesn't use simply never appears in the output — this
 * catalog is only consulted for keys actually present in `scoring_settings`.
 *
 * A key missing from this map is NOT an error: `normalize.ts` falls back to a
 * generated label and records a warning, so an unrecognized or brand-new
 * Sleeper key degrades gracefully instead of breaking the endpoint.
 */

import type { ScoringCatalogEntry } from "./types";

export const SCORING_CATALOG: Record<string, ScoringCatalogEntry> = {
  // Passing
  pass_yd: { label: "Passing yard", category: "passing" },
  pass_td: { label: "Passing touchdown", category: "passing" },
  pass_td_40p: { label: "Passing touchdown (40+ yards)", category: "passing" },
  pass_td_50p: { label: "Passing touchdown (50+ yards)", category: "passing" },
  pass_2pt: { label: "Passing 2-point conversion", category: "bonuses" },
  pass_sack: { label: "Quarterback sacked", category: "passing" },
  pass_cmp: { label: "Pass completion", category: "passing" },
  pass_inc: { label: "Incomplete pass", category: "passing" },
  pass_att: { label: "Pass attempt", category: "passing" },
  pass_int: { label: "Interception thrown", category: "turnovers" },
  pass_int_td: {
    label: "Interception returned for touchdown (against passer)",
    category: "turnovers",
  },
  pass_rz_att: { label: "Red-zone pass attempt", category: "passing" },

  // Rushing
  rush_yd: { label: "Rushing yard", category: "rushing" },
  rush_td: { label: "Rushing touchdown", category: "rushing" },
  rush_td_40p: { label: "Rushing touchdown (40+ yards)", category: "rushing" },
  rush_td_50p: { label: "Rushing touchdown (50+ yards)", category: "rushing" },
  rush_2pt: { label: "Rushing 2-point conversion", category: "bonuses" },
  rush_att: { label: "Rush attempt", category: "rushing" },
  rush_rz_att: { label: "Red-zone rush attempt", category: "rushing" },

  // Receiving
  rec: { label: "Reception", category: "receiving" },
  rec_yd: { label: "Receiving yard", category: "receiving" },
  rec_td: { label: "Receiving touchdown", category: "receiving" },
  rec_td_40p: {
    label: "Receiving touchdown (40+ yards)",
    category: "receiving",
  },
  rec_td_50p: {
    label: "Receiving touchdown (50+ yards)",
    category: "receiving",
  },
  rec_2pt: { label: "Receiving 2-point conversion", category: "bonuses" },
  rec_tgt: { label: "Target", category: "receiving" },
  bonus_rec_te: {
    label: "Tight end reception bonus (TE premium)",
    category: "bonuses",
  },
  bonus_rec_rb: { label: "Running back reception bonus", category: "bonuses" },
  bonus_rec_wr: { label: "Wide receiver reception bonus", category: "bonuses" },

  // Turnovers / ball security
  fum: { label: "Fumble (not necessarily lost)", category: "turnovers" },
  fum_lost: { label: "Fumble lost", category: "turnovers" },

  // Big-play / yardage bonuses (offense)
  bonus_pass_yd_300: { label: "300+ passing yards bonus", category: "bonuses" },
  bonus_pass_yd_400: { label: "400+ passing yards bonus", category: "bonuses" },
  bonus_rush_yd_100: { label: "100+ rushing yards bonus", category: "bonuses" },
  bonus_rush_yd_200: { label: "200+ rushing yards bonus", category: "bonuses" },
  bonus_rec_yd_100: {
    label: "100+ receiving yards bonus",
    category: "bonuses",
  },
  bonus_rec_yd_200: {
    label: "200+ receiving yards bonus",
    category: "bonuses",
  },

  // Kicking
  fgm: { label: "Field goal made (flat, any distance)", category: "kicking" },
  fgm_0_19: { label: "Field goal made (0-19 yards)", category: "kicking" },
  fgm_20_29: { label: "Field goal made (20-29 yards)", category: "kicking" },
  fgm_30_39: { label: "Field goal made (30-39 yards)", category: "kicking" },
  fgm_40_49: { label: "Field goal made (40-49 yards)", category: "kicking" },
  fgm_50_59: { label: "Field goal made (50-59 yards)", category: "kicking" },
  fgm_60p: { label: "Field goal made (60+ yards)", category: "kicking" },
  fgm_50p: { label: "Field goal made (50+ yards)", category: "kicking" },
  fgmiss: { label: "Field goal missed", category: "kicking" },
  fgmiss_0_19: { label: "Field goal missed (0-19 yards)", category: "kicking" },
  fgmiss_20_29: {
    label: "Field goal missed (20-29 yards)",
    category: "kicking",
  },
  fgmiss_30_39: {
    label: "Field goal missed (30-39 yards)",
    category: "kicking",
  },
  fgmiss_40_49: {
    label: "Field goal missed (40-49 yards)",
    category: "kicking",
  },
  fgmiss_50p: { label: "Field goal missed (50+ yards)", category: "kicking" },
  xpm: { label: "Extra point made", category: "kicking" },
  xpmiss: { label: "Extra point missed", category: "kicking" },

  // Team defense (DST)
  sack: { label: "Sack (team defense)", category: "defense" },
  sack_yd: { label: "Sack yardage (team defense)", category: "defense" },
  int: { label: "Interception (team defense)", category: "defense" },
  int_ret_yd: { label: "Interception return yard", category: "defense" },
  fum_rec: { label: "Fumble recovery", category: "defense" },
  fum_rec_td: { label: "Fumble recovery touchdown", category: "defense" },
  fum_ret_yd: { label: "Fumble return yard", category: "defense" },
  ff: { label: "Forced fumble", category: "defense" },
  safe: { label: "Safety", category: "defense" },
  blk_kick: { label: "Blocked kick", category: "defense" },
  def_td: { label: "Defensive touchdown", category: "defense" },
  def_2pt: { label: "Defensive 2-point conversion", category: "defense" },
  def_3_and_out: { label: "3-and-out forced", category: "defense" },
  def_4_and_stop: { label: "4th-down stop", category: "defense" },
  def_forced_punts: { label: "Forced punt", category: "defense" },
  tkl_loss: { label: "Tackle for loss (team defense)", category: "defense" },
  pts_allow: { label: "Points allowed (per point)", category: "defense" },
  pts_allow_0: { label: "Points allowed: 0 (shutout)", category: "defense" },
  pts_allow_1_6: { label: "Points allowed: 1-6", category: "defense" },
  pts_allow_7_13: { label: "Points allowed: 7-13", category: "defense" },
  pts_allow_14_20: { label: "Points allowed: 14-20", category: "defense" },
  pts_allow_21_27: { label: "Points allowed: 21-27", category: "defense" },
  pts_allow_28_34: { label: "Points allowed: 28-34", category: "defense" },
  pts_allow_35p: { label: "Points allowed: 35+", category: "defense" },
  yds_allow_0_100: { label: "Yards allowed: 0-100", category: "defense" },
  yds_allow_100_199: { label: "Yards allowed: 100-199", category: "defense" },
  yds_allow_200_299: { label: "Yards allowed: 200-299", category: "defense" },
  yds_allow_300_349: { label: "Yards allowed: 300-349", category: "defense" },
  yds_allow_350_399: { label: "Yards allowed: 350-399", category: "defense" },
  yds_allow_400_449: { label: "Yards allowed: 400-449", category: "defense" },
  yds_allow_450_499: { label: "Yards allowed: 450-499", category: "defense" },
  yds_allow_500_549: { label: "Yards allowed: 500-549", category: "defense" },
  yds_allow_550p: { label: "Yards allowed: 550+", category: "defense" },

  // Special teams / return game
  st_td: { label: "Special teams touchdown", category: "special_teams" },
  st_ff: { label: "Special teams forced fumble", category: "special_teams" },
  st_fum_rec: {
    label: "Special teams fumble recovery",
    category: "special_teams",
  },
  def_st_td: {
    label: "Defensive special-teams touchdown",
    category: "special_teams",
  },
  def_st_ff: {
    label: "Defensive special-teams forced fumble",
    category: "special_teams",
  },
  def_st_fum_rec: {
    label: "Defensive special-teams fumble recovery",
    category: "special_teams",
  },
  def_kr_yd: {
    label: "Kick return yard (team defense)",
    category: "special_teams",
  },
  def_pr_yd: {
    label: "Punt return yard (team defense)",
    category: "special_teams",
  },
  kr_yd: { label: "Kick return yard", category: "special_teams" },
  pr_yd: { label: "Punt return yard", category: "special_teams" },
  fg_ret_yd: { label: "Field goal return yard", category: "special_teams" },
  blk_kick_ret_yd: {
    label: "Blocked kick return yard",
    category: "special_teams",
  },

  // IDP (unused by Bloodline Bowl's roster, kept for portability)
  idp_tkl: { label: "Solo tackle (IDP)", category: "defense" },
  idp_tkl_solo: { label: "Solo tackle (IDP)", category: "defense" },
  idp_tkl_ast: { label: "Assisted tackle (IDP)", category: "defense" },
  idp_sack: { label: "Sack (IDP)", category: "defense" },
  idp_int: { label: "Interception (IDP)", category: "defense" },
  idp_ff: { label: "Forced fumble (IDP)", category: "defense" },
  idp_fum_rec: { label: "Fumble recovery (IDP)", category: "defense" },
  idp_pass_def: { label: "Pass defended (IDP)", category: "defense" },
  idp_blk_kick: { label: "Blocked kick (IDP)", category: "defense" },
  idp_safe: { label: "Safety (IDP)", category: "defense" },
  idp_tkl_loss: { label: "Tackle for loss (IDP)", category: "defense" },
  idp_qb_hit: { label: "QB hit (IDP)", category: "defense" },
};

/** Fallback for a scoring key with no catalog entry: "some_key" -> "Some key". */
export function humanizeKey(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
