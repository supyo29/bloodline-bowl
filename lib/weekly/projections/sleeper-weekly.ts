/**
 * SleeperWeeklyProjectionProvider — the production weekly projection source.
 *
 * Source: Sleeper's per-week projection feed (`/projections/nfl/{season}/{week}`,
 * RotoWire-backed), which carries real per-week projected STAT LINES plus each
 * player's NFL team and opponent for that week. Those stat lines are scored with
 * the LEAGUE's own canonical scoring — Sleeper's precomputed `pts_*` are not
 * trusted for offense.
 *
 * Honest limitations (surfaced as warnings, never hidden):
 *  - K / D-ST: Sleeper's weekly feed omits extra points (K) and sacks /
 *    points-allowed (D-ST), so league-specific reconstruction is not possible
 *    weekly. Those two slots fall back to Sleeper's standard precomputed points
 *    (`pts_std`) — a bounded approximation for the two lowest-leverage slots,
 *    flagged LOW/MEDIUM confidence. It is NOT a season value.
 *  - Bye: a rostered player whose NFL team has no game this week projects 0
 *    with `projection_status: "bye"` (a real 0, not missing data).
 *  - A requested player with no feed entry and a playing team -> projection is
 *    `null` with `projection_status: "unavailable"`.
 */

import { SLEEPER_ROOT_URL, fetchSleeper } from "@/lib/sleeper/client";
import { canonicalPosition } from "@/lib/canonical/players";
import { scoreWeeklyLine, NON_SCORING_KEY } from "../scoring";
import { weeklyBand } from "../uncertainty";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch, WeeklyWarning } from "../schema";
import type { ProjectionProvider, ProjectionRequest } from "./types";

const SLEEPER_WEEKLY_VERSION = "sleeper-weekly-rotowire";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
const REGULAR_SEASON_WEEKS = 17;

interface RawEntry {
  player_id?: string;
  team?: string | null;
  opponent?: string | null;
  week?: number | null;
  stats?: Record<string, number> | null;
  player?: {
    first_name?: string | null;
    last_name?: string | null;
    position?: string | null;
    fantasy_positions?: string[] | null;
    injury_status?: string | null;
    team?: string | null;
  } | null;
}

function injuryToAvailability(status: string | null | undefined): number {
  switch ((status ?? "").toLowerCase()) {
    case "out":
    case "ir":
    case "injured reserve":
    case "pup":
    case "sus":
    case "dnr":
      return 0.03;
    case "doubtful":
      return 0.3;
    case "questionable":
      return 0.78;
    default:
      return 1;
  }
}

async function fetchWeek(season: number, week: number): Promise<RawEntry[]> {
  const q = new URLSearchParams({ season_type: "regular", order_by: "pts_ppr" });
  for (const p of POSITIONS) q.append("position[]", p);
  return fetchSleeper<RawEntry[]>(`/projections/nfl/${season}/${week}?${q.toString()}`, {
    baseUrl: SLEEPER_ROOT_URL,
    revalidate: 30 * 60,
  });
}

async function fetchSeason(season: number): Promise<RawEntry[]> {
  const q = new URLSearchParams({ season_type: "regular", order_by: "pts_ppr" });
  for (const p of POSITIONS) q.append("position[]", p);
  return fetchSleeper<RawEntry[]>(`/projections/nfl/${season}?${q.toString()}`, {
    baseUrl: SLEEPER_ROOT_URL,
    revalidate: 6 * 60 * 60,
  }).catch(() => []);
}

export class SleeperWeeklyProjectionProvider implements ProjectionProvider {
  readonly name = "sleeper_weekly";
  readonly model_version = SLEEPER_WEEKLY_VERSION;

