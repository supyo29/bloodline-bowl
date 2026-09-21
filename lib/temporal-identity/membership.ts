/**
 * Phase 7 — TEMPORAL IDENTITY: player NFL-team membership as an interval/evidence model, kept SEPARATE from player identity.
 *
 *   identity      = who the person is (stable: GSIS / provider id)               -> lib/canonical/players.ts
 *   membership    = which NFL club he belonged to at time T, and WHY we believe it -> THIS module
 *   depth chart / fantasy ownership are different concepts and are NOT modeled here (no source exists / entirely separate layer).
 *
 * Nothing here reads a database, the network, or the clock: evidence goes in, a structured resolution comes out. Sources are adapters.
 *
 * SEMANTICS (audited against real data — see docs/INTELLIGENCE_MODERNIZATION_PHASE_7_TEMPORAL_IDENTITY.md):
 *  - Evidence has an explicit GRANULARITY; a coarser row never pretends to a finer date:
 *      GAME_OBSERVED     the player has a stat/participation row for TEAM in that exact (season, week) game
 *      SEASON_MEMBERSHIP a season-level roster fact (no game/date location)      [no live source exists today; supported by the contract]
 *      CURRENT_ONLY      a provider's statement about NOW                         [never valid for a past time]
 *  - WEEK_BRACKETED is a RESOLUTION (inferred) granularity, never source evidence: no game in week W (bye / inactive), same team at the nearest
 *    games before AND after in the same season. A transition between differently-teamed neighbours is AMBIGUOUS, never bridged.
 *  - Offseason and cross-season inference is never made: 2025's team says nothing about 2026.
 *  - Source disagreement is a first-class CONFLICT: the policy picks a candidate for lineage, but `team` stays null so no consumer joins on a disputed fact.
 *  - A current-only observation (provider now / crosswalk snapshot) is never returned for a historical time.
 */
import { normalizeTeamCode, isNoTeamMarker } from "@/lib/canonical/team-codes";

export const TEMPORAL_IDENTITY_VERSION = "temporal-identity-2026.1";
export type MembershipGranularity = "GAME_OBSERVED" | "SEASON_MEMBERSHIP" | "CURRENT_ONLY";
export type ResolvedGranularity = MembershipGranularity | "WEEK_BRACKETED";
export type MembershipSource = "GAME_LOG" | "ROLE_PARTICIPATION" | "PROVIDER_CURRENT" | "CROSSWALK_LATEST_TEAM";
export type EvidenceClass = "OBSERVED" | "INFERRED_BETWEEN_OBSERVATIONS" | "SNAPSHOT_STALE_RISK";

/** One team-membership observation about one person (`gsis_id` is the stable identity key). Team codes are normalized; the raw code is kept. */
export interface TeamObservation {
  gsis_id: string; season: number; week: number | null; team: string | null; no_team: boolean; raw_team: string | null; opponent: string | null;
  source: MembershipSource; granularity: MembershipGranularity; source_record_id: string; source_vintage: string | null;
}
export function observation(o: { gsis_id: string; season: number; week?: number | null; raw_team: string | null; opponent?: string | null; source: MembershipSource; granularity: MembershipGranularity; source_record_id: string; source_vintage?: string | null }): TeamObservation {
  return { gsis_id: o.gsis_id, season: o.season, week: o.week ?? null, team: normalizeTeamCode(o.raw_team), no_team: isNoTeamMarker(o.raw_team), raw_team: o.raw_team, opponent: normalizeTeamCode(o.opponent ?? null), source: o.source, granularity: o.granularity, source_record_id: o.source_record_id, source_vintage: o.source_vintage ?? null };
}

/** The ONE source-priority policy (used only to NAME a candidate inside a CONFLICT, and to order corroborating evidence). Consumers never choose their own.
 *  Rationale: participation (who was actually on the field) is closer to "represented TEAM in this game" than a stat-log team column; both outrank any
 *  current-only statement, which is not evidence about a past time at all. */
