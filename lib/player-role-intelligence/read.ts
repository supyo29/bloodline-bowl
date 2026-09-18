/**
 * Player Role & Opportunity Intelligence — file-backed read adapter
 * (Phase 2, Checkpoint D).
 *
 * Pure synchronous file reads over `lib/player-role-intelligence/data/*`
 * (committed, Vercel-safe -- same boundary decision as `lib/football-intel/read.ts`).
 * No R, no network, no recomputation, no mutation.
 *
 * Honest degradation:
 *   - no manifest / no data file  -> loadRoleOpportunitySnapshot() returns null
 *   - unknown player              -> getPlayerRoleProfile() returns null (never throws, never fabricates)
 *   - domain not applicable to this position -> the domain field is `null`, never an empty-but-present object
 *   - a dimension whose current evidence is unavailable (e.g. routes) -> DimensionProfile with `latest: null`, `confidence: "INSUFFICIENT_SAMPLE"` -- never a fabricated value
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  RoleOpportunityManifest,
  PlayerRoleProfile,
  RoleChangeEvent,
  DimensionProfile,
  Confidence,
  Trend,
  EvidenceState,
  Discontinuity,
  RoleLevel,
  RouteEvidenceTag,
  RoleDomain,
} from "./schema";

const DATA_DIR = join(process.cwd(), "lib", "player-role-intelligence", "data");

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
const CONFIDENCE_VALUES: Confidence[] = ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT_SAMPLE"];
const TREND_VALUES: Trend[] = ["EXPANDING", "STABLE", "CONTRACTING", "UNCERTAIN"];
const EVIDENCE_STATE_VALUES: EvidenceState[] = ["OBSERVED", "TENTATIVE", "INSUFFICIENT_SAMPLE"];
const DISCONTINUITY_VALUES: Discontinuity[] = ["NONE", "TEAM_CHANGE", "POSITION_CHANGE", "ROOKIE_OR_NO_PRIOR_SEASON", "NO_PRIOR_EVIDENCE_THIS_METRIC"];
const ROLE_LEVEL_VALUES: RoleLevel[] = ["MINIMAL", "ROTATIONAL", "REGULAR", "FEATURED", "PRIMARY"];

function readDimension(row: Record<string, string>, prefix: string): DimensionProfile | null {
  const confidenceRaw = row[`${prefix}_confidence`];
  // Domain/dimension not applicable to this position at all (Checkpoint C
  // spec §7) -- the R build emits an all-blank row for it. Distinguished
  // from "applicable but no current evidence" (which always has a real
  // confidence/evidence_state enum value, typically INSUFFICIENT_SAMPLE).
  if (confidenceRaw == null || confidenceRaw === "") return null;
  const confidence = CONFIDENCE_VALUES.includes(confidenceRaw as Confidence) ? (confidenceRaw as Confidence) : "INSUFFICIENT_SAMPLE";
  const evidenceRaw = row[`${prefix}_evidence_state`] ?? "";
  const priorConfRaw = row[`${prefix}_prior_role_confidence`] ?? "";
  const discRaw = row[`${prefix}_discontinuity`] ?? "";
  return {
    latest: n(row[`${prefix}_latest`]),
    recent: n(row[`${prefix}_recent`]),
    season: n(row[`${prefix}_season`]),
    prior: n(row[`${prefix}_prior`]),
    prior_role_confidence: CONFIDENCE_VALUES.includes(priorConfRaw as Confidence) ? (priorConfRaw as Confidence) : "INSUFFICIENT_SAMPLE",
    discontinuity: DISCONTINUITY_VALUES.includes(discRaw as Discontinuity) ? (discRaw as Discontinuity) : "NONE",
    n_games_season: n(row[`${prefix}_n_games_season`]) ?? 0,
    opportunity_total: n(row[`${prefix}_opportunity_total`]) ?? 0,
    delta_latest_vs_recent: n(row[`${prefix}_delta_latest_vs_recent`]),
    trend_latest_vs_recent: TREND_VALUES.includes(row[`${prefix}_trend_latest_vs_recent`] as Trend) ? (row[`${prefix}_trend_latest_vs_recent`] as Trend) : "UNCERTAIN",
    trend_latest_vs_season: TREND_VALUES.includes(row[`${prefix}_trend_latest_vs_season`] as Trend) ? (row[`${prefix}_trend_latest_vs_season`] as Trend) : "UNCERTAIN",
    trend_recent_vs_prior: TREND_VALUES.includes(row[`${prefix}_trend_recent_vs_prior`] as Trend) ? (row[`${prefix}_trend_recent_vs_prior`] as Trend) : "UNCERTAIN",
    evidence_state: EVIDENCE_STATE_VALUES.includes(evidenceRaw as EvidenceState) ? (evidenceRaw as EvidenceState) : "INSUFFICIENT_SAMPLE",
    confidence,
  };
}

function rowToProfile(row: Record<string, string>): PlayerRoleProfile {
  const receivingTarget = readDimension(row, "receiving_target_share");
  const rushingShare = readDimension(row, "rushing_rush_share");
  const roleLevelRaw = row.role_level ?? "";
  return {
    identity: {
      gsis_id: row.gsis_id ?? "",
      sleeper_id: s(row.sleeper_id),
      full_name: row.full_name ?? "",
      position: row.position ?? "",
      team: row.team ?? "",
      opponent: s(row.opponent),
    },
    as_of: { season: n(row.season) ?? 0, through_week: n(row.through_week) ?? 0 },
    participation: readDimension(row, "participation_snap_share"),
    receiving: receivingTarget
      ? {
          target_share: receivingTarget,
          position_group_target_share: readDimension(row, "receiving_position_group_target_share"),
          air_yards_share: readDimension(row, "receiving_air_yards_share")!,
          route_participation: readDimension(row, "receiving_route_participation")!,
          corroboration_count: n(row.receiving_corroboration_count) ?? 0,
        }
      : null,
    rushing: rushingShare
      ? {
          rush_share: rushingShare,
          position_group_rush_share: readDimension(row, "rushing_position_group_rush_share"),
          corroboration_count: n(row.rushing_corroboration_count) ?? 0,
        }
      : null,
    high_value: {
      rz_target_share: readDimension(row, "high_value_rz_target_share"),
      rz_carry_share: readDimension(row, "high_value_rz_carry_share"),
      goal_line_carries_latest: n(row.high_value_goal_line_carries_latest),
      third_down_targets_latest: n(row.high_value_third_down_targets_latest),
      two_minute_targets_latest: n(row.high_value_two_minute_targets_latest),
    },
    returns: {
      kick_return_role: readDimension(row, "returns_kick_return_role")!,
      punt_return_role: readDimension(row, "returns_punt_return_role")!,
    },
    role_state: {
      role_level: ROLE_LEVEL_VALUES.includes(roleLevelRaw as RoleLevel) ? (roleLevelRaw as RoleLevel) : null,
      role_trend: TREND_VALUES.includes(row.role_trend as Trend) ? (row.role_trend as Trend) : "UNCERTAIN",
      evidence_state: EVIDENCE_STATE_VALUES.includes(row.role_evidence_state as EvidenceState) ? (row.role_evidence_state as EvidenceState) : "INSUFFICIENT_SAMPLE",
    },
    source_availability: {
      route_evidence: (row.route_evidence === "ROUTE_CORROBORATION_AVAILABLE" ? "ROUTE_CORROBORATION_AVAILABLE" : "ROUTE_CORROBORATION_UNAVAILABLE") as RouteEvidenceTag,
    },
    schema_version: row.schema_version ?? "",
  };
}

const ROLE_DOMAINS: RoleDomain[] = ["PARTICIPATION", "RECEIVING", "RUSHING", "HIGH_VALUE", "RETURNS"];
function rowToEvent(row: Record<string, string>): RoleChangeEvent {
  return {
    gsis_id: row.gsis_id ?? "",
    full_name: row.full_name ?? "",
    season: n(row.season) ?? 0,
    through_week: n(row.through_week) ?? 0,
    domain: ROLE_DOMAINS.includes(row.domain as RoleDomain) ? (row.domain as RoleDomain) : "PARTICIPATION",
    dimension: row.dimension ?? "",
    trend: TREND_VALUES.includes(row.trend as Trend) ? (row.trend as Trend) : "UNCERTAIN",
    evidence_state: EVIDENCE_STATE_VALUES.includes(row.evidence_state as EvidenceState) ? (row.evidence_state as EvidenceState) : "INSUFFICIENT_SAMPLE",
    confidence: CONFIDENCE_VALUES.includes(row.confidence as Confidence) ? (row.confidence as Confidence) : "INSUFFICIENT_SAMPLE",
    latest: n(row.latest),
    baseline_recent: n(row.baseline_recent),
    baseline_season: n(row.baseline_season),
    baseline_prior: n(row.baseline_prior),
    delta: n(row.delta),
    n_games_season: n(row.n_games_season) ?? 0,
    opportunity_total: n(row.opportunity_total) ?? 0,
  };
}

export interface RoleOpportunitySnapshot {
  manifest: RoleOpportunityManifest;
  profiles: PlayerRoleProfile[];
  events: RoleChangeEvent[];
  getPlayerRoleProfile(id: { gsis_id?: string | null; sleeper_id?: string | null }): PlayerRoleProfile | null;
  getPlayerRoleChanges(id: { gsis_id?: string | null; sleeper_id?: string | null }): RoleChangeEvent[];
}

/**
 * Validates the loaded artifact against the invariants Checkpoint D §30
 * requires. Throws with a descriptive message on any violation -- this
 * runs on every load (cheap, ~1000 rows), not just in tests, so a
 * corrupted/regressed served artifact can never silently reach a consumer.
 */
