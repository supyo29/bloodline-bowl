/**
 * Layer 2 — league scoring translation.
 *
 * Takes a scoring-neutral `PlayerProjection` (or a Sleeper benchmark stat line)
 * and runs it through a league's ACTUAL Sleeper `scoring_settings` using the
 * repo's existing `calculateFantasyPoints` engine. No scoring math is
 * re-implemented here.
 *
 * Keyed by `league_id` + `scoring_hash`. Two managers in the same league get
 * identical `league_points` for the same player — this module has no concept of
 * a manager.
 *
 * Non-linear scoring (DEF points-allowed tiers, K distance buckets) is handled
 * by expanding the projected season into the bucket stat keys Sleeper scores,
 * then passing those through the same linear engine — exactly how Sleeper itself
 * scores a real game.
 */

import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import { hashScoringSettings } from "@/lib/analytics/historical-scoring";
import type { PlayerProjection, ProjectedFootballStats, LeagueProjection } from "./schema";

export interface LeagueScoringContext {
  league_slug: string;
  league_id: string;
  scoring_settings: Record<string, number>;
  scoring_hash: string;
}

export function leagueScoringContext(
  league_slug: string,
  league_id: string,
  scoring_settings: Record<string, number>,
): LeagueScoringContext {
  return {
    league_slug,
    league_id,
    scoring_settings,
    scoring_hash: hashScoringSettings(scoring_settings),
  };
}

/* --------------------------------------- projected season -> Sleeper stat keys */

/**
 * Threshold / big-play bonus keys that Sleeper scores per game and that we
 * cannot faithfully project from a season total. If a league uses them we score
 * everything else and record the gap rather than guessing.
 */
const UNSUPPORTED_BONUS_KEYS = [
  "bonus_rec_yd_100", "bonus_rec_yd_200", "bonus_rush_yd_100", "bonus_rush_yd_200",
  "bonus_pass_yd_300", "bonus_pass_yd_400", "bonus_rush_rec_yd_100", "bonus_rush_rec_yd_200",
  "bonus_pass_cmp_25", "bonus_rush_att_20",
];

/** Distribute an expected season points-allowed/game mean into Sleeper's DEF tiers. */
function defPointsAllowedBuckets(perGame: number, games: number): Record<string, number> {
  // Normal-ish spread of weekly points allowed, sd ~ 7.
  const sd = 7;
  const edges = [0, 6.5, 13.5, 20.5, 27.5, 34.5];
  const keys = ["pts_allow_0", "pts_allow_1_6", "pts_allow_7_13", "pts_allow_14_20", "pts_allow_21_27", "pts_allow_28_34", "pts_allow_35p"];
  const cdf = (x: number) => 0.5 * (1 + erf((x - perGame) / (sd * Math.SQRT2)));
  const probs: number[] = [];
  // exact-0 shutout: small mass below 0.5
  probs.push(Math.max(0.01, cdf(0.5) * 0.5));
  for (let i = 0; i < edges.length - 1; i++) probs.push(cdf(edges[i + 1]!) - cdf(edges[i]!));
  probs.push(1 - cdf(edges[edges.length - 1]!));
  const sum = probs.reduce((a, b) => a + b, 0) || 1;
  const out: Record<string, number> = {};
  keys.forEach((k, i) => { out[k] = (probs[i]! / sum) * games; });
  return out;
}

function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

/** K: split the schema's coarse FG buckets into Sleeper's distance keys. */
function kickerStatKeys(s: ProjectedFootballStats): Record<string, number> {
  const out: Record<string, number> = {};
  const made0_39 = s.fg_made_0_39 ?? 0;
  out.fgm_0_19 = made0_39 * 0.08;
  out.fgm_20_29 = made0_39 * 0.42;
  out.fgm_30_39 = made0_39 * 0.5;
  out.fgm_40_49 = s.fg_made_40_49 ?? 0;
  out.fgm_50p = s.fg_made_50p ?? 0;
  if (s.fg_made != null) out.fgm = s.fg_made;
  if (s.fg_miss != null) out.fgmiss = s.fg_miss;
  if (s.xp_made != null) out.xpm = s.xp_made;
  if (s.xp_miss != null) out.xpmiss = s.xp_miss;
  return out;
}

/**
 * Build a Sleeper-style stat line (the same key space `calculateFantasyPoints`
 * expects) from a projected season.
 */
