/**
 * Phase 5 — projection provider wrapper backed by canonical Supabase snapshots.
 *
 * Read path:
 *   fresh durable snapshot -> return normalized batch without touching Sleeper
 *   miss/stale/error       -> call live provider -> best-effort persist -> return
 *
 * The wrapper never turns a persistence failure into projection unavailability.
 * Live source truth remains the safety fallback.
 */

import { getProjectionSnapshotStore } from "@/lib/persistence/supabase/projection-snapshot";
import type { WeeklyProjectionBatch, WeeklyWarning } from "../schema";
import type { ProjectionProvider, ProjectionRequest } from "./types";
import type { ProjectionSnapshotStore } from "./canonical-snapshot";

function info(code: string, message: string): WeeklyWarning {
  return { code, message, severity: "info" };
}

export class CanonicalProjectionSnapshotProvider implements ProjectionProvider {
  readonly name: string;
  readonly model_version: string;

  constructor(
    private readonly live: ProjectionProvider,
    private readonly store: ProjectionSnapshotStore = getProjectionSnapshotStore(),
  ) {
    this.name = live.name;
    this.model_version = live.model_version;
  }

  async getWeeklyProjections(req: ProjectionRequest): Promise<WeeklyProjectionBatch> {
    // The request fingerprint includes crosswalk.version. Load it before ANY
    // snapshot scope is computed so readLatest() and a later record() cannot
    // disagree merely because the live provider initialized the crosswalk.
    await req.crosswalk.ensureLoaded();
    const policy = req.projection_snapshot_policy ?? "prefer";
    let readFailure: string | null = null;

    if (policy === "prefer") {
      try {
        const hit = await this.store.readLatest(req);
        if (hit) return hit.batch;
      } catch (error) {
        readFailure = error instanceof Error ? error.message : String(error);
      }
    }

    const liveBatch = await this.live.getWeeklyProjections(req);
    const readPath =
      policy === "refresh" ? "LIVE_REFRESH" : policy === "bypass" ? "LIVE_BYPASS" : "LIVE_FALLBACK";

    let snapshot = {
      read_path: readPath as NonNullable<WeeklyProjectionBatch["canonical_snapshot"]>["read_path"],
      artifact_id: null as string | null,
      observed_at: null as string | null,
      age_ms: null as number | null,
      durable: false,
    };
    const warnings = [...liveBatch.warnings];

    if (readFailure) {
      warnings.push(
        info(
          "canonical_projection_snapshot_read_failed",
          `Canonical projection snapshot read failed; live projection fallback remained available (${readFailure}).`,
        ),
      );
    }

    if (
      policy !== "bypass" &&
      liveBatch.status !== "PROJECTIONS_UNAVAILABLE" &&
      liveBatch.by_player.size > 0
    ) {
      const observedAt = new Date().toISOString();
      const written = await this.store.record(req, liveBatch, observedAt);
      snapshot = {
        read_path: readPath,
        artifact_id: written.artifact_id,
        observed_at: written.observed_at,
        age_ms: 0,
        durable: written.durable && (written.status === "INSERTED" || written.status === "DUPLICATE_IDENTICAL"),
      };
      if (written.status === "ERROR" || written.status === "NOT_CONFIGURED") {
        warnings.push(
          info(
            "canonical_projection_snapshot_write_unavailable",
            written.error ?? `Canonical projection snapshot write status: ${written.status}.`,
          ),
        );
      }
    }

    return {
      ...liveBatch,
      warnings,
      canonical_snapshot: snapshot,
    };
  }
}