export const SOURCE_PRIORITY: MembershipSource[] = ["ROLE_PARTICIPATION", "GAME_LOG", "PROVIDER_CURRENT", "CROSSWALK_LATEST_TEAM"];
const rank = (s: MembershipSource): number => SOURCE_PRIORITY.indexOf(s);

export type MembershipStatus =
  | "SUPPORTED_GAME" | "SUPPORTED_BRACKETED" | "SUPPORTED_SEASON" | "SUPPORTED_CURRENT"
  | "AMBIGUOUS_TRANSITION" | "BRACKET_GAP_TOO_LONG" | "CONFLICT" | "NO_TEAM_OBSERVED" | "NO_EVIDENCE" | "CURRENT_ONLY_OUT_OF_SCOPE";
export const RESOLVED_STATUSES: MembershipStatus[] = ["SUPPORTED_GAME", "SUPPORTED_BRACKETED", "SUPPORTED_SEASON", "SUPPORTED_CURRENT"];
export const isResolved = (s: MembershipStatus): boolean => RESOLVED_STATUSES.includes(s);

export interface Candidate { team: string | null; sources: MembershipSource[]; weeks: number[]; record_ids: string[]; granularity: MembershipGranularity }
export interface TeamResolution {
  version: string; gsis_id: string; query: TemporalQuery; status: MembershipStatus;
  /** the team a consumer may join on — null unless the status is a SUPPORTED_* one */
  team: string | null; granularity: ResolvedGranularity | null; evidence_class: EvidenceClass | null;
  candidates: Candidate[]; selected_by_policy: string | null; gap_weeks: number | null; reasons: string[]; evidence_ids: string[]; policy: string;
}
/** Same-team bracketing is inferred only across a gap of at most this many missing weeks. DATA-JUSTIFIED (leave-one-out over all 103,096 interior games in the real 2019-2025 game-log source):
 *  gaps of 1-3 weeks: 92,952 inferences, 0 wrong; gaps of 4+ weeks: 9,348 inferences, 2 wrong (real A->B->A sequences: DeVante Bausby DEN-ARI-DEN 2020, DeAndre Houston-Carson HOU-BAL-HOU 2023).
 *  Callers may raise it explicitly; the default is conservative. */
export const DEFAULT_MAX_BRACKET_GAP_WEEKS = 3;
export interface ResolveOptions { maxBracketGapWeeks?: number }
export type TemporalQuery = { kind: "GAME"; season: number; week: number } | { kind: "CURRENT"; season: number; week: number };

const POLICY = `GAME_OBSERVED exact > WEEK_BRACKETED (same team both sides, same season) > SEASON_MEMBERSHIP > (CURRENT queries only) PROVIDER_CURRENT > CROSSWALK_LATEST_TEAM(stale-risk); priority ${SOURCE_PRIORITY.join(" > ")}; no cross-season inference`;

function candidatesOf(obs: TeamObservation[], chronological = false): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const o of obs) { const key = o.no_team ? "∅" : (o.team ?? "?"); const c = by.get(key) ?? { team: o.no_team ? null : o.team, sources: [], weeks: [], record_ids: [], granularity: o.granularity }; if (!c.sources.includes(o.source)) c.sources.push(o.source); if (o.week != null && !c.weeks.includes(o.week)) c.weeks.push(o.week); c.record_ids.push(o.source_record_id); by.set(key, c); }
  const list = [...by.values()]; return chronological ? list : list.sort((a, b) => Math.min(...a.sources.map(rank)) - Math.min(...b.sources.map(rank)) || String(a.team).localeCompare(String(b.team)));
}
const base = (gsis: string, q: TemporalQuery): Omit<TeamResolution, "status" | "team" | "granularity" | "evidence_class" | "reasons"> => ({ version: TEMPORAL_IDENTITY_VERSION, gsis_id: gsis, query: q, candidates: [], selected_by_policy: null, gap_weeks: null, evidence_ids: [], policy: POLICY });
const done = (b: ReturnType<typeof base>, status: MembershipStatus, team: string | null, granularity: ResolvedGranularity | null, cls: EvidenceClass | null, reasons: string[], over: Partial<TeamResolution> = {}): TeamResolution => ({ ...b, status, team, granularity, evidence_class: cls, reasons, ...over });

