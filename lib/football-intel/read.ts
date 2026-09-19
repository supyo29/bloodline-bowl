/**
 * Football Intelligence — file-backed read adapter (Phase 3, spec §24, §25).
 *
 * Pure synchronous file reads over `lib/football-intel/data/*` (committed, so
 * Vercel-safe — same boundary decision as `lib/trades/r-data-providers.ts`).
 * No R, no network, no recomputation.
 *
 * Honest degradation (spec §25):
 *   - no manifest / no data file           -> loadFootballIntelligence() returns null
 *   - player join key not found            -> { resolution: "UNRESOLVED" }
 *   - contextual matchup pair not present  -> { availability: "NOT_AVAILABLE" }
 *   - a rating below publication threshold  -> present, confidence "INSUFFICIENT_SAMPLE"
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  FootballIntelligenceManifest,
  TeamProfile,
  TeamMetricRating,
  PlayerUsageProfile,
  PlayerUsageMetric,
  CoverageAllowedRating,
  ContextualMatchupFeature,
  FtnDescriptive,
  Confidence,
  TrendDirection,
} from "./schema";

const DATA_DIR = join(process.cwd(), "lib", "football-intel", "data");

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
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

const n = (v: string | undefined): number | null =>
  v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const s = (v: string | undefined): string | null => (v == null || v === "" ? null : v);
const conf = (v: string | undefined): Confidence => {
  const u = (v ?? "").toUpperCase();
  return u === "HIGH" || u === "MEDIUM" || u === "LOW" ? u : "INSUFFICIENT_SAMPLE";
};

export interface FootballIntelligence {
  manifest: FootballIntelligenceManifest;
  team(nflTeam: string): TeamProfile | null;
  teams(): TeamProfile[];
  playerUsage(key: { gsis_id?: string | null; sleeper_id?: string | null }): PlayerUsageProfile;
  coverageAllowed(nflTeam: string): CoverageAllowedRating[];
  contextualMatchup(
    feature: string,
    offenseTeam: string,
    defenseTeam: string,
  ): ContextualMatchupFeature | { availability: "NOT_AVAILABLE" };
  ftnDescriptive(nflTeam: string): FtnDescriptive[];
  /** structural cutoff (spec §24): the max NFL week any consumer may treat as known. */
  throughWeek(source?: string): number;
}

let cached: FootballIntelligence | null | undefined;

