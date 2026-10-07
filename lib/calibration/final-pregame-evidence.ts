/**
 * W1.R1 / G3 — the FINAL CANONICAL FORECAST as calibration evidence.
 *
 * Before this, the ledger scored the projection snapshot's `projected_points`, which is the SOURCE basis (W1.P2 moved the injury-aware value into
 * `expected_points`), so it could never evaluate what Bloodline actually told users. This adapts an immutable final-pregame REVISION into the
 * ledger's candidate shape:
 *   projected_points            = the canonical decision value (`expected_points`) the lineup/matchup consumed
 *   detail.source_points        = the upstream source value for the SAME player-game, so source quality and decision quality are scored
 *                                 against the same actual and can be compared
 *   detail.*                    = injury adjustment, availability, workload, semantics/λ basis, ledger digest, shadow components (values,
 *                                 modes — never applied), certification, source observation id
 * League isolation: a revision is league-scoped (expected points are league-scored); the shared NFL source observation is REFERENCED by id,
 * never merged into one fantasy-point record. Provider-neutral: identity is the canonical id; a Sleeper id is used only as a stats-join key when
 * one exists (a Yahoo-only individual stays representable but cannot be graded until a stats join exists — recorded, not fabricated).
 */
import { contentHash } from "@/lib/bridge/hash";
import { normalizeTeamCode } from "@/lib/canonical/team-codes";
import { sleeperIdFromCanonicalId } from "@/lib/canonical/team-defense";
import type { FinalPregameRecord } from "@/lib/weekly/freshness/final-pregame";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { PlayerIdentity } from "./case-builder";
import { scoringExactness } from "./outcome";
import type { ProjectionCandidate } from "./types";

export const EVALUATION_BASIS_CANONICAL = "CANONICAL_EXPECTED_POINTS" as const;
export const EVALUATION_BASIS_SOURCE = "SOURCE_PROJECTION" as const;

export async function readFinalPregameRevisions(rest: SupabaseRest, league: string, season: number, week: number): Promise<FinalPregameRecord[]> {
  const out: FinalPregameRecord[] = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await rest.select<{ record: FinalPregameRecord }>("bridge_final_pregame_revisions", {
      filter: { league_slug: `eq.${league}`, season: `eq.${season}`, week: `eq.${week}` },
      select: "record", order: "canonical_player_id.asc,source_observed_at.asc,composed_at.asc,forecast_id.asc", limit: 1000, offset,
    });
    out.push(...rows.map((r) => r.record));
    if (rows.length < 1000) break;
  }
  return out;
}

export function identityFromFinalPregame(r: FinalPregameRecord): PlayerIdentity {
  const provider_ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.identifiers)) if (k.endsWith("_id") || k.endsWith("_key")) provider_ids[k] = String(v);
  const snap = r.forecast_snapshot;
  return {
    canonical_player_id: r.canonical_player_id,
    sleeper_id: provider_ids.sleeper_id ?? sleeperIdFromCanonicalId(r.canonical_player_id),
    provider_ids,
    name: null,
    position: snap?.position ?? null,
    nfl_team: normalizeTeamCode(snap?.team ?? null),
    resolved: !r.canonical_player_id.startsWith("unresolved:"),
  };
}

/** the revision as a calibration candidate. Returns null for a revision with no decision value (nothing to grade). */
export function candidateFromFinalPregame(r: FinalPregameRecord, rawScoring: Record<string, number> | null): ProjectionCandidate | null {
  const f = r.forecast_snapshot;
  if (!f || r.expected_points == null || !r.scoring_fingerprint) return null;
  const warnings = [...f.provenance.source_warnings, ...f.certification.warnings];
  const position = f.position;
  const variance = f.uncertainty.variance;
  return {
    kind: "FINAL_PREGAME_FORECAST",
    artifact_id: r.forecast_id,
    content_hash: r.content_signature,
    request_fingerprint: null,
    recorded_at: r.composed_at, // when Bloodline produced the forecast users saw; the ledger's rule is STRICTLY before kickoff
    league_slug: r.league_slug,
    scoring_fingerprint: r.scoring_fingerprint,
    source: `final_pregame:${r.source_provider ?? "unknown"}`,
    model_version: r.forecast_model_version,
    projected_points: r.expected_points,
    floor_points: f.projection.floor,
    ceiling_points: f.projection.ceiling,
    std_dev: variance == null ? null : Math.sqrt(variance),
    expected_availability: r.injury.probability_active,
    injury_status: r.injury.source_status,
    warnings,
    nfl_team: normalizeTeamCode(f.team),
    opponent: normalizeTeamCode(f.opponent),
    position,
    scoring_exactness: scoringExactness(position, rawScoring, warnings),
    detail: {
      evaluation_basis: EVALUATION_BASIS_CANONICAL,
      final_pregame_forecast_id: r.forecast_id,
      source_points: r.source_points,
      conditional_active_points: r.conditional_active_points,
      expected_points_basis: f.projection.expected_points_basis,
      current_week_state: r.current_week_state,
      injury_adjustment_points: f.injury_model.adjustment_points,
      probability_active: f.injury_model.probability_active,
      workload_expected_fraction: f.injury_model.workload_if_active.expected_fraction,
      source_semantics: f.injury_model.source_projection_injury_semantics,
      embedded_fraction_assumed: f.injury_model.embedded_fraction_assumed,
      injury_model_version: r.injury_model_version,
      forecast_model_version: r.forecast_model_version,
      contribution_ledger_digest: contentHash(f.contributions).slice(0, 16),
      contributions: f.contributions.length,
      shadow: { role: f.role.mode ?? null, environment: f.environment.mode ?? null, matchup: f.matchup.mode ?? null, values: r.shadow },
      certification: f.certification.state,
      source_observation_id: r.source_observation_id,
      source_observed_at: r.source_observed_at,
      snapshot_artifact_id: r.snapshot_artifact_id,
      composed_at: r.composed_at,
    },
  };
}
