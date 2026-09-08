/**
 * Phase 4 remediation Part C — live shadow-decision capture.
 *
 * From Week 1 of 2026 onward, every shadow Start/Sit decision can be persisted
 * with enough as-of state to evaluate later WITHOUT reconstruction. This is the
 * highest-integrity evidence for the future re-certification (Part C).
 *
 * `capture_kind` is always one of:
 *   LIVE_CAPTURED               — recorded before the Week-W games
 *   HISTORICALLY_RECONSTRUCTED  — rebuilt later from archives
 * The two are never mixed silently; the re-evaluation reports them separately.
 *
 * Default store is `NullCaptureStore` (no-op) — nothing is written unless a
 * caller wires a concrete store. `FileCaptureStore` appends JSONL under
 * `outputs/startsit-2026/shadow_capture/` (git-ignored, like other Phase-4 outputs).
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StartSitShadowComparison } from "./schema";

export type CaptureKind = "LIVE_CAPTURED" | "HISTORICALLY_RECONSTRUCTED";

export interface ShadowDecisionRecord {
  capture_kind: CaptureKind;
  decision_timestamp: string;
  season: number;
  week: number;
  league_slug: string;
  manager_slug: string;
  /** canonical scoring identity for the league (spec §26). */
  scoring_fingerprint: string | null;
  start_sit_model_version: string;
  football_intelligence_version: string | null;
  football_intel_data_cutoff: Record<string, number> | null;
  baseline_projection_version: string;
  deployment: string;
  /** per close-call: identities, baseline proj, FI inputs, adjusted proj, both picks, reversal. */
  decisions: Array<{
    slot: string | null;
    baseline_start: string;
    fi_start: string;
    baseline_edge: number | null;
    fi_edge: number | null;
    reversal: boolean;
    inside_tie_break_gate: boolean;
    reason_codes: string[];
  }>;
  adjustments: Array<{
    canonical_player_id: string;
    position: string;
    nfl_team: string | null;
    opponent: string | null;
    baseline_projection: number | null;
    expected_adjustment: number;
    adjusted_projection: number | null;
    decision_confidence: string;
    fi_prior_season_only: boolean;
    contributions: Array<{ family: string; routing: string; fi_value: number | null; fi_confidence: string | null; points_contribution: number }>;
  }>;
  /** filled in later, once the Week-W results are known. */
  actual_fantasy_points: Record<string, number> | null;
}

export interface ShadowCaptureStore {
  readonly kind: string;
  record(rec: ShadowDecisionRecord): void;
}

export class NullCaptureStore implements ShadowCaptureStore {
  readonly kind = "null";
  record(): void {
    /* no-op */
  }
}

export class FileCaptureStore implements ShadowCaptureStore {
  readonly kind = "file";
  private readonly dir: string;
  constructor(baseDir?: string) {
    this.dir = baseDir ?? join(process.cwd(), "outputs", "startsit-2026", "shadow_capture");
  }
  record(rec: ShadowDecisionRecord): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${rec.season}_w${String(rec.week).padStart(2, "0")}.jsonl`);
    appendFileSync(file, JSON.stringify(rec) + "\n");
  }
}

let store: ShadowCaptureStore = new NullCaptureStore();
export function setShadowCaptureStore(s: ShadowCaptureStore): void {
  store = s;
}
export function getShadowCaptureStore(): ShadowCaptureStore {
  return store;
}

/** build the record from a shadow comparison. `kind` defaults to LIVE_CAPTURED. */
export function captureShadowDecision(
  cmp: StartSitShadowComparison,
  meta: {
    season: number;
    week: number;
    league_slug: string;
    manager_slug: string;
    scoring_fingerprint: string | null;
    kind?: CaptureKind;
  },
): ShadowDecisionRecord {
  const rec: ShadowDecisionRecord = {
    capture_kind: meta.kind ?? "LIVE_CAPTURED",
    decision_timestamp: cmp.lineage.decision_generated_at,
    season: meta.season,
    week: meta.week,
    league_slug: meta.league_slug,
    manager_slug: meta.manager_slug,
    scoring_fingerprint: meta.scoring_fingerprint,
    start_sit_model_version: cmp.lineage.start_sit_model_version,
    football_intelligence_version: cmp.lineage.football_intelligence_version,
    football_intel_data_cutoff: cmp.lineage.football_intel_data_cutoff,
    baseline_projection_version: cmp.lineage.baseline_projection_version,
    deployment: cmp.lineage.deployment,
    decisions: cmp.start_sit_deltas.map((d) => ({
      slot: d.slot,
      baseline_start: d.baseline_start,
      fi_start: d.fi_start,
      baseline_edge: d.baseline_edge,
      fi_edge: d.fi_edge,
      reversal: d.changed,
      inside_tie_break_gate: d.inside_tie_break_gate,
      reason_codes: d.reason_codes,
    })),
    adjustments: cmp.adjustments.map((a) => ({
      canonical_player_id: a.canonical_player_id,
      position: a.position,
      nfl_team: a.nfl_team,
      opponent: a.opponent,
      baseline_projection: a.baseline_projection,
      expected_adjustment: a.expected_adjustment,
      adjusted_projection: a.adjusted_projection,
      decision_confidence: a.decision_confidence,
      fi_prior_season_only: a.fi_prior_season_only,
      contributions: a.contributions.map((c) => ({
        family: c.family,
        routing: c.routing,
        fi_value: c.fi_value,
        fi_confidence: c.fi_confidence,
        points_contribution: c.points_contribution,
      })),
    })),
    actual_fantasy_points: null,
  };
  store.record(rec);
  return rec;
}
