/**
 * Pure assembly of calibration cases for one (season, week). All I/O (Supabase / Sleeper / ESPN) lives in
 * materialize.ts; this file is deterministic given its inputs so every rule is unit-testable and re-runnable.
 */
import { createHash } from "node:crypto";
import { gameForTeam, opponentOf } from "./games";
import { selectPregameEvidence } from "./evidence-selection";
import { caseErrors, rangeResult } from "./metrics";
import { classifyParticipation, scoringExactness, statsDigest, translateActual, TEAM_STAT_COVERAGE_MIN_ROWS, OUT_INJURY } from "./outcome";
import { selectPregameWeather, type WeatherSnapshotRow } from "./weather";
import { CALIBRATION_LEDGER_VERSION, type CalibrationCase, type EvidenceStatus, type FootballOutcome, type NflGame, type ProjectionCandidate, type ScoringExactness } from "./types";

export interface LeagueScoringInput { league_slug: string; provider: string; scoring_fingerprint: string | null; raw_scoring: Record<string, number> | null; note?: string }
export interface PlayerIdentity { canonical_player_id: string; sleeper_id: string | null; provider_ids: Record<string, string>; name: string | null; position: string | null; nfl_team: string | null; resolved: boolean }
export interface WeekActualsLike { clean: ReadonlyMap<string, Record<string, number>>; raw: ReadonlyMap<string, Record<string, number>> }
export interface ExistingCaseHead { evidence_digest: string; revision: number }

export interface BuildWeekInput {
  season: number; week: number; now: string; stats_source: string;
  games: readonly NflGame[];
  leagues: readonly LeagueScoringInput[];
  identities: ReadonlyMap<string, PlayerIdentity>;
  /** key `${league_slug}|${canonical_player_id}` -> every projection candidate that could be evidence for that league's player */
  candidates: ReadonlyMap<string, readonly ProjectionCandidate[]>;
  actuals: WeekActualsLike | null;
  weather: readonly WeatherSnapshotRow[];
  existing: ReadonlyMap<string, ExistingCaseHead>;
}
export interface BuildWeekResult {
  cases: CalibrationCase[]; football_outcomes: FootballOutcome[];
  unchanged: number; skipped_no_signal: number; skipped_game_not_final: number; skipped_no_game: number; revisions_of_existing: number;
}

const sha = (s: string, n: number): string => createHash("sha256").update(s).digest("hex").slice(0, n);
export const caseId = (season: number, week: number, gameId: string, canonical: string, league: string, fp: string): string => `cc:${sha(`${season}|${week}|${gameId}|${canonical}|${league}|${fp}`, 24)}`;
const isFinal = (g: NflGame): boolean => g.status === "complete";
const isCancelled = (g: NflGame): boolean => /^(postponed|cancel+ed)$/.test(g.status);

