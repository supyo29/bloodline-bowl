/**
 * Phase 7 — chronology-safe historical EVIDENCE CONTEXT: player -> effective team at a historical game -> opponent -> which team-keyed evidence applies.
 * It answers "which team context does this evidence belong to?" for Role, Football Intelligence and Player-Scheme WITHOUT modifying any of them and without ever
 * consulting today's roster. It is not a prediction and carries no numeric adjustment; if the join cannot be established the context is UNAVAILABLE with the failure code.
 */
import { resolveOpponentAt, isResolved, type OpponentResolution, type ScheduleSource, type TeamMembershipIndex, type TeamObservation, type TemporalQuery, type ResolveOptions } from "./membership";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schemeVintageFlag, type SchemeVintageFlag } from "./sources";

export interface HistoricalEvidenceContext {
  status: "READY" | "UNAVAILABLE"; gsis_id: string; season: number; week: number; team: string | null; opponent: string | null;
  /** FI is team-based: player evidence joins FI OFFENSE rows on `offense_team` and the game's actual opponent's DEFENSE rows on `defense_team` (ratings themselves untouched). */
  fi_join: { offense_team: string; defense_team: string; season: number; week: number } | null;
  /** Role evidence for this player-week belongs to this club (never today's team). */
  role_team: string | null;
  /** Player-Scheme's current_team window is the AS-OF (2025 wk18) team; this says whether it is the same club as the effective team at this game. */
  scheme_window_vintage: SchemeVintageFlag | null;
  /** Is the team-keyed evidence for THIS game actually reconstructable AS-OF that game? Phase 7 makes the team/opponent join safe; it does NOT create historical feature snapshots. */
  evidence_availability: Record<"football_intelligence" | "role" | "player_scheme" | "matchup2", { state: "AVAILABLE_AS_OF" | "HISTORY_LIMITED" | "SOURCE_LAG" | "UNAVAILABLE"; reason: string }>;
  failure_code: string | null; membership: OpponentResolution["membership"]; reasons: string[];
}

/**
 * Per-family as-of availability, read from the served manifests (never assumed). FI and Role serve ONE current vintage (no per-week history is preserved), Player-Scheme is a cumulative
 * profile through 2025 week 18 (it contains the game itself and later games, so it is not as-of-safe for any game up to its cutoff), and Matchup 2.0 composes all three.
 */
export function historicalEvidenceAvailability(season: number, week: number, root = process.cwd()): HistoricalEvidenceContext["evidence_availability"] {
  const man = (rel: string): Record<string, number> => { try { return JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, number>; } catch { return {}; } };
  const fi = man("lib/football-intel/data/football_intelligence_manifest.json"), role = man("lib/player-role-intelligence/data/role_opportunity_manifest.json"), ps = man("lib/player-scheme-intelligence/data/player_scheme_manifest.json");
  const fiState: HistoricalEvidenceContext["evidence_availability"]["football_intelligence"] = season === fi.season ? (week <= (fi.through_week ?? 0) ? { state: "HISTORY_LIMITED", reason: `FI serves one cumulative state through ${fi.season} week ${fi.through_week}; the state as-of week ${week} is not preserved` } : { state: "SOURCE_LAG", reason: `FI has not been refreshed through week ${week}` }) : { state: "UNAVAILABLE", reason: `no FI state is preserved for ${season}` };
  const roleState: HistoricalEvidenceContext["evidence_availability"]["role"] = season === role.season && week <= (role.through_week ?? 0) ? { state: "AVAILABLE_AS_OF", reason: `game-level participation exists for ${season} week ${week}` } : season === role.season ? { state: "SOURCE_LAG", reason: `Role is preserved through ${role.season} week ${role.through_week}` } : { state: "UNAVAILABLE", reason: `Role history covers ${role.season} only (earlier seasons exist only in the R cache); no team-context Role state for ${season}` };
  const psState: HistoricalEvidenceContext["evidence_availability"]["player_scheme"] = season > (ps.current_season ?? 0) ? { state: "SOURCE_LAG", reason: `Player-Scheme is prior-season only (through ${ps.current_season} week ${ps.as_of_week}); no ${season} signal` } : { state: "HISTORY_LIMITED", reason: `Player-Scheme is cumulative through ${ps.current_season} week ${ps.as_of_week} — it includes this game and later ones, so it is not reconstructable as-of ${season} week ${week}` };
  return { football_intelligence: fiState, role: roleState, player_scheme: psState, matchup2: { state: "UNAVAILABLE", reason: "Matchup 2.0 composes FI + Player-Scheme + Role as-of the game; the historical snapshots do not exist, so historical matchup evidence is limited to the (now safe) team/opponent join" } };
}
export function historicalEvidenceContext(o: { gsis_id: string; season: number; week: number; observations: readonly TeamObservation[] | TeamMembershipIndex; schedule: ScheduleSource; scheme_as_of_team?: string | null; opts?: ResolveOptions }): HistoricalEvidenceContext {
  const q: TemporalQuery = { kind: "GAME", season: o.season, week: o.week }; const r = resolveOpponentAt(o.gsis_id, o.observations, o.schedule, q, o.opts);
  const ok = r.status === "RESOLVED" && isResolved(r.membership.status) && !!r.team && !!r.opponent;
  return { status: ok ? "READY" : "UNAVAILABLE", gsis_id: o.gsis_id, season: o.season, week: o.week, team: r.team, opponent: r.opponent,
    fi_join: ok ? { offense_team: r.team!, defense_team: r.opponent!, season: o.season, week: o.week } : null, role_team: isResolved(r.membership.status) ? r.team : null,
    scheme_window_vintage: o.scheme_as_of_team !== undefined ? schemeVintageFlag(o.scheme_as_of_team, r.team) : null,
    evidence_availability: historicalEvidenceAvailability(o.season, o.week), failure_code: ok ? null : (r.membership.failure_code ?? (r.status === "BYE" ? "MEMBERSHIP_UNKNOWN" : "GRANULARITY_INSUFFICIENT")), membership: r.membership, reasons: r.reasons };
}
