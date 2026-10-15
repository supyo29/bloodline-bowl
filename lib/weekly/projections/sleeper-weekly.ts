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

import {
  getSeasonProjectionSegments,
  getWeeklyProjectionSegments,
  type ProjectionFeedSegmentResult,
} from "@/lib/sleeper/client";
import { canonicalPosition } from "@/lib/canonical/players";
import { scoreWeeklyLine, NON_SCORING_KEY } from "../scoring";
import { materializeScoringEvents } from "@/lib/scoring/derived-events";
import { leagueScoringContract } from "@/lib/scoring/support-contract";
import { enrichWeeklyStatsWithReturnGame } from "../return-game-weekly";
import { weeklyBand } from "../uncertainty";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch, WeeklyWarning } from "../schema";
import type { ProjectionProvider, ProjectionRequest } from "./types";
import { observationContentHash, type SourceObservationInput, type SourcePlayerObservation } from "../freshness/observation";
import { contentHash } from "@/lib/bridge/hash";
import { activeProjectionScope } from "@/lib/canonical/request-scope";

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

/** Default upstream cache window when the caller states no requirement (kept at the client's long-standing 30 minutes). */
const DEFAULT_WEEKLY_FEED_MAX_AGE_MS = 30 * 60 * 1000;

async function fetchWeekSegments(
  season: number,
  week: number,
  maxSourceAgeMs: number | undefined,
): Promise<ProjectionFeedSegmentResult[]> {
  // The freshness authority decides how old the SOURCE may be; the client's per-path cache honours it (a tighter requirement forces a refetch,
  // a looser one never extends the default). Within one request scope the SAME segment fetch is reused by every consumer so that lineup,
  // matchup, waivers and roster-health all rest on one source observation (and the multi-league cron does not refetch per league).
  const ttlMs = Math.min(DEFAULT_WEEKLY_FEED_MAX_AGE_MS, Math.max(0, maxSourceAgeMs ?? DEFAULT_WEEKLY_FEED_MAX_AGE_MS));
  const scope = activeProjectionScope();
  const key = `segments|${season}|${week}`;
  const run = () => getWeeklyProjectionSegments(String(season), week, [...POSITIONS], { revalidate: ttlMs / 1000 });
  if (!scope) return run();
  const existing = scope.get(key) as Promise<ProjectionFeedSegmentResult[]> | undefined;
  if (existing) return existing;
  const p = run();
  scope.set(key, p);
  return p;
}

/** Oldest READY segment fetch instant = the conservative observation time of the whole feed. */
function sourceObservationFromSegments(segments: ProjectionFeedSegmentResult[]): { observed_at: string | null; by_segment: Record<string, string>; fetch_path: "LIVE_FETCH" | "PROCESS_CACHE" | "MIXED" } {
  const ready = segments.filter((x) => x.status === "READY" && x.fetched_at);
  const by_segment = Object.fromEntries(ready.map((x) => [x.segment_id, x.fetched_at as string]));
  const observed_at = ready.length ? ready.map((x) => x.fetched_at as string).sort()[0] ?? null : null;
  const hits = ready.filter((x) => x.cache_hit).length;
  return { observed_at, by_segment, fetch_path: hits === 0 ? "LIVE_FETCH" : hits === ready.length ? "PROCESS_CACHE" : "MIXED" };
}

/** League-INDEPENDENT facts only (no scoring): what the source said about each player. */
function toObservationPlayers(raw: RawEntry[]): SourcePlayerObservation[] {
  const out: SourcePlayerObservation[] = [];
  for (const e of raw) {
    if (!e.player_id) continue;
    const stats: Record<string, number> = {};
    for (const [k, v] of Object.entries(e.stats ?? {})) if (typeof v === "number" && Number.isFinite(v) && !NON_SCORING_KEY.test(k)) stats[k] = v;
    const gp = typeof e.stats?.gp === "number" ? e.stats.gp : null;
    out.push({
      provider: "sleeper",
      provider_player_id: e.player_id,
      position: canonicalPosition(e.player?.position ?? e.player?.fantasy_positions?.[0] ?? null),
      nfl_team: (e.team ?? e.player?.team ?? null)?.toUpperCase() ?? null,
      opponent: e.opponent ?? null,
      injury_status: e.player?.injury_status ?? null,
      gp,
      stats,
    });
  }
  return out;
}

/** Observation sinks must never break projections. Keyed per (season, week, fetch instant) so each upstream fetch is offered once. */
export type ObservationSink = (o: SourceObservationInput) => Promise<unknown>;
const offeredObservations = new Set<string>();
export function __resetOfferedObservationsForTests(): void {
  offeredObservations.clear();
}

async function fetchSeasonSegments(
  season: number,
): Promise<ProjectionFeedSegmentResult[]> {
  return getSeasonProjectionSegments(String(season), [...POSITIONS], {
    revalidate: 6 * 60 * 60,
  });
}