export function statLineFromProjection(
  proj: Pick<PlayerProjection, "stats" | "position" | "availability">,
): Record<string, number> {
  const s = proj.stats;
  // The Layer-1 stat line is full (17-game) pace; DEF/K bucket expansion uses a
  // full season and the availability haircut is applied to points downstream.
  const games = 17;
  const line: Record<string, number> = {};
  const put = (k: string, v: number | null | undefined) => {
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) line[k] = v;
  };

  if (proj.position === "DEF") {
    put("sack", s.def_sack);
    put("int", s.def_int);
    put("fum_rec", s.def_fum_rec);
    put("def_td", s.def_td);
    put("safe", s.def_safety);
    Object.assign(line, defPointsAllowedBuckets(s.def_pts_allowed_per_game ?? 22, games));
    return line;
  }
  if (proj.position === "K") {
    Object.assign(line, kickerStatKeys(s));
    return line;
  }

  put("pass_yd", s.pass_yd);
  put("pass_td", s.pass_td);
  put("pass_int", s.pass_int);
  put("pass_2pt", s.pass_2pt);
  put("pass_cmp", s.pass_cmp);
  put("pass_att", s.pass_att);
  if (s.pass_att != null && s.pass_cmp != null) put("pass_inc", s.pass_att - s.pass_cmp);
  put("rush_yd", s.rush_yd);
  put("rush_att", s.rush_att);
  put("rush_td", s.rush_td);
  put("rush_2pt", s.rush_2pt);
  put("rec", s.rec);
  put("rec_yd", s.rec_yd);
  put("rec_td", s.rec_td);
  put("rec_2pt", s.rec_2pt);
  put("rec_tgt", s.targets);
  put("fum_lost", s.fum_lost);
  put("fum", s.fum_lost); // some leagues score all fumbles; harmless if unmapped
  return line;
}

/* ------------------------------------------------------------ translate to league */

export interface TranslateResult {
  league_points: number;
  league_ppg: number;
  warnings: string[];
  unsupported_bonus_keys: string[];
}

export function translateStatsToLeague(
  proj: Pick<PlayerProjection, "stats" | "position" | "availability">,
  ctx: LeagueScoringContext,
): TranslateResult {
  const line = statLineFromProjection(proj);
  const result = calculateFantasyPoints(line, ctx.scoring_settings);
  const unsupported = UNSUPPORTED_BONUS_KEYS.filter((k) => k in ctx.scoring_settings);
  const expectedGames = proj.availability.expected_games || 17;
  const gf = expectedGames / 17;
  const fullPace = result.fantasy_points;
  return {
    league_points: round2(fullPace * gf), // season points, availability-adjusted
    league_ppg: round2(fullPace / 17), // per-game at full health
    warnings: unsupported.length
      ? [`league uses per-game bonus keys not modeled from a season total: ${unsupported.join(", ")}`]
      : [],
    unsupported_bonus_keys: unsupported,
  };
}

/**
 * Full Layer-2 record for one player. `sleeperStats` (optional) is Sleeper's
 * projected football stat line, translated through the SAME league scoring for
 * an apples-to-apples benchmark. Replacement/VOR/tier/rank fields are filled in
 * afterward by `lib/projections/replacement.ts` once the whole pool is scored.
 */
export function buildLeagueProjection(
  proj: PlayerProjection,
  ctx: LeagueScoringContext,
  sleeperStats: ProjectedFootballStats | null,
): LeagueProjection {
  const ri = translateStatsToLeague(proj, ctx);

  const scale = proj.neutral_points > 0 ? ri.league_points / proj.neutral_points : 1;
  const leagueOutcome = {
    floor: round1(proj.outcome.floor * scale),
    median: round1(proj.outcome.median * scale),
    ceiling: round1(proj.outcome.ceiling * scale),
    sd: round1(proj.outcome.sd * scale),
    percentiles: proj.outcome.percentiles,
  };

  let sleeperLeaguePoints: number | null = null;
  if (sleeperStats) {
    const sl = calculateFantasyPoints(
      statLineFromProjection({ stats: sleeperStats, position: proj.position, availability: proj.availability }),
      ctx.scoring_settings,
    );
    sleeperLeaguePoints = round2(sl.fantasy_points);
  }

  // Compare on the SAME basis: RI full-pace (17g) league points vs Sleeper's
  // (~17g) league points. `league_points` above is the availability-adjusted
  // season number used for draft value; the vs_sleeper delta is not.
  const riFullPace = round2(ri.league_ppg * 17);
  const delta = sleeperLeaguePoints != null ? round2(riFullPace - sleeperLeaguePoints) : null;
  const deltaPct =
    sleeperLeaguePoints && sleeperLeaguePoints !== 0 && delta != null
      ? round1((delta / sleeperLeaguePoints) * 100)
      : null;

  return {
    player_id: proj.player_id,
    full_name: proj.full_name,
    position: proj.position,
    team: proj.team,
    league_slug: ctx.league_slug,
    league_id: ctx.league_id,
    scoring_hash: ctx.scoring_hash,
    league_points: ri.league_points,
    league_ppg: ri.league_ppg,
    league_outcome: leagueOutcome,
    sleeper_league_points: sleeperLeaguePoints,
    vs_sleeper: {
      delta_points: delta,
      delta_pct: deltaPct,
      ri_rank: null,
      sleeper_rank: null,
      rank_delta: null,
      primary_driver: null, // filled by compare.ts
    },
    replacement_points: null,
    value_over_replacement: null,
    vor_rank: null,
    position_rank: null,
    overall_rank: null,
    tier: null,
    confidence: proj.confidence.bucket,
  };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
