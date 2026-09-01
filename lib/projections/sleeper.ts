/**
 * Sleeper projection provider — an EXTERNAL BENCHMARK, never the model target.
 *
 * Sleeper exposes season-long player projections at
 * `https://api.sleeper.app/projections/nfl/{season}` (array form, RotoWire
 * upstream per the `company` field) and weekly at
 * `/v1/projections/nfl/regular/{season}/{week}` (dict form). Both are
 * undocumented but public and same-domain.
 *
 * This module: fetches, detects schema drift, normalizes to the canonical
 * football-stat vocabulary, keeps provider provenance, and degrades gracefully
 * (a Sleeper outage lowers confidence and emits a warning — it never zeroes a
 * stat or crashes the Roster Intel build).
 */

import {
  SleeperError,
  getSeasonProjections,
  getWeeklyProjections,
  type RawSleeperProjectionEntry,
} from "@/lib/sleeper/client";
import type { FantasyPosition } from "./schema";

export type ProviderStatus =
  | "OK"
  | "DEGRADED_SCHEMA"
  | "STALE"
  | "UNAVAILABLE";

/** Fields we require to consider a Sleeper season projection usable. */
const REQUIRED_SEASON_KEYS = ["gp"] as const;
/** Fields whose disappearance means the schema materially changed. */
const EXPECTED_SEASON_KEYS = [
  "gp",
  "pts_ppr",
  "pts_half_ppr",
  "pts_std",
] as const;

/** How old a projection may be (by `last_modified`) before it is flagged STALE. */
const STALE_AFTER_DAYS = 30;

export interface SleeperNormalizedProjection {
  player_id: string;
  full_name: string;
  position: FantasyPosition | null;
  team: string | null;
  years_exp: number | null;
  is_rookie: boolean;
  injury_status: string | null;
  /** Sleeper's own scored totals (assume a specific scoring system — see note). */
  sleeper_points: { std: number | null; half_ppr: number | null; ppr: number | null };
  /** Normalized football stats (subset present per position). */
  stats: {
    gp: number | null;
    pass_att: number | null;
    pass_cmp: number | null;
    pass_yd: number | null;
    pass_td: number | null;
    pass_int: number | null;
    pass_2pt: number | null;
    rush_att: number | null;
    rush_yd: number | null;
    rush_td: number | null;
    rush_2pt: number | null;
    targets: number | null;
    rec: number | null;
    rec_yd: number | null;
    rec_td: number | null;
    rec_2pt: number | null;
    fum_lost: number | null;
    /** Kicking (Sleeper only supplies 40-49 and 50+ buckets + total FG yards). */
    fgm_40_49: number | null;
    fgm_50p: number | null;
    fgm_yds: number | null;
    fgmiss_40_49: number | null;
    fgmiss_50p: number | null;
    xpm: number | null;
    xpmiss: number | null;
    /** Defense */
    def_sack: number | null;
    def_int: number | null;
    def_fum_rec: number | null;
    def_td: number | null;
    def_blk_kick: number | null;
  };
  raw_stat_keys: string[];
  source_updated_at: string | null;
}

export interface SleeperProjectionSource {
  provider: "sleeper";
  status: ProviderStatus;
  company: string | null;
  season: number;
  scope: "season" | "week";
  week: number | null;
  players_returned: number;
  players_usable: number;
  coverage_by_position: Record<string, number>;
  source_updated_at_range: [string | null, string | null];
  retrieved_at: string;
  source_schema_version: string;
  missing_expected_keys: string[];
  warnings: string[];
  projections: Map<string, SleeperNormalizedProjection>;
}