/**
 * Resolve which NFL team `gsis_id` belonged to at `query`. `observations` may contain any player's rows (filtered by gsis_id here).
 * Deterministic: input order does not matter.
 */
export function resolvePlayerTeamAt(gsisId: string, observations: readonly TeamObservation[], query: TemporalQuery, opts: ResolveOptions = {}): TeamResolution {
  const maxGap = opts.maxBracketGapWeeks ?? DEFAULT_MAX_BRACKET_GAP_WEEKS;
  const b = base(gsisId, query); const mine = observations.filter((o) => o.gsis_id === gsisId);
  const games = mine.filter((o) => o.granularity === "GAME_OBSERVED" && o.season === query.season && o.week != null);
  const ids = (xs: TeamObservation[]) => xs.map((x) => x.source_record_id).sort();

  /* 1) exact game evidence */
  const exact = games.filter((o) => o.week === query.week);
  if (exact.length) {
    const cands = candidatesOf(exact);
    if (cands.length === 1) { const c = cands[0]!; return c.team == null
      ? done(b, "NO_TEAM_OBSERVED", null, "GAME_OBSERVED", "OBSERVED", ["a game-level source records no team for this player-week"], { candidates: cands, evidence_ids: ids(exact) })
      : done(b, "SUPPORTED_GAME", c.team, "GAME_OBSERVED", "OBSERVED", [`game-level evidence for ${c.team} in ${query.season} week ${query.week} from ${c.sources.join("+")}`], { candidates: cands, evidence_ids: ids(exact) }); }
    return done(b, "CONFLICT", null, "GAME_OBSERVED", "OBSERVED", [`sources disagree for ${query.season} week ${query.week}: ${cands.map((c) => `${c.team ?? "no team"} (${c.sources.join("+")})`).join(" vs ")}`, "a candidate is named by policy for lineage only; no team is returned for joining"], { candidates: cands, selected_by_policy: cands[0]!.team, evidence_ids: ids(exact) });
  }

  /* 2) CURRENT query: a provider's statement about NOW (never valid for the past) */
  if (query.kind === "CURRENT") {
    const prov = mine.filter((o) => o.source === "PROVIDER_CURRENT" && o.granularity === "CURRENT_ONLY");
    const lastGame = games.filter((o) => (o.week as number) < query.week).sort((a, c) => (c.week as number) - (a.week as number))[0];
    if (prov.length) {
      const cands = candidatesOf(prov);
      if (cands.length > 1) return done(b, "CONFLICT", null, "CURRENT_ONLY", "OBSERVED", ["provider observations for NOW disagree"], { candidates: cands, evidence_ids: ids(prov) });
      const c = cands[0]!; const extra = lastGame && !c.team ? [] : lastGame && lastGame.team && lastGame.team !== c.team ? [`differs from the team at his last observed game (${lastGame.team}, week ${lastGame.week}): consistent with a transition after that game — NOT a conflict`] : [];
      return c.team == null ? done(b, "NO_TEAM_OBSERVED", null, "CURRENT_ONLY", "OBSERVED", ["provider reports no NFL team right now (free agent / unsigned)", ...extra], { candidates: cands, evidence_ids: ids(prov) })
        : done(b, "SUPPORTED_CURRENT", c.team, "CURRENT_ONLY", "OBSERVED", [`provider observation of ${c.team} at request time`, ...extra], { candidates: cands, evidence_ids: ids(prov) });
    }
    const xw = mine.filter((o) => o.source === "CROSSWALK_LATEST_TEAM");
    if (xw.length) { const cands = candidatesOf(xw); const c = cands[0]!; if (c.team) return done(b, "SUPPORTED_CURRENT", c.team, "CURRENT_ONLY", "SNAPSHOT_STALE_RISK", [`no live provider observation; identity-table snapshot ${xw[0]!.source_vintage ?? "(undated)"} says ${c.team}`, "snapshot may be stale (real audit: ~10% of players had changed teams since the snapshot)"], { candidates: cands, evidence_ids: ids(xw) }); }
  }

  /* 3) bracket between game observations in the SAME season (never across seasons) */
  const before = games.filter((o) => (o.week as number) < query.week).sort((a, c) => (c.week as number) - (a.week as number))[0];
  const after = games.filter((o) => (o.week as number) > query.week).sort((a, c) => (a.week as number) - (c.week as number))[0];
  if (before && after) {
    const gap = (after.week as number) - (before.week as number) - 1;
    if (before.team && before.team === after.team && gap > maxGap) return done(b, "BRACKET_GAP_TOO_LONG", null, "WEEK_BRACKETED", "INFERRED_BETWEEN_OBSERVATIONS", [`same team (${before.team}) at week ${before.week} and week ${after.week}, but ${gap} missing weeks exceeds the ${maxGap}-week inference limit (real audit: 0 wrong in 92,952 gaps of 1-3 weeks; 2 wrong in 9,348 longer gaps); membership in week ${query.week} is not asserted`], { gap_weeks: gap, candidates: candidatesOf([before, after], true), evidence_ids: ids([before, after]) });
    if (before.team && before.team === after.team) return done(b, "SUPPORTED_BRACKETED", before.team, "WEEK_BRACKETED", "INFERRED_BETWEEN_OBSERVATIONS", [`no game observed in week ${query.week} (bye / inactive); same team (${before.team}) at week ${before.week} and week ${after.week}`], { gap_weeks: gap, candidates: candidatesOf([before, after], true), evidence_ids: ids([before, after]) });
    return done(b, "AMBIGUOUS_TRANSITION", null, "WEEK_BRACKETED", "INFERRED_BETWEEN_OBSERVATIONS", [`team before (${before.team ?? "none"}, week ${before.week}) differs from team after (${after.team ?? "none"}, week ${after.week}); the change point lies in weeks ${before.week}–${after.week} and is not located by any source`], { gap_weeks: gap, candidates: candidatesOf([before, after], true), evidence_ids: ids([before, after]) });
  }

  /* 4) season-level membership */
  const season = mine.filter((o) => o.granularity === "SEASON_MEMBERSHIP" && o.season === query.season);
  if (season.length) { const cands = candidatesOf(season); return cands.length === 1 && cands[0]!.team
    ? done(b, "SUPPORTED_SEASON", cands[0]!.team, "SEASON_MEMBERSHIP", "OBSERVED", [`season-level membership only: ${cands[0]!.team} sometime in ${query.season}; the exact interval is unknown`], { candidates: cands, evidence_ids: ids(season) })
    : done(b, "AMBIGUOUS_TRANSITION", null, "SEASON_MEMBERSHIP", "OBSERVED", [`season-level evidence lists ${cands.map((c) => c.team ?? "no team").join(", ")}; the change point is unknown`], { candidates: cands, evidence_ids: ids(season) }); }

  /* 5) nothing usable — say why, never fall back to today's team */
  const currentOnly = mine.filter((o) => o.granularity === "CURRENT_ONLY");
  if (query.kind === "GAME" && currentOnly.length) return done(b, "CURRENT_ONLY_OUT_OF_SCOPE", null, null, null, ["only current-only evidence exists; it does not describe " + `${query.season} week ${query.week}` + " and is never returned for a past time"], { candidates: candidatesOf(currentOnly), evidence_ids: ids(currentOnly) });
  const near = before ?? after;
  return done(b, "NO_EVIDENCE", null, null, null, [near ? `nearest game evidence is ${near.team ?? "no team"} at week ${near.week} of ${near.season}, on one side only; no membership is inferred for week ${query.week}` : `no membership evidence for ${query.season}${query.kind === "GAME" ? ` week ${query.week}` : ""}`], { candidates: near ? candidatesOf([near]) : [], evidence_ids: near ? ids([near]) : [] });
}

