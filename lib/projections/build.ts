/**
 * Projection build orchestrator.
 *
 * Layer 1 (this file's `buildBaseProjections`): scoring-neutral, league-agnostic,
 * manager-agnostic. Built once per (season, projection_version) and cached in
 * module scope. Sleeper projections are loaded here as a BENCHMARK only and are
 * never fed into the RI model.
 *
 * Layer 2 (`buildLeagueProjections`): translate the cached base through one
 * league's scoring + derive replacement/VOR/tiers. Cache key adds
 * `league_id + scoring_hash`.
 *
 * Layer 3 (`buildManagerView`): need-weight one league's pool for one manager.
 * Cache key adds `sleeper_user_id + draft_id/state`.
 */

import { getPlayerIndex } from "@/lib/sleeper/client";
import { isCurrentlyDraftable } from "@/lib/sleeper/eligibility";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import {
  PROJECTION_MODEL_VERSION,
  PROJECTION_SCHEMA_VERSION,
  type FantasyPosition,
  type LeagueProjection,
  type ManagerProjectionValue,
  type PlayerProjection,
} from "./schema";
import { loadSeasonActuals, type SeasonActuals } from "./actuals";
import { loadSleeperSeasonProjections, type SleeperProjectionSource } from "./sleeper";
import { aggregateHistory, buildTeamEnvironment, projectTeamOffense, type TeamEnvironment } from "./model";
import { analyticBand, confidenceBucket } from "./uncertainty";
import { CALIBRATION_V3, effectiveSample, type CalibrationProfile } from "./baselines";
import { reconcileTeam, normalizeTeamVolume, summarizeReconciliation, type TeamReconciliation, type ReconciliationReport } from "./reconcile";
import { comparePlayer, aggregateDisagreement, foldDisagreementIntoConfidence, type PlayerComparison, type PositionDisagreement } from "./compare";
import { leagueScoringContext, buildLeagueProjection, type LeagueScoringContext } from "./league";
import { computeReplacementLevels, applyValueOverReplacement, positionalScarcity, type PositionalScarcity } from "./replacement";
import { buildManagerProjectionValues, type ManagerRosterState } from "./manager-value";

export const PROJECTION_VERSION = "2026.3.0";
const HISTORY_SEASONS = [2021, 2022, 2023, 2024, 2025];
const SKILL: FantasyPosition[] = ["QB", "RB", "WR", "TE"];

/* -------------------------------------------------------------- base result */

export interface BaseProjectionResult {
  projection_version: string;
  model_version: string;
  schema_version: string;
  season: number;
  generated_at: string;
  data_as_of: string;

  projections: Map<string, PlayerProjection>;
  team_environments: Map<string, TeamEnvironment>;

  /** Sleeper benchmark diagnostics (never a model input). */
  benchmark: {
    provider: "sleeper";
    role: "BENCHMARK_ONLY";
    status: SleeperProjectionSource["status"];
    players_returned: number;
    players_usable: number;
    players_matched: number;
    players_unmatched: number;
    coverage_by_position: Record<string, number>;
    source_updated_at_range: [string | null, string | null];
    retrieved_at: string;
    source_schema_version: string;
    missing_expected_keys: string[];
    warnings: string[];
  };

  comparisons: Map<string, PlayerComparison>;
  disagreement_by_position: PositionDisagreement[];
  reconciliation: ReconciliationReport;
  reconciliation_raw: ReconciliationReport;
  reconciliation_rows: TeamReconciliation[];

  warnings: string[];
}

let baseCache: { key: string; value: BaseProjectionResult } | null = null;

export function baseCacheKey(season: number, calibrationId: string = CALIBRATION_V3.id): string {
  return `base:${season}:${PROJECTION_VERSION}:${PROJECTION_MODEL_VERSION}:${calibrationId}`;
}
export function leagueCacheKey(season: number, leagueId: string, scoringHash: string): string {
  return `league:${season}:${PROJECTION_VERSION}:${leagueId}:${scoringHash}`;
}
export function managerCacheKey(
  season: number,
  leagueId: string,
  scoringHash: string,
  sleeperUserId: string,
  draftKey: string,
): string {
  return `manager:${season}:${PROJECTION_VERSION}:${leagueId}:${scoringHash}:${sleeperUserId}:${draftKey}`;
}

export interface BuildOptions {
  season?: number;
  /** skip the Sleeper benchmark fetch (used by deterministic tests) */
  skipBenchmark?: boolean;
  /** inject actuals + player index for deterministic tests */
  fixtures?: {
    playerIndex: ReadonlyMap<string, NormalizedPlayer>;
    seasons: SeasonActuals[];
    benchmark?: SleeperProjectionSource;
  };
  /** apply team-volume normalization after reconciliation (default true) */
  normalize?: boolean;
  /** calibration profile (default = live v2); only the v1↔v2 audit overrides it. */
  calibration?: CalibrationProfile;
  force?: boolean;
}

