/** Phase 4.5 Checkpoint E — capture identity/dedupe hardening + immutable market-state history. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { evaluateWaiver2 } from "@/lib/waiver2/actions";
import { waiver2EvidenceGate, buildBlockedRecord, buildCaptureRecord, captureKindFor, evaluationEligibility, validateCaptureRecord, MemoryWaiverCaptureStore, type WaiverLockEvidence } from "@/lib/waiver2/capture";
import { buildMarketSnapshot } from "@/lib/market-state/build";
import { classifyHistoricalMarket, compactMarketSnapshot, MemoryMarketSnapshotStore, validateCompactSnapshot } from "@/lib/market-state/history";
import { SupabaseMarketSnapshotStore, __resetMarketSnapshotRuntime, __setMarketSnapshotStore, getMarketSnapshotHealth, persistMarketSnapshot, snapshotRow } from "@/lib/persistence/supabase/market-state";
import { SupabaseRest } from "@/lib/persistence/supabase/rest";
import { installMarketSnapshotHook, runMarketSnapshotHook } from "@/lib/market-state/snapshot-hook";
import { mkWaiverInput, stdMine, type WaiverFixture } from "./fixtures/waiver2";
import { badSrc, marketInput, okSrc, agoMs } from "./fixtures/market";
import type { WaiverInput } from "@/lib/waiver2/types";

const OTHERS: WaiverFixture["others"] = [{ id: "3", players: [{ id: "o1", pos: "WR", pts: 9, team: "GB" }] }];
const fx = (over: Partial<WaiverFixture> = {}) => mkWaiverInput({ mine: stdMine(), others: OTHERS, freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }, { id: "fa3", pos: "RB", pts: 9, team: "NO", ros: 110 }], roles: { fa1: { tRecent: 0.27, tSeason: 0.2, conf: "HIGH", trend: "EXPANDING" } }, bye: { KC: 6 }, ...over });
const M = { league_slug: "bloodline-bowl", manager_slug: "supyo29", season: 2026 };
const PRE: WaiverLockEvidence = { verdict: "PRE_KICKOFF_VERIFIED", reason: "ALL_INVOLVED_GAMES_PRE_GAME", involved_teams: ["KC"], schedule_fetched_at: "t1", decision_date_et: "2026-09-22" };
const rec = (input: WaiverInput, lock: WaiverLockEvidence | null = PRE) => { const ev = evaluateWaiver2(input); return buildCaptureRecord(ev, input, { ...M, kind: captureKindFor(ev, { illustrative: false, is_reconstruction: false, lock }), lock }); };
const withLineage = (i: WaiverInput, id: string, hash: string) => { (i.weekly as unknown as { lineage: unknown }).lineage = { snapshot: { league_snapshot_id: id, content_hash: hash } }; return i; };

test("DEDUPE: identical requests and every volatile field share ONE identity (snapshot id/hash, read timestamps, lock read time, health counters)", () => {
  const a = rec(withLineage(fx(), "snap:A", "hashA")); const b = rec(withLineage(fx(), "snap:B", "hashB"));
  assert.equal(a.capture_id, b.capture_id, "the canonical snapshot id/content hash change on every read and are NOT decision identity"); assert.notEqual(a.snapshot.id, b.snapshot.id, "but they are still recorded for audit");
  const c = rec(fx(), { ...PRE, schedule_fetched_at: "t2", decision_date_et: "2026-09-23" }); assert.equal(c.capture_id, a.capture_id, "lock read times are not identity");
  const d = rec(fx()); assert.equal(d.capture_id, a.capture_id); assert.deepEqual(validateCaptureRecord(a), []); assert.equal(a.capture_class, "LIVE_CAPTURED"); assert.equal(a.schema_version, 3);
  const i = fx(); i.pool.market = { ...i.pool.market!, blocks: [], limitations: [] }; assert.equal(rec(i).capture_id, a.capture_id, "unchanged market ⇒ unchanged identity");
});
test("DEDUPE: a real decision change yields a NEW identity — market content, candidate set, roster (add/drop), acquisition status, FAAB (mine and others), lock verdict", () => {
  const base = rec(fx()).capture_id; const ids = new Set([base]);
  const mkt = fx(); mkt.pool.market = { ...mkt.pool.market!, market_content_id: "mkt:2026:w02:changed" }; ids.add(rec(mkt).capture_id);
  ids.add(rec(fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }] })).capture_id); // a candidate left the pool (ownership/acquisition change)
  ids.add(rec(fx({ mine: { ...stdMine(), bench: stdMine().bench.slice(1) } })).capture_id); // roster drop
  ids.add(rec(fx({ mine: { ...stdMine(), bench: [...stdMine().bench, { id: "x9", pos: "WR", pts: 2, team: "SF" }] } })).capture_id); // roster add
  ids.add(rec(fx({ mine: stdMine({ faab: 55 }) })).capture_id); // my FAAB
  const acq = fx(); acq.pool.market = { ...acq.pool.market!, acquisition_context_id: "acq:changed" }; ids.add(rec(acq).capture_id); // any team's FAAB/priority
  ids.add(rec(fx(), { ...PRE, verdict: "POST_LOCK", reason: "GAME_NOT_PRE_GAME:KC:in_game" }).capture_id);
  assert.equal(ids.size, 8);
});
test("DEDUPE: blocked readiness records are identified by readiness codes only — no per-read market id, snapshot id or coverage", () => {
  const blocked = (codes: string[], id: string) => { const i = withLineage(fx({ cert: "UNCERTIFIED_UNROSTERED" }), id, id); i.pool.market = { market_state_version: "v", market_content_id: `mkt:${id}`, pool_id: `pool:${id}`, acquisition_context_id: `acq:${id}`, history_class: "UNSAFE", readiness_status: "NOT_READY", blocks: codes, limitations: [], coverage: { pool_size: id.length, evaluated: 0, unmatched: 0 } }; const ev = evaluateWaiver2(i); return buildBlockedRecord(ev, i, { ...M, kind: "NOT_ACTIONABLE", lock: null }); };
  const a = blocked(["WAIVER_STATE_UNVERIFIABLE"], "one"); const b = blocked(["WAIVER_STATE_UNVERIFIABLE"], "twotwo"); const c = blocked(["ROSTER_STATE_UNAVAILABLE"], "one");
  assert.equal(a.capture_id, b.capture_id); assert.notEqual(a.capture_id, c.capture_id); assert.equal(a.market?.market_content_id, null); assert.deepEqual(validateCaptureRecord(a), []);
  assert.match(validateCaptureRecord({ ...a, market: { ...a.market!, market_content_id: "mkt:x" } }).join(), /readiness codes only/);
});
test("CAPTURE carries the market lineage; a v3 live record without it is refused; eligibility requires a TRUE_AS_OF non-blocked market; NOT_ACTIONABLE never counts", () => {
  const r = rec(fx()); assert.match(r.market!.market_content_id!, /^mkt:/); assert.equal(r.market!.history_class, "TRUE_AS_OF"); assert.ok(r.pool.candidate_ids.length > 0); assert.ok(r.roster.roster_hash); assert.ok(r.scoring_fingerprint === null || /^scoring/.test(r.scoring_fingerprint));
  assert.match(validateCaptureRecord({ ...r, market: null }).join(), /market-state lineage/);
  const el = evaluationEligibility(r, true); assert.ok(!el.reasons.some((x) => /market-state/.test(x)));
  const noMkt = { ...r, market: { ...r.market!, market_content_id: null } }; assert.ok(evaluationEligibility(noMkt as never, true).reasons.some((x) => /market-state lineage/.test(x)));
  const i = fx({ cert: "UNCERTIFIED_UNROSTERED" }); const bl = buildBlockedRecord(evaluateWaiver2(i), i, { ...M, kind: "NOT_ACTIONABLE", lock: null }); assert.equal(evaluationEligibility(bl, true).eligible, false);
  const st = new MemoryWaiverCaptureStore(); assert.equal(st.record(r).status, "INSERTED"); assert.equal(st.record(rec(withLineage(fx(), "snap:Z", "z"))).status, "DUPLICATE_IDENTICAL");
});

/* ---------------------------------------------------------------------------------------------- history */
const snap = (o: Parameters<typeof marketInput>[0] = {}) => buildMarketSnapshot(marketInput(o));
test("HISTORY: compact snapshot is content-addressed, excludes volatile fields, and is stable across reads of an unchanged market", () => {
  const a = compactMarketSnapshot(snap()); const b = compactMarketSnapshot(snap({ request_id: "req:Q", source_snapshot_id: "snap:Q", as_of: "2026-09-22T15:00:30.000Z" }));
  assert.equal(a.artifact_id, b.artifact_id); assert.deepEqual(validateCompactSnapshot(a), []); assert.match(a.artifact_id, /^mktsnap:[0-9a-f]{20}$/);
  const fa = marketInput(); fa.rosters.teams[0]!.faab_used = 60; const c = compactMarketSnapshot(buildMarketSnapshot(fa));
  assert.equal(c.market_content_id, a.market_content_id); assert.notEqual(c.artifact_id, a.artifact_id, "a decision-relevant FAAB change is a new artifact under the same market content id");
  assert.notEqual(compactMarketSnapshot(snap({ transactions: { source: okSrc(), entries: [{ type: "free_agent", status: "complete", status_updated: agoMs(1), adds: [], drops: ["30"] }] } })).artifact_id, a.artifact_id);
});
test("HISTORY: tampering, blocked markets and conflicting states are refused; historical classes never overclaim", async () => {
  const a = compactMarketSnapshot(snap()); const st = new MemoryMarketSnapshotStore();
  assert.equal((await st.record(a)).status, "INSERTED"); assert.equal((await st.record(a)).status, "DUPLICATE_IDENTICAL"); assert.equal(st.rows.size, 1);
  assert.equal((await st.record({ ...a, available: [...a.available, ["sleeper:10", "WR", "KC"]] })).status, "REFUSED");
  const blocked = compactMarketSnapshot(snap({ transactions: { source: badSrc(), entries: [] } })); assert.equal((await st.record(blocked)).status, "REFUSED");
  assert.equal(classifyHistoricalMarket({ immutable_snapshot_at_the_time: true, roster_and_universe_archive_at_the_time: false, transaction_chronology: false }), "TRUE_AS_OF");
  assert.equal(classifyHistoricalMarket({ immutable_snapshot_at_the_time: false, roster_and_universe_archive_at_the_time: false, transaction_chronology: true }), "RETROSPECTIVE_ONLY", "transactions alone cannot rebuild a past pool");
  assert.equal(classifyHistoricalMarket({ immutable_snapshot_at_the_time: false, roster_and_universe_archive_at_the_time: false, transaction_chronology: false }), "UNSAFE");
});
beforeEach(() => { __resetMarketSnapshotRuntime(); __setMarketSnapshotStore(undefined); });
test("HISTORY runtime: writes once per artifact, throttles flapping, skips blocked markets, degrades truthfully; never throws", async () => {
  const mem = new MemoryMarketSnapshotStore(); __setMarketSnapshotStore(mem); let t = 0; const now = () => t;
  assert.equal((await persistMarketSnapshot(snap(), { now })).status, "INSERTED"); assert.equal((await persistMarketSnapshot(snap({ request_id: "req:2" }), { now })).status, "DUPLICATE_IDENTICAL");
  const changed = marketInput(); changed.rosters.teams[1]!.players.push("30");
  assert.equal((await persistMarketSnapshot(buildMarketSnapshot(changed), { now })).status, "THROTTLED"); t = 3 * 60 * 1000; assert.equal((await persistMarketSnapshot(buildMarketSnapshot(changed), { now })).status, "INSERTED"); assert.equal(mem.rows.size, 2);
  assert.equal((await persistMarketSnapshot(snap({ rosters: { source: badSrc(), teams: [] } }), { now })).status, "SKIPPED_BLOCKED");
  const h = getMarketSnapshotHealth(); assert.equal(h.inserted, 2); assert.equal(h.skipped_blocked, 1); assert.equal(h.throttled, 1);
  __setMarketSnapshotStore({ kind: "x", durable: true, record: async () => { throw new Error("db down"); } }); __resetMarketSnapshotRuntime(); __setMarketSnapshotStore({ kind: "x", durable: true, record: async () => { throw new Error("db down"); } });
  const bad = await persistMarketSnapshot(snap(), { now }); assert.equal(bad.status, "ERROR"); assert.equal(getMarketSnapshotHealth().failures, 1);
  __setMarketSnapshotStore({ kind: "slow", durable: true, record: () => new Promise(() => undefined) }); __resetMarketSnapshotRuntime(); __setMarketSnapshotStore({ kind: "slow", durable: true, record: () => new Promise(() => undefined) });
  assert.equal((await persistMarketSnapshot(snap(), { now, timeoutMs: 20 })).status, "TIMEOUT");
  __setMarketSnapshotStore(null); assert.equal((await persistMarketSnapshot(snap(), { now })).status, "NOT_CONFIGURED");
});
test("HISTORY durable store (mocked PostgREST): table/conflict target/row shape; duplicate ⇒ DUPLICATE_IDENTICAL; invalid never reaches the network", async () => {
  const calls: Array<{ url: string; body: unknown }> = []; const orig = globalThis.fetch; let mode: "insert" | "dup" = "insert";
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(mode === "insert" ? [{ artifact_id: "x" }] : []), { status: 201, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const st = new SupabaseMarketSnapshotStore(new SupabaseRest({ url: "https://x.supabase.co", serviceRoleKey: "k" })); const c = compactMarketSnapshot(snap());
    assert.equal((await st.record(c)).status, "INSERTED"); assert.match(calls[0]!.url, /bridge_market_state_snapshots\?on_conflict=artifact_id/);
    const row = (calls[0]!.body as Array<Record<string, unknown>>)[0]!; assert.deepEqual(Object.keys(row).sort(), Object.keys(snapshotRow(c)).sort()); assert.equal(row.history_class, "TRUE_AS_OF");
    mode = "dup"; assert.equal((await st.record(c)).status, "DUPLICATE_IDENTICAL");
    const n = calls.length; assert.equal((await st.record({ ...c, history_class: "UNSAFE" })).status, "REFUSED"); assert.equal(calls.length, n);
  } finally { globalThis.fetch = orig; }
});
test("HISTORY hook is one-way telemetry: it never throws and cannot change the snapshot", async () => {
  const s = snap(); const before = JSON.stringify(s); installMarketSnapshotHook(async () => { throw new Error("boom"); });
  try { await runMarketSnapshotHook(s); await runMarketSnapshotHook(null); } finally { installMarketSnapshotHook(null); }
  assert.equal(JSON.stringify(s), before);
});