/* ------------------------------------------------------------------------------------------------ opponent (chronology-safe) */
export type ScheduleLookup = { kind: "GAME"; opponent: string } | { kind: "BYE" } | { kind: "UNKNOWN"; reason: string };
export interface ScheduleSource { opponentOf(team: string, season: number, week: number): ScheduleLookup }
export interface OpponentResolution { status: "RESOLVED" | "BYE" | "UNAVAILABLE"; team: string | null; opponent: string | null; membership: TeamResolution; reasons: string[] }

/**
 * player + EFFECTIVE team at game time + schedule -> opponent. NEVER player + current team + historical week.
 * An ambiguous / conflicting / unsupported membership makes the opponent UNAVAILABLE (with the reason) — it does not degrade to a guess.
 */
export function resolveOpponentAt(gsisId: string, observations: readonly TeamObservation[], schedule: ScheduleSource, query: TemporalQuery, opts: ResolveOptions = {}): OpponentResolution {
  const m = resolvePlayerTeamAt(gsisId, observations, query, opts);
  if (!isResolved(m.status) || !m.team) return { status: "UNAVAILABLE", team: null, opponent: null, membership: m, reasons: [`team membership not established (${m.status}); opponent not derived`, ...m.reasons] };
  const s = schedule.opponentOf(m.team, query.season, query.week);
  if (s.kind === "GAME") return { status: "RESOLVED", team: m.team, opponent: s.opponent, membership: m, reasons: [`${m.team} played ${s.opponent} in ${query.season} week ${query.week}`] };
  if (s.kind === "BYE") return { status: "BYE", team: m.team, opponent: null, membership: m, reasons: [`${m.team} has no game in week ${query.week}`] };
  return { status: "UNAVAILABLE", team: m.team, opponent: null, membership: m, reasons: [`schedule cannot establish ${m.team}'s opponent: ${s.reason}`] };
}

