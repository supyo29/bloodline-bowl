/**
 * Trade Engine — Phase 3.5 completion: REAL file-based usage/schedule
 * providers, backed by the R pipelines in `analysis/phase35_usage_pipeline.R`
 * and `analysis/phase35_schedule_pipeline.R`.
 *
 * Architecture boundary (per the completion spec): R owns statistical
 * feature production (pulling real nflverse data via {nflreadr}, computing
 * shares/percentiles). This file owns validation, ingestion, identity
 * (rows are already keyed by `sleeper_id` via R's `nflreadr::load_ff_playerids`
 * crosswalk), freshness, provenance, and safe fallbacks — it does NOT
 * recompute or re-derive any statistic R already produced.
 *
 * TEMPORAL SAFETY IS STRUCTURAL, NOT A CALLER CONVENTION: both providers are
 * constructed with a fixed `asOfWeek` cutoff (`createRUsageProviderAsOf`,
 * `createRScheduleProviderAsOf`) and every query method internally filters
 * to `week <= asOfWeek` — a caller cannot accidentally read a future week
 * through this provider even if it tries to, because the row simply isn't in
 * the filtered index. This is `resolvePlayerIntelligenceAsOf` (completion
 * spec §35) implemented as a type, not a discipline.
 *
 * DEPLOYMENT NOTE (completion spec §29): these providers read a file that
 * must already exist on disk at request time — they NEVER shell out to R or
 * run a pipeline synchronously inside a request. On Vercel, `outputs/` must
 * be committed to the repo (as it is today) or copied into the deployment
 * bundle; this module does not attempt to solve external object storage —
 * that decision is explicitly deferred (see the Phase 3.5 completion report).
 *
 * NOT wired as the DEFAULT provider anywhere (`DEFAULT_PLAYER_INTELLIGENCE_PROVIDERS`
 * in `intelligence.ts` still uses the NULL providers) — the real data here is
 * 2025 season backtest data, not live 2026 data (the 2026 season has not
 * played a game as of this pipeline run), so serving it as "current" for a
 * live trade analysis would be actively misleading. These are for
 * HISTORICAL/BACKTEST calibration research only, wired explicitly by a
 * caller that knows it is doing that (see `lib/trades/historical-loader.ts`).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  UsageProvider,
  ScheduleProvider,
  PlayerUsageSnapshot,
  PlayerScheduleContext,
  UsageFreshness,
} from "./providers";

const OUT_DIR = join(process.cwd(), "lib", "trades", "data");

/** Minimal, quote-aware CSV parser for the fixed, controlled shape `write.csv()` produces. Not a general-purpose CSV library. */
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (c === '"') inQuotes = false;
        else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

const num = (v: string | undefined): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: string | undefined): string | null => (v == null || v === "" ? null : v);

export interface RDataFileMeta {
  data_version: string;
  season: number;
  weeks_present: number[];
  rows: number;
  generated_at: string;
}

export interface RDataLoadResult<T> {
  rows: T[];
  meta: RDataFileMeta | null;
  file_path: string;
  file_exists: boolean;
}

function loadCsvWithMeta<T>(csvName: string, metaName: string, mapRow: (r: Record<string, string>) => T): RDataLoadResult<T> {
  const csvPath = join(OUT_DIR, csvName);
  const metaPath = join(OUT_DIR, metaName);
  if (!existsSync(csvPath)) return { rows: [], meta: null, file_path: csvPath, file_exists: false };
  const rows = parseCsv(readFileSync(csvPath, "utf8")).map(mapRow);
  let meta: RDataFileMeta | null = null;
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      meta = null; // malformed metadata is treated as absent, never guessed at
    }
  }
  return { rows, meta, file_path: csvPath, file_exists: true };
}

/* -------------------------------------------------------------------------- */
/* Usage                                                                       */
/* -------------------------------------------------------------------------- */

interface UsageRow {
  season: number;
  week: number;
  sleeper_id: string | null;
  team: string | null;
  position: string | null;
  snaps: number | null;
  snap_share: number | null;
  targets: number | null;
  target_share: number | null;
  carries: number | null;
  rush_share: number | null;
  red_zone_targets: number | null;
  red_zone_carries: number | null;
  goal_line_carries: number | null;
  source: string;
  source_updated_at: string;
  data_version: string;
}

