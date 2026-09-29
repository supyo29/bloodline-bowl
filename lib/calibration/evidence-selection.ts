/**
 * The player-level kickoff rule. NO HINDSIGHT: a projection may grade a player-game only if it was durably recorded
 * STRICTLY BEFORE THAT PLAYER'S OWN game kickoff. The decision is per player-game — never per weekly artifact — so a
 * Thursday kickoff never invalidates Sunday players, and a Sunday artifact is never used for a Thursday player.
 *
 * Pure; no I/O.
 */
import type { EvidenceSelection, ProjectionCandidate } from "./types";

export const SELECTION_RULE = "latest valid projection recorded strictly before this player's own game kickoff; ties: PROJECTION_SNAPSHOT before STARTSIT_CAPTURE, then artifact_id ascending";
const KIND_RANK: Record<string, number> = { PROJECTION_SNAPSHOT: 0, STARTSIT_CAPTURE: 1 };

/** A candidate is usable evidence only if it carries an actual projected number for this player. */
export function isValidCandidate(c: ProjectionCandidate): boolean {
  return c.projected_points != null && Number.isFinite(c.projected_points);
}

export function selectPregameEvidence(candidates: readonly ProjectionCandidate[], kickoffIso: string): EvidenceSelection {
  const kickoff = Date.parse(kickoffIso);
  if (!Number.isFinite(kickoff)) return { chosen: null, considered: candidates.length, rejected_not_before_kickoff: 0, rejected_invalid: 0, rule: SELECTION_RULE };
  let notBefore = 0, invalid = 0;
  const eligible: Array<{ c: ProjectionCandidate; t: number }> = [];
  for (const c of candidates) {
    const t = Date.parse(c.recorded_at);
    if (!Number.isFinite(t) || t >= kickoff) { notBefore++; continue; } // unparseable time is treated as NOT provably before kickoff
    if (!isValidCandidate(c)) { invalid++; continue; }
    eligible.push({ c, t });
  }
  eligible.sort((a, b) =>
    b.t - a.t
    || (KIND_RANK[a.c.kind] ?? 9) - (KIND_RANK[b.c.kind] ?? 9)
    || (a.c.artifact_id < b.c.artifact_id ? -1 : a.c.artifact_id > b.c.artifact_id ? 1 : 0));
  return { chosen: eligible[0]?.c ?? null, considered: candidates.length, rejected_not_before_kickoff: notBefore, rejected_invalid: invalid, rule: SELECTION_RULE };
}
