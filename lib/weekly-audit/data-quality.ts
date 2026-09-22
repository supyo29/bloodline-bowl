/**
 * Phase 9 Step 27 — weekly data-quality checks. Pure. A finding EXCLUDES the offending row from calibration
 * (Step 27: "do not include bad rows in calibration metrics"); it never throws, so one corrupted row cannot
 * erase an otherwise-good component (Step 46 partial-failure).
 */
import type { DataQualityFinding } from "./contract";

export interface GenericCaptureLike { capture_id: string; season: number; week: number; scoring_fingerprint?: string | null; capture_kind?: string; captured_at?: string }

/** Duplicate `capture_id` within one batch (should be impossible given the PK, but a caller-level fetch bug could double-list). */
export function findDuplicateCaptures(rows: readonly GenericCaptureLike[]): DataQualityFinding[] {
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.capture_id, (seen.get(r.capture_id) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ code: "DUPLICATE_CAPTURE_ROW", severity: "INVESTIGATE", scope: id, detail: `capture_id appears ${n} times in one fetch`, rows_excluded: n - 1 }));
}

/** A capture whose `captured_at` is after "now" is impossible (clock skew or corrupted row) — excluded, never trusted. */
export function findFutureTimestamps(rows: readonly GenericCaptureLike[], now = Date.now()): DataQualityFinding[] {
  return rows.filter((r) => r.captured_at && Date.parse(r.captured_at) > now).map((r) => ({ code: "IMPOSSIBLE_FUTURE_TIMESTAMP", severity: "BLOCKING_DATA_QUALITY", scope: r.capture_id, detail: `captured_at ${r.captured_at} is after the audit run time`, rows_excluded: 1 }));
}

/** A `LIVE_POST_LOCK` capture is, by class, NOT pristine — this is expected and not a defect; flag it only if it is silently treated as `LIVE_CAPTURED` elsewhere (defence-in-depth check). */
export function findMislabeledPreLock(rows: readonly GenericCaptureLike[], claimedPristine: ReadonlySet<string>): DataQualityFinding[] {
  return rows.filter((r) => r.capture_kind && r.capture_kind !== "LIVE_CAPTURED" && claimedPristine.has(r.capture_id)).map((r) => ({ code: "POST_LOCK_CAPTURE_TREATED_AS_PRISTINE", severity: "BLOCKING_DATA_QUALITY", scope: r.capture_id, detail: `capture_kind=${r.capture_kind} but was included in the pristine (LIVE_CAPTURED) evidence set`, rows_excluded: 1 }));
}

/** A missing/invalid scoring fingerprint means outcomes cannot be league-scored honestly — excluded, not zeroed. */
export function findMissingScoringFingerprint(rows: readonly GenericCaptureLike[]): DataQualityFinding[] {
  return rows.filter((r) => !r.scoring_fingerprint || !/^scoring:v1:[0-9a-f]+$/.test(r.scoring_fingerprint)).map((r) => ({ code: "INVALID_OR_MISSING_SCORING_FINGERPRINT", severity: "WATCH", scope: r.capture_id, detail: `scoring_fingerprint=${String(r.scoring_fingerprint)}`, rows_excluded: 1 }));
}

/** A capture whose season/week does not match the audit's own (season, week) — a cross-week contamination bug, never silently included. */
export function findWrongWeek(rows: readonly GenericCaptureLike[], season: number, week: number): DataQualityFinding[] {
  return rows.filter((r) => r.season !== season || r.week !== week).map((r) => ({ code: "CROSS_WEEK_CONTAMINATION", severity: "BLOCKING_DATA_QUALITY", scope: r.capture_id, detail: `row is (${r.season},${r.week}), audit is (${season},${week})`, rows_excluded: 1 }));
}

/** Runs every check and returns the union of findings plus the set of capture_ids to exclude from calibration. */
export function runDataQualityChecks(rows: readonly GenericCaptureLike[], season: number, week: number, claimedPristine: ReadonlySet<string>, now = Date.now()): { findings: DataQualityFinding[]; excludeIds: Set<string> } {
  const findings = [...findDuplicateCaptures(rows), ...findFutureTimestamps(rows, now), ...findMislabeledPreLock(rows, claimedPristine), ...findMissingScoringFingerprint(rows), ...findWrongWeek(rows, season, week)];
  const excludeIds = new Set(findings.filter((f) => f.severity === "BLOCKING_DATA_QUALITY").map((f) => f.scope));
  return { findings, excludeIds };
}