/** A schedule derived from game-level rows themselves. A team-week whose rows name different opponents is UNKNOWN (never silently one of them). */
export function scheduleFromObservations(obs: readonly TeamObservation[]): ScheduleSource {
  const map = new Map<string, Set<string>>(); const weeksOf = new Map<string, Set<number>>();
  for (const o of obs) { if (o.granularity !== "GAME_OBSERVED" || !o.team || o.week == null) continue; weeksOf.set(`${o.season}|${o.team}`, (weeksOf.get(`${o.season}|${o.team}`) ?? new Set()).add(o.week)); if (!o.opponent) continue; const k = `${o.season}|${o.week}|${o.team}`; (map.get(k) ?? map.set(k, new Set()).get(k)!).add(o.opponent); }
  return { opponentOf(team, season, week) {
    const t = normalizeTeamCode(team); if (!t) return { kind: "UNKNOWN", reason: "no team" };
    const opps = map.get(`${season}|${week}|${t}`); if (opps?.size === 1) return { kind: "GAME", opponent: [...opps][0]! };
    if (opps && opps.size > 1) return { kind: "UNKNOWN", reason: `rows disagree on the opponent: ${[...opps].sort().join(" / ")}` };
    const seen = weeksOf.get(`${season}|${t}`); if (!seen || seen.size === 0) return { kind: "UNKNOWN", reason: `no rows for ${t} in ${season}` };
    return { kind: "UNKNOWN", reason: `no game row for ${t} in week ${week} (bye or not covered by this source)` };
  } };
}

/** Integrity check for one game row against a schedule: does the row's own (team, opponent) agree with the schedule? Used as an adversarial validator. */
export function gameRowConsistency(o: TeamObservation, schedule: ScheduleSource): "CONSISTENT" | "OPPONENT_MISMATCH" | "SCHEDULE_UNKNOWN" | "NOT_A_GAME_ROW" {
  if (o.granularity !== "GAME_OBSERVED" || !o.team || o.week == null || !o.opponent) return "NOT_A_GAME_ROW";
  const s = schedule.opponentOf(o.team, o.season, o.week); return s.kind === "GAME" ? (s.opponent === o.opponent ? "CONSISTENT" : "OPPONENT_MISMATCH") : "SCHEDULE_UNKNOWN";
}
