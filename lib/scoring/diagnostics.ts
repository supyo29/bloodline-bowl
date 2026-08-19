/**
 * Deterministic, evidence-based diagnostics about the league's scoring rules.
 *
 * Every diagnostic is derived directly from a comparison between scoring
 * settings — never a subjective "this is unfair" judgment. A rule that shows no
 * notable comparison simply produces no diagnostic; nothing is fabricated to
 * fill out the list.
 */

import { SCORING_CATALOG, humanizeKey } from "./catalog";
import { roundPoints } from "./calculate";
import type { ScoringDiagnostic } from "./types";

type Raw = Record<string, number>;

const nz = (raw: Raw, key: string): number | null =>
  typeof raw[key] === "number" && Number.isFinite(raw[key] as number)
    ? (raw[key] as number)
    : null;

const POINTS_ALLOWED_TIER_KEYS = [
  "pts_allow_0",
  "pts_allow_1_6",
  "pts_allow_7_13",
  "pts_allow_14_20",
  "pts_allow_21_27",
  "pts_allow_28_34",
  "pts_allow_35p",
];
const FG_DISTANCE_TIER_KEYS = [
  "fgm_0_19",
  "fgm_20_29",
  "fgm_30_39",
  "fgm_40_49",
  "fgm_50_59",
  "fgm_60p",
  "fgm_50p",
];

/** informational < notable < strong, based on how large the gap actually is. */
function severityForGap(
  gap: number,
  thresholds: { notable: number; strong: number },
): "informational" | "notable" | "strong" {
  const magnitude = Math.abs(gap);
  if (magnitude >= thresholds.strong) return "strong";
  if (magnitude >= thresholds.notable) return "notable";
  return "informational";
}

export function buildDiagnostics(raw: Raw): ScoringDiagnostic[] {
  const diagnostics: ScoringDiagnostic[] = [];

  const passTd = nz(raw, "pass_td");
  const rushTd = nz(raw, "rush_td");
  const recTd = nz(raw, "rec_td");
  const passYd = nz(raw, "pass_yd");
  const rushYd = nz(raw, "rush_yd");
  const rec = nz(raw, "rec");
  const passInt = nz(raw, "pass_int");
  const fumLost = nz(raw, "fum_lost");
  const passSack = nz(raw, "pass_sack");
  const teBonus = nz(raw, "bonus_rec_te");
  const ptsAllow = nz(raw, "pts_allow");

  // Rushing TD vs passing TD.
  if (rushTd !== null && passTd !== null && rushTd > passTd) {
    const gap = roundPoints(rushTd - passTd);
    diagnostics.push({
      id: "rushing_td_premium",
      severity: severityForGap(gap, { notable: 1.5, strong: 3 }),
      message: `Rushing touchdowns are worth ${gap} more point(s) than passing touchdowns (${rushTd} vs. ${passTd}), which increases the relative value of any position that scores rushing touchdowns (running backs, dual-threat quarterbacks).`,
    });
  }

  // Receiving TD vs passing TD.
  if (recTd !== null && passTd !== null && recTd > passTd) {
    const gap = roundPoints(recTd - passTd);
    diagnostics.push({
      id: "receiving_td_premium",
      severity: severityForGap(gap, { notable: 1.5, strong: 3 }),
      message: `Receiving touchdowns are worth ${gap} more point(s) than passing touchdowns (${recTd} vs. ${passTd}), which increases the relative value of pass-catchers (wide receivers, tight ends, receiving running backs) over the quarterback who threw the pass.`,
    });
  }

  // Reception-value leverage (PPR).
  if (rec !== null && rec > 0) {
    diagnostics.push({
      id: "reception_value_leverage",
      severity: rec >= 1 ? "notable" : "informational",
      message: `Each reception is worth ${rec} point(s), rewarding high-target-share players (pass-catching running backs, possession receivers, tight ends) independent of yardage or touchdowns.`,
    });
  }

  // Rushing yardage value vs passing yardage value.
  if (rushYd !== null && passYd !== null && passYd > 0 && rushYd > passYd) {
    const ratio = roundPoints(rushYd / passYd);
    diagnostics.push({
      id: "rushing_yardage_premium",
      severity: severityForGap(ratio, { notable: 2, strong: 3 }),
      message: `Each rushing yard is worth ${ratio}x a passing yard (${rushYd} vs. ${passYd} points per yard), which can make rushing production more valuable per yard than passing production.`,
    });
  }

  // Turnover penalties lighter than a common -2 baseline.
  if (passInt !== null && passInt !== 0 && passInt > -1.5) {
    diagnostics.push({
      id: "low_interception_penalty",
      severity: "informational",
      message: `Interceptions are penalized ${passInt} point(s), lighter than the common -2 baseline, which may reduce the statistical cost of turnover-prone quarterback play.`,
    });
  }
  if (fumLost !== null && fumLost !== 0 && fumLost > -1.5) {
    diagnostics.push({
      id: "low_fumble_penalty",
      severity: "informational",
      message: `Lost fumbles are penalized ${fumLost} point(s), lighter than the common -2 baseline, which may reduce the statistical cost of ball-security issues.`,
    });
  }

  // Quarterback sacked penalty.
  if (passSack !== null && passSack !== 0) {
    diagnostics.push({
      id: "quarterback_sack_penalty",
      severity: "informational",
      message: `Quarterbacks lose ${Math.abs(passSack)} point(s) when sacked, a scoring rule not every league includes; it modestly penalizes quarterbacks who play behind a weaker offensive line or hold the ball longer.`,
    });
  }

  // TE premium.
  if (teBonus !== null && teBonus !== 0) {
    diagnostics.push({
      id: "tight_end_premium",
      severity: "notable",
      message: `Tight ends receive an additional ${teBonus} point(s) per reception on top of the standard reception value, narrowing the scoring gap between tight ends and wide receivers.`,
    });
  }

  // Points-allowed scoring model.
  const hasPtsAllowTiers = POINTS_ALLOWED_TIER_KEYS.some((key) => {
    const value = nz(raw, key);
    return value !== null && value !== 0;
  });
  if (ptsAllow !== null && ptsAllow !== 0 && !hasPtsAllowTiers) {
    diagnostics.push({
      id: "defense_points_allowed_penalty",
      severity: "notable",
      message: `Team defenses ${ptsAllow < 0 ? "lose" : "gain"} ${Math.abs(ptsAllow)} point(s) per point allowed on a continuous scale, rather than earning a tiered bonus at fixed point-allowed thresholds (shutout, 1-6, 7-13, etc.), which are all set to zero.`,
    });
  }

  // Flat kicker scoring.
  const flatFg = nz(raw, "fgm");
  const hasFgTiers = FG_DISTANCE_TIER_KEYS.some((key) => {
    const value = nz(raw, key);
    return value !== null && value !== 0;
  });
  if (flatFg !== null && flatFg !== 0 && !hasFgTiers) {
    diagnostics.push({
      id: "flat_kicker_scoring",
      severity: "informational",
      message: `Field goals are scored as a flat ${flatFg} point(s) regardless of distance, so long field goals earn no bonus over short ones.`,
    });
  }

  // Big-play yardage bonuses actually configured.
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("bonus_") && key !== "bonus_rec_te" && value !== 0) {
      const meta = SCORING_CATALOG[key];
      diagnostics.push({
        id: "big_play_bonus_present",
        severity: Math.abs(value) >= 3 ? "notable" : "informational",
        message: `${meta?.label ?? humanizeKey(key)} awards an additional ${value} point(s), rewarding explosive individual games beyond their raw yardage/touchdown value.`,
      });
    }
  }

  return diagnostics;
}