const POS_SET = new Set<FantasyPosition>(["QB", "RB", "WR", "TE", "K", "DEF"]);

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizeEntry(
  e: RawSleeperProjectionEntry,
): SleeperNormalizedProjection | null {
  const s = e.stats ?? {};
  const p = e.player ?? {};
  const posRaw = (p.position ?? "").toUpperCase();
  const position = POS_SET.has(posRaw as FantasyPosition)
    ? (posRaw as FantasyPosition)
    : null;
  const fullName =
    [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || e.player_id;
  const yearsExp = num(p.years_exp);
  return {
    player_id: e.player_id,
    full_name: fullName,
    position,
    team: e.team ?? p.team ?? null,
    years_exp: yearsExp,
    is_rookie: yearsExp === 0,
    injury_status: p.injury_status ?? null,
    sleeper_points: {
      std: num(s.pts_std),
      half_ppr: num(s.pts_half_ppr),
      ppr: num(s.pts_ppr),
    },
    stats: {
      gp: num(s.gp),
      pass_att: num(s.pass_att),
      pass_cmp: num(s.pass_cmp),
      pass_yd: num(s.pass_yd),
      pass_td: num(s.pass_td),
      pass_int: num(s.pass_int),
      pass_2pt: num(s.pass_2pt),
      rush_att: num(s.rush_att),
      rush_yd: num(s.rush_yd),
      rush_td: num(s.rush_td),
      rush_2pt: num(s.rush_2pt),
      targets: num(s.rec_tgt) ?? num(s.targets),
      rec: num(s.rec),
      rec_yd: num(s.rec_yd),
      rec_td: num(s.rec_td),
      rec_2pt: num(s.rec_2pt),
      fum_lost: num(s.fum_lost),
      fgm_40_49: num(s.fgm_40_49),
      fgm_50p: num(s.fgm_50p),
      fgm_yds: num(s.fgm_yds),
      fgmiss_40_49: num(s.fgmiss_40_49),
      fgmiss_50p: num(s.fgmiss_50p),
      xpm: num(s.xpm),
      xpmiss: num(s.xpmiss),
      def_sack: num(s.sack),
      def_int: num(s.int),
      def_fum_rec: num(s.fum_rec),
      def_td: num((s.def_fum_td ?? 0) + (s.def_kr_td ?? 0)) ?? num(s.def_td),
      def_blk_kick: num(s.blk_kick),
    },
    raw_stat_keys: Object.keys(s).sort(),
    source_updated_at: e.last_modified
      ? new Date(e.last_modified).toISOString()
      : null,
  };
}

function unavailable(
  season: number,
  scope: "season" | "week",
  week: number | null,
  reason: string,
): SleeperProjectionSource {
  return {
    provider: "sleeper",
    status: "UNAVAILABLE",
    company: null,
    season,
    scope,
    week,
    players_returned: 0,
    players_usable: 0,
    coverage_by_position: {},
    source_updated_at_range: [null, null],
    retrieved_at: new Date().toISOString(),
    source_schema_version: "unknown",
    missing_expected_keys: [...EXPECTED_SEASON_KEYS],
    warnings: [`Sleeper projections UNAVAILABLE: ${reason}`],
    projections: new Map(),
  };
}

/** Fetch + normalize Sleeper's season-long projections for `season`. */
export async function loadSleeperSeasonProjections(
  season: number,
  options: { positions?: FantasyPosition[] } = {},
): Promise<SleeperProjectionSource> {
  const positions =
    options.positions ?? (["QB", "RB", "WR", "TE", "K", "DEF"] as FantasyPosition[]);
  let raw: RawSleeperProjectionEntry[];
  try {
    raw = await getSeasonProjections(String(season), positions);
  } catch (error) {
    const msg =
      error instanceof SleeperError
        ? `${error.status} ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return unavailable(season, "season", null, msg);
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    return unavailable(season, "season", null, "empty or non-array response");
  }

  const warnings: string[] = [];
  const projections = new Map<string, SleeperNormalizedProjection>();
  const coverage: Record<string, number> = {};
  const updatedAts: string[] = [];
  let company: string | null = null;
  let usable = 0;
  const seenKeys = new Set<string>();

  for (const e of raw) {
    if (!e || typeof e.player_id !== "string") continue;
    company = company ?? e.company ?? null;
    const n = normalizeEntry(e);
    if (!n) continue;
    for (const k of n.raw_stat_keys) seenKeys.add(k);

    const hasRequired = REQUIRED_SEASON_KEYS.every(
      (k) => e.stats && typeof e.stats[k] === "number",
    );
    if (!hasRequired) continue;

    // last entry for a player_id wins (dedupe defensive).
    projections.set(n.player_id, n);
    if (n.source_updated_at) updatedAts.push(n.source_updated_at);
    if (n.position) coverage[n.position] = (coverage[n.position] ?? 0) + 1;
    usable += 1;
  }

  const missing = EXPECTED_SEASON_KEYS.filter((k) => !seenKeys.has(k));
  updatedAts.sort();
  const oldest = updatedAts[0] ?? null;
  const newest = updatedAts[updatedAts.length - 1] ?? null;

  let status: ProviderStatus = "OK";
  if (missing.length > 0) {
    status = "DEGRADED_SCHEMA";
    warnings.push(
      `Sleeper projection schema drift: expected keys missing across all rows: ${missing.join(", ")}.`,
    );
  }
  if (newest) {
    const ageDays = (Date.now() - Date.parse(newest)) / 86_400_000;
    if (ageDays > STALE_AFTER_DAYS) {
      status = status === "OK" ? "STALE" : status;
      warnings.push(
        `Sleeper projections last updated ${newest} (${Math.round(ageDays)}d ago).`,
      );
    }
  }
  if (usable === 0) {
    return unavailable(season, "season", null, "no rows passed validation");
  }

  return {
    provider: "sleeper",
    status,
    company,
    season,
    scope: "season",
    week: null,
    players_returned: raw.length,
    players_usable: usable,
    coverage_by_position: coverage,
    source_updated_at_range: [oldest, newest],
    retrieved_at: new Date().toISOString(),
    source_schema_version: `keys:${[...seenKeys].sort().join(",").length}`,
    missing_expected_keys: missing,
    warnings,
    projections,
  };
}

/** Fetch + normalize Sleeper's weekly projections. */
export async function loadSleeperWeeklyProjections(
  season: number,
  week: number,
): Promise<SleeperProjectionSource> {
  let raw: Record<string, Record<string, number>>;
  try {
    raw = await getWeeklyProjections(String(season), week);
  } catch (error) {
    return unavailable(
      season,
      "week",
      week,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!raw || typeof raw !== "object") {
    return unavailable(season, "week", week, "non-object response");
  }
  const projections = new Map<string, SleeperNormalizedProjection>();
  const coverage: Record<string, number> = {};
  const seenKeys = new Set<string>();
  for (const [pid, s] of Object.entries(raw)) {
    if (pid.startsWith("TEAM_")) continue;
    for (const k of Object.keys(s)) seenKeys.add(k);
    const entry: RawSleeperProjectionEntry = {
      player_id: pid,
      team: null,
      opponent: null,
      season: String(season),
      season_type: "regular",
      week,
      category: "proj",
      company: null,
      last_modified: null,
      updated_at: null,
      stats: s,
      player: null,
    };
    const n = normalizeEntry(entry);
    if (!n) continue;
    projections.set(pid, n);
  }
  return {
    provider: "sleeper",
    status: projections.size > 0 ? "OK" : "UNAVAILABLE",
    company: "rotowire",
    season,
    scope: "week",
    week,
    players_returned: Object.keys(raw).length,
    players_usable: projections.size,
    coverage_by_position: coverage,
    source_updated_at_range: [null, null],
    retrieved_at: new Date().toISOString(),
    source_schema_version: `keys:${[...seenKeys].sort().join(",").length}`,
    missing_expected_keys: [],
    warnings: [],
    projections,
  };
}

/**
 * Parse a raw Sleeper projection array (already fetched, e.g. from a test
 * fixture) into a `SleeperProjectionSource`. Pure, deterministic.
 */
export function parseSleeperSeasonArray(
  raw: RawSleeperProjectionEntry[],
  season: number,
): SleeperProjectionSource {
  const projections = new Map<string, SleeperNormalizedProjection>();
  const coverage: Record<string, number> = {};
  const seenKeys = new Set<string>();
  const updatedAts: string[] = [];
  let company: string | null = null;
  let usable = 0;
  for (const e of raw) {
    if (!e || typeof e.player_id !== "string") continue;
    company = company ?? e.company ?? null;
    const n = normalizeEntry(e);
    if (!n) continue;
    for (const k of n.raw_stat_keys) seenKeys.add(k);
    if (!REQUIRED_SEASON_KEYS.every((k) => typeof e.stats?.[k] === "number")) {
      continue;
    }
    projections.set(n.player_id, n);
    if (n.source_updated_at) updatedAts.push(n.source_updated_at);
    if (n.position) coverage[n.position] = (coverage[n.position] ?? 0) + 1;
    usable += 1;
  }
  const missing = EXPECTED_SEASON_KEYS.filter((k) => !seenKeys.has(k));
  updatedAts.sort();
  return {
    provider: "sleeper",
    status: usable === 0 ? "UNAVAILABLE" : missing.length ? "DEGRADED_SCHEMA" : "OK",
    company,
    season,
    scope: "season",
    week: null,
    players_returned: raw.length,
    players_usable: usable,
    coverage_by_position: coverage,
    source_updated_at_range: [
      updatedAts[0] ?? null,
      updatedAts[updatedAts.length - 1] ?? null,
    ],
    retrieved_at: new Date().toISOString(),
    source_schema_version: `keys:${[...seenKeys].sort().join(",").length}`,
    missing_expected_keys: missing,
    warnings: missing.length
      ? [`schema drift: missing ${missing.join(", ")}`]
      : [],
    projections,
  };
}
