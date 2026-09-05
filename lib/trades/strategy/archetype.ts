/**
 * Trade Engine — Phase 6C: strategic archetype classification.
 *
 * Combines playoff status + record + season stage — never a single weak
 * metric (spec §11). Redraft-only: no `REBUILDER`/dynasty labeling, since
 * this repository's registered leagues are redraft (see spec §10 — an
 * eliminated redraft team is not a "rebuilder").
 */

import type { LeagueSeasonContext, ManagerStandingsContext, PlayoffContext, StrategicArchetype } from "./types";

export function classifyArchetype(
  season: LeagueSeasonContext,
  standings: ManagerStandingsContext,
  playoff: PlayoffContext,
): { archetype: StrategicArchetype; reasons: string[] } {
  const reasons: string[] = [];

  if (season.season_stage === "PRESEASON" || season.season_stage === "SEASON_COMPLETE") {
    reasons.push(`season stage is ${season.season_stage} — strategic archetype is not meaningful outside an active regular/playoff season`);
    return { archetype: "UNKNOWN", reasons };
  }
  if (!standings.standings_available || playoff.status === "UNKNOWN") {
    reasons.push("standings or playoff context unavailable — cannot classify a strategic archetype from insufficient evidence");
    return { archetype: "UNKNOWN", reasons };
  }

  switch (playoff.status) {
    case "CLINCHED":
      reasons.push(`clinched playoff position (${standings.wins}-${standings.losses}${standings.ties ? `-${standings.ties}` : ""}, rank ${standings.rank})`);
      return { archetype: "FRONT_RUNNER", reasons };
    case "STRONG_POSITION":
      reasons.push(`strong playoff position but not yet clinched (${standings.wins}-${standings.losses}${standings.ties ? `-${standings.ties}` : ""}, rank ${standings.rank})`);
      return { archetype: "CONTENDER", reasons };
    case "BUBBLE":
      reasons.push(`near the playoff qualification boundary (${playoff.games_back} games back of the cutline)`);
      return { archetype: "BUBBLE", reasons };
    case "LONG_SHOT": {
      // A long-shot team with very little season left and a real mathematical
      // path becomes MUST_WIN (spec §15/§16 distinction): every remaining
      // week now carries binary elimination pressure.
      if (season.weeks_remaining_regular <= 2 && playoff.games_back != null && playoff.games_back <= season.weeks_remaining_regular) {
        reasons.push(`long-shot playoff path with only ${season.weeks_remaining_regular} regular-season week(s) left — every remaining game is now do-or-die`);
        return { archetype: "MUST_WIN", reasons };
      }
      reasons.push(`long-shot playoff path (${playoff.games_back} games back) with meaningful weeks still remaining`);
      return { archetype: "LONG_SHOT", reasons };
    }
    case "ELIMINATED":
      reasons.push("mathematically eliminated from the playoffs this season");
      return { archetype: "ELIMINATED", reasons };
    default:
      reasons.push("insufficient evidence to classify");
      return { archetype: "UNKNOWN", reasons };
  }
}