test("CRON /api/cron/waiver2-capture is auth-gated (no secret ⇒ refused, wrong token ⇒ 401) and scheduled", async () => {
  const { GET } = (await import("../app/api/cron/waiver2-capture/route")) as { GET: (r: Request) => Promise<Response> };
  const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
  try {
    const none = await GET(new Request("https://x/api/cron/waiver2-capture")); assert.ok(none.status === 401 || none.status === 403 || none.status === 503, `no secret configured must refuse (got ${none.status})`);
    process.env.CRON_SECRET = "s3cret"; const bad = await GET(new Request("https://x/api/cron/waiver2-capture", { headers: { authorization: "Bearer nope" } })); assert.equal(bad.status, 401);
  } finally { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
  const { readFileSync } = await import("node:fs"); assert.ok(JSON.parse(readFileSync("vercel.json", "utf8")).crons.some((c: { path: string }) => c.path === "/api/cron/waiver2-capture"));
});

test("PROVENANCE: invocation origin is recorded but is NOT identity and NOT an eligibility criterion; correlated captures of one decision window never inflate the gate", () => {
  const i = fx(); const ev = evaluateWaiver2(i); const o = { ...M, kind: "LIVE_CAPTURED" as const, lock: PRE };
  const cron = buildCaptureRecord(ev, i, { ...o, invocation: "CRON" }); const req = buildCaptureRecord(ev, i, { ...o, invocation: "REQUEST" });
  assert.equal(cron.provenance?.invocation, "CRON"); assert.equal(req.provenance?.invocation, "REQUEST"); assert.equal(cron.capture_id, req.capture_id, "origin is not identity"); assert.deepEqual(validateCaptureRecord(cron), []);
  assert.equal(evaluationEligibility(cron, true).eligible, evaluationEligibility(req, true).eligible, "origin does not decide eligibility");
  const spoofed = buildCaptureRecord(ev, i, { ...o, kind: "LIVE_POST_LOCK", lock: { ...PRE, verdict: "POST_LOCK" }, invocation: "CRON" }); assert.equal(evaluationEligibility(spoofed, true).eligible, false, "a cron run after kickoff is never pristine");
  // 30 daily-cron-style variants of ONE manager/week decision (different FAAB each) = 1 decision
  const variants = Array.from({ length: 30 }, (_, k) => { const v = fx({ mine: stdMine({ faab: 50 + k }) }); return buildCaptureRecord(evaluateWaiver2(v), v, { ...o, invocation: "CRON" }); });
  assert.equal(new Set(variants.map((r) => r.capture_id)).size, 30);
  const g = waiver2EvidenceGate(variants.map((r, k) => ({ ...r, captured_at: `2026-09-2${k % 10}T14:00:00.000Z` })), variants.map((r) => ({ capture_id: r.capture_id })));
  assert.equal(g.eligible_records, 1); assert.equal(g.distinct_weeks, 1); assert.equal(g.distinct_managers, 1); assert.equal(g.excluded.CORRELATED_SAME_DECISION_WINDOW, 29); assert.equal(g.status, "NOT_ELIGIBLE");
});
