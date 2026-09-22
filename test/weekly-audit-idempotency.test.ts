/**
 * Phase 9 Step 4 / Step 45 — deterministic identity (never a wall-clock timestamp) + idempotent writes
 * (`insertIgnoreDuplicates` conflict target proves a second identical run is a no-op).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evidenceDigest, auditId } from "@/lib/weekly-audit/identity";
import { writeStartSitOutcomes, writeMatchup2Outcomes, writeWaiver2Outcomes, writeWeeklyModelAudit } from "@/lib/persistence/supabase/weekly-audit-store";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { ShadowOutcomeRecord } from "@/lib/weekly/start-sit-fi/capture";
import type { Matchup2Outcome } from "@/lib/matchup2/capture";
import type { WaiverOutcome } from "@/lib/waiver2/capture";
import type { WeeklyModelAudit } from "@/lib/weekly-audit/contract";

const inputs = () => ({ fi_version: "fi:2026:w02:x", scoring_fingerprints: ["b", "a"], startsit_capture_ids: ["c2", "c1"], startsit_outcome_sources: ["s1"], matchup2_capture_ids: [], matchup2_outcome_sources: [], waiver2_capture_ids: [], waiver2_outcome_sources: [], certification_version: "fi-certification-TEST" });

describe("identity — deterministic, never a timestamp", () => {
  test("same evidence, different key/array order -> identical digest and audit_id", () => {
    const a = evidenceDigest(inputs());
    const b = evidenceDigest({ ...inputs(), scoring_fingerprints: ["a", "b"], startsit_capture_ids: ["c1", "c2"] });
    assert.equal(a, b);
    assert.equal(auditId(2026, 2, a), auditId(2026, 2, b));
  });
  test("repeated calls are byte-identical (no clock, no randomness)", () => {
    assert.equal(evidenceDigest(inputs()), evidenceDigest(inputs()));
  });
  test("new evidence (a new outcome source) -> a DIFFERENT audit_id, never a mutation of the old one", () => {
    const a = auditId(2026, 2, evidenceDigest(inputs()));
    const b = auditId(2026, 2, evidenceDigest({ ...inputs(), startsit_outcome_sources: ["s1", "s2"] }));
    assert.notEqual(a, b);
  });
  test("audit_id format matches the migration's CHECK constraint", () => {
    assert.match(auditId(2026, 2, evidenceDigest(inputs())), /^wa:2026:2:v1:[0-9a-f]{16}$/);
  });
});

/** A duck-typed SupabaseRest double: first insert accepts every row, second identical call returns none — exactly what PostgREST's `resolution=ignore-duplicates` does against a real unique index. */
function fakeRest(): { rest: SupabaseRest; inserted: unknown[][] } {
  const seen = new Set<string>();
  const inserted: unknown[][] = [];
  const rest = {
    insertIgnoreDuplicates: async (_table: string, rows: unknown[], conflictColumns: string[]) => {
      const fresh = rows.filter((r) => { const k = conflictColumns.map((c) => (r as Record<string, unknown>)[c]).join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
      inserted.push(fresh);
      return fresh;
    },
  } as unknown as SupabaseRest;
  return { rest, inserted };
}

describe("outcome writers — idempotent (first INSERTED, repeat DUPLICATE_IDENTICAL)", () => {
  test("Start/Sit outcome: first run inserts, identical second run inserts nothing", async () => {
    const { rest } = fakeRest();
    const row: ShadowOutcomeRecord = { capture_id: "ssc:1", source: "sleeper-stats:v1", recorded_at: "t", scoring_fingerprint: "scoring:v1:x", actual_fantasy_points: { "player:sleeper:1": 10 } };
    const first = await writeStartSitOutcomes(rest, [row]); assert.equal(first.inserted, 1); assert.equal(first.duplicate, 0);
    const second = await writeStartSitOutcomes(rest, [row]); assert.equal(second.inserted, 0); assert.equal(second.duplicate, 1);
  });
  test("Matchup2 outcome: idempotent on (capture_id, source)", async () => {
    const { rest } = fakeRest();
    const row: Matchup2Outcome = { capture_id: "m2cap:1", source: "sleeper-stats:v1", recorded_at: "t", realized_fantasy_points: 12, played: true };
    assert.equal((await writeMatchup2Outcomes(rest, [row])).inserted, 1);
    assert.equal((await writeMatchup2Outcomes(rest, [row])).inserted, 0);
  });
  test("Waiver2 outcome: idempotent on (capture_id, source)", async () => {
    const { rest } = fakeRest();
    const row: WaiverOutcome = { capture_id: "w2:1", source: "sleeper-transactions:v1", recorded_at: "t", claim_result: "WON", winning_bid: 10, winning_manager: "m", candidate_unclaimed: false, realized: { candidate_points_started: null, drop_points_lost: null, role_share_change: null, roster_survival_weeks: null, best_alternative_points_started: null } };
    assert.equal((await writeWaiver2Outcomes(rest, [row])).inserted, 1);
    assert.equal((await writeWaiver2Outcomes(rest, [row])).inserted, 0);
  });
  test("a CORRECTED outcome uses a NEW versioned source (e.g. sleeper-stats:v2) and is a distinct, additive row — never overwrites v1", async () => {
    const { rest } = fakeRest();
    const v1: ShadowOutcomeRecord = { capture_id: "ssc:1", source: "sleeper-stats:v1", recorded_at: "t1", scoring_fingerprint: "scoring:v1:x", actual_fantasy_points: { "player:sleeper:1": 10 } };
    const v2: ShadowOutcomeRecord = { ...v1, source: "sleeper-stats:v2", recorded_at: "t2", actual_fantasy_points: { "player:sleeper:1": 11 } }; // provider corrected the stat line
    assert.equal((await writeStartSitOutcomes(rest, [v1])).inserted, 1);
    const r2 = await writeStartSitOutcomes(rest, [v2]); assert.equal(r2.inserted, 1, "a new source version is a NEW row, not blocked as a duplicate");
    assert.equal((await writeStartSitOutcomes(rest, [v1])).inserted, 0, "the original v1 remains queryable and is still idempotent on its own");
  });
  test("weekly audit record: idempotent on audit_id", async () => {
    const { rest } = fakeRest();
    const audit = { audit_id: "wa:2026:2:v1:abc1230000000000", season: 2026, week: 2, audit_schema_version: 1, evidence_digest: "abc", status: "WEEK_COMPLETE", severity: "INFO", generated_at: "t" } as unknown as WeeklyModelAudit;
    assert.equal((await writeWeeklyModelAudit(rest, audit)).inserted, 1);
    assert.equal((await writeWeeklyModelAudit(rest, audit)).inserted, 0);
  });
});