export function buildWeekCases(input: BuildWeekInput): BuildWeekResult {
  const out: BuildWeekResult = { cases: [], football_outcomes: [], unchanged: 0, skipped_no_signal: 0, skipped_game_not_final: 0, skipped_no_game: 0, revisions_of_existing: 0 };

  // Team stat coverage: how many mapped players per team actually have a provider row (distinguishes DNP from a provider gap).
  const teamRows = new Map<string, number>();
  if (input.actuals) for (const id of input.identities.values()) if (id.sleeper_id && input.actuals.raw.has(id.sleeper_id.toUpperCase()) && id.nfl_team) teamRows.set(id.nfl_team, (teamRows.get(id.nfl_team) ?? 0) + 1);

  const outcomeById = new Map<string, FootballOutcome>();
  const identityIds = [...input.identities.keys()].sort();

  for (const league of input.leagues) {
    for (const canonical of identityIds) {
      const ident = input.identities.get(canonical)!;
      const cands = input.candidates.get(`${league.league_slug}|${canonical}`) ?? [];
      const team = cands.find((c) => c.nfl_team)?.nfl_team ?? ident.nfl_team;
      const game = gameForTeam(input.games, team);
      if (!game || !team) { out.skipped_no_game++; continue; }
      if (!isFinal(game) && !isCancelled(game)) { out.skipped_game_not_final++; continue; }

      const sel = selectPregameEvidence(cands, game.kickoff_at);
      const sid = ident.sleeper_id?.toUpperCase() ?? null;
      const raw = input.actuals && sid ? input.actuals.raw.get(sid) : undefined;
      const clean = input.actuals && sid ? input.actuals.clean.get(sid) : undefined;
      const hasStats = !!raw && Object.keys(raw).length > 0;
      const positionForScoring = sel.chosen?.position ?? ident.position;
      // A player with neither a pre-kickoff projection nor a stat row is not an eligible player-game (never projected, never played).
      if (!sel.chosen && !hasStats && !cands.some((c) => c.projected_points != null)) { out.skipped_no_signal++; continue; }

      const chosen = sel.chosen;
      const fp = chosen?.scoring_fingerprint ?? league.scoring_fingerprint ?? "unavailable";
      const cid = caseId(input.season, input.week, game.nfl_game_id, canonical, league.league_slug, fp);
      const notes: string[] = [];

      // ---- football reality (league independent) ----------------------------------------------------------------
      let fo: FootballOutcome | null = null;
      if (input.actuals) {
        const digest = statsDigest(hasStats, raw);
        const oid = `fo:${sha(`${input.season}|${input.week}|${canonical}|${digest}`, 24)}`;
        fo = outcomeById.get(oid) ?? {
          outcome_id: oid, season: input.season, week: input.week, nfl_game_id: game.nfl_game_id, canonical_player_id: canonical,
          provider_player_ids: ident.provider_ids, nfl_team: team, stat_row_present: hasStats, raw_stats: raw ?? {}, stats_digest: digest,
          stats_source: input.stats_source, stats_fetched_at: input.now,
        };
        outcomeById.set(oid, fo);
      }

      // ---- participation + actual translation -------------------------------------------------------------------
      const injury = chosen?.injury_status ?? null;
      const part = input.actuals || isCancelled(game)
        ? classifyParticipation({ position: positionForScoring, game_status: game.status, raw, injury_status_at_projection: injury })
        : { state: "UNKNOWN" as const, note: "stats source unavailable" };
      if (part.note) notes.push(part.note);

      let actual: number | null = null, basis: string | null = null, actualExact: ScoringExactness | null = null, actualWarnings: string[] = [];
      let status: EvidenceStatus;
      const identityResolved = ident.resolved;

      if (!identityResolved) status = "UNRESOLVED_IDENTITY";
      else if (isCancelled(game)) status = "GAME_NOT_PLAYED";
      else if (!input.actuals) status = "ACTUAL_SCORING_UNAVAILABLE";
      else if (!league.raw_scoring || !league.scoring_fingerprint) { status = "ACTUAL_SCORING_UNAVAILABLE"; notes.push(league.note ?? "league scoring unavailable for this league/provider"); }
      else if (chosen && chosen.scoring_fingerprint !== league.scoring_fingerprint) {
        status = "SCORING_FINGERPRINT_MISMATCH";
        notes.push(`projection artifact scored under ${chosen.scoring_fingerprint}, league scoring is now ${league.scoring_fingerprint}; actual not translated`);
      } else {
        const t = translateActual({ position: positionForScoring, clean, raw, rawScoring: league.raw_scoring, teamCovered: (teamRows.get(team) ?? 0) >= TEAM_STAT_COVERAGE_MIN_ROWS });
        actual = t.points; basis = t.basis; actualExact = t.points == null ? null : t.exactness; actualWarnings = t.warnings;
        if (actual == null) status = "ACTUAL_SCORING_UNAVAILABLE";
        else if (!chosen) status = "NO_PREKICKOFF_PROJECTION";
        else status = (chosen.scoring_exactness !== "LEAGUE_EXACT" || t.exactness !== "LEAGUE_EXACT") ? "CERTIFIED_APPROXIMATE_SCORING" : "CERTIFIED";
      }
      if (status === "ACTUAL_SCORING_UNAVAILABLE" && !chosen) notes.push("no certified pre-kickoff projection either");
      if (!chosen) notes.push(sel.rejected_not_before_kickoff ? `${sel.rejected_not_before_kickoff} candidate(s) recorded at/after this game's kickoff were rejected (no hindsight)` : "no projection artifact existed for this player-game");

      // ---- deterministic math (only for certified cases) ---------------------------------------------------------
      const certified = status === "CERTIFIED" || status === "CERTIFIED_APPROXIMATE_SCORING";
      const errs = certified && chosen && actual != null ? caseErrors(chosen.projected_points!, actual) : null;
      const range = rangeResult(certified ? actual : null, chosen?.floor_points ?? null, chosen?.ceiling_points ?? null);
      if (certified && range.range_status === "RANGE_UNAVAILABLE") notes.push("no floor/ceiling on this evidence artifact");
      if (OUT_INJURY.test(injury ?? "") && part.state !== "INACTIVE" && part.state !== "DID_NOT_PLAY") notes.push(`injury status at projection: ${injury}`);

      const weather = selectPregameWeather(input.weather, game);
      const digest = sha(JSON.stringify([
        CALIBRATION_LEDGER_VERSION, cid, game.kickoff_at,
        chosen ? [chosen.kind, chosen.artifact_id, chosen.content_hash, chosen.projected_points, chosen.floor_points, chosen.ceiling_points] : null,
        fo?.stats_digest ?? null, actual, basis, part.state, status, weather?.snapshot_id ?? null,
      ]), 16);
      const ex = input.existing.get(cid);
      if (ex?.evidence_digest === digest) { out.unchanged++; continue; }
      if (ex) out.revisions_of_existing++;

      out.cases.push({
        case_id: cid, evidence_digest: digest, revision: ex ? ex.revision + 1 : 1, supersedes_evidence_digest: ex?.evidence_digest ?? null, ledger_version: CALIBRATION_LEDGER_VERSION,
        season: input.season, week: input.week, nfl_game_id: game.nfl_game_id, kickoff_at: game.kickoff_at, kickoff_source: game.kickoff_source,
        canonical_player_id: canonical, provider_player_ids: ident.provider_ids, player_name: ident.name, nfl_team: team, opponent: opponentOf(game, team), position: positionForScoring,
        league_slug: league.league_slug, provider: league.provider, scoring_fingerprint: fp,
        projection_artifact_kind: chosen?.kind ?? null, projection_artifact_id: chosen?.artifact_id ?? null, projection_content_hash: chosen?.content_hash ?? null,
        projection_request_fingerprint: chosen?.request_fingerprint ?? null, projection_recorded_at: chosen?.recorded_at ?? null,
        projection_source: chosen?.source ?? null, projection_model_version: chosen?.model_version ?? null,
        projected_points: chosen?.projected_points ?? null, projected_floor: chosen?.floor_points ?? null, projected_ceiling: chosen?.ceiling_points ?? null, projected_std_dev: chosen?.std_dev ?? null,
        expected_availability: chosen?.expected_availability ?? null, injury_status_at_projection: injury, projection_warnings: chosen?.warnings ?? [],
        projection_scoring_exactness: chosen ? chosen.scoring_exactness : null,
        projection_selection: { rule: sel.rule, considered: sel.considered, rejected_not_before_kickoff: sel.rejected_not_before_kickoff, rejected_invalid: sel.rejected_invalid, ...(chosen?.detail ?? {}) },
        weather_snapshot_id: weather?.snapshot_id ?? null, weather_evidence: weather,
        football_outcome_id: fo?.outcome_id ?? null, stats_digest: fo?.stats_digest ?? null,
        participation_state: part.state, actual_fantasy_points: actual, actual_scoring_basis: basis, actual_scoring_exactness: actualExact, actual_warnings: actualWarnings,
        error: errs?.error ?? null, abs_error: errs?.abs_error ?? null, squared_error: errs?.squared_error ?? null, ...range,
        evidence_status: status, evidence_notes: notes, generated_at: input.now,
      });
    }
  }
  out.football_outcomes = [...outcomeById.values()];
  return out;
}
export { scoringExactness };