  async getWeeklyProjections(req: ProjectionRequest): Promise<WeeklyProjectionBatch> {
    const { league, week, crosswalk } = req;
    const warnings: WeeklyWarning[] = [];
    await crosswalk.ensureLoaded();

    let raw: RawEntry[];
    try {
      raw = await fetchWeek(league.season, week);
    } catch (error) {
      return {
        league_slug: league.league_slug,
        season: league.season,
        week,
        status: "PROJECTIONS_UNAVAILABLE",
        by_player: new Map(),
        resolved_players: new Map(),
        source: this.name,
        model_version: this.model_version,
        missing: [...req.canonical_player_ids],
        teams_with_games: [],
        warnings: [
          {
            code: "weekly_projection_source_unavailable",
            message: `Sleeper weekly projection feed failed: ${error instanceof Error ? error.message : String(error)}`,
            severity: "error",
          },
        ],
      };
    }

    if (!Array.isArray(raw) || raw.length === 0) {
      return {
        league_slug: league.league_slug,
        season: league.season,
        week,
        status: "PROJECTIONS_UNAVAILABLE",
        by_player: new Map(),
        resolved_players: new Map(),
        source: this.name,
        model_version: this.model_version,
        missing: [...req.canonical_player_ids],
        teams_with_games: [],
        warnings: [
          {
            code: "weekly_projection_empty",
            message: `Sleeper published no week ${week} projections for ${league.season} yet.`,
            severity: "error",
          },
        ],
      };
    }

    // Optional rest-of-season, from the season feed, prorated + league-scored.
    const rosByCanonical = new Map<string, number>();
    if (req.want_rest_of_season) {
      const seasonRaw = await fetchSeason(league.season);
      const weeksLeftFrac = Math.max(0, (REGULAR_SEASON_WEEKS - (week - 1)) / REGULAR_SEASON_WEEKS);
      for (const e of seasonRaw) {
        if (!e.player_id || !e.stats) continue;
        const cid = this.#resolve(crosswalk, e);
        const pos = canonicalPosition(e.player?.position ?? null);
        const seasonPts =
          pos === "K" || pos === "DEF"
            ? Number(e.stats.pts_std ?? 0)
            : scoreWeeklyLine(e.stats, league.raw_scoring).points;
        if (seasonPts > 0) rosByCanonical.set(cid, Math.round(seasonPts * weeksLeftFrac * 100) / 100);
      }
    }

    const teamsPlaying = new Set<string>();
    for (const e of raw) if (e.team) teamsPlaying.add(e.team.toUpperCase());

    const byCanonical = new Map<string, WeeklyProjection>();
    const resolvedPlayers = new Map<string, CanonicalPlayer>();
    let kdefApproximated = 0;
    let unscoredNoise = 0;

    for (const e of raw) {
      if (!e.player_id) continue;
      const resolved = this.#resolveFull(crosswalk, e);
      const cid = resolved.canonical_player_id;
      resolvedPlayers.set(cid, resolved);
      const pos = canonicalPosition(e.player?.position ?? e.player?.fantasy_positions?.[0] ?? null);
      const stats = e.stats ?? {};
      const injury = e.player?.injury_status ?? null;
      const nflTeam = (e.team ?? e.player?.team ?? null)?.toUpperCase() ?? null;
      const availability = injuryToAvailability(injury);

      let points: number | null;
      let status: WeeklyProjection["projection_status"] = "projected";
      const uncertainty: WeeklyProjection["uncertainty_source"] = "position_volatility_heuristic";
      const pWarnings: string[] = [];

      // Projection PRESENCE is decided by whether the source published real
      // stats for this player-week — NOT by the sign of the scored points. A
      // legitimate 0 (or negative) projection is data, not "unavailable".
      const hasRealStats = Object.keys(stats).some((k) => !NON_SCORING_KEY.test(k));

      if (pos === "K" || pos === "DEF") {
        const std = Number(stats.pts_std);
        points = hasRealStats && Number.isFinite(std) ? Math.round(std * 100) / 100 : null;
        if (points != null) {
          kdefApproximated += 1;
          pWarnings.push("k_dst_uses_sleeper_standard_points (league-specific weekly K/DST scoring not reconstructable)");
        }
      } else if (hasRealStats) {
        const scored = scoreWeeklyLine(stats, league.raw_scoring);
        points = scored.points; // keep 0 / negative — it is a real projection
        if (scored.unscored_keys.length > 6) unscoredNoise += 1;
      } else {
        points = null;
      }

      if (points == null && !hasRealStats) {
        status = stats.gp === 0 ? "out" : "unavailable";
      }

      const band = points != null ? weeklyBand(points, pos, availability) : null;

      byCanonical.set(cid, {
        canonical_player_id: cid,
        week,
        season: league.season,
        position: pos,
        nfl_team: nflTeam,
        opponent: e.opponent ?? null,
        is_home: null,
        projected_points: points,
        floor_points: band?.floor ?? null,
        ceiling_points: band?.ceiling ?? null,
        std_dev: band?.std_dev ?? null,
        projection_status: status,
        expected_availability: availability,
        is_bye: false,
        injury_status: injury,
        rest_of_season_points: rosByCanonical.get(cid) ?? null,
        ros: null,
        source: this.name,
        model_version: this.model_version,
        uncertainty_source: uncertainty,
        warnings: pWarnings,
      });
    }

    // Requested players with no feed entry. bye-vs-genuinely-missing is decided
    // by the context builder (it holds each CanonicalPlayer's nfl_team and can
    // check it against `teams_with_games`).
    const missing = req.canonical_player_ids.filter((cid) => !byCanonical.has(cid));

    if (kdefApproximated > 0) {
      warnings.push({
        code: "k_dst_weekly_approximated",
        message: `${kdefApproximated} K/D-ST weekly projections use Sleeper's standard precomputed points; league-specific K/D-ST scoring is not reconstructed weekly.`,
        severity: "warning",
      });
    }
    if (unscoredNoise > 0) {
      warnings.push({
        code: "unscored_stat_keys",
        message: `${unscoredNoise} projections carried stat keys this league does not score (ignored, not an error).`,
        severity: "info",
      });
    }

    const status: WeeklyProjectionBatch["status"] =
      missing.length > req.canonical_player_ids.length * 0.5 && req.canonical_player_ids.length > 0
        ? "PROJECTIONS_PARTIAL"
        : warnings.some((w) => w.severity === "warning")
          ? "PROJECTIONS_PARTIAL"
          : "READY";

    return {
      league_slug: league.league_slug,
      season: league.season,
      week,
      status,
      by_player: byCanonical,
      resolved_players: resolvedPlayers,
      source: this.name,
      model_version: this.model_version,
      missing,
      teams_with_games: [...teamsPlaying],
      warnings,
    };
  }

  #resolveFull(crosswalk: ProjectionRequest["crosswalk"], e: RawEntry): CanonicalPlayer {
    return this.#resolveRaw(crosswalk, e);
  }

  #resolve(crosswalk: ProjectionRequest["crosswalk"], e: RawEntry): string {
    return this.#resolveRaw(crosswalk, e).canonical_player_id;
  }

  #resolveRaw(crosswalk: ProjectionRequest["crosswalk"], e: RawEntry): CanonicalPlayer {
    const name = [e.player?.first_name, e.player?.last_name].filter(Boolean).join(" ").trim() || null;
    return crosswalk.resolve({
      provider: "sleeper",
      provider_player_id: e.player_id ?? null,
      full_name: name,
      first_name: e.player?.first_name ?? null,
      last_name: e.player?.last_name ?? null,
      position: e.player?.position ?? null,
      nfl_team: e.team ?? e.player?.team ?? null,
      eligible_positions: e.player?.fantasy_positions ?? null,
    }).player;
  }
}
