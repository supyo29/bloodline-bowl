/**
 * Injury -> Opportunity Propagation Intelligence — file-backed read
 * adapter (Phase 3, Checkpoint D).
 *
 * Pure synchronous file reads over
 * `lib/opportunity-propagation-intelligence/data/*` (committed,
 * Vercel-safe -- same boundary decision as `lib/player-role-intelligence/
 * read.ts`). No R, no network, no recomputation, no mutation.
 *
 * Honest degradation: no manifest / no data file -> loadOpportunityPropagationModel() returns null.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  OpportunityPropagationManifest,
  OpportunityPropagationModel,
  InheritanceRateLeagueRow,
  InheritanceRatePositionRow,
  InheritanceRateTeamRow,
  PositionRelationshipWeightRow,
  SupportedDimension,
} from "./schema";

const DATA_DIR = join(process.cwd(), "lib", "opportunity-propagation-intelligence", "data");

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

const num = (v: string | undefined): number => (v == null || v === "" ? NaN : Number(v));

/**
 * Validates the loaded artifact against Checkpoint D §47's product
 * validator requirements. Throws with a descriptive message on any
 * violation -- runs on every load, not just in tests.
 */
export function validateOpportunityPropagationModel(model: OpportunityPropagationModel): void {
  const m = model.manifest;
  if (!m.model_tag || !m.opportunity_propagation_version || !m.schema_version) {
    throw new Error("OpportunityPropagationModel: manifest missing model_tag/opportunity_propagation_version/schema_version");
  }
  if (!m.role_opportunity_dependency?.role_opportunity_version) {
    throw new Error("OpportunityPropagationModel: manifest missing role_opportunity_dependency.role_opportunity_version");
  }
  const supported = new Set(m.supported_absent_positions);
  if (!supported.has("RB") || !supported.has("WR") || !supported.has("TE") || supported.has("QB" as never)) {
    throw new Error(`OpportunityPropagationModel: supported_absent_positions must be exactly RB/WR/TE, got ${JSON.stringify(m.supported_absent_positions)}`);
  }
  if (m.supported_scenario_type !== "FULL_GAME_NONPARTICIPATION") {
    throw new Error(`OpportunityPropagationModel: unexpected supported_scenario_type ${m.supported_scenario_type}`);
  }
  if (m.single_absence_support !== "CALIBRATED") throw new Error("OpportunityPropagationModel: single_absence_support must be CALIBRATED");
  if (m.multi_absence_support !== "EXPERIMENTAL_MULTI_ABSENCE") throw new Error("OpportunityPropagationModel: multi_absence_support must be EXPERIMENTAL_MULTI_ABSENCE (never silently upgraded)");
  const badTiers = m.confidence_semantics.tiers_supported.filter((t) => t !== "LOW" && t !== "INSUFFICIENT_EVIDENCE");
  if (badTiers.length > 0) throw new Error(`OpportunityPropagationModel: unsupported confidence tiers served: ${badTiers.join(", ")} (no HIGH/MEDIUM without calibration)`);
  if (m.uncertainty_ranges_supported !== false) throw new Error("OpportunityPropagationModel: uncertainty_ranges_supported must be false (no calibrated ranges exist yet)");
  if (m.deployment_state !== "SHADOW_ONLY") throw new Error(`OpportunityPropagationModel: deployment_state must be SHADOW_ONLY, got ${m.deployment_state}`);
  if (m.eligible_to_influence_production !== false) throw new Error("OpportunityPropagationModel: eligible_to_influence_production must be false");
  if (m.production_numeric_influence !== "PROHIBITED") throw new Error("OpportunityPropagationModel: production_numeric_influence must be PROHIBITED");
  if (m.training_window.end_season >= 2026) throw new Error("OpportunityPropagationModel: 2026 must never appear in the training/calibration window metadata");
  if (m.historical_training_semantics.cause !== "UNKNOWN") throw new Error("OpportunityPropagationModel: historical_training_semantics.cause must be UNKNOWN");

  if (model.league.length === 0) throw new Error("OpportunityPropagationModel: empty league inheritance table");
  const seenLeague = new Set<string>();
  for (const r of model.league) {
    if (seenLeague.has(r.dimension)) throw new Error(`OpportunityPropagationModel: duplicate league row for dimension ${r.dimension}`);
    seenLeague.add(r.dimension);
    if (!Number.isFinite(r.league_rate) || r.league_rate < 0) throw new Error(`OpportunityPropagationModel: invalid league_rate for ${r.dimension}: ${r.league_rate}`);
  }
  const seenTeam = new Set<string>();
  for (const r of model.team) {
    const key = `${r.dimension}:${r.team}:${r.position}`;
    if (seenTeam.has(key)) throw new Error(`OpportunityPropagationModel: duplicate team-inheritance-rate key ${key}`);
    seenTeam.add(key);
    if (!Number.isFinite(r.team_rate_blended) || r.team_rate_blended < 0) throw new Error(`OpportunityPropagationModel: invalid team_rate_blended for ${key}: ${r.team_rate_blended}`);
  }
  for (const r of model.positionWeights) {
    if (!Number.isFinite(r.same_position_multiplier) || r.same_position_multiplier < 0) {
      throw new Error(`OpportunityPropagationModel: invalid same_position_multiplier for ${r.dimension}: ${r.same_position_multiplier}`);
    }
  }
}

let cache: OpportunityPropagationModel | null | undefined;

/** Reset the module-level cache -- test-only. */
export function __resetOpportunityPropagationCache(): void {
  cache = undefined;
}

export function loadOpportunityPropagationModel(): OpportunityPropagationModel | null {
  if (cache !== undefined) return cache;
  const manifestPath = join(DATA_DIR, "opportunity_propagation_manifest.json");
  if (!existsSync(manifestPath)) {
    cache = null;
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OpportunityPropagationManifest;

  const readTable = (file: string) => {
    const p = join(DATA_DIR, file);
    return existsSync(p) ? parseCsv(readFileSync(p, "utf8")) : [];
  };

  const league: InheritanceRateLeagueRow[] = readTable("inheritance_priors_league.csv").map((r) => ({
    dimension: r.dimension ?? "",
    league_rate: num(r.league_rate),
    n_league: num(r.n_league),
  }));
  const position: InheritanceRatePositionRow[] = readTable("inheritance_priors_position.csv").map((r) => ({
    dimension: r.dimension ?? "",
    position: r.position ?? "",
    position_rate_blended: num(r.position_rate_blended),
  }));
  const team: InheritanceRateTeamRow[] = readTable("inheritance_priors_team.csv").map((r) => ({
    dimension: r.dimension ?? "",
    team: r.team ?? "",
    position: r.position ?? "",
    team_rate_blended: num(r.team_rate_blended),
    n_team: num(r.n_team),
  }));
  const positionWeights: PositionRelationshipWeightRow[] = readTable("position_relationship_weights.csv").map((r) => ({
    dimension: r.dimension ?? "",
    same_position_multiplier: num(r.same_position_multiplier),
  }));
  const dimensions: SupportedDimension[] = readTable("supported_dimensions.csv").map((r) => ({
    domain: r.domain as SupportedDimension["domain"],
    dimension: r.dimension ?? "",
    positions: (r.positions ?? "").split("|") as SupportedDimension["positions"],
  }));

  const model: OpportunityPropagationModel = { manifest, league, position, team, positionWeights, dimensions };
  validateOpportunityPropagationModel(model);
  cache = model;
  return model;
}
