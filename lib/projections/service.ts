/**
 * HTTP-facing orchestration for the projection endpoints. Keeps the route
 * handlers thin and keeps all "fetch league config / manager roster from
 * Sleeper, then call the right build layer" logic in one place.
 */

import { getLeague, getLeagueRosters, getPlayerIndex } from "@/lib/sleeper/client";
import {
  buildBaseProjections,
  buildLeagueProjections,
  buildManagerView,
  PROJECTION_VERSION,
  type BaseProjectionResult,
  type LeagueProjectionResult,
} from "./build";
import { PROJECTION_MODEL_VERSION, PROJECTION_SCHEMA_VERSION, type FantasyPosition, type PlayerProjection } from "./schema";
import type { ManagerRosterState } from "./manager-value";

const PROJECTION_SEASON = 2026;

export interface ProjectionMeta {
  projection_version: string;
  model_version: string;
  schema_version: string;
  season: number;
  generated_at: string;
  data_as_of: string;
  benchmark: BaseProjectionResult["benchmark"];
}

function meta(base: BaseProjectionResult): ProjectionMeta {
  return {
    projection_version: base.projection_version,
    model_version: base.model_version,
    schema_version: base.schema_version,
    season: base.season,
    generated_at: base.generated_at,
    data_as_of: base.data_as_of,
    benchmark: base.benchmark,
  };
}

/* -------------------------------------------------------------- base (Layer 1) */

export async function getBaseProjections(): Promise<BaseProjectionResult> {
  return buildBaseProjections({ season: PROJECTION_SEASON });
}

export interface BaseListResponse {
  meta: ProjectionMeta;
  count: number;
  reconciliation: BaseProjectionResult["reconciliation"];
  disagreement_by_position: BaseProjectionResult["disagreement_by_position"];
  players: Array<PlayerProjection & { vs_sleeper: ReturnType<typeof compactComparison> }>;
}

function compactComparison(base: BaseProjectionResult, playerId: string) {
  const c = base.comparisons.get(playerId);
  if (!c) return null;
  return {
    has_benchmark: c.has_benchmark,
    sleeper_ppr_points: c.sleeper_ppr_points,
    neutral_delta: c.neutral_delta,
    neutral_delta_pct: c.neutral_delta_pct,
    direction: c.direction,
    primary_driver: c.primary_driver,
    stat_deltas: c.stat_deltas,
  };
}

export async function buildBaseListResponse(opts: {
  position?: string | null;
  limit?: number;
}): Promise<BaseListResponse> {
  const base = await getBaseProjections();
  const pos = opts.position?.toUpperCase() as FantasyPosition | undefined;
  let players = [...base.projections.values()];
  if (pos) players = players.filter((p) => p.position === pos);
  players.sort((a, b) => b.neutral_points - a.neutral_points);
  const limit = Math.max(1, Math.min(opts.limit ?? 400, 2000));
  return {
    meta: meta(base),
    count: players.length,
    reconciliation: base.reconciliation,
    disagreement_by_position: base.disagreement_by_position,
    players: players.slice(0, limit).map((p) => ({
      ...p,
      vs_sleeper: compactComparison(base, p.player_id),
    })),
  };
}

export async function buildSinglePlayerResponse(playerId: string): Promise<
  | { ok: true; meta: ProjectionMeta; projection: PlayerProjection; vs_sleeper: ReturnType<typeof compactComparison> }
  | { ok: false }
> {
  const base = await getBaseProjections();
  const projection = base.projections.get(playerId);
  if (!projection) return { ok: false };
  return { ok: true, meta: meta(base), projection, vs_sleeper: compactComparison(base, playerId) };
}

/* ------------------------------------------------------------ league (Layer 2) */

export interface ResolvedLeagueConfig {
  league_slug: string;
  league_id: string;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
  num_teams: number;
}

export async function loadLeagueConfig(
  leagueSlug: string,
  leagueId: string,
): Promise<ResolvedLeagueConfig> {
  const league = await getLeague(leagueId);
  const rosters = await getLeagueRosters(leagueId).catch(() => []);
  return {
    league_slug: leagueSlug,
    league_id: leagueId,
    scoring_settings: league.scoring_settings ?? {},
    roster_positions: league.roster_positions ?? [],
    num_teams: league.total_rosters ?? rosters.length ?? 12,
  };
}

