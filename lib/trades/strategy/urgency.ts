/**
 * Trade Engine — Phase 6D: urgency and time-horizon model.
 *
 * `computeUrgency` is a bounded [0, 1] score. It NEVER touches base roster
 * utility (spec §19) — it only feeds `adjustment.ts`'s bounded strategic
 * adjustment, which is itself capped relative to the trade's own base value.
 */

import type { LeagueSeasonContext, PlayoffContext, PlayoffStatus, UrgencyResult } from "./types";
import { PLAYOFF_STATUS_URGENCY, URGENCY_WEIGHTS } from "./config";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Time-pressure component: rises as fewer regular-season weeks remain before the playoff cutover. */
function timePressureComponent(season: LeagueSeasonContext): number {
  if (season.playoff_start_week == null) return 0.3; // no resolvable cutover — mild default, not fabricated urgency
  const weeksLeft = season.weeks_remaining_regular;
  if (weeksLeft <= 0) return 1;
  if (weeksLeft >= 8) return 0;
  return clamp01(1 - weeksLeft / 8);
}

/** Record component: a losing or barely-.500 record raises urgency modestly; a comfortably winning record lowers it. */
function recordComponent(wins: number, losses: number, ties: number): number {
  const gp = wins + losses + ties;
  if (gp === 0) return 0.5;
  const winPct = (wins + ties * 0.5) / gp;
  return clamp01(1 - winPct);
}

export function computeUrgency(season: LeagueSeasonContext, playoff: PlayoffContext, wins: number, losses: number, ties: number): UrgencyResult {
  const playoffComponent = PLAYOFF_STATUS_URGENCY[playoff.status as PlayoffStatus] ?? PLAYOFF_STATUS_URGENCY.UNKNOWN!;
  const timeComponent = timePressureComponent(season);
  const recComponent = recordComponent(wins, losses, ties);

  const score = clamp01(
    URGENCY_WEIGHTS.playoff_status * playoffComponent + URGENCY_WEIGHTS.time_pressure * timeComponent + URGENCY_WEIGHTS.record * recComponent,
  );

  const reasons: string[] = [
    `playoff status ${playoff.status} contributes ${(URGENCY_WEIGHTS.playoff_status * playoffComponent).toFixed(2)} of ${URGENCY_WEIGHTS.playoff_status.toFixed(2)} max`,
    `${season.weeks_remaining_regular} regular-season week(s) remaining contributes ${(URGENCY_WEIGHTS.time_pressure * timeComponent).toFixed(2)} of ${URGENCY_WEIGHTS.time_pressure.toFixed(2)} max`,
    `record ${wins}-${losses}${ties ? `-${ties}` : ""} contributes ${(URGENCY_WEIGHTS.record * recComponent).toFixed(2)} of ${URGENCY_WEIGHTS.record.toFixed(2)} max`,
  ];

  return {
    score: Math.round(score * 1000) / 1000,
    components: {
      playoff_status_component: Math.round(playoffComponent * 1000) / 1000,
      time_pressure_component: Math.round(timeComponent * 1000) / 1000,
      record_component: Math.round(recComponent * 1000) / 1000,
    },
    reasons,
  };
}