export async function buildBaseProjections(opts: BuildOptions = {}): Promise<BaseProjectionResult> {
  const season = opts.season ?? 2026;
  const calibration = opts.calibration ?? CALIBRATION_V3;
  const key = baseCacheKey(season, calibration.id);
  if (!opts.force && !opts.fixtures && baseCache?.key === key) return baseCache.value;

  const warnings: string[] = [];
  const generatedAt = new Date().toISOString();

  const playerIndex = opts.fixtures?.playerIndex ?? (await getPlayerIndex());

  const positionByPlayer = new Map<string, { position: string | null; team: string | null }>();
  for (const [pid, p] of playerIndex) {
    positionByPlayer.set(pid, { position: p.position, team: p.team });
  }

  // --- historical actuals ---
  let seasons: SeasonActuals[];
  if (opts.fixtures) {
    seasons = opts.fixtures.seasons;
  } else {
    seasons = [];
    for (const y of HISTORY_SEASONS) {
      try {
        seasons.push(await loadSeasonActuals(y, positionByPlayer));
      } catch (e) {
        warnings.push(`historical actuals for ${y} unavailable: ${errMsg(e)}`);
      }
    }
  }
  if (seasons.length === 0) {
    warnings.push("NO historical actuals loaded — projections fall back to position baselines only");
  }

  // --- per-player history aggregation ---
  const historyByPlayer = new Map<string, ReturnType<typeof aggregateHistory>>();
  const seasonsByPlayer = new Map<string, Parameters<typeof aggregateHistory>[0]>();
  for (const sa of seasons) {
    for (const [pid, row] of sa.players) {
      if (!seasonsByPlayer.has(pid)) seasonsByPlayer.set(pid, []);
      seasonsByPlayer.get(pid)!.push(row);
    }
  }
  for (const [pid, rows] of seasonsByPlayer) {
    historyByPlayer.set(pid, aggregateHistory(rows));
  }

  // --- group active skill players by NFL team ---
  // Same eligibility gate as the draft pool (active + on an NFL team + supported
  // position), then narrowed to the offensive skill positions the model covers.
  const byTeam = new Map<string, NormalizedPlayer[]>();
  for (const [, p] of playerIndex) {
    if (!isCurrentlyDraftable(p)) continue;
    const pos = (p.position ?? "") as FantasyPosition;
    if (!SKILL.includes(pos)) continue;
    if (!byTeam.has(p.team!)) byTeam.set(p.team!, []);
    byTeam.get(p.team!)!.push(p);
  }

  const projections = new Map<string, PlayerProjection>();
  const teamEnvironments = new Map<string, TeamEnvironment>();
  const reconciliationRows: TeamReconciliation[] = [];
  const rawReconciliationRows: TeamReconciliation[] = [];

  const compactHistory = new Map<string, NonNullable<ReturnType<typeof aggregateHistory>>>();
  for (const [pid, h] of historyByPlayer) if (h) compactHistory.set(pid, h);

  for (const [team, players] of byTeam) {
    const teamProjs = projectTeamOffense({
      team,
      players,
      historyByPlayer: compactHistory,
      historicalSeasons: seasons,
      season,
      dataAsOf: seasons.map((s) => s.season).join(","),
      calibration,
    });

    // team environment (recomputed here for the reconciliation report)
    const qb1 = players
      .filter((p) => p.position === "QB")
      .sort((a, b) => (a.depth_chart_order ?? 9) - (b.depth_chart_order ?? 9))[0];
    const qb1Hist = qb1 ? compactHistory.get(qb1.player_id) : undefined;
    const qbTransition = !qb1Hist || (qb1?.years_exp ?? 0) === 0;
    const env = buildTeamEnvironment(team, seasons, qbTransition);
    teamEnvironments.set(team, env);

    // uncertainty + confidence per player
    for (const pr of teamProjs) {
      const h = compactHistory.get(pr.player_id);
      const eff = h ? effectiveSample(h.seasons) : 0;
      const band = analyticBand({
        position: pr.position,
        median: pr.neutral_points,
        is_rookie: pr.confidence.is_rookie,
        snap_share: pr.components.snap_share,
        td_points: pr.components.td_component,
        expected_games: pr.availability.expected_games,
        games_if_healthy: pr.availability.games_if_healthy,
      });
      pr.outcome = band;
      const conf = confidenceBucket({
        position: pr.position,
        sample_seasons: pr.confidence.sample_seasons,
        effective_sample: eff,
        is_rookie: pr.confidence.is_rookie,
        team_changed: pr.confidence.team_changed,
        injury_flagged: pr.confidence.injury_flagged,
        snap_share: pr.components.snap_share,
        role_locked:
          (players.find((p) => p.player_id === pr.player_id)?.depth_chart_order ?? 9) === 1 ||
          (pr.components.snap_share ?? 0) >= 0.75,
      });
      pr.confidence.bucket = conf.bucket;
      pr.confidence.score = conf.score;
      pr.confidence.reasons = conf.reasons;
      projections.set(pr.player_id, pr);
    }

    const rawRecs = reconcileTeam(env, teamProjs);
    if (opts.normalize !== false) {
      normalizeTeamVolume(teamProjs, rawRecs);
      // re-band after normalization
      for (const pr of teamProjs) {
        pr.outcome = analyticBand({
          position: pr.position,
          median: pr.neutral_points,
          is_rookie: pr.confidence.is_rookie,
          snap_share: pr.components.snap_share,
          td_points: pr.components.td_component,
          expected_games: pr.availability.expected_games,
          games_if_healthy: pr.availability.games_if_healthy,
        });
      }
    }
    // Report the RESIDUAL reconciliation (post-normalization when it ran).
    reconciliationRows.push(...reconcileTeam(env, teamProjs));
    rawReconciliationRows.push(...rawRecs);
  }

  const reconciliation = summarizeReconciliation(season, reconciliationRows, opts.normalize !== false);
  const rawReconciliation = summarizeReconciliation(season, rawReconciliationRows, false);
  if (rawReconciliation.hard_misses.length > 0) {
    warnings.push(
      `${rawReconciliation.hard_misses.length} pre-normalization reconciliation HARD misses (raw model); ` +
        `${reconciliation.hard_misses.length} residual after normalization`,
    );
  }

  // --- Sleeper benchmark (BENCHMARK_ONLY) ---
  let benchSource: SleeperProjectionSource | null = null;
  if (!opts.skipBenchmark) {
    benchSource = opts.fixtures?.benchmark ?? (await loadSleeperSeasonProjections(season));
  }

  const comparisons = new Map<string, PlayerComparison>();
  let matched = 0;
  if (benchSource) {
    for (const [pid, pr] of projections) {
      const b = benchSource.projections.get(pid);
      if (b) matched++;
      const c = comparePlayer(pr, b);
      comparisons.set(pid, c);
    }
    foldDisagreementIntoConfidence([...projections.values()], comparisons);
  } else {
    warnings.push("Sleeper benchmark skipped — no RI-vs-Sleeper comparison in this build");
  }

  const disagreement = aggregateDisagreement([...comparisons.values()]);

  const result: BaseProjectionResult = {
    projection_version: PROJECTION_VERSION,
    model_version: PROJECTION_MODEL_VERSION,
    schema_version: PROJECTION_SCHEMA_VERSION,
    season,
    generated_at: generatedAt,
    data_as_of: seasons.map((s) => s.season).join(",") || "none",
    projections,
    team_environments: teamEnvironments,
    benchmark: {
      provider: "sleeper",
      role: "BENCHMARK_ONLY",
      status: benchSource?.status ?? "UNAVAILABLE",
      players_returned: benchSource?.players_returned ?? 0,
      players_usable: benchSource?.players_usable ?? 0,
      players_matched: matched,
      players_unmatched: (benchSource?.players_usable ?? 0) - matched,
      coverage_by_position: benchSource?.coverage_by_position ?? {},
      source_updated_at_range: benchSource?.source_updated_at_range ?? [null, null],
      retrieved_at: benchSource?.retrieved_at ?? generatedAt,
      source_schema_version: benchSource?.source_schema_version ?? "unknown",
      missing_expected_keys: benchSource?.missing_expected_keys ?? [],
      warnings: benchSource?.warnings ?? ["benchmark not fetched"],
    },
    comparisons,
    disagreement_by_position: disagreement,
    reconciliation,
    reconciliation_raw: rawReconciliation,
    reconciliation_rows: reconciliationRows,
    warnings,
  };

  if (!opts.fixtures) baseCache = { key, value: result };
  return result;
}