/** Load the current published snapshot. Returns null if nothing is published. */
export function loadFootballIntelligence(opts?: { force?: boolean }): FootballIntelligence | null {
  if (!opts?.force && cached !== undefined) return cached;
  const manifestPath = join(DATA_DIR, "football_intelligence_manifest.json");
  if (!existsSync(manifestPath)) {
    cached = null;
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FootballIntelligenceManifest;

  const readCsv = (name: string) =>
    existsSync(join(DATA_DIR, name)) ? parseCsv(readFileSync(join(DATA_DIR, name), "utf8")) : [];

  const teamRows = readCsv("team_profile.csv");
  const usageRows = readCsv("player_usage_profile.csv");
  const covRows = readCsv("unit_coverage_profile.csv");
  const ctxRows = readCsv("contextual_matchup_feature.csv");
  const ftnRows = readCsv("ftn_descriptive.csv");

  const toRating = (r: Record<string, string>): TeamMetricRating => ({
    team: r.team!,
    side: (r.side as "offense" | "defense") ?? "offense",
    metric: r.metric!,
    output_class: (r.output_class as TeamMetricRating["output_class"]) ?? "MODELED",
    predictive_status: (r.predictive_status as TeamMetricRating["predictive_status"]) ?? "UNVALIDATED",
    raw: n(r.raw),
    modeled: n(r.modeled),
    league_mean: n(r.league_mean),
    league_percentile: n(r.league_percentile),
    n_obs_effective: n(r.n_obs_effective),
    prior_mean: n(r.prior_mean),
    prior_n_seasons: n(r.prior_n_seasons),
    prior_discount: n(r.prior_discount),
    prior_weight: n(r.prior_weight),
    recent_weight: n(r.recent_weight),
    shrunk_to_league: n(r.shrunk_to_league),
    std_error: n(r.std_error),
    confidence: conf(r.confidence),
    trend: {
      current_level: n(r.trend_current_level),
      recent_level: n(r.trend_recent_level),
      direction: (r.trend_direction as TrendDirection) ?? "uncertain",
      magnitude: n(r.trend_magnitude),
      confidence: conf(r.trend_confidence),
    },
  });

  const teamProfiles = new Map<string, TeamProfile>();
  for (const r of teamRows) {
    const team = r.team!;
    if (!teamProfiles.has(team)) {
      teamProfiles.set(team, {
        team,
        season: manifest.season,
        through_week: manifest.through_week,
        offense: {},
        defense: {},
      });
    }
    const tp = teamProfiles.get(team)!;
    const rating = toRating(r);
    (rating.side === "defense" ? tp.defense : tp.offense)[rating.metric] = rating;
  }

  const usageByGsis = new Map<string, PlayerUsageProfile>();
  const gsisBySleeper = new Map<string, string>();
  for (const r of usageRows) {
    const gsis = r.gsis_id!;
    if (!usageByGsis.has(gsis)) {
      usageByGsis.set(gsis, {
        gsis_id: gsis,
        sleeper_id: s(r.sleeper_id),
        pfr_id: s(r.pfr_id),
        full_name: s(r.full_name),
        position: s(r.position),
        nfl_team: s(r.team),
        season: manifest.season,
        through_week: manifest.through_week,
        games: n(r.games),
        eff_games: n(r.eff_games),
        last_week: n(r.last_week),
        metrics: {},
      });
      if (r.sleeper_id) gsisBySleeper.set(r.sleeper_id, gsis);
    }
    const p = usageByGsis.get(gsis)!;
    const m: PlayerUsageMetric = {
      metric: r.metric!,
      output_class: (r.output_class as PlayerUsageMetric["output_class"]) ?? "OBSERVED",
      observed: n(r.observed),
      modeled: n(r.modeled),
      position_mean: n(r.position_mean),
      prior_season: n(r.prior_season),
      prior_weight: n(r.prior_weight),
      recent_weight: n(r.recent_weight),
      confidence: conf(r.confidence),
    };
    p.metrics[m.metric] = m;
  }

  const covByTeam = new Map<string, CoverageAllowedRating[]>();
  for (const r of covRows) {
    const arr = covByTeam.get(r.team!) ?? [];
    const metric = r.metric!;
    arr.push({
      team: r.team!,
      position: (metric.split("_").pop() as "RB" | "WR" | "TE") ?? "WR",
      metric,
      output_class: (r.output_class as CoverageAllowedRating["output_class"]) ?? "MODELED",
      raw: n(r.raw),
      modeled: n(r.modeled),
      league_percentile: n(r.league_percentile),
      prior_mean: n(r.prior_mean),
      confidence: conf(r.confidence),
    });
    covByTeam.set(r.team!, arr);
  }

  const ctxIndex = new Map<string, ContextualMatchupFeature>();
  for (const r of ctxRows) {
    const key = `${r.feature}|${r.offense_team ?? ""}|${r.defense_team ?? ""}`;
    ctxIndex.set(key, {
      feature: r.feature!,
      season: manifest.season,
      through_week: manifest.through_week,
      offense_team: s(r.offense_team),
      defense_team: s(r.defense_team),
      offense_rating: n(r.offense_rating),
      defense_rating: n(r.defense_rating),
      offense_percentile: n(r.offense_percentile),
      defense_percentile: n(r.defense_percentile),
      interaction_signal: n(r.interaction_signal),
      predictive_status: r.predictive_status ?? "UNVALIDATED",
      confidence: conf(r.confidence),
      output_class: (r.output_class as ContextualMatchupFeature["output_class"]) ?? "MODELED",
    });
  }

  const ftnByTeam = new Map<string, FtnDescriptive[]>();
  for (const r of ftnRows) {
    const arr = ftnByTeam.get(r.team!) ?? [];
    arr.push({
      team: r.team!,
      metric: r.metric!,
      value: n(r.value),
      n_plays: n(r.n_plays),
      availability: r.availability ?? "AVAILABLE",
      output_class: "DESCRIPTIVE_ONLY",
      source_coverage: r.source_coverage ?? "",
      season_bounds: r.season_bounds ?? "",
    });
    ftnByTeam.set(r.team!, arr);
  }

  cached = {
    manifest,
    team: (t) => teamProfiles.get(t) ?? null,
    teams: () => Array.from(teamProfiles.values()),
    playerUsage: (key) => {
      let gsis = key.gsis_id ?? null;
      if (!gsis && key.sleeper_id) gsis = gsisBySleeper.get(key.sleeper_id) ?? null;
      const hit = gsis ? usageByGsis.get(gsis) : undefined;
      if (hit) return hit;
      return {
        gsis_id: key.gsis_id ?? "",
        sleeper_id: key.sleeper_id ?? null,
        pfr_id: null,
        full_name: null,
        position: null,
        nfl_team: null,
        season: manifest.season,
        through_week: manifest.through_week,
        games: null,
        eff_games: null,
        last_week: null,
        metrics: {},
        resolution: "UNRESOLVED",
      };
    },
    coverageAllowed: (t) => covByTeam.get(t) ?? [],
    contextualMatchup: (feature, off, def) =>
      ctxIndex.get(`${feature}|${off}|${def}`) ?? { availability: "NOT_AVAILABLE" },
    ftnDescriptive: (t) => ftnByTeam.get(t) ?? [],
    throughWeek: (source) => {
      if (source && manifest.data_cutoff[source] != null) return manifest.data_cutoff[source]!;
      return manifest.through_week;
    },
  };
  return cached;
}

/** test-only: drop the module cache. */
export function __resetFootballIntelligenceCache(): void {
  cached = undefined;
}