function usableRows(segments: ProjectionFeedSegmentResult[]): RawEntry[] {
  return segments
    .filter((segment) => segment.status === "READY")
    .flatMap((segment) => segment.rows);
}

function pushSegmentWarnings(
  warnings: WeeklyWarning[],
  scope: "weekly" | "season",
  segments: ProjectionFeedSegmentResult[],
): void {
  for (const segment of segments) {
    if (segment.status === "READY") continue;
    const code =
      segment.status === "EMPTY"
        ? `${scope}_projection_segment_empty`
        : `${scope}_projection_segment_unavailable`;
    warnings.push({
      code,
      message:
        `Sleeper ${scope} projection segment ${segment.segment_id} ` +
        `(${segment.positions.join("/")}) is ${segment.status.toLowerCase()}` +
        (segment.error ? `: ${segment.error}` : "."),
      severity: "warning",
    });
  }
}

export class SleeperWeeklyProjectionProvider implements ProjectionProvider {
  readonly name = "sleeper_weekly";
  readonly model_version = SLEEPER_WEEKLY_VERSION;

  constructor(private readonly observationSink: ObservationSink | null = null) {}

  async getWeeklyProjections(req: ProjectionRequest): Promise<WeeklyProjectionBatch> {
    const { league, week, crosswalk } = req;
    const warnings: WeeklyWarning[] = [];
    await crosswalk.ensureLoaded();

    const weekSegments = await fetchWeekSegments(league.season, week, req.max_source_age_ms);
    pushSegmentWarnings(warnings, "weekly", weekSegments);
    const raw = usableRows(weekSegments);
    const weeklySegmentsReady = weekSegments.filter((segment) => segment.status === "READY").length;

    const obs = sourceObservationFromSegments(weekSegments);

    if (weeklySegmentsReady === 0 || raw.length === 0) {
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
        source_observation: { provider: "sleeper", observed_at: obs.observed_at, observation_id: null, content_hash: null, fetch_path: obs.fetch_path, by_segment: obs.by_segment },
        warnings: [
          ...warnings,
          {
            code: "weekly_projection_source_unavailable",
            message:
              `No usable Sleeper weekly projection segment was available for ` +
              `week ${week} of ${league.season}.`,
            severity: "error",
          },
        ],
      };
    }