/* ------------------------------------------------------------ Layer 2 build */

export interface LeagueConfig {
  league_slug: string;
  league_id: string;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
  num_teams: number;
}

export interface LeagueProjectionResult {
  cache_key: string;
  league_slug: string;
  league_id: string;
  scoring_hash: string;
  projection_version: string;
  generated_at: string;
  projections: LeagueProjection[];
  positional_scarcity: PositionalScarcity[];
  replacement_levels: ReturnType<typeof computeReplacementLevels>;
  warnings: string[];
}

const leagueCache = new Map<string, LeagueProjectionResult>();

export function buildLeagueProjections(
  base: BaseProjectionResult,
  cfg: LeagueConfig,
  opts: { force?: boolean } = {},
): LeagueProjectionResult {
  const ctx: LeagueScoringContext = leagueScoringContext(cfg.league_slug, cfg.league_id, cfg.scoring_settings);
  const key = leagueCacheKey(base.season, cfg.league_id, ctx.scoring_hash);
  const cached = leagueCache.get(key);
  if (cached && !opts.force) return cached;

  const warnings: string[] = [];
  const pool: LeagueProjection[] = [];
  for (const [pid, pr] of base.projections) {
    const bench = base.comparisons.get(pid);
    const sleeperStats = bench?.has_benchmark ? sleeperStatsFor(base, pid) : null;
    const lp = buildLeagueProjection(pr, ctx, sleeperStats);
    const cmp = base.comparisons.get(pid);
    if (cmp) lp.vs_sleeper.primary_driver = cmp.primary_driver;
    pool.push(lp);
  }

  const levels = computeReplacementLevels(cfg.roster_positions, cfg.num_teams, pool);
  applyValueOverReplacement(pool, levels);

  // RI vs Sleeper ranks under this league's scoring
  rankVsSleeper(pool);

  const scarcity = positionalScarcity(pool, levels, cfg.num_teams);

  const result: LeagueProjectionResult = {
    cache_key: key,
    league_slug: cfg.league_slug,
    league_id: cfg.league_id,
    scoring_hash: ctx.scoring_hash,
    projection_version: PROJECTION_VERSION,
    generated_at: new Date().toISOString(),
    projections: pool.sort((a, b) => (b.value_over_replacement ?? -1e9) - (a.value_over_replacement ?? -1e9)),
    positional_scarcity: scarcity,
    replacement_levels: levels,
    warnings,
  };
  leagueCache.set(key, result);
  return result;
}

