/**
 * Phase 7 — chronology-safe historical EVIDENCE CONTEXT: player -> effective team at a historical game -> opponent -> which team-keyed evidence applies.
 * It answers "which team context does this evidence belong to?" for Role, Football Intelligence and Player-Scheme WITHOUT modifying any of them and without ever
 * consulting today's roster. It is not a prediction and carries no numeric adjustment; if the join cannot be established the context is UNAVAILABLE with the failure code.
 */
import { resolveOpponentAt, isResolved, type OpponentResolution, type ScheduleSource, type TeamMembershipIndex, type TeamObservation, type TemporalQuery, type ResolveOptions } from "./membership";
import { schemeVintageFlag, type SchemeVintageFlag } from "./sources";

export interface HistoricalEvidenceContext {
  status: "READY" | "UNAVAILABLE"; gsis_id: string; season: number; week: number; team: string | null; opponent: string | null;
  /** FI is team-based: player evidence joins FI OFFENSE rows on `offense_team` and the game's actual opponent's DEFENSE rows on `defense_team` (ratings themselves untouched). */
  fi_join: { offense_team: string; defense_team: string; season: number; week: number } | null;
  /** Role evidence for this player-week belongs to this club (never today's team). */
  role_team: string | null;
  /** Player-Scheme's current_team window is the AS-OF (2025 wk18) team; this says whether it is the same club as the effective team at this game. */
  scheme_window_vintage: SchemeVintageFlag | null;
  failure_code: string | null; membership: OpponentResolution["membership"]; reasons: string[];
}
export function historicalEvidenceContext(o: { gsis_id: string; season: number; week: number; observations: readonly TeamObservation[] | TeamMembershipIndex; schedule: ScheduleSource; scheme_as_of_team?: string | null; opts?: ResolveOptions }): HistoricalEvidenceContext {
  const q: TemporalQuery = { kind: "GAME", season: o.season, week: o.week }; const r = resolveOpponentAt(o.gsis_id, o.observations, o.schedule, q, o.opts);
  const ok = r.status === "RESOLVED" && isResolved(r.membership.status) && !!r.team && !!r.opponent;
  return { status: ok ? "READY" : "UNAVAILABLE", gsis_id: o.gsis_id, season: o.season, week: o.week, team: r.team, opponent: r.opponent,
    fi_join: ok ? { offense_team: r.team!, defense_team: r.opponent!, season: o.season, week: o.week } : null, role_team: isResolved(r.membership.status) ? r.team : null,
    scheme_window_vintage: o.scheme_as_of_team !== undefined ? schemeVintageFlag(o.scheme_as_of_team, r.team) : null,
    failure_code: ok ? null : (r.membership.failure_code ?? (r.status === "BYE" ? "MEMBERSHIP_UNKNOWN" : "GRANULARITY_INSUFFICIENT")), membership: r.membership, reasons: r.reasons };
}