export function validateRoleOpportunitySnapshot(manifest: RoleOpportunityManifest, profiles: PlayerRoleProfile[], events: RoleChangeEvent[]): void {
  const seen = new Set<string>();
  for (const p of profiles) {
    const key = `${p.as_of.season}:${p.as_of.through_week}:${p.identity.gsis_id}`;
    if (seen.has(key)) throw new Error(`RoleOpportunitySnapshot: duplicate profile key ${key}`);
    seen.add(key);
    if (!p.identity.gsis_id) throw new Error("RoleOpportunitySnapshot: profile with empty gsis_id");
    if (p.as_of.season !== manifest.season || p.as_of.through_week > manifest.through_week) {
      throw new Error(`RoleOpportunitySnapshot: profile ${p.identity.gsis_id} season/week (${p.as_of.season}/${p.as_of.through_week}) is inconsistent with manifest (${manifest.season}/${manifest.through_week})`);
    }
    // Strictly [0,1]-bounded by construction: target/rush share (targets or
    // carries over a team total) and return-opportunity share can never
    // exceed 1. `participation` (snap_share_derived) is DELIBERATELY
    // EXCLUDED here -- Checkpoint B documented and tested that it can
    // legitimately exceed 1.0 for QBs (PFR's raw snap count includes QB
    // kneels; the team-play denominator excludes them by design), so
    // enforcing a hard <=1 bound on it would fail on correct, expected data.
    for (const dim of [p.receiving?.target_share, p.rushing?.rush_share, p.returns.kick_return_role, p.returns.punt_return_role]) {
      if (!dim) continue;
      for (const field of ["latest", "recent", "season", "prior"] as const) {
        const v = dim[field];
        if (v != null && (v < 0 || v > 1 || !Number.isFinite(v))) {
          throw new Error(`RoleOpportunitySnapshot: ${p.identity.gsis_id} ${field}=${v} out of bounds [0,1]`);
        }
      }
    }
  }
  const routeFamily = manifest.source_availability.find((f) => f.family === "ROLE_ROUTES");
  if (routeFamily?.status === "AVAILABLE_CURRENT") {
    const anyRouteEvidence = profiles.some((p) => p.receiving?.route_participation.latest != null);
    if (!anyRouteEvidence) {
      throw new Error("RoleOpportunitySnapshot: ROLE_ROUTES marked AVAILABLE_CURRENT but no profile has route evidence -- availability false positive");
    }
  }
  const eventKeys = new Set<string>();
  for (const e of events) {
    const key = `${e.season}:${e.through_week}:${e.gsis_id}:${e.domain}:${e.dimension}`;
    if (eventKeys.has(key)) throw new Error(`RoleOpportunitySnapshot: duplicate change-event key ${key}`);
    eventKeys.add(key);
  }
}