function sleeperStatsFor(base: BaseProjectionResult, playerId: string) {
  // The comparison object carries Sleeper's numbers only as deltas; the raw
  // Sleeper stat line lives on the benchmark source, which is not retained past
  // the base build. For Layer-2 apples-to-apples we reconstruct the minimal
  // stat object from the comparison deltas + RI stats.
  const cmp = base.comparisons.get(playerId);
  const pr = base.projections.get(playerId);
  if (!cmp || !pr || !cmp.has_benchmark) return null;
  const s = { ...pr.stats };
  for (const d of cmp.stat_deltas) {
    if (d.sleeper == null) continue;
    if (d.stat in s) (s as Record<string, number | null>)[d.stat] = d.sleeper;
  }
  return s;
}

function rankVsSleeper(pool: LeagueProjection[]): void {
  const withRi = pool.slice().sort((a, b) => b.league_points - a.league_points);
  withRi.forEach((p, i) => (p.vs_sleeper.ri_rank = i + 1));
  const withSl = pool
    .filter((p) => p.sleeper_league_points != null)
    .sort((a, b) => (b.sleeper_league_points ?? 0) - (a.sleeper_league_points ?? 0));
  withSl.forEach((p, i) => (p.vs_sleeper.sleeper_rank = i + 1));
  for (const p of pool) {
    if (p.vs_sleeper.ri_rank != null && p.vs_sleeper.sleeper_rank != null) {
      p.vs_sleeper.rank_delta = p.vs_sleeper.sleeper_rank - p.vs_sleeper.ri_rank;
    }
  }
}

/* ------------------------------------------------------------ Layer 3 build */

export interface ManagerViewResult {
  cache_key: string;
  league_id: string;
  sleeper_user_id: string;
  roster_id: number;
  draft_key: string;
  projection_version: string;
  generated_at: string;
  needs: ReturnType<typeof buildManagerProjectionValues>["needs"];
  values: ManagerProjectionValue[];
}

const managerCache = new Map<string, ManagerViewResult>();

export function buildManagerView(
  base: BaseProjectionResult,
  league: LeagueProjectionResult,
  state: ManagerRosterState,
  opts: { force?: boolean } = {},
): ManagerViewResult {
  const draftKey = `${state.draft_id ?? "none"}:${state.draft_state ?? "none"}:${state.owned_player_ids.length}`;
  const key = managerCacheKey(base.season, state.league_id, league.scoring_hash, state.sleeper_user_id, draftKey);
  const cached = managerCache.get(key);
  if (cached && !opts.force) return cached;

  const { needs, values } = buildManagerProjectionValues(state, league.projections, base.comparisons);
  const result: ManagerViewResult = {
    cache_key: key,
    league_id: state.league_id,
    sleeper_user_id: state.sleeper_user_id,
    roster_id: state.roster_id,
    draft_key: draftKey,
    projection_version: PROJECTION_VERSION,
    generated_at: new Date().toISOString(),
    needs,
    values,
  };
  managerCache.set(key, result);
  return result;
}

export function clearProjectionCaches(): void {
  baseCache = null;
  leagueCache.clear();
  managerCache.clear();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
