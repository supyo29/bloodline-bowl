/**
 * Publication-audit "latest": ties on the millisecond `attempted_at` must resolve to the NEWEST recorded attempt. Regression for a flake found by the test-failure audit (bridge-refresh
 * "a self-contradictory candidate is rejected" failed ~1 in 6 loaded runs: `latest()` returned the first publish's CERTIFIED row instead of the rejected attempt's REJECTED row).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryPublicationAuditStore } from "../lib/persistence/memory";
import { AUDIT_ORDER, SupabasePublicationAuditStore } from "../lib/persistence/supabase/publication-audit";
import type { PublicationAudit } from "../lib/persistence/types";
import type { SupabaseRest } from "../lib/persistence/supabase/rest";

const audit = (over: Partial<PublicationAudit>): PublicationAudit => ({
  league_slug: "l", season: 2026, trigger: "API", attempted_at: "2026-10-14T00:00:00.000Z", finished_at: "2026-10-14T00:00:00.001Z", duration_ms: 1, outcome: "published", ok: true, candidate_snapshot_id: null, candidate_content_hash: null,
  prior_pointer_seq: null, resulting_pointer_seq: null, pointer_advanced: false, snapshot_persisted: "created", integrity: "CERTIFIED", validation_detail: null, source_status: null, error_category: null, error: null, ...over,
} as PublicationAudit);

describe("MemoryPublicationAuditStore ordering", () => {
  it("same-millisecond attempts: the LAST recorded is 'latest', and recent() is newest-first", async () => {
    const s = new MemoryPublicationAuditStore();
    await s.record(audit({ outcome: "published", integrity: "CERTIFIED" })); await s.record(audit({ outcome: "rejected", integrity: "REJECTED", ok: false })); await s.record(audit({ outcome: "unchanged", integrity: "CERTIFIED" }));
    assert.equal((await s.latest("l", 2026))!.outcome, "unchanged");
    assert.deepEqual((await s.recent("l", 2026)).map((a) => a.outcome), ["unchanged", "rejected", "published"]);
  });
  it("a strictly later attempted_at always wins regardless of recording order", async () => {
    const s = new MemoryPublicationAuditStore();
    await s.record(audit({ outcome: "newer", attempted_at: "2026-10-14T00:00:05.000Z" })); await s.record(audit({ outcome: "older", attempted_at: "2026-10-14T00:00:01.000Z" }));
    assert.equal((await s.latest("l", 2026))!.outcome, "newer");
  });
  it("scoping and limit are respected", async () => {
    const s = new MemoryPublicationAuditStore();
    for (let i = 0; i < 5; i++) await s.record(audit({ outcome: `a${i}` })); await s.record(audit({ league_slug: "other", outcome: "x" }));
    assert.equal((await s.recent("l", 2026, 2)).length, 2); assert.equal((await s.latest("nope", 2026)), null);
  });
});

describe("SupabasePublicationAuditStore ordering", () => {
  it("asks PostgREST for a TOTAL newest-first order (attempted_at, then finished_at, then id) for both latest() and recent()", async () => {
    const calls: Array<{ order?: string; limit?: number }> = [];
    const rest = { select: async (_t: string, o: { order?: string; limit?: number }) => { calls.push(o); return []; } } as unknown as SupabaseRest;
    const s = new SupabasePublicationAuditStore(rest); await s.latest("l", 2026); await s.recent("l", 2026, 7);
    assert.equal(calls.length, 2); assert.ok(calls.every((c) => c.order === AUDIT_ORDER));
    assert.match(AUDIT_ORDER, /^attempted_at\.desc,finished_at\.desc\.nullslast,id\.desc$/);
  });
});
