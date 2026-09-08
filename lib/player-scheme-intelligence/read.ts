/**
 * Player x Scheme Intelligence — file-backed read adapter (Phase 9, Tier A).
 *
 * Pure synchronous file reads over `lib/player-scheme-intelligence/data/*`
 * (committed, Vercel-safe — same boundary as `lib/football-intel/read.ts`).
 * No R, no network, no recomputation.
 *
 * ADDITIVE / READ-ONLY (spec §1, §37, §44). Nothing here changes a projection,
 * lineup, start/sit, waiver, trade, matchup, Roster Health, Schedule Planning,
 * or Orchestrator ACTION. Interaction/alignment output carries
 * `numeric_fantasy_adjustment = 0` and `deployment = "SHADOW_ONLY"` for the
 * predictive lane; Tier A itself is `SHARED_DESCRIPTIVE`.
 *
 * Honest degradation (aligns with FI spec §25):
 *   - no manifest / no data file            -> loadPlayerSchemeIntelligence() returns null
 *   - player id not resolvable              -> { resolution: "UNRESOLVED" }
 *   - a profile kind absent for a player    -> that field is null / []
 *   - a cell below publication threshold    -> present, evidence_class "INSUFFICIENT"
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AvailabilityState,
  DepthBin,
  EvidenceClass,
  FieldThird,
  PlayerSchemeManifest,
} from "./schema";

const DATA_DIR = join(process.cwd(), "lib", "player-scheme-intelligence", "data");
const MANIFEST = join(DATA_DIR, "player_scheme_manifest.json");

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
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
  const header = parseLine(lines[0] ?? "");
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

const S = (v: string | undefined): string => v ?? "";
const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "" || v === "NA") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: string | undefined): string | null => (v === undefined || v === "" || v === "NA" ? null : v);

function readCsv(name: string): Array<Record<string, string>> {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return [];
  try { return parseCsv(readFileSync(p, "utf8")); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Shapes returned by the loaders
// ---------------------------------------------------------------------------
export type ProfileWindow = "career" | "recent" | "current_team";

export interface DirectoryEntry {
  gsis_id: string;
  full_name: string | null;
  position: string | null;
  nfl_team: string | null;
  sleeper_id: string | null;
  pfr_id: string | null;
  espn_id: string | null;
  yahoo_id: string | null;
}

export interface SpatialCellRow {
  gsis_id: string;
  window: ProfileWindow;
  depth_bin: DepthBin;
  field_third: FieldThird;
  attempts: number | null;
  attempt_share: number | null;
  completion_pct: number | null;
  air_yards: number | null;
  yards_per_attempt: number | null;
  epa_per_attempt: number | null;
  epa_per_attempt_raw: number | null;
  success_rate: number | null;
  td_rate: number | null;
  int_rate: number | null;
  explosive_rate: number | null;
  first_down_rate: number | null;
  yac: number | null;
  attempts_total: number | null;
  attempts_charted: number | null;
  attempts_uncharted: number | null;
  evidence_class: EvidenceClass;
}

export interface QbDirectionalRow {
  gsis_id: string;
  window: ProfileWindow;
  n: number | null;
  values: Record<string, number | null>;
  vs_league: Record<string, number | null>;
}

export interface PlayerSchemeIntelligence {
  manifest: PlayerSchemeManifest & {
    availability_state: AvailabilityState;
    live_class: string;
    current_season_status: string;
    windows: string[];
  };
  directory: DirectoryEntry[];
}

let cache: PlayerSchemeIntelligence | null | undefined;
export function __resetPlayerSchemeCache(): void { cache = undefined; }

export function loadPlayerSchemeIntelligence(): PlayerSchemeIntelligence | null {
  if (cache !== undefined) return cache;
  if (!existsSync(MANIFEST)) { cache = null; return cache; }
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const directory: DirectoryEntry[] = readCsv("player_directory.csv").map((r) => ({
      gsis_id: S(r.gsis_id),
      full_name: str(r.full_name),
      position: str(r.position),
      nfl_team: str(r.nfl_team),
      sleeper_id: str(r.sleeper_id),
      pfr_id: str(r.pfr_id),
      espn_id: str(r.espn_id),
      yahoo_id: str(r.yahoo_id),
    }));
    cache = { manifest, directory };
  } catch { cache = null; }
  return cache;
}

// ---------------------------------------------------------------------------
// id resolution (spec §37: canonical id in identity, provider-id fallback)
// ---------------------------------------------------------------------------
export interface ResolveResult {
  entry: DirectoryEntry | null;
  matched_on: "gsis_id" | "sleeper_id" | "pfr_id" | "espn_id" | "yahoo_id" | "name" | null;
}

export function resolvePlayer(raw: string): ResolveResult {
  const psi = loadPlayerSchemeIntelligence();
  if (!psi) return { entry: null, matched_on: null };
  const id = raw.trim();
  const byId = psi.directory.find((d) => d.gsis_id === id);
  if (byId) return { entry: byId, matched_on: "gsis_id" };
  for (const key of ["sleeper_id", "pfr_id", "espn_id", "yahoo_id"] as const) {
    const hit = psi.directory.find((d) => d[key] && d[key] === id);
    if (hit) return { entry: hit, matched_on: key };
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const target = norm(id);
  const byName = psi.directory.filter((d) => d.full_name && norm(d.full_name) === target);
  if (byName.length === 1) return { entry: byName[0]!, matched_on: "name" };
  return { entry: null, matched_on: null };
}

// ---------------------------------------------------------------------------
// Profile loaders — filtered by gsis_id / team, keyed by window
// ---------------------------------------------------------------------------
function spatialRows(file: string, gsis_id: string): SpatialCellRow[] {
  return readCsv(file)
    .filter((r) => r.gsis_id === gsis_id)
    .map((r) => ({
      gsis_id: S(r.gsis_id),
      window: S(r.window) as ProfileWindow,
      depth_bin: S(r.depth_bin) as DepthBin,
      field_third: S(r.field_third) as FieldThird,
      attempts: num(r.attempts ?? r.targets ?? r.carries),
      attempt_share: num(r.attempt_share ?? r.target_share_of_self ?? r.carry_share),
      completion_pct: num(r.completion_pct ?? r.catch_rate),
      air_yards: num(r.air_yards),
      yards_per_attempt: num(r.yards_per_attempt ?? r.yards_per_target ?? r.yards_per_carry),
      epa_per_attempt: num(r.epa_per_attempt ?? r.epa_per_target ?? r.epa_per_rush),
      epa_per_attempt_raw: num(r.epa_per_attempt_raw ?? r.epa_per_target_raw ?? r.epa_per_rush_raw),
      success_rate: num(r.success_rate),
      td_rate: num(r.td_rate),
      int_rate: num(r.int_rate),
      explosive_rate: num(r.explosive_rate),
      first_down_rate: num(r.first_down_rate),
      yac: num(r.yac),
      attempts_total: num(r.attempts_total ?? r.targets_total ?? r.carries_total),
      attempts_charted: num(r.attempts_charted ?? r.targets_charted ?? r.carries_charted),
      attempts_uncharted: num(r.attempts_uncharted ?? r.targets_uncharted ?? r.carries_uncharted),
      evidence_class: (S(r.evidence_class) as EvidenceClass) || "INSUFFICIENT",
    }));
}

export function qbMatrix(gsis_id: string): SpatialCellRow[] { return spatialRows("qb_spatial_matrix.csv", gsis_id); }
export function receiverMatrix(gsis_id: string): SpatialCellRow[] { return spatialRows("receiver_spatial_matrix.csv", gsis_id); }
export function rbRushMatrix(gsis_id: string): SpatialCellRow[] { return spatialRows("rb_rush_matrix.csv", gsis_id); }

export function rbRushGap(gsis_id: string): Array<Record<string, string | number | null>> {
  return readCsv("rb_rush_gap.csv").filter((r) => r.gsis_id === gsis_id).map((r) => ({
    window: S(r.window), run_gap: S(r.run_gap), carries: num(r.carries),
    yards_per_carry: num(r.yards_per_carry), epa_per_rush: num(r.epa_per_rush),
    success_rate: num(r.success_rate), explosive_rate: num(r.explosive_rate),
    stuff_rate: num(r.stuff_rate), evidence_class: S(r.evidence_class),
  }));
}

export function qbDirectional(gsis_id: string): QbDirectionalRow[] {
  return readCsv("qb_directional.csv").filter((r) => r.gsis_id === gsis_id).map((r) => {
    const values: Record<string, number | null> = {};
    const vs: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "gsis_id" || k === "window") continue;
      if (k.endsWith("_vs_league")) vs[k.replace(/_vs_league$/, "")] = num(v);
      else if (k !== "n") values[k] = num(v);
    }
    return { gsis_id: S(r.gsis_id), window: S(r.window) as ProfileWindow, n: num(r.n), values, vs_league: vs };
  });
}

export interface DefensePassCell {
  team: string;
  window: "career" | "recent";
  depth_bin: DepthBin;
  field_third: FieldThird;
  targets_allowed: number | null;
  target_share_allowed: number | null;
  completion_pct_allowed: number | null;
  epa_per_target_allowed: number | null;
  success_rate_allowed: number | null;
  yards_per_target_allowed: number | null;
  explosive_rate_allowed: number | null;
  td_rate_allowed: number | null;
  int_rate_generated: number | null;
  evidence_class: EvidenceClass;
}

export function defensePassMatrix(team: string): DefensePassCell[] {
  const t = team.toUpperCase();
  return readCsv("defense_pass_vulnerability.csv").filter((r) => r.team === t).map((r) => ({
    team: S(r.team),
    window: S(r.window) as "career" | "recent",
    depth_bin: S(r.depth_bin) as DepthBin,
    field_third: S(r.field_third) as FieldThird,
    targets_allowed: num(r.targets_allowed),
    target_share_allowed: num(r.target_share_allowed),
    completion_pct_allowed: num(r.completion_pct_allowed),
    epa_per_target_allowed: num(r.epa_per_target_allowed),
    success_rate_allowed: num(r.success_rate_allowed),
    yards_per_target_allowed: num(r.yards_per_target_allowed),
    explosive_rate_allowed: num(r.explosive_rate_allowed),
    td_rate_allowed: num(r.td_rate_allowed),
    int_rate_generated: num(r.int_rate_generated),
    evidence_class: (S(r.evidence_class) as EvidenceClass) || "INSUFFICIENT",
  }));
}

export function defenseRushProfile(team: string): Array<Record<string, string | number | null>> {
  const t = team.toUpperCase();
  return readCsv("defense_rush_profile.csv").filter((r) => r.team === t).map((r) => ({
    window: S(r.window), field_third: S(r.field_third),
    carries_allowed: num(r.carries_allowed), carry_share_allowed: num(r.carry_share_allowed),
    yards_per_carry_allowed: num(r.yards_per_carry_allowed),
    epa_per_rush_allowed: num(r.epa_per_rush_allowed),
    success_rate_allowed: num(r.success_rate_allowed),
    explosive_rate_allowed: num(r.explosive_rate_allowed),
    stuff_rate_generated: num(r.stuff_rate_generated), evidence_class: S(r.evidence_class),
  }));
}

export function leagueBaselines(): Array<Record<string, string | number | null>> {
  return readCsv("league_baselines.csv").map((r) => {
    const o: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(r)) {
      o[k] = k === "window" || k === "entity" || k === "depth_bin" || k === "field_third" ? v : num(v);
    }
    return o;
  });
}