let cache: RoleOpportunitySnapshot | null | undefined;

/** Reset the module-level cache -- test-only. */
export function __resetRoleOpportunityCache(): void {
  cache = undefined;
}

export function loadRoleOpportunitySnapshot(): RoleOpportunitySnapshot | null {
  if (cache !== undefined) return cache;
  const manifestPath = join(DATA_DIR, "role_opportunity_manifest.json");
  const profilePath = join(DATA_DIR, "player_role_profile.csv");
  const eventPath = join(DATA_DIR, "player_role_change.csv");
  if (!existsSync(manifestPath) || !existsSync(profilePath)) {
    cache = null;
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RoleOpportunityManifest;
  const profiles = parseCsv(readFileSync(profilePath, "utf8")).map(rowToProfile);
  const events = existsSync(eventPath) ? parseCsv(readFileSync(eventPath, "utf8")).map(rowToEvent) : [];

  validateRoleOpportunitySnapshot(manifest, profiles, events);

  const byGsis = new Map(profiles.map((p) => [p.identity.gsis_id, p]));
  const bySleeper = new Map(profiles.filter((p) => p.identity.sleeper_id).map((p) => [p.identity.sleeper_id as string, p]));
  const eventsByGsis = new Map<string, RoleChangeEvent[]>();
  for (const e of events) {
    const list = eventsByGsis.get(e.gsis_id) ?? [];
    list.push(e);
    eventsByGsis.set(e.gsis_id, list);
  }

  const resolve = (id: { gsis_id?: string | null; sleeper_id?: string | null }): PlayerRoleProfile | null => {
    if (id.gsis_id) {
      const byId = byGsis.get(id.gsis_id);
      if (byId) return byId;
    }
    if (id.sleeper_id) {
      const byId = bySleeper.get(id.sleeper_id);
      if (byId) return byId;
    }
    return null;
  };

  const snapshot: RoleOpportunitySnapshot = {
    manifest,
    profiles,
    events,
    getPlayerRoleProfile: resolve,
    getPlayerRoleChanges: (id) => {
      const profile = resolve(id);
      return profile ? (eventsByGsis.get(profile.identity.gsis_id) ?? []) : [];
    },
  };
  cache = snapshot;
  return snapshot;
}