function toUsageRow(r: Record<string, string>): UsageRow {
  return {
    season: Number(r.season),
    week: Number(r.week),
    sleeper_id: str(r.sleeper_id),
    team: str(r.team),
    position: str(r.position),
    snaps: num(r.snaps),
    snap_share: num(r.snap_share),
    targets: num(r.targets),
    target_share: num(r.target_share),
    carries: num(r.carries),
    rush_share: num(r.rush_share),
    red_zone_targets: num(r.red_zone_targets),
    red_zone_carries: num(r.red_zone_carries),
    goal_line_carries: num(r.goal_line_carries),
    source: r.source ?? "unknown",
    source_updated_at: r.source_updated_at ?? "",
    data_version: r.data_version ?? "unknown",
  };
}

function toUsageSnapshot(r: UsageRow, freshness: UsageFreshness): PlayerUsageSnapshot {
  return {
    player_id: r.sleeper_id ?? "",
    season: r.season,
    week: r.week,
    snaps: r.snaps,
    snap_share: r.snap_share,
    routes: null,
    route_participation: null,
    targets: r.targets,
    target_share: r.target_share,
    carries: r.carries,
    rush_share: r.rush_share,
    red_zone_targets: r.red_zone_targets,
    red_zone_carries: r.red_zone_carries,
    goal_line_carries: r.goal_line_carries,
    source: r.source,
    updated_at: r.source_updated_at,
    freshness,
  };
}

/**
 * A real, file-backed `UsageProvider` over `lib/trades/data/player_usage_weekly.csv`
 * (produced by `analysis/phase35_usage_pipeline.R`), scoped to never return a
 * row later than `asOfWeek` in `season` — the structural no-look-ahead guard
 * described in the module doc above.
 */