export async function buildLeagueResponse(
  cfg: ResolvedLeagueConfig,
  opts: { position?: string | null; limit?: number } = {},
): Promise<{
  meta: ProjectionMeta;
  league: { league_slug: string; league_id: string; scoring_hash: string; num_teams: number; roster_positions: string[] };
  replacement_levels: LeagueProjectionResult["replacement_levels"];
  positional_scarcity: LeagueProjectionResult["positional_scarcity"];
  cache_key: string;
  count: number;
  players: LeagueProjectionResult["projections"];
}> {
  const base = await getBaseProjections();
  const league = buildLeagueProjections(base, cfg);
  const pos = opts.position?.toUpperCase() as FantasyPosition | undefined;
  let players = league.projections;
  if (pos) players = players.filter((p) => p.position === pos);
  const limit = Math.max(1, Math.min(opts.limit ?? 400, 2000));
  return {
    meta: meta(base),
    league: {
      league_slug: cfg.league_slug,
      league_id: cfg.league_id,
      scoring_hash: league.scoring_hash,
      num_teams: cfg.num_teams,
      roster_positions: cfg.roster_positions,
    },
    replacement_levels: league.replacement_levels,
    positional_scarcity: league.positional_scarcity,
    cache_key: league.cache_key,
    count: players.length,
    players: players.slice(0, limit),
  };
}

export async function buildLeaguePlayerResponse(
  cfg: ResolvedLeagueConfig,
  playerId: string,
): Promise<
  | { ok: true; meta: ProjectionMeta; scoring_hash: string; league_projection: LeagueProjectionResult["projections"][number]; football_projection: PlayerProjection }
  | { ok: false }
> {
  const base = await getBaseProjections();
  const football = base.projections.get(playerId);
  if (!football) return { ok: false };
  const league = buildLeagueProjections(base, cfg);
  const lp = league.projections.find((p) => p.player_id === playerId);
  if (!lp) return { ok: false };
  return { ok: true, meta: meta(base), scoring_hash: league.scoring_hash, league_projection: lp, football_projection: football };
}

/* ----------------------------------------------------------- manager (Layer 3) */

export interface ManagerRouteInputs {
  league_slug: string;
  league_id: string;
  sleeper_user_id: string;
  roster_id: number;
  draft_id: string | null;
}

export async function buildManagerProjectionResponse(
  m: ManagerRouteInputs,
  opts: { limit?: number } = {},
): Promise<{
  meta: ProjectionMeta;
  manager: { sleeper_user_id: string; roster_id: number; draft_id: string | null };
  scoring_hash: string;
  cache_key: string;
  needs: ReturnType<typeof buildManagerView>["needs"];
  count: number;
  values: ReturnType<typeof buildManagerView>["values"];
}> {
  const cfg = await loadLeagueConfig(m.league_slug, m.league_id);
  const base = await getBaseProjections();
  const league = buildLeagueProjections(base, cfg);

  const rosters = await getLeagueRosters(m.league_id);
  const mine = rosters.find((r) => r.roster_id === m.roster_id);
  const owned = (mine?.players ?? []).filter((p): p is string => typeof p === "string" && p !== "0");

  const playerIndex = await getPlayerIndex();
  const positionByPlayer = new Map<string, FantasyPosition | null>();
  for (const pid of owned) {
    const p = playerIndex.get(pid);
    const raw = (p?.position ?? "") as FantasyPosition;
    positionByPlayer.set(pid, ["QB", "RB", "WR", "TE", "K", "DEF"].includes(raw) ? raw : null);
  }

  const state: ManagerRosterState = {
    league_id: m.league_id,
    sleeper_user_id: m.sleeper_user_id,
    roster_id: m.roster_id,
    draft_id: m.draft_id,
    draft_state: null,
    owned_player_ids: owned,
    roster_positions: cfg.roster_positions,
    position_by_player: positionByPlayer,
  };

  const view = buildManagerView(base, league, state);
  const limit = Math.max(1, Math.min(opts.limit ?? 300, 1000));
  return {
    meta: meta(base),
    manager: { sleeper_user_id: m.sleeper_user_id, roster_id: m.roster_id, draft_id: m.draft_id },
    scoring_hash: league.scoring_hash,
    cache_key: view.cache_key,
    needs: view.needs,
    count: view.values.length,
    values: view.values.slice(0, limit),
  };
}

export const PROJECTION_IDENTITY = {
  projection_version: PROJECTION_VERSION,
  model_version: PROJECTION_MODEL_VERSION,
  schema_version: PROJECTION_SCHEMA_VERSION,
  season: PROJECTION_SEASON,
};