    // Optional rest-of-season, from independently degradable season segments,
    // prorated + league-scored. Missing season segments null only the affected
    // ROS rows; they never erase successful weekly projections.
    const rosByCanonical = new Map<string, number>();
    if (req.want_rest_of_season) {
      const seasonSegments = await fetchSeasonSegments(league.season);
      pushSegmentWarnings(warnings, "season", seasonSegments);
      const seasonRaw = usableRows(seasonSegments);
      const weeksLeftFrac = Math.max(0, (REGULAR_SEASON_WEEKS - (week - 1)) / REGULAR_SEASON_WEEKS);
      for (const e of seasonRaw) {
        if (!e.player_id || !e.stats) continue;
        const cid = this.#resolve(crosswalk, e);
        const pos = canonicalPosition(e.player?.position ?? null);
        const sk = Object.keys(e.stats);
        if (pos === "K" || pos === "DEF") {
          const std = Number(e.stats.pts_std ?? 0);
          if (std > 0) rosByCanonical.set(cid, Math.round(std * weeksLeftFrac * 100) / 100);
        } else {
          // component stats only — a `pts_*`-only season row is not reconstructable.
          const hasComponent = sk.some((k) => !NON_SCORING_KEY.test(k) && !/^pts_/.test(k));
          if (!hasComponent) continue;
          const seasonPts = scoreWeeklyLine(materializeScoringEvents(e.stats, { position: pos }).stats, league.raw_scoring).points;
          if (seasonPts > 0) rosByCanonical.set(cid, Math.round(seasonPts * weeksLeftFrac * 100) / 100);
        }
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
      // Phase 6: the single owner of derived scoring events (lib/scoring/derived-events.ts). Provider-first; renames the provider's individual
      // return yards from the team-defense key (`def_kr_yd`) to `kr_yd` BEFORE enrichment so a returner is never priced twice, and derives a
      // position reception bonus only if the provider omitted it.
      const rawEntryStats = materializeScoringEvents(e.stats ?? {}, { position: pos }).stats;
      const injury = e.player?.injury_status ?? null;
      const nflTeam = (e.team ?? e.player?.team ?? null)?.toUpperCase() ?? null;
      const availability = injuryToAvailability(injury);

      let points: number | null;
      let status: WeeklyProjection["projection_status"] = "projected";
      const uncertainty: WeeklyProjection["uncertainty_source"] = "position_volatility_heuristic";
      const pWarnings: string[] = [];

      // Weekly kickoff-return enrichment (lib/weekly/return-game-weekly.ts):
      // Sleeper's weekly feed never publishes individual kr_yd (live-verified),
      // so an offensive player with a real KR role otherwise projects as if he
      // never returns kicks. Provider-first: only fires when `kr_yd` is ABSENT
      // from the raw entry; punt returns (`pr_yd`) are never touched — Sleeper
      // already supplies those. No-op (returns `rawEntryStats` unchanged) when
      // the caller didn't provide `return_game_season` (optional, best-effort).
      const { stats, warnings: returnGameWarnings } = enrichWeeklyStatsWithReturnGame(
        rawEntryStats,
        e.player_id,
        req.return_game_season,
        req.return_game_recent_attempts,
      );
      pWarnings.push(...returnGameWarnings);

      // Projection PRESENCE is decided by whether the source published real
      // stats for this player-week — NOT by the sign of the scored points. A
      // legitimate 0 (or negative) projection is data, not "unavailable".
      //
      // Sleeper's precomputed `pts_*` totals do NOT count as a component stat
      // line for OFFENSE: those totals are deliberately not trusted, and a row
      // carrying only `pts_*` (no yards/TDs/receptions) has no reconstructable
      // league projection -> it is `unavailable`, not a 0. K/DEF is the one
      // documented exception (it has nothing but `pts_std` to fall back on).
      // `keys`/`hasAnyStatKey`/`hasComponentStats` are computed from the
      // POST-enrichment `stats` so a pure return specialist with no other
      // component stats can flip from "unavailable" to a real projection.
      const keys = Object.keys(stats);
      const hasAnyStatKey = keys.some((k) => !NON_SCORING_KEY.test(k));
      const hasComponentStats = keys.some((k) => !NON_SCORING_KEY.test(k) && !/^pts_/.test(k));

      if (pos === "K" || pos === "DEF") {
        // W1.R2 (L3): a null / missing `pts_std` is UNKNOWN, never a known 0 (`Number(null)` is 0 — a K/DST row carrying `pts_std: null`
        // used to become a projected, "known" zero)
        const std = stats.pts_std == null ? Number.NaN : Number(stats.pts_std);
        points = hasAnyStatKey && Number.isFinite(std) ? Math.round(std * 100) / 100 : null;
        if (points != null) {
          kdefApproximated += 1;
          pWarnings.push("k_dst_uses_sleeper_standard_points (league-specific weekly K/DST scoring not reconstructable)");
        }
      } else if (hasComponentStats) {
        const scored = scoreWeeklyLine(stats, league.raw_scoring);
        points = scored.points; // keep 0 / negative — it is a real projection
        if (scored.unscored_keys.length > 6) unscoredNoise += 1;
      } else {
        points = null;
        if (hasAnyStatKey && keys.some((k) => /^pts_/.test(k))) {
          pWarnings.push("only_precomputed_totals (no reconstructable component stats for this league's scoring)");
        }
      }

      if (points == null) {
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
    // Phase 6 (D-4): a rule the league scores that the weekly provider never supplies (e.g. whole-game threshold bonuses, distance-TD bonuses) adds NOTHING
    // to a weekly projection. Say so, once per batch, instead of leaving the omission silent. Info severity: it never changes batch status.
    const notSupplied = leagueScoringContract(league.raw_scoring).offense_rules_not_reaching_weekly_projection;
    if (notSupplied.length > 0) {
      warnings.push({ code: "league_scores_keys_provider_does_not_supply", message: `This league scores offense rule(s) the weekly provider does not supply, so they contribute nothing to weekly projections (exact only on completed games): ${notSupplied.join(", ")}.`, severity: "info" });
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

    // ---- W1.P4 source observation: league-independent, identified by content, offered to the history sink ONCE per upstream fetch ----
    let observation_id: string | null = null;
    let content_hash: string | null = null;
    if (obs.observed_at) {
      const players = toObservationPlayers(raw);
      content_hash = observationContentHash(players);
      observation_id = `srcobs:${contentHash({ p: "sleeper", s: league.season, w: week, t: obs.observed_at, h: content_hash }).slice(0, 20)}`;
      const offerKey = `${league.season}|${week}|${obs.observed_at}`;
      if (this.observationSink && !offeredObservations.has(offerKey)) {
        offeredObservations.add(offerKey);
        try {
          await this.observationSink({ provider: "sleeper", season: league.season, week, observed_at: obs.observed_at, by_segment: obs.by_segment, fetch_path: obs.fetch_path, players });
        } catch {
          offeredObservations.delete(offerKey); // history capture is best-effort and must never fail a projection
        }
      }
    }

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
      source_observation: { provider: "sleeper", observed_at: obs.observed_at, observation_id, content_hash, fetch_path: obs.fetch_path, by_segment: obs.by_segment },
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