export function createRUsageProviderAsOf(season: number, asOfWeek: number): UsageProvider & { readonly _diagnostics: { file_exists: boolean; data_version: string | null; total_rows_in_file: number; rows_within_cutoff: number } } {
  const loaded = loadCsvWithMeta("player_usage_weekly.csv", "player_usage_weekly.meta.json", toUsageRow);
  const inScope = loaded.rows.filter((r) => r.season === season && r.week <= asOfWeek && r.sleeper_id != null);
  const byPlayer = new Map<string, UsageRow[]>();
  for (const r of inScope) {
    if (!byPlayer.has(r.sleeper_id!)) byPlayer.set(r.sleeper_id!, []);
    byPlayer.get(r.sleeper_id!)!.push(r);
  }
  for (const arr of byPlayer.values()) arr.sort((a, b) => a.week - b.week);

  return {
    source_name: `R usage pipeline (${loaded.meta?.data_version ?? "no metadata"}, season ${season}, as-of week ${asOfWeek})`,
    getCurrentUsage: (playerId) => {
      const arr = byPlayer.get(playerId);
      if (!arr || arr.length === 0) return null;
      const latest = arr.at(-1)!;
      return toUsageSnapshot(latest, latest.week === asOfWeek ? "CURRENT" : "STALE");
    },
    getHistoricalUsage: (playerId, s, w) => {
      if (s !== season || w > asOfWeek) return null; // structurally cannot serve a future-relative-to-asOf week even if asked
      const row = (byPlayer.get(playerId) ?? []).find((r) => r.week === w);
      return row ? toUsageSnapshot(row, "CURRENT") : null;
    },
    getRecentUsageSeries: (playerId, weeksBack) => {
      const arr = byPlayer.get(playerId) ?? [];
      return arr.slice(-weeksBack).map((r) => toUsageSnapshot(r, "CURRENT"));
    },
    _diagnostics: {
      file_exists: loaded.file_exists,
      data_version: loaded.meta?.data_version ?? null,
      total_rows_in_file: loaded.rows.length,
      rows_within_cutoff: inScope.length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Schedule                                                                    */
/* -------------------------------------------------------------------------- */

interface ScheduleRow {
  season: number;
  week: number;
  team: string;
  opponent: string;
  position: string;
  matchup_score: number | null;
  matchup_percentile: number | null;
  source: string;
  source_updated_at: string;
}

function toScheduleRow(r: Record<string, string>): ScheduleRow {
  return {
    season: Number(r.season),
    week: Number(r.week),
    team: r.team ?? "",
    opponent: r.opponent ?? "",
    position: r.position ?? "",
    matchup_score: num(r.matchup_score),
    matchup_percentile: num(r.matchup_percentile),
    source: r.source ?? "unknown",
    source_updated_at: r.source_updated_at ?? "",
  };
}

/**
 * A real, file-backed `ScheduleProvider` over
 * `lib/trades/data/player_schedule_strength_weekly.csv` (produced by
 * `analysis/phase35_schedule_pipeline.R`), scoped to `asOfWeek` the same way
 * as the usage provider. Since the raw table is keyed by team+opponent+position
 * (league-agnostic, per completion spec §24), this provider needs to know
 * each player's team+position for the requested week — it takes that from
 * the usage provider's own resolved rows (both pipelines key off the same
 * real nflverse season) rather than requiring a second, redundant identity
 * source.
 */
export function createRScheduleProviderAsOf(season: number, asOfWeek: number, playerTeamPosition: (playerId: string, week: number) => { team: string; position: string } | null): ScheduleProvider & { readonly _diagnostics: { file_exists: boolean; total_rows_in_file: number; rows_within_cutoff: number } } {
  const loaded = loadCsvWithMeta("player_schedule_strength_weekly.csv", "player_schedule_strength_weekly.meta.json", toScheduleRow);
  const inScope = loaded.rows.filter((r) => r.season === season && r.week <= asOfWeek);
  const index = new Map<string, ScheduleRow>();
  for (const r of inScope) index.set(`${r.team}:${r.week}:${r.position}`, r);

  return {
    source_name: `R schedule pipeline (season ${season}, as-of week ${asOfWeek}, league-agnostic raw matchup score)`,
    getWeeklyMatchup: (playerId, week) => {
      if (week > asOfWeek) return null; // structural cutoff, independent of what the caller's own `ctx.week` claims
      const tp = playerTeamPosition(playerId, week);
      if (!tp) return null;
      const row = index.get(`${tp.team}:${week}:${tp.position}`);
      if (!row || row.matchup_score == null) return null;
      const ctx: PlayerScheduleContext = {
        player_id: playerId,
        week,
        opponent: row.opponent,
        position: tp.position,
        matchup_score: row.matchup_score,
        matchup_percentile: row.matchup_percentile,
        source: row.source,
        updated_at: row.source_updated_at,
        freshness: row.week === asOfWeek ? "CURRENT" : "STALE",
      };
      return ctx;
    },
    _diagnostics: { file_exists: loaded.file_exists, total_rows_in_file: loaded.rows.length, rows_within_cutoff: inScope.length },
  };
}

/** Convenience: build a `(playerId, week) -> {team, position}` resolver directly from the usage CSV, for wiring the schedule provider without a second lookup source. */
export function buildTeamPositionResolverFromUsage(season: number, asOfWeek: number): (playerId: string, week: number) => { team: string; position: string } | null {
  const loaded = loadCsvWithMeta("player_usage_weekly.csv", "player_usage_weekly.meta.json", toUsageRow);
  const index = new Map<string, { team: string; position: string }>();
  for (const r of loaded.rows) {
    if (r.season !== season || r.week > asOfWeek || !r.sleeper_id || !r.team || !r.position) continue;
    index.set(`${r.sleeper_id}:${r.week}`, { team: r.team, position: r.position });
  }
  return (playerId, week) => index.get(`${playerId}:${week}`) ?? null;
}

export function rDataFileStatus(fileName: string): { exists: boolean; size_bytes: number | null; modified_at: string | null } {
  const p = join(OUT_DIR, fileName);
  if (!existsSync(p)) return { exists: false, size_bytes: null, modified_at: null };
  const s = statSync(p);
  return { exists: true, size_bytes: s.size, modified_at: s.mtime.toISOString() };
}
